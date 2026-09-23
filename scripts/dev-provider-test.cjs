// 自定义提供商（中转站 / 自建端点）自测：node scripts/dev-provider-test.cjs
// 用 mktemp 造库，不碰真实 %APPDATA%\AgentHub\proxy\stats.db；纯本地断言，不打任何上游网络。
"use strict";
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

// 必须在任何产品代码 require 之前落地：store.cjs 一加载就把网关数据目录解析成 %APPDATA%\AgentHub\proxy
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-provider-test-"));

const store = require("../electron/backend/proxy/store.cjs");
const pool = require("../electron/backend/proxy/pool.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const provider = require("../electron/backend/proxy/provider.cjs");
const credits = require("../electron/backend/proxy/credits.cjs");
const config = require("../electron/backend/config.cjs");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? `→ got ${JSON.stringify(extra)}` : ""); }
}
const crypto = require("node:crypto");
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

console.log("base_url 归一化:");
const B = provider.normalizeBaseUrl;
ok("补协议后原样", B("https://a.com").url === "https://a.com", B("https://a.com"));
ok("剥尾斜杠", B("https://a.com/").url === "https://a.com", B("https://a.com/").url);
ok("剥 /v1", B("https://a.com/v1").url === "https://a.com", B("https://a.com/v1").url);
ok("剥 /v1/", B("https://a.com/v1/").url === "https://a.com", B("https://a.com/v1/").url);
ok("剥完整 chat 端点", B("https://a.com/v1/chat/completions").url === "https://a.com", B("https://a.com/v1/chat/completions").url);
ok("挂载路径下的完整端点", B("https://a.com/api/v1/chat/completions").url === "https://a.com/api", B("https://a.com/api/v1/chat/completions").url);
ok("一次就归一干净（不需二次）", B(B("https://a.com/v1/chat/completions").url).url === B("https://a.com/v1/chat/completions").url);
ok("保留挂载路径", B("https://a.com/api/openai/v1").url === "https://a.com/api/openai", B("https://a.com/api/openai/v1").url);
ok("幂等（二次归一不变）", B(B("https://a.com/v1/chat/completions").url).url === "https://a.com", B(B("https://a.com/v1/chat/completions").url).url);
ok("domain 取 hostname", B("https://relay.example.com:8443/v1").domain === "relay.example.com", B("https://relay.example.com:8443/v1"));
ok("拒空", !B("").ok);
ok("拒无协议", !B("a.com").ok, B("a.com"));
ok("拒非 http(s)", !B("ftp://a.com").ok, B("ftp://a.com"));
ok("拒 userinfo", !B("https://u:p@a.com").ok, B("https://u:p@a.com"));
ok("拒查询串", !B("https://a.com/v1?key=1").ok, B("https://a.com/v1?key=1"));

console.log("\n标识（slug）校验与保留名:");
store.open();
const base = { baseUrl: "https://relay.test/v1", models: ["gpt-4o"], display: "测试中转" };
ok("拒含斜杠", !provider.create({ id: "a/b", ...base }).ok, provider.create({ id: "a/b", ...base }));
ok("拒大写", !provider.create({ id: "MyProv", ...base }).ok);
ok("拒过短", !provider.create({ id: "a", ...base }).ok);
ok("拒内置 id", !provider.create({ id: "trae", ...base }).ok, provider.create({ id: "trae", ...base }).message);
ok("拒保留名 auto", !provider.create({ id: "auto", ...base }).ok);
ok("拒保留名 v1", !provider.create({ id: "v1", ...base }).ok);
ok("合法 slug 建成", provider.create({ id: "relay", ...base }).ok === true, provider.create({ id: "relay", ...base }));
ok("重复 slug 被拒", !provider.create({ id: "relay", ...base }).ok);
ok("模型名含斜杠被拒", !provider.create({ id: "p2", ...base, models: ["google/gemini"] }).ok, provider.create({ id: "p2", ...base, models: ["google/gemini"] }).message);

