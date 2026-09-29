// Responses 形态**上游**（出站）自测：node scripts/dev-responses-up-test.cjs
//
// 与 dev-responses-test.cjs 的方向相反：那道闸管的是「客户端打网关 /v1/responses」，
// 本闸管「网关打上游 /v1/responses」。两个方向共用 protocols/responses-*.cjs 这套词汇，
// 但代码路径完全不重叠（入站在 server.cjs 的 surface，出站在 adapters.cjs 的 kind 分派）。
//
// 用 mktemp 造库 + 假上游 + 测试端口，不碰真实 %APPDATA%，也不碰用户自己的 9527。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-respup-"));

const store = require("../electron/backend/proxy/store.cjs");
const provider = require("../electron/backend/proxy/provider.cjs");
const server = require("../electron/backend/proxy/server.cjs");
const rup = require("../electron/backend/proxy/protocols/responses-up.cjs");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? `→ got ${JSON.stringify(extra)}` : ""); }
}
const GW = 19581;
const UP = 19582;

/** 收集 emit 事件，便于逐条断言内部词汇 */
function collector() {
  const evs = [];
  return { evs, emit: (e) => evs.push(e) };
}
const deltas = (evs) => evs.filter((e) => e.type === "delta").map((e) => e.delta);
const flatToolText = (evs) => deltas(evs).flatMap((d) => (d.tool_calls || []).map((t) => (t.function && t.function.arguments) || "")).join("");

// ===== 请求侧：内部 OpenAI chat body → Responses 请求 =====
console.log("请求侧（toRequest）:");
let q = rup.toRequest("gpt-x", {
  messages: [
    { role: "system", content: "规则一" },
    { role: "developer", content: "规则二" },
    { role: "user", content: "你好" },
  ],
  max_tokens: 512,
  temperature: 0.3,
  top_p: 0.9,
});
ok("model 落到请求上", q.ok && q.request.model === "gpt-x", q.request);
ok("system/developer 拼成 instructions 且不进 input", q.request.instructions === "规则一\n\n规则二" && q.request.input.length === 1, [q.request.instructions, q.request.input]);
ok("user 字符串 → message item + input_text", q.request.input[0].type === "message" && q.request.input[0].role === "user" && q.request.input[0].content[0].type === "input_text" && q.request.input[0].content[0].text === "你好", q.request.input[0]);
ok("max_tokens → max_output_tokens", q.request.max_output_tokens === 512, q.request.max_output_tokens);
ok("无 max_tokens 时不硬造该键", !("max_output_tokens" in rup.toRequest("m", { messages: [{ role: "user", content: "hi" }] }).request));
ok("temperature/top_p 透传", q.request.temperature === 0.3 && q.request.top_p === 0.9, [q.request.temperature, q.request.top_p]);
ok("一律流式打上游（非流式由 server 侧本地聚合）", q.request.stream === true, q.request.stream);
ok("messages 为空直接拒（发过去必 400）", rup.toRequest("m", { messages: [] }).ok === false);

q = rup.toRequest("m", {
  messages: [
    { role: "user", content: [{ type: "text", text: "看这张图" }, { type: "image_url", image_url: { url: "https://a/b.png" } }] },
    { role: "assistant", content: "我调用一下", reasoning_content: "别给上游看", tool_calls: [{ id: "call_7", type: "function", function: { name: "shell", arguments: '{"cmd":"ls"}' } }] },
    { role: "tool", tool_call_id: "call_7", content: "a.txt" },
  ],
});
ok("多模态数组 → input_text + input_image", q.request.input[0].content[0].type === "input_text" && q.request.input[0].content[1].type === "input_image" && q.request.input[0].content[1].image_url === "https://a/b.png", q.request.input[0].content);
ok("assistant 正文 → output_text", q.request.input[1].type === "message" && q.request.input[1].role === "assistant" && q.request.input[1].content[0].type === "output_text", q.request.input[1]);
ok("tool_calls 拆成独立 function_call item 且 call_id 保真", q.request.input[2].type === "function_call" && q.request.input[2].call_id === "call_7" && q.request.input[2].name === "shell" && q.request.input[2].arguments === '{"cmd":"ls"}', q.request.input[2]);
ok("role:tool → function_call_output 且 call_id 保真", q.request.input[3].type === "function_call_output" && q.request.input[3].call_id === "call_7" && q.request.input[3].output === "a.txt", q.request.input[3]);
ok("思考链不回投上游且留痕", !JSON.stringify(q.request).includes("别给上游看") && q.notes.some((n) => /reasoning|思考/.test(n)), q.notes);

