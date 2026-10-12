// Cline 渠道自测：node scripts/dev-cline-test.cjs
// mktemp 造库隔离（dev-provider-test.cjs 同款硬规则），纯本地断言，不打上游网络。
"use strict";
const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-cline-test-"));

const clineAuth = require("../electron/backend/proxy/clineAuth.cjs");
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? `→ got ${JSON.stringify(extra)}` : ""); }
}
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const mkJwt = (claims) => `workos:xxx.${b64url(claims)}.sig`;

console.log("ensureTokenPrefix:");
ok("裸 JWT 补前缀", clineAuth.ensureTokenPrefix("eyJh.eyJi.c") === "workos:eyJh.eyJi.c");
ok("已带前缀幂等", clineAuth.ensureTokenPrefix("workos:eyJh.eyJi.c") === "workos:eyJh.eyJi.c");
ok("空串安全", clineAuth.ensureTokenPrefix("") === "");

console.log("clineUid:");
const uidTok = mkJwt({ sub: "user_ABC", external_id: "usr-123", "https://api.cline.bot/user_id": undefined });
ok("external_id 优先", clineAuth.clineUid(uidTok) === "usr-123", clineAuth.clineUid(uidTok));
ok("sub 不可用（回落 fallback）", clineAuth.clineUid(mkJwt({ sub: "user_ABC" }), "usr-fallback") === "usr-fallback");

console.log("clineExpiresAt:");
ok("ISO 字符串", clineAuth.clineExpiresAt("2030-01-01T00:00:00Z", {}) === Date.parse("2030-01-01T00:00:00Z"));
ok("毫秒数字", clineAuth.clineExpiresAt(1893456000000, {}) === 1893456000000);
const expTok = mkJwt({ exp: 1893456000 });
ok("JWT exp 秒→毫秒", clineAuth.clineExpiresAt(undefined, JSON.parse(Buffer.from(expTok.replace("workos:","").split(".")[1], "base64url").toString())) === 1893456000000, clineAuth.clineExpiresAt(undefined, JSON.parse(Buffer.from(expTok.replace("workos:","").split(".")[1], "base64url").toString())));
ok("解不出为 0", clineAuth.clineExpiresAt(undefined, {}) === 0);

console.log("readClineDesktopAuth:");
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "cline-home-"));
const settingsDir = path.join(fakeHome, ".cline", "data", "settings");
fs.mkdirSync(settingsDir, { recursive: true });
fs.writeFileSync(path.join(settingsDir, "providers.json"), JSON.stringify({
  providers: { cline: { settings: { auth: { accessToken: "workos:eyJh.eyJi.c", refreshToken: "rt-1",
    expiresAt: 1893456000000, accountId: "usr-9",
    metadata: { userInfo: { firstName: "三", lastName: "张", email: "z@x.com" } } } } } },
}));
// readClineDesktopAuth 内部用 os.homedir()——只在断言内部临时覆盖，用完恢复原函数（APPDATA 隔离与其互不干扰）
const realHome = os.homedir;
os.homedir = () => fakeHome;
const cred = clineAuth.readClineDesktopAuth();
os.homedir = realHome;
ok("读到 token 且带前缀", !!cred && cred.token === "workos:eyJh.eyJi.c", cred);
ok("displayName 中文姓在前", !!cred && cred.displayName === "张三", cred && cred.displayName);
ok("未安装返回 null", (() => { const h = os.homedir; os.homedir = () => path.join(fakeHome, "empty"); const r = clineAuth.readClineDesktopAuth(); os.homedir = h; return r === null; })());

