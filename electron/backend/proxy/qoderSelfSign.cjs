// Qoder 自签路径（fork 独有）：本机未安装 Qoder 客户端时的可用链。
//
// 与上游 qoderAdapter 的形状差异：上游签名由客户端里的 wasm 逐请求产出（见 qoderSigner.cjs），
// 本模块用 qoderCosy.cjs 纯 JS 复现同一套 COSY 签名 ⇒ 零安装可用。
// 请求体必须**先 encodeBody、后 buildCosyHeaders**（签的是编码后字节），顺序颠倒只报「签名不匹配」，无从排查。
//
// 地区由**渠道 id** 决定（PRODUCT_REGION）：上游主干用 product 分双区，本模块必须与它同一套真相源，
// 故不再读 fork 历史账号里的 meta.mode。
//
// 依赖方向：util.cjs 只依赖内置与 package.json、store.cjs 只依赖 config.cjs 与内置，两者都不回指
// adapters.cjs ⇒ 此处顶层 require 不成环。反向 require adapters 会取到半初始化模块
// （本仓 index.cjs:33 与 adapters.cjs 的 qoderAdapter 注释记录过同一教训），故绝对不做。
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const qcosy = require("./qoderCosy.cjs");
const U = require("./util.cjs");
const store = require("./store.cjs");

/** 四组域名按 region 内置切换（地区不接受任意 URL）；模型目录/凭证两地区不通用。
 *  ⚠ gateway 值带尾斜杠：自签链路按 `${gateway}${PATH}` 拼接（PATH 不带前导斜杠）。 */
const REGIONS = {
  global: { openApi: "https://openapi.qoder.sh", center: "https://center.qoder.sh", webOrigin: "https://qoder.com", gateway: "https://api3.qoder.sh/" },
  cn: { openApi: "https://openapi.qoder.com.cn", center: "https://gateway.qoder.com.cn", webOrigin: "https://qoder.com.cn", gateway: "https://gateway.qoder.com.cn/" },
};

/** 渠道 id → 地区。上游主干用 product 分双区，本模块必须与它同一套真相源。 */
const PRODUCT_REGION = { qoder: "cn", qoder_intl: "global" };

const CHAT_PATH = "algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"; // gateway 基址带尾斜杠
const MODEL_LIST_PATH = "algo/api/v2/model/list?Encode=1";
const REFRESH_PATH = "/algo/api/v3/user/refresh_token"; // center 域

// 兜底清单（协议参考 §3.8；upstreamKey/reasoning/vision/倍率快照 2026-09-20 实测；global 17 / cn 10）。
// 档位已全部收编进 rules/effort_catalog.json（统一 seed loader，方案 §3.2），此处不再内联 efforts——
// seed 解析失败时按 §5.1 退空表，chat 侧 allow-list 自有默认档兜底，不需要第二份档位数据。
const FALLBACK = {
  global: [
    ["Qwen3.8-Flash", "qfmodel", true, true, "0.1"],
    ["Qwen3.8-Max", "qmodel_38max", true, true, "0.5"],
    ["Auto", "auto", false, true, "1"],
    ["Ultimate", "ultimate", true, true, "1.6"],
    ["Performance", "performance", true, true, "1.1"],
    ["Efficient", "efficient", false, true, "0.3"],
    ["Sonus", "smodel", true, true, "3.2"],
    ["Cantus", "cmodel", true, true, "3.2"],
    ["Qwen3.7-Max", "qmodel_latest", true, true, "0.5"],
    ["Qwen3.7-Plus", "qmodel", false, true, "0.1"],
    ["Kimi-K3", "kmodel_latest", false, true, "0.8"],
    ["Kimi-K2.8-Preview", "kmodel", false, true, "0.3"],
    ["GLM-5.3", "gmodel", true, true, "0.6"],
    ["GLM-5.3-Flash", "gfmodel", true, true, "0.1"],
    ["DeepSeek-V4-Pro", "dmodel", true, true, "0.8"],
    ["DeepSeek-Flash", "dfmodel", true, true, "0.2"],
    ["MiniMax-M3", "mmodel", false, true, "0.2"],
  ],
  cn: [
    ["Qwen3.8-Flash", "qfmodel", true, true, "0.1"],
    ["Qwen3.8-Max", "qmodel_38max", true, true, "0.5"],
    ["Auto", "auto", false, true, "1"],
    ["Qwen3.7-Max", "qmodel_latest", true, true, "0.5"],
    ["Qwen3.7-Plus", "qmodel", false, true, "0.1"],
    ["DeepSeek-V4-Pro", "dmodel", true, true, "0.8"],
    ["DeepSeek-Flash", "dfmodel", false, true, "0.2"],
    ["GLM-5.3", "gmodel", true, true, "0.6"],
    ["Kimi-K2.8-Preview", "kmodel", true, true, "0.3"],
    ["MiniMax-M3", "mmodel", false, true, "0.2"],
  ],
};

