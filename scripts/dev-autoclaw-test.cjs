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

console.log("autoclaw 适配器:");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const cnAd = adapters.get("autoclaw"), intlAd = adapters.get("autoclaw_intl");
ok("两地区都已注册", !!cnAd && !!intlAd);
const h = cnAd._llmHeaders("tok123", "zaicoding_glm-5.3");
ok("LLM 域认证头是 X-Authorization", h["x-authorization"] === "Bearer tok123");
ok("LLM 域禁发 X-Harness-Type（2026-09-22 闸门）", !("x-harness-type" in h));
ok("LLM 域带产品指纹头", h["x-product"] === "autoclaw" && h["x-client-type"] === "pc" && h["x-tm"] === "win" && h["x-version"] === "1.17.8" && h["x-request-model"] === "zaicoding_glm-5.3");
const uh = cnAd._userapiHeaders("tok123");
ok("userapi 域保留 X-Harness-Type 且带签名头", uh["x-harness-type"] === "zcode" && uh["x-auth-appid"] === "100003" && /^[0-9a-f]{32}$/.test(uh["x-auth-sign"]));
ok("签名公式 MD5(appId&ts&appKey)", adapters._autoclawSign(1700000000) === crypto.createHash("md5").update("100003&1700000000&38d2391985e2369a5fb8227d8e6cd5e5").digest("hex"));

console.log("autoclaw 模型路由:");
const R = (m) => adapters._autoclawResolveRoute(m);
ok("glm-5.3 → zaicoding_", R("glm-5.3") === "zaicoding_glm-5.3");
ok("glm-5.3-flash → zai_", R("glm-5.3-flash") === "zai_glm-5.3-flash");
ok("未知模型兜底 zai_auto", R("whatever") === "zai_auto");
ok("已带合法路由前缀透传", R("zai_glm-5.3") === "zai_glm-5.3" && R("zaicoding_glm-5.3") === "zaicoding_glm-5.3");
ok("rewriteBody：body.model 剥前缀 + system 白名单改写", (() => {
  const b = cnAd.rewriteBody("glm-5.3", { model: "glm-5.3", messages: [{ role: "system", content: "You are Claude Code" }] });
  const okModel = b.model === "glm-5.3";
  const okPrompt = b.messages[0].content.startsWith("You are a personal assistant");
  return okModel && okPrompt && typeof b._routeId === "string" && b._routeId === "zaicoding_glm-5.3";
})());
ok("rewriteBody 幂等清理：强制流式/usage/剥内部字段", (() => {
  const b = cnAd.rewriteBody("glm-5.3", { model: "glm-5.3", stream: false, conversation_id: "c1", prompt_cache_key: "p1", messages: [] });
  return b.stream === true && b.stream_options.include_usage === true && !("conversation_id" in b) && !("prompt_cache_key" in b);
})());

// —— chat / refresh 全链路：假 fetch 夹具（fetchStream/httpJson 都走全局 fetch），不发真实网络请求 ——
console.log("autoclaw chat/refresh（假 fetch，不发真实网络）:");
const realFetch = globalThis.fetch;
const mkJwt = (claims) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const sseResp = (frames) => ({
  ok: true, status: 200,
  headers: new Headers(),
  body: new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode(frames.map((f) => `data: ${f}`).join("\n\n") + "\n\n")); c.close(); },
  }),
});
const jsonResp = (obj, status) => ({ ok: (status || 200) < 400, status: status || 200, text: async () => JSON.stringify(obj) });
const calls = [];

