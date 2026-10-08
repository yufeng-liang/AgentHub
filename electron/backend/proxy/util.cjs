// 反代网关 · 通用工具：JWT 解析 / 宽容取值 / SSE 行扫描 / OpenAI chunk 组装与非流式聚合
"use strict";
const crypto = require("node:crypto");

function uuid() {
  return crypto.randomUUID();
}

/** Trae 风格 trace id："00-<hex32>-<hex32>-01" */
function traceId() {
  return `00-${crypto.randomBytes(16).toString("hex")}-${crypto.randomBytes(16).toString("hex")}-01`;
}

/** JWT payload 解析（不验签）：剥 Cloud-IDE-JWT / Bearer 前缀，取 uid 与 exp */
function jwtDecode(token) {
  let t = String(token || "").trim();
  t = t.replace(/^Cloud-IDE-JWT\s+/i, "").replace(/^Bearer\s+/i, "");
  const parts = t.split(".");
  if (parts.length < 2) return { token: t, uid: "", exp: 0, payload: null };
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    const uid = String((payload.data && payload.data.id) || payload.auth_id || payload.sub || payload.user_id || "");
    const exp = Number(payload.exp) || 0;
    return { token: t, uid, exp, payload };
  } catch {
    return { token: t, uid: "", exp: 0, payload: null };
  }
}

