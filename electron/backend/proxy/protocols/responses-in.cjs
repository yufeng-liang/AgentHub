// 反代网关 · 入站协议：OpenAI Responses（Codex CLI 直接打这里）
//
// 职责与 anthropic-in 同构：把 `POST /v1/responses` 的请求体翻译成网关的内部规范形（OpenAI chat body），
// 反向翻译在 responses-out.cjs。
//
// 为什么这一层非做不可：Codex 已经把 `wire_api = "chat"` 删掉了，写它直接硬报错，
// 也就是说想让 Codex 直连本网关，就必须有人会讲 Responses 协议——CC Switch 那层翻译已经不成立了。
"use strict";

// Codex 随请求发、但网关没有对应能力的字段：**收下并忽略**，绝不回 400。
// 回 400 会当场打死客户端（它对 400 没有降级路径），而忽略的代价只是少了一个它本来也用不上的特性。
// store 是半个例外：false 会被收进原件回填（替用户关掉上游持久化），true 才是真忽略。
const IGNORED_FIELDS = ["store", "background", "include", "truncation", "service_tier",
  "prompt_cache_key", "metadata", "user", "safety_identifier", "top_logprobs"];

// 两端同格式时能原样补录回上游的 Responses 原生字段（chat 形状里没有它们的位置）。
// 只列 text 一条是有意的保守：能不能并到上游由 adapters.cjs 的 NATIVE_KEYS_BY_KIND 把关，
// 而那批被排除字段的理由（回程接不住 / 中转站不实现 / 有长度硬约束）都写在它上面。
// parallel_tool_calls 与 reasoning 的原件在下面单独特判，不并进这张表。
const NATIVE_FIELDS = ["text"];

/**
 * Responses 请求体 → 内部 OpenAI chat body。
 * @returns {{ok:true, body:object, notes:string[]} | {ok:false, message:string}}
 *
 * notes 记「这次转换丢了/降级了什么」（reasoning item 丢弃、私有工具类型降级……），
 * 由路由层打进日志：语义损失不可避免，不可追溯才是问题。
 */
function toInternal(raw) {
  const notes = [];
  if (!raw || typeof raw !== "object") return { ok: false, message: "请求体必须是 JSON 对象" };
  const model = String(raw.model || "");
  if (!model) return { ok: false, message: "model 不能为空" };
  // 本期不做会话存储，所以只有这一条是硬拒：拿不到历史就真的没法续写。
  // Codex 实测每轮全量重放历史、不发这个字段，正常路径碰不到。
  if (raw.previous_response_id) {
    return { ok: false, message: "网关不保存会话，无法按 previous_response_id 续写；请把完整历史放在 input 里" };
  }
  if (raw.input == null && !Array.isArray(raw.messages)) return { ok: false, message: "input 不能为空" };

  const messages = [];
  const instr = instructionsText(raw.instructions);
  if (instr) messages.push({ role: "system", content: instr });

  if (typeof raw.input === "string") {
    messages.push({ role: "user", content: raw.input });
  } else if (Array.isArray(raw.input)) {
    for (const item of raw.input) messages.push(...mapItem(item, notes));
  } else if (Array.isArray(raw.messages)) {
    // 少数客户端把 chat 的 messages 数组原样发过来：能接就接，不为难用户
    for (const m of raw.messages) if (m && typeof m === "object") messages.push(normalizeMessage(m, notes));
    notes.push("请求用的是 messages 而非 input（Responses 协议里没有这种写法），已按 chat 形态接收");
  }

  const body = { model, messages, stream: !!raw.stream };
  if (Number.isFinite(Number(raw.max_output_tokens)) && Number(raw.max_output_tokens) > 0) body.max_tokens = Math.floor(Number(raw.max_output_tokens));
  if (raw.temperature != null) body.temperature = Number(raw.temperature);
  if (raw.top_p != null) body.top_p = Number(raw.top_p);
  if (raw.stop != null) body.stop = raw.stop;
  if (raw.tool_choice != null) {
    const tc = mapToolChoice(raw.tool_choice, notes);
    if (tc) body.tool_choice = tc;
  }
  // effort 交给下游同一套档位降级（util.normalizeReasoningEffort 认 reasoning_effort）
  if (raw.reasoning && typeof raw.reasoning === "object" && raw.reasoning.effort) {
    body.reasoning_effort = String(raw.reasoning.effort).toLowerCase();
  }
  const tools = mapTools(raw.tools, notes);
  if (tools) body.tools = tools;

  const extraBody = {};
  // 不再 !! 强转：Responses 的 parallel_tool_calls 允许 boolean | "auto"，
  // 而这个值过去从没落到上游，现在它真的会被发出去，抄平就等于篡改
  if (raw.parallel_tool_calls != null) extraBody.parallel_tool_calls = raw.parallel_tool_calls;
  for (const f of NATIVE_FIELDS) if (raw[f] !== undefined) extraBody[f] = raw[f];
  if (raw.store === false) extraBody.store = false;
  if (raw.reasoning && typeof raw.reasoning === "object") {
    const rest = { ...raw.reasoning };
    // effort 只走档位降级那一条路（上面已映成 reasoning_effort）：整包回填会把
    // 「上游不支持就降档」绕成原样透传，换来一个 400
    delete rest.effort;
    if (Object.keys(rest).length) extraBody.reasoning = rest;
  }
  if (Object.keys(extraBody).length) body.extraBody = extraBody;

  for (const f of IGNORED_FIELDS) {
    if (raw[f] !== undefined && !(f === "store" && raw.store === false)) {
      notes.push(`Responses 字段 ${f} 已收下并忽略（网关无对应能力）`);
    }
  }
  return { ok: true, body, notes };
}

