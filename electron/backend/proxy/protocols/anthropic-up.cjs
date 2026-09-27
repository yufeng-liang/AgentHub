// 反代网关 · 上游形态：Anthropic Messages（把内部规范形发出去，把上游的事件流收回来）
//
// 存在理由：Claude 中转生态里有相当一部分端点**只**开放 /v1/messages。
// 只支持 OpenAI 形态上游的话，这类提供商根本接不进来，而目标用户恰恰是 Claude Code 人群。
//
// 方向与 anthropic-in/out 相反，字段映射表却是同一张——所以三个文件放在同一目录下对照读：
//   anthropic-in.cjs  客户端 Messages 请求  → 内部
//   anthropic-out.cjs 内部事件              → 客户端 Messages 流
//   本文件            内部请求              → 上游 Messages 请求；上游 Messages 流 → 内部事件
//
// 内部规范形始终是 OpenAI chat 形状：这样 4 个内置渠道的适配器与调度核心都不必知道上游说的是哪种协议。
"use strict";

// Anthropic 的工具名规则比 OpenAI 严（^[a-zA-Z0-9_-]{1,128}$）。名字不合规时必须**可逆**改写：
// 上游回来的 tool_use.name 要能还原成客户端认识的那个名字，否则工具调用回环直接断。
const NAME_OK = /^[a-zA-Z0-9_-]{1,128}$/;

function sanitizeName(name, used, map) {
  const raw = String(name || "");
  if (NAME_OK.test(raw)) return raw;
  let out = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "tool";
  let i = 1;
  while (used.has(out)) out = `${raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 110)}_${i++}`;
  used.add(out);
  map[out] = raw;
  return out;
}

function restoreName(name, map) {
  return map[name] || String(name || "");
}

/** data URI → Anthropic image.source */
function imageSource(url) {
  const m = /^data:([^;,]+);base64,([\s\S]+)$/i.exec(String(url || ""));
  if (m) return { type: "base64", media_type: m[1], data: m[2] };
  if (/^https?:\/\//i.test(String(url || ""))) return { type: "url", url: String(url) };
  return null;
}

/** content（string | 多模态数组）→ Anthropic 的块数组 */
function blocksFromContent(content, note) {
  if (typeof content === "string") return content ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text") out.push({ type: "text", text: String(part.text || "") });
    else if (part.type === "image_url") {
      const src = imageSource(part.image_url && part.image_url.url);
      if (src) out.push({ type: "image", source: src });
      else note.push("图片既不是 data URI 也不是 http(s) URL，已丢弃");
    }
  }
  return out;
}

/**
 * 内部 OpenAI body → Anthropic Messages 请求。
 * @returns {{ok:true, request:object, nameMap:object, notes:string[]}}
 */
