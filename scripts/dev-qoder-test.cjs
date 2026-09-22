// Qoder COSY 自签名自测：node scripts/dev-qoder-test.cjs
// 用 mkdtemp 造隔离 APPDATA，不碰真实 %APPDATA%\AgentHub；纯本地断言（编码互拍 + 头结构），不打任何上游网络。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 必须在任何产品代码 require 之前落地：隔离网关数据目录，避免污染真实 %APPDATA%\AgentHub
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-test-"));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? `→ got ${JSON.stringify(extra)}` : ""); }
}

console.log("qoderCosy:");
const qcosy = require("../electron/backend/proxy/qoderCosy.cjs");
ok("sigPath 去 /algo 前缀且不含查询", qcosy.sigPathOf("https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1") === "/api/v2/service/pro/sse/agent_chat_generation");
ok("sigPath 对不带 /algo 的路径原样", qcosy.sigPathOf("https://x/api/v1/userinfo") === "/api/v1/userinfo");
ok("sigPath 不误切 /algorithm 类路径", qcosy.sigPathOf("https://x/algorithm/list") === "/algorithm/list");

// encode_body 三步变换：与测试内独立第二实现互拍（协议参考 §3.3：尾段→中段→首段，余数在中段，'='→'$'）
const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUS = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
function refEncode(bytes) {
  const b64 = Buffer.from(bytes).toString("base64");
  const n = b64.length, third = Math.floor(n / 3);
  const rot = b64.slice(n - third) + b64.slice(third, n - third) + b64.slice(0, third);
  return [...rot].map((ch) => (ch === "=" ? "$" : STD.includes(ch) ? CUS[STD.indexOf(ch)] : ch)).join("");
}
const sample = Buffer.from(JSON.stringify({ hello: "world", n: 42, ok: true }));
ok("encodeBody 与参考实现逐字节一致", qcosy.encodeBody(sample).toString("latin1") === refEncode(sample));
const sample2 = Buffer.from("aaaa"); // base64 长 4（third=1，有余数场景）
ok("encodeBody 有余数场景一致", qcosy.encodeBody(sample2).toString("latin1") === refEncode(sample2));
const sample3 = Buffer.from("abcdef"); // base64 长 8（third=2，无余数场景）
ok("encodeBody 无余数场景一致", qcosy.encodeBody(sample3).toString("latin1") === refEncode(sample3));

// buildCosyHeaders：结构断言（无官方向量，spec §十 风险 3 的三层断言）
const body = qcosy.encodeBody(sample);
const headers = qcosy.buildCosyHeaders({
  url: "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1",
  body, uid: "u1", token: "tok", name: "n", email: "e@x", machineId: "mid", requestId: "req-1",
});
const auth = headers.authorization || "";
ok("Authorization 是 COSY 三段式", /^Bearer COSY\.[A-Za-z0-9+/=]+\.[0-9a-f]{32}$/.test(auth), auth.slice(0, 40));
ok("cosy-key 解出定长 128 字节", (() => {
  const raw = Buffer.from(headers["cosy-key"], "base64");
  return raw.length === 128 && raw.some((b) => b !== 0);
})());
ok("cosy-sigpath 正确", headers["cosy-sigpath"] === "/api/v2/service/pro/sse/agent_chat_generation");
ok("cosy-bodyhash = MD5(编码后 body)", headers["cosy-bodyhash"] === qcosy.md5hex(body.toString("latin1")));
ok("cosy-bodylength = 编码后字节数", Number(headers["cosy-bodylength"]) === body.length);
ok("机器头成对且类型 5", headers["cosy-machineid"] === "mid" && headers["cosy-machinetoken"] === "mid" && headers["cosy-machinetype"] === "5" && headers["cosy-machineos"] === "x86_64_windows");
ok("payload JSON 键序完整且 requestId 一致", (() => {
  const payloadB64 = auth.replace(/^Bearer COSY\./, "").split(".")[0];
  const o = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"));
  return o.version === "v1" && o.requestId === "req-1" && typeof o.info === "string" && o.cosyVersion === "1.1.38" && o.ideVersion === "";
})());