/** instructions：string 或 ContentItem[]，与 system 同处理——拼成一条 */
function instructionsText(instr) {
  if (!instr) return "";
  if (typeof instr === "string") return instr;
  if (!Array.isArray(instr)) return "";
  return instr.map((b) => (typeof b === "string" ? b : String((b && (b.text || b.content)) || ""))).filter(Boolean).join("\n");
}

/** input item → 0~N 条内部消息（一个 message item 可能同时给出正文与工具调用） */
function mapItem(item, notes) {
  if (!item || typeof item !== "object") return [];
  const type = String(item.type || (typeof item.role === "string" ? "message" : ""));
  if (type === "message" || item.role) return [normalizeMessage(item, notes)];
  if (type === "function_call") {
    // call_id 必须保真：它是 OpenAI 侧 tool_calls[].id，下一轮的 function_call_output 靠它关联，
    // 聚合器与出站侧都不能改它
    const id = String(item.call_id || item.id || "");
    return [{
      role: "assistant",
      content: "",
      tool_calls: [{ id, type: "function", function: { name: String(item.name || ""), arguments: typeof item.arguments === "string" ? item.arguments : safeStringify(item.arguments) } }],
    }];
  }
  if (type === "function_call_output") {
    const out = item.error ? `[error] ${typeof item.error === "string" ? item.error : safeStringify(item.error)}` : flattenOutput(item.output, notes);
    return [{ role: "tool", tool_call_id: String(item.call_id || ""), content: out }];
  }
  if (type === "reasoning") {
    notes.push("历史里的 reasoning item 已丢弃（思考内容不回投上游）");
    return [];
  }
  if (type === "item_reference") {
    notes.push("item_reference 未支持（网关不保存会话），该项已丢弃");
    return [];
  }
  // web_search_call / computer_call / mcp_call 等 Codex 私有扩展：不认识就跳过，但不拒请求
  notes.push(`未识别的 input item 类型 ${type || "(无 type)"}，已丢弃`);
  return [];
}