/** 宽容解析（参考项目 dig 思路）：递归在响应 JSON 里按键名正则找第一个匹配值 */
function dig(node, re, depth) {
  if (node == null || (depth != null && depth < 0)) return undefined;
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = dig(v, re, (depth == null ? 6 : depth) - 1);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if (re.test(k) && (typeof v === "number" || typeof v === "string" || typeof v === "boolean")) return v;
    }
    for (const v of Object.values(node)) {
      const hit = dig(v, re, (depth == null ? 6 : depth) - 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/** 把可能是秒/毫秒/ISO 字符串的时间统一成毫秒时间戳（0 = 无） */
function toMs(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "string" && /[-T:]/.test(v)) {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : 0;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * 积分包到期归一（方案 Q10）：上游到期字段名混乱且有脏值，统一成"可比毫秒时间戳"。
 * - 纯日期串（YYYY-MM-DD，无时分秒）补 23:59:59（当天有效，不因取到 00:00 被误判成前一天就过期）
 * - 秒/毫秒自动判别沿用 toMs
 * - "远未来"脏值（如 DeductionEndTime=2049 与月底 CycleEndTime 并存）超过 now + farYears 年 → 视为长期有效，返回 0
 * 返回 0 表示"无到期 / 长期有效"（与 expiresAt=0 语义一致）。
 */
function normalizeExpiryMs(raw, farYears) {
  const years = Number(farYears) > 0 ? Number(farYears) : 5;
  let v = raw;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) v = s + "T23:59:59"; // 纯日期补当天末尾
  }
  const ms = toMs(v);
  if (!ms) return 0;
  if (ms > Date.now() + years * 365 * 86400000) return 0; // 远未来脏值 → 长期有效
  return ms;
}

/** 判定字符串是否为完整 JSON（SSE 紧凑流兼容的判据，参考项目 wb_sse 实证） */
function isCompleteJson(s) {
  if (!s || s === "[DONE]") return false;
  try { JSON.parse(s); return true; } catch { return false; }
}

/**
 * 限流响应头解析（参考项目 P1-2：Retry-After 秒 / Retry-After-Ms 毫秒 / X-Ratelimit-Reset epoch）。
 * 纯数字才认（HTTP-Date 不解析，宁缺毋滥），上限 2h（超过视为上游异常值丢弃）。
 * 传 web fetch 的 Headers 对象；取不到返回 0。
 */
function parseRetryAfterHeaders(headers) {
  if (!headers || typeof headers.get !== "function") return 0;
  const CAP = 2 * 3600 * 1000;
  for (const [name, kind] of [["retry-after", "s"], ["retry-after-ms", "ms"], ["x-ratelimit-reset", "epoch"]]) {
    const v = String(headers.get(name) || "").trim();
    if (!v || !/^[0-9]+$/.test(v)) continue;
    const n = Number(v);
    if (n <= 0) continue;
    if (kind === "s") { const ms = n * 1000; if (ms <= CAP) return ms; continue; }
    if (kind === "ms") { if (n <= CAP) return n; continue; }
    // epoch：≥12 位按毫秒，否则按秒；取「now + 剩余量」，已过去视为不可用
    const sec = String(v).length >= 12 ? n / 1000 : n;
    const remain = sec * 1000 - Date.now();
    if (remain > 0 && remain <= CAP) return remain;
  }
  return 0;
}

/** 稳定会话键：取前 3 条消息指纹的 sha256 前 16 hex——同一会话多轮间头部不变，键即稳定 */
function stableConvId(messages) {
  try {
    const head = (Array.isArray(messages) ? messages : [])
      .slice(0, 3)
      .map((m) => `${(m && m.role) || ""}:${typeof (m && m.content) === "string" ? m.content : JSON.stringify((m && m.content) ?? null)}`)
      .join("|");
    if (!head || head === "||") return "";
    return crypto.createHash("sha256").update(head).digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}

/** 上游 prompt_cache_key（参考项目 cache_key.go 实证：带上后 credit≈0.02 vs 0.34，约 17× 费用差）。
 *  uid 是跨账号硬隔离段——跨账号绝不复用同一键，防止命中错账号的前缀缓存 */
function promptCacheKey(uid, conversation) {
  const u = String(uid || "-");
  const uid8 = u.slice(0, 8) || "-";
  const conv = crypto.createHash("sha256").update(`${u}|${String(conversation || "")}`).digest("hex").slice(0, 16);
  return `agenthub-${uid8}-${conv}`;
}

// ===== deepseek 思维链（参考项目 thinking.go：开思考必须显式 thinking:enabled + effort，否则无思维链） =====

function isDeepSeekModel(model) {
  return /^deepseek/i.test(String(model || "").trim());
}

/** deepseek thinking 注入：显式 disabled 尊重并删 effort；显式 enabled 缺 effort 补默认档；
 *  无 thinking 注入 enabled + 补默认档。非 deepseek 零改动。
 *  reasoning_effort="off" 是 Anthropic 入站「客户端显式关思考」的管线标记（anthropic-in.budgetToEffort）：
 *  此时绝不能注入 enabled——否则客户端的关思考会被翻转成开思考（方案 §3.1 off=删除档位）。 */
function injectThinking(obj, defaultEffort) {
  if (!obj || !isDeepSeekModel(obj.model)) return;
  if (obj.reasoning_effort === "off") return;
  const dft = String(defaultEffort || "high");
  const th = obj.thinking && typeof obj.thinking === "object" ? obj.thinking : null;
  const typ = th ? String(th.type || "").trim() : "";
  const ensureEffort = () => {
    if (obj.reasoning_effort != null || obj.reasoningEffort != null) return;
    obj.reasoning_effort = dft;
  };
  if (typ) {
    if (/^disabled$/i.test(typ)) {
      delete obj.reasoning_effort;
      delete obj.reasoningEffort;
      return;
    }
    ensureEffort();
    return;
  }
  if (th) th.type = "enabled";
  else obj.thinking = { type: "enabled" };
  ensureEffort();
}

const EFFORT_RANK = { off: 0, minimal: 1, low: 2, medium: 3, high: 4, xhigh: 5, max: 6 };
// 档位词表的唯一出处：提供商侧配置要校验用户填的档位，必须用同一份而不是再抄一个字面量数组
const EFFORT_LEVELS = Object.keys(EFFORT_RANK);
// 档位别名归一（移植 Repo1）：Repo1 的 "none" 语义等同本项目的 "off"（关思考）。
// 只做别名折叠 + lowercase，非法值原样返回交由调用方（normalizeReasoningEffort / 各适配器）判空。
function normalizeEffortName(effort) {
  const s = String(effort == null ? "" : effort).trim().toLowerCase();
  return s === "none" ? "off" : s;
}

/** reasoning_effort 档位降级（参考项目 normalizeReasoningEffort）：模型目录声明 supportedEfforts
 *  时按其收敛——请求档不在支持集则降到 ≤ 请求档的最高支持档；支持档全高于请求档取最低档。 */
function normalizeReasoningEffort(obj, reasoningMeta) {
  if (!obj) return;
  // "off" 不是最低档：语义是「关思考」（方案 §3.1 type=disabled/0 → off → 删除档位）。
  // 绝不能落进下面的降级算法（支持档全高于 off 会被抬成最低档=把关思考翻成开思考）：
  // 模型被用户覆盖明确声明支持 off 时原样保留（此时它是一个真实档位），否则删除档位字段。
  if (normalizeEffortName(obj.reasoning_effort) === "off") {
    const supported = (reasoningMeta && Array.isArray(reasoningMeta.supportedEfforts))
      ? reasoningMeta.supportedEfforts.map(normalizeEffortName).filter((s) => EFFORT_RANK[s] != null)
      : [];
    if (supported.includes("off")) obj.reasoning_effort = "off";
    else delete obj.reasoning_effort;
    return;
  }
  const supported = (reasoningMeta && Array.isArray(reasoningMeta.supportedEfforts))
    ? reasoningMeta.supportedEfforts.map(normalizeEffortName).filter((s) => EFFORT_RANK[s] != null)
    : [];
  if (!supported.length) return;
  // "none"→"off" 别名折叠后再判档（Repo1 词表兼容）；折叠后写回 obj，保证发往上游的是本项目词表
  const cur = typeof obj.reasoning_effort === "string" ? normalizeEffortName(obj.reasoning_effort) : "";
  if (!cur || EFFORT_RANK[cur] == null) return;
  const sorted = [...new Set(supported)].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b]);
  if (sorted.includes(cur)) { obj.reasoning_effort = cur; return; }
  const curRank = EFFORT_RANK[cur];
  const lower = sorted.filter((s) => EFFORT_RANK[s] <= curRank);
  obj.reasoning_effort = lower.length ? lower[lower.length - 1] : sorted[0];
}

