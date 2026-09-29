// /v1/responses（OpenAI Responses 入站，Codex CLI 直连）自测：node scripts/dev-responses-test.cjs
// 用 mktemp 造库 + 假上游 + 测试端口，不碰真实 %APPDATA%，也不碰用户自己的 9527。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-responses-"));

const store = require("../electron/backend/proxy/store.cjs");
const provider = require("../electron/backend/proxy/provider.cjs");
const server = require("../electron/backend/proxy/server.cjs");
const rin = require("../electron/backend/proxy/protocols/responses-in.cjs");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? `→ got ${JSON.stringify(extra)}` : ""); }
}
const GW = 19571;
const UP = 19572;

// ===== 入站归一：Responses item[] → 内部 OpenAI chat body =====
console.log("入站归一（toInternal）:");
ok("缺 model 被拒", rin.toInternal({ input: "hi" }).ok === false);
ok("缺 input 被拒", rin.toInternal({ model: "m" }).ok === false);
ok("input 为空数组也算空", rin.toInternal({ model: "m", input: [] }).body.messages.length === 0);
ok("previous_response_id 非空才拒（本期不做会话存储）", rin.toInternal({ model: "m", input: "hi", previous_response_id: "resp_1" }).ok === false);
ok("previous_response_id 为空串不拦", rin.toInternal({ model: "m", input: "hi", previous_response_id: "" }).ok === true);

let r = rin.toInternal({ model: "gpt-x", input: "你好" });
ok("字符串 input → 一条 user", r.ok && r.body.messages.length === 1 && r.body.messages[0].content === "你好", r.body);
ok("stream 缺省 false", r.body.stream === false);

r = rin.toInternal({
  model: "gpt-x",
  instructions: "你是一个助手",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  max_output_tokens: 512,
  temperature: 0.3,
  store: true, background: false, include: ["reasoning.matched_message_content"], truncation: "auto",
  parallel_tool_calls: "auto", text: { format: { type: "json_schema", json_schema: { name: "t" } } },
});
ok("instructions → 首条 system", r.body.messages[0].role === "system" && r.body.messages[0].content === "你是一个助手", r.body.messages);
ok("max_output_tokens → max_tokens", r.body.max_tokens === 512, r.body.max_tokens);
ok("store/background/include 收下不拒（回 400 会当场打死 Codex）", r.ok === true, r);
// include/truncation 现在收进内部载体等出站按形态回填，不再是损失；只有真没落地的才留痕
ok("真被忽略的字段留痕可查", r.notes.some((n) => /store/.test(n)) && r.notes.some((n) => /include/.test(n)) && r.notes.some((n) => /truncation/.test(n)), r.notes);
ok("可补录的原生字段不谎称已忽略", !r.notes.some((n) => /text/.test(n)), r.notes);
ok("text（结构化输出）进了内部载体", JSON.stringify(r.body.extraBody?.text) === '{"format":{"type":"json_schema","json_schema":{"name":"t"}}}', r.body.extraBody);
// Responses 的 parallel_tool_calls 是 boolean | "auto"：曾经的 !! 强转只在它从没落到上游时无害
ok("parallel_tool_calls 的 auto 不被强转成 true", r.body.extraBody?.parallel_tool_calls === "auto", r.body.extraBody);

// store 的例外方向：客户端显式"别存"必须尊重，丢掉等于替用户打开上游持久化
const rn = rin.toInternal({ model: "gpt-x", input: "hi", store: false });
ok("store:false 收进载体且不再写忽略 note", rn.body.extraBody?.store === false && !rn.notes.some((n) => /store/.test(n)), rn.notes);