console.log("cline 适配器（上游 cline/ 目录实现）:");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const clineModels = require("../electron/backend/proxy/cline/models.cjs");
const clineAdapterMod = require("../electron/backend/proxy/cline/adapter.cjs");
const free = adapters.get("cline_free"), passAd = adapters.get("cline_pass");
ok("两池都已注册", !!free && !!passAd);
ok("上游能力面齐（cfg/queryCredits/classifyError/checkin 都在）", ["cfg", "queryCredits", "classifyError", "checkin", "checkinStatus", "headers", "rewriteBody", "fetchModels"].every((k) => typeof free[k] === "function"), Object.keys(free).join(","));
ok("cfg() 读 headers.json 的 cline 段（apiBase 只有单层 v1）", free.cfg().apiBase === "https://api.cline.bot/api/v1", free.cfg());
ok("目录接口无需鉴权（modelsNeedAuth=false：导入账号前就能同步模型）", free.modelsNeedAuth === false);
ok("临期窗口 600s（access 实测 1h 的 1/6）", free.refreshWindowSec === 600);
ok("headers() 带 X-CLIENT-TYPE: cline-sdk（免费池硬门槛，缺它整池 403）", free.headers()["x-client-type"] === "cline-sdk", free.headers());
ok("headers() 不含 authorization（鉴权在 chat 内按账号出）", !("authorization" in free.headers()));
ok("rewriteBody：短名按本池目录补前缀，并给出 sessionId（与 X-Task-ID 同值）", (() => {
  const r = free.rewriteBody("deepseek-v4.1-flash", { model: "x", messages: [] });
  return r.body.model === "cline-free/deepseek-v4.1-flash" && /^sess_\d+$/.test(String(r.sessionId));
})(), free.rewriteBody("deepseek-v4.1-flash", { model: "x", messages: [] }));
ok("rewriteBody：完整 id 原样；带另一池前缀也不改写（跨池不换计费通道）",
  passAd.rewriteBody("cline-free/glm-5.3-flash", { messages: [] }).body.model === "cline-free/glm-5.3-flash");
ok("rewriteBody：目录里没有的名字原样透传（未知模型交给上游 404，绝不静默替换）",
  free.rewriteBody("no-such/model-x", { messages: [] }).body.model === "no-such/model-x");
ok("rewriteBody：不注入 max_tokens、不改 stream 字段（缺失交给上游按模型默认）", (() => {
  const b = free.rewriteBody("cline-free/solar-pro4", { messages: [] }).body;
  return !("max_tokens" in b) && !("stream" in b);
})(), free.rewriteBody("cline-free/solar-pro4", { messages: [] }));
ok("rewriteBody：reasoning_effort 缺省补 high，驼峰键翻译后删原键", (() => {
  const a = free.rewriteBody("cline-free/solar-pro4", { messages: [], reasoningEffort: "low" }).body;
  const b = free.rewriteBody("cline-free/solar-pro4", { messages: [] }).body;
  return a.reasoning_effort === "low" && !("reasoningEffort" in a) && b.reasoning_effort === "high";
})(), free.rewriteBody("cline-free/solar-pro4", { messages: [] }));
ok("rewriteBody：深拷贝改写，绝不污染入参 body（回退链多渠道复用同一对象）", (() => {
  const input = { model: "x", messages: [{ role: "user", content: "hi" }] };
  free.rewriteBody("deepseek-v4.1-flash", input);
  return input.model === "x" && input.messages.length === 1 && !("session_id" in input) && !("reasoning_effort" in input);
})());

console.log("cline 错误分类（适配器 classifyError）:");
const C403 = (msg) => free.classifyError({ status: 403, body: JSON.stringify({ error: { code: "ENTITLEMENT_ERROR", message: msg } }) });
ok("403 → model_denied 且不换号（确定性拒绝，冷却只会把确定失败变静默跳过）", (() => {
  const c = C403("Your account is not subscribed to this model");
  return c.kind === "model_denied" && c.switchable === false && c.status === 403 && c.channelLevel === false;
})(), free.classifyError({ status: 403, body: "{}" }));
ok("403 渠道级产品面校验 → 文案点出 X-CLIENT-TYPE 伪装头（整池静默失效不能无感）", (() => {
  const c = C403("This model is only available via Cline product surfaces");
  return c.channelLevel === true && /X-CLIENT-TYPE/.test(c.message) && c.kind === "model_denied";
})(), C403("only available via Cline product surfaces"));
ok("404 → model_denied（模型名不对，换号无用）", (() => {
  const c = free.classifyError({ status: 404, body: "{\"error\":\"model not found\"}" });
  return c.kind === "model_denied" && c.switchable === false;
})(), free.classifyError({ status: 404 }));
ok("429 → rate 且解析人话时长填 resetMs（免费池冷却可达小时级）", (() => {
  const c = free.classifyError({ status: 429, body: "Try again in 17h 59m" });
  const gap = c.resetMs - Date.now();
  return c.kind === "rate" && c.switchable === true && gap > 17 * 3600000 && gap <= 18 * 3600000;
})(), free.classifyError({ status: 429, body: "Try again in 17h 59m" }));
ok("401 不拦截（交回通用层走 relogin 刷新重试）", free.classifyError({ status: 401 }) === null);
ok("parseTryAgainMs：1d 2h 30m / 30s / 认不出都按事实算", (() => {
  const P = clineAdapterMod.parseTryAgainMs;
  return P("Try again in 1d 2h 30m") === 95400000 && P("Try again in 30s") === 30000 && P("no hint") === 0;
})(), clineAdapterMod.parseTryAgainMs("Try again in 1d 2h 30m"));