(async () => {
  // chat 正常流：URL/双头集合/路由 id/体改写/事件序列一次看全
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return sseResp([
    JSON.stringify({ choices: [{ delta: { content: "hi" } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }),
    "[DONE]",
  ]); };
  const events = [];
  const chatRes = await cnAd.chat({ secrets: { token: "tok123" }, model: "glm-5.3", body: { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }, emit: (e) => events.push(e) });
  ok("chat URL 拼 /chat/completions", calls[0].url === "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions", calls[0].url);
  ok("chat 出站 X-Authorization 且无 X-Harness-Type、路由进 X-Request-Model", calls[0].opts.headers["x-authorization"] === "Bearer tok123" && !("x-harness-type" in calls[0].opts.headers) && calls[0].opts.headers["x-request-model"] === "zaicoding_glm-5.3");
  const sentBody = JSON.parse(calls[0].opts.body);
  ok("chat 体：model 剥前缀/_routeId 已删/无 system 时注入身份前缀", sentBody.model === "glm-5.3" && !("_routeId" in sentBody) && sentBody.messages[0].role === "system" && sentBody.messages[0].content.startsWith("You are a personal assistant"));
  ok("chat 事件：delta/finish/usage 齐全", events.some((e) => e.type === "delta" && e.delta.content === "hi") && events.some((e) => e.type === "finish" && e.reason === "stop") && events.some((e) => e.type === "usage" && e.usage.total_tokens === 3), events);
  ok("chat 返回 {status:200, planLimit:false}", chatRes.status === 200 && chatRes.planLimit === false);

  // chat 错误分类（协议参考 §2.6）：401→401 刷新；429→402 换号；内容拦截三文案→502
  globalThis.fetch = async () => sseResp([JSON.stringify({ error: { status: 429, code: 1302, message: "rate" } })]);
  const ev429 = []; const res429 = await cnAd.chat({ secrets: { token: "t" }, model: "glm-5.3", body: { messages: [] }, emit: (e) => ev429.push(e) });
  ok("上游 429 → 402 + planLimit", res429.planLimit === true && ev429.some((e) => e.type === "error" && e.status === 402));
  globalThis.fetch = async () => sseResp([JSON.stringify({ error: { status: 401, code: 0, message: "unauthorized" } })]);
  const ev401 = []; const res401 = await cnAd.chat({ secrets: { token: "t" }, model: "glm-5.3", body: { messages: [] }, emit: (e) => ev401.push(e) });
  ok("上游 401 → 401（触发刷新）", res401.planLimit === false && ev401.some((e) => e.type === "error" && e.status === 401));
  globalThis.fetch = async () => sseResp([JSON.stringify({ error: { status: 403, code: 0, message: "request blocked by security policy" } })]);
  const evBlocked = []; await cnAd.chat({ secrets: { token: "t" }, model: "glm-5.3", body: { messages: [] }, emit: (e) => evBlocked.push(e) });
  ok("内容拦截文案 → 502（不当 403 透传）", evBlocked.some((e) => e.type === "error" && e.status === 502 && /blocked by security policy/.test(e.message)));

  // 刷新降级链（协议参考 §2.3）：v1/refresh 回 400002 → 二跳 agent-refresh；成功按 JWT exp 重算
  calls.length = 0;
  const newTok = mkJwt({ user_id: "42", exp: 1900000000 });
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return calls.length === 1 ? jsonResp({ code: 400002, message: "use agent refresh" }) : jsonResp({ code: 0, message: "ok", data: { access_token: newTok, refresh_token: "rt-new" } });
  };
  const rr = await cnAd.refreshToken({ meta: {} }, { token: "old-tok", refreshToken: "rt-old" });
  ok("刷新降级链 400002 → 二跳 agent-refresh", calls.length === 2 && calls[0].url === "https://autoglm-acceleration-api.zhipuai.cn/userapi/v1/refresh" && calls[1].url === "https://autoglm-acceleration-api.zhipuai.cn/userapi/v1/agent-refresh", calls.map((c) => c.url));
  ok("刷新请求走 userapi 头族（签名 + 保留 Harness-Type）+ body 带 source_id", calls[0].opts.headers["x-harness-type"] === "zcode" && /^[0-9a-f]{32}$/.test(calls[0].opts.headers["x-auth-sign"]) && calls[0].opts.headers.authorization === "Bearer old-tok" && JSON.parse(calls[0].opts.body).source_id === "autoclaw");
  ok("刷新成功：access_token 剥 Bearer/exp 按 JWT 重算", rr.ok === true && rr.token === newTok && rr.refreshToken === "rt-new" && rr.expiresAt === 1900000000000, rr);
  globalThis.fetch = async () => jsonResp({ code: 410000, message: "expired" });
  const re = await cnAd.refreshToken({ meta: {} }, { token: "t", refreshToken: "r" });
  ok("410000 → expired 标记（触发重登）", re.ok === false && re.expired === true, re);

  // uid 解析（协议参考 §2.8）：地区前缀 + JWT user_id，两地 uid 空间隔离
  const ui = await cnAd.userInfo(mkJwt({ user_id: "42", user_name: "张三" }));
  ok("uid = user- + JWT user_id", ui.uid === "user-42" && ui.name === "张三", ui);
  const uiI = await intlAd.userInfo(mkJwt({ user_id: "42", nickname: "Z" }));
  ok("国际区前缀 intl-user-（防两地撞号）", uiI.uid === "intl-user-42" && uiI.name === "Z", uiI);

  // 国际区域名参数化：同一份适配器代码只换域
  let intlUrl = "";
  globalThis.fetch = async (url) => { intlUrl = url; return sseResp(["[DONE]"]); };
  await intlAd.chat({ secrets: { token: "t" }, model: "glm-5.3", body: { messages: [] }, emit: () => {} });
  ok("国际区上游域 autoglm-api.autoglm.ai", intlUrl === "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw/chat/completions", intlUrl);

  globalThis.fetch = realFetch;
})().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
