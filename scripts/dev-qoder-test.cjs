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

// ===== 0. 自签模块装配（归一移植地基：导出面齐备 + 地区由渠道 id 定 + 调用元数不变） =====
// 元数必须与 adapters._qoder* 的历史形状逐字一致：下方约 40 条既有断言按无注入签名调用，
// 一旦改成参数注入它们会全红——那是安全网，不是待重写对象。
console.log("qoderSelfSign 模块装配:");
const qSelf = require("../electron/backend/proxy/qoderSelfSign.cjs");
ok("自签模块导出面齐备", ["REGIONS","PRODUCT_REGION","machineId","classify","statusCodeOf","unpack","ids","envelope","TagSplitter","jwtUserInfo","FALLBACK","CHAT_PATH","MODEL_LIST_PATH","REFRESH_PATH"].every((k) => qSelf[k] !== undefined), ["REGIONS","PRODUCT_REGION","machineId","classify","statusCodeOf","unpack","ids","envelope","TagSplitter","jwtUserInfo","FALLBACK","CHAT_PATH","MODEL_LIST_PATH","REFRESH_PATH"].filter((k) => qSelf[k] === undefined));
ok("地区按渠道 id 判定（qoder=CN，qoder_intl=Global）", qSelf.PRODUCT_REGION.qoder === "cn" && qSelf.PRODUCT_REGION.qoder_intl === "global");
ok("statusCodeOf 两侧信封都吃", qSelf.statusCodeOf({ statusCodeValue: 403 }) === 403 && qSelf.statusCodeOf({ statusCode: "UNAUTHORIZED" }) === 401 && qSelf.statusCodeOf({ statusCode: "OK" }) === 0);
ok("纯函数保持历史调用元数（ids/unpack 不注入，machineId 无参）", qSelf.ids({ userId: "u1", upstreamKey: "qfmodel", maxTokens: 32768 }).sessionId.length > 0 && qSelf.unpack({ statusCodeValue: 200, body: "{}" }).ok === true && qSelf.jwtUserInfo.length === 1 && qSelf.machineId.length === 0);

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

// 装配面回归：手工造的 {key,is_reasoning,is_vl} 字面量会掩盖真实形状（上游目录条目是
// id + capabilities.{reasoning,images}）——用**上游 modelMeta 的产物形状**过一遍转换函数再喂信封，
// 三个字段必须都归一到位，否则真实上游收 "undefined" 与恒 false。
// （归一移植前这条走 qAd._resolveEntry；fork 内联适配器删除后，同一接缝住在
//   qoderSelfSign.selfSignEntryFromMeta，由 qoderAdapter 的签名回落分支调用。）
const mmShape = {
  id: "qfmodel", name: "Qwen3.8-Flash", rate: 0.1,
  capabilities: { reasoning: true, tools: true, images: true },
  reasoning: { effort: null, defaultEffort: "", supportedEfforts: ["low", "xhigh"] },
  contextLength: 200000, maxOutputTokens: 0,
};
const convEntry = qSelf.selfSignEntryFromMeta(mmShape, "qfmodel");
const envReal = adapters._qoderBody({
  internal: { messages: [{ role: "user", content: "hi" }], tools: [], max_tokens: 100 },
  modelEntry: convEntry,
  ids, requestId: "rq-2", lastUserText: "hi",
});
ok("上游目录条目 → 自签入口：key/is_reasoning/is_vl 全部归一化", convEntry.key === "qfmodel" && convEntry.is_reasoning === true && convEntry.is_vl === true && JSON.stringify(convEntry.efforts) === JSON.stringify(["low", "xhigh"]), convEntry);
ok("真实目录条目装配：model_config 收到真 key", envReal.model_config.key === "qfmodel" && envReal.model_config.is_reasoning === true && envReal.model_config.is_vl === true,
  envReal.model_config);
ok("目录缺能力位时保守归一（不编造能力）", (() => { const e = qSelf.selfSignEntryFromMeta({ id: "x", capabilities: {} }, "x"); return e.is_reasoning === false && e.is_vl === false && Array.isArray(e.efforts) && e.efforts.length === 0; })());

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