/** 错误分类（协议参考 §3.6，按顺序判；先看响应体语义再看状态码）。
 *  403 双语义：带 pricing/额度特征是套餐不足（402 换号），裸 403 才是登录态（401 刷新）——
 *  只看状态码会把「该充值」误报成「登录失效」。 */
function classify({ httpStatus, text }) {
  const t = String(text || "");
  const hasPricing = /https?:\/\/[^"\\]*\/pricing[^"\\]*/i.test(t) || /pricingurl|insufficient|no_quota|quota_exceed|exceed_quota|exceeded|credit|upgrade|subscription|plan|trial/i.test(t);
  if (hasPricing || /"code"\s*:\s*112/.test(t)) return { status: 402, message: "当前账号额度不足或套餐不支持该模型" };
  if (httpStatus === 429 || /rate limit|too many/i.test(t)) return { status: 402, message: t.slice(0, 300) || "上游限流" };
  if (httpStatus === 401 || httpStatus === 403) return { status: 401, message: t.slice(0, 300) || "登录态失效或权限不足" };
  return { status: 502, message: t.slice(0, 300) || "上游错误" };
}

/** 信封状态码归一：fork 链路给 statusCodeValue（数字，HTTP 恒 200 时错误码在内层），
 *  上游 wasm 解密后的信封给 statusCode（字符串，如 UNAUTHORIZED / OK）。两条路径共用 classify
 *  时必须先归一，漏掉哪一侧，403 双语义判据就整体失效。 */
function statusCodeOf(env) {
  const n = Number(env && env.statusCodeValue);
  if (Number.isFinite(n) && n > 0) return n;
  const s = String((env && env.statusCode) || "").toUpperCase();
  const map = { UNAUTHORIZED: 401, FORBIDDEN: 403, TOO_MANY_REQUESTS: 429, RATE_LIMITED: 429, PAYMENT_REQUIRED: 402 };
  return map[s] || 0;
}

/** 与 adapters.cjs 的同名私有 parseJson 等价（JSON.parse 失败回 null）。
 *  不复用是因为反向 require adapters 会成循环依赖。 */
function parseJson(s) { try { return JSON.parse(s); } catch { return null; } }

/** 会话/记录 id 派生（协议参考 §3.4 公式：sha256 前 16 hex，\0 分隔） */
function ids({ userId, upstreamKey, maxTokens, seed }) {
  const h = (label, ...parts) => crypto.createHash("sha256").update(label + "\0" + parts.join("\0")).digest("hex").slice(0, 16);
  return {
    sessionId: h("qoder-session", String(userId || ""), String(upstreamKey || "")) + "-" + (seed || U.uuid()),
    recordId: h("qoder-record", String(upstreamKey || ""), "mt=" + String(maxTokens)),
  };
}