/** function_call_output 的 output：string 或 ContentItem[]（新版 API 允许带图片） */
function flattenOutput(output, notes) {
  if (output == null) return "";
  if (typeof output === "string") return output;
  if (!Array.isArray(output)) return safeStringify(output);
  const parts = [];
  for (const c of output) {
    if (!c || typeof c !== "object") continue;
    if (c.type === "input_text" || c.type === "output_text" || c.type === "text") parts.push(String(c.text || ""));
    else if (c.type === "input_image" && c.image_url) parts.push(`[image] ${String(c.image_url)}`);
    else notes.push(`工具结果里的 ${c.type || "(无 type)"} 内容项无对应物，已丢弃`);
  }
  return parts.join("\n");
}

function normalizeMessage(m, notes) {
  const role = m.role === "assistant" ? "assistant" : m.role === "system" || m.role === "developer" ? "system" : m.role === "tool" ? "tool" : "user";
  const out = { role };
  if (m.tool_call_id) out.tool_call_id = String(m.tool_call_id);
  const content = m.content;
  if (typeof content === "string") {
    out.content = content;
  } else if (Array.isArray(content)) {
    const textParts = [];
    const parts = [];
    for (const c of content) {
      if (!c || typeof c !== "object") continue;
      const t = String(c.type || "");
      if (t === "input_text" || t === "output_text" || t === "text") textParts.push(String(c.text || ""));
      else if (t === "input_image") {
        const url = typeof c.image_url === "string" ? c.image_url : (c.image_url && c.image_url.url) || c.url || "";
        if (url) parts.push({ type: "image_url", image_url: { url: String(url) } });
        else notes.push("input_image 没有可用的 url / image_url 字段，已丢弃");
      } else if (t === "input_audio") {
        notes.push("input_audio 无对应物（网关不转码音频），已丢弃");
      } else if (t === "refusal") {
        textParts.push(String(c.refusal || ""));
      } else if (t) {
        notes.push(`未识别的内容项类型 ${t}，已丢弃`);
      }
    }
    const text = textParts.join("");
    if (parts.length) out.content = [{ type: "text", text }, ...parts];
    else out.content = text;
  } else {
    out.content = "";
  }
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) out.tool_calls = m.tool_calls;
  return out;
}

/** tools[]：Responses 是**扁平**的 {type:'function',name,parameters}，chat 是嵌套的 {function:{...}}。
 *  两种写法都收：中转站/客户端混用得很多，认一种就把另一种判死没道理。 */
function mapTools(tools, notes) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const out = [];
  for (const t of tools) {
    if (!t || typeof t !== "object") continue;
    const fn = t.function && typeof t.function === "object" ? t.function : t;
    if (!fn.name) {
      notes.push(`工具类型 ${t.type || "(未声明)"} 无 name，已降级/丢弃`);
      continue;
    }
    if (t.type && t.type !== "function") {
      notes.push(`${t.type} 是 Codex/上游私有工具类型，已降级为普通 function`);
    }
    out.push({
      type: "function",
      function: {
        name: String(fn.name),
        description: fn.description ? String(fn.description) : "",
        parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
        ...(fn.strict != null ? { strict: !!fn.strict } : {}),
      },
    });
  }
  return out.length ? out : null;
}

/** tool_choice：字符串同 chat；对象形态 Responses 用 {type:'function',name}（扁平），
 *  而内部规范形要的是嵌套——不转的话下游适配器认不出来。 */
function mapToolChoice(choice, notes) {
  if (typeof choice === "string") return choice === "none" ? "none" : choice === "required" ? "required" : "auto";
  if (!choice || typeof choice !== "object") return null;
  if (choice.type === "function" || choice.function) {
    const name = (choice.function && choice.function.name) || choice.name;
    if (name) return { type: "function", function: { name: String(name) } };
  }
  if (choice.type === "hosted_tool" || choice.type === "allowed_tools" || choice.type === "mcp" || choice.type === "custom") {
    notes.push(`tool_choice.${choice.type} 无对应物，已退化为 auto`);
    return "auto";
  }
  if (choice.type === "none" || choice.type === "auto" || choice.type === "required") return choice.type;
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

module.exports = { toInternal, mapTools, mapToolChoice, IGNORED_FIELDS };