console.log("cline 目录归池（上游 cline/models.cjs）:");
const groups = {
  free: [{ id: "cline-free/a" }, { id: "z-ai/glm-5.3-flash" }],
  clinePass: [{ id: "cline-pass/b" }],
  recommended: [{ id: "openai/gpt-x" }, { id: "cline-free/from-recommended" }],
  clineCloud: [{ id: "cline-cloud/y" }],
};
const parsed = clineModels.parseRecommended(groups);
const inPool = (pool) => clineModels.filterByPool(parsed, pool).map((e) => e.id).join(",");
ok("free 组归 free 池（含裸厂商 id 条目，归池看分组不看前缀）", inPool("free") === "cline-free/a,z-ai/glm-5.3-flash,cline-free/from-recommended", inPool("free"));
ok("pass 组归 pass 池", inPool("pass") === "cline-pass/b,openai/gpt-x", inPool("pass"));
ok("recommended 组按前缀兜底判池（上游不标注池归属）", parsed.some((e) => e.id === "cline-free/from-recommended" && e.pool === "free") && parsed.some((e) => e.id === "openai/gpt-x" && e.pool === "pass"), parsed);
ok("云池条目不收录（实测 403，广告一个必然失败的模型只会让客户端选中后报错）", !parsed.some((e) => e.id === "cline-cloud/y"));
ok("friendlyAlias 只剥池前缀，不剥承载方前缀（z-ai/... 剥了就是上游不存在的名字）",
  clineModels.friendlyAlias("cline-pass/kimi-k3") === "kimi-k3" && clineModels.friendlyAlias("z-ai/glm-5.3-flash") === null);
ok("同 id 只留第一条（四组之间有重叠，去重防目录里出现两份）",
  clineModels.parseRecommended({ free: [{ id: "x/y" }], recommended: [{ id: "x/y" }] }).length === 1);

console.log("scanCline:");
const discovery = require("../electron/backend/proxy/discovery.cjs");
os.homedir = () => fakeHome; // Task 2 已造 ~/.cline/data/settings/providers.json 夹具
const cands = discovery.scanAll().filter((c) => c.channel.startsWith("cline_"));
os.homedir = () => path.join(fakeHome, "empty");
// 两池各一条候选是 fork 的真实缺口修补：扫描弹窗按「当前正在新增的渠道」过滤候选
//（ProxyAgentsView 的 scanRows），单候选 = cline_pass 那页永远扫不出本机登录态。
ok("两池各产一条候选（不猜池）", cands.map((c) => c.channel).join(",") === "cline_free,cline_pass", cands.map((c) => c.channel));
ok("两条候选是同一份桌面登录态（同 uid / 带前缀 token / 同源文件），导入哪条就落哪个池",
  cands.length === 2 && cands.every((c) => c.uid === "usr-9" && String(c.token).startsWith("workos:") && c.file === "providers.json" && c.source === "scan"), cands[0]);
ok("池被关时不产该池候选（channelOn 门禁）", (() => {
  const realOn = adapters.channelOn;
  adapters.channelOn = (ch) => (ch === "cline_pass" ? false : realOn(ch));
  os.homedir = () => fakeHome;
  try {
    return discovery.scanAll().filter((c) => c.channel.startsWith("cline_")).map((c) => c.channel).join(",") === "cline_free";
  } finally {
    adapters.channelOn = realOn;
    os.homedir = () => path.join(fakeHome, "empty");
  }
})());

