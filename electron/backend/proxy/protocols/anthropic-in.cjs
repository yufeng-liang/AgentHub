// 反代网关 · 入站协议：Anthropic Messages（Claude Code / Anthropic SDK 直接打这里）
//
// 职责只有一个方向：把 `POST /v1/messages` 的请求体翻译成网关的内部规范形（OpenAI chat body），
// 响应的反向翻译在 anthropic-out.cjs。两者不共享代码，但共享同一张字段映射表——改一处必须同步另一处。
//
// 为什么 Anthropic 入站要单独一层：Claude Code 只讲 Messages 协议，
// 有了它，用户在客户端里填一个网关地址就能用到所有渠道与自定义提供商，
// 不再需要 CC Switch 在中间做协议翻译。
"use strict";

// 开放列表：除这些之外的一律原样转发给上游。allowlist 会在下一个客户端版本精准破功，
// 所以只列「转发了一定出错」的（连接语义与网关自己生成的头），其余放行。
const DROP_REQUEST_HEADERS = new Set([
  "authorization", "x-api-key", "host", "content-length", "connection",
  "accept-encoding", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "upgrade",
]);

// Anthropic thinking.budget_tokens → reasoning_effort 换算阈值（方案 §3.1，可调常量，对齐 util.EFFORT_RANK）。
// 加法语义：派生出的 effort 供 effort 档位型上游（WorkBuddy 等）用，原始 thinking.budget_tokens 仍保留给
// Anthropic 原生上游（见 toInternal 的 extraBody.thinking 透传）。派生后一样过 util.normalizeReasoningEffort 收敛。
const THINKING_BUDGET_THRESHOLDS = [
  { max: 4096, effort: "low" },      // 1 – 4096
  { max: 16384, effort: "medium" },  // 4097 – 16384
  { max: 32768, effort: "high" },    // 16385 – 32768
  { max: Infinity, effort: "max" },  // > 32768
];

/** thinking → 派生 effort。返回：
 *  · "off"        —— type=disabled 或 budget=0（调用方据此删除档位，不发思考预算）
 *  · "low/medium/high/max" —— 按预算落桶
 *  · undefined    —— 无 thinking / 非法（负数、NaN）：当 enabled 无档，不派生（保留默认档路径） */
function budgetToEffort(thinking) {
  if (!thinking || typeof thinking !== "object") return undefined;
  if (String(thinking.type || "").trim().toLowerCase() === "disabled") return "off";
  const budget = Number(thinking.budget_tokens);
  if (budget === 0) return "off";
  if (!Number.isFinite(budget) || budget < 0) return undefined; // 非法/负 → enabled 无档，不派生
  for (const t of THINKING_BUDGET_THRESHOLDS) if (budget <= t.max) return t.effort;
  return "max";
}

/** 客户端可原样带过去的头。注意：**只有④的 Anthropic 形态上游才用得上**——
 *  内置 4 家渠道的头矩阵是逐家逆向出来的指纹（UA/设备 id 缺一不可），掺进客户端随机头
 *  只会破坏伪装；通用 openai_compat 上游同理不需要。所以这里提供能力，不做默认转发。 */
function forwardableHeaders(req) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers || {})) {
    if (DROP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
    if (typeof v !== "string") continue;
    out[k] = v;
  }
  return out;
}

/** 网关 Key：x-api-key 优先，回落 Authorization: Bearer；两者都在但不等价时判失败。
 *  这是刻意从严：静默挑一个用，等于让用户以为配错了也能跑，之后按哪个 Key 记账都会对不上。 */
function readKey(req) {
  const apiHeader = String(req.headers["x-api-key"] || "").trim();
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (apiHeader && bearer && apiHeader !== bearer) {
    return { error: "x-api-key 与 Authorization 指向两把不同的 Key，请只留一把（Claude Code 同时设置会告警）" };
  }
  return { key: apiHeader || bearer };
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}

/** system：string 或 TextBlockParam[]，按序拼成一条 system（Anthropic 允许多块 + cache_control） */
function systemText(system) {
  if (!system) return "";
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((b) => (typeof b === "string" ? b : (b && typeof b.text === "string" ? b.text : ""))).filter(Boolean).join("\n");
}

/** image 块 → OpenAI image_url。Anthropic 的 source 有 base64 / url / file 三型，
 *  file 型走的是 Anthropic 文件存储，中转站听不懂，明确拒绝而不是悄悄丢图 */