/** Anthropic 客户端「thinking 预算非法/负」→ 协议层不派生档位（anthropic-in.budgetToEffort 返回
 *  undefined），落到管线时 reasoning_effort 未定。按方案 §3.1「当 enabled 无档」补模型默认档。
 *  识别标记：body.extraBody.thinking 存在（anthropic-in 的 thinking 原件透传位，chat/responses 入站没有）；
 *  deepseek 渠道由 injectThinking 补默认档，此处补的 reasoning_effort 非 null 会被它的 ensureEffort 跳过，
 *  故两个调用点都可以无条件调用。补上的档随后照常过 normalizeReasoningEffort 收敛。
 *  返回是否补了档（测试断言用）。 */
function fillThinkingDefaultEffort(obj, defaultEffort) {
  if (!obj || obj.reasoning_effort != null) return false;
  const th = obj.extraBody && obj.extraBody.thinking;
  if (!th || typeof th !== "object") return false;
  const d = normalizeEffortName(defaultEffort);
  if (!d || EFFORT_RANK[d] == null) return false;
  obj.reasoning_effort = d;
  return true;
}

/** deepseek 多轮回填（参考项目 backfillReasoningContent）：会话含 reasoning 痕迹时，
 *  所有 assistant 消息必须带 reasoning_content 字段（可为空串），否则上游 400 */
function backfillReasoningContent(obj) {
  if (!obj || !isDeepSeekModel(obj.model)) return;
  const msgs = Array.isArray(obj.messages) ? obj.messages : [];
  if (!msgs.length) return;
  const hasTrace = msgs.some((m) => m && typeof m === "object" && (
    (typeof m.reasoning === "string" && m.reasoning !== "") || "reasoning_content" in m
  ));
  if (!hasTrace) return;
  for (const m of msgs) {
    if (!m || typeof m !== "object" || m.role !== "assistant") continue;
    if ("reasoning_content" in m) continue;
    m.reasoning_content = typeof m.reasoning === "string" ? m.reasoning : "";
  }
}

