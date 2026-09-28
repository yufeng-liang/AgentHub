// 反代网关 · 号池服务（方案 §6.10）：账号状态机 + 池内调度 + 错误分类冷却
// 状态机五态：online / cooling / exhausted / relogin / disabled；调度只挑 online
"use strict";
const store = require("./store.cjs");

/** 派生有效状态：cooling 到期自动回 online；exhausted 到次日 04:00 后给复活机会 */
function effectiveStatus(acc, now) {
  now = now || Date.now();
  // 冷却截止时间：poolAccounts 传入的是 accountView（驼峰 coolUntil），原始行是 cool_until——两者都认，
  // 否则「cooling 到期自动复活」这条会因字段名不匹配（读到 undefined）永不触发（软冷却账号只能等额度刷新翻身）。
  const coolUntil = Number(acc.coolUntil ?? acc.cool_until) || 0;
  if (acc.status === "cooling" && coolUntil && coolUntil <= now) {
    store.updateAccount(acc.id, { status: "online", coolUntil: 0, coolReason: "" });
    return "online";
  }
  if (acc.status === "exhausted" && coolUntil && coolUntil <= now) return "online";
  return acc.status;
}

/** 渠道号池视图（账号明细 + 派生状态） */
function poolAccounts(channel) {
  return store.listAccounts(channel).map((a) => {
    const before = a.status;
    const eff = effectiveStatus(a);
    // 派生复活（cooling/exhausted 到期）必须落库，否则调度/健康检查读原始行永不复活
    if (before !== eff) store.updateAccount(a.id, { status: eff, coolUntil: 0, coolReason: "" });
    return { ...a, status: eff };
  });
}

// ===== 选号权重常量（②闲置补偿权重，参考项目 weight 语义：负载摊开）=====
// 权重语义：weight = (credits 比例)×CREDIT_WEIGHT + idleWeight；idleWeight = min(闲置小时×PER_HOUR, CAP)。
const CREDIT_WEIGHT = 10;          // credits 占满（=候选最大值）时贡献的权重上限
const IDLE_WEIGHT_PER_HOUR = 0.5; // 每闲置 1 小时累加的权重
const IDLE_WEIGHT_CAP = 5;        // 闲置补偿封顶（约 10 小时到顶），防止久眠号权重无限膨胀

/** 闲置补偿权重：越久没被选中权重越高（摊开负载）。lastUsed=0（从未用）直接给满值 CAP。 */
function idleWeight(acc, now) {
  const last = Number(acc.lastUsed) || 0;
  if (last <= 0) return IDLE_WEIGHT_CAP;
  const hours = Math.max(0, (now - last) / 3600000);
  return Math.min(hours * IDLE_WEIGHT_PER_HOUR, IDLE_WEIGHT_CAP);
}

/** 按权重随机取一个（普通 Math.random）；总权重<=0（全零）时退化为取第一个，保持确定不崩。 */
function weightedPick(list, weightFn) {
  if (list.length <= 1) return list[0];
  const weights = list.map((a) => Math.max(0, Number(weightFn(a)) || 0));
  const total = weights.reduce((s, w) => s + w, 0);
  if (total <= 0) return list[0];
  let r = Math.random() * total;
  for (let i = 0; i < list.length; i++) {
    r -= weights[i];
    if (r < 0) return list[i];
  }
  return list[list.length - 1];
}

/** ① 全冷却顶班兜底：正常候选（online）为空时的最后一搏。
 *  可顶班集合 = hasToken && !exclude 且"软性可恢复"的账号。判定口径直接看派生后的 status：
 *  只有 status==="cooling" 才可能顶班成功——coolAccount 对 429 软限流(kind rate)、5xx 熔断/网络
 *  退避(kind server)、404/默认退避(default) 与 coolAccountMs 全部写 status="cooling"；
 *  而 exhausted（402 余额耗尽/余额已到期，见 coolAccount kind credit 与 pickAccount 的两处标记）、
 *  relogin（401 凭证失效）、disabled（人工停用）顶班必然失败或无额度，一律排除。
 *  从可顶班集合里取 coolUntil 升序（最早恢复者优先）第一个返回；集合空返回 null。
 *  注意：不把它的 status 改成 online（只是本次选它顶班），也不做任何特殊标记。
 *  边界（保守）：顶班的前提是"有个班可顶"——即这是**多账号号池**被临时全部冷却（spec 原文
 *  "全部账号...都在 cooling/熔断"本就是复数语义）。单账号渠道被冷却时没有"别人的班"可顶，
 *  只是它自己在退避，此时保持既有的"返回 null → readyz/请求 503"信号不变（429 的同号退避重试
 *  由 server 层 rateRetried 负责，不必在选号层强行赌一个孤号）。故渠道有 token 的账号 < 2 时不顶班。 */