/** 内部 OpenAI body → Qoder 固定业务信封（协议参考 §3.4 逐字段） */
function envelope({ internal, modelEntry, ids: idz, requestId, lastUserText }) {
  const maxTokens = Math.min(Number((internal && internal.max_tokens) || 0) || 32768, 32768); // >32K 上游退化
  const srcMessages = (internal && Array.isArray(internal.messages) ? internal.messages : []).slice();
  const sysTexts = []; // system/developer 收集置顶（上游不看顶层 system 字段）
  const rest = [];
  for (const m of srcMessages) {
    if (m && (m.role === "system" || m.role === "developer")) {
      const t = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      if (t && t.trim()) sysTexts.push(t.trim());
    } else rest.push(m);
  }
  const messages = [];
  if (sysTexts.length) messages.push({ role: "system", content: sysTexts.join("\n\n") });
  for (const m of rest) {
    if (!m || typeof m.role !== "string") continue;
    if (m.role === "user") {
      if (Array.isArray(m.content)) { // 无图压平文本；有图 → [{text},{image_url}]（image_url 原样抽出）
        const parts = [];
        for (const p of m.content) {
          if (p && p.type === "text") parts.push({ type: "text", text: String(p.text || "") });
          else if (p && p.type === "image_url") parts.push({ type: "image_url", image_url: p.image_url });
        }
        messages.push({ role: "user", content: parts });
      } else messages.push({ role: "user", content: String(m.content ?? "") });
    } else if (m.role === "assistant") {
      const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length;
      const content = m.content == null || m.content === "" ? (hasToolCalls ? " " : "") : String(m.content); // 纯空体会被拒
      const out = { role: "assistant", content };
      if (hasToolCalls) out.tool_calls = m.tool_calls;
      messages.push(out);
    } else if (m.role === "tool") {
      messages.push({ role: "tool", tool_call_id: String(m.tool_call_id || ""), content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") });
    }
  }
  const isReasoning = !!(modelEntry && modelEntry.is_reasoning);
  return {
    request_id: String(requestId),
    request_set_id: idz.recordId,
    chat_record_id: idz.recordId,
    session_id: idz.sessionId,
    stream: true, // 恒 true（非流式由 Aggregator 本地聚合）
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    system: "",
    messages,
    tools: Array.isArray(internal && internal.tools) ? internal.tools : [],
    parameters: { max_tokens: maxTokens }, // enable_thinking/reasoning_effort 仅显式开思考时追加（发 false 会把思考混进正文或断连）
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: { context: [], modelConfig: { key: String(modelEntry.key), is_reasoning: isReasoning }, originalContent: String(lastUserText || "") },
      features: [],
      text: String(lastUserText || ""),
    },
    model_config: { key: String(modelEntry.key), is_reasoning: isReasoning, is_vl: !!(modelEntry && modelEntry.is_vl), source: "system" }, // 精简版：剥 thinking_config（原样回传会覆盖 parameters.enable_thinking）
    business: { product: "cli", version: "1.0.0", type: "agent", stage: "start", id: U.uuid(), name: String(lastUserText || "").slice(0, 30), begin_at: Date.now() },
  };
}

/** 信封 SSE 帧解包（协议参考 §3.5）：HTTP 恒 200，{statusCodeValue, body}，body 是内层 JSON 字符串需二次解析；
 *  body 也可能直接是 "[DONE]" 字符串或非字符串对象。 */
function unpack(frame) {
  const code = Number(frame && frame.statusCodeValue);
  if (code !== 200) {
    const bodyVal = frame && frame.body;
    const text = typeof bodyVal === "string" ? bodyVal : JSON.stringify(bodyVal ?? "");
    return { ok: false, status: code, text };
  }
  const bodyVal = frame && frame.body;
  if (bodyVal === "[DONE]") return { done: true };
  const inner = typeof bodyVal === "string" ? parseJson(bodyVal) : bodyVal;
  return { ok: true, chunk: inner || null };
}

/** thinking 标签跨分片状态机（协议参考 §3.5）：reasoning 以 <thinking>/<think>/<reasoning>/<thought>
 *  混在 content，标签可能切在任意位置；闭标签后吃掉紧跟换行（先 \n\n 再单个）；流结束必须 flush。 */
const TAG_OPEN = /<(thinking|think|reasoning|thought)>/;
const TAG_CLOSE = /<\/(thinking|think|reasoning|thought)>/;
// 无匹配时尾部要保留的「半截标签」长度：最长开标签 <reasoning> 11 字符 → 真前缀至多 10；
// 最长闭标签 </reasoning> 12 字符 → 至多 11。硬编码 8 连 <thought>(9) 都兜不住，
// <reasonin 切在跨片边界时首字符 < 会漏进正文且该标签内容不再被剥离
const OPEN_KEEP = 10;
const CLOSE_KEEP = 11;
class TagSplitter {
  constructor() { this.buf = ""; this.inTag = false; }
  feed(piece) {
    this.buf += piece;
    let out = "";
    for (;;) {
      if (!this.inTag) {
        const m = this.buf.match(TAG_OPEN);
        if (!m) {
          const keep = Math.min(this.buf.length, OPEN_KEEP);
          const safe = this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(safe.length);
          return out + safe;
        }
        out += this.buf.slice(0, m.index);
        this.buf = this.buf.slice(m.index + m[0].length);
        this.inTag = true;
      } else {
        const m = this.buf.match(TAG_CLOSE);
        if (!m) {
          const keep = Math.min(this.buf.length, CLOSE_KEEP);
          const safe = this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(safe.length);
          return out;
        }
        this.buf = this.buf.slice(m.index + m[0].length).replace(/^\r?\n\r?\n/, "").replace(/^\r?\n/, "");
        this.inTag = false;
      }
    }
  }
  flush() { const rest = this.buf; this.buf = ""; return rest; }
}

/** 自签机器标识（协议参考 §3.7）：按序找候选文件，第一个存在的非空（≤256 字符、无控制字符）用之；
 *  都没有则生成 UUID v4 写入 <config_dir>/qoder-machine-id，进程内缓存。只碰文件，不碰网络与注册表。 */
let _mid = null;
function machineId() {
  if (_mid) return _mid;
  const fs = require("node:fs");
  const configDir = store.proxyDir();
  const candidates = [path.join(configDir, "qoder-machine-id"), path.join(os.homedir(), ".qoder-proxy", "machine_id"), path.join(os.homedir(), ".qoder", ".auth", "machine_id"), path.join(os.homedir(), ".qoder", "machine_id")];
  for (const f of candidates) {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      if (v && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v)) { _mid = v; return _mid; }
    } catch { /* 下一个候选 */ }
  }
  _mid = U.uuid();
  try { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(path.join(configDir, "qoder-machine-id"), _mid); } catch { /* 只读环境用内存值 */ }
  return _mid;
}

