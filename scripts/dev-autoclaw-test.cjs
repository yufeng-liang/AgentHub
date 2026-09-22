// AutoClaw 凭证解密链自测：node scripts/dev-autoclaw-test.cjs
// APPDATA 隔离必须先于任何产品代码 require（proxy 模块可能在加载期解析数据目录）；
// 纯本地断言，不打任何上游网络。
"use strict";
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const APPDATA_TMP = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaw-test-"));
process.env.APPDATA = APPDATA_TMP;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? `→ got ${JSON.stringify(extra)}` : ""); }
}

console.log("autoclawCredentials:");
const crypto = require("node:crypto");
const ac = require("../electron/backend/proxy/autoclawCredentials.cjs");
ok("stripBearer 大小写不敏感", ac.stripBearer("Bearer abc") === "abc" && ac.stripBearer("bearer abc") === "abc" && ac.stripBearer("abc") === "abc");

// DPAPI 探针（koffi 纯 node 可用）。若声明签名与 koffi 版本 API 不符，此步失败并给出真实错误：
// 按 sqlcipher.cjs:40-44 的既有用法与 koffi 官方文档修正声明再继续——不许跳过、不许 mock。
const key = crypto.randomBytes(32);
const sealed = ac.dpapiProtect(key);
ok("DPAPI round-trip", ac.dpapiUnprotect(sealed).equals(key));

// 全链夹具：os_crypt key 用 DPAPI 包进 Local State；auth.json 的 enc: 字段手工 AES-256-GCM
const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaw-home-"));
const aesKey = crypto.randomBytes(32);
fs.writeFileSync(path.join(fakeDir, "Local State"), JSON.stringify({
  os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), ac.dpapiProtect(aesKey)]).toString("base64") },
}));
function encValue(plain) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", aesKey, nonce);
  const ct = Buffer.concat([c.update(Buffer.from(plain, "utf8")), c.final(), c.getAuthTag()]);
  return "enc:" + Buffer.concat([Buffer.from("v10"), nonce, ct]).toString("base64");
}
fs.writeFileSync(path.join(fakeDir, "auth.json"), JSON.stringify({
  deviceId: "dev-1", token: encValue("Bearer eyJtok"), refreshToken: encValue("rt-plain"), userInfo: {},
}));
// 夹具补丁：readAutoClawAuth 按 §2.7 真实布局读 %APPDATA%\AutoClaw\{auth.json, Local State}，
// 而下方 parseAuthFile/osCryptKey 逐字断言直读 fakeDir 根，故根部夹具保留一份、再复制一份进 AutoClaw/ 子目录
fs.mkdirSync(path.join(fakeDir, "AutoClaw"));
fs.copyFileSync(path.join(fakeDir, "auth.json"), path.join(fakeDir, "AutoClaw", "auth.json"));
fs.copyFileSync(path.join(fakeDir, "Local State"), path.join(fakeDir, "AutoClaw", "Local State"));
const parsed = ac.parseAuthFile(JSON.parse(fs.readFileSync(path.join(fakeDir, "auth.json"), "utf8")), ac.osCryptKey(fakeDir));
ok("token 解出并剥 Bearer", parsed.token === "eyJtok", parsed.token);
ok("refreshToken 解出", parsed.refreshToken === "rt-plain", parsed.refreshToken);
ok("deviceId 透出", parsed.deviceId === "dev-1");
ok("readAutoClawAuth 全链（APPDATA 指向夹具）", (() => {
  process.env.APPDATA = fakeDir;
  const r = ac.readAutoClawAuth();
  return !!r && r.token === "eyJtok" && r.deviceId === "dev-1";
})());
process.env.APPDATA = APPDATA_TMP; // 测完恢复（后续测试段沿用头部隔离目录）
ok("坏 enc: 报中文错（版本或解密）", (() => {
  try { ac.decryptEncValue("enc:!!!", ac.osCryptKey(fakeDir)); return false; }
  catch (e) { return /解密|版本|长度/.test(e.message); }
})());

console.log("autoclawPrompt:");
const ap = require("../electron/backend/proxy/autoclawPrompt.cjs");
ok("身份句逐字", ap.IDENTITY_LINE === "You are a personal assistant running inside OpenClaw.");
ok("前缀含 Tooling 段", ap.IDENTITY_PREFIX.includes("## Tooling"));

const b1 = { messages: [{ role: "user", content: "hi" }] };
ap.normalizeSystemPrompt(b1);
ok("无 system 时插一条只带前缀的", b1.messages[0].role === "system" && b1.messages[0].content.startsWith(ap.IDENTITY_LINE));

const b2 = { messages: [{ role: "system", content: "You are Claude Code, Anthropic's official CLI tool for Claude." }, { role: "user", content: "hi" }] };
ap.normalizeSystemPrompt(b2);
ok("外来身份句改写", !b2.messages[0].content.includes("Claude Code") && b2.messages[0].content.includes("You are a coding assistant"));
ok("前缀在前、客户端提示词逐字保留在后", b2.messages[0].content.indexOf(ap.IDENTITY_LINE) === 0 && b2.messages[0].content.endsWith("official CLI tool for Claude."));
ok("messages 数量不变", b2.messages.length === 2);

const b3 = { messages: [{ role: "system", content: ap.IDENTITY_PREFIX + "custom prompt" }] };
ap.normalizeSystemPrompt(b3);
ap.normalizeSystemPrompt(b3);
ok("幂等（重复归一只有一份前缀）", (b3.messages[0].content.match(/running inside OpenClaw/g) || []).length === 1 && b3.messages[0].content.includes("custom prompt"));

const b4 = { messages: [{ role: "system", content: [{ type: "text", text: "You are ZCode, an interactive coding agent" }, { type: "text", text: "more" }] }] };
ap.normalizeSystemPrompt(b4);
ok("数组 content 拼第一个文本 part 且 ZCode 改写", b4.messages[0].content[0].text.startsWith(ap.IDENTITY_LINE) && !b4.messages[0].content[0].text.includes("ZCode"));

const b5 = { messages: [{ role: "user", content: "You are Claude Code" }] };
ap.normalizeSystemPrompt(b5);
// 简报笔误修正：无 system 时 unshift 一条 system 在 messages[0]（b1 已断言该行为），
// 原 user 消息落到 messages[1]，「不动」指其 content 逐字保留
ok("user 消息不动", b5.messages[0].role === "system" && b5.messages[1].content === "You are Claude Code");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