console.log("\n渠道视图与路由合法性:");
ok("channelList 含内置 4 家 + relay", store.channelList().length === 5, store.channelList().map((c) => c.id));
ok("relay 标记为 openai_compat", (store.channelList().find((c) => c.id === "relay") || {}).kind === "openai_compat");
ok("内置渠道 kind=builtin", (store.channelList().find((c) => c.id === "trae") || {}).kind === "builtin");
ok("routeOk 接受提供商 slug", store.channelList().some((c) => c.id === "relay"));
ok("停用后从路由视图消失", (() => {
  provider.update("relay", { enabled: false });
  return !store.channelList().some((c) => c.id === "relay");
})(), store.channelList().map((c) => c.id));
ok("停用仍在管理面可见（否则无法再打开）", store.listProviders().some((p) => p.id === "relay"));
ok("展示名对停用提供商仍可解析", store.channelDisplay("relay") === "测试中转", store.channelDisplay("relay"));
provider.update("relay", { enabled: true });

console.log("\n模型名解析（防遮蔽的核心）:");
ok("slug/ 前缀命中", provider.parseModelRef("relay/gpt-4o") === "relay", provider.parseModelRef("relay/gpt-4o"));
ok("未启用提供商的前缀不命中", (() => { provider.update("relay", { enabled: false }); const r = provider.parseModelRef("relay/x"); provider.update("relay", { enabled: true }); return r === null; })());
ok("非提供商首段不命中", provider.parseModelRef("google/gemini-2.5-pro") === null, provider.parseModelRef("google/gemini-2.5-pro"));
ok("裸名不命中前缀解析", provider.parseModelRef("gpt-4o") === null);
ok("斜杠在末尾不命中", provider.parseModelRef("relay/") === null);
ok("裸名唯一命中提供商", provider.findUniqueByBareModel("gpt-4o") === "relay", provider.findUniqueByBareModel("gpt-4o"));
ok("目录外裸名返回 null", provider.findUniqueByBareModel("nope-999") === null);
ok("歧义不猜（两个提供商都有同名 → null）", (() => {
  provider.create({ id: "relay2", baseUrl: "https://r2.test", models: ["gpt-4o"] });
  return provider.findUniqueByBareModel("gpt-4o") === null;
})(), provider.findUniqueByBareModel("gpt-4o"));
store.deleteProvider("relay2");

console.log("\n目录合并（/v1/models 只出 slug/model）:");
const ids = adapters.mergedModels().map((m) => m.id);
ok("列出 relay/gpt-4o", ids.includes("relay/gpt-4o"), ids.filter((x) => x.startsWith("relay/")));
ok("不出现裸 gpt-4o（结构性防遮蔽）", !ids.includes("gpt-4o"));
ok("内置渠道归属仍是 trae 而非 relay", (() => {
  const t = adapters.mergedModels().find((m) => m.id.toLowerCase() === "kimi-k2-0905-preview");
  return !t || !t.sources.includes("relay");
})());
ok("提供商模型带 owned_by", (adapters.mergedModels().find((m) => m.id === "relay/gpt-4o") || {}).owned_by === "relay");