/** 身份解析（协议参考 §3.7）：自签账号的 token 是 JWT，身份直接读 payload。
 *  （声明在 payload——util.jwtDecode 顶层只有 token/uid/exp，简报直取 .user_id 是笔误，按真实接口修正） */
function jwtUserInfo(token) {
  const c = U.jwtDecode(String(token || "")).payload || {};
  return { uid: String(c.user_id || c.sub || ""), name: String(c.nickname || c.name || "Qoder 账号") };
}

/** 上游目录条目（modelMeta 形状）→ 自签信封入口。
 *  这是本次归一移植最容易被静默做错的一处接缝：上游把能力放在 capabilities.{reasoning,images}、
 *  身份放在 id，而 envelope 读 {key,is_reasoning,is_vl}。直取会发 "undefined" 上行并让能力位恒 false
 *  （fork 期同款缺陷由 smoke 抓到过，原实现住在 _resolveEntry）。集中成一个函数，两侧都能测。 */
function selfSignEntryFromMeta(mm, key) {
  const cap = (mm && mm.capabilities) || {};
  return {
    key: String(key || ""),
    is_reasoning: !!cap.reasoning,
    is_vl: !!cap.images,
    efforts: ((mm && mm.reasoning && mm.reasoning.supportedEfforts) || []).slice(),
  };
}