// ===== SSE =====

/** SSE 行扫描器：累积 event:/data: 到空行触发一次事件（对齐参考项目 scan_line） */
class SseScanner {
  constructor(onEvent) {
    this.buf = "";
    this.event = "";
    this.data = [];
    this.onEvent = onEvent;
  }
  /** 喂入一块文本（可能不完整） */
  feed(text) {
    this.buf += text;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.line(line);
    }
  }
  line(line) {
    if (line === "") {
      if (this.data.length) {
        const raw = this.data.join("\n");
        this.data = [];
        const ev = this.event;
        this.event = "";
        this.onEvent(ev, raw);
      }
      return;
    }
    if (line.startsWith(":")) return; // keep-alive 注释行
    if (line.startsWith("event:")) {
      this.event = line.slice(6).trim();
      return;
    }
    if (line.startsWith("data:")) {
      this.data.push(line.slice(5).replace(/^ /, ""));
      // 紧凑流兼容（参考项目 wb_sse 实证：上游存在无空行分隔的连续 data: 流）——
      // data 已拼出完整 JSON 或 [DONE] 时立即产出，不等空行；不完整则继续等
      const joined = this.data.join("\n");
      if (joined === "[DONE]" || isCompleteJson(joined)) {
        const raw = this.data.join("\n");
        this.data = [];
        const ev = this.event;
        this.event = "";
        this.onEvent(ev, raw);
      }
      return;
    }
  }
  /** 流结束时冲刷残余（无结尾空行也兜底触发一个事件） */
  flush() {
    const rest = this.buf.trim();
    this.buf = "";
    if (rest) this.line(rest);
    if (this.data.length) this.line("");
  }
}

/**
 * 空噪声 delta 字段清洗（出线前统一过一遍）。
 * WorkBuddy 上游实测：每个流式 chunk 的 delta 都带全展开的
 * `function_call:null / refusal:"" / tool_calls:[] / extra_fields:null`，且首块之后仍重复携带 `role`。
 * 原样透传有两层危害：
 *  1) 严格拼接的客户端（Qoder 等）见到"无 content 却有结构字段"的 delta 会另起一段，
 *     一句正文被切成几十行；
 *  2) 网关侧 emit 以"rest 非空"判定正文开始并冲刷思考链缓冲，噪声帧被误判成正文，
 *     使思考链合批（REASON_BATCH_CHARS）永远攒不满，碎成一词一条刷屏。
 * 规则：值为 null/undefined/空串/空数组的字段一律丢弃（OpenAI 语义下这些字段无需显式空值），
 * 非空 role 也丢弃——首包的 {role:"assistant"} 由 server 统一发出，重复 role 才是分段元凶。
 * 只清顶层，非空的上游私有扩展字段（如 extra_fields:{}）会原样保留，由调用方自行判消费。
 */