console.log("\n上游模型名映射（适配器侧）:");
provider.update("relay", { models: [{ model: "gpt-4o", upstream: "gpt-4o-2024-11-20" }, "glm-4.6"] });
const ad = adapters.get("relay");
ok("动态解析到适配器", !!ad && typeof ad.chat === "function");
ok("剥前缀 + 映射 upstream 别名", ad.upstreamFor("relay/gpt-4o") === "gpt-4o-2024-11-20", ad.upstreamFor("relay/gpt-4o"));
ok("裸名同样映射", ad.upstreamFor("gpt-4o") === "gpt-4o-2024-11-20", ad.upstreamFor("gpt-4o"));
ok("目录外模型原样透传", ad.upstreamFor("relay/qwen3-max") === "qwen3-max", ad.upstreamFor("relay/qwen3-max"));
ok("大小写不敏感命中", ad.upstreamFor("RELAY/GPT-4O") === "gpt-4o-2024-11-20", ad.upstreamFor("RELAY/GPT-4O"));
const rw = ad.rewriteBody("relay/gpt-4o", {
  model: "relay/gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false,
  conversation_id: "c1", prompt_cache_key: "p1", temperature: 0.3,
});
ok("强制 stream:true（非流式由本地聚合）", rw.stream === true, rw.stream);
ok("上游 model 已是真名", rw.model === "gpt-4o-2024-11-20", rw.model);
ok("注入 include_usage", rw.stream_options && rw.stream_options.include_usage === true);
ok("剔除 conversation_id", !("conversation_id" in rw) && !("prompt_cache_key" in rw), Object.keys(rw));
ok("标准字段透传", rw.temperature === 0.3 && Array.isArray(rw.messages));
provider.update("relay", { extraBody: { reasoning: { effort: "high" }, thinking: { budget_tokens: 100 } } });
const rw2 = adapters.get("relay").rewriteBody("relay/gpt-4o", { model: "relay/gpt-4o", messages: [] });
ok("extraBody 深合并进上游体", rw2.reasoning.effort === "high" && rw2.thinking.budget_tokens === 100, rw2);
ok("extraBody 不许覆盖 model", !provider.create({ id: "bad1", baseUrl: "https://x.test", extraBody: { model: "evil" } }).ok);
ok("extraHeaders 不许覆盖 authorization", !provider.create({ id: "bad2", baseUrl: "https://x.test", extraHeaders: { Authorization: "Bearer zzz" } }).ok);
store.deleteProvider("bad1");
store.deleteProvider("bad2");
const h = adapters.get("relay").headers({ token: "sk-abc" });
ok("鉴权头由 Key 生成", h.authorization === "Bearer sk-abc", h);

console.log("\n适配器缺省项（号池语义不被污染的前提）:");
ok("不定义 queryCredits", typeof adapters.get("relay").queryCredits !== "undefined" ? false : true, typeof adapters.get("relay").queryCredits);
ok("内置渠道仍查得到适配器", !!adapters.get("raccoon") && !!adapters.get("trae"));
ok("未知渠道回 null", adapters.get("nope") === null);
adapters.get("relay").refreshToken().then((r) => ok("refreshToken 显式声明无刷新", r.ok === false && r.noRefresh === true, r));

console.log("\nKey 落库六约束:");
const addR = provider.addKey("relay", { name: "主 Key", key: "sk-test-one" });
ok("加 Key 成功", addR.ok === true, addR);
provider.addKey("relay", { key: "sk-test-two" });
ok("重复粘贴同一把 Key 被拒", !provider.addKey("relay", { key: "sk-test-one" }).ok, provider.addKey("relay", { key: "sk-test-one" }).message);
ok("空 Key 被拒", !provider.addKey("relay", { key: "  " }).ok);
const rows = store.accountRows("relay");
ok("号池里两把 Key", rows.length === 2, rows.length);
const r0 = rows[0];
ok("refresh_enc 留空串（不产生解不开的空信封）", r0.refresh_enc === "", JSON.stringify(r0.refresh_enc));
ok("credits 与 credits_at 双 0", r0.credits === 0 && r0.credits_at === 0, [r0.credits, r0.credits_at]);
ok("expires_at 为 0", r0.expires_at === 0, r0.expires_at);
ok("source=paste", r0.source === "paste");
ok("status=online", r0.status === "online");
ok("token 可解密回原值", config.decryptSecret(r0.token_enc) === "sk-test-one", config.decryptSecret(r0.token_enc));
ok("hasToken 判可用", store.accountSecrets(r0).token === "sk-test-one");
ok("建提供商时调度策略落 round_robin", (store.listAgents().find((a) => a.id === "relay") || {}).poolStrategy === "round_robin", store.listAgents().find((a) => a.id === "relay"));
ok("默认名自动编号", rows[1].name === "Key 2", rows[1].name);

