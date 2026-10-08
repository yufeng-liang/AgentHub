// 反代网关 · 编排层：模块装配 + IPC 命令注册（对应前端 src/views/proxy/* 与 src/api/ipc.ts）
// 设置统一存框架整体配置 config.json 的 proxy 段（config.cjs 默认值深合并），每次读取走磁盘 = 热生效；
// 端口属例外：改端口由 proxy_restart 同进程 stop→listen 秒级完成（方案 §6.6 第②层）
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const config = require("../config.cjs");
const store = require("./store.cjs");
const rules = require("./rules.cjs");
const pool = require("./pool.cjs");
const adapters = require("./adapters.cjs");
const provider = require("./provider.cjs");
const discovery = require("./discovery.cjs");
const credits = require("./credits.cjs");
const server = require("./server.cjs");
const events = require("./events.cjs");
const util = require("./util.cjs");
const ideswitch = require("./ideswitch.cjs");
const poolsync = require("./poolsync.cjs");
const ccswitch = require("./ccswitch.cjs");
const zcodeLocal = require("./zcodeLocal.cjs");
const zip = require("../zip.cjs");
const secretbox = require("./secretbox.cjs");

// 休眠唤醒守卫：避免唤醒瞬间逾期定时任务集中爆发（见 backend/wakeGuard.cjs 的实测说明）。
// 本模块跑在网关子进程里，所以只用它纯逻辑的那半边（noteTick / checkinAllowed）；powerMonitor
// 那半边由主进程 main.cjs 注入注册——wakeGuard 自身不 require("electron")，子进程 require 得到。
const wakeGuard = require("../wakeGuard.cjs");
/** 签到自动检查的 tick 间隔：既用于 setInterval，也作为 B（时间跳跃检测）的预期间隔 */
const CHECKIN_TICK_MS = 60000;

// ModelScope（魔搭）续期实现注入：discovery.cjs 顶部 require 了 adapters.cjs，
// 适配器反向 require 会形成循环依赖（Node 下取到半初始化模块），故与 qoderAdapter
// 同款处理——由编排层在这里把实现注入给适配器。
adapters.setModelScopeRefresh(discovery.refreshModelScopeToken);

// getShell 只在 2 条「留主进程」命令的**同名实现体**里被引用：proxy_open_rules_dir /
// proxy_open_data_dir 的 openPath。这两条在主进程由 gateway-client.cjs 用真 shell 另行实现
// （UI_LOCAL 四条之二），子进程表里的这份实现体只是命令表完整性的一部分，永远不会被派发到 ——
// 顶层 require("electron") 会让整张依赖图在纯 Node 子进程里加载不了（Task 0 实测唯一 FAIL 点），
// 故惰性取 + 拿不到时明确抛错，而不是让子进程 require 到一半炸掉。
function getShell() {
  try {
    const el = require("electron");
    return el && typeof el === "object" ? el.shell : null;
  } catch {
    return null;
  }
}

// ===== 号池 JSON 导入（粘贴 / 文件共用）：单个对象或数组，字段容忍常见别名 =====

/** JSON 文本宽容解析（快照形态的 credentials/config 常是字符串内嵌 JSON） */
function looseJson(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string") return null;
  try {
    const j = JSON.parse(value);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/**
 * zcode 快照形态识别（三种来源同构归一）：
 *   ① zcode-account-switcher 导出：{meta:{label,email}, snapshot:{credentials, config}}
 *   ② 官方/手工裸快照：{credentials, config}（credentials 可为对象或 JSON 字符串）
 *   ③ 官方档案导出：{provider_api_keys, cred_file?…} 带 credentials 键的变体
 * 守卫：credentials JSON 必须含 zcode 特征键（zcodejwttoken / oauth:* / account-provider:*），
 * 否则不接管（其他渠道的 credentials 字段名撞车不误导）。
 */
function normalizeZcodeSnapshot(raw) {
  const snap = raw.snapshot && typeof raw.snapshot === "object" ? raw.snapshot : raw;
  const credJson = looseJson(snap.credentials);
  if (!credJson) return null;
  const keys = Object.keys(credJson);
  if (!keys.some((k) => k === "zcodejwttoken" || k.startsWith("oauth:") || k.startsWith("account-provider:"))) return null;
  const parsed = zcodeLocal.parseCredentials(credJson);
  const configJson = looseJson(snap.config);
  const configKeys = zcodeLocal.extractConfigApiKeys(configJson);
  const label = (raw.meta && (raw.meta.label || raw.meta.email || raw.meta.name)) || snap.label || snap.name || snap.email || "";
  const record = zcodeLocal.accountRecord(parsed, {
    profileApiKeys: { ...configKeys, ...(looseJson(snap.provider_api_keys) || {}) },
    jwtFallback: configKeys["builtin:zai-start-plan"] || configKeys["builtin:bigmodel-start-plan"] || "",
    name: String(label || snap.name || ""),
    email: String((raw.meta && raw.meta.email) || snap.email || ""),
  });
  if (!record.token && !record.refreshToken) return null;
  return { channel: "zcode", ...record, expiresAt: 0, source: "json" };
}

// 一条记录归一化为 addAccount 入参；token 与 refreshToken 均为空返回 null（交由上层按无效计数）
function normalizeAccountJson(raw, fallbackChannel) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  // zcode 快照顾例先行（整份 credentials 导入，含切号快照）
  const snap = normalizeZcodeSnapshot(raw);
  if (snap) return snap;
  const channel = adapters.get(raw.channel) ? String(raw.channel) : fallbackChannel;
  let token = String(raw.token ?? raw.accessToken ?? raw.access_token ?? raw.jwt ?? raw.JWT ?? raw.zcodeJwtToken ?? raw.zcodejwttoken ?? "").trim();
  token = token.replace(/^Cloud-IDE-JWT\s+/i, "").replace(/^Bearer\s+/i, "");
  let refreshToken = String(raw.refreshToken ?? raw.refresh_token ?? raw.apiKey ?? raw.codingPlanKey ?? "").trim();
  // 智能识别：如果是 zcode 渠道，且 token 看起来是 32 位 apiKey.secret（2段且非 JWT），将其归一化到 refreshToken
  if (channel === "zcode") {
    if (token && !refreshToken && /^[a-f0-9]{32}\.[a-zA-Z0-9_-]+$/i.test(token)) {
      refreshToken = token;
      token = "";
    }
    if (!token && !refreshToken) return null;
  } else if (!token) {
    return null;
  }
  const dec = util.jwtDecode(token);
  let uid = String(raw.uid ?? raw.userId ?? raw.user_id ?? dec.uid ?? "").trim();
  if (!uid && refreshToken) {
    uid = crypto.createHash("sha256").update(refreshToken).digest("hex").slice(0, 16);
  }
  const out = {
    channel,
    uid,
    name: String(raw.name ?? raw.remark ?? "").trim(),
    token,
    refreshToken,
    expiresAt: Number(raw.expiresAt ?? raw.expires_at ?? 0) || 0,
    source: "json",
  };
  // zcode 专属画像字段（provider/email 透传 meta，切号快照缺失时这些是仅有的渠道身份）
  if (channel === "zcode" && (raw.provider || raw.email)) {
    out.meta = { provider: String(raw.provider || "zai"), email: String(raw.email || "") };
  }
  return out;
}

/** 解析 JSON 文本（对象 / 数组 / {accounts:[...]} 包装），返回 { list, invalid } */
function parseAccountsJson(text, fallbackChannel) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    throw new Error("JSON 解析失败：内容不是合法 JSON");
  }
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.accounts) ? parsed.accounts : [parsed];
  const list = [];
  let invalid = 0;
  for (const item of arr) {
    const acc = normalizeAccountJson(item, fallbackChannel);
    if (acc) list.push(acc);
    else invalid++;
  }
  return { list, invalid };
}

/** 批量入池：同渠道同 uid 已存在则跳过；入池即后台查一次额度 */
function importAccounts(list) {
  const existing = store.listAccounts();
  let added = 0, dup = 0;
  for (const acc of list) {
    if (acc.uid && existing.some((a) => a.channel === acc.channel && a.uid === acc.uid)) {
      dup++;
      continue;
    }
    const id = store.addAccount(acc);
    credits.refreshAccount(id).catch(() => {}); // 入池即查一次额度（失败不阻塞）
    added++;
  }
  return { added, dup };
}

