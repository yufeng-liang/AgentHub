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

console.log("autoclaw/prompt.cjs（上游归一实现，取代 fork 的 autoclawPrompt.cjs）:");
const ap = require("../electron/backend/proxy/autoclaw/prompt.cjs");
ok("身份句逐字", ap.IDENTITY_LINE === "You are a personal assistant running inside OpenClaw.");
ok("前缀含 Tooling 段", ap.IDENTITY_PREFIX.includes("## Tooling"));

const b1 = { messages: [{ role: "user", content: "hi" }] };
ap.normalizeSystemMessages(b1);
ok("无 system 时插一条只带前缀的", b1.messages[0].role === "system" && b1.messages[0].content.startsWith(ap.IDENTITY_LINE));

const b2 = { messages: [{ role: "system", content: "You are Claude Code, Anthropic's official CLI tool for Claude." }, { role: "user", content: "hi" }] };
ap.normalizeSystemMessages(b2);
ok("外来身份句改写", !b2.messages[0].content.includes("Claude Code") && b2.messages[0].content.includes("You are a coding assistant"));
ok("前缀在前、客户端提示词逐字保留在后", b2.messages[0].content.indexOf(ap.IDENTITY_LINE) === 0 && b2.messages[0].content.endsWith("official CLI tool for Claude."));
ok("messages 数量不变", b2.messages.length === 2);

const b3 = { messages: [{ role: "system", content: ap.IDENTITY_PREFIX + "custom prompt" }] };
ap.normalizeSystemMessages(b3);
ap.normalizeSystemMessages(b3);
ok("幂等（重复归一只有一份前缀）", (b3.messages[0].content.match(/running inside OpenClaw/g) || []).length === 1 && b3.messages[0].content.includes("custom prompt"));

const b4 = { messages: [{ role: "system", content: [{ type: "text", text: "You are ZCode, an interactive coding agent" }, { type: "text", text: "more" }] }] };
ap.normalizeSystemMessages(b4);
ok("数组 content 拼第一个文本 part 且 ZCode 改写", b4.messages[0].content[0].text.startsWith(ap.IDENTITY_LINE) && !b4.messages[0].content[0].text.includes("ZCode"));

const b5 = { messages: [{ role: "user", content: "You are Claude Code" }] };
ap.normalizeSystemMessages(b5);
ok("user 消息不动（闸门只看 system/developer，身份句放进 user 消息不拦）", b5.messages[0].role === "system" && b5.messages[1].content === "You are Claude Code");

// 上游这份比内联版多的三条能力——接线后生产路径就是它，没断言盯着等于盲接：
ok("改写忽略 ASCII 大小写（内联版按 includes 逐字匹配，客户端写成大写就漏闸）", (() => {
  const b = { messages: [{ role: "system", content: "YOU ARE CLAUDE CODE, hi" }] };
  ap.normalizeSystemMessages(b);
  const rest = b.messages[0].content.slice(ap.IDENTITY_PREFIX.length);
  return !/CLAUDE CODE/i.test(rest) && rest.includes("You are a coding assistant");
})());
ok("Codex CLI / DeepSeek harness 身份句也在表内（内联版只有 ZCode 与 Claude 两家）", (() => {
  const b = { messages: [{ role: "system", content: "You are a coding agent running in the Codex CLI tool.\nYou are an AI agent powered by DeepSeek Harness." }] };
  ap.normalizeSystemMessages(b);
  return !/Codex|DeepSeek/.test(b.messages[0].content.slice(ap.IDENTITY_PREFIX.length));
})());
ok("normalizeMaxTokens：0<v<10000 归一到 10000（上游对小值做预校验并回 406 空体）", (() => {
  const b = { max_tokens: 1024 }; ap.normalizeMaxTokens(b); return b.max_tokens === 10000;
})());
ok("normalizeMaxTokens：缺省不注入 / ≥10000 不动 / 字符串不强转 / max_completion_tokens 不参与", (() => {
  const a = {}; ap.normalizeMaxTokens(a);
  const b = { max_tokens: 20000 }; ap.normalizeMaxTokens(b);
  const c = { max_tokens: "4096" }; ap.normalizeMaxTokens(c);
  const d = { max_completion_tokens: 512 }; ap.normalizeMaxTokens(d);
  return !("max_tokens" in a) && b.max_tokens === 20000 && c.max_tokens === "4096" && d.max_completion_tokens === 512;
})());