function fallbackPick(channel, exclude, now) {
  const accs = poolAccounts(channel);
  if (accs.filter((a) => a.hasToken).length < 2) return null;
  let best = null;
  let bestUntil = Infinity;
  for (const a of accs) {
    if (!a.hasToken || exclude.has(a.id) || a.status !== "cooling") continue;
    const until = Number(a.coolUntil) || 0;
    if (until < bestUntil) { best = a; bestUntil = until; }
  }
  return best;
}

/**
 * 池内选号：expire_first（默认，积分先到期先用）/ credit_first / round_robin
 * 两种自动切换（不发请求、调度期前置生效）：
 *  ① 余额不足自动切换——已查到余额为 0 的账号直接标记耗尽并跳过，不再浪费一次上游 402；
 *  ② 余额到期自动切换——到期时间已过的账号余额视为失效，标记并跳过；
 *     搭配默认 expire_first 策略：快到期账号永远排在最前优先消耗（到期前榨干），过期即自动切走。
 * 被跳过的账号等下次额度刷新拿到新余额/新到期时间后自动复活（credits.cjs）。
 * maxInFlight > 0 时在途数已达上限的账号不参与候选（参考项目租约语义），
 * 全部忙时降级取在途最小者（不过载拒绝）；100ms 内刚选中过的账号让位给其他候选（防惊群）。
 */
function pickAccount(channel, strategy, excludeIds, maxInFlight) {
  const now = Date.now();
  const exclude = new Set(excludeIds || []);
  const candidates = [];
  for (const a of poolAccounts(channel)) {
    if (a.status !== "online" || !a.hasToken || exclude.has(a.id)) continue;
    // credits === -1 = 企业版无限额度哨兵，不参与耗尽判定
    if (a.creditsAt > 0 && a.credits === 0) {
      // ① 已知余额不足：标记耗尽（次日 04:00 给复活机会），自动切换下一账号
      store.updateAccount(a.id, { status: "exhausted", coolUntil: nextDay4AM(), coolReason: "余额不足，已自动切换" });
      continue;
    }
    if (a.expiresAt > 0 && a.expiresAt <= now) {
      // ② 余额已到期：标记失效（靠额度刷新复活），自动切换下一账号
      store.updateAccount(a.id, { status: "exhausted", coolUntil: 0, coolReason: "余额已到期，已自动切换" });
      continue;
    }
    candidates.push(a);
  }
  // ① 全冷却顶班兜底：正常候选（online）为空——号池全在 cooling/熔断——时，与其硬失败(返回 null)
  // 不如从"软性可恢复"账号里赌一个最早恢复的顶班。集合仍空才真正返回 null。详见 fallbackPick。
  if (!candidates.length) return fallbackPick(channel, exclude, now);
  // 并发租约：在途数达上限的账号让位；全忙时取在途最小者（不过载拒绝，参考项目语义）
  let pool2 = candidates;
  const limit = Number(maxInFlight) > 0 ? Number(maxInFlight) : 0;
  if (limit) {
    const idle = candidates.filter((a) => (inFlight.get(a.id) || 0) < limit);
    if (idle.length) {
      pool2 = idle;
    } else {
      let min = Infinity;
      for (const a of candidates) {
        const c = inFlight.get(a.id) || 0;
        if (c < min) { min = c; pool2 = [a]; }
      }
    }
  }
  let picked;
  switch (strategy) {
    case "credit_first": {
      // ② 加权随机（负载摊开）：权重 = (credits/候选最大credits)×CREDIT_WEIGHT + idleWeight。
      // 偏向高余额号消耗，同时用闲置补偿把负载摊到久未使用的号；credits 全 0 时退化为纯 idleWeight。
      const maxCredits = pool2.reduce((m, a) => Math.max(m, a.credits > 0 ? a.credits : 0), 0);
      picked = weightedPick(pool2, (a) => {
        const ratio = maxCredits > 0 ? (a.credits > 0 ? a.credits : 0) / maxCredits : 0;
        return ratio * CREDIT_WEIGHT + idleWeight(a, now);
      });
      break;
    }
    case "round_robin":
      // 现状：lastUsed 升序本身即摊开负载，保持确定性不叠加权重
      pool2.sort((a, b) => a.lastUsed - b.lastUsed);
      picked = pool2[0];
      break;
    case "expire_first":
    default: {
      // 先到期的先用；没查过到期时间的排最后（不失效优先消耗快过期的）
      pool2.sort((a, b) => (a.expiresAt || Number.MAX_SAFE_INTEGER) - (b.expiresAt || Number.MAX_SAFE_INTEGER));
      // ② 保持"最早到期优先"的确定性：仅当排序后头部存在多个 expiresAt 并列（同一到期批次，
      // 含都无到期时间即都为 MAX 的情况）时，才在这批并列账号内用"闲置补偿加权随机"摊开负载；
      // 非并列时行为与原实现完全一致（取下标 0）。credits 不参与——expire_first 本意是烧到期批次。
      const headExp = pool2[0].expiresAt || Number.MAX_SAFE_INTEGER;
      const tiedHead = pool2.filter((a) => (a.expiresAt || Number.MAX_SAFE_INTEGER) === headExp);
      picked = tiedHead.length > 1 ? weightedPick(tiedHead, (a) => idleWeight(a, now)) : pool2[0];
      break;
    }
  }
  // 防惊群：100ms 内刚选中过同一账号且还有其他候选 → 让位重选（并发突发不再集中打一个号）。
  // 作用在加权/排序选出的结果之后，语义不变。
  if (pool2.length > 1 && now - (lastPickAt.get(picked.id) || 0) < 100) {
    const alt = pool2.find((a) => now - (lastPickAt.get(a.id) || 0) >= 100);
    if (alt) picked = alt;
  }
  lastPickAt.set(picked.id, now);
  // 选中即写 lastUsed：lastUsed 平时要等请求结束才更新，并发 N 个请求同窗口选号会全部
  // 压到 candidates[0] 上（突发集中打一个号易被上游风控识别）；先落笔把后续请求摊开
  store.updateAccount(picked.id, { lastUsed: now });
  return picked;
}