q = rup.toRequest("m", {
  messages: [{ role: "user", content: "hi" }],
  tools: [{ type: "function", function: { name: "shell", description: "跑命令", parameters: { type: "object", properties: {} }, strict: true } }],
  tool_choice: { type: "function", function: { name: "shell" } },
  reasoning_effort: "high",
  stop: ["END"],
});
ok("tools 嵌套 → 扁平（type/name/description/parameters）", q.request.tools[0].type === "function" && q.request.tools[0].name === "shell" && q.request.tools[0].description === "跑命令" && q.request.tools[0].parameters.type === "object", q.request.tools[0]);
ok("strict 保留（Responses 里它是 function 的字段）", q.request.tools[0].strict === true, q.request.tools[0]);
ok("tool_choice 嵌套 → 扁平", q.request.tool_choice.type === "function" && q.request.tool_choice.name === "shell", q.request.tool_choice);
ok("reasoning_effort → reasoning.effort", q.request.reasoning.effort === "high", q.request.reasoning);
ok("无 reasoning_effort 时不硬造 reasoning 键", !("reasoning" in rup.toRequest("m", { messages: [{ role: "user", content: "hi" }] }).request));
ok("stop 在 Responses 里没有对应物：丢弃但留痕", !("stop" in q.request) && q.notes.some((n) => /stop/.test(n)), q.notes);
for (const [chat, want] of [["auto", "auto"], ["required", "required"], ["none", "none"]]) {
  const r = rup.toRequest("m", { messages: [{ role: "user", content: "hi" }], tools: [{ type: "function", function: { name: "a" } }], tool_choice: chat });
  ok(`tool_choice "${chat}" 按字符串回`, r.request.tool_choice === want, r.request.tool_choice);
}

// ===== 事件流侧：Responses SSE → 内部 emit 词汇 =====
console.log("\n事件流侧（makeTranslator）:");
function runEvents(datas) {
  const c = collector();
  const tr = rup.makeTranslator(c.emit);
  for (const d of datas) tr.push(d);
  tr.close();
  return c.evs;
}
const textFlow = [
  { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
  { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
  { type: "response.reasoning_summary_text.delta", item_id: "rs_1", output_index: 0, summary_index: 0, delta: "先想想" },
  { type: "response.output_item.done", output_index: 0, item: { type: "reasoning", id: "rs_1", summary: [] } },
  { type: "response.output_item.added", output_index: 1, item: { type: "message", id: "msg_1", role: "assistant", content: [] } },
  { type: "response.content_part.added", item_id: "msg_1", output_index: 1, content_index: 0, part: { type: "output_text", text: "" } },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "你好" },
  { type: "response.output_text.delta", item_id: "msg_1", output_index: 1, content_index: 0, delta: "，世界" },
  { type: "response.output_text.done", item_id: "msg_1", output_index: 1, content_index: 0, text: "你好，世界" },
  { type: "response.content_part.done", item_id: "msg_1", output_index: 1, content_index: 0, part: { type: "output_text", text: "你好，世界" } },
  { type: "response.output_item.done", output_index: 1, item: { type: "message", role: "assistant", content: [{ type: "output_text", text: "你好，世界" }] } },
  { type: "response.completed", response: { id: "resp_1", status: "completed", output: [], usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33, input_tokens_details: { cached_tokens: 4 } } } },
];
let evs = runEvents(textFlow);
ok("正文 delta 按序拼出全文", deltas(evs).filter((d) => d.content).map((d) => d.content).join("") === "你好，世界", deltas(evs));
ok("思考链走 reasoning_content", deltas(evs).some((d) => d.reasoning_content === "先想想"), deltas(evs));
ok("usage 归一成 chat 口径（input→prompt、output→completion）", (() => {
  const u = (evs.find((e) => e.type === "usage") || {}).usage || {};
  return u.prompt_tokens === 11 && u.completion_tokens === 22 && u.total_tokens === 33;
})(), evs.filter((e) => e.type === "usage").map((e) => e.usage));
ok("缓存命中段带进 cached_tokens", (() => {
  const u = (evs.find((e) => e.type === "usage") || {}).usage || {};
  return u.cached_tokens === 4;
})(), evs.filter((e) => e.type === "usage").map((e) => e.usage));
ok("终止帧是 finish=stop（无工具调用时）", (() => {
  const f = evs.filter((e) => e.type === "finish");
  return f.length === 1 && f[0].reason === "stop";
})(), evs.filter((e) => e.type === "finish"));
ok("created/content_part 这类边界帧不产生多余 delta", deltas(evs).length === 3, deltas(evs));