/** 网关设置（框架整体配置的 proxy 段，深合并默认值后必有完整结构） */
function settings() {
  return config.loadConfig().proxy;
}

// 子进程角色开关：attachGatewayMode() 置真——事件出口换管道（events.setSink）。
// 监听决策归主进程（主进程 start() 成功后按 restoreOnLaunch 发 proxy_start / proxy_status），
// 本模块自身不按 restoreOnLaunch 自动 listen。
let gatewayAttached = false;

// ===== 签到（Trae ug 签到 / WB 双区 daily-checkin / WB AI trial 加油包，参考项目实证端点） =====
/** 批量签到动作：channel 为空 = 全渠道；accountId 指定 = 单账号（OAuth 登录后自动签到用）。
 *  国际版没有每日签到体系，checkin 动作对它自动改走 trial 加油包（与号池页按钮行为一致） */
let checkinBusy = false;
async function checkinBatch({ channel, accountId, action, interactive, captcha, planId }) {
  const acts = ["status", "checkin", "trial"];
  const act = acts.includes(String(action)) ? String(action) : "checkin";
  if (checkinBusy && act !== "status") return { ok: false, action: act, total: 0, okCount: 0, rows: [], message: "签到进行中" };
  if (act !== "status") checkinBusy = true;
  try {
    const accounts = store.listAccounts().filter(
      (a) =>
        (!channel || a.channel === channel) &&
        (!accountId || a.id === accountId) &&
        a.hasToken &&
        a.status !== "disabled"
    );
    const rows = [];
    for (const acc of accounts) {
      // 避免突发并发风控：多账号批量操作（非纯状态查询）在账号之间注入 800ms ~ 2000ms 随机抖动
      if (act !== "status" && accounts.length > 1 && rows.length > 0) {
        const jitter = 800 + Math.floor(Math.random() * 1200);
        await new Promise((r) => setTimeout(r, jitter));
      }
      const ad = adapters.get(acc.channel);
      const useAct = act === "checkin" && acc.channel === "workbuddy_ai" ? "trial" : act;
      const secrets = store.accountSecrets(store.getAccount(acc.id));
      try {
        let r;
        // 能力门禁：新渠道（cline_free/cline_pass/autoclaw/autoclaw_intl/qoder）官方就没有签到体系，
        // 适配器根本不定义这两个方法。缺守卫就是 "ad.checkin is not a function" 这句英文 TypeError
        // 原样进结果行、直出到前端。判据与下方 trial 一致（typeof === "function"）；缺能力按既有约定回
        // ok:true + unavailable:true（同 adapters 的 1001 分支）——前端 checkinTagCls 先判 !r.ok 就红，
        // 用 ok:false 会把「这渠道没签到」渲染成「这个号签到失败」。
        if (useAct === "status") {
          r = typeof ad.checkinStatus === "function" ? await ad.checkinStatus(acc, secrets) : { ok: true, unavailable: true, checkedIn: false, message: "该渠道没有签到状态可查" };
        } else if (useAct === "checkin") {
          r = typeof ad.checkin === "function"
            ? await ad.checkin(acc, secrets, captcha ? { captcha, planId } : undefined)
            : { ok: true, unavailable: true, checkedIn: false, message: "该渠道没有签到" };
          // zcode 领取奖励的人机校验二段流（上游 v1.31）：适配器返回 needCaptcha+captcha 配置。
          // 网关子进程是 ELECTRON_RUN_AS_NODE，拿不到 BrowserWindow——验证窗由渲染层过码
          // （号池页已加载阿里云 SDK），这里把 captcha 配置原样带回；UI 过码后带 verifyParam
          // 重调 checkin。无人值守的自动 tick 不弹窗，该行如实标「需人工过码」。
          if (r && r.needCaptcha && r.captcha && r.captcha.sceneId) {
            r = interactive
              ? { ok: false, needCaptcha: true, captcha: r.captcha, planId: r.planId, message: "领取奖励需要完成一次人机校验" }
              : { ok: false, needCaptcha: true, skipped: true, message: "领取奖励需要完成一次人机校验，请到号池页手动点「一键领取」" };
          }

        } else r = typeof ad.trial === "function" ? await ad.trial(acc, secrets) : { ok: false, message: "该渠道没有加油包" };
        rows.push({ accountId: acc.id, channel: acc.channel, name: acc.name, uid: acc.uid, ok: !!r.ok, ...r });
        // 签到成功（且不是幂等/不可用）后顺手刷新余额，让号池立刻看到新积分
        if (useAct !== "status" && r.ok && !r.unavailable && !r.already) {
          credits.refreshAccount(acc.id).catch(() => {});
        }
      } catch (e) {
        rows.push({ accountId: acc.id, channel: acc.channel, name: acc.name, uid: acc.uid, ok: false, message: String((e && e.message) || e) });
      }
    }
    const okCount = rows.filter((r) => r.ok).length;
    // 只有真正改了状态的 checkin/trial 才广播：status 是纯读取。广播它会让「收到 credits 就刷新」
    // 的号池页被自己触发的刷新再次唤醒，形成约 1.2 秒一轮的自激刷新循环（每轮还白打一次上游接口）
    if (act !== "status") events.emit({ type: "credits" });
    // 渠道可声明「领取窗口未开」（Qoder 每日 Credits 10:00 UTC+8 重置）：
    // 聚合最晚的重试时刻，供 checkinAutoTick 延后当天的自动签到
    const deferredRetryAt = rows.reduce((n, x) => Math.max(n, (x && x.deferred && Number(x.retryAt)) || 0), 0);
    return { ok: true, action: act, total: rows.length, okCount, rows, ...(deferredRetryAt ? { deferredRetryAt } : {}) };
  } finally {
    if (act !== "status") checkinBusy = false;
  }
}

// ===== 定时自动签到：每天到点自动跑一次全渠道（Trae/WorkBuddy 每日签到 + 国际版领加油包） =====
// setInterval 常驻、tick 动态读配置——开关/时间改完即生效，无需重启；当天已跑过不重跑。
// 重启应用后当天会再跑一次：签到/加油包都是幂等语义（already 不算失败），无害
let checkinTimer = null;
let lastAutoCheckinDay = "";
// 领取窗口未开（渠道 deferred）时的延后重试时刻：窗口开放前 60s tick 直接跳过，
// 且不标记当天已完成——否则一天一次的语义会永久错过当日窗口（Qoder 每日 10:00 UTC+8 重置）
let autoDeferredUntil = 0;
function checkinAutoTick() {
  try {
    const cfg = settings();
    if (!cfg.checkinAuto) return;
    // 唤醒守卫（见 backend/wakeGuard.cjs）：
    //   B. 先做时间跳跃检测——不依赖电源事件的兜底：睡眠期间定时器被冻结，
    //      唤醒后本轮间隔远大于 60s，推定刚唤醒并置静默窗（必须**先于** A/C 判定调用）
    //   A. 唤醒后 15 秒静默窗内不启动签到——否则一醒就开跑，与 Chromium 会话/GPU 恢复叠加
    //   C. 还要求「应用已连续唤醒 ≥ 30 秒」——签到批量本身持续 20~30 秒且带抖动，
    //      静默窗一过就开跑仍会压在用户刚开始操作的时刻上
    // ⚠ 此处**不能**先写 lastAutoCheckinDay：直接 return 让下一轮 tick 自然重试，
    //   否则当天签到会被永久跳过（本函数末尾才落标记）
    wakeGuard.noteTick("checkin-auto", CHECKIN_TICK_MS);
    if (!wakeGuard.checkinAllowed()) return;
    const now = new Date();
    const [h, m] = String(cfg.checkinAutoTime || "09:00").split(":").map((x) => Number(x) || 0);
    const planned = new Date(now);
    planned.setHours(h, m, 0, 0);
    if (now < planned) return;
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (lastAutoCheckinDay === day) return;
    if (Date.now() < autoDeferredUntil) return;
    lastAutoCheckinDay = day;
    checkinBatch({ action: "checkin" }).then((res) => {
      // deferred：撤销当天标记并记录重试时刻——60s tick 到点自会重跑并真正完成签到
      if (res && res.deferredRetryAt && res.deferredRetryAt > Date.now()) {
        lastAutoCheckinDay = "";
        // 延后只在当天内生效：retryAt 一旦落在明天及以后（远期活动实例/字段异常），
        // 窗口交由次日的例行签到重新评估——不让一个渠道的 deferred 停摆其它渠道好几天
        const endOfDay = new Date(now);
        endOfDay.setHours(24, 0, 0, 0);
        autoDeferredUntil = Math.min(res.deferredRetryAt, endOfDay.getTime());
      }
    }).catch(() => {});
  } catch {
    /* 配置读取失败下轮再试 */
  }
}
function startCheckinAuto() {
  stopCheckinAuto();
  checkinTimer = setInterval(checkinAutoTick, CHECKIN_TICK_MS);
}
function stopCheckinAuto() {
  if (checkinTimer) clearInterval(checkinTimer);
  checkinTimer = null;
}

