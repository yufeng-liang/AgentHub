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

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