const toolFlow = [
  { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "shell", arguments: "" } },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, call_id: "call_9", delta: '{"cmd":' },
  { type: "response.function_call_arguments.delta", item_id: "fc_1", output_index: 0, call_id: "call_9", delta: '"ls"}' },
  { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, arguments: '{"cmd":"ls"}' },
  { type: "response.output_item.done", output_index: 0, item: { type: "function_call", call_id: "call_9", name: "shell", arguments: '{"cmd":"ls"}' } },
  { type: "response.completed", response: { status: "completed", output: [{ type: "function_call", call_id: "call_9", name: "shell", arguments: '{"cmd":"ls"}' }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
];
evs = runEvents(toolFlow);
ok("function_call 首帧带 id/name（聚合器守卫要求，缺了就凭空造假条目）", (() => {
  const t = deltas(evs).flatMap((d) => d.tool_calls || [])[0] || {};
  return t.id === "call_9" && t.function.name === "shell" && t.index === 0;
})(), deltas(evs));
ok("参数增量拼回完整 JSON", flatToolText(evs) === '{"cmd":"ls"}', flatToolText(evs));
ok("arguments.done 的全量不重复计（只认增量）", (() => {
  const frags = deltas(evs).flatMap((d) => (d.tool_calls || []).map((t) => (t.function && t.function.arguments) || "")).filter(Boolean);
  return frags.length === 2;
})(), deltas(evs));
ok("有 function_call 输出时 finish=tool_calls", (() => {
  const f = evs.filter((e) => e.type === "finish");
  return f.length === 1 && f[0].reason === "tool_calls";
})(), evs.filter((e) => e.type === "finish"));

evs = runEvents([
  { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_a", call_id: "call_a", name: "one", arguments: "" } },
  { type: "response.function_call_arguments.delta", output_index: 0, delta: "1" },
  { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_b", call_id: "call_b", name: "two", arguments: "" } },
  { type: "response.function_call_arguments.delta", output_index: 1, delta: "2" },
  { type: "response.completed", response: { status: "completed", output: [], usage: { total_tokens: 0 } } },
]);
ok("并行两个工具各自占一个 index 且 arguments 不串", (() => {
  const byIndex = {};
  for (const d of deltas(evs)) for (const t of (d.tool_calls || [])) {
    byIndex[t.index] = byIndex[t.index] || { id: "", name: "", args: "" };
    if (t.id) byIndex[t.index].id = t.id;
    if (t.function && t.function.name) byIndex[t.index].name = t.function.name;
    if (t.function && t.function.arguments) byIndex[t.index].args += t.function.arguments;
  }
  return byIndex[0].id === "call_a" && byIndex[0].args === "1" && byIndex[1].id === "call_b" && byIndex[1].name === "two" && byIndex[1].args === "2";
})(), deltas(evs));

evs = runEvents([
  { type: "response.output_text.delta", output_index: 0, delta: "被截断" },
  { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } } },
]);
ok("incomplete(max_output_tokens) → finish=length 且 usage 不丢", (() => {
  const f = evs.filter((e) => e.type === "finish");
  const u = (evs.find((e) => e.type === "usage") || {}).usage || {};
  return f.length === 1 && f[0].reason === "length" && u.prompt_tokens === 5;
})(), [evs.filter((e) => e.type === "finish"), evs.filter((e) => e.type === "usage").map((e) => e.usage)]);

evs = runEvents([{ type: "response.output_text.delta", output_index: 0, delta: "半句" }]);
ok("流被截断（没有终止帧）也要 close 出 finish，否则客户端永远等不到收尾", (() => {
  const f = evs.filter((e) => e.type === "finish");
  return f.length === 1 && f[0].reason === "";
})(), evs.filter((e) => e.type === "finish"));

evs = runEvents([{ type: "error", message: "上游炸了", code: "server_error" }]);
ok("error 事件转成内部 error", (() => {
  const e = evs.find((x) => x.type === "error") || {};
  return e.message === "上游炸了";
})(), evs);
ok("error 状态映射：欠费判 402（只有 402 会走切号 + planLimit）", (() => {
  const seen = [];
  rup.makeTranslator((e) => seen.push(e)).push({ type: "error", message: "insufficient_quota", code: "insufficient_quota" });
  return (seen.find((e) => e.type === "error") || {}).status === 402;
})(), undefined);
ok("error 状态映射：限流 429 / 鉴权 401", (() => {
  const s1 = [];
  rup.makeTranslator((e) => s1.push(e)).push({ type: "error", message: "rate limit exceeded" });
  const s2 = [];
  rup.makeTranslator((e) => s2.push(e)).push({ type: "error", message: "invalid api key" });
  return s1[0].status === 429 && s2[0].status === 401;
})(), undefined);

evs = runEvents([{ type: "response.failed", response: { status: "failed", error: { message: "上游拒绝" } } }]);
ok("response.failed 按错误处理（不能当正常收尾）", (() => {
  const e = evs.find((x) => x.type === "error") || {};
  return e.message === "上游拒绝";
})(), evs);

console.log("\n整包兜底（emitWhole，上游无视 stream 回一整个 response）:");
const c = collector();
rup.emitWhole({
  id: "resp_9", status: "completed",
  output: [
    { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "想了一下" }] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "整包答复" }] },
    { type: "function_call", call_id: "call_z", name: "shell", arguments: '{"cmd":"id"}' },
  ],
  usage: { input_tokens: 8, output_tokens: 9, total_tokens: 17 },
}, c.emit);
ok("整包正文成一条 content delta", deltas(c.evs).some((d) => d.content === "整包答复"), deltas(c.evs));
ok("整包工具调用带 call_id 与全量参数", (() => {
  const t = deltas(c.evs).flatMap((d) => d.tool_calls || []).find((x) => x.id === "call_z");
  return !!t && t.function.name === "shell" && t.function.arguments === '{"cmd":"id"}';
})(), deltas(c.evs));
ok("整包 usage 与 finish 齐备", (() => {
  const u = (c.evs.find((e) => e.type === "usage") || {}).usage || {};
  const f = c.evs.filter((e) => e.type === "finish");
  return u.prompt_tokens === 8 && u.completion_tokens === 9 && f.length === 1 && f[0].reason === "tool_calls";
})(), [c.evs.find((e) => e.type === "usage"), c.evs.filter((e) => e.type === "finish")]);
const c2 = collector();
rup.emitWhole({ status: "failed", error: { message: "整包错误" } }, c2.emit);
ok("整包错误体转内部 error", (c2.evs.find((e) => e.type === "error") || {}).message === "整包错误", c2.evs);