function toRequest(model, body) {
  const notes = [];
  const systemParts = [];
  const msgs = [];
  const nameMap = {};     // 改写后的别名 → 客户端原名（响应侧还原用）
  const aliasOfRaw = {};  // 客户端原名 → 改写后的别名（请求侧改写用）
  // tools 先转：assistant 里的 tool_calls 必须改成同一个合规名，映射得先生成
  const usedNames = new Set();
  const tools = [];
  for (const t of Array.isArray(body.tools) ? body.tools : []) {
    const fn = (t && (t.function || t)) || {};
    if (!fn.name) continue;
    const raw = String(fn.name);
    const alias = sanitizeName(raw, usedNames, nameMap);
    if (alias !== raw) aliasOfRaw[raw] = alias;
    tools.push({
      name: alias,
      description: fn.description ? String(fn.description) : "",
      input_schema: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
    });
  }
  const toAlias = (n) => aliasOfRaw[String(n || "")] || String(n || "");

  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m || typeof m !== "object") continue;
    const role = m.role;
    if (role === "system" || role === "developer") {
      const t = typeof m.content === "string" ? m.content : blocksFromContent(m.content, notes).map((b) => b.text || "").join("");
      if (t) systemParts.push(t);
      continue;
    }
    if (role === "tool") {
      // OpenAI 的工具结果 → user 消息里的 tool_result 块（Anthropic 就是这么放的）
      msgs.push({ role: "user", content: [{ type: "tool_result", tool_use_id: String(m.tool_call_id || ""), content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") }] });
      continue;
    }
    const blocks = blocksFromContent(m.content, notes);
    for (const tc of Array.isArray(m.tool_calls) ? m.tool_calls : []) {
      if (!tc || typeof tc !== "object") continue;
      let input = {};
      try {
        input = JSON.parse((tc.function && tc.function.arguments) || "{}");
        if (!input || typeof input !== "object") input = {};
      } catch {
        notes.push("工具调用参数不是合法 JSON，已按空对象发送");
      }
      blocks.push({ type: "tool_use", id: String(tc.id || ""), name: toAlias((tc.function && tc.function.name) || ""), input });
    }
    msgs.push({ role: role === "assistant" ? "assistant" : "user", content: blocks.length ? blocks : [{ type: "text", text: "" }] });
  }

  if (!msgs.length) return { ok: false, message: "messages 为空，无法发往 Anthropic 形态上游" };

  const req = {
    model: String(model || ""),
    messages: mergeConsecutive(msgs, notes),
    // max_tokens 是 Anthropic 少数几个必填项之一；OpenAI 客户端常省略，给一个保守默认而非无限，
    // 否则某些中转站会直接 400
    max_tokens: Math.max(1, Number(body.max_tokens) || 4096),
    stream: true,
  };
  if (systemParts.length) req.system = systemParts.join("\n\n");
  if (tools.length) req.tools = tools;
  const tc = mapToolChoice(body.tool_choice, toAlias);
  if (tc) req.tool_choice = tc;
  if (body.temperature != null) req.temperature = Math.min(1, Math.max(0, Number(body.temperature)));
  if (body.top_p != null) req.top_p = Number(body.top_p);
  if (body.stop != null) req.stop_sequences = Array.isArray(body.stop) ? body.stop : [String(body.stop)];
  return { ok: true, request: req, nameMap, notes };
}

/** 指定工具名同样要过一遍改写表：不然是拿客户端的原始名去点名一个上游没见过的工具，必 400。 */
function mapToolChoice(choice, toAlias) {
  const alias = typeof toAlias === "function" ? toAlias : (n) => String(n || "");
  if (!choice) return null;
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return { type: "none" };
  if (typeof choice === "object" && choice.function && choice.function.name) return { type: "tool", name: alias(choice.function.name) };
  return null;
}

/** Anthropic 要求 user/assistant 交替、且首条不能是 assistant。
 *  OpenAI 形态里连发同角色很常见（多个 tool_result、连续 user 消息），这里按角色合并相邻消息。 */
function mergeConsecutive(msgs, notes) {
  const out = [];
  for (const m of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) {
      prev.content = [...prev.content, ...m.content];
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  if (out.length && out[0].role !== "user") {
    // 首条非 user：补一条空 user（Anthropic 会 400 拒绝，否则整轮白跑）
    notes.push("历史首条不是 user 消息，已补一条空 user 以满足 Anthropic 约束");
    out.unshift({ role: "user", content: [{ type: "text", text: "(continuing)" }] });
  }
  return out;
}

/**
 * 上游 Messages 事件流 → 内部 emit 词汇（delta / usage / finish / error）。
 * @param nameMap 请求侧改写过的工具名，在这里还原回客户端认识的名字——
 *                不还原的话客户端收到一个自己没声明过的工具名，工具调用回环直接断。
 */
/** Anthropic usage → 内部规范 usage。两个归一：
 *  ① prompt_tokens = input_tokens + cache_read + cache_creation——Claude 的 input_tokens 不含
 *     缓存段而 OpenAI/DeepSeek 的 prompt_tokens 含，不归一的话命中率分母两种口径没法共用一个公式；
 *  ② 带上 cached_tokens / cache_write_tokens（上游没给就不带 → 记账落 -1「未上报」哨兵） */
function normalizeAnthropicUsage(u) {
  const read = Number(u.cache_read_input_tokens);
  const write = Number(u.cache_creation_input_tokens);
  const hasRead = Number.isFinite(read);
  const hasWrite = Number.isFinite(write);
  return {
    prompt_tokens: (Number(u.input_tokens) || 0)
      + (hasRead ? Math.max(0, Math.round(read)) : 0)
      + (hasWrite ? Math.max(0, Math.round(write)) : 0),
    completion_tokens: Number(u.output_tokens) || 0,
    total_tokens: 0,
    ...(hasRead ? { cached_tokens: Math.max(0, Math.round(read)) } : {}),
    ...(hasWrite ? { cache_write_tokens: Math.max(0, Math.round(write)) } : {}),
  };
}

function makeTranslator(emit, nameMap, statusOf) {
  const restore = (n) => (nameMap && nameMap[n]) || String(n || "");
  const mapStatus = statusOf || upstreamErrorStatus;
  let toolSeq = 0;
  const blockToTool = new Map(); // Anthropic content block index → OpenAI tool_calls index
  let sawFinish = false;
  let startUsage = null; // message_start 的 usage 原件：message_delta 只带 output，prompt/缓存段要靠这里补全
  return {
    push(data) {
      const type = data && data.type;
      if (!type) return;
      if (type === "ping") return;
      if (type === "error") {
        const e = data.error || {};
        emit({ type: "error", message: String(e.message || "上游错误"), status: mapStatus(e, data), code: 0 });
        return;
      }
      if (type === "message_start") {
        const u = (data.message && data.message.usage) || {};
        if (u.input_tokens != null || u.output_tokens != null) {
          startUsage = { ...u };
          emit({ type: "usage", usage: normalizeAnthropicUsage(u) });
        }
        return;
      }
      if (type === "content_block_start") {
        const cb = data.content_block || {};
        if (cb.type === "tool_use") {
          const idx = toolSeq++;
          blockToTool.set(data.index, idx);
          // 工具名还原成客户端写法：上游看到的是改写后的合规别名
          emit({ type: "delta", delta: { tool_calls: [{ index: idx, id: String(cb.id || ""), type: "function", function: { name: restore(cb.name), arguments: "" } }] } });
        }
        return;
      }
      if (type === "content_block_delta") {
        const d = data.delta || {};
        if (d.type === "text_delta" && d.text) emit({ type: "delta", delta: { content: String(d.text) } });
        else if (d.type === "thinking_delta" && d.thinking) emit({ type: "delta", delta: { reasoning_content: String(d.thinking) } });
        else if (d.type === "input_json_delta" && d.partial_json) {
          const idx = blockToTool.get(data.index);
          if (idx !== undefined) emit({ type: "delta", delta: { tool_calls: [{ index: idx, function: { arguments: String(d.partial_json) } }] } });
        }
        // signature_delta 有意忽略：内部规范形没有签名字段，回投时我们也不带（见 anthropic-in 注释）
        return;
      }
      if (type === "message_delta") {
        const d = data.delta || {};
        const u = data.usage || {};
        // 合并 start 帧后再发：sink 侧是「最后一条 usage 覆盖」语义，只发 output 会把
        // prompt_tokens 记成 0（原实现如此，账面上 prompt 全部丢失）；上游在 delta 里
        // 重复给出的 input/缓存段以新值为准
        const merged = { ...(startUsage || {}), ...u };
        if (merged.input_tokens != null || merged.output_tokens != null) {
          emit({ type: "usage", usage: normalizeAnthropicUsage(merged) });
        }
        if (d.stop_reason) {
          sawFinish = true;
          emit({ type: "finish", reason: STOP_TO_FINISH[d.stop_reason] || "stop" });
        }
        return;
      }
      // content_block_stop / message_stop 不需要额外动作：块边界由调度侧按事件推导
    },
    /** SSE 结束但上游没给 message_delta（截断/异常收尾）也要有终止帧，否则客户端永远等不到 finish */
    close() {
      if (!sawFinish) emit({ type: "finish", reason: "" });
    },
  };
}

/** Anthropic 官方错误 type → 我们内部 HTTP 语义（调度器据此决定罚不罚号）。
 *  认不出的留给调用方传入的通用表（中转站常把欠费写成 invalid_request_error）。 */
const UP_ERROR_STATUS = {
  authentication_error: 401,
  permission_error: 401,
  rate_limit_error: 429,
  not_found_error: 404,
  overloaded_error: 503,
  api_error: 502,
  invalid_request_error: 400,
};
function upstreamErrorStatus(errObj) {
  return UP_ERROR_STATUS[String((errObj && errObj.type) || "")] || 502;
}

/** 上游无视 stream:true、直接回一整个 Messages 对象时的分支。
 *  不处理的话 SSE 扫描器一条事件都收不到，客户端会拿到一个 200 空响应——
 *  chatOpenai 里同有一条 content-type 兜底，两边都得有。 */
function emitWhole(data, emit, nameMap, statusOf) {
  const restore = (n) => (nameMap && nameMap[n]) || String(n || "");
  const mapStatus = statusOf || upstreamErrorStatus;
  if (!data || typeof data !== "object") return;
  if (data.type === "error" || data.error) {
    const e = data.error || {};
    emit({ type: "error", status: mapStatus(e, data), code: 0, message: String(e.message || "上游错误") });
    return;
  }
  const blocks = Array.isArray(data.content) ? data.content : [];
  let seq = 0;
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text" && b.text) emit({ type: "delta", delta: { content: String(b.text) } });
    else if (b.type === "thinking" && b.thinking) emit({ type: "delta", delta: { reasoning_content: String(b.thinking) } });
    else if (b.type === "tool_use") {
      emit({
        type: "delta",
        delta: { tool_calls: [{ index: seq++, id: String(b.id || ""), type: "function", function: { name: restore(b.name), arguments: JSON.stringify(b.input || {}) } }] },
      });
    }
    // server_tool_use / web_search_tool_result 等 Anthropic 服务端工具在 OpenAI 形态里没有对应物，丢弃
  }
  const u = data.usage || {};
  if (u.input_tokens != null || u.output_tokens != null) {
    emit({ type: "usage", usage: normalizeAnthropicUsage(u) });
  }
  emit({ type: "finish", reason: data.stop_reason ? STOP_TO_FINISH[data.stop_reason] || "stop" : "" });
}

const STOP_TO_FINISH = {
  end_turn: "stop",
  max_tokens: "length",
  stop_sequence: "stop",
  tool_use: "tool_calls",
  refusal: "content_filter",
  pause_turn: "stop",
  model_context_window_exceeded: "length",
};

module.exports = { toRequest, makeTranslator, emitWhole, upstreamErrorStatus, STOP_TO_FINISH, sanitizeName, restoreName };