console.log("\n号池调度对提供商生效:");
const s1 = pool.poolSummary("relay");
ok("poolSummary 认得该渠道", s1.accountCount === 2 && s1.onlineCount === 2, s1);
const p1 = pool.pickAccount("relay", "round_robin", [], 3);
const p2 = pool.pickAccount("relay", "round_robin", [], 3);
ok("round_robin 两次选到不同 Key", p1 && p2 && p1.id !== p2.id, [p1 && p1.name, p2 && p2.name]);
const p3 = pool.pickAccount("relay", "round_robin", [p1.id, p2.id], 3);
ok("exclude 用尽后返回 null", p3 === null);
ok("双 0 余额不会被判 exhausted（creditsAt 判据不触发）", pool.poolAccounts("relay").every((a) => a.status === "online"), pool.poolAccounts("relay").map((a) => a.status));

console.log("\n额度刷新跳过提供商:");
credits.refreshAccount(rows[0].id).then((r) => ok("单账号刷新不该成功", false, r)).catch((e) => ok("单账号刷新明确报无余额概念", /无余额概念/.test(String(e.message)), e.message));
credits.refreshChannel("relay").then((r) => ok("渠道级刷新直接拒", r.ok === false && /无余额概念/.test(r.message || ""), r));
credits.refreshChannel("trae").then((r) => ok("内置渠道不被误伤（能进批次逻辑）", !(r.message || "").includes("无余额概念"), r.message));

console.log("\n删除提供商连带清理:");
store.addAccount({ channel: "relay", uid: "", name: "快照用", token: "sk-third", refreshToken: "", source: "paste" });
store.snapshotCredits("relay", rows[0].id, 10, 0);
store.upsertModelCooldown(rows[0].id, "relay/gpt-4o", Date.now() + 60000, "test");
const accIds = store.accountRows("relay").map((r) => r.id);
ok("删前 3 把 Key", accIds.length === 3, accIds.length);
ok("删除成功", provider.remove("relay").ok === true);
ok("渠道行消失", !store.getProvider("relay"));
ok("Key 行连带删除", store.accountRows("relay").length === 0);
ok("模型冷却无残留", accIds.every((id) => !store.listModelCooldowns().some((c) => (c.accId || c.acc_id) === id)));
ok("路由视图回到只剩内置", store.channelList().length === store.BUILTIN_CHANNELS.length, store.channelList().map((c) => c.id));
ok("删不存在的提供商回 false", provider.remove("relay").ok === false);
// credits_history 无对外读接口，其连带清理由 removeAccount 的 DELETE 语句保证（本脚本已覆盖账号删除本身）

console.log("\n探测的离线校验分支（不发网络请求）:");
const server = require("../electron/backend/proxy/server.cjs");

/** 假 OpenAI 兼容上游：按 Authorization 决定成败，从而**确定性地**验到多 Key 轮转
 *  （比"先 429 再成功"的时序写法可靠——那种要靠重试次数碰）。 */
function startFakeUpstream(port) {
  const http = require("node:http");
  const seen = [];
  const fake = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      // 模型目录接口（fetchModels 走 GET）：真机实测中转站普遍提供，闸里也得有它一条形状
      if (req.method === "GET") {
        seen.push({ auth: String(req.headers.authorization || ""), model: "(list)", stream: null, path: req.url });
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"object":"list","data":[{"id":"gpt-4o"},{"id":"gpt-4o-mini"}]}');
        return;
      }
      const body = JSON.parse(raw || "{}");
      seen.push({ auth: String(req.headers.authorization || ""), model: body.model, stream: body.stream, path: req.url });
      // delta 必须以 JSON 对象入帧：写成 ${对象} 会被插值成 "[object Object]"，
      // 那是非法 JSON，上游等于什么都没回——曾经让这条闸整段假绿过一轮正文断言
      const chunk = (delta, finish, usage) =>
        `data: ${JSON.stringify({
          id: "c1", object: "chat.completion.chunk", created: 1, model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish || null }],
          ...(usage ? { usage } : {}),
        })}\n\n`;
      if (String(req.headers.authorization || "").includes("sk-key-one")) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
        res.end('{"error":{"message":"rate limit exceeded","type":"rate_limit_error"}}');
        return;
      }
      if (body.model === "plain-json") {
        // 少数中转站无视 stream:true，直接回一整个 JSON：网关必须聚合出正文，不能给 200 空响应
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"id":"x","object":"chat.completion","model":"plain-json","choices":[{"index":0,"message":{"role":"assistant","content":"JSON 兜底正文"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":6,"total_tokens":10}}');
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        chunk({ role: "assistant", content: "" }, null) +
        chunk({ content: "中转" }, null) +
        chunk({ content: "站回答" }, "stop", { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 }) +
        "data: [DONE]\n\n"
      );
    });
  });
  return new Promise((r) => fake.listen(port, "127.0.0.1", () => r({ fake, seen })));
}

