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

// 装配面回归：上面手工造的 {key,is_reasoning,is_vl} 形状会掩盖真实形状（key 在 _key、能力在 capabilities）——
// 用 modelEntries 的产物直接喂信封，三个字段必须都归一化到位（否则真实上游收 "undefined" 与恒 false）
const envReal = adapters._qoderBody({
  internal: { messages: [{ role: "user", content: "hi" }], tools: [], max_tokens: 100 },
  modelEntry: qAd._resolveEntry("Qwen3.8-Flash"),
  ids, requestId: "rq-2", lastUserText: "hi",
});
ok("真实目录条目装配：key/is_reasoning/is_vl 全部归一化", envReal.model_config.key === "qfmodel" && envReal.model_config.is_reasoning === true && envReal.model_config.is_vl === true,
  envReal.model_config);

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
// 集成回归（smoke 发现的 _key/key 错位）：modelEntries 产物的上游 key 在 _key，chat 消费面读 key——
// _resolveEntry 归一化后两者必须相等，否则 x-model-key / model_config.key 会发 "undefined"
ok("_resolveEntry 产物补 key（chat 消费面）", qAd._resolveEntry("Qwen3.8-Flash").key === "qfmodel" && qAd._resolveEntry("Auto").key === "auto");

// catalog 同步分支（评审发现）：fetchModels 写回的 _key/_efforts 必须保留、不被展示 id 覆盖；DEFAULTS 条目无 _key 回落展示 id
const rules = require("../electron/backend/proxy/rules.cjs");
const catPath = path.join(rules.rulesDir(), "catalog.json");
rules.init(); // dev 环境无人调 init，ensureFiles 不会落盘——先落 DEFAULTS 再改夹具
const cat0 = JSON.parse(fs.readFileSync(catPath, "utf8"));
cat0.qoder.models.push(
  { id: "SyncedModel", name: "SyncedModel", rate: 1, capabilities: { images: false, reasoning: true, tools: true }, contextLength: 200000, maxOutputTokens: 0, _key: "synced-upstream-key", _efforts: ["low", "xhigh"] },
  { id: "DefaultsOnly", name: "DefaultsOnly", rate: 1, capabilities: { images: false, reasoning: false, tools: true }, contextLength: 200000, maxOutputTokens: 0 }
);
fs.writeFileSync(catPath, JSON.stringify(cat0));
rules.reload("catalog.json");
ok("catalog 同步 _key 保留（upstreamFor）", qAd.upstreamFor("SyncedModel") === "synced-upstream-key");
ok("catalog 同步 _key 保留（chat 消费面）", qAd._resolveEntry("SyncedModel").key === "synced-upstream-key" && JSON.stringify(qAd._resolveEntry("SyncedModel")._efforts) === JSON.stringify(["low", "xhigh"]));
ok("目录条目无 _key 回落展示 id", qAd.upstreamFor("DefaultsOnly") === "DefaultsOnly" && qAd._resolveEntry("DefaultsOnly").key === "DefaultsOnly");
ok("refreshToken 3 段打包串走 center 刷新路径", typeof qAd.refreshToken === "function");

// ===== Task 11：qoder PKCE 设备授权流（假 fetch + 假时钟：不发真实网络、不真等 2s 轮询间隔） =====
console.log("qoder 登录辅助:");
const crypto = require("node:crypto");
const discovery = require("../electron/backend/proxy/discovery.cjs");
const store = require("../electron/backend/proxy/store.cjs");
ok("region 归一", discovery._qoderRegionOfMode("cn") === "cn" && discovery._qoderRegionOfMode("intl") === "global" && discovery._qoderRegionOfMode("") === "global");

// 假时钟：setTimeout 只入队，drain() 手动按序触发，2s 间隔一秒都不等；每轮之后新排期的间隔记进
// pollArms（httpJson 自带的 60s 总超时定时器在同一轮 finally 里就被清掉，不会混进记录）
const realSetTimeout = global.setTimeout, realClearTimeout = global.clearTimeout;
let timers = [], pollArms = [], timerSeq = 0;
global.setTimeout = (fn, ms) => { const t = { id: ++timerSeq, fn, ms }; timers.push(t); return t.id; };
global.clearTimeout = (id) => { timers = timers.filter((t) => t.id !== id); };
const drain = async (max = 20) => { let n = 0; while (timers.length && n < max) { n++; await timers.shift().fn(); pollArms.push(timers.length ? timers[0].ms : null); } };
const resetClock = () => { timers = []; pollArms = []; };
const restoreClock = () => { global.setTimeout = realSetTimeout; global.clearTimeout = realClearTimeout; timers = []; pollArms = []; };

