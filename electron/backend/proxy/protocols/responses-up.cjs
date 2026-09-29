// 反代网关 · 上游形态：OpenAI Responses（把内部规范形发出去，把上游的事件流收回来）
//
// 存在理由：一批中转站与自建网关只开 `/v1/responses`（OpenAI 自己也在往这个接口收敛），
// 只支持 chat 形态上游的话，这类端点接不进来——而它给的往往正是 gpt-5 / codex 系模型。
//
// 方向与 responses-in/out 相反，字段映射表却是同一张——三个文件对照读：
//   responses-in.cjs   客户端 Responses 请求 → 内部
//   responses-out.cjs  内部事件              → 客户端 Responses 流
//   本文件             内部请求              → 上游 Responses 请求；上游 Responses 流 → 内部事件
//
// 内部规范形始终是 OpenAI chat 形状：调度核心、号池、记账、四个内置渠道适配器都不必
// 知道上游说的是哪种协议（与 anthropic-up.cjs 同一取舍）。
//
// 本期有意不做的 Responses 能力（选中该形态时会在 UI 与日志里说清，不是静默丢）：
// 上游会话存储（store / previous_response_id——网关每轮全量重放历史）、内置工具
// （web_search / file_search / code_interpreter）、后台任务、结构化输出（text.format）。
"use strict";
const util = require("../util.cjs");

// chat 有、Responses 没有的采样与控制字段：透传过去是一个 400，丢掉但必须留痕，
// 否则用户看到的是"同样的请求打 chat 上游正常、打 Responses 差一点"且无线索可归因。
const UNSUPPORTED_FIELDS = ["stop", "presence_penalty", "frequency_penalty", "response_format", "seed", "n", "logprobs", "logit_bias"];

/** chat 的 content（string | 多模态数组）→ Responses 的内容项数组。
 *  role 决定文本项类型：user 侧是 input_text，assistant 侧是 output_text——写反了上游按输入解析历史回复。 */
function contentParts(content, role, note) {
  if (typeof content === "string") {
    return content ? [{ type: role === "assistant" ? "output_text" : "input_text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      const t = String(part.text || "");
      if (t) out.push({ type: role === "assistant" ? "output_text" : "input_text", text: t });
    } else if (part.type === "refusal") {
      const t = String(part.refusal || "");
      if (t) out.push({ type: role === "assistant" ? "output_text" : "input_text", text: t });
    } else if (part.type === "image_url") {
      const iu = part.image_url;
      const url = typeof iu === "string" ? iu : (iu && iu.url) || "";
      if (url) out.push({ type: "input_image", image_url: String(url) });
      else note.push("图片没有可用的 url，已丢弃");
    } else if (part.type === "input_audio" || part.type === "audio") {
      note.push("音频内容项无对应物（网关不转码），已丢弃");
    } else {
      note.push(`未识别的内容项类型 ${String(part.type || "(无 type)")}，已丢弃`);
    }
  }
  return out;
}

/** tools：chat 的嵌套 `{type:"function", function:{...}}` → Responses 的扁平 `{type:"function", name,...}`。
 *  两种写法都收（中转站与 SDK 混用很常见，responses-in 也是双向兼容处理）。 */
function mapTools(raw, note) {
  if (!Array.isArray(raw) || !raw.length) return undefined;
  const out = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const flat = t.type === "function" && t.function ? t.function : t;
    const name = String(flat.name || "");
    if (!name) {
      note.push("无 name 的工具（托管/服务端工具）在 Responses 形态里没有对应物，已丢弃");
      continue;
    }
    const item = {
      type: "function",
      name,
      description: flat.description ? String(flat.description) : "",
      parameters: flat.parameters && typeof flat.parameters === "object" ? flat.parameters : { type: "object", properties: {} },
    };
    if (flat.strict != null) item.strict = !!flat.strict;
    out.push(item);
  }
  return out.length ? out : undefined;
}

/** tool_choice：chat 嵌套 → Responses 扁平；字符串三档原样。 */
function mapToolChoice(choice) {
  if (!choice) return undefined;
  if (typeof choice === "string") return ["auto", "none", "required"].includes(choice) ? choice : "auto";
  if (typeof choice === "object") {
    const name = (choice.function && choice.function.name) || choice.name;
    if (name) return { type: "function", name: String(name) };
  }
  return undefined;
}

/**
 * 内部 OpenAI chat body → Responses 请求。
 * @returns {{ok:true, request:object, notes:string[]} | {ok:false, message:string}}
 */