console.log("autoclaw 适配器（上游 autoclaw/ 目录 + fork 语义装饰）:");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const acHeaders = require("../electron/backend/proxy/autoclaw/headers.cjs");
const acModels = require("../electron/backend/proxy/autoclaw/models.cjs");
const cnAd = adapters.get("autoclaw"), intlAd = adapters.get("autoclaw_intl");
ok("两地区都已注册", !!cnAd && !!intlAd);
ok("上游能力面齐（cfg/fetchModels/queryCredits/checkin/checkinStatus 都在）",
  ["cfg", "fetchModels", "queryCredits", "checkin", "checkinStatus", "headers", "rewriteBody"].every((k) => typeof cnAd[k] === "function"), Object.keys(cnAd).join(","));
ok("cfg() 按渠道读 headers.json（两区域名不同、代理路径相同）",
  cnAd.cfg().userapiBase === "https://autoglm-acceleration-api.zhipuai.cn" && intlAd.cfg().userapiBase === "https://autoglm-api.autoglm.ai"
    && cnAd.cfg().llmProxyPath === intlAd.cfg().llmProxyPath, cnAd.cfg());
ok("临期窗口 300s 由 fork 装饰补回（上游目录没这个键，缺省会按 24h 判临期，于是每次刷额度都在刷 token，与桌面端抢同一个 refresh_token）",
  cnAd.refreshWindowSec === 300 && intlAd.refreshWindowSec === 300);
ok("headers() 只给非签名基础头且不含 authorization（LLM 认证头在 chat 内按账号现场出）",
  !("authorization" in cnAd.headers()) && cnAd.headers()["x-product"] === "autoclaw" && cnAd.headers()["x-version"] === "1.17.8", cnAd.headers());
const h = acHeaders.llmHeaders(cnAd.cfg(), "tok123", "zaicoding_glm-5.3");
ok("LLM 域认证头是 X-Authorization", h["x-authorization"] === "Bearer tok123");
ok("LLM 域禁发 X-Harness-Type（2026-09-22 闸门）", !("x-harness-type" in h));
ok("LLM 域带产品指纹头", h["x-product"] === "autoclaw" && h["x-client-type"] === "pc" && h["x-tm"] === "win" && h["x-version"] === "1.17.8" && h["x-request-model"] === "zaicoding_glm-5.3");
const uh = acHeaders.signedAuthHeaders(cnAd.cfg(), "tok123");
ok("userapi 域保留 X-Harness-Type 且带签名头", uh["x-harness-type"] === "zcode" && uh["x-auth-appid"] === "100003" && /^[0-9a-f]{32}$/.test(uh["x-auth-sign"]));
ok("签名公式 MD5(appId&秒级时间戳&appKey)", acHeaders.authSign("100003", "38d2391985e2369a5fb8227d8e6cd5e5", 1700000000000).sign
  === crypto.createHash("md5").update("100003&1700000000&38d2391985e2369a5fb8227d8e6cd5e5").digest("hex"));
ok("签名头族在无 token 时整条 authorization 不发（captcha-config 那一步是匿名形态）",
  !("authorization" in acHeaders.signedAuthHeaders(cnAd.cfg(), "")));
ok("会话透传三头按客户端原样改名透传，没带就不发", (() => {
  const s = acHeaders.sessionPassthroughHeaders({ "x-autoclaw-session-id": "sid-1", "other": "x" });
  return Object.keys(s).join() === "X-Session-Id" && s["X-Session-Id"] === "sid-1"
    && Object.keys(acHeaders.sessionPassthroughHeaders({})).length === 0;
})());