// ===== 白名单：新 kind 必须过后端校验 =====
console.log("\nkind 白名单:");
ok("openai_responses 是合法 kind", provider.create({ id: "rup", baseUrl: `http://127.0.0.1:${UP}/v1`, display: "假Responses站", kind: "openai_responses", models: ["gpt-x", "tooly", "trunc", "whole"] }).ok === true);
ok("未知 kind 仍被拒", provider.create({ id: "rup2", baseUrl: `http://127.0.0.1:${UP}/v1`, kind: "openai_whatever" }).ok === false);

// ===== 端到端：客户端说 chat，上游只讲 Responses =====
function responsesFrames(b) {
  if (b.model === "tooly") {
    return [
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc_1", call_id: "call_9", name: "shell", arguments: "" } },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"cmd":' },
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '"ls"}' },
      { type: "response.completed", response: { status: "completed", output: [{ type: "function_call", call_id: "call_9", name: "shell", arguments: '{"cmd":"ls"}' }], usage: { input_tokens: 3, output_tokens: 4, total_tokens: 7 } } },
    ];
  }
  if (b.model === "trunc") {
    return [
      { type: "response.output_text.delta", output_index: 0, delta: "被截断" },
      { type: "response.incomplete", response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [], usage: { input_tokens: 5, output_tokens: 7, total_tokens: 12 } } },
    ];
  }
  return [
    { type: "response.output_item.added", output_index: 0, item: { type: "reasoning", id: "rs_1" } },
    { type: "response.reasoning_summary_text.delta", output_index: 0, summary_index: 0, delta: "先想想" },
    { type: "response.output_text.delta", output_index: 1, delta: "你好" },
    { type: "response.output_text.delta", output_index: 1, delta: "，世界" },
    { type: "response.completed", response: { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "你好，世界" }] }], usage: { input_tokens: 11, output_tokens: 22, total_tokens: 33, input_tokens_details: { cached_tokens: 4 } } } },
  ];
}