console.log("qoder 适配器注册形状（归一移植后：上游 qoderAdapter 是生产主路径）:");
const Q_NEED = ["cfg", "models", "fetchModels", "headers", "rewriteBody", "chat", "queryCredits", "refreshToken"];
ok("qoder 已注册", !!qAd);
ok("八件套齐备（与 proxy-smoke 同判据）", Q_NEED.every((k) => typeof qAd[k] === "function"), Q_NEED.filter((k) => typeof qAd[k] !== "function"));
// discovery 的导入/扫描路径是 adapter.userInfo(token).catch(...)——方法不存在抛的是同步 TypeError，
// 链上的 .catch 兜不住，表现为「导入 qoder 账号直接崩」。上游适配器本来没有这个方法，属 fork-port 补件。
ok("userInfo 在位（防导入路径同步崩）", typeof qAd.userInfo === "function");
// credits.cjs 只在 util.jwtDecode(token).exp 存在时按此窗口预刷：自签账号是 JWT，24h 窗口会把
// 每轮额度刷新都变成一次 token 轮换；dt- 无 exp 不受影响，故统一取 300s。
ok("refreshWindowSec=300", qAd.refreshWindowSec === 300);
ok("模型 id 是上游 key 而非展示名", qAd.models().includes("dfmodel") && !qAd.models().some((m) => /[^a-z0-9_]/.test(String(m))), qAd.models());
ok("headers() 不含 Authorization（签名每请求在 chat 内现产）", !("authorization" in qAd.headers()));
ok("rewriteBody 把请求模型落进 model_config.key", qAd.rewriteBody("dfmodel", { messages: [{ role: "user", content: "x" }] }, { uid: "u" }, {}).model_config.key === "dfmodel");
ok("自签纯函数仍从 adapters 转出（discovery 取 _qoderMachineId）", typeof adapters._qoderMachineId === "function" && typeof adapters._qoderClassify === "function" && typeof adapters._TagSplitter === "function");

// ===== Task 11：qoder PKCE 设备授权流（假 fetch + 假时钟：不发真实网络、不真等 2s 轮询间隔） =====
console.log("qoder 登录辅助:");
const crypto = require("node:crypto");
const discovery = require("../electron/backend/proxy/discovery.cjs");
const store = require("../electron/backend/proxy/store.cjs");
ok("region 归一", discovery._qoderRegionOfMode("cn") === "cn" && discovery._qoderRegionOfMode("intl") === "global" && discovery._qoderRegionOfMode("") === "global");