/** 停机：先让在途监听与定时任务停下，最后才关库句柄（顺序反了会让在途请求写到已关闭的 db 上）。
 *  store.close() 在这里落地 = stats.db 的句柄归属有人收（二期写权归子进程独占，Task 3 把它升级成
 *  gracefulShutdown 并接上 stopAsync / 周期 checkpoint 计时器的停止）。
 *  与下面 gracefulShutdown() 的分工：这条是**主进程退出路径**的同步版——before-quit 不会 await 它，
 *  所以全程必须同步，否则 store.close() 赶不上进程退出；子进程侧用 await 版。
 *  Task 7 的装更互锁会把两者收敛到 gateway-client.stopAndWait() 一条实现上。 */
function shutdown() {
  credits.stopScheduler();
  stopCheckinAuto();
  discovery.cancelOAuth();
  server.stop();
  store.close();
}

/** 排空在途异步作业的预算上限（ms）。它与 server.cjs 的 CLOSE_BUDGET_MS、gateway.cjs 的
 *  RESPONSE_FLUSH_MS 一起构成「等干净的三段之和 < gateway.cjs 那条唯一硬退计时器的 EXIT_CEILING_MS」
 *  这条不变式（评审 I2②：旧值 1000 + stopAsync 的 1000 已经吃掉整个 2 s 上界，"必须退"总是抢在
 *  "等干净"前面拿到决定权）。四个数字由 scripts/dev-gateway-pipe-test.cjs 的**同一条断言**钉住，
 *  合计口径也只有那一条断言在算（CLOSE + DRAIN + FLUSH = 1600 < 2000）——这里不留第二个「预算」导出，
 *  免得下一位改数的人把少算一段的那个当成真相源。 */
const DRAIN_BUDGET_MS = 800;

/** 子进程侧唯一的优雅停机实现（Task 7 的 gateway_shutdown 命令体复用它，不开第二份）。
 *  与一期 shutdown() 的三处差别：① server.stop() 换成 await server.stopAsync()——
 *    stop()（server.cjs 的 stop）连监听释放都不等，跨进程场景下 NSIS 要的是映像解锁 + 端口释放；
 *  ② store.close() 内含 checkpoint 与周期计时器停止（Task 2 落地了调用点，Task 3 成对收尾计时器）；
 *  ③ 追加 rules.close() + drainLibuvWork()：热重载 watcher 既 ref 着事件循环，它首扫丢到
 *    libuv 线程池的 readdir/stat 作业又会在进程已 exit 时被工作线程回报到已关闭的 uv_async_t 上
 *    （实测 0xC0000409 fastfail，见 rules.close 的注释）。停机的定义因此必须含「在途异步作业落地」。
 *  返回值一路原样交给父进程（gateway.cjs 把它编进 gateway_shutdown 的响应）：
 *   · drained=false 排空超时、· forced=true 监听没在预算内释放、· port 是刚释放的那个端口。
 *  这两布尔缺一不可地上报（评审 I2③）：本任务最坏的失败形态「停不干净」过去在代码里是被允许通过的那一支。 */
async function gracefulShutdown() {
  credits.stopScheduler();
  stopCheckinAuto();
  discovery.cancelOAuth();
  const st = await server.stopAsync();
  await rules.close();
  store.close();
  const drained = await drainLibuvWork();
  return { ok: true, drained, forced: !!st.forced, port: Number(st.port) || 0 };
}

/** libuv 线程池上还有没有在途作业（fs 异步请求这类）。getActiveResourcesInfo() 是 Node 18+ 的
 *  公开 API，它把 handle 与 request 混在同一个数组里返回；request 的名字一律带 "Req"
 *  （FSReqCallback / GetAddrinfoReq / FileHandleReq），handle 的名字一律是 *Wrap / Timeout /
 *  Immediate，所以按 "Req" 取的就是「工作线程上还压着的活」。只等 request 不等 handle：
 *  handle 漏关是本机代码的配置问题，不该拿「给进程续命」来兜。 */
function pendingLibuvWork() {
  try { return process.getActiveResourcesInfo().filter((n) => /Req/.test(String(n))).length; }
  catch { return 0; }   // runtime 不提供这个 API 时不阻塞停机，行为退回修复前
}

/** 排空在途异步作业，带上界：停不干净也必须让 NSIS 拿到解锁的映像，不许把安装器挂死。
 *  返回是否在预算内排空（超时只是「没等到」，不是错误）。 */