function toRequest(model, body) {
  const notes = [];
  const b = body || {};
  const systemParts = [];
  const input = [];
  let toolSeq = 0;
  for (const m of Array.isArray(b.messages) ? b.messages : []) {
    if (!m || typeof m !== "object") continue;
    const role = m.role;
    if (role === "system" || role === "developer") {
      const t = typeof m.content === "string" ? m.content : contentParts(m.content, "user", notes).map((p) => p.text || "").join("");
      if (t) systemParts.push(t);
      continue;
    }
    if (role === "tool") {
      // 工具结果：Responses 用独立 item，call_id 是关联键，改一个字符这轮回环就断
      input.push({
        type: "function_call_output",
        call_id: String(m.tool_call_id || ""),
        output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
      });
      continue;
    }
    const asst = role === "assistant";
    const parts = contentParts(m.content, asst ? "assistant" : "user", notes);
    if (parts.length) input.push({ type: "message", role: asst ? "assistant" : "user", content: parts });
    if (asst && m.reasoning_content) notes.push("历史里的思考链不带回上游（Responses 只认 reasoning item，我们不复用）");
    for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      if (!tc || typeof tc !== "object") continue;
      const fn = tc.function || {};
      input.push({
        type: "function_call",
        call_id: String(tc.id || `call_${toolSeq}`),
        name: String(fn.name || ""),
        arguments: typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? {}),
      });
      toolSeq++;
    }
  }
  if (!input.length) return { ok: false, message: "input 为空，无法发往 Responses 形态上游" };

  const req = { model: String(model || ""), input, stream: true };
  if (systemParts.length) req.instructions = systemParts.join("\n\n");
  if (Number(b.max_tokens) > 0) req.max_output_tokens = Math.floor(Number(b.max_tokens));
  if (b.temperature != null) req.temperature = Number(b.temperature);
  if (b.top_p != null) req.top_p = Number(b.top_p);
  const tools = mapTools(b.tools, notes);
  if (tools) req.tools = tools;
  const tc = mapToolChoice(b.tool_choice);
  if (tc !== undefined) req.tool_choice = tc;
  // 档位降级已在 rewriteBody 之外由 util 收敛过（chat 形态同款），这里只换字段名
  if (typeof b.reasoning_effort === "string" && b.reasoning_effort) req.reasoning = { effort: b.reasoning_effort };
  const dropped = UNSUPPORTED_FIELDS.filter((k) => b[k] !== undefined && k in b);
  if (dropped.length) notes.push(`Responses 没有这些 chat 字段，已丢弃：${dropped.join("、")}`);
  return { ok: true, request: req, notes };
}

/** Responses usage → 内部规范 usage。
 *  只换字段名（input/output → prompt/completion），缓存段从 input_tokens_details 搬进
 *  prompt_tokens_details，好让 util.openaiCacheTokens 那一份口径继续生效——
 *  在这里自己算一遍 cached 就等于埋下第二份公式，迟早和统计页漂开。 */
function normalizeResponsesUsage(u) {
  if (!u || typeof u !== "object") return null;
  const shaped = {
    prompt_tokens: Number(u.input_tokens) || 0,
    completion_tokens: Number(u.output_tokens) || 0,
    total_tokens: Number(u.total_tokens) || 0,
  };
  const cached = Number(u.input_tokens_details && u.input_tokens_details.cached_tokens);
  if (Number.isFinite(cached)) shaped.prompt_tokens_details = { cached_tokens: cached };
  return util.normalizeOpenAiUsage(shaped, false);
}

/** 收尾语义：Responses 没有 finish_reason，只能从 status 与 output 项推。
 *  工具优先——一轮里既有正文又有 function_call 时，客户端必须看到 tool_calls 才会去执行，
 *  报成 stop 等于把这一轮的工具调用静默吞掉。 */
function finishReasonOf(resp, sawTool) {
  if (resp.status === "incomplete") {
    const r = String((resp.incomplete_details && resp.incomplete_details.reason) || "");
    return r === "content_filter" ? "content_filter" : "length";
  }
  const out = Array.isArray(resp.output) ? resp.output : null;
  const hasTool = out && out.length ? out.some((i) => i && i.type === "function_call") : !!sawTool;
  return hasTool ? "tool_calls" : "stop";
}

/** Responses 错误 → HTTP 语义（调度器据此决定罚不罚号）。
 *  欠费必须排在最前：只有 402 会走「切号 + planLimit」这条既有链路，落到 400/502
 *  就是把坏 Key 当好 Key 反复打。认不出的一律 502（可换号）。 */
function upstreamErrorStatus(errObj) {
  const code = String((errObj && (errObj.code || errObj.type)) || "");
  const msg = String((errObj && errObj.message) || "");
  const both = `${code} ${msg}`;
  if (/insufficient_quota|quota|balance|exhausted|欠费|余额|积分/i.test(both)) return 402;
  if (/rate.?limit|too many requests|限流/i.test(both)) return 429;
  if (/invalid_api_key|api[_ ]?key|unauthorized|authentication/i.test(both)) return 401;
  if (/context_length|token_limit/i.test(both)) return 400;
  return 502;
}

/**
 * 上游 Responses 事件流 → 内部 emit 词汇（delta / usage / finish / error）。
 *
 * 只认 `.delta` 系列做增量、`completed`/`incomplete` 做收束：`.done` 与 `content_part.*`
 * 给的是全量与块边界，内部词汇按增量聚合，重复计入会把参数拼成两遍。
 */