function fakeUpstream() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const b = JSON.parse(raw || "{}");
      // body 整体留一份：原生字段回填类断言要看具体值，keys 列表不足以区分「并回来了但值是错的」
      seen.push({ path: req.url, method: req.method, auth: String(req.headers.authorization || ""), model: b.model, stream: b.stream, keys: Object.keys(b).sort(), input: b.input || null, instructions: b.instructions || null, body: b });
      if (String(req.headers.authorization || "").includes("sk-bad")) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end('{"error":{"message":"rate limit"}}');
        return;
      }
      if (b.model === "whole") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: "resp_w", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "整包直回" }] }], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(responsesFrames(b).map((d) => `data: ${JSON.stringify(d)}\n\n`).join(""));
    });
  });
  return new Promise((res) => srv.listen(UP, "127.0.0.1", () => res({ srv, seen })));
}

function parseChatSse(text) {
  const out = [];
  for (const block of text.split("\n\n")) {
    const line = block.split("\n").find((l) => l.startsWith("data:"));
    if (!line) continue;
    const raw = line.slice(5).trim();
    if (raw === "[DONE]") { out.push({ done: true }); continue; }
    try { out.push(JSON.parse(raw)); } catch { /* 非 JSON 帧忽略 */ }
  }
  return out;
}

function post(body, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const headers = { "content-type": "application/json", authorization: "Bearer " + GWKEY.secret };
    const req = http.request(
      // agent:false —— 网关重启后复用旧 socket 会 ECONNRESET（闸自身基础设施坑，非被测代码）
      { host: "127.0.0.1", port: GW, path: "/v1/chat/completions", method: "POST", headers, agent: false },
      (res) => {
        let t = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (t += d));
        res.on("end", () => resolve({ status: res.statusCode, text: t, ctype: String(res.headers["content-type"] || "") }));
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error("网关 15s 无响应")));
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** 客户端侧也用 Responses 协议打网关（/v1/responses 入站 → Responses 形态上游）：
 *  这是「两端同格式」的那格，用来验原生字段补录是否真的走通。 */
function postResponses(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: GW, path: "/v1/responses", method: "POST", agent: false,
        headers: { "content-type": "application/json", authorization: "Bearer " + GWKEY.secret } },
      (res) => {
        let t = "";
        res.setEncoding("utf8");
        res.on("data", (d) => (t += d));
        res.on("end", () => resolve({ status: res.statusCode, text: t }));
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error("网关 15s 无响应")));
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