/** 发一次网关请求并把响应体读干。
 *  读干不是洁癖：网关在打上游之前就 writeHead(200)，只 `await fetch()` 会在响应头到达时立刻返回，
 *  此时上游请求可能根本还没发出——任何"上游收到几次 / 收到什么模型名"的断言都会读到过去的数。
 *  （这条闸就以这种方式假失败过一次，看着像"透传没打上游"。） */
const call = async (base, secret, model, stream) => {
  const r = await fetch(base + "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + secret },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }], stream }),
  });
  return { status: r.status, text: await r.text() };
};

(async () => {
  ok("探测：缺 Key 明确报错", /API Key/.test((await provider.probe({ baseUrl: "https://a.com", key: "", model: "gpt-4o" })).message || ""));
  ok("探测：地址非法明确报错", (await provider.probe({ baseUrl: "not-a-url", key: "sk-1", model: "gpt-4o" })).ok === false);
  ok("探测：缺模型名明确报错", /模型/.test((await provider.probe({ baseUrl: "https://a.com", key: "sk-1", model: "" })).message || ""));

  console.log("\n端到端（网关 ← 假中转站，走真实 HTTP 与 SSE）:");
  const UP = 19532;
  const GW = 19531;
  const { fake, seen } = await startFakeUpstream(UP);
  const created = provider.create({ id: "myprov", baseUrl: `http://127.0.0.1:${UP}/v1`, display: "假中转", models: [{ model: "gpt-4o", upstream: "gpt-4o-2024-11-20" }] });
  ok("提供商创建成功", created.ok === true, created);
  provider.addKey("myprov", { name: "限速的那把", key: "sk-key-one" });
  provider.addKey("myprov", { name: "好的那把", key: "sk-key-two" });
  const gwKey = store.createKey({ name: "e2e", route: "auto", dailyQuota: 0, rateLimit: 0 });
  const sr = await server.start(() => ({
    port: GW, bind: "127.0.0.1", rateLimitPerMin: 0, concurrency: 8, routeStrategy: "smart",
    fixedChannel: "trae", modelOverrides: {}, debugStatus: false, humanizeJitter: false,
  }));
  ok("网关在测试端口起来（绝不打用户自己的 9527）", sr.ok === true && sr.port === GW, sr);
  const base = `http://127.0.0.1:${GW}`;

  const r1 = await call(base, gwKey.secret, "myprov/gpt-4o", true);
  const t1 = r1.text;
  ok("流式 200", r1.status === 200, r1.status);
  ok("正文按帧送达", t1.includes("中转") && t1.includes("站回答"), t1.slice(0, 200));
  ok("[DONE] 收尾", t1.trimEnd().endsWith("data: [DONE]"));
  ok("客户端看到的 model 仍是请求值（契约不变）", t1.includes('"model":"myprov/gpt-4o"'), t1.slice(0, 200));
  ok("上游收到的 model 已剥前缀并映射别名", seen[0] && seen[0].model === "gpt-4o-2024-11-20", seen[0]);
  ok("上游被强制流式", seen[0] && seen[0].stream === true, seen[0]);
  ok("端点是 base + /v1/chat/completions（base 存根、/v1 由出站补，真机实测过）", seen[0] && seen[0].path === "/v1/chat/completions", seen[0] && seen[0].path);
  ok("鉴权头取号池里的 Key", /^Bearer sk-key-/.test((seen[0] || {}).auth || ""), seen[0]);

  const fm = await provider.fetchModels("myprov");
  ok("拉上游模型清单走 /v1/models", fm.ok === true && JSON.stringify(fm.models) === '["gpt-4o","gpt-4o-mini"]', fm);
  ok("清单请求带的是号池 Key 的 Bearer", (seen[seen.length - 1] || {}).path === "/v1/models" && /^Bearer sk-key-/.test((seen[seen.length - 1] || {}).auth || ""), seen[seen.length - 1]);

  // 第一把 Key 被上游 429：应就地换第二把并成功，客户端完全无感（防多号切换痕迹）
  const k1 = store.accountRows("myprov").find((r) => config.decryptSecret(r.token_enc) === "sk-key-one");
  ok("429 后该 Key 进 cooling", k1 && k1.status === "cooling" && k1.cool_until > Date.now(), k1 && [k1.status, k1.cool_until]);
  const k2 = store.accountRows("myprov").find((r) => config.decryptSecret(r.token_enc) === "sk-key-two");
  ok("换到的第二把 Key 仍在线", k2 && k2.status === "online", k2 && k2.status);
  ok("本次请求打了 429 一次又重发（正文未拼接）", (t1.match(/中转/g) || []).length === 1, t1);

  const r2 = await call(base, gwKey.secret, "myprov/gpt-4o", false);
  const j2 = JSON.parse(r2.text);
  ok("非流式聚合出完整正文", j2.choices && j2.choices[0].message.content === "中转站回答", j2);
  ok("非流式 usage 落账", j2.usage && j2.usage.prompt_tokens === 11 && j2.usage.completion_tokens === 22, j2.usage);
  ok("非流式 finish_reason 透传", (j2.choices[0].finish_reason || "") === "stop", j2.choices[0]);

  const r3 = await call(base, gwKey.secret, "myprov/plain-json", true);
  const t3 = r3.text;
  ok("上游回整段 JSON 时不产生 200 空响应", t3.includes("JSON 兜底正文"), t3.slice(0, 260));

  // 游标写法：只比对本轮新增的上游请求。按全表下标取数会被 429 重发打乱，
  // 失败时游标能直接指出丢在哪一步（配合 call() 必须读干响应体这条前提）。
  const before4 = seen.length;
  const r4 = await call(base, gwKey.secret, "myprov/not-in-catalog", true);
  const mine4 = seen.slice(before4);
  ok("目录外模型按前缀透传（不因清单滞后而 400）", r4.status === 200, r4.status);
  ok("透传的上游名已去掉 slug 前缀", mine4.some((x) => x.model === "not-in-catalog"), { before4, hits: mine4.map((x) => x.model) });

  const r5 = await call(base, gwKey.secret, "totally-unknown-model", true);
  ok("既非前缀也无人拥有的模型仍 400", r5.status === 400, r5.status);
  ok("400 提示里列出 slug/model 形态可用名", /myprov\/gpt-4o/.test(r5.text), r5.text.slice(0, 200));

  const models = await (await fetch(base + "/v1/models")).json();
  ok("/v1/models 列出 myprov/gpt-4o", models.data.some((m) => m.id === "myprov/gpt-4o"));
  ok("/v1/models 不列裸 gpt-4o", !models.data.some((m) => m.id === "gpt-4o"));

  const usage = store.statsDetail({ page: 1, pageSize: 50, channel: "myprov" });
  ok("流水按渠道可查", usage.total >= 4, usage.total);
  ok("流水 model 记的是客户端可见名", usage.rows.every((x) => /^myprov\//.test(x.model)), usage.rows.map((x) => x.model));
  ok("成功流水记 200 与真实 usage", usage.rows.some((x) => x.status === 200 && x.promptTokens === 11 && x.completionTokens === 22), usage.rows.slice(0, 3).map((x) => [x.model, x.promptTokens, x.completionTokens]));
  ok("账号维度记到具体 Key", usage.rows.some((x) => x.accountName === "好的那把"), usage.rows.slice(0, 3).map((x) => x.accountName));

  server.stop();
  fake.close();
  provider.remove("myprov");

  console.log(`\n${pass} passed, ${fail} failed`);
  store.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("\n闸自身异常:", e);
  process.exit(1);
});