function toImageUrl(source) {
  if (!source || typeof source !== "object") return null;
  if (source.type === "base64") {
    if (!source.media_type || !source.data) return null;
    return `data:${source.media_type};base64,${source.data}`;
  }
  if (source.type === "url" && source.url) return source.url;
  return null;
}

/** tool_result 的 content 摊平成字符串（OpenAI role:tool 的 content 只收文本/图片数组，
 *  摊平是通行做法：文本块拼接，图片转 data URI 交给多模态分支） */
function flattenToolResult(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  const parts = [];
  for (const b of content) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text") parts.push(String(b.text || ""));
    else if (b.type === "image") {
      const u = toImageUrl(b.source);
      if (u) parts.push(`[image] ${u}`);
    }
  }
  return parts.join("\n");
}

/**
 * Messages 请求体 → 内部 OpenAI chat body。
 * @returns {{ok:true, body:object, notes:string[]} | {ok:false, message:string}}
 *
 * notes 记录「这次转换丢了什么/降级了什么」，由调用方写进流水：
 * 语义损失本身无法避免（thinking 签名不可伪造、cache_control 无对应物），但必须可追溯。
 */
function toInternal(raw) {
  const notes = [];
  if (!raw || typeof raw !== "object") return { ok: false, message: "请求体必须是 JSON 对象" };
  const model = String(raw.model || "");
  if (!model) return { ok: false, message: "missing_model：model 不能为空" };
  if (!Number.isFinite(Number(raw.max_tokens)) || Number(raw.max_tokens) <= 0) {
    // Anthropic 把 max_tokens 列为必填（messages API 唯一必填的采样参数），缺失时客户端自己也不会发
    return { ok: false, message: `max_tokens 必填且需为正整数（Anthropic Messages 协议要求）` };
  }
  if (!Array.isArray(raw.messages) || !raw.messages.length) {
    return { ok: false, message: "messages 不能为空" };
  }

  const messages = [];
  const sys = systemText(raw.system);
  if (sys) messages.push({ role: "system", content: sys });

  for (const m of raw.messages) {
    if (!m || typeof m !== "object") continue;
    const role = m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user";
    const blocks = Array.isArray(m.content) ? m.content : null;

    if (!blocks) {
      messages.push({ role, content: typeof m.content === "string" ? m.content : "" });
      continue;
    }

    const textParts = [];
    const images = [];
    const toolCalls = [];
    // tool_result 收集成数组：Anthropic 允许单条 user 消息带多个 tool_result 块（并行工具调用的
    // 标准形态），单变量覆盖会只留最后一个，上游收到缺 response 的 tool_call 直接 400
    const toolResults = [];
    for (const b of blocks) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") textParts.push(String(b.text || ""));
      else if (b.type === "image") {
        const u = toImageUrl(b.source);
        if (u) images.push({ type: "image_url", image_url: { url: u } });
        else notes.push("image.source.type=file 无法转发（Anthropic 文件存储无对应物），该图已丢弃");
      } else if (b.type === "tool_use" && role === "assistant") {
        // input 是对象，OpenAI 侧 arguments 是 JSON 字符串：序列化保真，call id 原样带上
        toolCalls.push({ id: String(b.id || ""), type: "function", function: { name: String(b.name || ""), arguments: safeStringify(b.input) } });
      } else if (b.type === "tool_result") {
        const tr = { role: "tool", tool_call_id: String(b.tool_use_id || ""), content: flattenToolResult(b.content) };
        if (b.is_error) tr.content = `[error] ${tr.content}`;
        toolResults.push(tr);
      } else if (b.type === "thinking" || b.type === "redacted_thinking") {
        // 不回投：signature 是 Anthropic 对上游思考的签名，伪造不了；多数 OpenAI 上游也不认这个字段。
        // 只把内容并进 reasoning_content 供目录/统计侧看，签名丢弃
        notes.push(b.type === "thinking" ? "thinking.signature 不回投上游" : "redacted_thinking 已丢弃");
      } else if (b.type === "document") {
        notes.push("document 块未转换（无 OpenAI chat 对应物），内容已丢弃");
      } else if (b.type) {
        notes.push(`未识别的内容块类型 ${b.type}，已丢弃`);
      }
    }

    if (toolResults.length) {
      for (const tr of toolResults) messages.push(tr);
      // tool_result 与 text 混排时（Claude Code 会这么发），文本另起一条 user 消息，别丢
      const extra = textParts.join("");
      if (extra) messages.push({ role: "user", content: extra });
      continue;
    }
    const msg = { role, content: textParts.join("") };
    if (images.length) msg.content = [{ type: "text", text: msg.content }, ...images];
    if (toolCalls.length) msg.tool_calls = toolCalls;
    messages.push(msg);
  }

  const body = {
    model,
    messages,
    max_tokens: Math.max(1, Number(raw.max_tokens) || 1),
    stream: !!raw.stream,
  };
  if (raw.temperature != null) body.temperature = Number(raw.temperature);
  if (raw.top_p != null) body.top_p = Number(raw.top_p);
  if (Array.isArray(raw.stop_sequences) && raw.stop_sequences.length) body.stop = raw.stop_sequences;

  const tools = mapTools(raw.tools, notes);
  if (tools) body.tools = tools;
  const tc = mapToolChoice(raw.tool_choice);
  if (tc) body.tool_choice = tc;

  // 采样之外的 Anthropic 私有字段进 extraBody 原样带上：中转站若支持就生效，不支持也只是多个未知字段
  const extraBody = {};
  if (raw.thinking) {
    // 加法语义（方案 §3.1）：原始 thinking 透传给 Anthropic 原生上游；同时派生 reasoning_effort 给 effort 档位型上游。
    // off 不在协议层删档：置 "off" 标记贯通管线——适配器侧 util.injectThinking 靠它抑制 enabled 注入
    // （deepseek 渠道的 thinking 原件在 extraBody，协议层删了档位标记，注入会把关思考翻回开思考）、
    // util.normalizeReasoningEffort 靠它落地「删档位」。Anthropic 原生上游由 extraBody.thinking(type=disabled) 生效。
    extraBody.thinking = raw.thinking;
    const eff = budgetToEffort(raw.thinking);
    if (eff === "off") { body.reasoning_effort = "off"; notes.push("thinking disabled/budget=0：置 off 标记（管线删档位/抑制注入）"); }
    else if (eff) { body.reasoning_effort = eff; notes.push(`thinking.budget_tokens 派生 reasoning_effort=${eff}`); }
    // 非法/负 budget（eff=undefined）：当 enabled 无档，不派生；默认档由适配器侧
    // util.fillThinkingDefaultEffort 按合并后 ModelMeta 补上（此处无元数据，不补）
  }
  if (raw.metadata) extraBody.metadata = raw.metadata;
  if (raw.top_k != null) extraBody.top_k = raw.top_k;
  if (Object.keys(extraBody).length) body.extraBody = extraBody;

  return { ok: true, body, notes };
}