console.log("autoclaw 模型路由（autoclaw/models.cjs）:");
const R = (m) => acModels.resolveRoute(m, acModels.STATIC_MODELS).routeModelId;
ok("glm-5.3 → zaicoding_", R("glm-5.3") === "zaicoding_glm-5.3");
ok("glm-5.3-flash → zai_", R("glm-5.3-flash") === "zai_glm-5.3-flash");
ok("未知模型兜底 zai_auto", R("whatever") === "zai_auto");
ok("已带合法路由前缀透传", R("zai_glm-5.3") === "zai_glm-5.3" && R("zaicoding_glm-5.3") === "zaicoding_glm-5.3");
ok("目录条目不带 routeId 时按 id 回静态表补（装机默认段就是这种形状，掉到 zai_auto 等于悄悄换计费通道）",
  acModels.resolveRoute("glm-5.3", [{ id: "glm-5.3", name: "GLM-5.3" }]).routeModelId === "zaicoding_glm-5.3"
    && acModels.resolveRoute("glm-5.3", [{ id: "glm-5.3", name: "GLM-5.3" }]).bodyModelId === "glm-5.3");
ok("目录条目自带 routeId 时以目录为准（拉过官方目录后不再看静态表）",
  acModels.resolveRoute("glm-5.3-flash", [{ id: "glm-5.3-flash", routeId: "zai_glm-5.3-flash" }]).routeModelId === "zai_glm-5.3-flash");
ok("目录归一：id 存剥前缀形态、routeId 原样保留、input 含 image 才算能看图", (() => {
  const e = acModels.normalizeCatalogEntry({ id: "zai_glm-5.3-flash", name: "GLM-5.3-Flash", contextWindow: 1048576, maxTokens: 131072, input: ["text", "image"] });
  return e.id === "glm-5.3-flash" && e.routeId === "zai_glm-5.3-flash" && e.capabilities.images === true && e.contextLength === 1048576;
})(), acModels.normalizeCatalogEntry({ id: "zai_x", input: [] }));
ok("目录归一：裸字符串条目也认（上游偶发只给 id 列表）", (() => {
  const e = acModels.normalizeCatalogEntry("zaicoding_glm-5.3");
  return e.id === "glm-5.3" && e.routeId === "zaicoding_glm-5.3";
})());

