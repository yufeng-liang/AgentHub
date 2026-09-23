// AutoClaw 自测：node scripts/dev-autoclaw-test.cjs
// 覆盖凭证解密链（国内 auth.json）、提示词归一、适配器路由/刷新、扫描门禁，
// 以及国际版网页 OAuth 全链（滑块参数透传 + 回环回调 + 双 state 换码，Task 12）。
// APPDATA 隔离必须先于任何产品代码 require（proxy 模块可能在加载期解析数据目录）；
// 上游一律假 fetch、回环一律假 server、超时一律假时钟，不打任何真实网络、不起真端口。
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

console.log("scanAutoClaw:");
const discovery = require("../electron/backend/proxy/discovery.cjs");
// 本机真实 ~/.openclaw-autoclaw/openclaw.json（含 X-Authorization）与 ~/.box-agent/config/auth.json
// 会漏进扫描结果——扫描期间把 homedir 指到空目录隔离（与 APPDATA 夹具同一思路），测完恢复
const scanHome = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaw-scan-home-"));
const realHomeFn = os.homedir;
os.homedir = () => scanHome;
process.env.APPDATA = fakeDir;
const acands = discovery.scanAll().filter((c) => c.channel === "autoclaw");
ok("扫描出 autoclaw 候选（仅国内渠道）", acands.length === 1 && acands[0].token === "eyJtok" && acands[0].meta.device_id === "dev-1", acands[0]);
ok("intl 渠道不产生 auth.json 候选（地区门禁，参考项目同款）", discovery.scanAll().some((c) => c.channel === "autoclaw_intl") === false);
os.homedir = realHomeFn;
process.env.APPDATA = APPDATA_TMP; // 测完恢复（与上方 readAutoClawAuth 段同一约定）

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

  console.log("autoclaw intl 回调解析（双 state 陷阱）:");
  const P = discovery._autoclawParseCallback;
  const parsed = P("/aclaw-cb/zai/state-abc", "?code=cd-1&state=upstream-state-9");
  ok("路径里是我们发起的任务 state", parsed.taskState === "state-abc" && parsed.vendor === "zai");
  ok("查询串里才是上游回的 state（换码必须用它）", parsed.upstreamState === "upstream-state-9");
  ok("code 透出", parsed.code === "cd-1");
  ok("用户拒绝带 error", P("/aclaw-cb/zai/s", "?error=access_denied").error === "access_denied");
  ok("非本前缀的路径拆不出 vendor/taskState（回调只认 /aclaw-cb/）", (() => {
    const x = P("/authorize", "?code=c&state=s");
    return x.vendor === "" && x.taskState === "" && x.code === "c" && x.upstreamState === "s";
  })());
  ok("缺查询串也不炸", (() => { const x = P("/aclaw-cb/google/st", ""); return x.code === "" && x.upstreamState === "" && x.error === ""; })());

  // ===== Task 12：滑块参数透传 + 回环回调 + 双 state 换码 =====
  // 夹具三件套：假 fetch（上游）、假 server（http.createServer 不起真端口）、假时钟（超时/轮询一秒不等）。
  // 回调不是靠真浏览器 302 打进来，而是直接调用捕获到的 requestListener——不发任何真实网络。
  console.log("autoclaw intl OAuth（假 fetch + 假 server + 假时钟）:");
  const http = require("node:http");
  const store = require("../electron/backend/proxy/store.cjs");
  const FAKE_PORT = 55999;
  const realCreateServer = http.createServer;
  const realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
  let timers = [], timerSeq = 0;
  global.setTimeout = (fn, ms) => { const t = { id: ++timerSeq, fn, ms }; timers.push(t); return t.id; };
  global.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
  const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => realSetTimeout(r, 0)); }; // 真实事件循环排干 Promise 链（假时钟里那些定时器永远不响）
  const fireTimeout = async () => { const t = timers.find((x) => x.ms === 360000); if (t) timers = timers.filter((x) => x !== t); if (t) await t.fn(); };
  const timersLeft = () => timers.filter((t) => t.ms === 360000).length; // 只看本流程的 6 分钟兜底（httpJson 的 60s 超时在 finally 里已清）
  let listenFailures = 0; // >0 时假 server 的 listen 直接报错（回环端口监听失败路径）
  const servers = [];
  http.createServer = (handler) => {
    const s = {
      handler, closes: 0, _ev: {},
      once(ev, fn) { (this._ev[ev] = this._ev[ev] || []).push(fn); },
      removeListener() { /* 夹具不区分监听器身份 */ },
      listen() {
        if (listenFailures > 0) { listenFailures--; (this._ev.error || []).forEach((f) => f(new Error("listen EPERM"))); return; }
        (this._ev.listening || []).forEach((f) => f());
      },
      address() { return { address: "127.0.0.1", family: "IPv4", port: FAKE_PORT }; },
      close() { this.closes++; },
    };
    servers.push(s);
    return s;
  };
  const cur = () => servers[servers.length - 1];
  const hit = (url) => { const res = { statusCode: 200, body: "", end(c) { this.body = String(c || ""); } }; cur().handler({ url }, res); return res; };
  const cleanup = () => { discovery.cancelOAuth(); timers = []; };

  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const JWT_INTL = `eyJhbGciOiJIUzI1NiJ9.${b64u({ user_id: "42", user_name: "Zoe", exp: 1900000000 })}.sig`;
  const resp = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });
  const OAUTH_URL = "https://autoglm-api.autoglm.ai/oauth/login-page?lang=en";
  let seen = [], captchaResp = null, oauthUrlResp = null, loginResp = null;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    if (url.endsWith("/userapi/overseasv1/oauth-captcha-config")) return captchaResp;
    if (url.endsWith("-oauth-url")) return oauthUrlResp;
    if (url.endsWith("-oauth-login")) return loginResp;
    return resp(500, { error: "unexpected url" });
  };
  const beginIntl = (opts, onDone) => discovery.beginOAuth("autoclaw_intl", opts, onDone || (() => {}));

  // —— 第 0 步：滑块配置（第一次调用不带 captchaVerifyParam）——
  captchaResp = resp(200, { code: 0, message: "ok", data: { enabled: true, region: "cn-hangzhou", prefix: "1abcd2", scene_id: "18vhnjxl", captcha_supplier: "aliyun" } });
  seen = [];
  const rc = await beginIntl({});
  ok("首次调用回 needCaptcha + 归一后的滑块配置（region/prefix/sceneId/supplier）", rc.ok === true && rc.needCaptcha === true && rc.captcha.region === "cn-hangzhou" && rc.captcha.prefix === "1abcd2" && rc.captcha.sceneId === "18vhnjxl" && rc.captcha.supplier === "aliyun", rc);
  ok("captcha-config 请求逐字：POST {intl}/userapi/overseasv1/oauth-captcha-config 且 body 为空对象", seen.length === 1 && seen[0].url === "https://autoglm-api.autoglm.ai/userapi/overseasv1/oauth-captcha-config" && seen[0].opts.method === "POST" && seen[0].opts.body === "{}", seen[0]);
  ok("签名头族齐（appid/秒级时间戳/md5 sign/x-harness-type 保留）且未登录不带 authorization", (() => {
    const h = seen[0].opts.headers;
    return h["x-product"] === "autoclaw" && h["x-client-type"] === "pc" && h["x-harness-type"] === "zcode" && h["x-auth-appid"] === "100003"
      && /^\d{10}$/.test(h["x-auth-timestamp"]) && /^[0-9a-f]{32}$/.test(h["x-auth-sign"])
      && h["x-auth-sign"] === adapters._autoclawSign(Number(h["x-auth-timestamp"])) && !("authorization" in h);
  })(), seen[0] && seen[0].opts.headers);
  ok("滑块配置这一步不留会话（不占用单飞）", discovery.cancelOAuth() === false && servers.length === 0);
  ok("supplier 缺省兜底 aliyun", await (async () => {
    captchaResp = resp(200, { code: 0, data: { enabled: true, region: "cn", prefix: "p", scene_id: "s" } });
    const x = await beginIntl({});
    return x.ok === true && x.captcha.supplier === "aliyun";
  })());
  ok("enabled=false（国内版形态）→ 明确报未启用而非弹滑块", await (async () => {
    captchaResp = resp(200, { code: 0, data: { enabled: false, region: "", prefix: "", scene_id: "" } });
    const x = await beginIntl({});
    return x.ok === false && x.message === "上游滑块验证未启用（captcha-config enabled=false）";
  })());
  ok("captcha-config 上游 500 → 同一文案（不假装可以登录）", await (async () => {
    captchaResp = resp(500, { message: "boom" });
    const x = await beginIntl({});
    return x.ok === false && /未启用/.test(x.message);
  })());
  ok("captcha-config 网络异常 → 不抛（catch 成 ok:false）", await (async () => {
    captchaResp = { then() { throw new Error("net down"); } };
    const x = await beginIntl({});
    return x.ok === false && /未启用/.test(x.message);
  })());
  captchaResp = resp(200, { code: 0, data: { enabled: true, region: "cn", prefix: "p", scene_id: "s", captcha_supplier: "aliyun" } });

  // —— vendor 白名单（这一步在起回环服务之前，零网络零端口）——
  ok("vendor 只认 zai / google", await (async () => {
    seen = [];
    const a = await beginIntl({ vendor: "qq", captchaVerifyParam: "p" });
    const b = await beginIntl({ captchaVerifyParam: "p" });
    return a.ok === false && a.message === "vendor 只支持 zai / google" && b.message === "vendor 只支持 zai / google" && seen.length === 0 && servers.length === 0;
  })(), { seen: seen.length, servers: servers.length });

  // —— 第 1~3 步：回环回调全链（成功落库）——
  oauthUrlResp = resp(200, { code: 0, message: "ok", data: { oauth_url: OAUTH_URL } });
  loginResp = resp(200, { code: 0, message: "ok", data: { access_token: JWT_INTL, refresh_token: "rt-1", user_id: 42, user_name: "Zoe", first_login: false } });
  seen = [];
  let done = null;
  const rb = await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-1" }, (x) => { done = x; });
  const nav = JSON.parse(seen[0].opts.body).navigate_uri;
  const cbPath = new URL(nav).pathname;
  const taskState = cbPath.split("/").pop();
  ok("oauth-url 请求逐字：POST {intl}/userapi/overseasv1/zai-oauth-url + source_id/device_id/navigate_uri/ali_captcha_verify_param", seen.length === 1 && seen[0].url === "https://autoglm-api.autoglm.ai/userapi/overseasv1/zai-oauth-url" && seen[0].opts.method === "POST" && JSON.stringify(JSON.parse(seen[0].opts.body)) === JSON.stringify({ source_id: "autoclaw", device_id: JSON.parse(seen[0].opts.body).device_id, navigate_uri: nav, ali_captcha_verify_param: "CVP-1" }), seen[0]);
  ok("navigate_uri 指向回环 /aclaw-cb/{vendor}/{32hex taskState}（端口是 listen 实际端口）", nav === `http://127.0.0.1:${FAKE_PORT}/aclaw-cb/zai/${taskState}` && /^[0-9a-f]{32}$/.test(taskState), nav);
  ok("device_id 是 64hex（两跳同值由后面换码请求断言）", /^[0-9a-f]{64}$/.test(JSON.parse(seen[0].opts.body).device_id));
  ok("begin 返回 mode=callback + 上游 oauth_url（url 由主进程 openExternal）", rb.ok === true && rb.mode === "callback" && rb.url === OAUTH_URL, rb);
  ok("会话进行中拒绝第二次登录（单飞）", await beginIntl({}, () => {}).then(() => false, (e) => /已有进行中的登录/.test(e.message)));
  ok("回调流不接受粘贴回调地址（结果由回调页自动带回）", (await discovery.submitCallbackUrl(`http://127.0.0.1:${FAKE_PORT}${cbPath}?code=1&state=2`, "autoclaw_intl")).message === "AutoClaw 国际版登录由回调页自动完成，无需粘贴地址");
  ok("6 分钟超时兜底已排期（回调是唯一入口，没轮询可判放弃）", timersLeft() === 1);
  // 外来回调：路径 state 不是本次发起的 → 只拒本次请求，不杀会话
  const rBad = hit(`/aclaw-cb/zai/${"f".repeat(32)}?code=c&state=s`);
  ok("外来 taskState → 400 且会话继续等（不重演「登录后无法回调」）", rBad.statusCode === 400 && /回调校验不通过（非本次发起的授权回调）/.test(rBad.body) && await beginIntl({}, () => {}).then(() => false, (e) => /已有进行中的登录/.test(e.message)), rBad);
  const rProbe = hit(cbPath);
  ok("空参探测回调可达性 → 挂起页继续等待，会话不被杀", /正在等待授权结果/.test(rProbe.body) && !!cur() && cur().closes === 0, rProbe);
  const rHalf = hit(cbPath + "?code=only-code"); // 有 code 无 state：按失败收口
  ok("回调缺上游 state → 页面与 onDone 同时报「授权未完成」", rHalf.statusCode === 200 && /授权未完成：回调缺参数/.test(rHalf.body) && !!done && done.ok === false && done.message === "授权未完成：回调缺参数", { res: rHalf.body, done });
  ok("失败收尾后回环服务已关、会话已清空", cur().closes === 1 && discovery.cancelOAuth() === false && timersLeft() === 0);

  // 用户拒绝（带 error）
  seen = []; cleanup();
  done = null;
  await beginIntl({ vendor: "google", captchaVerifyParam: "CVP-2" }, (x) => { done = x; });
  const navG = JSON.parse(seen[0].opts.body).navigate_uri;
  const cbPathG = new URL(navG).pathname;
  const rDeny = hit(`${cbPathG}?error=access_denied&error_description=nope`);
  ok("用户在授权页拒绝 → 200 报错页 + onDone 透出 error", /授权未完成：access_denied/.test(rDeny.body) && !!done && done.ok === false && done.message === "授权未完成：access_denied", { body: rDeny.body, done });
  ok("google 渠道端点是 google-oauth-url", seen[0].url === "https://autoglm-api.autoglm.ai/userapi/overseasv1/google-oauth-url", seen[0].url);

  // 成功链：换码 → 落库
  seen = []; cleanup();
  done = null;
  await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-3" }, (x) => { done = x; });
  const navZ = JSON.parse(seen[0].opts.body).navigate_uri;
  const pathZ = new URL(navZ).pathname;
  const stateZ = pathZ.split("/").pop();
  const rOk = hit(`${pathZ}?code=cd-1&state=upstream-state-9`);
  await flush();
  ok("回调成功页逐字（协议参考 §3.2 ④）", rOk.statusCode === 200 && /登录成功，已返回网关，可以关闭此页面。/.test(rOk.body), rOk.body);
  const login = seen.find((s) => s.url.endsWith("-oauth-login"));
  ok("换码端点 second hop：zai-oauth-login", !!login && login.url === "https://autoglm-api.autoglm.ai/userapi/overseasv1/zai-oauth-login", login && login.url);
  ok("双 state 陷阱：换码用查询串里上游回的 state，不是路径里的任务 state", !!login && JSON.parse(login.opts.body).state === "upstream-state-9" && JSON.parse(login.opts.body).state !== stateZ, login && login.opts.body);
  ok("换码体逐字：source_id/device_id（与上一跳同值）/code/state/navigate_uri（与上一跳逐字相同）", !!login && JSON.stringify(JSON.parse(login.opts.body)) === JSON.stringify({ source_id: "autoclaw", device_id: JSON.parse(seen[0].opts.body).device_id, code: "cd-1", state: "upstream-state-9", navigate_uri: navZ }), login && login.opts.body);
  ok("onDone 成功：带 id 与 intl-user- uid（简报里 session.uid 恒空，改用换码结果）", !!done && done.ok === true && done.uid === "intl-user-42" && !!done.id, done);
  const intlRows = store.accountRows("autoclaw_intl");
  const intlView = store.listAccounts("autoclaw_intl"); // meta 只有 accountView 会反序列化，原始行里是 JSON 串
  const sec = intlRows.length ? store.accountSecrets(intlRows[0]) : {};
  ok("落库 autoclaw_intl：uid 前缀 intl-user-、展示名 user_name、token/refreshToken、expiresAt 按 JWT exp 秒→毫秒", intlRows.length === 1 && intlRows[0].uid === "intl-user-42" && intlRows[0].name === "Zoe" && sec.token === JWT_INTL && sec.refreshToken === "rt-1" && intlRows[0].expires_at === 1900000000000, intlRows[0] && { uid: intlRows[0].uid, name: intlRows[0].name, exp: intlRows[0].expires_at });
  ok("落库 meta.device_id = 本次 64hex（刷新要用）、source=oauth", intlView.length === 1 && intlView[0].meta.device_id === JSON.parse(seen[0].opts.body).device_id && intlView[0].source === "oauth", intlView[0] && intlView[0].meta);
  ok("成功后会话收口：关回环服务、清 timer、onDone 只回一次", !!cur() && cur().closes === 1 && discovery.cancelOAuth() === false && timersLeft() === 0);
  // 重复登录同 uid → 更新凭据不新建
  seen = []; cleanup();
  loginResp = resp(200, { code: 0, data: { access_token: `Bearer eyJh.${b64u({ user_id: 42, nickname: "Nick", exp: 1911111111 })}.sig`, refresh_token: "rt-2", user_id: 42 } });
  done = null;
  await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-4" }, (x) => { done = x; });
  const path4 = new URL(JSON.parse(seen[0].opts.body).navigate_uri).pathname;
  hit(`${path4}?code=cd-2&state=up-2`);
  await flush();
  const rows2 = store.accountRows("autoclaw_intl");
  // saveDiscoveredAccount 的更新分支只换凭据（与 importCandidate 同语义），展示名保留首登值；nickname 回落由下一条断言覆盖
  ok("同 uid 二次登录：更新凭据而不新建（Bearer 前缀剥掉、expiresAt 按新 JWT 重算、展示名保留首登值）", !!done && done.ok === true && rows2.length === 1 && rows2[0].id === intlRows[0].id && store.accountSecrets(rows2[0]).token.startsWith("eyJh.") && store.accountSecrets(rows2[0]).refreshToken === "rt-2" && rows2[0].name === "Zoe" && rows2[0].expires_at === 1911111111000, { done, name: rows2[0] && rows2[0].name, tok: store.accountSecrets(rows2[0]).token.slice(0, 8) });
  ok("展示名与 uid 的回落链：响应缺 user_name 时用 JWT nickname，全缺时兜底文案；uid 回落 JWT user_id", await (async () => {
    seen = []; cleanup();
    loginResp = resp(200, { code: 0, data: { access_token: `eyJh.${b64u({ user_id: "76", nickname: "Nick", exp: 1900000000 })}.sig`, refresh_token: "rt-3a" } });
    done = null;
    await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-5a" }, (x) => { done = x; });
    hit(`${new URL(JSON.parse(seen[0].opts.body).navigate_uri).pathname}?code=c5a&state=s5a`);
    await flush();
    const row76 = store.accountRows("autoclaw_intl").find((a) => a.uid === "intl-user-76");
    seen = []; cleanup();
    loginResp = resp(200, { code: 0, data: { access_token: `eyJh.${b64u({ user_id: "77", exp: 1900000000 })}.sig`, refresh_token: "rt-3" } });
    done = null;
    await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-5" }, (x) => { done = x; });
    hit(`${new URL(JSON.parse(seen[0].opts.body).navigate_uri).pathname}?code=c5&state=s5`);
    await flush();
    const row = store.accountRows("autoclaw_intl").find((a) => a.uid === "intl-user-77");
    return !!row76 && row76.name === "Nick" && !!row && row.name === "AutoClaw 国际版账号" && !!done && done.uid === "intl-user-77";
  })(), { done, rows: store.accountRows("autoclaw_intl").map((r) => `${r.uid}/${r.name}`) });
  ok("账号标识双缺（响应与 JWT 都没有 user_id）→ 报错且不落空 uid 账号", await (async () => {
    seen = []; cleanup();
    loginResp = resp(200, { code: 0, data: { access_token: `eyJh.${b64u({ exp: 1900000000 })}.sig`, refresh_token: "rt" } });
    done = null;
    await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-6" }, (x) => { done = x; });
    hit(`${new URL(JSON.parse(seen[0].opts.body).navigate_uri).pathname}?code=c6&state=s6`);
    await flush();
    return !!done && done.ok === false && /账号标识/.test(done.message) && store.accountRows("autoclaw_intl").some((a) => !a.uid) === false;
  })(), done);
  ok("换码上游 631001（HTTP 200 但无 access_token）→ onDone 报换码失败并带状态", await (async () => {
    seen = []; cleanup();
    loginResp = resp(200, { code: 631001, message: "User login error" });
    done = null;
    await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-7" }, (x) => { done = x; });
    hit(`${new URL(JSON.parse(seen[0].opts.body).navigate_uri).pathname}?code=bad&state=s7`);
    await flush();
    return !!done && done.ok === false && /换码失败（HTTP 200）/.test(done.message);
  })(), done);
  ok("换码请求网络异常 → 「换码失败：<原因>」", await (async () => {
    seen = []; cleanup();
    loginResp = null; // 命中 unexpected 分支前的 throw：直接让 fetch 抛
    const realScript = globalThis.fetch;
    globalThis.fetch = async (url, opts) => { if (url.endsWith("-oauth-login")) throw new Error("net down"); return realScript(url, opts); };
    done = null;
    await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-8" }, (x) => { done = x; });
    hit(`${new URL(JSON.parse(seen[0].opts.body).navigate_uri).pathname}?code=c8&state=s8`);
    await flush();
    globalThis.fetch = realScript;
    return !!done && done.ok === false && done.message === "换码失败：net down";
  })(), done);
  // 取消后迟到的回调：不替别人的会话收尾（遗留 m4 的规避）
  seen = []; cleanup();
  done = null;
  const ghostPath = await (async () => {
    await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-9" }, (x) => { done = x; });
    const p = new URL(JSON.parse(seen[0].opts.body).navigate_uri).pathname;
    discovery.cancelOAuth();
    return p;
  })();
  const before9 = store.accountRows("autoclaw_intl").length;
  const ghost = hit(`${ghostPath}?code=c9&state=s9`);
  await flush();
  ok("已取消后迟到的回调 → 只回「会话已结束」页，不写库也不回调 onDone", /登录会话已结束/.test(ghost.body) && done === null && store.accountRows("autoclaw_intl").length === before9, { body: ghost.body, done });
  cleanup();
  ok("超时兜底触发 → onDone 报登录超时并关掉回环", await (async () => {
    seen = []; cleanup();
    done = null;
    await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-T" }, (x) => { done = x; });
    const s = cur();
    await fireTimeout();
    return !!done && done.ok === false && done.message === "登录超时（6 分钟）" && s.closes === 1 && timersLeft() === 0;
  })(), done);
  ok("重复回调幂等：第二次不再烧 code，也不重复 onDone", await (async () => {
    seen = []; cleanup();
    loginResp = resp(200, { code: 0, data: { access_token: JWT_INTL, refresh_token: "rt-1", user_id: 42, user_name: "Zoe" } });
    done = null;
    await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-R" }, (x) => { done = x; });
    const p = new URL(JSON.parse(seen[0].opts.body).navigate_uri).pathname;
    hit(`${p}?code=cd-r&state=s-r`);
    hit(`${p}?code=cd-r&state=s-r`);
    await flush();
    const hops = seen.filter((s) => s.url.endsWith("-oauth-login")).length;
    return hops === 1 && !!done && done.ok === true;
  })(), done);
  ok("oauth-url 上游拒绝（630014 审核失败）→ 报「获取授权地址失败」并立刻关掉回环", await (async () => {
    seen = []; cleanup();
    oauthUrlResp = resp(200, { code: 630014, message: "抱歉,审核失败" });
    const x = await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-BAD" }, () => {});
    return x.ok === false && x.message === "获取授权地址失败（HTTP 200）抱歉,审核失败" && cur().closes === 1 && discovery.cancelOAuth() === false;
  })());
  ok("oauth-url 网络异常 → HTTP 0 带上原因，且不留半开的监听", await (async () => {
    seen = []; cleanup();
    oauthUrlResp = null;
    const realScript = globalThis.fetch;
    globalThis.fetch = async (url, opts) => { if (url.endsWith("-oauth-url")) throw new Error("net down"); return realScript(url, opts); };
    const x = await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-NET" }, () => {});
    globalThis.fetch = realScript;
    return x.ok === false && /^获取授权地址失败（HTTP 0）/.test(x.message) && /net down/.test(x.message) && cur().closes === 1 && discovery.cancelOAuth() === false;
  })(), "oauth-url 网络异常路径");
  ok("回环端口监听失败 → 明确报错，不带未定义的 navigate_uri", await (async () => {
    seen = []; cleanup();
    oauthUrlResp = resp(200, { code: 0, data: { oauth_url: OAUTH_URL } });
    listenFailures = 1;
    const x = await beginIntl({ vendor: "zai", captchaVerifyParam: "CVP-L" }, () => {});
    listenFailures = 0;
    return x.ok === false && /^回环端口监听失败：/.test(x.message) && cur().closes === 1 && seen.length === 0 && discovery.cancelOAuth() === false;
  })(), "监听失败路径");

  cleanup();
  http.createServer = realCreateServer;
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
  timers = [];

  globalThis.fetch = realFetch;
})().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