/** tools: Anthropic {name,description,input_schema} → OpenAI {type:'function',function:{...}} */
function mapTools(tools, notes) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object" || !t.name) continue;
    out.push({
      type: "function",
      function: {
        name: String(t.name),
        description: t.description ? String(t.description) : "",
        parameters: t.input_schema && typeof t.input_schema === "object" ? t.input_schema : { type: "object", properties: {} },
      },
    });
  }
  if (!out.length) return null;
  // Anthropic 工具名规则比 OpenAI 严（^[a-zA-Z0-9_-]{1,128}$），反向不成立：
  // 内置渠道里若有名字不合 Anthropic 规矩的，出站侧（④）要做可逆改名，这里先记下
  if (out.some((x) => !/^[a-zA-Z0-9_-]{1,128}$/.test(x.function.name))) notes.push("存在不符合 Anthropic 命名规则的工具名，发往 Anthropic 形态上游时会被改写");
  return out;
}

/** tool_choice: auto/any/tool/none → OpenAI 形态 */
function mapToolChoice(choice) {
  if (!choice) return null;
  if (typeof choice === "string") return choice === "any" ? "required" : choice;
  if (typeof choice !== "object") return null;
  if (choice.type === "auto") return "auto";
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool" && choice.name) return { type: "function", function: { name: String(choice.name) } };
  return null;
}

function safeStringify(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v == null ? {} : v);
  } catch {
    return "{}";
  }
}

/** POST /v1/messages/count_tokens：官方标注为可选（缺了客户端退化成字符估算），
 *  我们复用网关既有的 length/4 估算口径，保证与它自己的兜底同量级、不出现"两边数差很多" */
function countTokens(raw) {
  const util = require("../util.cjs");
  const r = toInternal(raw);
  const text = r.ok ? JSON.stringify(r.body.messages) : JSON.stringify(raw || {});
  const n = util.estimateTokens(text);
  return { input_tokens: n };
}

module.exports = { readKey, toInternal, countTokens, forwardableHeaders, _budgetToEffort: budgetToEffort };