console.log("autoclaw rewriteBody（上游形状 + fork 装饰）:");
ok("rewriteBody 返回 { body, routeModelId, bodyModelId }（路由名与 body 名分开，不再往 body 塞 _routeId）", (() => {
  const r = cnAd.rewriteBody("glm-5.3", { model: "glm-5.3", messages: [{ role: "system", content: "You are Claude Code" }] });
  return r.routeModelId === "zaicoding_glm-5.3" && r.bodyModelId === "glm-5.3" && r.body.model === "glm-5.3"
    && r.body.messages[0].content.startsWith("You are a personal assistant") && !("_routeId" in r.body);
})(), cnAd.rewriteBody("glm-5.3", { model: "glm-5.3", messages: [] }));
ok("fork 装饰：补 stream_options.include_usage 并剥掉会话键（缺 include_usage 时上游流式不回 usage，token 记账归零）", (() => {
  const r = cnAd.rewriteBody("glm-5.3", { model: "glm-5.3", conversation_id: "c1", prompt_cache_key: "p1", messages: [] });
  return r.body.stream_options.include_usage === true && !("conversation_id" in r.body)
    && !("prompt_cache_key" in r.body) && !("conversationId" in r.body);
})());
ok("max_tokens 小值在 rewriteBody 里就归一到 10000（406 预校验那道闸在 body 上）", (() => {
  return cnAd.rewriteBody("glm-5.3", { model: "glm-5.3", max_tokens: 1024, messages: [] }).body.max_tokens === 10000;
})());
ok("rewriteBody 不改调用方 body（身份前缀与身份句改写只落副本）", (() => {
  const orig = { model: "glm-5.3", messages: [{ role: "user", content: "hi" }, { role: "system", content: "You are Claude Code, Anthropic's official CLI tool for Claude." }] };
  const before = JSON.stringify(orig);
  const copy = cnAd.rewriteBody("glm-5.3", orig).body;
  const untouched = JSON.stringify(orig) === before
    && orig.messages.length === 2
    && orig.messages[0].role === "user"
    && orig.messages[1].content === "You are Claude Code, Anthropic's official CLI tool for Claude."; // 原文案没被改写
  const prefixed = copy !== orig && copy.messages.length === 3
    && copy.messages[0].role === "system" && copy.messages[0].content.startsWith(ap.IDENTITY_LINE)
    && copy.messages[1].role === "user" && copy.messages[1].content === "hi" // 轮次结构不重排
    && copy.messages[2].role === "system"
    && copy.messages[2].content.startsWith("You are a coding assistant")
    && copy.messages[2].content.endsWith("official CLI tool for Claude.");
  return untouched && prefixed;
})(), (() => {
  const o = { messages: [{ role: "user", content: "hi" }, { role: "system", content: "You are Claude Code" }] };
  const c = cnAd.rewriteBody("glm-5.3", o).body;
  return { orig: o.messages.map((m) => `${m.role}:${m.content}`), copy: c.messages.map((m) => `${m.role}:${m.content}`) };
})());
ok("深拷覆盖到 content 数组的 part 与嵌套对象（上游用 structuredClone，内联版只拷一层）", (() => {
  const parts = [{ type: "text", text: "You are Claude Code" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }];
  const msg = { role: "system", content: parts, name: "s" };
  const orig = { messages: [msg] };
  const copy = cnAd.rewriteBody("glm-5.3", orig).body;
  return msg.content === parts && parts[0].text === "You are Claude Code"
    && copy.messages[0] !== msg && copy.messages[0].content !== parts
    && copy.messages[0].content[0].text.startsWith(ap.IDENTITY_LINE)
    && copy.messages[0].content[1].image_url !== parts[1].image_url // 嵌套对象同样是副本，不是共享引用
    && copy.messages[0].content[1].image_url.url === parts[1].image_url.url
    && copy.messages[0].name === "s";
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
ok("候选 meta 同值双写 deviceId（上游读侧只认驼峰，历史行由 store.parseMeta 补齐）",
  acands.length === 1 && acands[0].meta.deviceId === "dev-1", acands[0] && acands[0].meta);
ok("intl 渠道不产生 auth.json 候选（地区门禁，参考项目同款）", discovery.scanAll().some((c) => c.channel === "autoclaw_intl") === false);
ok("老式只写 snake 的行读出来带 deviceId（store.parseMeta 的读侧归一）", (() => {
  const st = require("../electron/backend/proxy/store.cjs");
  const id = st.addAccount({ channel: "autoclaw", uid: "user-legacy", name: "老行", token: "t", refreshToken: "r", source: "paste", meta: { device_id: "dev-snake-only" } });
  const view = st.listAccounts("autoclaw").find((a) => a.id === id);
  const raw = JSON.parse((st.getAccount(id) || {}).meta || "{}"); // 原始列里仍只有 snake：归一发生在读侧
  const shape = !!view && view.meta.deviceId === "dev-snake-only" && raw.deviceId === undefined;
  st.removeAccount(id); // 夹具行删干净，别给后面的落库断言留影子
  return shape;
})(), "meta 读侧归一");
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
  const chatRes = await cnAd.chat({ account: { id: "a1", uid: "user-1", meta: {} }, secrets: { token: "tok123" }, model: "glm-5.3", body: { model: "glm-5.3", messages: [{ role: "user", content: "hi" }] }, emit: (e) => events.push(e) });
  ok("chat URL 拼 /chat/completions", calls[0].url === "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions", calls[0].url);
  ok("chat 出站 X-Authorization 且无 X-Harness-Type、路由进 X-Request-Model", calls[0].opts.headers["x-authorization"] === "Bearer tok123" && !("x-harness-type" in calls[0].opts.headers) && calls[0].opts.headers["x-request-model"] === "zaicoding_glm-5.3");
  const sentBody = JSON.parse(calls[0].opts.body);
  ok("chat 体：model 剥前缀 / 无 _routeId 残留 / 无 system 时注入身份前缀", sentBody.model === "glm-5.3" && !("_routeId" in sentBody) && sentBody.messages[0].role === "system" && sentBody.messages[0].content.startsWith("You are a personal assistant"));
  ok("chat 体：恒流式并带 include_usage（fork 装饰补的那条，缺它流式不回 usage）", sentBody.stream === true && sentBody.stream_options.include_usage === true, sentBody.stream_options);
  ok("chat 事件：delta/finish/usage 齐全", events.some((e) => e.type === "delta" && e.delta.content === "hi") && events.some((e) => e.type === "finish" && e.reason === "stop") && events.some((e) => e.type === "usage" && e.usage.total_tokens === 3), events);
  ok("chat 返回 {status:200, planLimit:false}", chatRes.status === 200 && chatRes.planLimit === false);

  // chat 带内错误分类（协议参考 §2.6）：401→401 触发刷新；429→402 换号；内容拦截三文案→502
  // 这条是 fork 侧修复：上游目录实现原先把所有带内错误压成 502，三种形态都会落进「服务端错误 3 次熔断」
  globalThis.fetch = async () => sseResp([JSON.stringify({ error: { status: 429, code: 1302, message: "rate" } })]);
  const ev429 = []; const res429 = await cnAd.chat({ account: { id: "a1", meta: {} }, secrets: { token: "t" }, model: "glm-5.3", body: { messages: [] }, emit: (e) => ev429.push(e) });
  ok("上游 429 → 402 + planLimit", res429.planLimit === true && ev429.some((e) => e.type === "error" && e.status === 402), { res429, ev429 });
  globalThis.fetch = async () => sseResp([JSON.stringify({ error: { status: 401, code: 0, message: "unauthorized" } })]);
  const ev401 = []; const res401 = await cnAd.chat({ account: { id: "a1", meta: {} }, secrets: { token: "t" }, model: "glm-5.3", body: { messages: [] }, emit: (e) => ev401.push(e) });
  ok("上游 401 → 401（触发刷新链，不是熔断）", res401.planLimit === false && ev401.some((e) => e.type === "error" && e.status === 401), { res401, ev401 });
  globalThis.fetch = async () => sseResp([JSON.stringify({ error: { status: 403, code: 0, message: "request blocked by security policy" } })]);
  const evBlocked = []; await cnAd.chat({ account: { id: "a1", meta: {} }, secrets: { token: "t" }, model: "glm-5.3", body: { messages: [] }, emit: (e) => evBlocked.push(e) });
  ok("内容拦截文案 → 502（不当 403 透传，也不换号）", evBlocked.some((e) => e.type === "error" && e.status === 502 && /blocked by security policy/.test(e.message)));
  globalThis.fetch = async () => sseResp([JSON.stringify({ error: { status: 400, code: 0, message: "bad" } })]);
  const ev400 = []; await cnAd.chat({ account: { id: "a1", meta: {} }, secrets: { token: "t" }, model: "glm-5.3", body: { messages: [] }, emit: (e) => ev400.push(e) });
  ok("其它 status 原样透传（400 不折算成 502）", ev400.some((e) => e.type === "error" && e.status === 400), ev400);

  // 刷新降级链（协议参考 §2.3）：v1/refresh 回 400002 → 二跳 agent-refresh；成功按 JWT exp 重算
  calls.length = 0;
  const newTok = mkJwt({ user_id: "42", exp: 1900000000 });
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return calls.length === 1 ? jsonResp({ code: 400002, message: "use agent refresh" }) : jsonResp({ code: 0, message: "ok", data: { access_token: newTok, refresh_token: "rt-new" } });
  };
  const rr = await cnAd.refreshToken({ id: "a9", meta: {} }, { token: "old-tok", refreshToken: "rt-old" });
  ok("刷新降级链 400002 → 二跳 agent-refresh（同头同 body 重发）", calls.length === 2
    && calls[0].url === "https://autoglm-acceleration-api.zhipuai.cn/userapi/v1/refresh"
    && calls[1].url === "https://autoglm-acceleration-api.zhipuai.cn/userapi/v1/agent-refresh"
    && calls[0].opts.body === calls[1].opts.body, calls.map((c) => c.url));
  ok("刷新请求走 userapi 头族（签名 + 保留 Harness-Type）+ body 带 source_id", calls[0].opts.headers["x-harness-type"] === "zcode" && /^[0-9a-f]{32}$/.test(calls[0].opts.headers["x-auth-sign"]) && calls[0].opts.headers.authorization === "Bearer old-tok" && JSON.parse(calls[0].opts.body).source_id === "autoclaw");
  ok("刷新成功：access_token 剥 Bearer/exp 按 JWT 重算", rr.ok === true && rr.token === newTok && rr.refreshToken === "rt-new" && rr.expiresAt === 1900000000000, rr);
  ok("刷新结果标 noPersist（方案 §7：新凭证只进进程缓存，落库会与桌面端互顶）", rr.noPersist === true, rr);
  globalThis.fetch = async () => jsonResp({ code: 410000, message: "expired" });
  const re = await cnAd.refreshToken({ id: "a9", meta: {} }, { token: "t", refreshToken: "r" });
  ok("410000 → authError 标记（credits.cjs 认这个键，旧内联版的 expired 无人消费）", re.ok === false && re.authError === true, re);
  globalThis.fetch = async () => jsonResp({ code: 0, message: "ok", data: {} });
  const rno = await cnAd.refreshToken({ id: "a9", meta: {} }, { token: "t", refreshToken: "r" });
  ok("code=0 但没给新 token → 如实报错，不返回空 token 让账号上线", rno.ok === false && /未返回新 token/.test(rno.message || ""), rno);

  // ===== source=scan 的桌面文件凭据必须过身份比对（否则桌面端换账号后旧行会刷进新账号额度）=====
  // 夹具走 AUTOCLAW_USER_DATA_DIR（autoclawUserDataDir 的第一优先级）直接指向临时目录，
  // auth.json 的 token 是**真 JWT**、user_id 可控——不用「解不出 uid」的假形状糊过断言。
  const acFile = (userId, rtFile, devFile) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaw-file-"));
    const k = crypto.randomBytes(32);
    fs.writeFileSync(path.join(dir, "Local State"), JSON.stringify({
      os_crypt: { encrypted_key: Buffer.concat([Buffer.from("DPAPI"), ac.dpapiProtect(k)]).toString("base64") },
    }));
    const encWith = (plain) => {
      const n = crypto.randomBytes(12);
      const c = crypto.createCipheriv("aes-256-gcm", k, n);
      return "enc:" + Buffer.concat([Buffer.from("v10"), n, Buffer.concat([c.update(Buffer.from(plain, "utf8")), c.final(), c.getAuthTag()])]).toString("base64");
    };
    fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
      deviceId: devFile, token: encWith(`Bearer ${mkJwt({ user_id: userId, exp: 1900000000 })}`), refreshToken: encWith(rtFile), userInfo: {},
    }));
    return dir;
  };
  const refreshWithFile = async (ad, dir, account, secrets) => {
    calls.length = 0;
    process.env.AUTOCLAW_USER_DATA_DIR = dir;
    globalThis.fetch = async (url, opts) => {
      calls.push({ url, opts });
      return jsonResp({ code: 0, message: "ok", data: { access_token: mkJwt({ user_id: "42", exp: 1900000000 }), refresh_token: "rt-upstream" } });
    };
    const r = await ad.refreshToken(account, secrets);
    delete process.env.AUTOCLAW_USER_DATA_DIR;
    return { body: JSON.parse(calls[0].opts.body), r };
  };
  // 号池那一行的 uid 是 user-42，桌面文件已换成 user-99：refresh_token / device_id 都不许跟过去
  const mismatch = await refreshWithFile(cnAd,
    acFile("99", "rt-file-OTHER", "file-dev-OTHER"),
    { id: "a10", source: "scan", uid: "user-42", meta: {} },
    { token: mkJwt({ user_id: "42", exp: 1900000000 }), refreshToken: "rt-pool" }
  );
  ok("桌面文件是别人的账号（文件 user-99 ≠ 号池 user-42）→ 刷新仍用号池快照，不采用文件值",
    mismatch.body.refresh_token === "rt-pool" && mismatch.body.device_id !== "file-dev-OTHER" && mismatch.r.ok === true, mismatch.body);
  // 同 uid 时必须采用文件值（桌面端可能刚刷过并旋转了 refresh_token）——防修过头把同步能力删干净
  const matched = await refreshWithFile(cnAd,
    acFile("42", "rt-file-MINE", "file-dev-MINE"),
    { id: "a11", source: "scan", uid: "user-42", meta: {} },
    { token: mkJwt({ user_id: "42", exp: 1900000000 }), refreshToken: "rt-pool" }
  );
  ok("同 uid 时正常采用桌面文件值（refresh_token 跟上旋转、device_id 回落文件值）",
    matched.body.refresh_token === "rt-file-MINE" && matched.body.device_id === "file-dev-MINE", matched.body);
  // 前缀参与身份比对的证据：CN 行（uid=user-42）走 intlAd 时，文件里的 user_id 42 拼成 intl-user-42，
  // 与行 uid 对不上 ⇒ 整份文件值都不采用。auth.json 本身没有地区标记，前缀只由渠道 id 决定，
  // 所以「同一台机器上的 CN 号被刷进国际区凭据」这类错配必须由这一步拦住。
  const crossMismatch = await refreshWithFile(intlAd,
    acFile("42", "rt-file-CN", "file-dev-CN"),
    { id: "a12", source: "scan", uid: "user-42", meta: {} },
    { token: mkJwt({ user_id: "42", exp: 1900000000 }), refreshToken: "rt-pool-cn" }
  );
  ok("CN 行走 intlAd 续期不采用文件值（uid 地区前缀参与身份比对）",
    crossMismatch.body.refresh_token === "rt-pool-cn" && crossMismatch.body.device_id !== "file-dev-CN", crossMismatch.body);
  const intlMatched = await refreshWithFile(intlAd,
    acFile("42", "rt-file-INTL", "file-dev-INTL"),
    { id: "a13", source: "scan", uid: "intl-user-42", meta: {} },
    { token: mkJwt({ user_id: "42", exp: 1900000000 }), refreshToken: "rt-pool-intl" }
  );
  ok("intl 行走 intlAd 时正常采用（前缀由渠道 id 决定，auth.json 里没有地区标记）",
    intlMatched.body.refresh_token === "rt-file-INTL" && intlMatched.body.device_id === "file-dev-INTL", intlMatched.body);
  // 粘贴导入的行没有 meta 设备号：从当前 access token 的 JWT device_id 声明取（内联版口径）
  calls.length = 0;
  globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return jsonResp({ code: 0, message: "ok", data: { access_token: mkJwt({ user_id: "42", exp: 1900000000 }), refresh_token: "rt-new" } }); };
  await cnAd.refreshToken({ id: "a14", source: "paste", uid: "user-42", meta: {} }, { token: mkJwt({ user_id: "42", device_id: "jwt-dev-7", exp: 1900000000 }), refreshToken: "rt-pool" });
  ok("无 meta 设备号时取 JWT 的 device_id 声明（不被合成 machineId 顶掉）", JSON.parse(calls[0].opts.body).device_id === "jwt-dev-7", calls[0] && calls[0].opts.body);

  // 国际区域名参数化：同一份适配器代码只换域
  let intlUrl = "";
  globalThis.fetch = async (url) => { intlUrl = url; return sseResp(["[DONE]"]); };
  await intlAd.chat({ account: { id: "b1", meta: {} }, secrets: { token: "t" }, model: "glm-5.3", body: { messages: [] }, emit: () => {} });
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
      // 签名公式复算一遍：用头里自带的 appid 与配置里的 appKey，按秒级时间戳重算 md5
      && h["x-auth-sign"] === acHeaders.authSign(h["x-auth-appid"], intlAd.cfg().authAppKey, Number(h["x-auth-timestamp"]) * 1000).sign
      && !("authorization" in h);
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

  // —— 导入身份复核：小浣熊与 AutoClaw 的候选 file 都是字面量 "auth.json" ——
  // 真机 2026-09-27 抓到的缺陷：proxy_scan_import 用 `file || uid` 的**或**去回查候选，
  // 而 scanAll() 里 raccoon 排在 autoclaw 前面 ⇒ 在两台桌面端都登录过的机器上点 AutoClaw 那行，
  // 落库的是小浣熊的 token 挂在 autoclaw 渠道下。UI 传满四参（ProxyAgentsView.vue），必然命中。
  console.log("proxy_scan_import 身份复核（两渠道共用 file=\"auth.json\"）:");
  {
    const store = require("../electron/backend/proxy/store.cjs");
    const proxy = require("../electron/backend/proxy/index.cjs");
    const handlers = new Map();
    proxy.register({ handle: (name, fn) => handlers.set(name, fn) });
    const call = (name, args) => handlers.get(name)(null, args);
    ok("① 处理体可从 register() 收集到（判据不是空转）", typeof handlers.get("proxy_scan_import") === "function");

    const realScanAll = discovery.scanAll;
    const CLAW = { channel: "autoclaw", uid: "user-9", name: "AutoClaw 账号", token: "AUTOC-1", refreshToken: "AUTOC-RT", expiresAt: 0, meta: {}, source: "scan", file: "auth.json" };
    const RAC = { channel: "raccoon", uid: "70ece0", name: "RaccoonAubrey", token: "RAC-1", refreshToken: "RAC-RT", expiresAt: 0, meta: {}, source: "scan", file: "auth.json" };
    discovery.scanAll = () => [RAC, CLAW]; // 顺序与 scanAll 真实现一致：raccoon 在 autoclaw 之前
    try {
      const r = await call("proxy_scan_import", { index: 1, channel: "autoclaw", file: "auth.json", uid: "user-9" });
      const acct = r && r.id ? store.getAccount(r.id) : null;
      const sec = acct ? store.accountSecrets(acct) : {};
      ok("点 AutoClaw 那行导入，落库渠道是 autoclaw", r.ok === true && !!acct && acct.channel === "autoclaw" && acct.uid === "user-9",
        { r, got: acct && { channel: acct.channel, uid: acct.uid, name: acct.name } });
      ok("落库的 token 是 AutoClaw 的凭据（不是小浣熊的）", sec.token === "AUTOC-1", { token: sec.token });
      ok("小浣熊渠道没有因此多出账号", store.listAccounts("raccoon").length === 0, store.listAccounts("raccoon").map(a => a.uid));

      const r2 = await call("proxy_scan_import", { index: 0, channel: "raccoon", file: "auth.json", uid: "70ece0" });
      const a2 = r2 && r2.id ? store.getAccount(r2.id) : null;
      ok("反向同理：点小浣熊那行落的是小浣熊（AND 之后不能退化成永远取下标 1）",
        r2.ok === true && !!a2 && a2.channel === "raccoon" && a2.uid === "70ece0" && store.accountSecrets(a2).token === "RAC-1",
        { r2, got: a2 && { ch: a2.channel, uid: a2.uid } });

      // 只传下标（本轮真机的绕行调用）仍按字面下标走
      const r3 = await call("proxy_scan_import", { index: 1 });
      ok("只传 {index} 时仍按下标取候选", r3.ok === true && r3.updated === true, r3);

      // 三个约束都必须是**可选**的：老调用方不传 channel 时，只靠 uid 也要能唯一命中
      const r5 = await call("proxy_scan_import", { index: 0, file: "auth.json", uid: "user-9" });
      ok("不传 channel、只给 file+uid 时按 uid 命中 autoclaw（约束不得变成硬性三必填）",
        r5.ok === true && r5.updated === true, r5);

      // 身份核对的本意要保住：文件里那一行消失 ⇒ 明确报「候选已变化」，不得静默导成别家
      discovery.scanAll = () => [RAC];
      const r4 = await call("proxy_scan_import", { index: 1, channel: "autoclaw", file: "auth.json", uid: "user-9" });
      ok("候选真消失了 → 报「候选已变化」而不是导成小浣熊", r4.ok === false && /候选已变化/.test(r4.message || ""), r4);
    } finally {
      discovery.scanAll = realScanAll;
    }
  }
})().then(() => {
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