/** 次日 04:00（402 积分耗尽的长冷却点，对齐参考项目 HardCredit） */
function nextDay4AM() {
  const d = new Date();
  d.setHours(4, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  return d.getTime();
}

// ===== 模型级负缓存（账号×模型，内存态 + 落库持久化）=====
// 参考项目实证：6004 = 模型级限流（换模型即豁免）、11102 = 该账号不支持此模型。
// 这两类错误罚"账号×模型"组合而不是整个账号——账号对其他模型仍可用。
// 6004 对齐墙钟可达数小时、11102 封顶 24h，纯内存态重启即丢 → 每次重启都白撞一次
// 上游 429 才能重建负缓存（2026-09-21 实测），故写穿 model_cooldowns 表
const modelCool = new Map(); // `${accId}∥${modelId小写}` → untilMs

function modelCoolKey(accId, model) {
  return `${accId}∥${model}`.toLowerCase();
}

/** 惰性从库恢复未过期的模型级冷却（首次访问时一次）；库不可用时纯内存降级 */
let modelCoolHydrated = false;
function ensureModelCoolHydrated() {
  if (modelCoolHydrated) return;
  modelCoolHydrated = true;
  try {
    for (const row of store.listModelCooldowns()) {
      // 与 modelCoolKey 同口径：整个 key（含 accId）小写，避免非 UUID 账号 id 大小写错位
      modelCool.set(`${row.accId}∥${row.model}`.toLowerCase(), { until: row.until, reason: row.reason || "" });
    }
  } catch { /* 库不可用：降级为纯内存 */ }
}

/** 模型级冷却/负缓存：untilMs 之后自动豁免；定期清扫防内存膨胀。
 *  opts.backoff = 11102 指数退避（参考项目 BlockModelBackoff）：命中次数递增，base→cap 封顶 */
function coolAccountModel(accId, model, untilMs, reason, opts) {
  ensureModelCoolHydrated();
  if (modelCool.size > 20000) {
    const now = Date.now();
    for (const [k, v] of modelCool) if (v.until <= now) modelCool.delete(k);
  }
  const key = modelCoolKey(accId, model);
  const lowerModel = String(model).toLowerCase();
  if (opts && opts.backoff) {
    const now = Date.now();
    const cur = modelCool.get(key);
    const hits = cur && cur.until > now ? (cur.hits || 0) + 1 : 0;
    const base = Number(opts.baseMs) > 0 ? Number(opts.baseMs) : untilMs;
    const cap = Number(opts.capMs) > 0 ? Number(opts.capMs) : base * 4;
    const until = Math.min(base * Math.pow(2, hits), cap);
    modelCool.set(key, { until, reason: reason || "", hits });
    store.upsertModelCooldown(accId, lowerModel, until, reason);
    return;
  }
  modelCool.set(key, { until: untilMs, reason: reason || "" });
  store.upsertModelCooldown(accId, lowerModel, untilMs, reason);
}

/** 该账号此模型是否在负缓存中 */
function isModelCooled(accId, model) {
  ensureModelCoolHydrated();
  const hit = modelCool.get(modelCoolKey(accId, model));
  if (!hit) return false;
  if (hit.until <= Date.now()) {
    modelCool.delete(modelCoolKey(accId, model));
    store.deleteModelCooldowns(accId, String(model).toLowerCase());
    return false;
  }
  return true;
}

/** 错误分类冷却（方案 §6.10）：402→exhausted 至次日 04:00；429→60s；5xx→10min；401→relogin */
function coolAccount(id, kind, detail) {
  const now = Date.now();
  switch (kind) {
    case "credit": // 402 积分耗尽
      store.updateAccount(id, { status: "exhausted", coolUntil: nextDay4AM(), coolReason: detail || "积分耗尽" });
      break;
    case "rate": // 429 限流
      store.updateAccount(id, { status: "cooling", coolUntil: now + 60000, coolReason: detail || "上游限流" });
      break;
    case "server": // 5xx / 网络异常
      store.updateAccount(id, { status: "cooling", coolUntil: now + 600000, coolReason: detail || "上游异常" });
      break;
    case "relogin": // 401 刷新失败
      store.updateAccount(id, { status: "relogin", coolUntil: 0, coolReason: detail || "凭证失效，需重新登录" });
      break;
    default:
      store.updateAccount(id, { status: "cooling", coolUntil: now + 60000, coolReason: detail || "" });
  }
}

/** 按绝对时刻冷却（429 对齐上游重置墙钟 / Retry-After / 指数退避等场景需要精确 until） */
function coolAccountMs(id, untilMs, detail) {
  store.updateAccount(id, { status: "cooling", coolUntil: Math.max(Number(untilMs) || 0, Date.now() + 1000), coolReason: detail || "" });
}

// ===== 并发租约 / 防惊群 / 软限流指数 / 会话判定计数（内存态） =====

const inFlight = new Map(); // accId → 在途请求数
const lastPickAt = new Map(); // accId → 上次被 pickAccount 选中的时间戳
const softStreaks = new Map(); // accId → 连续 429（无明示重置时间）次数
const sessionDeadFails = new Map(); // accId → 连续凭证失效次数（参考项目：3 次才判废）
const serverFails = new Map(); // accId → 连续 5xx/网络失败次数（熔断器：3 次起 30m 指数封顶 6h）

function acquireAccount(id) { inFlight.set(id, (inFlight.get(id) || 0) + 1); }
function releaseAccount(id) {
  const n = (inFlight.get(id) || 1) - 1;
  if (n <= 0) inFlight.delete(id);
  else inFlight.set(id, n);
}

/** 429 无明示重置时间时的有界指数退避：60s 基数翻倍封顶 2h（参考项目 CooldownSoftRate 语义） */
function softBackoffMs(id) {
  const n = softStreaks.get(id) || 0;
  softStreaks.set(id, n + 1);
  return Math.min(60000 * Math.pow(2, Math.min(n, 7)), 2 * 3600000);
}

/** 凭证失效计数：返回是否已达判废阈值（连续 3 次，参考项目 sessionDeadThreshold=3） */
function noteSessionDead(id) {
  const n = (sessionDeadFails.get(id) || 0) + 1;
  sessionDeadFails.set(id, n);
  return n >= 3;
}

/** 5xx/网络熔断（参考项目 breaker：连续 3 次起 30m 指数封顶 6h）。
 *  返回冷却截止时刻；未达触发阈值返回 0（调用方走基础冷却） */
function noteServerError(id) {
  const n = (serverFails.get(id) || 0) + 1;
  serverFails.set(id, n);
  if (n < 3) return 0;
  return Date.now() + Math.min(30 * 60000 * Math.pow(2, Math.min(n - 3, 3)), 6 * 3600000);
}

/** 成功收尾：清软限流 streak / 凭证失效计数 / 熔断计数 / 该账号该模型的负缓存（参考项目 NoteSuccess 语义） */
function noteSuccess(id, model) {
  if (id == null) return;
  softStreaks.delete(id);
  sessionDeadFails.delete(id);
  serverFails.delete(id);
  if (model) {
    modelCool.delete(modelCoolKey(id, model));
    store.deleteModelCooldowns(id, String(model).toLowerCase());
  }
}

/** 手动解除冷却（号池页「解冷却」按钮）：账号级清状态立即回 online；
    该账号的模型级负缓存一并豁免——只解账号级的话调度照样跳过，等于没解 */
function releaseCool(id) {
  ensureModelCoolHydrated();
  const acc = store.getAccount(id);
  if (!acc) return { ok: false, message: "账号不存在" };
  // key 存的是 toLowerCase 后的 `${accId}∥${model}`，前缀匹配同样 lower
  const prefix = `${String(id).toLowerCase()}∥`;
  let releasedModels = 0;
  for (const k of modelCool.keys()) {
    if (k.startsWith(prefix)) {
      modelCool.delete(k);
      releasedModels++;
    }
  }
  store.deleteModelCooldowns(id, null); // 库里的模型级负缓存一并清（重启后不复活）
  if (acc.status === "cooling") {
    store.updateAccount(id, { status: "online", coolUntil: 0, coolReason: "" });
    return { ok: true, releasedModels };
  }
  // 账号级不 cooling 但存在模型级负缓存（6004/11102 只罚"账号×模型"，不落账号状态）：
  // 同样允许解除，否则墙钟冷却期间用户没有手动出口（持久化后负缓存跨重启存活）
  if (releasedModels > 0) return { ok: true, releasedModels };
  return { ok: false, message: "该账号不在冷却中" };
}

/** 该账号当前生效的模型级负缓存列表（号池页展示 + 解冷却入口判断）：
    6004/11102 只罚"账号×模型"不落账号状态，前端靠它才能看见并手动解除 */
function accountModelCool(id) {
  ensureModelCoolHydrated();
  const prefix = `${String(id).toLowerCase()}∥`;
  const now = Date.now();
  const out = [];
  for (const [k, v] of modelCool) {
    if (!k.startsWith(prefix)) continue;
    if (v.until <= now) continue;
    out.push({ model: k.slice(prefix.length), until: v.until, reason: v.reason || "" });
  }
  return out;
}

/** 号池聚合视图（号池卡片顶部：总余额/账号数/可用/最早到期/今日消耗，单一数据源实时推导） */
function poolSummary(channel) {
  const accs = poolAccounts(channel);
  const now = Date.now();
  const online = accs.filter((a) => a.status === "online" && a.hasToken);
  const expires = accs.map((a) => a.expiresAt).filter((t) => t > 0);
  return {
    channel,
    // -1 = 无限额度哨兵：不进总量（不是负数也不是真余额）
    totalCredits: online.reduce((s, a) => s + (a.credits > 0 ? a.credits : 0), 0),
    accountCount: accs.length,
    onlineCount: online.length,
    earliestExpire: expires.length ? Math.min(...expires) : 0,
    // 已过期必须单独出标志：expiresAt - now 对过期账号是负数，按旧的「< 86400000」判定会把
    // 过期一周的号也标成「即将到期」（2026-09-27 Trae 渠道侧栏实测）
    expired: accs.some((a) => a.expiresAt > 0 && a.expiresAt <= now),
    expiringSoon: accs.some((a) => a.expiresAt > now && a.expiresAt - now < 86400000),
    todayReq: accs.reduce((s, a) => s + a.todayReq, 0),
    todayTokens: accs.reduce((s, a) => s + a.todayTokens, 0),
    lastCreditsAt: accs.reduce((m, a) => Math.max(m, a.creditsAt || 0), 0),
  };
}

module.exports = {
  effectiveStatus, poolAccounts, pickAccount, coolAccount, coolAccountMs,
  coolAccountModel, isModelCooled, accountModelCool, poolSummary, nextDay4AM,
  acquireAccount, releaseAccount, softBackoffMs, noteSessionDead, noteServerError, noteSuccess,
  releaseCool,
};