function stripEmptyDelta(d) {
  const out = {};
  if (!d || typeof d !== "object") return out;
  for (const [k, v] of Object.entries(d)) {
    if (k === "role") continue;
    if (v === null || v === undefined) continue;
    if (v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/**
 * 这帧 delta 是否含"客户端与聚合器真正可消费"的内容：正文 / 思考链 / 非空工具调用。
 * 判据必须与 Aggregator.pushDelta 认的三类字段一致——若用"清洗后还有键"代替，
 * 上游私有的非空扩展字段（extra_fields:{} 之类）会被判成已出线，
 * 既进不了聚合器，又封死 server 侧 streamErr 的换号路径，最终把空响应记成 200。
 * 全空噪声帧（function_call:null / refusal:"" / tool_calls:[] / role 重复）恒为 false；
 * 唯一的例外是带内容的 legacy function_call：虽经 OpenAI 协议早已废弃，但若上游真用它
 * 流式输出（旧协议兼容通道），本函数若不视为出线，流中失败会换号重发散成拼接；
 * 与「已经发出去的半截内容不能撤回」更一致才算出线。空名空参的占位帧仍是噪声。
 */
function hasConsumableDelta(d) {
  if (!d || typeof d !== "object") return false;
  const fc = d.function_call;
  const hasLegacyFn = !!fc && typeof fc === "object" && (!!fc.name || !!fc.arguments);
  return !!d.reasoning_content
    || !!d.content
    || (Array.isArray(d.tool_calls) && d.tool_calls.length > 0)
    || hasLegacyFn; // legacy 兼容通道的真实调用仍算出线，防流中换号重发拼接
}

/** OpenAI 流式 chunk 组装 */
function chunk(reqId, model, delta, finishReason, usage) {
  const c = {
    id: `chatcmpl-${reqId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: delta || {}, finish_reason: finishReason || null }],
  };
  if (usage) c.usage = usage;
  return `data: ${JSON.stringify(c)}\n\n`;
}

const DONE = "data: [DONE]\n\n";

/** 非流式聚合器：把流式 delta 拼成完整 chat.completion（tool_calls 按 index 合并） */
class Aggregator {
  constructor(reqId, model) {
    this.reqId = reqId;
    this.model = model;
    this.content = "";
    this.reasoning = "";
    this.toolCalls = new Map(); // index -> {id, type, function:{name, arguments}}
    this.toolSynthKey = 0; // index 缺失流的当前合成桶（新工具头推进）
    this.finishReason = "stop";
    this.usage = null;
  }
  pushDelta(delta) {
    if (!delta) return;
    if (delta.content) this.content += delta.content;
    if (delta.reasoning_content) this.reasoning += delta.reasoning_content;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        if (!tc || typeof tc !== "object") continue;
        const fn = tc.function && typeof tc.function === "object" ? tc.function : null;
        // index 缺失（部分中转/聚合器不回传）时的分桶：带 id/name 的分片是新工具头，推进
        // 合成桶；纯 arguments 分片延续当前桶。兜底 || 0 会把多个工具的增量并进同一桶
        // 拼出损坏调用。0 是合法 index，缺失判定必须用 == null
        let i;
        if (tc.index != null && Number.isFinite(Number(tc.index))) i = Number(tc.index);
        else {
          if (tc.id || (fn && fn.name)) this.toolSynthKey++;
          i = this.toolSynthKey;
        }
        const existing = this.toolCalls.get(i);
        // 全空分片（`{}` 或 function 既无 name 也无 arguments）不得凭空建条目：
        // 否则 result() 会输出一条 id 自动生成、name/arguments 全空的假工具调用，
        // 客户端据此发起一次无意义调用。真实首片必带 id 或 name、增量片必带 arguments，
        // 故此守卫对正常流零影响。
        if (!existing && !tc.id && !(fn && (fn.name || fn.arguments))) continue;
        const cur = existing || { id: tc.id || `call_${uuid().replace(/-/g, "").slice(0, 24)}`, type: "function", function: { name: "", arguments: "" } };
        if (tc.id) cur.id = tc.id;
        if (fn) {
          if (fn.name) cur.function.name += fn.name;
          if (fn.arguments) cur.function.arguments += fn.arguments;
        }
        this.toolCalls.set(i, cur);
      }
    }
  }
  result() {
    const message = { role: "assistant", content: this.content || "" };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    if (this.toolCalls.size) {
      message.tool_calls = [...this.toolCalls.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
    }
    const body = {
      id: `chatcmpl-${this.reqId}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: this.model,
      choices: [{ index: 0, message, finish_reason: this.finishReason }],
      usage: this.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    return body;
  }
}

/** OpenAI 同构错误体 */
function openaiError(message, type, code) {
  return { error: { message: String(message), type: type || "server_error", param: null, code: code || null } };
}

/** 请求体验证：messages/model 缺失返回 OpenAI 同构 400 */
function validateChatBody(body) {
  if (!body || typeof body !== "object") return "请求体必须是 JSON 对象";
  if (!Array.isArray(body.messages) || !body.messages.length) return "messages 缺失或为空";
  if (!body.model || typeof body.model !== "string") return "model 缺失";
  return "";
}

/** 角色归一：把 role 收敛到「所有渠道上游都接受」的公共集
 *
 *  背景（issue #47）：不同渠道的上游对 role 的白名单并不一致，而且互相冲突——
 *    · workbuddy 上游只收 [system assistant user tool function]，收到 developer 直接 400
 *      （code 11-128「当前模型不支持多角色设定」）；trae 同样拒 developer（#47 实测报错
 *      "developer is not one of ['system','assistant','user','tool','function']"）
 *    · raccoon 上游只收 [system assistant user tool developer]，收到 function 直接 400
 *  两份白名单的交集只有 [system assistant user tool]。而代理在 400 时会按渠道
 *  继续回退到下一个渠道，于是同一条消息在「能不能过」上取决于当时命中了哪个渠道，
 *  表现为用户描述的「有时能连上，有时一用 trace 就断」。
 *
 *  策略：入口处统一归一，而不是给每个渠道各维护一张白名单表（渠道/模型组合会增，
 *  表必然过期）。归一到交集里的角色后，任何渠道都能接受。
 *
 *    developer → system   （OpenAI 现行规范用 developer 取代 system；workbuddy 归一，
 *                          zcode 本就合并进 system，raccoon/trae 两者都收）
 *    function  → tool     （OpenAI legacy function_call 结果消息；它只带 name 不带
 *                          tool_call_id，无法安全转成 tool，保留为 user 语义更安全——
 *                          见下方分支）
 *
 *  归一后仍不在交集内的未知 role（如 tool_result / model / 乱写值）**保持原样不猜**，
 *  由各适配器按既有白名单丢弃；但这里补一条 warning，让「模型忘了某条消息」不再无声：
 *  丢弃本身发生在 qoderAdapter.toQoderMessages 的纯白名单 continue 与
 *  zcodeAnthropic 无兜底分支里，不报错、不写库，排查时无从察觉。
 *
 *  就地修改并返回 messages；非数组 / 非对象消息原样放过，不因此拒绝请求。
 */
const KNOWN_ROLES = new Set(["system", "user", "assistant", "tool"]);

function normalizeRoles(messages) {
  if (!Array.isArray(messages)) return messages;
  const unknown = new Map(); // role → 出现次数，避免长会话刷屏
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    if (typeof msg.role !== "string") continue;
    const role = msg.role.trim().toLowerCase();
    if (role === "developer") {
      msg.role = "system";
    } else if (role === "function") {
      // legacy function 消息：带 tool_call_id 才是完整的工具结果，可安全转 tool；
      // 只有 name 时按 user 处理，否则退化成无 tool_call_id 的 tool 会被
      // workbuddy 的孤儿清理（validToolIds 校验）整条丢弃。
      msg.role = msg.tool_call_id ? "tool" : "user";
    } else if (KNOWN_ROLES.has(role) && role !== msg.role) {
      // 交集角色的大小写/首尾空白变体（"User"、" System"）无损归一为小写：
      // 上游枚举校验区分大小写，留着会整条 400；语义未变，也无需记 warning
      msg.role = role;
    }
    if (!KNOWN_ROLES.has(msg.role)) {
      unknown.set(msg.role, (unknown.get(msg.role) || 0) + 1);
    }
  }
  if (unknown.size) {
    // 不猜语义、不改写：未知 role 交由各适配器按既有白名单丢弃，这里只让它不再无声。
    // 合并成一行，避免长会话里每条消息刷一次。
    const detail = Array.from(unknown, ([r, n]) => `${JSON.stringify(r)}×${n}`).join(" ");
    console.warn(`[proxy] 未知 role 将在适配器改写时被丢弃：${detail}（支持：system/user/assistant/tool，另有 developer/function 自动归一）`);
  }
  return messages;
}

/** 估算 token（上游 usage 缺失时的兜底口径：~4 字符 1 token） */
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

/** 版本号：两端同源。旧实现是 poolsync.appVersion（本地私有函数），用 electron 的 app.getVersion()，
 *  try 吞错后在子进程里恒返回 ""，会让 gateway.json 的版本比对（Task 3/7）永远"不匹配"→ 每次启动都重杀子进程。 */
function appVersion() {
  try { return require("../../../package.json").version || ""; } catch { return ""; }
}

/** 上游 usage → 内部规范的缓存字段：cached_tokens（读缓存命中）/ cache_write_tokens（缓存写入）。
 *  认三种命名：OpenAI/DeepSeek 系 usage.prompt_tokens_details.cached_tokens、DeepSeek 直发的
 *  prompt_cache_hit_tokens、Claude 系 cache_read_input_tokens；写缓存只有 Claude 系有。
 *  上游没给的字段不出现在返回对象里——server 记账据此落 -1（未上报）而不是假 0，
 *  「这个渠道不报缓存」和「上报了但命中为 0」在界面上必须区分开 */
function openaiCacheTokens(u) {
  if (!u || typeof u !== "object") return {};
  const out = {};
  const read = Number(
    (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ??
    u.prompt_cache_hit_tokens ??
    u.cache_read_input_tokens
  );
  if (Number.isFinite(read)) out.cached_tokens = Math.max(0, Math.round(read));
  const write = Number(u.cache_creation_input_tokens);
  if (Number.isFinite(write)) out.cache_write_tokens = Math.max(0, Math.round(write));
  return out;
}

/** 从上游 usage 对象里归一「本次请求消耗的积分」。
 *  只认「消耗」语义的字段名（credit/cost 族），刻意不认 points/balance/remain 这类「余额」字段，
 *  避免把余额误当消耗。返回 { credit } 或 {}（未上报——与落库 -1 哨兵一致，宁缺勿假）。
 *  0 是有效值（命中缓存时上游可能报接近 0 的消耗），故用 Number.isFinite 判定而非真值。 */
function upstreamCredit(u) {
  if (!u || typeof u !== "object") return {};
  const v =
    u.credit ?? u.credits ?? u.total_credit ?? u.total_credits ??
    u.credits_used ?? u.credit_used ?? u.used_credits ??
    u.cost ?? u.total_cost;
  const n = Number(v);
  if (v == null || !Number.isFinite(n) || n < 0) return {};
  return { credit: n };
}

/** 上游 OpenAI 形 usage → 内部规范 usage：计数字段 + 缓存字段 + 实报积分三件套的统一收口。
 *  全项目 8 处适配器 emit 都必须是同一形状；aliases=true 时回退读 Anthropic 风格
 *  input_tokens/output_tokens（小浣熊 / zcode / 兼容站混用两套命名的实测）。
 *  缓存/积分上游没给就不出现在返回对象里——server 记账据此落 -1（未上报）而不是假 0。 */
function normalizeOpenAiUsage(u, aliases) {
  if (!u || typeof u !== "object") return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  return {
    prompt_tokens: Number(u.prompt_tokens ?? (aliases ? u.input_tokens : undefined)) || 0,
    completion_tokens: Number(u.completion_tokens ?? (aliases ? u.output_tokens : undefined)) || 0,
    total_tokens: Number(u.total_tokens) || 0,
    ...openaiCacheTokens(u),
    ...upstreamCredit(u),
  };
}

module.exports = {
  uuid, traceId, jwtDecode, dig, toMs, normalizeExpiryMs,
  isCompleteJson, parseRetryAfterHeaders, stableConvId, promptCacheKey,
  isDeepSeekModel, injectThinking, normalizeReasoningEffort, backfillReasoningContent, EFFORT_LEVELS, EFFORT_RANK, normalizeEffortName,
  fillThinkingDefaultEffort,
  SseScanner, stripEmptyDelta, hasConsumableDelta, chunk, DONE, Aggregator, openaiError, validateChatBody, normalizeRoles, estimateTokens,
  openaiCacheTokens, upstreamCredit, normalizeOpenAiUsage,
  appVersion,
};
