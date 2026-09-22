// /v1/messages（Anthropic Messages 入站）自测：node scripts/dev-anthropic-test.cjs
// 用 mktemp 造库 + 假上游 + 测试端口，不碰真实 %APPDATA%，也不碰用户自己的 9527。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-anthropic-"));

const store = require("../electron/backend/proxy/store.cjs");
const provider = require("../electron/backend/proxy/provider.cjs");
const server = require("../electron/backend/proxy/server.cjs");
const ain = require("../electron/backend/proxy/protocols/anthropic-in.cjs");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? `→ got ${JSON.stringify(extra)}` : ""); }
}
const GW = 19561;
const UP = 19562;

console.log("入站归一（toInternal）:");
ok("缺 model 被拒", ain.toInternal({ max_tokens: 1, messages: [{ role: "user", content: "x" }] }).ok === false);
ok("缺 max_tokens 被拒（Anthropic 必填）", ain.toInternal({ model: "m", messages: [{ role: "user", content: "x" }] }).ok === false);
ok("缺 messages 被拒", ain.toInternal({ model: "m", max_tokens: 1, messages: [] }).ok === false);

let r = ain.toInternal({ model: "claude-sonnet-4-5", max_tokens: 1024, messages: [{ role: "user", content: "你好" }] });
ok("最小合法请求 + max_tokens 透传", r.ok && r.body.messages[0].content === "你好" && r.body.max_tokens === 1024, r);
ok("stream 缺省 false", r.body.stream === false);

r = ain.toInternal({
  model: "m", max_tokens: 100,
  system: [{ type: "text", text: "你是 A" }, { type: "text", text: "遵守 B", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "hi" }], stop_sequences: ["END"], top_p: 0.9, top_k: 40,
});
ok("多段 system 按序拼成一条", r.body.messages[0].role === "system" && r.body.messages[0].content === "你是 A\n遵守 B", r.body.messages);
ok("stop_sequences → stop", JSON.stringify(r.body.stop) === '["END"]', r.body.stop);
ok("top_k 等私有字段进 extraBody 不丢", r.body.extraBody.top_k === 40, r.body.extraBody);

r = ain.toInternal({
  model: "m", max_tokens: 100,
  messages: [
    { role: "user", content: "读文件" },
    { role: "assistant", content: [{ type: "text", text: "我读一下" }, { type: "tool_use", id: "toolu_1", name: "Read", input: { path: "/a" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "文件内容" }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "出错" }], is_error: true }] },
  ],
});
const m = r.body.messages;
ok("tool_use → tool_calls（id 保真 + arguments 序列化成字符串）", m[1].tool_calls[0].id === "toolu_1" && m[1].tool_calls[0].function.arguments === '{"path":"/a"}', m[1]);
ok("assistant 的 text 与 tool_use 共存时文本不丢", m[1].content === "我读一下", m[1]);
ok("tool_result → role:tool + tool_call_id", m[2].role === "tool" && m[2].tool_call_id === "toolu_1" && m[2].content === "文件内容", m[2]);
ok("is_error 加前缀标记", m[3].content === "[error] 出错", m[3]);

r = ain.toInternal({
  model: "m", max_tokens: 100,
  messages: [
    { role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } }] },
    { role: "user", content: [{ type: "image", source: { type: "file", file_id: "f1" } }] },
    { role: "assistant", content: [{ type: "thinking", thinking: "推理", signature: "sig" }] },
  ],
  tools: [{ name: "Read", input_schema: { type: "object" } }, { name: "bad name!", input_schema: { type: "object" } }],
  tool_choice: { type: "any" },
});
ok("base64 图 → data URI", r.body.messages[0].content[1].image_url.url === "data:image/png;base64,QUJD", r.body.messages[0]);
ok("file 图源无对应物：丢弃且留痕", r.notes.some((n) => /file/.test(n)), r.notes);
ok("thinking.signature 不回投：留痕", r.notes.some((n) => /signature/.test(n)), r.notes);
ok("tools 转 OpenAI 嵌套形态", r.body.tools[0].type === "function" && r.body.tools[0].function.name === "Read", r.body.tools);
ok("Anthropic 非法工具名留痕", r.notes.some((n) => /工具名/.test(n)), r.notes);
ok("tool_choice any → required", r.body.tool_choice === "required", r.body.tool_choice);