async function drainLibuvWork(budgetMs) {
  const deadline = Date.now() + (Number(budgetMs) > 0 ? Number(budgetMs) : DRAIN_BUDGET_MS);
  while (pendingLibuvWork() > 0) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

// ===== IPC =====

function ok(data) {
  return { ok: true, ...data };
}
function fail(message) {
  return { ok: false, message: String((message && message.message) || message) };
}
function handle(fn) {
  return async (_event, args) => {
    try {
      return await fn(args || {});
    } catch (e) {
      return fail(e);
    }
  };
}

// 本机 agent 当前登录态速查（渠道 → uid）：读几个本地 JSON/信封，10s TTL 缓存，
// 号池轮询频率高，不能每次都全量重扫五个客户端的登录文件
let localLoginsCache = { at: 0, map: {} };
function currentLocalLogins() {
  const now = Date.now();
  if (now - localLoginsCache.at < 10000) return localLoginsCache.map;
  let map = {};
  try {
    map = discovery.currentLocalLogins() || {};
  } catch { /* 探测失败按「无本机登录」处理，徽标只是提示性信息 */ }
  localLoginsCache = { at: now, map };
  return map;
}

// 上游在这里实现的 openAuthWindow（Electron 沙箱授权窗）刻意不合：本文件跑在网关子进程
// （ELECTRON_RUN_AS_NODE），require("electron") 给的是路径字符串，new BrowserWindow 必抛。
// fork 的等价链路是 proxy_oauth_begin 只建会话、推 oauth-open 事件交主进程去开浏览器，
// 因此 helpers.openAuthWindow 恒缺省。两条已知代价，都写了就地注释、不是漏看：
//   ① 小浣熊：上游「深链不进系统浏览器、免得官方客户端消费掉一次性授权码」的网络层拦截没有对应实现；
//   ② ModelScope：上游 discovery.beginModelScopeOAuth 在 openAuthWindow 缺失时**自己就降级**为
//      系统浏览器 + 回环回调（见其函数头），OAuth 令牌与推理链路照常，只是采不到 Web 会话 Cookie，
//      于是「点赞 / 每日登录(daily_active)」两类魔粒任务不可用、签到会如实提示缺 Cookie。
// 要补齐得在主进程做授权窗 + 把采到的 Cookie 回传子进程，属独立改动，不塞进合并里顺手做。
/** 号池页/状态页的渠道列表：内置 4 家 + **全部**自建提供商（含已停用）。
 *  这里刻意不用 store.channelList()——那是路由视图，只给启用中的；停用的提供商总得在界面上
 *  看得见才可能被重新打开，从视图里消失等于让用户没法把它恢复。 */
function poolChannels() {
  return store.BUILTIN_CHANNELS.map((c) => ({ ...c, kind: "builtin", enabled: true })).concat(store.listProviders());
}

/** 号池全量视图：各渠道聚合 + 账号明细 + 调度策略（号池页数据源） */
function poolView() {
  const agents = store.listAgents();
  const localLogins = currentLocalLogins();
  // 阈值随设置热生效（无需重启网关）：每次取号池视图前对齐一次（廉价的模块级 setter）
  pool.setExpiringSoonDays(settings().expiringSoonDays);
  const soonMs = Math.max(0, Number(settings().expiringSoonDays) || 0) * 86400000;
  const now = Date.now();
  // 渠道降级快照一次取全（上游那版在循环里逐渠道取，每次都是全表快照）
  const health = server.channelHealthSnapshot();
  // 逐包明细（Q6）：从持久化的 credit_packages 读取并附 expired/expiringSoon 派生量（时间态不落库）
  const withPackages = (a) => ({
    ...a,
    modelCool: pool.accountModelCool(a.id),
    packages: store.listCreditPackages(a.id).map((p) => ({
      ...p,
      expired: p.expiresAt > 0 && p.expiresAt <= now,
      expiringSoon: p.expiresAt > now && p.expiresAt - now < soonMs,
    })),
  });
  // fork 的渠道清单走 poolChannels()（含自定义提供商），store 已不导出旧的 CHANNELS 常量
  return poolChannels().map((c) => {
    const summary = pool.poolSummary(c.id);
    // 当前电脑上的 agent 客户端登录的就是这个账号（按本机登录态 uid 比对，上游 v1.31）
    const localUid = String((localLogins[c.id] && localLogins[c.id].uid) || "");
    const accounts = pool.poolAccounts(c.id).map((a) => ({
      ...withPackages(a),
      liveHere: !!(localUid && a.uid && String(a.uid) === localUid),
    }));
    // 上游把这条从 return 里提到局部变量（costTier 与 poolStrategy 两处都要用），
    // fork 原来是在 return 里内联 agents.find(...)，同一意图
    const agent = agents.find((a) => a.id === c.id) || {};
    return {
      ...c,
      // 成本档：库内值优先（用户可能改过），空值回落 CHANNELS 种子默认
      costTier: agent.costTier || c.costTier || "",
      poolStrategy: agent.poolStrategy || "expire_first",
      summary,
      accounts,
      health: health[c.id] || null, // 降级状态（until/reason/streak），null=正常
    };
  });
}

function gatewayStatus() {
  const s = server.status();
  const cfg = settings();
  // 渠道清单同 poolView：用 fork 的 poolChannels()（带 kind、含自定义提供商，store 已不导出旧 CHANNELS）；
  // 降级快照一次取全，不在 map 里逐渠道重取
  const health = server.channelHealthSnapshot();
  return {
    ...s,
    port: s.running ? s.port : cfg.port,
    bind: s.running ? s.bind : cfg.bind,
    baseUrl: `http://${s.running ? s.bind : cfg.bind}:${s.running ? s.port : cfg.port}/v1`,
    today: store.statsToday(),
    channels: poolChannels().map((c) => ({ id: c.id, display: c.display, kind: c.kind, ...pool.poolSummary(c.id), health: health[c.id] || null })),
    keyCount: store.listKeys().length,
    vaultOk: vaultOk(),
    dbDriver: store.driver(),
    // WAL 观测出口（三期 Task 3）：walBytes 让「是否还在单调增长」可量化，lastCheckpoint 让
    // 「上一次周期 checkpoint 跑没跑 / 截动了没有 / 报了什么错」可读。二期结尾那个
    // 1,388,472 B 冻结缺陷之所以拖了一期，就是这两个量在命令面上一个都不存在。
    walBytes: store.walBytes(),
    lastCheckpoint: store.lastCheckpoint(),
  };
}

// 保险可用性 = 「凭据能不能被解」，与在哪个进程无关。旧实现只看 safeStorage，
// 子进程里没有 electron 绑定 → 恒 false → 网关页误报（见 §5.7 更正：这条命令因此可转发）。
function vaultOk() { return secretbox.backend() !== "none"; }

// rememberRunning（proxy.restoreOnLaunch 的写权）二期 Task 5 撤出本文件、上移到
// gateway-client.cjs：启停命令的转发体在主进程，成功后由**主进程**写 config.json。
// 子进程永不写 config.json —— 那是主进程的写权（Task 2 的写权归属），留在这里就会双写。

/** 子进程侧后台作业（二期 Task 5）：额度定时刷新 + 定时自动签到。
 *  这两个计时器过去在主进程跑；43 条命令下沉子进程后随实现体一起下沉 ——
 *  留在主进程就会双跑（同一批号被签到两次、同一批号被刷两次额度），这是 gateway.cjs
 *  文件头「子进程不跑计时器」那条注释的解除时刻。签到/刷新的实现体本就在本模块
 *  （checkinBatch / credits），gateway.cjs 装配时调用这里这一个入口，不开第二份实现。
 *  上游 v1.34/v1.36 往它自己的 boot() 里追加了两件启动装配（deviceMid 撞车自愈、remoteMid
 *  云端兜底）。两者都要读号池库、后者还写子进程独占的 sync-state.json ⇒ 按 §5.4 单一写者
 *  落在本函数，而不是还原上游 boot()：本 fork 已无主进程 proxy.boot()。 */
function startBackgroundJobs() {
  // 存量迁移（deviceMid 撞车自愈启动闸，上游 v1.34.0）：历史版本会给「导入时是本机登录态」的账号继承
  // 同一枚 live 指纹（adopt 陷阱），多号共用一枚指纹 = 一号领取全组 1004。
  // 启动时静默跑一次修复，只动撞车/被烧的账号，正常账号零影响（幂等）
  try {
    const zs = require("./zcodeSwitch.cjs");
    const ds = zs.deviceStatus();
    if (ds.rows.some((r) => r.conflictWith.length || r.burnedLikely || !r.deviceMid)) {
      zs.repairDeviceMid({});
    }
  } catch { /* 迁移失败不阻断启动，号池页仍可手动修复 */ }
  credits.startScheduler(() => settings().creditsRefreshMin);
  startCheckinAuto();
  // 远程锚定指纹（remoteMid）的云端兜底（上游 v1.36.0）：本机 anchor 缺锚（重装/换机）先从 WebDAV 拉回；
  // 有锚则顺手上传一份（内容 hash 记账，未变不重传）。fire-and-forget，WebDAV 未配置/网络
  // 失败一律静默——锚定的主事实在本机 anchor 文件里，云端只是防丢副本
  try {
    const ps = require("./poolsync.cjs");
    const zl = require("./zcodeLocal.cjs");
    void (async () => {
      const st = zl.remoteMidState();
      if (!st.anchorMid) await ps.restoreAnchorMidFromRemote();
      await ps.backupAnchorMid();
    })().catch(() => {});
  } catch { /* WebDAV 不可用不影响启动 */ }
}

function register(ipcMain) {
  // 请求流水保留期从设置灌入（open() 的启动 GC 在首次摸库时才跑，register 先行不踩空）
  store.setUsageRetention(settings().usageRetentionDays);
  // 积分包「即将到期」阈值灌入号池模块（Q4）：poolSummary 的 expiringSoon 与到期总览分级共用
  pool.setExpiringSoonDays(settings().expiringSoonDays);
  // ===== 服务启停 / 状态（主进程侧的薄包装见 gateway-client.cjs：转发 + 成功后写 restoreOnLaunch） =====
  ipcMain.handle("proxy_status", handle(() => gatewayStatus()));
  ipcMain.handle("proxy_start", handle(async () => {
    const r = await server.start(settings);
    // claimed 分支的 restoreOnLaunch 守卫（评审 I3）随写权一起上移到 gateway-client.cjs：
    // 那条分支里本进程没有监听，配置不能记「本机在监听」，判断依据是响应里的 claimed 字段。
    events.emit({ type: "status" });
    // claimed：端口其实被**已常驻的网关**占着（server.cjs 的 EADDRINUSE 分支查过 gateway.json 并双检通过），
    // 此时本进程没有监听，接管状态与端口归属都由认领方维持（Task 6 的认领路径依赖这条不报错）
    return r.ok ? ok({ port: r.port, already: !!r.already, claimed: !!r.claimed }) : fail(r.message);
  }));
  ipcMain.handle("proxy_stop", handle(() => {
    server.stop();
    events.emit({ type: "status" });
    return ok({});
  }));
  // 改端口后调用：同进程 stop→listen，秒级完成（方案 §6.6）
  ipcMain.handle("proxy_restart", handle(async () => {
    const st = await server.stopAsync();
    // 评审裁定（Task 5 刀 2）：stop 没在预算内释放端口（forced=true）时**不盲启**。旧实现无视
    // forced 继续 start()，那个端口上挂着的正是自己没释放干净的旧监听 —— EADDRINUSE 分支的
    // probeResidentGateway 还会把它误认成「常驻网关」接管（claimed），看似成功实则无人监听，
    // 而且主进程会照常把 restoreOnLaunch 记成 true。代价：用户要手动再点一次（预算 1.5 s 内
    // 端口通常早释放了，forced 本来就是罕见路径），换来「成功必然真在监听」这个不变式。
    if (st.forced) {
      events.emit({ type: "status" });
      return fail("旧监听未能在预算内释放（端口 " + (Number(st.port) || settings().port) + " 仍被占用），请稍后重试");
    }
    const r = await server.start(settings);
    credits.startScheduler(() => settings().creditsRefreshMin); // 刷新周期一并热生效
    pool.setExpiringSoonDays(settings().expiringSoonDays); // 到期预警阈值一并热生效
    events.emit({ type: "status" });
    return r.ok ? ok({ port: r.port }) : fail(r.message);
  }));

  // ===== API Keys =====
  ipcMain.handle("proxy_keys_list", handle(() => store.listKeys()));
  ipcMain.handle("proxy_key_create", handle(({ name, route, routeOrder, dailyQuota, rateLimit }) => {
    const r = store.createKey({ name, route, routeOrder, dailyQuota, rateLimit });
    const row = store.listKeys().find((k) => k.id === r.id);
    // 完整 Key 已以 DPAPI 信封存库，列表接口随时可取（列表行内即带 secret）
    return { ...row, secret: r.secret };
  }));
  ipcMain.handle("proxy_key_update", handle(({ id, name, route, routeOrder, dailyQuota, rateLimit, enabled }) => {
    if (!store.updateKey(id, { name, route, routeOrder, dailyQuota, rateLimit, enabled })) return fail("Key 不存在");
    return ok({});
  }));
  ipcMain.handle("proxy_key_delete", handle(({ id }) => {
    if (!store.deleteKey(id)) return fail("Key 不存在");
    return ok({});
  }));

  // ===== 号池 =====
  ipcMain.handle("proxy_pool", handle(() => poolView()));
  ipcMain.handle("proxy_pool_strategy", handle(({ channel, strategy }) => {
    if (!store.setPoolStrategy(channel, strategy)) return fail("不支持的调度策略");
    return ok({});
  }));
  ipcMain.handle("proxy_pool_tier", handle(({ channel, tier }) => {
    if (!store.setAgentCostTier(channel, tier)) return fail("不支持的成本档位");
    return ok({});
  }));
  // 手动粘贴（方案 §2.4 三途径之一）；token 仅本地加密存储
  ipcMain.handle("proxy_account_add", handle(({ channel, name, token, refreshToken, uid }) => {
    if (!adapters.get(channel)) return fail("未知渠道");
    if (!String(token || "").trim()) return fail("请粘贴 token / JWT");
    // ModelScope（魔搭）：凭据形态与其它渠道不同（ms- 访问令牌，非 JWT），且必须先校验
    // 令牌有效性、并用真实用户名作 uid（否则号池去重失效、credit_first 排序错乱）。
    // 故走专用导入路径，不做 JWT 解码。
    if (channel === "modelscope") {
      return discovery.importModelScopeToken(String(token).trim()).then((r) => {
        if (!r.ok) return fail(r.message);
        credits.refreshAccount(r.id).catch(() => {});
        // 入池即跑一次每日任务（登录 200/绑云 50 自动 + 点赞补足）——与 OAuth 路径行为对齐
        checkinBatch({ accountId: r.id, action: "checkin" }).catch(() => {});
        return ok({ id: r.id, uid: r.uid, updated: r.updated, message: r.message });
      }).catch((e) => fail(String((e && e.message) || e)));
    }
    const clean = String(token).trim().replace(/^Cloud-IDE-JWT\s+/i, "").replace(/^Bearer\s+/i, "");
    const dec = util.jwtDecode(clean);
    const id = store.addAccount({
      channel,
      uid: String(uid || dec.uid || ""),
      name: String(name || "").trim() || (dec.uid ? `账号 ${dec.uid.slice(-6)}` : "手动添加"),
      token: clean,
      refreshToken: String(refreshToken || "").trim(),
      source: "paste",
    });
    credits.refreshAccount(id).catch(() => {}); // 入池即查一次额度（失败不阻塞）
    return ok({ id });
  }));
  ipcMain.handle("proxy_account_remove", handle(({ id }) => {
    const acc = store.getAccount(id);
    if (!acc) return fail("账号不存在");
    // 先写墓碑再删本机：删除要经 WebDAV 传播到其他设备（号池同步拉取时按墓碑移除）
    poolsync.noteRemoved(poolsync.accountKeyOf(acc));
    if (!store.removeAccount(id)) return fail("账号不存在");
    return ok({});
  }));
  ipcMain.handle("proxy_account_toggle", handle(({ id, enabled }) => {
    const acc = store.getAccount(id);
    if (!acc) return fail("账号不存在");
    store.updateAccount(id, enabled
      ? { status: "online", coolUntil: 0, coolReason: "" }
      : { status: "disabled" });
    return ok({});
  }));
  // 重命名账号（自定义备注）：只写 name 列，不推进任何参与 LWW 比较的时间戳 ⇒ 已知缺陷（本期不修）：
  // uid 缺失的号以 name 作身份键（poolsync.accountKeyOf），改名会被下一轮号池同步还原、并在对端按新键多出一条号
  // （上游 v1.18.0 带来的命令，三期 Task 1 接线：随 register() 同源进 dispatchTable ⇒ 归子进程，号池写权仍单一）
  ipcMain.handle("proxy_account_rename", handle(({ id, name }) => {
    const acc = store.getAccount(id);
    if (!acc) return fail("账号不存在");
    // uid 缺失时改名会改身份键（poolsync.accountKeyOf 退回 name），导致同步后同一 token 变两条号 ⇒ 拒绝
    // （三期 fork 侧修复，2026-09-24，用户裁决选「拒绝」而非加稳定身份键）
    if (poolsync.renameWouldChangeIdentity(acc)) {
      return fail("该账号没有 UID，改名会让号池同步把它认成另一个号（同一 token 变两条）。如需改名请删除后重新添加");
    }
    store.updateAccount(id, { name: String(name || "").trim() });
    return ok({});
  }));
  // 手动解除冷却：cooling 账号立即回 online，同时豁免该账号的模型级负缓存
  ipcMain.handle("proxy_account_cool_off", handle(({ id }) => {
    const r = pool.releaseCool(String(id || ""));
    return r.ok ? ok({ releasedModels: r.releasedModels }) : fail(r.message);
  }));
  ipcMain.handle("proxy_account_refresh", handle(({ id }) => credits.refreshAccount(id)));
  ipcMain.handle("proxy_credits_refresh", handle(() => credits.refreshAll()));
  // 号池页右上角「刷新当前渠道」：只刷一个编译器的号池额度
  ipcMain.handle("proxy_credits_refresh_channel", handle(({ channel }) => {
    if (!channel) return fail("缺少渠道参数");
    return credits.refreshChannel(String(channel));
  }));

    // ===== 签到（Trae ug 签到 / WB 双区 daily-checkin / WB AI trial 加油包 / ZCode 领取奖励，参考项目实证端点） =====
  // 批量签到动作见模块级 checkinBatch（手动 IPC 与定时自动签到共用）；
  // 手动发起 interactive=true——zcode 领取需要人机校验时允许弹官方 SDK 验证窗
  ipcMain.handle("proxy_checkin_status", handle(({ channel, accountId }) => checkinBatch({ channel, accountId, action: "status" })));
  ipcMain.handle("proxy_checkin_run", handle(({ channel, accountId, action, captcha, planId }) => checkinBatch({ channel, accountId, action: action || "checkin", interactive: true, captcha, planId })));

  // ===== 凭据接入：本机软件导入 =====
  ipcMain.handle("proxy_scan", handle(() => {
    const found = discovery.scanAll();
    const existing = store.listAccounts();
    return found.map((c) => ({
      ...c,
      token: "", // 凭据不出主进程：导入时按候选标识回读
      refreshToken: "",
      imported: !!(c.uid && existing.some((a) => a.channel === c.channel && a.uid === c.uid)),
    }));
  }));
  // 导入本机候选：index 指向 proxy_scan 返回的数组下标；
  // 同时带上 channel/file 做一次身份核对 —— 两次扫描之间文件可能增减，只认下标会导错账号
  ipcMain.handle("proxy_scan_import", handle(({ index, channel, file, uid }) => {
    const found = discovery.scanAll();
    let c = found[Number(index)];
    if (file || uid) {
      // 身份核对：三个约束**同时**成立才算同一条候选。旧写法是 `file || uid` 的或，而两个渠道的本机
      // 登录文件可以同名（小浣熊与 AutoClaw 都叫 auth.json），scanAll() 里小浣熊又排在 AutoClaw 前面
      // ⇒ 点 AutoClaw 那行会命中排前的小浣熊，把别家凭据静默挂到所点渠道下（真机 2026-09-27 抓到，
      // 闸见 scripts/dev-autoclaw-test.cjs「proxy_scan_import 身份复核」节）。
      const hit = found.find((x) =>
        (!channel || x.channel === channel) && (!file || x.file === file) && (!uid || x.uid === uid));
      if (!hit) return fail("候选已变化（本地登录态可能刚被更新），请重新扫描后再导入");
      c = hit;
    }
    if (!c) return fail("候选不存在，请重新扫描");
    const r = discovery.importCandidate(c, channel || undefined);
    credits.refreshAccount(r.id).catch(() => {});
    return ok({ id: r.id, updated: r.updated });
  }));
  // oauth_begin 的形状（二期 Task 5）：本进程只创建 OAuth 会话，登录页的打开由**主进程**做 ——
  // 会话建好、拿到 url 后推 {type:"oauth-open", url} 事件（CRITICAL_EVENTS 成员，背压不丢），
  // 主进程收到才 shell.openExternal。旧实现在这里直接开浏览器，下沉后拿不到 shell。
  // 抛错时机说明：beginOAuth 同步抛的错（已有进行中的登录 / 未知渠道 / 小浣熊不支持）在
  // handle() 里收成 {ok:false, message}，用户立刻看到；旧实现「beginOAuth 成功之后才可能
  // 因 shell 缺失而抛错」的那条路径随 openExternal 下移而消失（主进程 shell 恒在）。
  // 参数：edition/vendor/captchaVerifyParam 供新渠道用（autoclaw 国际的滑块第二跳要原样回传
  // captchaVerifyParam，edition/vendor 决定跳哪个授权域），旧调用只传 channel 时它们为 undefined。
  ipcMain.handle("proxy_oauth_begin", handle(async ({ channel, edition, vendor, captchaVerifyParam }) => {
    // OAuth 只对内置生态渠道存在：提供商没有授权页可跳，落到兜底渠道会把用户带去登录别人的账号
    if (!store.isBuiltinChannel(channel) || !adapters.get(channel)) return fail("该渠道不支持 OAuth 登录");
    const ch = String(channel);
    const r = await discovery.beginOAuth(ch, { edition, vendor, captchaVerifyParam }, (result) => {
      if (result.ok) {
        credits.refreshAccount(result.id).catch(() => {});
        // 登录后自动签到一次（参考项目 login.sh / signin 同款：自动签到 + 查积分）
        checkinBatch({ accountId: result.id, action: "checkin" }).catch(() => {});
      }
      events.emit({ type: "oauth-done", channel: ch, ...result });
    });
    if (r.ok && r.url) events.emit({ type: "oauth-open", channel: ch, url: r.url });
    // mode=device（cline WorkOS / qoder PKCE 设备流）额外回 userCode 供 UI 展示；
    // needCaptcha/captcha 必须一并透传：autoclaw_intl 第一跳没有 url，只回滑块配置，
    // 丢了这两个键 UI 就分不清「要滑块」还是「已打开登录页」，会停在假等待态（Task 12 终审 M1）
    return r.ok
      ? ok({ url: r.url, mode: r.mode, userCode: r.userCode || "", needCaptcha: !!r.needCaptcha, captcha: r.captcha })
      : fail(r.message);

  }));
  ipcMain.handle("proxy_oauth_cancel", handle(() => ok({ cancelled: discovery.cancelOAuth() })));
  // 浏览器没跳回回环地址时的兜底：把地址栏内容整段粘回来完成登录
  ipcMain.handle("proxy_oauth_submit_callback", handle(async ({ channel, url }) => {
    const r = await discovery.submitCallbackUrl(url, channel);
    // LobsterAI 的「晚到回调」补交路径不经过 beginOAuth 的 onDone（会话可能已超时关闭），
    // 故这里自行补跑「刷新余额 + 自动签到」——否则新入池账号停在 credits=0 / creditsAt=0，
    // 会被 credit_first 策略误判为最末位（与 onDone 路径行为对齐）。
    // 必须限定 channel：其它渠道的 submit（raccoon / zcode）内部已调 finishOAuth→onDone，
    // 同一套副作用会被执行第二遍（重复余额请求 / 重复签到 / 重复 oauth-done 事件）。
    if (r && r.ok && r.id && String(channel || "") === "lobster") {
      credits.refreshAccount(r.id).catch(() => {});
      checkinBatch({ accountId: r.id, action: "checkin" }).catch(() => {});
      events.emit({ type: "oauth-done", channel: String(channel || ""), ok: true, id: r.id, uid: r.uid });
    }
    return r;
  }));

  // ===== 凭据接入：粘贴 JSON / 从 JSON/ZIP 文件添加（批量，字段容忍别名） =====
  ipcMain.handle("proxy_account_import_json", handle(({ channel, json }) => {
    // 生态渠道的凭据包导入；提供商的 Key 走 proxy_provider_add_key（一条一把，没有 JSON 包形态）
    if (!store.isBuiltinChannel(channel) || !adapters.get(channel)) return fail("该渠道不支持 JSON 导入");
    const fallback = String(channel);
    const { list, invalid } = parseAccountsJson(json, fallback);
    if (!list.length) return fail(invalid ? `没有可导入的账号（${invalid} 条记录缺 token）` : "没有可导入的账号");
    const r = importAccounts(list);
    const parts = [`成功导入 ${r.added} 个账号`];
    if (r.dup) parts.push(`${r.dup} 个同 UID 已存在跳过`);
    if (invalid) parts.push(`${invalid} 条记录缺 token 忽略`);
    return ok({ ...r, invalid, message: parts.join("，") });
  }));
  // 从 JSON/ZIP 文件添加 · 子进程半段（Task 5 拆两段）：主进程弹框读字节、base64 过管道
  // 投到这条命令（zip.readZip + importAccounts，即拆分前的 :412-432 主体）。文件选择框在
  // 纯 Node 子进程里弹不了，字节过管道后实现体留在这一侧——号池写权（store）归子进程独占。
  // name：原始文件名，zip 判定沿用「按扩展名」（拆分前就是 /\.zip$/i），结果文案也用它。
  ipcMain.handle("proxy_account_import_blob", handle(({ channel, blob, name }) => {
    const fallback = adapters.get(channel) ? String(channel) : store.BUILTIN_CHANNELS[0].id;
    const buf = Buffer.from(String(blob || ""), "base64");
    if (!buf.length) return fail("文件内容为空");
    const fileName = String(name || "");
    let texts = [];
    if (/\.zip$/i.test(fileName)) {
      let entries;
      try {
        entries = zip.readZip(buf).filter((e) => /\.json$/i.test(e.name));
      } catch (e) {
        return fail("压缩包读取失败：" + String((e && e.message) || e));
      }
      if (!entries.length) return fail("压缩包里没有 .json 文件");
      texts = entries.map((e) => e.data.toString("utf8"));
    } else {
      texts = [buf.toString("utf8")];
    }
    let added = 0, dup = 0, invalid = 0;
    for (const text of texts) {
      let parsed;
      try {
        parsed = parseAccountsJson(text, fallback);
      } catch {
        invalid++; // 单个 JSON 坏了不拖垮整包
        continue;
      }
      invalid += parsed.invalid;
      const r2 = importAccounts(parsed.list);
      added += r2.added;
      dup += r2.dup;
    }
    if (!added && !dup) return fail(`没有可导入的账号（${invalid ? `${invalid} 条记录无效` : "文件为空"}）`);
    const parts = [`成功导入 ${added} 个账号`];
    if (dup) parts.push(`${dup} 个同 UID 已存在跳过`);
    if (invalid) parts.push(`${invalid} 条记录无效忽略`);
    return ok({ added, dup, invalid, message: parts.join("，") });
  }));
  ipcMain.handle("proxy_account_import_file", handle(() =>
    fail("该命令的文件选择半段只在主进程：子进程表保留这个占位名是为逐字相等闸（④ ⊇ ②）无例外，字节应经 proxy_account_import_blob 投递")));
  // webdav_shared_save 的反向跨界半段（Task 5）：主进程改了 WebDAV 共享口令后投这条命令，
  // 在**子进程内**给 sync-state.json 记 keyChangeAt（那份文件归子进程独占，主进程不再直接写）
  ipcMain.handle("proxy_poolsync_password_changed", handle(() => {
    poolsync.onSharedPasswordMaybeChanged();
    return ok({});
  }));

  // ===== 模型目录 =====
  // 合并视图 + 管理态（启停/渠道覆盖/回退模型/自定义参数）；管理态由渲染层写回整体配置（app.save），服务端每请求读盘热生效
  ipcMain.handle("proxy_models", handle(() => {
    const cfg = settings();
    return adapters.mergedModels(cfg).map((m) => ({

      ...m,
      enabled: !(cfg.disabledModels || []).includes(m.id),
      override: (cfg.modelOverrides || {})[m.id] || "",
      fallback: (cfg.modelFallback || {})[m.id] || "",
      custom: (cfg.modelCustom || {})[m.id] || undefined,
    }));
  }));
  // 官方模型目录拉取（三渠道通用）：取号池里第一个 online 有 token 的账号，adapter.fetchModels 走云端接口
  // （Trae get_detail_param / WB v3/config + console models），结果写回 rules/catalog.json 热生效。
  // 拉取失败不写空——保留旧目录，面板报错由用户重试
  ipcMain.handle("proxy_models_sync", handle(async ({ channel }) => {
    const ch = String(channel || "");
    // 只服务内置渠道：它的落点是 rules/catalog.json（内置渠道的元数据本来就在里面），
    // 提供商的清单归 models_json、由「自定义提供商」页自己拉。放过来会把提供商的模型写进内置目录，
    // 而且内置适配器签名是 fetchModels(account, secrets)、compat 是 fetchModels(secrets)，
    // 这里统一按内置签名调用，提供商渠道会拿到一个 undefined 的 Key——两条都是静默错。
    // 注意先判「渠道到底存不存在」：若直接按 !isBuiltinChannel 拦，一个真的拼错的渠道名
    // （如 "no-such-channel"）也会拿到「请去自定义提供商页拉取」的误导文案（本分支合并时踩到）。
    if (!store.isBuiltinChannel(ch)) {
      return store.getProvider(ch)
        ? fail("自定义提供商的模型清单请在「自定义提供商」页的模型列表里拉取与勾选")
        : fail(`未知渠道 "${ch}"`);
    }
    const adapter = adapters.get(ch);
    if (!adapter) return fail(`未知渠道 "${ch}"`);
    // 适配器在、只是不提供 fetchModels：AutoClaw 的模型目录就是内置静态表（官方目录端点无人调用），
    // 这时报「未知渠道」是谎报——渠道明明存在，用户会以为号池配坏了。按渠道类别说清缺的是哪个能力。
    if (typeof adapter.fetchModels !== "function") {
      return fail(store.isBuiltinChannel(ch) ? "该渠道模型目录为内置，不支持同步" : `自定义提供商 "${ch}" 不支持模型目录同步`);
    }
    const acc = pool.poolAccounts(ch).find((a) => a.status === "online" && a.hasToken);
    if (!acc) return fail(`${store.channelDisplay(ch)}号池无可用账号，无法拉取模型目录`);
    const secrets = store.accountSecrets(store.getAccount(acc.id));
    const r = await adapter.fetchModels(acc, secrets);
    if (!r || !r.ok || !Array.isArray(r.models) || !r.models.length) {
      return fail((r && r.message) || "目录拉取失败");
    }
    const file = path.join(rules.rulesDir(), "catalog.json");
    const cur = JSON.parse(JSON.stringify(rules.get("catalog.json") || {}));
    cur[ch] = { syncedAt: Date.now(), models: r.models };
    fs.writeFileSync(file, JSON.stringify(cur, null, 2), "utf8");
    rules.reload("catalog.json");
    const withRate = r.models.filter((m) => m && m.rate != null).length;
    return ok({ channel: ch, count: r.models.length, withRate });
  }));

  // ===== 生态接入：CC Switch =====
  ipcMain.handle("proxy_ccswitch_status", handle(() => ccswitch.status()));
  ipcMain.handle("proxy_ccswitch_register", handle(({ appType, apiKey, model, port }) =>
    ccswitch.register({ appType, apiKey, model, port })));

  // ===== 本地 IDE 快捷切换账号 =====
  // zcode 渠道：客户端在跑时首调返回 needConfirm（前端弹确认），用户确认后带 confirmAck 重调
  ipcMain.handle("proxy_ide_switch", handle(({ accountId, confirmAck }) => ideswitch.switchIdeAccount(accountId, { confirmAck: !!confirmAck })));
  ipcMain.handle("proxy_ide_status", handle(() => ideswitch.ideSwitchStatus()));
  // zcode 切号回滚（逃生通道：切出问题 / 远程连接异常时一键还原最近一次切前状态）
  ipcMain.handle("proxy_zcode_switch_rollback", handle(() => require("./zcodeSwitch.cjs").rollbackLatest()));
  // zcode 设备指纹诊断（只读）：多号共用一枚指纹 = 一号领取全组 1004 的病灶定位
  ipcMain.handle("proxy_zcode_device_status", handle(() => require("./zcodeSwitch.cjs").deviceStatus()));
  // zcode 设备指纹修复（幂等）：撞车/疑似被烧的账号重派全新随机指纹，claim 1004 的唯一出路
  ipcMain.handle("proxy_zcode_device_repair", handle(({ all } = {}) => require("./zcodeSwitch.cjs").repairDeviceMid({ all: !!all })));
  // zcode 领取模式（人工链路）：live 指纹临时借出为目标账号专属指纹，官方客户端里人工领周末
  // 套餐用；客户端在跑时首调返回 needConfirm（前端弹确认），确认后带 confirmAck 重调
  ipcMain.handle("proxy_zcode_claim_mode", handle(({ accountId, confirmAck } = {}) =>
    require("./zcodeSwitch.cjs").enterClaimMode(String(accountId || ""), { confirmAck: !!confirmAck })));
  // zcode 恢复本机锚定指纹（领取模式收尾）：anchor.remoteMid 写回 live，手机远程随之恢复
  ipcMain.handle("proxy_zcode_restore_mid", handle(({ confirmAck } = {}) =>
    require("./zcodeSwitch.cjs").restoreRemoteMid({ confirmAck: !!confirmAck })));
  // zcode 独立人机校验（过码）：弹独立沙箱窗过码，拿 verifyParam 核销并解除风控限制
  ipcMain.handle("proxy_zcode_solve_captcha", handle(async ({ accountId, verifyParam, region } = {}) => {
    if (!accountId) return fail("缺少账号 ID");
    const acc = store.getAccount(accountId);
    if (!acc) return fail("未找到指定账号");
    if (acc.channel !== "zcode" && acc.channel !== "zcode_intl") return fail("该渠道不支持此人机校验");
    const secrets = store.accountSecrets(acc);
    const ad = adapters.get("zcode");
    if (!ad || typeof ad.solveCaptchaWithParam !== "function") return fail("适配器不支持人机校验");
    // 两段式：不带 verifyParam → 先回滑块配置（UI 弹渲染层过码）；带了 → 完成上报/核销并解除冷却
    if (!verifyParam) {
      const cfg = await ad.solveCaptchaConfig(acc, secrets);
      if (!cfg.ok) return fail(cfg.message || "获取验证码配置失败");
      // 第一段必须是 ok:true：渲染层 call()（src/api/ipc.ts）把「返回体 ok===false」一律当异常抛，
      // 抛出来 UI 就再也读不到 needCaptcha，滑块永远弹不出来，只会显示一句
      // 「命令 proxy_zcode_solve_captcha 执行失败」。第一段的语义本就是「配置取到了，附带要过码」，
      // 与 discovery.cjs beginOAuth 首跳同形（{ok:true, needCaptcha:true, captcha}）。
      return { ok: true, needCaptcha: true, captcha: cfg.captcha };
    }
    const r = await ad.solveCaptchaWithParam(acc, secrets, verifyParam, region);
    if (r.ok) {
      pool.releaseCool(acc.id);
      store.clearError(acc.id);
    }
    return r.ok ? ok(r) : fail(r.message);
  }));

  // ===== ZCode 活动领取（额度套餐领取；preview 列可领 / captcha 拿滑块配置 / claim 领取） =====

  // ===== 统计 =====
  ipcMain.handle("proxy_stats_overview", handle(({ days }) => ({
    today: store.statsToday(),
    trend: store.statsTrend(days || 7),
    tops: {
      channel: store.statsTop("channel", days || 7),
      model: store.statsTop("model", days || 7),
      key: store.statsTop("key", days || 7),
      account: store.statsTop("account", days || 7),
    },
  })));
  ipcMain.handle("proxy_stats_top", handle(({ dim, days }) => store.statsTop(dim, days)));
  ipcMain.handle("proxy_stats_detail", handle(({ page, pageSize, channel, keyId, model, status, sinceTs }) =>
    store.statsDetail({ page, pageSize, channel, keyId, model, status, sinceTs })));
  // 单条详情（详情弹窗）：列表不带 2KB 级的 error_body，点开按 id 再取
  ipcMain.handle("proxy_stats_request", handle(({ id }) => store.usageRequestById(id)));
  // 手动清理流水（days 缺省取设置里的保留期；all=true 清空整表）
  ipcMain.handle("proxy_stats_cleanup", handle(({ days, all }) =>
    store.cleanupUsage(Math.round(Number(days)) || Number(settings().usageRetentionDays) || 90, !!all)));
  ipcMain.handle("proxy_recent", handle(({ limit }) => store.recentRequests(limit)));

  // ===== 规则文件 / 目录 / 安全 =====
  ipcMain.handle("proxy_rules_list", handle(() => rules.list()));
  ipcMain.handle("proxy_open_rules_dir", handle(async () => {
    const shell = getShell();
    if (!shell) throw new Error("该操作需要主进程界面，不能由后台常驻网关执行");
    await shell.openPath(rules.rulesDir());
    return ok({});
  }));
  ipcMain.handle("proxy_open_data_dir", handle(async () => {
    const shell = getShell();
    if (!shell) throw new Error("该操作需要主进程界面，不能由后台常驻网关执行");
    await shell.openPath(store.proxyDir());
    return ok({});
  }));
  ipcMain.handle("proxy_vault_status", handle(() => ({
    encrypted: vaultOk(),
    driver: store.driver(),
    dataDir: store.proxyDir(),
  })));

  // ===== 号池 WebDAV 同步（统一服务器 + proxy 根目录；压缩包用 WebDAV 密码加密；
  //        可选 channel = 只同步某一个编译器） =====
  ipcMain.handle("proxy_poolsync_status", handle(() => poolsync.progress()));
  ipcMain.handle("proxy_poolsync_run", handle(async ({ channel }) => {
    if (poolsync.progress().running) return fail("号池同步已在进行中");
    // 前台 await 跑完：号池体量小（几十账号），一轮就是几次请求；进度仍走 app:event 广播
    return poolsync.run({ channel: channel ? String(channel) : "" });
  }));
  ipcMain.handle("proxy_poolsync_cancel", handle(() => poolsync.cancel()));

  // ===== 自定义提供商（中转站 / 自建 OpenAI 兼容端点） =====
  // 校验与规矩都在 provider.cjs；这里只做参数搬运与 ok/fail 形状包装，出错一律 {ok:false,message}
  // 由前端直接展示（validate 的 message 已带用户可行动的说明，不再另造错误码）。
  ipcMain.handle("proxy_provider_list", handle(() => ok({ providers: provider.list() })));
  ipcMain.handle("proxy_provider_create", handle(({ keys, ...input }) => {
    const r = provider.create(input);
    if (!r.ok) return r;
    // 建提供商时顺带把手里几把 Key 一起存：表单一次填完比"先建再逐个加"少三 step。
    // 逐个走 addKey 是为了让去重与校验规则只有一份。
    const added = [];
    for (const k of Array.isArray(keys) ? keys : []) {
      const a = provider.addKey(r.provider.id, typeof k === "string" ? { key: k } : k);
      if (a.ok) added.push(a.id);
    }
    return ok({ provider: r.provider, keyIds: added });
  }));
  ipcMain.handle("proxy_provider_update", handle((input) => provider.update(input.id, input)));
  ipcMain.handle("proxy_provider_delete", handle(({ id }) => provider.remove(id)));
  ipcMain.handle("proxy_provider_add_key", handle(({ id, name, key }) => provider.addKey(id, { name, key })));
  ipcMain.handle("proxy_provider_remove_key", handle(({ accountId }) => provider.removeKey(accountId)));
  // 探测用「表单里当场填的那把 Key + 地址」，不读号池：既能动未保存的配置试，也不会把号池好 Key 打成冷却
  ipcMain.handle("proxy_provider_test", handle((input) => provider.probe(input)));
  ipcMain.handle("proxy_provider_fetch_models", handle(({ id }) => provider.fetchModels(id)));
}

// checkinBatch 一并导出：给 scripts/dev-provider-test.cjs 直测「渠道缺签到能力」这条门禁
// （proxy_checkin_run / proxy_checkin_status 两个 IPC handler 只是它的包装，不必为了测试拉起 Electron）
// ===== 子进程侧的命令出口（二期 Task 3）=====

// 表只在首次用到时构建一次，之后复用模块内缓存（每条命令重建一次全部闭包是纯浪费）
let TABLE = null;

/** 子进程侧：把 register() 的 ipcMain 换成收集器，register() 里每条命令名与实现体一字不动地复用。
 *  为什么这样而不是重构出 COMMANDS 表：那是 290 行的重排，会掩盖「二期只改出口、不改命令语义」这个契约，
 *  且 Task 5 的逐字相等闸（dev-gateway-forward-parity-test）就没法拿旧注册当基线。 */
function dispatchTable() {
  if (TABLE) return TABLE;
  const cmds = {};
  register({ handle: (name, fn) => { cmds[name] = fn; } });
  TABLE = cmds;
  return TABLE;
}

/** 走管道调一条命令。第一个参数是假的 _event：全仓每条处理体都不使用 event / event.sender
 *  （逐条核过；真依赖 UI 的那 4 条靠 getShell() 的惰性 require 抛错，见 §5.7）。 */
async function dispatch(cmd, args) {
  const fn = dispatchTable()[cmd];
  if (!fn) throw new Error("未知命令: " + cmd);
  return fn({ sender: { send() {} } }, args || {});
}

/** 子进程装配：把事件出口接到管道广播上（emit 由 gateway.cjs 在 serve() 建成之后给，装配序不是风格）。
 *  置上网关角色后本模块不再按 restoreOnLaunch 自动 listen —— 监听决策归主进程（Task 6 的新语义）。 */
function attachGatewayMode({ emit } = {}) {
  if (typeof emit !== "function") throw new Error("attachGatewayMode 需要 emit(payload) 函数");
  gatewayAttached = true;
  events.setSink(emit);
}

// gatewayStatus 一并导出：proxy_status 命令走它，Task 1 的闸直接断言 vaultOk 字段，
// Task 5 的转发化也要按这个名字取（藏在 register 里没法单测）
// dispatchTable/dispatch/attachGatewayMode/gracefulShutdown：二期 Task 3 的子进程入口与管道出口
// startBackgroundJobs：二期 Task 5 的子进程后台作业入口（credits 定时刷新 + 定时自动签到，
// 随命令实现体一起下沉；gateway.cjs 装配时调用）
// DRAIN_BUDGET_MS：停机预算的四个数字之一，供 dev-gateway-pipe-test 断言它们仍复合（合计只在那一条断言里算）
// checkinBatch：给 scripts/dev-provider-test.cjs 直测「渠道缺签到能力」这条门禁（本分支新增导出）
module.exports = { shutdown, gracefulShutdown, DRAIN_BUDGET_MS, register, settings, gatewayStatus, dispatchTable, dispatch, attachGatewayMode, startBackgroundJobs, checkinBatch };