// ===== machineId 键名口径（读侧只认 meta.machineId，写侧历史上只写 machine_id）=====
// 读侧：qoderAdapter 五处（签名头 Cosy-MachineId、续期、风控身份）全读 account.meta.machineId；
// 写侧：本机扫描导入写 machineId，而 OAuth 登录只写 machine_id ⇒ 网页登录的 Qoder 号
// machineId 恒空，签名用的是另一个来源的机器码。双写是零迁移的收口方式。
ok("OAuth meta 双写 machineId / machine_id（读侧只认前者）", (() => {
  const f = discovery._qoderOauthMetaForTest;
  if (typeof f !== "function") return false; // 未导出时报 ✗ 而不是抛穿整个文件（后面还有 40 条断言）
  const m = f("m-42", "cn", "a@b.c", "u-7");
  return m.machineId === "m-42" && m.machine_id === "m-42" && m.mode === "cn" && m.user_id === "u-7";
})(), typeof discovery._qoderOauthMetaForTest === "function" ? JSON.stringify(discovery._qoderOauthMetaForTest("m-42", "cn", "a@b.c", "u-7")) : "没有 _qoderOauthMetaForTest 导出");
// 这条防的是「把读侧改成二选一」那种假修：读侧保持只认 machineId，双写才有意义。
ok("读侧仍只认 meta.machineId（不得改成 machine_id 兜底来糊弄双写）", (() => {
  const src = fs.readFileSync(path.join(__dirname, "..", "electron/backend/proxy/qoderAdapter.cjs"), "utf8");
  return /meta\.machineId/.test(src) && !/meta\.machine_id/.test(src);
})());

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
  const rg = await discovery.beginOAuth("qoder", { edition: "cn" }, (x) => { done = x; });
  ok("edition=cn 授权页落 cn 域", rg.ok === true && /^https:\/\/qoder\.com\.cn\/device\/selectAccounts\?/.test(rg.url), rg.url);
  await drain();
  const acc2 = store.listAccounts("qoder").find((a) => a.uid === "uid-q-2");
  const row2 = store.accountRows("qoder").find((r0) => r0.uid === "uid-q-2");
  ok("userinfo 失败仍落库（uid 用 poll 的 user_id、名兜底、到期缺省 now+30 天）", !!acc2 && acc2.name === "Qoder 账号" && acc2.meta.mode === "cn" && seen.some((s) => s.url.startsWith("https://openapi.qoder.com.cn/api/v1/deviceToken/poll")) && row2.expires_at > Date.now() + 29 * 86400 * 1000, acc2 && { name: acc2.name, meta: acc2.meta, exp: row2.expires_at });

  // 区服由**渠道 id** 决定（qoder=CN / qoder_intl=global），edition 这个登录参数不再被读。
  const ri = await discovery.beginOAuth("qoder", { edition: "intl" }, () => {});
  ok("qoder 渠道即使带 edition=intl 也落 CN 授权页（区服跟随渠道 id）", ri.ok === true && /^https:\/\/qoder\.com\.cn\/device\/selectAccounts\?/.test(ri.url), ri.url || ri);
  await drain();

  // 国际版是独立渠道（store.QODER_INTL_ENABLED=true 后它真的注册了）：授权页与轮询都落 global 区，
  // 账号进 qoder_intl 池而不是混进 CN 池。开关若被关回去，beginOAuth 会回「未知渠道」，
  // 这两条一起红——它们同时是「渠道已接入」和「区服不再读登录参数」的证据。
  resetClock(); seen = []; polls = 0; done = null;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    if (url.includes("/api/v1/deviceToken/poll")) return resp(200, { token: "i-access", refresh_token: "i-rt", user_id: "uid-i-1" });
    if (url.includes("/api/v1/userinfo")) return resp(200, { data: { id: "uid-i-1", nickname: "Intl User", email: "i@q.com" } });
    return resp(500, {});
  };
  const rint = await discovery.beginOAuth("qoder_intl", {}, (x) => { done = x; });
  ok("国际版渠道已注册：授权页落 global 门户（qoder.com）", rint.ok === true && /^https:\/\/qoder\.com\/device\/selectAccounts\?/.test(rint.url), rint.url || rint);
  await drain();
  const polInt = seen.find((s) => s.url.includes("/deviceToken/poll"));
  ok("国际版轮询打 global 区 openapi 域（不借 CN 的域）", !!polInt && polInt.url.startsWith("https://openapi.qoder.sh/api/v1/deviceToken/poll"), polInt && polInt.url);
  const accInt = store.listAccounts("qoder_intl").find((a) => a.uid === "uid-i-1");
  ok("国际版账号落 qoder_intl 池且 meta.mode=global", !!accInt && accInt.meta.mode === "global" && !store.listAccounts("qoder").some((a) => a.uid === "uid-i-1"), accInt && accInt.meta);

  // refresh_token 含 | 判无效（§2.3）→ 不落库、继续轮；取消后不再排期
  resetClock(); seen = []; polls = 0; done = null;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return url.includes("/api/v1/deviceToken/poll") ? resp(200, { token: "t", refresh_token: "pat|a|b", user_id: "uid-q-3" }) : resp(500, {});
  };
  await discovery.beginOAuth("qoder", { edition: "cn" }, (x) => { done = x; });
  await drain(4);
  ok("refresh_token 含 | 判无效 → 不落库并继续轮", done === null && pollArms.length === 4 && pollArms.every((ms) => ms === 2000) && !store.listAccounts("qoder").some((a) => a.uid === "uid-q-3"), { done, pollArms });
  ok("取消登录撤销轮询", discovery.cancelOAuth() === true && timers.length === 0);

  // poll 缺 user_id 且 userinfo 失败 → 必须报错（§2.5 容忍规则）：空 uid 会跳过同 uid 查找，重登就堆「未命名账号」
  resetClock(); seen = []; polls = 0; done = null;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return url.includes("/api/v1/deviceToken/poll") ? resp(200, { token: "t", refresh_token: "rt-no-uid" }) : resp(500, {});
  };
  await discovery.beginOAuth("qoder", { edition: "cn" }, (x) => { done = x; });
  await drain();
  ok("poll 缺 user_id 且 userinfo 失败 → 报错且不落空 uid 账号", !!done && done.ok === false && /user_id/.test(done.message) && !store.listAccounts("qoder").some((a) => !a.uid), done);

  // expires_at 秒形态必须认（§3.7 毫秒|秒|RFC3339 自动识别）；此路径 poll 带 user_id，userinfo 失败可容忍
  resetClock(); seen = []; polls = 0; done = null;
  globalThis.fetch = async (url, opts) => {
    seen.push({ url, opts });
    return url.includes("/api/v1/deviceToken/poll") ? resp(200, { token: "q-access4", refresh_token: "q-rt4", user_id: "uid-q-4", expires_at: 1893456000 }) : resp(500, {});
  };
  await discovery.beginOAuth("qoder", { edition: "cn" }, (x) => { done = x; });
  await drain();
  const row4 = store.accountRows("qoder").find((r0) => r0.uid === "uid-q-4");
  ok("expires_at 秒形态识别为毫秒且容忍 userinfo 失败", !!done && done.ok === true && !!row4 && row4.expires_at === 1893456000000, { done, exp: row4 && row4.expires_at });
  // 双写不只活在纯函数里：走完整假 fetch 登录链路后，**落库那一行**的 meta 必须两个键都在且同值
  // （读侧 qoderAdapter 拿的是这一行，不是 qoderOauthMeta 的返回值）。
  ok("登录落库的 meta 两个键同值（端到端，不是只测构造函数）", (() => {
    if (!row4) return false;
    const m = typeof row4.meta === "string" ? JSON.parse(row4.meta) : row4.meta || {};
    return !!m.machineId && m.machineId === m.machine_id;
  })(), row4 && row4.meta);

  restoreClock();
  globalThis.fetch = realFetch;
})().then(() => {
  console.log(`\n${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}).catch((e) => { console.error("测试执行异常:", e); process.exit(1); });