/** chat 末帧的 choices 是空数组、[DONE] 帧根本没有 choices——
 *  所有取 delta/finish_reason 的断言一律走这两个守卫过的取值器，别在闸里制造 TypeError。 */
const frameDeltas = (frames) => frames.map((x) => (x.choices && x.choices[0] && x.choices[0].delta) || null).filter(Boolean);
const frameContent = (frames) => frameDeltas(frames).map((d) => d.content || "").join("");
const frameFinish = (frames) => frames.map((x) => (x.choices && x.choices[0] && x.choices[0].finish_reason) || null).filter(Boolean);
const frameToolText = (frames) => frameDeltas(frames).flatMap((d) => (d.tool_calls || []).map((t) => (t.function && t.function.arguments) || "")).join("");

let GWKEY = { secret: "" };
(async () => {
  const { srv, seen } = await fakeUpstream();
  provider.addKey("rup", { name: "限速的", key: "sk-bad" });
  provider.addKey("rup", { name: "好的", key: "sk-good" });
  store.open();
  GWKEY = store.createKey({ name: "respup-e2e", route: "auto" });
  const sr = await server.start(() => ({
    port: GW, bind: "127.0.0.1", rateLimitPerMin: 0, concurrency: 8, routeStrategy: "smart",
    fixedChannel: "trae", modelOverrides: {}, debugStatus: false, humanizeJitter: false,
  }));
  ok("网关在测试端口起来", sr.ok === true && sr.port === GW, sr);

  const a = await post({ model: "rup/gpt-x", messages: [{ role: "user", content: "你好" }], stream: true });
  const ca = parseChatSse(a.text);
  ok("chat 客户端拿到 200 + SSE 内容类型", a.status === 200 && /text\/event-stream/.test(a.ctype), [a.status, a.ctype]);
  ok("正文拼回完整一轮", frameContent(ca) === "你好，世界", frameDeltas(ca));
  ok("思考链走 reasoning_content", frameDeltas(ca).some((d) => d.reasoning_content === "先想想"), frameDeltas(ca));
  // 出线 usage 是网关统一的**扁平 cached_tokens**（不是 OpenAI 原生的 prompt_tokens_details）——
  // 所有渠道都这一个形状，由 dev-sink-golden 逐字守着，Responses 形态上游不能自成一派
  ok("末帧 usage 是 chat 口径且缓存段可见", (() => {
    const u = (ca.filter((x) => x.usage).pop() || {}).usage || {};
    return u.prompt_tokens === 11 && u.completion_tokens === 22 && u.total_tokens === 33 && u.cached_tokens === 4;
  })(), (ca.filter((x) => x.usage).pop() || {}).usage);
  ok("上游收到的是 /v1/responses + Bearer + 去前缀模型名", seen[0].path === "/v1/responses" && /^Bearer sk-/.test(seen[0].auth) && seen[0].model === "gpt-x", seen[0]);
  ok("上游收到的是 Responses 形状（input/instructions，没有 messages）", !seen[0].keys.includes("messages") && Array.isArray(seen[0].input), seen[0]);

  const b = await post({ model: "rup/tooly", messages: [{ role: "user", content: "跑一下" }], stream: true });
  const cb = parseChatSse(b.text);
  const tool = frameDeltas(cb).flatMap((d) => d.tool_calls || []).find((t) => t.id === "call_9");
  ok("工具回环：call_id 与 name 原样回到 chat 客户端", !!tool && tool.function.name === "shell", frameDeltas(cb));
  ok("工具参数增量拼回完整 JSON", frameToolText(cb) === '{"cmd":"ls"}', frameDeltas(cb));
  ok("finish_reason=tool_calls", frameFinish(cb).includes("tool_calls"), frameFinish(cb));

  const d = await post({ model: "rup/trunc", messages: [{ role: "user", content: "hi" }], stream: true });
  ok("上游截断 → finish_reason=length", frameFinish(parseChatSse(d.text)).includes("length"), frameFinish(parseChatSse(d.text)));

  const w = await post({ model: "rup/whole", messages: [{ role: "user", content: "hi" }], stream: true });
  ok("上游无视 stream 回整包 JSON 也不空响应", frameContent(parseChatSse(w.text)).includes("整包直回"), w.text.slice(0, 200));

  // 第一把 Key 429 → 换号：gpt-x 这条已经在 seen[0] 成功过，这里只验「换号后仍拿到完整一轮」
  const e = await post({ model: "rup/gpt-x", messages: [{ role: "user", content: "你好" }], stream: true });
  ok("Key 被限流后换号，客户端只见完整一轮", frameContent(parseChatSse(e.text)) === "你好，世界", e.text.slice(0, 200));

  const f = await post({ model: "rup/gpt-x", messages: [{ role: "system", content: "规则" }, { role: "user", content: "你好" }] });
  ok("非流式请求本地聚合可用", f.status === 200 && JSON.parse(f.text).choices[0].message.content === "你好，世界", f.text.slice(0, 200));

  // ===== 两端同格式（Responses 客户端 → Responses 上游）：协议原生字段必须补录到上游 =====
  // 这些字段在 chat 形状里没有对应物，入站层过去只是"收下并忽略"，于是两端都支持的字段
  // 被中间层抹平。判据取自 OpenAI 的 CreateResponse 请求表，不是猜上游会不会忽略未知字段。
  provider.update("rup", { models: ["gpt-x", "tooly", "trunc", "whole", { model: "efforty", reasoning: { supportedEfforts: ["medium"], defaultEffort: "medium" } }] });
  const n = await postResponses({
    model: "rup/gpt-x", input: "你好", stream: true,
    text: { format: { type: "json_schema", json_schema: { name: "t", schema: { type: "object" } } } },
    service_tier: "priority", include: ["reasoning.encrypted_content"], truncation: "disabled",
    safety_identifier: "safety-1", parallel_tool_calls: false, store: false,
    reasoning: { effort: "high", summary: "auto" },
  });
  ok("Responses 客户端 → Responses 上游拿到 200", n.status === 200, [n.status, n.text.slice(0, 200)]);
  const up = seen[seen.length - 1].body;
  ok("结构化输出 text 原件到达上游", up.text && up.text.format.type === "json_schema", up.text);
  ok("被刻意排除的字段确实没发给上游（收窄的白名单要有反向判据）",
    !("service_tier" in up) && !("include" in up) && !("truncation" in up) && !("safety_identifier" in up),
    Object.keys(up));
  ok("parallel_tool_calls 原件到达上游", up.parallel_tool_calls === false, up.parallel_tool_calls);
  ok("客户端显式 store:false 必须尊重（丢就等于替用户打开上游持久化）", up.store === false, up.store);
  ok("reasoning.summary 到达上游", up.reasoning && up.reasoning.summary === "auto", up.reasoning);
  ok("上游请求仍是 Responses 形状（没有 messages/字面 extraBody）",
    !("messages" in up) && !("extraBody" in up), Object.keys(up));

  // 客户端要的档位上游不支持时，降级由档位表说了算——原件里的 effort 不许绕开它
  const ne = await postResponses({ model: "rup/efforty", input: "hi", stream: true, reasoning: { effort: "high", summary: "auto" } });
  const upE = seen[seen.length - 1].body;
  ok("同协议补录不得绕过思考档位降级（high→声明的 medium）", ne.status === 200 && upE.reasoning.effort === "medium", upE.reasoning);
  ok("降级后 summary 仍随原件带上", upE.reasoning.summary === "auto", upE.reasoning);

  // 会话存储语义维持不放开：网关每轮全量重放且多号轮转，response id 跨账号互不相通
  const np = await postResponses({ model: "rup/gpt-x", input: "hi", previous_response_id: "resp_abc" });
  ok("previous_response_id 仍是硬拒 400", np.status === 400, [np.status, np.text.slice(0, 160)]);

  srv.close();
  server.stop();
  store.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n闸自身异常:", e);
  process.exit(1);
});