r = rin.toInternal({
  model: "gpt-x",
  input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: "规则" }] },
    { type: "message", role: "user", content: [{ type: "input_text", text: "看这张图" }, { type: "input_image", image_url: "https://a/b.png" }] },
    { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: "我调用一下" }] },
    { type: "function_call", call_id: "call_7", name: "shell", arguments: '{"cmd":"ls"}' },
    { type: "function_call_output", call_id: "call_7", output: [{ type: "output_text", text: "a.txt" }] },
    { type: "function_call_output", call_id: "call_8", error: "命令失败" },
    { type: "web_search_call", id: "ws_1" },
  ],
});
const msgs = r.body.messages;
ok("developer 归到 system", msgs[0].role === "system" && msgs[0].content === "规则", msgs[0]);
ok("input_image → image_url 且文本不丢", msgs[1].content[0].text === "看这张图" && msgs[1].content[1].image_url.url === "https://a/b.png", msgs[1]);
ok("assistant 的 output_text 归到 content", msgs[2].role === "assistant" && msgs[2].content === "我调用一下", msgs[2]);
ok("function_call → tool_calls（call_id 保真）", msgs[3].tool_calls[0].id === "call_7" && msgs[3].tool_calls[0].function.arguments === '{"cmd":"ls"}', msgs[3]);
ok("function_call_output → role:tool + tool_call_id", msgs[4].role === "tool" && msgs[4].tool_call_id === "call_7" && msgs[4].content === "a.txt", msgs[4]);
ok("工具报错也落到 role:tool 并带前缀", msgs[5].content === "[error] 命令失败", msgs[5]);
ok("reasoning item 丢弃且留痕（思考不回投）", r.notes.some((n) => /reasoning/.test(n)), r.notes);
ok("私有 item 类型只丢弃不拒请求", r.ok === true && r.notes.some((n) => /web_search_call/.test(n)), r.notes);

r = rin.toInternal({
  model: "gpt-x",
  input: "hi",
  tools: [
    { type: "function", name: "shell", description: "d", parameters: { type: "object", properties: {} }, strict: true },
    { type: "namespace", name: "multi", parameters: { type: "object" } },
    { type: "web_search" },
    { type: "custom", name: "freeform" },
    { type: "function", function: { name: "nested", parameters: { type: "object" } } },
  ],
  tool_choice: { type: "function", name: "shell" },
  reasoning: { effort: "HIGH", summary: "auto" },
  parallel_tool_calls: true,
});
ok("扁平 function → 嵌套形态", r.body.tools[0].type === "function" && r.body.tools[0].function.name === "shell" && r.body.tools[0].function.strict === true, r.body.tools[0]);
ok("chat 的嵌套写法也收（两种混用很常见）", r.body.tools.some((t) => t.function.name === "nested"), r.body.tools.map((t) => t.function.name));
ok("namespace/custom 私有工具降级为 function 并留痕", r.body.tools.some((t) => t.function.name === "multi") && r.notes.some((n) => /降级/.test(n)), r.notes);
ok("无 name 的托管工具直接丢弃", !r.body.tools.some((t) => t.function.name === "web_search"), r.body.tools);
ok("tool_choice 扁平 → 嵌套", r.body.tool_choice.type === "function" && r.body.tool_choice.function.name === "shell", r.body.tool_choice);
ok("reasoning.effort → reasoning_effort（归一小写，交给下游档位降级）", r.body.reasoning_effort === "high", r.body.reasoning_effort);
ok("parallel_tool_calls 进 extraBody 透传", r.body.extraBody.parallel_tool_calls === true, r.body.extraBody);