const resp = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });
let seen = [], polls = 0, done = null;
const realFetch = globalThis.fetch;

;(async () => {
  // 中国区：404 → 202（都算「还没确认」）→ 200 出票
  resetClock(); seen = []; polls = 0; done = null;
  const cnScript = [
    { status: 404, body: { message: "not found" } },
    { status: 202, body: {} },
    { status: 200, body: { token: "q-access", refresh_token: "q-rt", user_id: "uid-q-1", expires_at: 1893456000000 } },
  ];
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    if (url.includes("/api/v1/deviceToken/poll")) {
      const step = cnScript[Math.min(polls, cnScript.length - 1)];
      polls++;
      return resp(step.status, step.body);
    }
    if (url.includes("/api/v1/userinfo")) return resp(200, { data: { id: "uid-q-1", nickname: "小明", email: "x@q.com" } });
    return resp(500, { message: "unexpected" });
  };
  const r = await discovery.beginOAuth("qoder", { edition: "cn" }, (x) => { done = x; });
  ok("begin 返回设备流（qoder 无用户码 → userCode 空串），授权页落 cn 域", r.ok === true && r.mode === "device" && r.userCode === "" && /^https:\/\/qoder\.com\.cn\/device\/selectAccounts\?/.test(r.url), r);
  const authQ = new URL(r.url);
  ok("授权页参数齐：challenge / challenge_method=S256 / machine_id / nonce", !!authQ.searchParams.get("challenge") && authQ.searchParams.get("challenge_method") === "S256" && !!authQ.searchParams.get("machine_id") && !!authQ.searchParams.get("nonce"), r.url);
  ok("轮询起始间隔 2s", timers.length === 1 && timers[0].ms === 2000, timers.map((t) => t.ms));
  await drain();
  const pol = seen.find((s) => s.url.includes("/deviceToken/poll"));
  const polQ = new URL(pol.url);
  ok("轮询命中 cn 区 openapi 域且带 cosy 三件套", pol.url.startsWith("https://openapi.qoder.com.cn/api/v1/deviceToken/poll") && pol.opts.method === "GET" && pol.opts.headers["cosy-version"] === "1.0.1" && pol.opts.headers["cosy-clienttype"] === "5" && pol.opts.headers["user-agent"] === "qoder-local-proxy", pol && pol.opts && pol.opts.headers);
  ok("PKCE 配对：challenge = base64url(sha256(verifier))，轮询按 nonce+verifier+challenge_method=S256 回传", crypto.createHash("sha256").update(polQ.searchParams.get("verifier")).digest("base64url") === authQ.searchParams.get("challenge") && polQ.searchParams.get("challenge_method") === "S256" && polQ.searchParams.get("nonce") === authQ.searchParams.get("nonce") && authQ.searchParams.get("challenge").length === 43 && !authQ.searchParams.get("challenge").includes("="), { challenge: authQ.searchParams.get("challenge"), verifier: polQ.searchParams.get("verifier") });
  ok("202/404 继续轮且间隔恒为 2s，出票后不再排期", JSON.stringify(pollArms) === JSON.stringify([2000, 2000, null]), pollArms);
  ok("登录完成回调 ok:true 且 uid 取 userinfo.id", !!done && done.ok === true && done.uid === "uid-q-1", done);
  const acc1 = store.listAccounts("qoder").find((a) => a.uid === "uid-q-1");
  const row1 = store.accountRows("qoder").find((r0) => r0.uid === "uid-q-1");
  const sec1 = row1 ? store.accountSecrets(row1) : {};
  ok("落库 qoder：userinfo 补 name/email、token 原样、expires_at 用上游值", !!acc1 && acc1.name === "小明" && sec1.token === "q-access" && acc1.expiresAt === 1893456000000 && acc1.source === "oauth", acc1 && { name: acc1.name, exp: acc1.expiresAt });
  ok("refreshToken 打包成 <rt>|<user_id>|<machine_id> 三段（§3.7）", sec1.refreshToken === `q-rt|uid-q-1|${authQ.searchParams.get("machine_id")}`, sec1.refreshToken);
  ok("meta 带 mode/email/machine_id/user_id", !!acc1 && acc1.meta.mode === "cn" && acc1.meta.email === "x@q.com" && acc1.meta.user_id === "uid-q-1" && acc1.meta.machine_id === authQ.searchParams.get("machine_id"), acc1 && acc1.meta);

  // 国际区 + userinfo 失败：poll 已带 user_id，兜底不阻断登录
  resetClock(); seen = []; polls = 0; done = null;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    if (url.includes("/api/v1/deviceToken/poll")) return resp(200, { token: "q-access2", refresh_token: "q-rt2", user_id: "uid-q-2" });
    if (url.includes("/api/v1/userinfo")) return resp(500, { message: "boom" });
    return resp(500, {});
  };
  const rg = await discovery.beginOAuth("qoder", { edition: "intl" }, (x) => { done = x; });
  ok("edition=intl → global 区授权页", rg.ok === true && /^https:\/\/qoder\.com\/device\/selectAccounts\?/.test(rg.url), rg.url);
  await drain();
  const acc2 = store.listAccounts("qoder").find((a) => a.uid === "uid-q-2");
  const row2 = store.accountRows("qoder").find((r0) => r0.uid === "uid-q-2");
  ok("userinfo 失败仍落库（uid 用 poll 的 user_id、名兜底、到期缺省 now+30 天）", !!acc2 && acc2.name === "Qoder 账号" && acc2.meta.mode === "global" && seen.some((s) => s.url.startsWith("https://openapi.qoder.sh/api/v1/deviceToken/poll")) && row2.expires_at > Date.now() + 29 * 86400 * 1000, acc2 && { name: acc2.name, meta: acc2.meta, exp: row2.expires_at });

  // refresh_token 含 | 判无效（§2.3）→ 不落库、继续轮；取消后不再排期
  resetClock(); seen = []; polls = 0; done = null;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return url.includes("/api/v1/deviceToken/poll") ? resp(200, { token: "t", refresh_token: "pat|a|b", user_id: "uid-q-3" }) : resp(500, {});
  };
  await discovery.beginOAuth("qoder", {}, (x) => { done = x; });
  await drain(4);
  ok("refresh_token 含 | 判无效 → 不落库并继续轮", done === null && pollArms.length === 4 && pollArms.every((ms) => ms === 2000) && !store.listAccounts("qoder").some((a) => a.uid === "uid-q-3"), { done, pollArms });
  ok("取消登录撤销轮询", discovery.cancelOAuth() === true && timers.length === 0);

  // poll 缺 user_id 且 userinfo 失败 → 必须报错（§2.5 容忍规则）：空 uid 会跳过同 uid 查找，重登就堆「未命名账号」
  resetClock(); seen = []; polls = 0; done = null;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return url.includes("/api/v1/deviceToken/poll") ? resp(200, { token: "t", refresh_token: "rt-no-uid" }) : resp(500, {});
  };
  await discovery.beginOAuth("qoder", {}, (x) => { done = x; });
  await drain();
  ok("poll 缺 user_id 且 userinfo 失败 → 报错且不落空 uid 账号", !!done && done.ok === false && /user_id/.test(done.message) && !store.listAccounts("qoder").some((a) => !a.uid), done);

  // expires_at 秒形态必须认（§3.7 毫秒|秒|RFC3339 自动识别）；此路径 poll 带 user_id，userinfo 失败可容忍
  resetClock(); seen = []; polls = 0; done = null;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return url.includes("/api/v1/deviceToken/poll") ? resp(200, { token: "q-access4", refresh_token: "q-rt4", user_id: "uid-q-4", expires_at: 1893456000 }) : resp(500, {});
  };
  await discovery.beginOAuth("qoder", {}, (x) => { done = x; });
  await drain();
  const row4 = store.accountRows("qoder").find((r0) => r0.uid === "uid-q-4");
  ok("expires_at 秒形态识别为毫秒且容忍 userinfo 失败", !!done && done.ok === true && !!row4 && row4.expires_at === 1893456000000, { done, exp: row4 && row4.expires_at });

  restoreClock();
  globalThis.fetch = realFetch;
})().then(() => {
  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