console.log("\n网关 Key 读取（x-api-key 与 Bearer）:");
ok("x-api-key 优先", ain.readKey({ headers: { "x-api-key": "sk-a", authorization: "Bearer sk-a" } }).key === "sk-a");
ok("只有 Bearer 也能读", ain.readKey({ headers: { authorization: "Bearer sk-b" } }).key === "sk-b");
ok("两者不等价时明确报错（不静默挑一个）", /两把不同/.test(ain.readKey({ headers: { "x-api-key": "sk-a", authorization: "Bearer sk-z" } }).error || ""));

console.log("\ncount_tokens:");
const ct = ain.countTokens({ model: "m", max_tokens: 10, messages: [{ role: "user", content: "x".repeat(400) }] });
ok("返回 input_tokens 且随文本变长而变大", ct.input_tokens >= 100, ct);

// ===== 端到端：客户端说 Messages，上游是 OpenAI 兼容中转站 =====
function fakeUpstream() {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const b = JSON.parse(raw || "{}");
      seen.push({ auth: String(req.headers.authorization || ""), model: b.model });
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
          ch({ tool_calls: [{ index: 0, id: "call_9", function: { name: "Read", arguments: "" } }] }, null) +
          ch({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }, null) +
          ch({ tool_calls: [{ index: 0, function: { arguments: '"/x"}' } }] }, "tool_calls") +
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

/** 解析 SSE：返回 [{event, data}]（Messages 协议每个事件都带 event: 行） */
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

function post(pathName, body, key, headers) {
  return new Promise((resolve, reject) => {
    const h = { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01", ...(headers || {}) };
    if (h["x-api-key"] === undefined) delete h["x-api-key"];
    const req = http.request(
      { host: "127.0.0.1", port: GW, path: pathName, method: "POST", headers: h },
      (res) => {
        let t = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (t += c));
        res.on("end", () => resolve({ status: res.statusCode, text: t, ctype: res.headers["content-type"] }));
      }
    );
    // 超时是闸自己的基础设施：网关若在某条路径上不再回应，必须让它报错变红，
    // 而不是把整条闸挂在那里等人去 kill（非流式 Messages 就是这么被发现的）
    req.setTimeout(15000, () => req.destroy(new Error(`请求 ${pathName} 15s 无响应`)));
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

const client = (model, extra) => Object.assign({ model, max_tokens: 512, stream: true, messages: [{ role: "user", content: "hi" }] }, extra);

(async () => {
  const { srv, seen } = await fakeUpstream();
  provider.create({ id: "rel", baseUrl: `http://127.0.0.1:${UP}/v1`, display: "假中转", models: ["claude-sonnet-4-5", "tooly", "trunc"] });
  provider.addKey("rel", { name: "限速的", key: "sk-bad" });
  provider.addKey("rel", { name: "好的", key: "sk-good" });
  store.open();
  const gwKey = store.createKey({ name: "anthropic-e2e", route: "auto" });
  const sr = await server.start(() => ({
    port: GW, bind: "127.0.0.1", rateLimitPerMin: 0, concurrency: 8, routeStrategy: "smart",
    fixedChannel: "trae", modelOverrides: {}, debugStatus: false, humanizeJitter: false,
  }));
  ok("网关在测试端口起来", sr.ok === true && sr.port === GW, sr);

  const res1 = await post("/v1/messages", client("rel/claude-sonnet-4-5"), gwKey.secret);
  const f1 = parseSse(res1.text);
  ok("流式 200 + SSE 内容类型", res1.status === 200 && /text\/event-stream/.test(res1.ctype || ""), [res1.status, res1.ctype]);
  ok("事件顺序：start→block起→thinking→text→block止→delta→stop", JSON.stringify(types(f1)) === JSON.stringify([
    "message_start", "content_block_start", "content_block_delta", "content_block_stop",
    "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
    "message_delta", "message_stop",
  ]), types(f1));
  const thinkingFrame = f1.find((f) => f.data.delta && f.data.delta.type === "thinking_delta");
  const textFrames = f1.filter((f) => f.data.delta && f.data.delta.type === "text_delta");
  ok("思考链独立成块且内容正确", thinkingFrame && thinkingFrame.data.delta.thinking.includes("先想想"), thinkingFrame);
  ok("正文两帧增量按序送达、不丢字", textFrames.map((f) => f.data.delta.text).join("") === "你好，世界", textFrames.map((f) => f.data.delta.text));
  const startMsg = f1[0].data.message;
  ok("message_start 带 id/role/model 且 stop_reason 为 null", /^msg_/.test(startMsg.id) && startMsg.role === "assistant" && startMsg.model === "rel/claude-sonnet-4-5" && startMsg.stop_reason === null, startMsg);
  const md = f1[f1.length - 2].data;
  ok("message_delta 收 stop_reason=end_turn 且带 output_tokens", md.delta.stop_reason === "end_turn" && md.usage.output_tokens === 22, md);
  ok("块 index 连续从 0 开始", f1.filter((f) => f.data.type === "content_block_start").map((f) => f.data.index).join(",") === "0,1", f1.filter((f) => f.data.type === "content_block_start"));
  ok("首帧延迟期内只发了一个 message_start", types(f1).filter((t) => t === "message_start").length === 1, types(f1));
  ok("换号（第一把 Key 429）后仍不出现第二个 message_start", seen.length >= 2 && types(f1).filter((t) => t === "message_start").length === 1, seen);
  ok("上游收到的是去掉前缀的模型名", seen[0].model === "claude-sonnet-4-5", seen[0]);

  const res2 = await post("/v1/messages", client("rel/tooly"), gwKey.secret);
  const f2 = parseSse(res2.text);
  const toolStart = f2.find((f) => f.data.content_block && f.data.content_block.type === "tool_use");
  const pj = f2.filter((f) => f.data.delta && f.data.delta.type === "input_json_delta").map((f) => f.data.delta.partial_json).join("");
  ok("tool_use 块带 id 与 name", toolStart && toolStart.data.content_block.id === "call_9" && toolStart.data.content_block.name === "Read", toolStart);
  ok("arguments 以 partial_json 增量拼回", pj === '{"path":"/x"}', pj);
  ok("一个 tool_call 恰好三个事件", types(f2).filter((t) => t === "content_block_start").length === 1 && types(f2).filter((t) => t === "content_block_stop").length === 1, types(f2));
  ok("finish_reason=tool_calls → stop_reason=tool_use", f2[f2.length - 2].data.delta.stop_reason === "tool_use", f2[f2.length - 2].data);

  const res3 = await post("/v1/messages", client("rel/trunc"), gwKey.secret);
  ok("finish_reason=length → stop_reason=max_tokens", parseSse(res3.text)[parseSse(res3.text).length - 2].data.delta.stop_reason === "max_tokens", types(parseSse(res3.text)));

  const res4 = await post("/v1/messages", client("rel/claude-sonnet-4-5", { stream: false }), gwKey.secret);
  const j4 = JSON.parse(res4.text);
  ok("非流式回 Messages 对象（含 content 块与 stop_reason）", j4.type === "message" && j4.content.some((b) => b.type === "text" && b.text === "你好，世界") && j4.stop_reason === "end_turn", j4);
  ok("非流式 usage 用上游真值", j4.usage.output_tokens === 22, j4.usage);

  const res5 = await post("/v1/messages", { model: "rel/claude-sonnet-4-5", messages: [] }, gwKey.secret);
  ok("归一失败按 Anthropic 错误形状回 400", res5.status === 400 && JSON.parse(res5.text).error.type === "invalid_request_error", res5.text);
  const res6 = await post("/v1/messages", client("rel/claude-sonnet-4-5"), "sk-wrong-key");
  ok("鉴权失败也是 Anthropic 形状（不是 OpenAI 的 400 外壳）", res6.status === 401 && JSON.parse(res6.text).type === "error", res6.text);
  const res7 = await post("/v1/messages", client("rel/claude-sonnet-4-5"), gwKey.secret, { "x-api-key": undefined, authorization: "Bearer " + gwKey.secret });
  ok("Bearer 兜底可用", res7.status === 200, res7.status);

  const models = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: GW, path: "/v1/models?limit=1000", headers: { "anthropic-version": "2023-06-01" } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(t) }));
    });
  });
  ok("带 anthropic-version 时按 Messages 形状回", models.json.data[0] && models.json.data[0].type === "model" && "display_name" in models.json.data[0], models.json.data[0]);
  ok("有 has_more/first_id/last_id 分页字段", models.json.has_more === false && "first_id" in models.json, Object.keys(models.json));
  ok("绝不 3xx（Claude Code 把重定向判失败）", models.status === 200, models.status);
  const slash = await new Promise((resolve) => {
    http.get({ host: "127.0.0.1", port: GW, path: "/v1/models/" }, (res) => { res.resume(); resolve(res.statusCode); });
  });
  ok("尾斜杠路径也 200（不靠重定向）", slash === 200, slash);
  const ct = await post("/v1/messages/count_tokens", { model: "m", max_tokens: 10, messages: [{ role: "user", content: "abc" }] }, gwKey.secret);
  ok("count_tokens 端点可用", ct.status === 200 && JSON.parse(ct.text).input_tokens >= 1, ct.text);

  srv.close();
  server.stop();
  store.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n闸自身异常:", e);
  process.exit(1);
});