// fetchModels 全链路用假 fetch 注入夹具（httpJson 走全局 fetch），不发真实网络请求
console.log("cline fetchModels（假 fetch 夹具，不发真实网络）:");
const RECOMMENDED_FIXTURE = {
  recommended: [{ id: "openai/gpt-x", name: "GPT-X" }],
  free: [{ id: "cline-free/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (免费)" }, { id: "z-ai/glm-5.3-flash", name: "GLM-5.3-Flash (免费)" }],
  clinePass: [{ id: "cline-pass/kimi-k3", name: "Kimi K3 (ClinePass)" }, { id: "whatever/not-in-catalog", name: "Not In Catalog" }],
  clineCloud: [{ id: "cline-cloud/y", name: "Cloud Y" }],
};
let lastReq = null;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => { lastReq = { url, opts }; return { ok: true, status: 200, text: async () => JSON.stringify(RECOMMENDED_FIXTURE) }; };
(async () => {
  const fmFree = await free.fetchModels();
  ok("请求 URL 是 recommended-models（apiBase 只有单层 v1，拼成 /v1/v1/ 实测 404）", lastReq && lastReq.url === "https://api.cline.bot/api/v1/ai/cline/recommended-models", lastReq && lastReq.url);
  ok("目录请求不带 authorization（实测免鉴权，也是 modelsNeedAuth 的实现面）",
    !!lastReq && !("authorization" in lastReq.opts.headers) && lastReq.opts.headers["x-client-type"] === "cline-sdk", lastReq && lastReq.opts.headers);
  ok("free 池只收 free 组两条（recommended/cloud 不混进来）", fmFree.ok === true && fmFree.models.map((m) => m.id).join(",") === "cline-free/deepseek-v4.1-flash,z-ai/glm-5.3-flash", fmFree);
  const fmP = await passAd.fetchModels();
  ok("pass 池收 clinePass 组 + recommended 里其余条目（无池信息按前缀兜底归 pass）", (() => {
    const ids = fmP.models.map((m) => m.id);
    return fmP.ok === true && ids.join(",") === "cline-pass/kimi-k3,whatever/not-in-catalog,openai/gpt-x";
  })(), fmP);
  ok("目录条目只给 id/name 与能力声明，元数据不由这次拉取回填（rate 恒 null、contextLength 恒 0）", (() => {
    const one = fmFree.models.find((m) => m.id === "z-ai/glm-5.3-flash");
    return one.rate === null && one.contextLength === 0 && one.maxOutputTokens === 0 && one.capabilities.images === true && one.capabilities.reasoning === true && one.capabilities.tools === true;
  })(), fmFree.models);

  globalThis.fetch = async () => ({ ok: false, status: 500, text: async () => "boom" });
  const fm500 = await free.fetchModels();
  ok("上游 500 → ok:false 且文案带状态码（管道失败不写空目录）", fm500.ok === false && /模型目录 HTTP 500/.test(fm500.message), fm500);
  globalThis.fetch = async () => { throw new Error("net down"); };
  const fmNet = await free.fetchModels();
  ok("网络异常 → ok:false 带 HTTP 0 与原因", fmNet.ok === false && /模型目录 HTTP 0/.test(fmNet.message) && /net down/.test(fmNet.message), fmNet);
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => "{}" });
  const fmEmpty = await free.fetchModels();
  ok("响应里没有本池可用模型 → ok:false 如实说空", fmEmpty.ok === false && /本池/.test(fmEmpty.message), fmEmpty);

  // ===== fork 独有语义：scan 来源账号续期前回读桌面端 providers.json =====
  // 上游 refresh.cjs 是纯 httpJson，没有这条；这里必须**观测出站请求**才能证明包装真的生效，
  // 只断言「返回值 ok」的话包装即使是空转也会绿。
  console.log("scan 来源账号续期回读桌面端（fork 独有语义）:");
  const liveHome = fs.mkdtempSync(path.join(os.tmpdir(), "cline-scan-home-"));
  fs.mkdirSync(path.join(liveHome, ".cline", "data", "settings"), { recursive: true });
  fs.writeFileSync(path.join(liveHome, ".cline", "data", "settings", "providers.json"), JSON.stringify({
    providers: { cline: { settings: { auth: {
      accessToken: mkJwt({ external_id: "usr-9", exp: 1893456000 }),
      refreshToken: "rt-live", accountId: "usr-9",
    } } } },
  }));
  const realHome2 = os.homedir;
  const refreshBodies = [];
  globalThis.fetch = async (url, opts) => {
    refreshBodies.push({ url, body: opts && opts.body });
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: { accessToken: "eyJh.eyJj.c", refreshToken: "rt-rotated", expiresAt: 1893456000000 }, success: true }) };
  };
  const rtCall = async (account) => free.refreshToken(account, { token: "workos:eyJh.eyJj.c", refreshToken: "rt-old" });
  let r;
  os.homedir = () => liveHome;
  r = await rtCall({ id: "s1", channel: "cline_free", uid: "usr-9", source: "scan" });
  os.homedir = realHome2;
  ok("scan 来源 + uid 对得上 ⇒ 出站用的是桌面端活 refreshToken",
    r.ok === true && JSON.parse(refreshBodies[0].body).refreshToken === "rt-live", refreshBodies[0]);
  ok("续期成功透传旋转后的双令牌与 expiresAt", r.token && String(r.token).startsWith("workos:") && r.refreshToken === "rt-rotated" && r.expiresAt === 1893456000000, r);
  os.homedir = () => liveHome;
  r = await rtCall({ id: "s2", channel: "cline_free", uid: "usr-DIFFERENT", source: "scan" });
  os.homedir = realHome2;
  ok("scan 来源但 uid 对不上 ⇒ 不回读（绝不把 A 号的活凭据续到 B 号头上）",
    r.ok === true && JSON.parse(refreshBodies[1].body).refreshToken === "rt-old", refreshBodies[1]);
  r = await rtCall({ id: "s3", channel: "cline_free", uid: "usr-9", source: "oauth" });
  ok("非 scan 来源不读桌面端文件（库里那份就是真相）",
    r.ok === true && JSON.parse(refreshBodies[2].body).refreshToken === "rt-old", refreshBodies[2]);
  ok("grantType 保持 camelCase（源实现 @cline/core 就发这个键名）",
    JSON.parse(refreshBodies[0].body).grantType === "refresh_token", refreshBodies[0]);
  refreshBodies.length = 0;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => "{}" });
  r = await free.refreshToken({ id: "x", uid: "u", source: "oauth" }, { token: "t", refreshToken: "rt" });
  ok("401 ⇒ authError:true（credits/pool 就认这一个标记，据此把账号标 relogin）", r.ok === false && r.authError === true && /重新登录/.test(r.message), r);

  // ===== Task 11：cline WorkOS 设备授权流（假 fetch + 假时钟：不发真实网络、不真等轮询间隔） =====
  console.log("workos 设备流轮询判定:");
  const W = discovery._workosPollVerdict;
  ok("200 带 token → done", W(200, { access_token: "a" }) === "done");
  ok("400 authorization_pending → pending", W(400, { error: "authorization_pending" }) === "pending");
  ok("400 slow_down → slow_down", W(400, { error: "slow_down" }) === "slow_down");
  ok("400 expired_token → expired", W(400, { error: "expired_token" }) === "expired");
  ok("400 access_denied → denied", W(400, { error: "access_denied" }) === "denied");

  console.log("cline 设备授权流（假 fetch + 假时钟）:");
  const store = require("../electron/backend/proxy/store.cjs");
  // 假时钟：setTimeout 只入队，drain() 手动按序触发，真实的 5s/6s 间隔一秒都不等；
  // clearTimeout 按 id 撤销（finishOAuth/cancelOAuth 都靠它）。每轮之后新排期的间隔记进 pollArms
  // （httpJson 自带的 60s 总超时定时器在同一轮 finally 里就被清掉，不会混进记录）
  const realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
  let timers = [], pollArms = [], timerSeq = 0;
  global.setTimeout = (fn, ms) => { const t = { id: ++timerSeq, fn, ms }; timers.push(t); return t.id; };
  global.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
  const drain = async (max = 20) => { let n = 0; while (timers.length && n < max) { n++; await timers.shift().fn(); pollArms.push(timers.length ? timers[0].ms : null); } };
  const resetClock = () => { timers = []; pollArms = []; };
  const restoreClock = () => { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; timers = []; pollArms = []; };

  const DEV_CLAIMS = { sub: "user_WORKOS", external_id: "usr-77", exp: 1893456000, metadata: { userInfo: { firstName: "Ming", lastName: "Li", email: "li@x.com" } } };
  const DEV_JWT = `eyJhbGciOiJSUzI1NiJ9.${b64url(DEV_CLAIMS)}.sig`; // 裸 JWT：落库时必须补 workos: 前缀
  const resp = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });
  const DEVICE_FIXTURE = {
    device_code: "dc-1", user_code: "WDMA-YTSP",
    verification_uri: "https://authkit.cline.bot/device",
    verification_uri_complete: "https://authkit.cline.bot/device?user_code=WDMA-YTSP",
    interval: 5, expires_in: 600,
  };
  let seen = [], polls = 0, done = null;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    if (url === "https://api.workos.com/user_management/authorize/device") return resp(200, DEVICE_FIXTURE);
    if (url === "https://api.workos.com/user_management/authenticate") {
      polls++;
      if (polls === 1) return resp(400, { error: "authorization_pending" });
      if (polls === 2) return resp(400, { error: "slow_down" });
      return resp(200, { access_token: DEV_JWT, refresh_token: "rt-workos", expires_in: 3600 });
    }
    if (url === "https://api.cline.bot/api/v1/auth/register") return resp(200, { data: { accessToken: DEV_JWT, refreshToken: "rt-cline", accountId: "usr-77", expiresAt: 1893456000000 }, success: true });
    return resp(500, { error: "unexpected" });
  };
  const r1 = await discovery.beginOAuth("cline_free", {}, (x) => { done = x; });
  ok("begin 返回 mode=device + userCode + verification_uri_complete（免手输）", r1.ok === true && r1.mode === "device" && r1.userCode === "WDMA-YTSP" && r1.url === "https://authkit.cline.bot/device?user_code=WDMA-YTSP", r1);
  ok("发起请求逐字：POST form-urlencoded 且 body 只有 client_id", seen[0].opts.method === "POST" && seen[0].opts.body === "client_id=client_01K3A541FN8TA3EPPHTD2325AR" && seen[0].opts.headers["content-type"] === "application/x-www-form-urlencoded", seen[0] && seen[0].opts);
  ok("首轮轮询间隔 = 上游 interval × 1000", timers.length === 1 && timers[0].ms === 5000, timers.map((t) => t.ms));
  ok("会话进行中拒绝第二次登录（单飞）", await discovery.beginOAuth("cline_free", {}, () => {}).then(() => false, (e) => /已有进行中的登录/.test(e.message)));
  ok("设备流不接受粘贴回调地址", (await discovery.submitCallbackUrl("http://127.0.0.1:17388/authorize", "cline_free")).message === "设备授权无需粘贴回调地址，请在授权页确认后回到本窗口等待");
  await drain();
  ok("pending → slow_down → done 三轮后登录成功", !!done && done.ok === true && done.uid === "usr-77" && done.pool === "free" && !!done.id, done);
  ok("slow_down 使间隔 +1s（pending 仍 5000 → slow_down 后 6000 → done 不再排期）", JSON.stringify(pollArms) === JSON.stringify([5000, 6000, null]), pollArms);
  const authReq = seen.find((s) => s.url.endsWith("/user_management/authenticate"));
  ok("轮询请求体逐字：device_code URN + device_code + client_id", authReq.opts.body === "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code&device_code=dc-1&client_id=client_01K3A541FN8TA3EPPHTD2325AR", authReq.opts.body);
  const regReq = seen.find((s) => s.url === "https://api.cline.bot/api/v1/auth/register");
  ok("必做第四步 auth/register：x-client-type: cline-sdk 且透传 WorkOS 双令牌", !!regReq && regReq.opts.headers["x-client-type"] === "cline-sdk" && JSON.parse(regReq.opts.body).accessToken === DEV_JWT && JSON.parse(regReq.opts.body).refreshToken === "rt-workos", regReq && regReq.opts);
  const clineRows = store.accountRows("cline_free");
  const clineSec = clineRows.length ? store.accountSecrets(clineRows[0]) : {};
  ok("落库 cline_free：uid=external_id、展示名西式名、token 补 workos: 前缀", clineRows.length === 1 && clineRows[0].uid === "usr-77" && clineRows[0].name === "Ming Li" && clineSec.token === "workos:" + DEV_JWT && clineRows[0].expires_at === 1893456000000, clineRows[0] && { uid: clineRows[0].uid, name: clineRows[0].name, token: clineSec.token });
  // 前缀只属于 accessToken（协议参考 §1.3 口径 1 / §1.7 桌面端样例）：adapters 的 refreshToken 把存的原样发给
  // /auth/refresh，scan 来源存的就是裸值，登录来源必须一致，否则一小时后刷新必 401
  ok("refreshToken 存裸值不加 workos: 前缀", clineSec.refreshToken === "rt-cline", clineSec.refreshToken);
  ok("登录来源标 source=oauth", clineRows.length === 1 && clineRows[0].source === "oauth", clineRows[0] && clineRows[0].source);

  // 换池登录 → 落 cline_pass；同渠道同 uid 再登录 → 更新凭据不新建（与 importCandidate 同语义）
  const DEV_JWT2 = `eyJh.${b64url({ ...DEV_CLAIMS, exp: 1900000000 })}.sig`;
  const passScript = async (url, opts) => {
    seen.push({ url, opts });
    if (url.endsWith("/authorize/device")) return resp(200, { ...DEVICE_FIXTURE, device_code: "dc-2", user_code: "QRST-5678" });
    if (url.endsWith("/user_management/authenticate")) return resp(200, { access_token: DEV_JWT2, refresh_token: "rt-workos2" });
    if (url.endsWith("/auth/register")) return resp(200, { data: { accessToken: DEV_JWT2, refreshToken: "rt-cline2", accountId: "usr-77", expiresAt: 1900000000000 } });
    return resp(500, {});
  };
  resetClock(); done = null; seen = [];
  globalThis.fetch = passScript;
  await discovery.beginOAuth("cline_pass", {}, (x) => { done = x; });
  await drain();
  const passRows1 = store.accountRows("cline_pass");
  ok("pass 渠道登录落 cline_pass 且 pool 透出（两池同凭证、不同渠道各一条）", !!done && done.ok === true && done.pool === "pass" && passRows1.length === 1 && store.accountRows("cline_free").length === 1, { done, pass: passRows1.length });
  resetClock(); done = null;
  await discovery.beginOAuth("cline_pass", {}, (x) => { done = x; });
  await drain();
  const passRows2 = store.accountRows("cline_pass");
  ok("同渠道同 uid 二次登录：更新凭据而不新建", !!done && done.ok === true && done.id === passRows1[0].id && passRows2.length === 1 && store.accountSecrets(passRows2[0]).token === "workos:" + DEV_JWT2 && store.accountSecrets(passRows2[0]).refreshToken === "rt-cline2", { done, n: passRows2.length });

  // 上游终态与异常的错误映射
  const failFlow = async (pollResp, wantMsg) => {
    resetClock(); polls = 0; done = null;
    globalThis.fetch = async (url) => {
      if (url.endsWith("/authorize/device")) return resp(200, DEVICE_FIXTURE);
      if (url.endsWith("/user_management/authenticate")) return resp(pollResp.status, pollResp.body);
      return resp(500, {});
    };
    await discovery.beginOAuth("cline_free", {}, (x) => { done = x; });
    await drain();
    return !!done && done.ok === false && done.message === wantMsg;
  };
  ok("expired_token → 「设备码已过期，请重新发起登录」", await failFlow({ status: 400, body: { error: "expired_token" } }, "设备码已过期，请重新发起登录"), done);
  ok("access_denied → 「你在授权页拒绝了本次登录」", await failFlow({ status: 400, body: { error: "access_denied" } }, "你在授权页拒绝了本次登录"), done);
  ok("换会话令牌失败 → 透出 HTTP 状态", await (async () => {
    resetClock(); done = null;
    globalThis.fetch = async (url) => {
      if (url.endsWith("/authorize/device")) return resp(200, DEVICE_FIXTURE);
      if (url.endsWith("/user_management/authenticate")) return resp(200, { access_token: DEV_JWT, refresh_token: "rt-workos" });
      return resp(500, { error: "boom" });
    };
    await discovery.beginOAuth("cline_free", {}, (x) => { done = x; });
    await drain();
    return !!done && done.ok === false && /换会话令牌失败（HTTP 500）/.test(done.message);
  })(), done);
  ok("超时（deadline 过了）→ 「登录超时」", await (async () => {
    resetClock(); done = null;
    globalThis.fetch = async (url) => (url.endsWith("/authorize/device") ? resp(200, { ...DEVICE_FIXTURE, expires_in: 60 }) : resp(400, { error: "authorization_pending" }));
    const realNow = Date.now;
    await discovery.beginOAuth("cline_free", {}, (x) => { done = x; });
    Date.now = () => realNow() + 7200000; // 假时钟推进 2 小时，越过 deadline（expires_in 60 与 3 分钟取大）
    try { await drain(); } finally { Date.now = realNow; }
    return !!done && done.ok === false && done.message === "登录超时" && timers.length === 0;
  })(), done);
  ok("发起请求网络异常 → ok:false 且不留会话", await (async () => {
    resetClock();
    globalThis.fetch = async () => { throw new Error("net down"); };
    const r = await discovery.beginOAuth("cline_free", {}, () => {});
    return r.ok === false && r.message === "设备授权发起失败（HTTP 0）" && discovery.cancelOAuth() === false;
  })());

  ok("换到会话令牌但无账号标识（external_id 与 accountId 双缺）→ 报错不落空 uid 账号", await (async () => {
    resetClock(); done = null;
    const NOID_JWT = `eyJh.${b64url({ sub: "user_NOID", exp: 1900000000 })}.sig`;
    globalThis.fetch = async (url) => {
      if (url.endsWith("/authorize/device")) return resp(200, DEVICE_FIXTURE);
      if (url.endsWith("/authenticate")) return resp(200, { access_token: NOID_JWT, refresh_token: "rt-n", expires_in: 3600 });
      if (url.endsWith("/auth/register")) return resp(200, { data: { accessToken: NOID_JWT, refreshToken: "rt-c" }, success: true });
      return resp(500, {});
    };
    await discovery.beginOAuth("cline_free", {}, (x) => { done = x; });
    await drain();
    return !!done && done.ok === false && /账号标识/.test(done.message) && !store.listAccounts("cline_free").some((a) => !a.uid);
  })(), done);

  console.log("beginOAuth 渠道分派:");
  // Task 12 已接管 autoclaw_intl：原「下一任务接入」占位断言改为钉真流程的入口行为——
  // 第一次调用不带滑块参数只回滑块配置（renderer 据此弹滑块），完整回环回调/换码链在 dev-autoclaw-test.cjs 覆盖
  ok("autoclaw_intl 首次调用回 needCaptcha + 滑块配置且不留会话", await (async () => {
    globalThis.fetch = async (url) => (url === "https://autoglm-api.autoglm.ai/userapi/overseasv1/oauth-captcha-config"
      ? resp(200, { code: 0, message: "ok", data: { enabled: true, region: "cn-hangzhou", prefix: "pfx", scene_id: "sq51tr", captcha_supplier: "aliyun" } })
      : resp(500, {}));
    const r = await discovery.beginOAuth("autoclaw_intl", {}, () => {});
    return r.ok === true && r.needCaptcha === true && r.captcha.region === "cn-hangzhou" && r.captcha.sceneId === "sq51tr" && r.captcha.supplier === "aliyun" && discovery.cancelOAuth() === false;
  })(), "autoclaw_intl 入口未接入真流程");
  ok("autoclaw_intl vendor 白名单（占位文案已被真流程取代，且这一步不打网络）", await (async () => {
    const r = await discovery.beginOAuth("autoclaw_intl", { vendor: "qq", captchaVerifyParam: "p" }, () => {});
    return r.ok === false && r.message === "vendor 只支持 zai / google";
  })());
  ok("autoclaw（国内）没有网页登录 → 明确抛错引导导入", await discovery.beginOAuth("autoclaw", { edition: "cn" }, () => {}).then(() => false, (e) => /没有网页登录/.test(e.message)));
  // 旧两参签名兼容（第二参直接是回调）仍走到分派：小浣熊上游 v1.18.0 起支持应用内登录，
  // 故这里断言「返回 manual 模式会话」而不是「抛不支持」（本分支基点时还是抛错，合并后按上游事实改）
  ok("旧两参签名兼容（第二参直接是回调）仍走到分派", await discovery.beginOAuth("raccoon", () => {}).then(
    (r) => r.ok === true && r.mode === "manual" && /xiaohuanxiong\.com/.test(r.url || ""),
    () => false
  ));

  restoreClock();
  globalThis.fetch = realFetch;
})().then(() => {
  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