// ===== 端到端：客户端说 Responses，上游是 OpenAI 兼容中转站 =====
function fakeUpstream() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const b = JSON.parse(raw || "{}");
      seen.push({ path: req.url, auth: String(req.headers.authorization || ""), model: b.model, stream: b.stream, tools: b.tools || null });
      if (String(req.headers.authorization || "").includes("sk-bad")) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end('{"error":{"message":"rate limit"}}');
        return;
      }
      const ch = (d, f, u) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: b.model, choices: [{ index: 0, delta: d, finish_reason: f || null }], ...(u ? { usage: u } : {}) })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (b.model === "tooly") {
        res.end(
          ch({ role: "assistant" }, null) +
          ch({ tool_calls: [{ index: 0, id: "call_9", function: { name: "shell", arguments: "" } }] }, null) +
          ch({ tool_calls: [{ index: 0, function: { arguments: '{"cmd":' } }] }, null) +
          ch({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }, "tool_calls") +
          "data: [DONE]\n\n"
        );
        return;
      }
      if (b.model === "trunc") {
        res.end(ch({ content: "被截断" }, "length", { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }) + "data: [DONE]\n\n");
        return;
      }
      res.end(
        ch({ role: "assistant", content: "" }, null) +
        ch({ reasoning_content: "先想想" }, null) +
        ch({ content: "你好" }, null) +
        ch({ content: "，世界" }, "stop", { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 }) +
        "data: [DONE]\n\n"
      );
    });
  });
  return new Promise((res) => srv.listen(UP, "127.0.0.1", () => res({ srv, seen })));
}

function parseSse(text) {
  const out = [];
  for (const block of text.split("\n\n")) {
    if (!block.trim()) continue;
    let event = null;
    let data = null;
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data = JSON.parse(line.slice(5).trim());
    }
    if (data) out.push({ event, data });
  }
  return out;
}
const types = (frames) => frames.map((f) => f.data.type);
const frameOf = (frames, t) => frames.find((f) => f.data.type === t);