function makeTranslator(emit, statusOf) {
  const mapStatus = statusOf || upstreamErrorStatus;
  let sawFinish = false;
  let toolSeq = 0;
  let sawTool = false;
  const toolIndexByOutput = new Map(); // 上游 output_index → 内部 tool_calls index

  const finishWith = (resp) => {
    sawFinish = true;
    emit({ type: "finish", reason: finishReasonOf(resp || {}, sawTool) });
  };
  const failWith = (errObj) => {
    emit({ type: "error", message: String((errObj && errObj.message) || "上游错误"), status: mapStatus(errObj), code: 0 });
  };

  return {
    push(data) {
      const type = data && data.type;
      if (!type) return;
      if (type === "response.output_text.delta") {
        if (data.delta) emit({ type: "delta", delta: { content: String(data.delta) } });
        return;
      }
      if (type === "response.reasoning_summary_text.delta") {
        if (data.delta) emit({ type: "delta", delta: { reasoning_content: String(data.delta) } });
        return;
      }
      if (type === "response.refusal.delta") {
        // 拒答文本按正文下发：藏起来只会让客户端看到一个空响应
        if (data.delta) emit({ type: "delta", delta: { content: String(data.delta) } });
        return;
      }
      if (type === "response.output_item.added") {
        const it = data.item || {};
        if (it.type === "function_call") {
          const idx = toolSeq++;
          toolIndexByOutput.set(data.output_index, idx);
          sawTool = true;
          // 首帧必须同时带 id 与 name：聚合器对「全空分片」刻意不建条目（防假工具调用），
          // 少了这两个字段后面所有增量都会落进同一条自动编 id 的假记录里。
          emit({
            type: "delta",
            delta: { tool_calls: [{ index: idx, id: String(it.call_id || ""), type: "function", function: { name: String(it.name || ""), arguments: "" } }] },
          });
        }
        return;
      }
      if (type === "response.function_call_arguments.delta") {
        const idx = toolIndexByOutput.get(data.output_index);
        if (idx === undefined || !data.delta) return;
        emit({ type: "delta", delta: { tool_calls: [{ index: idx, function: { arguments: String(data.delta) } }] } });
        return;
      }
      if (type === "response.completed" || type === "response.incomplete") {
        const resp = data.response || {};
        const usage = normalizeResponsesUsage(resp.usage);
        if (usage) emit({ type: "usage", usage });
        finishWith(resp);
        return;
      }
      if (type === "response.failed") {
        failWith((data.response || {}).error || data.response || {});
        return;
      }
      if (type === "error") {
        failWith(data);
        return;
      }
      // response.created / in_progress / output_item.done / content_part.* / 各类 *.done：
      // 块边界由调度侧按事件推导，这里不需要额外动作
    },
    /** SSE 结束但上游没给终止帧（截断/异常收尾）也要有 finish，否则客户端永远等不到收尾。
     *  reason 留空而不是补一个 "stop"：空是「上游没告诉我们原因」的既有哨兵值（chatOpenai 的
     *  [DONE]、anthropic-up 的 close 都是它），报成 stop 等于把截断说成正常收尾。 */
    close() {
      if (!sawFinish) {
        sawFinish = true;
        emit({ type: "finish", reason: "" });
      }
    },
  };
}

/** 上游无视 stream:true、直接回一整个 response 对象时的分支。
 *  不处理的话 SSE 扫描器一条事件都收不到，客户端会拿到一个 200 空响应——
 *  chatOpenai / chatAnthropic 里各有一条同款 content-type 兜底，三边都得有。 */
function emitWhole(data, emit, statusOf) {
  const mapStatus = statusOf || upstreamErrorStatus;
  if (!data || typeof data !== "object") return;
  if (data.error || data.status === "failed") {
    const e = data.error || data;
    emit({ type: "error", status: mapStatus(e), code: 0, message: String(e.message || "上游错误") });
    return;
  }
  const items = Array.isArray(data.output) ? data.output : [];
  let seq = 0;
  let sawTool = false;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    if (it.type === "reasoning") {
      for (const s of Array.isArray(it.summary) ? it.summary : []) {
        const t = String((s && s.text) || "");
        if (t) emit({ type: "delta", delta: { reasoning_content: t } });
      }
    } else if (it.type === "message") {
      for (const p of Array.isArray(it.content) ? it.content : []) {
        const t = String((p && (p.text || p.refusal)) || "");
        if (t) emit({ type: "delta", delta: { content: t } });
      }
    } else if (it.type === "function_call") {
      sawTool = true;
      emit({
        type: "delta",
        delta: { tool_calls: [{ index: seq++, id: String(it.call_id || ""), type: "function", function: { name: String(it.name || ""), arguments: typeof it.arguments === "string" ? it.arguments : JSON.stringify(it.arguments ?? {}) } }] },
      });
    }
    // web_search_call / file_search_call 等内置工具调用结果在 chat 形态里没有对应物，丢弃
  }
  const usage = normalizeResponsesUsage(data.usage);
  if (usage) emit({ type: "usage", usage });
  emit({ type: "finish", reason: finishReasonOf(data, sawTool) });
}

module.exports = { toRequest, makeTranslator, emitWhole, upstreamErrorStatus, normalizeResponsesUsage, UNSUPPORTED_FIELDS };