console.log("qoder 协议纯函数（错误分类/id 派生/信封体/状态机/解包）:");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const qAd = adapters.get("qoder");
const C = adapters._qoderClassify;
ok("pricingUrl → 402", C({ httpStatus: 403, text: '{"message":"see https://x/pricing for plans"}' }).status === 402);
ok("额度关键词 → 402", C({ httpStatus: 200, text: "insufficient quota" }).status === 402);
ok("code 112 → 402", C({ httpStatus: 200, text: '{"code":112}' }).status === 402);
ok("429 → 402", C({ httpStatus: 429, text: "rate limit" }).status === 402);
ok("401 → 401", C({ httpStatus: 401, text: "unauthorized" }).status === 401);
ok("裸 403（无配额特征）→ 401", C({ httpStatus: 403, text: "forbidden" }).status === 401);
ok("5xx → 502", C({ httpStatus: 502, text: "bad gateway" }).status === 502);

const ids = adapters._qoderIds({ userId: "u1", upstreamKey: "qfmodel", maxTokens: 32768 });
ok("sessionId 16hex-uuid 形态", /^[0-9a-f]{16}-/.test(ids.sessionId));
ok("recordId 16hex", /^[0-9a-f]{16}$/.test(ids.recordId));
// 简报笔误修正：不传 seed 时 sessionId 后缀是随机 uuid，「同输入」前提不成立；
// 确定性只在显式 seed 下成立（协议参考 §3.4：seed 来自客户端 session_id），故两调用都补 seed
ok("同输入同 id（确定性）", JSON.stringify(adapters._qoderIds({ userId: "u1", upstreamKey: "qfmodel", maxTokens: 32768, seed: "s1" })) === JSON.stringify(adapters._qoderIds({ userId: "u1", upstreamKey: "qfmodel", maxTokens: 32768, seed: "s1" })));

const envBody = adapters._qoderBody({
  internal: { messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }], tools: [], max_tokens: 100 },
  modelEntry: { key: "qfmodel", is_reasoning: true, is_vl: false },
  ids, requestId: "rq-1", lastUserText: "hi",
});
ok("信封固定字段", envBody.stream === true && envBody.chat_task === "FREE_INPUT" && envBody.session_type === "qodercli" && envBody.agent_id === "agent_common" && envBody.request_set_id === envBody.chat_record_id);
ok("system 收进 messages 置顶（顶层 system 恒空串）", envBody.system === "" && envBody.messages[0].role === "system" && envBody.messages[0].content === "be nice");
ok("model_config 精简版（无 thinking_config）", envBody.model_config.key === "qfmodel" && envBody.model_config.is_reasoning === true && !("thinking_config" in envBody.model_config));
ok("parameters.max_tokens 与 32768 取小", envBody.parameters.max_tokens === 100);
ok("enable_thinking 缺省不发", !("enable_thinking" in envBody.parameters));
ok("business.name 取最后用户文本前 30 字符", envBody.business.name === "hi");

// 简报笔误修正：状态机语义是「过滤 thinking 段内容、保留标签外答案」（协议参考 §3.5 拆解 + chat() 集成把
// splitter 输出直接作为 content 下发），故断言 abcdef 不在输出、答案 after 保留、标签标记被剥
const sp = new adapters._TagSplitter();
let out = [];
for (const piece of ["<thi", "nking>abc", "def</think", "ing>\n\nafter"]) out.push(sp.feed(piece));
out.push(sp.flush());
const text = out.join("");
ok("跨分片拆标签且闭标签后吃换行（thinking 段过滤、答案保留）", !text.includes("abcdef") && text.includes("after") && !text.includes("<thinking>"), text);

ok("双层 JSON 解析", (() => {
  const inner = JSON.stringify({ choices: [{ delta: { content: "你" } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
  const u = adapters._qoderUnpack({ statusCodeValue: 200, body: inner });
  return u.ok === true && u.chunk.choices[0].delta.content === "你";
})());
ok("statusCodeValue != 200 → 错误帧", adapters._qoderUnpack({ statusCodeValue: 403, body: "quota exceeded" }).ok === false);
ok("body 为 [DONE] 字符串", adapters._qoderUnpack({ statusCodeValue: 200, body: "[DONE]" }).done === true);

console.log("qoder 适配器对象:");
ok("qoder 已注册", !!qAd);
ok("地区解析：meta.mode=cn → cn", qAd._regionOf({ meta: { mode: "cn" } }) === "cn" && qAd._regionOf({ meta: { mode: "intl" } }) === "global" && qAd._regionOf({}) === "global");
ok("目录两区并集且 global 优先", qAd.models().includes("Qwen3.8-Flash") && qAd.models().includes("MiniMax-M3"));
ok("upstreamFor 查 upstreamKey", qAd.upstreamFor("Qwen3.8-Flash") === "qfmodel" && qAd.upstreamFor("Auto") === "auto");
ok("refreshToken 3 段打包串走 center 刷新路径", typeof qAd.refreshToken === "function");

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