/** OpenAI body → 自签信封的 internal（对齐 fork 历史 rewriteBody：只补流式与 usage，信封组装在 chat 里做） */
function prepareBody(body) {
  const out = { ...(body || {}) };
  out.stream = true;
  if (!out.stream_options || typeof out.stream_options !== "object") out.stream_options = {};
  out.stream_options.include_usage = true;
  delete out.conversation_id; delete out.conversationId; delete out.prompt_cache_key;
  return out;
}

/** 自签实例：三条回落链（chat / refreshToken / fetchModelsRemote），地区由渠道 id 定。
 *  deps = { fetchStream, pumpSse, httpJson }——util/store 已在本模块顶层 require，不再注入。 */
function makeSelfSign(product, deps) {
  const { fetchStream, pumpSse, httpJson } = deps;
  const region = PRODUCT_REGION[product] || "global";

  /** 对话主流程（协议参考 §3.4/§3.5）：自签 → SSE 双层信封解包 → thinking 标签跨片剥离 */
  async function chat({ account, secrets, modelKey, entry, body, emit }) {
    const cfg = REGIONS[region];
    const e = entry || { key: "auto", is_reasoning: false, is_vl: false, efforts: [] };
    const lastUser = [...((body && body.messages) || [])].reverse().find((m) => m.role === "user");
    const lastUserText = typeof (lastUser && lastUser.content) === "string" ? lastUser.content : "";
    const prepared = prepareBody(body);
    const requestId = U.uuid();
    const userId = (account && ((account.meta && account.meta.user_id) || account.uid)) || "";
    const machineIdStr = machineId();
    const idz = ids({ userId, upstreamKey: e.key, maxTokens: prepared.max_tokens, seed: (prepared.session_id || "") || undefined });
    const envBody = envelope({ internal: prepared, modelEntry: e, ids: idz, requestId, lastUserText });
    // 思考档位（协议参考 §3.4）：reasoning_effort → reasoning → thinking 命中即停；off/none/disabled/false 不发；
    // true/null → enable_thinking:true 无档位；minimal/min→low、high/max→xhigh；白名单 = 目录 efforts，不支持退默认档
    const effSrc = prepared.reasoning_effort ?? prepared.reasoning ?? prepared.thinking;
    if (effSrc !== undefined && !["off", "none", "disabled", false].includes(effSrc)) {
      if (effSrc === true || effSrc === null) {
        envBody.parameters.enable_thinking = true;
      } else {
        const map = { minimal: "low", min: "low", high: "xhigh", max: "xhigh" };
        let effort = map[String(effSrc)] || String(effSrc);
        const allow = (e.efforts && e.efforts.length) ? e.efforts : ["low", "medium", "xhigh"];
        if (!allow.includes(effort)) effort = allow.includes("medium") ? "medium" : allow[0];
        envBody.parameters.enable_thinking = true;
        envBody.parameters.reasoning_effort = effort;
      }
    }
    const encoded = qcosy.encodeBody(Buffer.from(JSON.stringify(envBody), "utf8")); // 必须先编码后签名
    const url = `${cfg.gateway}${CHAT_PATH}`;
    const headers = {
      ...qcosy.buildCosyHeaders({ url, body: encoded, uid: userId, token: (secrets && secrets.token) || "", name: (account && account.name) || "", email: (account && account.meta && account.meta.email) || "", machineId: machineIdStr, requestId }),
      "content-type": "application/json",
      "accept": "text/event-stream",
      "cache-control": "no-cache",
      "accept-encoding": "identity",
      "x-model-key": String(e.key),
      "x-model-source": "system",
    };
    const { resp, cancelTimer } = await fetchStream(url, { method: "POST", headers, body: encoded });
    const result = { status: 200, planLimit: false };
    const splitter = new TagSplitter();
    let usage = null; // usage 取最后一帧（协议参考 §3.5）
    const flushUsage = () => { if (usage) emit({ type: "usage", usage }); };
    try {
      // HTTP 恒 200；错误在信封 statusCodeValue 里——fetchStream 的 !resp.ok 分支不会触发
      await pumpSse(resp, (_event, raw) => {
        if (raw === "[DONE]") { flushUsage(); emit({ type: "finish", reason: "" }); return; }
        const frame = parseJson(raw);
        if (!frame) return;
        const u = unpack(frame);
        if (u.done) { flushUsage(); emit({ type: "finish", reason: "" }); return; }
        if (!u.ok) {
          const cls = classify({ httpStatus: u.status, text: u.text });
          if (cls.status === 402) result.planLimit = true;
          emit({ type: "error", status: cls.status, code: 0, message: cls.message });
          return;
        }
        const chunk = u.chunk;
        if (!chunk) return;
        const choice = Array.isArray(chunk.choices) && chunk.choices[0];
        if (choice && choice.delta) {
          const delta = { ...choice.delta };
          if (typeof delta.content === "string" && delta.content) delta.content = splitter.feed(delta.content);
          if (Object.keys(delta).length) emit({ type: "delta", delta });
        }
        if (choice && choice.finish_reason) { flushUsage(); emit({ type: "finish", reason: choice.finish_reason }); }
        if (chunk.usage) usage = U.normalizeOpenAiUsage(chunk.usage);
      });
      const tail = splitter.flush();
      if (tail) emit({ type: "delta", delta: { content: tail } }); // 不 flush 会丢末尾文字
    } finally { cancelTimer(); }
    return result;
  }

  /** 刷新（协议参考 §3.7）：secrets.refreshToken 是打包串——
   *  5 段 `pat|<PAT>|<作业刷新令牌>|<userId>|<machineId>`（PAT 来源，重走 jobToken/exchange）
   *  3 段 `<oauth刷新令牌>|<userId>|<machineId>`（OAuth 来源，走 center refresh_token） */
  async function refreshToken({ account, secrets }) {
    const packed = String((secrets && secrets.refreshToken) || "");
    const cfg = REGIONS[region];
    const segs = packed.split("|");
    const baseHeaders = { "content-type": "application/json", "cosy-version": "1.0.1", "cosy-clienttype": "5", "user-agent": "qoder-local-proxy" };
    if (segs.length >= 5 && segs[0] === "pat") {
      const r = await httpJson(`${cfg.openApi}/api/v1/jobToken/exchange`, { method: "POST", headers: baseHeaders, body: JSON.stringify({ personal_token: segs[1] }) })
        .catch((e) => ({ ok: false, status: 0, data: null, message: String(e) }));
      const token = r.ok && r.data && r.data.data && r.data.data.token ? String(r.data.data.token) : "";
      if (!token) return { ok: false, message: `PAT 换取失败 HTTP ${r.status}` };
      const exp = Number(U.jwtDecode(token).exp || 0) * 1000;
      return { ok: true, token, refreshToken: packed, expiresAt: exp };
    }
    if (segs.length >= 3) {
      const r = await httpJson(`${cfg.center}${REFRESH_PATH}`, { method: "POST", headers: { ...baseHeaders, authorization: `Bearer ${(secrets && secrets.token) || ""}` }, body: JSON.stringify({ refreshToken: segs[0] }) })
        .catch((e) => ({ ok: false, status: 0, data: null, message: String(e) }));
      if (r.status === 401) return { ok: false, expired: true, message: "登录态已过期，请重新登录" };
      const d = r.data && (r.data.data || r.data);
      const token = d && d.token ? String(d.token) : "";
      if (!r.ok || !token) return { ok: false, message: (d && d.message) || `刷新失败 HTTP ${r.status}` };
      // refresh_token 不得含 |（协议参考 §2.3/oauth.rs 同判据）；缺失沿用旧值
      const nextRt = d.refresh_token && !String(d.refresh_token).includes("|") ? `${String(d.refresh_token)}|${segs[1]}|${segs[2]}` : packed;
      const exp = Number(U.jwtDecode(token).exp || 0) * 1000;
      return { ok: true, token, refreshToken: nextRt, expiresAt: exp };
    }
    return { ok: false, message: "refreshToken 打包串格式不认识（应为 3 段或 pat| 开头 5 段）" };
  }

  /** 远程目录（COSY 签名 + 信封，按地区缓存 1h 由 proxy_models_sync 层处理）；失败如实回错由 UI 引导手填。
   *  ⚠ 产出的 id 必须是上游 key：fork 历史用 display_name 去空白当 id，那份口径已随
   *  rules DEFAULTS 的展示名表一起废弃（见 proxy-qoder-adapter-selftest [3d]），
   *  展示名落 name、档位落 reasoning.supportedEfforts，形状与上游 fetchModels 逐字对齐。 */
  async function fetchModelsRemote({ account, secrets }) {
    const cfg = REGIONS[region];
    const url = `${cfg.gateway}${MODEL_LIST_PATH}`;
    const requestId = U.uuid();
    const encoded = qcosy.encodeBody(Buffer.from(JSON.stringify({ region }), "utf8"));
    const headers = qcosy.buildCosyHeaders({ url, body: encoded, uid: (account && account.uid) || "", token: (secrets && secrets.token) || "", name: "", email: "", machineId: machineId(), requestId });
    const r = await httpJson(url, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String(e) }));
    const chat = r.data && (r.data.chat || (r.data.data && r.data.data.chat));
    if (!r.ok || !Array.isArray(chat)) return { ok: false, message: `目录拉取失败（HTTP ${r.status || 0}）` };
    const models = chat.filter((m) => m && m.key).map((m) => {
      const ctxTiers = m.context_config && typeof m.context_config === "object" ? Object.values(m.context_config) : [];
      const ctxMax = ctxTiers.reduce((n, t) => Math.max(n, Number((t && t.token_count) || 0)), 0);
      const efforts = (() => {
        const e = m.thinking_config && m.thinking_config.enabled && m.thinking_config.enabled.efforts;
        return e && typeof e === "object" ? Object.keys(e) : [];
      })();
      return {
        id: String(m.key),
        name: String(m.display_name || m.key),
        rate: m.price_factor != null ? Number(m.price_factor) : null, // 0 是合法值不能当缺失丢弃；缺失回 null 不编造
        capabilities: { reasoning: !!m.is_reasoning, tools: true, images: !!m.is_vl },
        reasoning: efforts.length ? { effort: null, defaultEffort: "", supportedEfforts: efforts } : null,
        contextLength: ctxMax || Number(m.max_input_tokens) || 0,
        maxOutputTokens: 0,
        isFree: m.is_free === true || Number(m.price_factor) === 0,
        scene: "assistant",
      };
    });
    return models.length ? { ok: true, models, scene: "assistant", modelCount: models.length } : { ok: false, message: "目录为空" };
  }

  return { product, region, chat, refreshToken, fetchModelsRemote };
}

module.exports = {
  REGIONS,
  PRODUCT_REGION,
  CHAT_PATH,
  MODEL_LIST_PATH,
  REFRESH_PATH,
  FALLBACK,
  machineId,
  classify,
  statusCodeOf,
  unpack,
  ids,
  envelope,
  TagSplitter,
  jwtUserInfo,
  selfSignEntryFromMeta,
  makeSelfSign,
};