let GWKEY = { secret: "" };
function post(body, opts) {
  const o = opts || {};
  return new Promise((resolve, reject) => {
    const headers = Object.assign(
      { "content-type": "application/json", authorization: "Bearer " + (o.key === undefined ? GWKEY.secret : o.key) },
      o.headers || {}
    );
    const req = http.request(
      // agent:false —— Node 19+ 的 globalAgent 默认带连接池，网关重启后复用同一 host:port 的
      // 旧 socket 会直接 ECONNRESET（这不是被测代码的问题，是闸自己的基础设施坑）
      { host: "127.0.0.1", port: GW, path: o.path || "/v1/responses", method: "POST", headers, agent: false },
      (res) => {
        let t = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode, text: t, ctype: res.headers["content-type"] }));
      }
    );
    // 闸自己的超时：网关某条路径不再回应时必须报错变红，而不是挂着等人 kill
    req.setTimeout(15000, () => req.destroy(new Error(`请求 ${o.path || "/v1/responses"} 15s 无响应`)));
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
  const { srv, seen } = await fakeUpstream();
  provider.create({ id: "rel", baseUrl: `http://127.0.0.1:${UP}/v1`, display: "假中转", models: ["gpt-x", "tooly", "trunc"] });
  provider.addKey("rel", { name: "限速的", key: "sk-bad" });
  provider.addKey("rel", { name: "好的", key: "sk-good" });
  store.open();
  GWKEY = store.createKey({ name: "responses-e2e", route: "auto" });
  const sr = await server.start(() => ({
    port: GW, bind: "127.0.0.1", rateLimitPerMin: 0, concurrency: 8, routeStrategy: "smart",
    fixedChannel: "trae", modelOverrides: {}, debugStatus: false, humanizeJitter: false,
  }));
  ok("网关在测试端口起来", sr.ok === true && sr.port === GW, sr);

  // ---- 常规对话 ----
  const a = await post({ model: "rel/gpt-x", input: "你好", stream: true });
  const fa = parseSse(a.text);
  ok("流式 200 + SSE 内容类型", a.status === 200 && /text\/event-stream/.test(a.ctype || ""), [a.status, a.ctype]);
  ok("首帧是 response.created 且 status=in_progress", fa[0].data.type === "response.created" && fa[0].data.response.status === "in_progress", types(fa).slice(0, 3));
  ok("EOF 前必须出现 response.completed（缺了 Codex 直接报错）", fa[fa.length - 1].data.type === "response.completed", types(fa).slice(-2));
  ok("completed 里 status=completed", frameOf(fa, "response.completed").data.response.status === "completed", frameOf(fa, "response.completed").data.response.status);
  ok("本协议没有 [DONE]（不是 Responses 的东西）", !/\[DONE\]/.test(a.text));
  ok("事件顺序：思考项与正文项各自成对闭合，最后 completed 收束", JSON.stringify(types(fa)) === JSON.stringify([
    "response.created",
    "response.output_item.added", "response.reasoning_summary_part.added", "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done", "response.reasoning_summary_part.done", "response.output_item.done",
    "response.output_item.added", "response.content_part.added",
    "response.output_text.delta", "response.output_text.delta",
    "response.output_text.done", "response.content_part.done", "response.output_item.done",
    "response.completed",
  ]), types(fa));
  ok("正文 delta 拼出全文", fa.filter((f) => f.data.type === "response.output_text.delta").map((f) => f.data.delta).join("") === "你好，世界", types(fa));
  const doneItem = fa.filter((f) => f.data.type === "response.output_item.done").map((f) => f.data.item).find((i) => i.type === "message");
  ok("output_item.done 的 item 可反序列化（content 带 output_text + annotations）", doneItem && doneItem.role === "assistant" && doneItem.content[0].type === "output_text" && doneItem.content[0].text === "你好，世界" && Array.isArray(doneItem.content[0].annotations), fa.filter((f) => f.data.type === "response.output_item.done").map((f) => f.data.item));
  ok("usage 用 Responses 字段名（input/output/total_tokens）", JSON.stringify(frameOf(fa, "response.completed").data.response.usage) === JSON.stringify({ input_tokens: 11, output_tokens: 22, total_tokens: 33 }), frameOf(fa, "response.completed").data.response.usage);
  ok("思考链成为 reasoning item 且 encrypted_content 这个 key 存在", (() => {
    const added = fa.filter((f) => f.data.type === "response.output_item.added").map((f) => f.data.item);
    const rs = added.find((i) => i.type === "reasoning");
    return !!rs && Object.prototype.hasOwnProperty.call(rs, "encrypted_content");
  })(), fa.filter((f) => f.data.type === "response.output_item.added").map((f) => f.data.item));
  ok("思考与正文各占一个 output_index 且顺序为思考在前", (() => {
    const added = fa.filter((f) => f.data.type === "response.output_item.added").map((f) => f.data.item.type);
    return JSON.stringify(added) === JSON.stringify(["reasoning", "message"]);
  })(), fa.filter((f) => f.data.type === "response.output_item.added").map((f) => f.data.item.type));
  ok("response.output 收束时含两个完整 item", (() => {
    const out = frameOf(fa, "response.completed").data.response.output;
    return out.length === 2 && out[0].type === "reasoning" && out[1].content[0].text === "你好，世界";
  })(), frameOf(fa, "response.completed").data.response.output);
  ok("上游收到的是去掉前缀的模型名", seen[0].model === "gpt-x", seen[0]);

  // ---- 工具调用回环 ----
  const b = await post({ model: "rel/tooly", input: "跑一下", stream: true });
  const fb = parseSse(b.text);
  const fc = fb.filter((f) => f.data.type === "response.output_item.added").map((f) => f.data.item)[0];
  ok("function_call item 三键齐备（name/arguments/call_id）", fc.type === "function_call" && fc.name === "shell" && typeof fc.arguments === "string" && !!fc.call_id, fc);
  ok("call_id 与上游一致（下一轮靠它关联，改了就是断链）", fc.call_id === "call_9", fc.call_id);
  const argDeltas = fb.filter((f) => f.data.type === "response.function_call_arguments.delta").map((f) => f.data.delta).join("");
  ok("参数增量拼回完整 JSON", argDeltas === '{"cmd":"ls"}', argDeltas);
  ok("参数序：arguments.delta → arguments.done → item.done → completed", (() => {
    const t = types(fb);
    return t.indexOf("response.function_call_arguments.done") < t.indexOf("response.output_item.done") && t[t.length - 1] === "response.completed";
  })(), types(fb));
  ok("item.done 的 arguments 是全量字符串", frameOf(fb, "response.output_item.done").data.item.arguments === '{"cmd":"ls"}', frameOf(fb, "response.output_item.done").data.item);
  ok("finish_reason=tool_calls 仍收 completed（不是 failed）", frameOf(fb, "response.completed").data.response.status === "completed", types(fb).slice(-1));

  // ---- 截断：不能发 response.incomplete（Codex 把它当失败） ----
  const c = await post({ model: "rel/trunc", input: "hi", stream: true });
  const fc2 = parseSse(c.text);
  // 这里不假设 completed 帧一定在：缺帧必须是断言变红，而不是闸自己抛异常——
  // 崩掉的闸只给一句"闸自身异常"，看不出是哪条保护没了（变异自证时被这条坑过一次）
  const compFrame = frameOf(fc2, "response.completed");
  const comp = compFrame ? compFrame.data.response : null;
  ok("max_tokens 截断也发 completed + incomplete_details", fc2[fc2.length - 1].data.type === "response.completed" && !types(fc2).includes("response.incomplete") && !!comp && comp.incomplete_details && comp.incomplete_details.reason === "max_output_tokens", [types(fc2).slice(-1), comp && comp.incomplete_details]);

  // ---- 换号：第一把 Key 429 ----
  const d = await post({ model: "rel/gpt-x", input: "你好", stream: true });
  const fd = parseSse(d.text);
  ok("换号后只有一个 response.created（deferredOpen 生效）", types(fd).filter((t) => t === "response.created").length === 1, types(fd));
  ok("换号对客户端无痕（正文与 usage 仍是完整一轮）", frameOf(fd, "response.completed").data.response.usage.total_tokens === 33, types(fd));

  // ---- 非流式 ----
  const e = await post({ model: "rel/gpt-x", input: "你好" });
  const ebody = JSON.parse(e.text || "{}");
  ok("非流式回一条 Response 对象（不是 SSE）", e.status === 200 && ebody.object === "response" && ebody.status === "completed" && /application\/json/.test(e.ctype || ""), [e.status, e.ctype, e.text.slice(0, 160)]);
  ok("非流式 output 与 usage 齐全", ebody.output[1].content[0].text === "你好，世界" && ebody.usage.output_tokens === 22, ebody.output);

  // ---- 错误形状 ----
  const badKey = await post({ model: "rel/gpt-x", input: "hi" }, { key: "sk-not-a-gateway-key" });
  ok("鉴权失败是 Responses 错误外壳（error.message/type）", badKey.status === 401 && badKey.text.includes("\"error\"") && JSON.parse(badKey.text).error.type, badKey.text);
  const badModel = await post({ model: "nosuch/model", input: "hi" });
  ok("未知模型 400 且带可用模型提示", badModel.status === 400 && /不在任何渠道目录/.test(badModel.text), [badModel.status, badModel.text.slice(0, 160)]);
  const badPrev = await post({ model: "rel/gpt-x", input: "hi", previous_response_id: "resp_9" });
  ok("previous_response_id 的 400 说清怎么办", badPrev.status === 400 && /完整历史/.test(badPrev.text), badPrev.text);

  // ---- 止血开关 ----
  // 必须等监听完全释放再重绑：stop() 只 close 不等待，立刻 listen 会把在途连接 Reset 掉
  await server.stopAsync();
  const sr2 = await server.start(() => ({
    port: GW, bind: "127.0.0.1", rateLimitPerMin: 0, concurrency: 8, routeStrategy: "smart",
    fixedChannel: "trae", modelOverrides: {}, debugStatus: false, humanizeJitter: false, enableResponses: false,
  }));
  const off = await post({ model: "rel/gpt-x", input: "hi", stream: true });
  ok("enableResponses=false 时端点直接 404（不必回滚代码）", sr2.ok === true && off.status === 404, [sr2, off.status]);

  srv.close();
  server.stop();
  store.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n闸自身异常:", e);
  process.exit(1);
});
