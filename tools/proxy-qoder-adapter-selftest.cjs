// 反代网关 · Qoder 适配器单元自测（纯函数 + 信封解包，无需网络/凭据）
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-qoder-adapter-selftest.cjs [临时数据目录]
//
// 覆盖：
//   1) toQoderMessages：字符串/数组 content 归一、角色过滤、tool_calls 透传
//   2) toQoderTools：OpenAI function 形态过滤
//   3) rewriteBody：OpenAI → QoderInferRequest 字段映射 + 采样参数透传
//   4) fetchModels：目录解密 → 统一模型对象（注入 stub 签名器，验证整形与去重）
//   5) chat：SSE 信封解包（正常流 / 信封错误 / quota / 版本漂移 / [DONE] / usage）
//   6) queryCredits：额度口径（userQuota + addOnQuota，FIFO 求和）与 401/异常形态
//   7) refreshToken：轮换双 token 透传（注入 stub auth）
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const tmp = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-adapter-"));
process.env.APPDATA = tmp;

const assert = (cond, msg) => {
  if (!cond) throw new Error("断言失败: " + msg);
  console.log("  ✓ " + msg);
};

// ===== SSE 帧构造工具：把内层 chunk 包成 qoder 信封 =====
const frame = (inner, statusCode = "OK") =>
  `data:${JSON.stringify({ headers: { "Content-Type": ["application/json"] }, body: typeof inner === "string" ? inner : JSON.stringify(inner), statusCode })}\n\n`;

/** 构造一个受控的 SSE 响应体（ReadableStream） */
function sseStream(text) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      // 故意切成不规则分片，验证 pumpSse 的缓冲拼接
      for (let i = 0; i < text.length; i += 97) c.enqueue(enc.encode(text.slice(i, i + 97)));
      c.close();
    },
  });
}

async function main() {
  const { makeQoder, toQoderMessages, toQoderTools, STATIC_MODELS } = require("../electron/backend/proxy/qoderAdapter.cjs");
  const util = require("../electron/backend/proxy/util.cjs");

  // ===== 1. 消息归一 =====
  console.log("\n[1] toQoderMessages");
  const msgs = toQoderMessages([
    { role: "system", content: "你是助手" },
    { role: "user", content: "你好" },
    { role: "assistant", content: [{ type: "text", text: "在" }], tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
    { role: "tool", content: "结果", tool_call_id: "c1", name: "f" },
    { role: "bogus", content: "应被过滤" },
    { role: "user", content: [{ type: "image_url", image_url: { url: "http://x/y.png" } }] },
    { role: "user", content: [{ type: "unknown_part" }] },
  ]);
  // 输入 7 条：1 system、2 user、3 assistant(含 tool_calls)、4 tool、5 非法角色、6 user(image_url)、7 user(未知部件)
  // 保留 1/2/3/4/6 = 5 条；非法角色被过滤；未知部件归一后为空内容被丢弃
  assert(msgs.length === 5, "非法角色与空内容消息被过滤（7 → 5）");
  assert(Array.isArray(msgs[0].content) && msgs[0].content[0].text === "你是助手", "字符串 content 归一为 [{type:text}]");
  assert(msgs[2].tool_calls && msgs[2].tool_calls.length === 1, "assistant tool_calls 透传");
  assert(msgs[3].tool_call_id === "c1" && msgs[3].name === "f", "tool 角色 tool_call_id/name 透传");
  assert(msgs[4].content[0].type === "image_url", "image_url 部件保留");
  assert(toQoderMessages([{ role: "user", content: [{ type: "unknown_part" }] }]).length === 0, "未知部件归一为空后被丢弃");

  // ===== 2. tools 过滤 =====
  console.log("\n[2] toQoderTools");
  const tools = toQoderTools([
    { type: "function", function: { name: "get_weather", parameters: { type: "object" } } },
    { type: "function" },
    { type: "other", function: { name: "x" } },
    null,
  ]);
  assert(tools.length === 1 && tools[0].function.name === "get_weather", "仅保留合法 function 工具");

  // ===== 3. rewriteBody =====
  console.log("\n[3] rewriteBody");
  const rules = require("../electron/backend/proxy/rules.cjs");
  rules.init();
  // 生产环境的 fetchStream/pumpSse/httpJson 是 adapters.cjs 的私有函数（未导出），
  // 因此适配器通过 deps 注入。测试用同源实现（util.SseScanner）搭一个等价 pumpSse stub。
  const testPumpSse = async (resp, onEvent) => {
    const scanner = new util.SseScanner(onEvent);
    const dec = new TextDecoder();
    const reader = resp.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      scanner.feed(dec.decode(value, { stream: true }));
    }
    scanner.feed(dec.decode());
    scanner.flush();
  };
  const deps = {
    fetchStream: async () => ({ resp: { body: sseStream(""), ok: true, status: 200 }, cancelTimer: () => {} }),
    pumpSse: testPumpSse,
    httpJson: async () => ({ ok: true, status: 200, data: {} }),
    rules,
    auth: require("../electron/backend/proxy/qoderAuth.cjs"),
    signer: { createSession: async () => { throw new Error("stub"); } },
    store: null,
    util, // hasConsumableDelta 用于流中断时的本地出线判定
  };
  const ad = makeQoder("qoder", deps);
  assert(ad.id === "qoder", "渠道 id 正确");
  const rw = ad.rewriteBody("dfmodel", { messages: [{ role: "user", content: "hi" }], temperature: 0.3, max_tokens: 64, stop: ["x"] }, { uid: "u1" }, {});
  assert(rw.model_config.key === "dfmodel", "model_config.key 来自请求模型");
  assert(rw.model_config.format === "openai", "format=openai");
  assert(rw.model_config.source === "system", "source=system");
  assert(rw.session_id && rw.request_id && rw.request_set_id, "session/request id 已生成");
  assert(rw.request_id === rw.request_set_id, "request_set_id 与 request_id 一致");
  assert(rw.temperature === 0.3 && rw.max_tokens === 64 && Array.isArray(rw.stop), "采样参数透传");
  assert(Array.isArray(rw.tools) && rw.tools.length === 0, "无工具时为空数组");
  const meta = { requestId: "R1", sessionId: "S1" };
  const rw2 = ad.rewriteBody("gfmodel", { messages: [] }, {}, meta);
  assert(rw2.request_id === "R1" && rw2.session_id === "S1", "meta 提供时复用 id（轮内稳定）");
  // 静态兜底仅在「无目录」时生效（沙箱无 catalog.json）
  assert(ad.models().length >= STATIC_MODELS.length, "无目录时 models() 回退静态兜底表");
  // ===== 3b. issue #74 回归：两张兜底表必须各写各的（不是「谁不许有什么」）=====
  // 判据形态换了：原先断言「intl 表为空」，因为 intl 目录从没实测过，凭空兜底就是把请求
  // 导向不存在的模型（issue #74 的原症）。现在 intl 有了自己的实测集（参考仓在真实国际版
  // 账号上固化的 global 表），正确的不变量是**两表互不借对方独有的 id**——dfmodel 这类
  // 两区都有的 id 出现在两边是事实，不是串味。
  console.log("\n[3b] 静态兜底表按产品隔离（issue #74 回归）");
  const adIntl = makeQoder("qoder_intl", deps);
  const CN_ONLY = ["q37fmodel", "gm51model"];           // 只在中国版目录里实测到过
  const INTL_ONLY = ["ultimate", "performance", "efficient", "smodel", "cmodel"]; // 只有国际版有
  for (const id of CN_ONLY) assert(!adIntl.models().includes(id), `qoder_intl 不得有 CN 独有模型 ${id}`);
  for (const id of INTL_ONLY) assert(!ad.models().includes(id), `qoder(CN) 不得有 intl 独有模型 ${id}`);
  assert(ad.models().includes("dfmodel") && adIntl.models().includes("dfmodel"), "两区都实测到 dfmodel ⇒ 同时出现是事实而非串味");
  assert(adIntl.models().length === 17, `qoder_intl 静态兜底 17 条，实得 ${adIntl.models().length}`);
  assert(adIntl.models().length !== ad.models().length, "两表条数不同（相等说明有人把一张表复制了两遍）");

  // ===== 3c. issue #74 回归：有目录时只认目录（静态兜底不得复活已下架模型） =====
  // 场景：目录里只有 2 个模型，静态表里却有 14 个。修复前 models() = 并集 → 14 个都会
  // 被 modelOwners 视为「本渠道拥有」，于是列得出来、调不通（上游 400 code=11102）。
  console.log("\n[3c] 有目录时只认目录（issue #74 幽灵模型回归）");
  {
    const catDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-cat-"));
    fs.writeFileSync(
      path.join(catDir, "catalog.json"),
      JSON.stringify({
        qoder: {
          syncedAt: Date.now(),
          keyIdSchema: 1, // 与 rules DEFAULTS 同判据：无标记的条目会被 catalogIndex 忽略（见 [3d]）
          models: [
            { id: "dfmodel", name: "DeepSeek-Flash", scene: "assistant" },
            { id: "qfmodel", name: "Qwen3.8-Flash", scene: "assistant" },
          ],
        },
      })
    );
    // 只覆盖 rulesDir（不能 {...rules} 展开：模块方法会丢 this 绑定），其余转发真实 rules
    const stubRules = { get: (n) => rules.get(n), rulesDir: () => catDir };
    const adCat = makeQoder("qoder", { ...deps, rules: stubRules });
    const ms = adCat.models();
    assert(ms.length === 2, "有目录时 models() 只返回目录内容，实际 " + ms.length + "：" + ms.join(","));
    assert(ms.includes("dfmodel") && ms.includes("qfmodel"), "目录内模型保留");
    assert(!ms.includes("kmodel") && !ms.includes("mmodel"), "目录外的静态兜底模型不得复活（幽灵模型）");
  }

  // ===== 3d. qoder 兜底表只许有一份；历史展示名条目必须运行时忽略 =====
  // rules.init() 会把 DEFAULTS 写进 rules 目录。fork 期那份 qoder 用的是展示名 id
  // （Auto/Ultimate/…），上游 catalogIndex 读同一文件 ⇒ rewriteBody 把 model_config.key
  // 填成 "ultimate" 打给上游 ⇒ 400。用户文件里的历史条目不删（非破坏、可回退），但必须忽略。
  console.log("\n[3d] DEFAULTS 不再带 qoder 目录条目 + 无 keyIdSchema 的历史条目被忽略");
  {
    const defaults = require("../electron/backend/proxy/rules.cjs").DEFAULTS;
    assert(!defaults["catalog.json"].qoder, "DEFAULTS catalog.json 不含 qoder 条目（兜底唯一真相源是 STATIC_MODELS_BY_PRODUCT）");
    assert(ad.models().includes("dfmodel") && ad.models().length === STATIC_MODELS.length, "无目录条目时 models() 恰为本产品静态兜底（不借别区、不翻倍）");
    const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-stale-"));
    fs.writeFileSync(
      path.join(staleDir, "catalog.json"),
      JSON.stringify({ qoder: { syncedAt: 0, models: [{ id: "Ultimate", name: "Ultimate" }] } }),
      "utf8",
    );
    // 同 [3c]：只覆盖 rulesDir，不 {...rules} 展开（模块方法会丢 this 绑定）
    const staleRules = { get: (n) => rules.get(n), rulesDir: () => staleDir };
    const adStale = makeQoder("qoder", { ...deps, rules: staleRules });
    assert(adStale.models().includes("dfmodel"), "无 keyIdSchema 标记的历史 qoder 目录被忽略 → 回落静态兜底");
    assert(!adStale.models().includes("Ultimate") && !adStale.models().includes("ultimate"), "被忽略的历史条目不得泄漏成模型 id");
  }

  // ===== 4. fetchModels（stub 签名器）=====
  console.log("\n[4] fetchModels 目录整形");
  const fakeCatalog = JSON.stringify({
    assistant: [
      { key: "dfmodel", display_name: "DeepSeek-Flash", price_factor: 0.1, enable: true, is_reasoning: true, is_vl: true, max_input_tokens: 180000, context_config: { "200K": { token_count: 200000, is_default: true }, "1M": { token_count: 1000000 } }, thinking_config: { enabled: { efforts: { low: {}, high: {} } } } },
      { key: "qfmodel", display_name: "Qwen3.8-Flash", price_factor: 0, enable: true, is_free: true },
      { key: "disabled1", display_name: "Disabled", price_factor: 1, enable: false },
    ],
    chat: [
      { key: "dfmodel", display_name: "重复项应被去重", price_factor: 9 },
      { key: "mmodel", display_name: "MiniMax-M2.7", price_factor: 0.2, enable: true },
    ],
  });
  const deps2 = {
    ...deps,
    auth: { ...deps.auth, readCatalogBlob: () => "BLOB" },
    signer: { createSession: async () => ({ modelCacheDecrypt: () => fakeCatalog, free: () => {} }) },
  };
  const ad2 = makeQoder("qoder", deps2);
  const fm = await ad2.fetchModels({ uid: "u1" }, { token: "dt-x" });
  assert(fm.ok, "目录拉取成功");
  const ids = fm.models.map((m) => m.id);
  assert(ids.includes("dfmodel") && ids.includes("qfmodel") && ids.includes("mmodel"), "三模型入表");
  assert(!ids.includes("disabled1"), "enable=false 被剔除");
  assert(fm.models.filter((m) => m.id === "dfmodel").length === 1, "跨场景同 key 去重（assistant 优先）");
  const df = fm.models.find((m) => m.id === "dfmodel");
  assert(df.name === "DeepSeek-Flash", "assistant 场景优先（未被 chat 的重复项覆盖）");
  assert(df.rate === 0.1, "rate = price_factor");
  assert(df.contextLength === 1000000, "contextLength 取 context_config 最大档");
  assert(df.capabilities.reasoning === true && df.capabilities.images === true, "能力位映射（is_reasoning/is_vl）");
  assert(df.reasoning.supportedEfforts.length === 2, "thinking efforts 映射");
  const qf = fm.models.find((m) => m.id === "qfmodel");
  assert(qf.isFree === true && qf.rate === 0, "免费模型标记（price_factor=0）");
  const bad = await makeQoder("qoder", { ...deps, auth: { ...deps.auth, readCatalogBlob: () => null } }).fetchModels({ uid: "u1" }, { token: "t" });
  assert(!bad.ok, "无目录缓存时如实失败（不写空）");

  // ===== 5. chat 信封解包 =====
  console.log("\n[5] chat 信封解包");
  const mkChat = (sseText, sessionOverride) => {
    const events = [];
    const d = {
      ...deps,
      fetchStream: async () => ({ resp: { body: sseStream(sseText), ok: true, status: 200 }, cancelTimer: () => {} }),
      signer: {
        createSession: async () => sessionOverride || {
          prepareInferRequest: () => ({ url: "https://gw/x?Encode=1", headers: { Authorization: "Bearer COSY.a.b" }, body: Buffer.from("encoded") }),
          free: () => {},
        },
      },
    };
    return { ad: makeQoder("qoder", d), events };
  };
  const emitInto = (events) => (e) => events.push(e);

  // 5a 正常流
  const okSse =
    frame({ choices: [{ delta: { role: "assistant", reasoning_content: "" }, index: 0 }] }) +
    frame({ choices: [{ delta: { reasoning_content: "思考" }, index: 0 }] }) +
    frame({ choices: [{ delta: { content: "你好" }, index: 0 }] }) +
    frame({ choices: [{ delta: { content: "" }, finish_reason: "stop", index: 0 }], usage: { prompt_tokens: 37, completion_tokens: 28, total_tokens: 65, credits: 0.0066, billable: true } }) +
    frame("[DONE]");
  {
    const { ad: a, events } = mkChat(okSse);
    const res = await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "dt-x" }, model: "dfmodel", body: { messages: [{ role: "user", content: "hi" }] }, emit: emitInto(events), meta: {} });
    const deltas = events.filter((e) => e.type === "delta");
    // 适配器只发原始 delta，不做字段剥离（剥离与出线判定归 server.cjs 统一 emit 包装）
    assert(deltas.length === 4, "四个 delta 原样透传（含空串噪声帧，由 server 侧剥离）");
    assert(deltas[0].delta.role === "assistant" && deltas[0].delta.reasoning_content === "", "首帧原样透传（空 reasoning_content 不被适配器剥离）");
    assert(deltas[1].delta.reasoning_content === "思考", "reasoning_content 透传（思考流）");
    assert(deltas[2].delta.content === "你好", "content 透传");
    assert(deltas[3].delta.content === "" && !("finish_reason" in deltas[3].delta), "空 content 帧原样透传；finish_reason 不进 delta（走独立 finish 事件）");
    const finishes = events.filter((e) => e.type === "finish");
    assert(finishes.length === 2 && finishes[0].reason === "stop" && finishes[1].reason === "", "finish 两次：上游 stop + [DONE] 空 reason（沿用既有约定）");
    const u = events.find((e) => e.type === "usage").usage;
    assert(u.credits === 0.0066 && u.prompt_tokens === 37, "usage 透传含 credits 与 token 口径");
    assert(res.status === 200 && res.planLimit === false, "正常返回 status 200 / planLimit false");
  }
  // 5a-2 出线判据：仅 role / 私有扩展字段的噪声帧不得算「已出内容」（决定流中断能否换号自救）
  {
    const noiseSse =
      frame({ choices: [{ delta: { role: "assistant" }, index: 0 }] }) +          // 仅 role
      frame({ choices: [{ delta: { extra_fields: { a: 1 } }, index: 0 }] }) +     // 私有扩展字段
      frame({ choices: [{ delta: { tool_calls: [] }, index: 0 }] }) +             // 空工具数组
      frame(JSON.stringify({ code: "116", error: "quota exceeded" }), "FORBIDDEN");
    const { ad: a, events } = mkChat(noiseSse);
    const res = await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: emitInto(events), meta: {} });
    assert(res.planLimit === true, "噪声帧后遇 quota → 仍能 planLimit 换号（未被误判为已出线）");
    assert(events.filter((e) => e.type === "delta").length === 3, "三类噪声帧均透传（判定与透传解耦）");
  }
  // 5b quota exceeded → planLimit
  {
    const { ad: a, events } = mkChat(frame(JSON.stringify({ code: "116", error: "quota exceeded" }), "FORBIDDEN"));
    const res = await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: emitInto(events), meta: {} });
    assert(res.planLimit === true, "code116 → planLimit=true（触发换号）");
    assert(events.some((e) => e.type === "error" && e.status === 402), "emit 402 错误");
  }
  // 5c Signature invalid → 版本漂移（不落账号冷却）
  {
    const { ad: a, events } = mkChat(frame(JSON.stringify({ code: "101", message: "Signature invalid" }), "FORBIDDEN"));
    await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: emitInto(events), meta: {} });
    const err = events.find((e) => e.type === "error");
    assert(err && err.code === "signature_invalid" && err.status === 403, "Signature invalid → signature_invalid/403（版本漂移分类）");
  }
  // 5d 信封内 unauthorized → 401
  {
    const { ad: a, events } = mkChat(frame(JSON.stringify({ code: "TOKEN_EXPIRE", message: "token is not active" }), "UNAUTHORIZED"));
    await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: emitInto(events), meta: {} });
    const err = events.find((e) => e.type === "error");
    assert(err && err.status === 401, "token 失效 → 401（relogin 判定依据）");
  }
  // 5e 签名器不可用 → 503 渠道级
  {
    const { ad: a } = mkChat("", null);
    const d5 = { ...deps, signer: { createSession: async () => { throw new Error("客户端未安装"); } } };
    const a5 = makeQoder("qoder", d5);
    let threw = null;
    try { await a5.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: () => {}, meta: {} }); }
    catch (e) { threw = e; }
    assert(threw && threw.status === 503 && threw.qoderSignerDown === true, "签名器不可用 → 503 渠道级故障（不罚账号）");
  }
  // 5f 畸形帧不崩
  {
    const { ad: a, events } = mkChat("data:not-json\n\n" + frame({ choices: [{ delta: { content: "ok" }, index: 0 }] }) + frame("[DONE]"));
    const res = await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: emitInto(events), meta: {} });
    assert(res.status === 200 && events.some((e) => e.type === "delta"), "畸形帧被忽略，正常帧继续");
  }
  // 5g body:"null" 帧（实测：上游会在流中间夹一帧字面量 null，图片请求时尤其容易触发）
  // 修复前 JSON.parse 得到 null → chunk.choices 抛 TypeError → 整条流以内部异常中断
  {
    const { ad: a, events } = mkChat(
      frame({ choices: [{ delta: { role: "assistant" }, index: 0 }] }) +
      frame("null") +
      frame({ choices: [{ delta: { content: "after-null" }, index: 0 }] }) +
      frame("[DONE]")
    );
    const res = await a.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: emitInto(events), meta: {} });
    const text = events.filter((e) => e.type === "delta" && e.delta.content).map((e) => e.delta.content).join("");
    assert(res.status === 200, "body:\"null\" 帧不致流中断");
    assert(text === "after-null", "null 帧被跳过，其后内容正常透传");
    assert(!events.some((e) => e.type === "error"), "不产生 error 事件（修复前会抛 TypeError）");
  }
  // 5h 会话池：复用 / token 轮换新建 / 失败路径归还 / 容量淘汰
  {
    const created = [];
    const freed = [];
    const okResp = () => ({ resp: { body: sseStream(frame({ choices: [{ delta: { content: "ok" }, index: 0 }] }) + frame("[DONE]")), ok: true, status: 200 }, cancelTimer: () => {} });
    let failNext = false;
    const d = {
      ...deps,
      fetchStream: async () => {
        if (failNext) throw Object.assign(new Error("HTTP 429"), { status: 429 });
        return okResp();
      },
      signer: {
        createSession: async ({ token }) => {
          const s = {
            prepareInferRequest: () => ({ url: "https://gw/x?Encode=1", headers: {}, body: Buffer.from("encoded") }),
            free: () => freed.push(token),
          };
          created.push(s);
          return s;
        },
      },
    };
    const ad2 = makeQoder("qoder", d);
    const acctA = { uid: "A", meta: { machineId: "M1" } };
    const callA = () => ad2.chat({ account: acctA, secrets: { token: "T1" }, model: "dfmodel", body: { messages: [] }, emit: () => {}, meta: {} });
    await callA();
    await callA();
    assert(created.length === 1, "同身份两次 chat 复用池中会话（createSession 仅 1 次）");
    assert(freed.length === 0, "归还时不销毁（free 未被调用）");
    await ad2.chat({ account: acctA, secrets: { token: "T2" }, model: "dfmodel", body: { messages: [] }, emit: () => {}, meta: {} });
    assert(created.length === 2, "token 变化 → 新建会话（池键含 token）");
    // 失败路径归还：fetchStream 抛 429 时 chat 如实抛出，但会话必须已归还（旧实现在此泄漏）
    failNext = true;
    let threw = false;
    try { await callA(); } catch (e) { threw = true; }
    assert(threw, "fetchStream 抛错 → chat 如实抛出");
    assert(freed.length === 0, "失败路径归还后池中会话未被销毁（可复用）");
    failNext = false;
    // 容量淘汰：连续 20 个新身份（池上限 12）→ 最久未用的空闲会话被显式 free
    for (let i = 0; i < 20; i++) {
      await ad2.chat({ account: { uid: "U" + i, meta: { machineId: "M1" } }, secrets: { token: "TK" + i }, model: "dfmodel", body: { messages: [] }, emit: () => {}, meta: {} });
    }
    assert(created.length === 22, "累计新建 22 个会话（A 两次换 token + 20 个新身份）");
    assert(freed.length === created.length - 12, `容量淘汰 freed=${freed.length}（池上限 12，应释放 ${created.length - 12} 个）`);
    assert(freed.includes("T1"), "最先淘汰的是最久未用的（T1 在列）");
  }
  {
    // 加固回归：prepareInferRequest 抛错 → inUse 必须归还，否则该条目永远无法被
    // LRU 淘汰（等效池容量缩水）。观察法：让签名在 X 身份上炸一次，再压入 12 个新
    // 身份——若 X 已归还，X 会被正常淘汰计入 freed；若卡死则 freed 少 1。
    const created2 = [];
    const freed2 = [];
    const ok2 = () => ({ resp: { body: sseStream(frame({ choices: [{ delta: { content: "ok" }, index: 0 }] }) + frame("[DONE]")), ok: true, status: 200 }, cancelTimer: () => {} });
    const d3 = {
      ...deps,
      fetchStream: ok2,
      signer: {
        createSession: async ({ token }) => {
          const s = {
            prepareInferRequest: (o, b, mk) => {
              if (mk === "boom") throw new Error("wasm boom");
              return { url: "https://gw/x?Encode=1", headers: {}, body: Buffer.from("encoded") };
            },
            free: () => freed2.push(token),
          };
          created2.push(s);
          return s;
        },
      },
    };
    const ad3 = makeQoder("qoder", d3);
    let threw3 = false;
    try {
      await ad3.chat({ account: { uid: "X", meta: { machineId: "M" } }, secrets: { token: "TX" }, model: "boom", body: { messages: [] }, emit: () => {}, meta: {} });
    } catch (e) { threw3 = true; }
    assert(threw3, "prepareInferRequest 抛错 → chat 如实抛出");
    for (let i = 0; i < 12; i++) {
      await ad3.chat({ account: { uid: "Y" + i, meta: { machineId: "M" } }, secrets: { token: "TY" + i }, model: "dfmodel", body: { messages: [] }, emit: () => {}, meta: {} });
    }
    assert(created2.length === 13, "X 炸一次 + 12 个新身份 = 13 个会话");
    assert(freed2.includes("TX"), `抛错会话已被正常淘汰（freed 含 TX，实际 ${JSON.stringify(freed2)}）`);
  }

  // ===== 6. queryCredits =====
  console.log("\n[6] queryCredits 口径");
  const mkQ = (data, status = 200, ok = true) => makeQoder("qoder", { ...deps, httpJson: async () => ({ ok, status, data }) });
  {
    const r = await mkQ({ userQuota: { total: 300, used: 1, remaining: 299 }, addOnQuota: { total: 100, used: 0, remaining: 100 }, expiresAt: 1792285722753, userType: "personal_professional_trial" }).queryCredits({}, { token: "t" });
    assert(r.credits === 399, "credits = userQuota.remaining + addOnQuota.remaining（299+100）");
    assert(r.expiresAt === 1792285722753, "expiresAt 透传");
    assert(r.detail && r.detail.userQuota, "保留明细供 UI 分层展示");
  }
  {
    const r = await mkQ({ userQuota: { remaining: 0.5 }, addOnQuota: { remaining: 0.25 } }).queryCredits({}, { token: "t" });
    assert(r.credits === 0.75, "小数保留（浮点 credits，两位内不截断）");
  }
  {
    const r = await mkQ(null, 401, false).queryCredits({}, { token: "t" });
    assert(r.authError === true, "HTTP 401 → authError（触发刷新重试/relogin）");
  }
  {
    const r = await mkQ({ something: "else" }).queryCredits({}, { token: "t" });
    assert(r.unavailable === true, "结构未识别 → unavailable（不误判为 0 余额）");
  }
  // 多域回退：INTL 的额度端点在 openapi，gateway 返回 404（实测）→ 必须能回退到第二个域
  // ⚠ 此块曾在文件恢复事故中被旧版本覆盖（6820f8b 误删），现按 fecb29e 原文补回。
  {
    const seen = [];
    const stubRules = {
      get: (name) => (name === "headers.json"
        ? { qoder: { quotaBase: "https://gw.invalid", gateway: "https://gw2.invalid", openApi: "https://openapi.invalid", quotaPath: "/api/v2/quota/usage", userAgent: "qoder/0.4.3" } }
        : {}),
      rulesDir: () => tmp,
    };
    const ad = makeQoder("qoder", {
      ...deps,
      rules: stubRules,
      httpJson: async (url) => {
        seen.push(url);
        return url.includes("openapi") ? { ok: true, status: 200, data: { userQuota: { remaining: 7 } } } : { ok: false, status: 404, data: null };
      },
    });
    const r = await ad.queryCredits({}, { token: "t" });
    assert(r.credits === 7, "前序域 404 时回退到后续域成功");
    assert(seen.length === 3, "依次尝试 quotaBase → gateway → openApi 三个域");
    assert(seen[0].includes("gw.invalid") && seen[1].includes("gw2.invalid") && seen[2].includes("openapi.invalid"), "回退顺序正确（去重后按 quotaBase/gateway/openApi）");
  }

  // ===== 7. refreshToken =====
  console.log("\n[7] refreshToken 轮换");
  {
    const d7 = { ...deps, auth: { ...deps.auth, refreshDeviceToken: async () => ({ ok: true, token: "dt-new", refreshToken: "drt-new", expiresAt: 111, refreshTokenExpiresAt: 222 }) } };
    const r = await makeQoder("qoder", d7).refreshToken({ meta: { machineId: "mid" } }, { refreshToken: "drt-old" });
    assert(r.ok && r.token === "dt-new" && r.refreshToken === "drt-new", "双 token 同时返回（轮换制）");
    assert(r.expiresAt === 111 && r.refreshTokenExpiresAt === 222, "两个到期时间一并返回（供落库）");
  }
  {
    const r = await makeQoder("qoder", deps).refreshToken({ meta: {} }, {});
    assert(!r.ok, "无 refreshToken 时如实失败");
  }

  // ===== 8. 自签模块的远程目录必须是 key 口径（防展示名二次污染 catalog） =====
  // fetchModelsRemote 写回 rules/catalog.json，而 catalogIndex 只认 id=上游 key；
  // fork 历史版本把 display_name 去空白当 id，接上远程兜底就等于把上一个提交清掉的污染再写回去。
  console.log("\n[8] makeSelfSign().fetchModelsRemote 产出上游形状");
  {
    const qSS = require("../electron/backend/proxy/qoderSelfSign.cjs");
    const EP = require("../electron/backend/proxy/qoderEndpoints.cjs"); // host 判据的取值来源（与产品代码同一份表）
    let called = null;
    const stubHttpJson = async (url, o) => {
      called = url;
      return { ok: true, status: 200, data: { chat: [
        { key: "dfmodel", display_name: "DeepSeek-Flash", price_factor: 0.2, is_reasoning: true, is_vl: true, thinking_config: { enabled: { efforts: { low: {}, xhigh: {} } } }, max_input_tokens: 180000 },
        { key: "auto", display_name: "Auto", price_factor: 1, is_reasoning: false, is_vl: true },
        { key: "freemodel", display_name: "Free Zero", price_factor: 0, is_reasoning: false, is_vl: false },
      ] } };
    };
    const ss = qSS.makeSelfSign("qoder", { fetchStream: deps.fetchStream, pumpSse: deps.pumpSse, httpJson: stubHttpJson });
    const r = await ss.fetchModelsRemote({ account: { uid: "u1" }, secrets: { token: "jwt" } });
    assert(r.ok === true, "远程目录拉取成功");
    assert(/model\/list/.test(String(called)), "确实打了 model/list");
    // 不只判路径：**host 必须等于真相源**。端点闸判的是 REGIONS 表等值，这里判的是
    // 「拼 URL 那一行真的用了它」——两处缺一都能各自绿，只有合起来才封住改回常量的回归。
    assert(String(called).startsWith(EP.inferGateway("qoder") + "/algo/"), `CN 自签打在 ${EP.inferGateway("qoder")}（实得 ${called}）`);
    assert(r.models.some((m) => m.id === "dfmodel"), "id 是上游 key");
    assert(!r.models.some((m) => m.id === "DeepSeek-Flash"), "绝不产出展示名 id");
    assert(r.models.find((m) => m.id === "dfmodel").name === "DeepSeek-Flash", "展示名落在 name");
    assert(JSON.stringify(r.models.find((m) => m.id === "dfmodel").reasoning.supportedEfforts) === JSON.stringify(["low", "xhigh"]), "档位落在 reasoning.supportedEfforts");
    assert(r.models.find((m) => m.id === "dfmodel").capabilities.reasoning === true && r.models.find((m) => m.id === "auto").capabilities.reasoning === false, "能力位按 is_reasoning 映射，不编造");
    assert(r.models.find((m) => m.id === "freemodel").rate === 0 && r.models.find((m) => m.id === "freemodel").isFree === true, "price_factor=0 是合法值（当缺失丢弃会把免费档倍率抹成 null）");
    assert(r.models.find((m) => m.id === "dfmodel").contextLength === 180000 || r.models.find((m) => m.id === "dfmodel").contextLength === 0, "contextLength 取 context_config 最大档或 max_input_tokens");
    assert(ss.region === "cn", "qoder 产品的自签地区是 cn（不再读 meta.mode）");
    const intl = qSS.makeSelfSign("qoder_intl", { fetchStream: deps.fetchStream, pumpSse: deps.pumpSse, httpJson: stubHttpJson });
    assert(intl.region === "global", "qoder_intl 产品对应 global 区");
    // 国际版走一遍同一条链路，判它落到的 host：这是开关关闭期唯一能自证「国际版网关取值正确」的方式
    called = "";
    const ri = await intl.fetchModelsRemote({ account: { uid: "u9" }, secrets: { token: "jwt" } });
    assert(ri.ok === true && String(called).startsWith(EP.inferGateway("qoder_intl") + "/algo/"), `国际版自签打在 ${EP.inferGateway("qoder_intl")}（实得 ${called}）`);
  }

  // ===== 9. 双路签名：签名器不可用 → 回落自签（fork「零安装可用」卖点） =====
  console.log("\n[9] 签名器不可用 → 回落 qoderSelfSign");
  {
    let selfArgs = null;
    const selfSign = {
      chat: async (a) => { selfArgs = a; return { status: 200, planLimit: false, viaSelfSign: true }; },
      refreshToken: async () => ({ ok: true, token: "t", refreshToken: "rt", expiresAt: 1 }),
      fetchModelsRemote: async () => ({ ok: false, message: "n/a" }),
    };
    const qSS9 = require("../electron/backend/proxy/qoderSelfSign.cjs");
    const adDown = makeQoder("qoder", { ...deps, selfSign, selfSignUtil: qSS9 });
    const r = await adDown.chat({
      account: { uid: "u1", meta: { machineId: "m1" } }, secrets: { token: "dt-x" },
      model: "dfmodel", body: { messages: [{ role: "user", content: "hi" }] }, emit: () => {}, meta: {},
    });
    assert(r.viaSelfSign === true, "签名器抛错时走了自签回落");
    assert(selfArgs && selfArgs.entry.key === "dfmodel", "回落传出的 entry.key 是请求模型 key");
    assert(Array.isArray(selfArgs.entry.efforts), "回落传出的 entry.efforts 是数组");
    assert(selfArgs.account.uid === "u1" && typeof selfArgs.emit === "function", "回落转出 account/emit 原样");
    // 注入不完整（有 selfSign 没 selfSignUtil）时必须保留上游 503 语义：
    // 否则会拿模块内兜底的 "auto" 上行，用户看到「答非所问」而不是「渠道不可用」。
    let partialThrew = null;
    await makeQoder("qoder", { ...deps, selfSign }).chat({ account: { uid: "u1", meta: {} }, secrets: { token: "dt-x" }, model: "dfmodel", body: { messages: [] }, emit: () => {}, meta: {} }).catch((e) => { partialThrew = e; });
    assert(partialThrew && partialThrew.status === 503, "缺 selfSignUtil 注入时不静默兜底成 auto，仍回 503");
    const adNo = makeQoder("qoder", { ...deps });
    let threw = null;
    await adNo.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "dt-x" }, model: "dfmodel", body: { messages: [] }, emit: () => {}, meta: {} }).catch((e) => { threw = e; });
    assert(threw && threw.status === 503 && threw.qoderSignerDown === true, "未注入 selfSign 时保持上游 503 语义（不静默降级）");
  }

  // ===== 10. fork-port：403 双语义 / 429→402 / <thinking> 跨片剥离 =====
  // 上游只看 statusCode 字符串：403 一律当登录态。fork 实测 403 有两种含义——带 pricing/额度特征
  // 的是套餐不足（402 → 换号），裸 403 才是登录态（401 → 刷新）；只看状态码把「该充值」误报成
  // 「登录失效」，换号与刷新两条自救路径都会走错。thinking 标签同理：Qoder 把 reasoning 混在
  // content 里下发且会切在分片边界。
  console.log("\n[10] 信封分类与 thinking 剥离");
  {
    const SU = require("../electron/backend/proxy/qoderSelfSign.cjs");
    const mk = (text) => makeQoder("qoder", {
      ...deps,
      selfSignUtil: SU,
      signer: { createSession: async () => ({ prepareInferRequest: () => ({ url: "http://x/y", headers: {}, body: Buffer.from("{}") }), modelCacheDecrypt: () => "{}", free() {} }) },
      fetchStream: async () => ({ resp: { body: sseStream(text), ok: true, status: 200 }, cancelTimer: () => {} }),
    });
    const run = async (text) => { const emits = []; const res = await mk(text).chat({ account: { uid: "u", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: (x) => emits.push(x), meta: {} }); return { emits, res }; };

    const a = await run(frame({ message: "please see https://qoder.com/pricing to upgrade your plan" }, "FORBIDDEN"));
    assert(a.emits.some((x) => x.type === "error" && x.status === 402), "403 带 pricing 判成 402");
    assert(a.res.planLimit === true, "402 同时置 planLimit（换号触发口径）");

    const b = await run(frame({ message: "permission denied" }, "FORBIDDEN"));
    assert(b.emits.some((x) => x.type === "error" && x.status === 401), "裸 403 判成 401 登录态");
    assert(b.res.planLimit === false, "裸 403 不得置 planLimit（不是额度问题）");

    const c = await run(frame({ message: "too many requests" }, "TOO_MANY_REQUESTS"));
    assert(c.emits.some((x) => x.type === "error" && x.status === 402), "429 转 402（限流交交换号，不算硬故障）");

    const d = await run(frame({ choices: [{ delta: { content: "A<thin" } }] }, "OK") + frame({ choices: [{ delta: { content: "king>B秘密</thinking>C" } }] }, "OK"));
    const text = d.emits.filter((x) => x.type === "delta").map((x) => (x.delta && x.delta.content) || "").join("");
    assert(text === "AC", "跨片 thinking 剥离干净且 flush 补回尾段（实得 " + JSON.stringify(text) + "）");
    assert(!/think/.test(text), "正文不残留标签碎片");
  }

  // ===== 11. 续期双判据：打包串走自签（含 PAT 换取），裸 dt- 走 deviceToken =====
  // fork 的 device 登录落的是打包串（3 段 <rt>|<uid>|<mid>，或 pat| 开头 5 段）：PAT 换取与
  // center 域 refresh 只有自签路会做；上游 deviceToken 刷新吃裸 dt-，喂打包串必失败。
  // 判据只看「含 |」——dt-/drt- 系列不含该字符，不必分辨段数就不至于漏。
  console.log("\n[11] refreshToken 按凭据形态分流");
  {
    let authCalled = null;
    const selfSign11 = {
      chat: async () => ({}),
      fetchModelsRemote: async () => ({ ok: false }),
      refreshToken: async (a) => ({ ok: true, via: "self", token: a.secrets.token, refreshToken: a.secrets.refreshToken }),
    };
    const fakeAuth11 = {
      PRODUCTS: { qoder: { gateway: "https://gw.invalid" } },
      refreshDeviceToken: async (product, rt, machineId) => { authCalled = { product, rt, machineId }; return { ok: true, token: "T2", refreshToken: "drt2", expiresAt: 111, refreshTokenExpiresAt: 222 }; },
      readCatalogBlob: () => null, readRiskIdentity: () => null,
    };
    const ad11 = makeQoder("qoder", { ...deps, selfSign: selfSign11, auth: fakeAuth11 });
    const packed = await ad11.refreshToken({ uid: "u", meta: { machineId: "m" } }, { refreshToken: "RT|u|m", token: "jwt.x.y" });
    assert(packed.via === "self" && packed.refreshToken === "RT|u|m", "3 段打包串走自签刷新");
    const pat = await ad11.refreshToken({ uid: "u", meta: {} }, { refreshToken: "pat|PAT|RT|u|m", token: "jwt.x.y" });
    assert(pat.via === "self", "pat| 5 段走自签（PAT 换取在自签内部完成）");
    const bare = await ad11.refreshToken({ uid: "u", meta: { machineId: "m" } }, { refreshToken: "drt-abc", token: "dt-abc" });
    assert(bare.ok === true && bare.token === "T2" && bare.refreshTokenExpiresAt === 222, "裸 dt- 走上游 deviceToken 刷新（含双到期时间）");
    assert(authCalled && authCalled.product === "qoder" && authCalled.rt === "drt-abc" && authCalled.machineId === "m", "deviceToken 刷新带 product/旧 rt/machineId");
    const none = await ad11.refreshToken({ uid: "u", meta: {} }, {});
    assert(none.ok === false && /无 refreshToken/.test(String(none.message)), "无凭据如实报错");
    // 未注入 selfSign 时，打包串不能被悄悄交给 deviceToken 刷新（那会是一次注定失败的请求）
    const adNo11 = makeQoder("qoder", { ...deps, auth: fakeAuth11 });
    let calledNo = null;
    authCalled = null;
    const rNo = await adNo11.refreshToken({ uid: "u", meta: {} }, { refreshToken: "RT|u|m", token: "jwt" });
    calledNo = authCalled;
    assert(rNo.ok === false, "缺 selfSign 注入时打包串不硬塞给 deviceToken");
    assert(calledNo === null, "且确实没发起那次注定失败的 deviceToken 请求");
  }

  // ===== 12. 自签刷新器内部：PAT 换取 与 3 段 OAuth 刷新（真实现，不打桩） =====
  // [11] 用桩验分流，这段验被搬进来的真码：PAT 走 jobToken/exchange 且原串回写（换了作业令牌
  // 也不丢 PAT），OAuth 走 center 域且新 rt 含 | 时必须沿用旧串（打包分隔符不能被污染）。
  console.log("\n[12] 自签刷新器真实现（PAT / OAuth 两分支）");
  {
    const qSS12 = require("../electron/backend/proxy/qoderSelfSign.cjs");
    const jwtWithExp = (() => {
      const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
      return b64({ alg: "none" }) + "." + b64({ user_id: "u9", exp: 2000000000 }) + ".sig";
    })();
    const mkSs = (handler) => qSS12.makeSelfSign("qoder", { fetchStream: deps.fetchStream, pumpSse: deps.pumpSse, httpJson: handler });
    const seen12 = [];
    const ssPat = mkSs(async (url, o) => { seen12.push({ url, body: o && o.body }); return { ok: true, status: 200, data: { data: { token: jwtWithExp } } }; });
    const rp = await ssPat.refreshToken({ account: { uid: "u9" }, secrets: { refreshToken: "pat|SECRET_PAT|oldjobrt|u9|m9", token: "old" } });
    assert(rp.ok === true && rp.token === jwtWithExp, "PAT 换取成功并回新 token");
    assert(rp.refreshToken === "pat|SECRET_PAT|oldjobrt|u9|m9", "PAT 原串回写（作业令牌轮换不得把 PAT 丢掉）");
    assert(rp.expiresAt === 2000000000 * 1000, "到期时间取 JWT exp 并换成毫秒");
    assert(/jobToken\/exchange/.test(seen12[0].url) && JSON.parse(seen12[0].body).personal_token === "SECRET_PAT", "打的是 openApi 域 jobToken/exchange 且带 personal_token");
    const ssPatFail = mkSs(async () => ({ ok: false, status: 403, data: null }));
    const rpf = await ssPatFail.refreshToken({ account: {}, secrets: { refreshToken: "pat|P|a|b|c" } });
    assert(rpf.ok === false && /PAT 换取失败 HTTP 403/.test(rpf.message), "PAT 换取失败如实带状态码");

    const seenO = [];
    const ssOauth = mkSs(async (url, o) => { seenO.push({ url, headers: o && o.headers, body: o && o.body }); return { ok: true, status: 200, data: { data: { token: jwtWithExp, refresh_token: "brand-new-rt" } } }; });
    const ro = await ssOauth.refreshToken({ account: { uid: "u9" }, secrets: { refreshToken: "oldrt|u9|m9", token: "cur" } });
    assert(ro.ok === true && ro.refreshToken === "brand-new-rt|u9|m9", "OAuth 刷新重组三段串（uid/machineId 沿用）");
    assert(/\/algo\/api\/v3\/user\/refresh_token$/.test(seenO[0].url) || seenO[0].url.includes("refresh_token"), "打的是 center 域 refresh_token");
    assert(String(seenO[0].headers.authorization) === "Bearer cur", "刷新带当前 token 的 Bearer");
    assert(JSON.parse(seenO[0].body).refreshToken === "oldrt", "请求体只带首段旧 rt（不带 uid/machineId）");

    // 上游若回一个含 | 的 refresh_token，绝不能拼进打包串（分隔符被污染后下次分段就错）
    const ssDirty = mkSs(async () => ({ ok: true, status: 200, data: { data: { token: jwtWithExp, refresh_token: "bad|rt" } } }));
    const rd = await ssDirty.refreshToken({ account: {}, secrets: { refreshToken: "oldrt|u9|m9", token: "cur" } });
    assert(rd.ok === true && rd.refreshToken === "oldrt|u9|m9", "含 | 的新 rt 被拒收，沿用旧串");

    const ss401 = mkSs(async () => ({ ok: false, status: 401, data: null }));
    const r4 = await ss401.refreshToken({ account: {}, secrets: { refreshToken: "oldrt|u9|m9" } });
    assert(r4.ok === false && r4.expired === true, "401 标 expired（触发 relogin 而非无限重试）");
    const ssBogus = mkSs(async () => ({ ok: true, status: 200, data: {} }));
    const rb = await ssBogus.refreshToken({ account: {}, secrets: { refreshToken: "只有一段" } });
    assert(rb.ok === false && /格式不认识/.test(rb.message), "段数不足如实报错，不静默当 OAuth 分支");
  }

  // ===== 13. 目录双轨：本机 catalog 解密不可用的每种诱因都要落到远程兜底 =====
  // 上游目录来自本机 catalog-v6 解密（需装客户端且该 uid 用过）。fork 的远程 model/list 是
  // 「零安装也能拿到目录」的唯一来源，所以五种失败（无 uid / 无 blob / 签名器不可用 / 解密失败 /
  // 目录为空）逐一都要接上兜底——漏一种就是那种机器上目录永远拉不到。
  console.log("\n[13] fetchModels 远程兜底（逐诱因）");
  {
    const remoteModels = [{ id: "dfmodel", name: "DeepSeek-Flash", capabilities: { reasoning: true, tools: true, images: true } }];
    let remoteHits = 0;
    const selfSign13 = {
      chat: async () => ({}), refreshToken: async () => ({ ok: false }),
      fetchModelsRemote: async () => { remoteHits += 1; return { ok: true, models: remoteModels, scene: "assistant", modelCount: 1 }; },
    };
    const mk13 = (auth, signer) => makeQoder("qoder", { ...deps, selfSign: selfSign13, auth, signer });
    const cases = [
      ["无 uid", mk13({ PRODUCTS: { qoder: {} }, readCatalogBlob: () => "B" }, deps.signer), { uid: "", meta: {} }],
      ["本机无 blob", mk13({ PRODUCTS: { qoder: {} }, readCatalogBlob: () => null }, deps.signer), { uid: "u1", meta: {} }],
      ["签名器不可用", mk13({ PRODUCTS: { qoder: {} }, readCatalogBlob: () => "B" }, { createSession: async () => { throw Object.assign(new Error("glue 加载失败"), { status: 503, qoderSignerDown: true }); } }), { uid: "u1", meta: {} }],
      ["解密抛错", mk13({ PRODUCTS: { qoder: {} }, readCatalogBlob: () => "B" }, { createSession: async () => ({ modelCacheDecrypt: () => { throw new Error("bad blob"); }, free() {} }) }), { uid: "u1", meta: {} }],
      ["目录结构为空", mk13({ PRODUCTS: { qoder: {} }, readCatalogBlob: () => "B" }, { createSession: async () => ({ modelCacheDecrypt: () => JSON.stringify({ assistant: [] }), free() {} }) }), { uid: "u1", meta: {} }],
    ];
    for (const [name, ad, acct] of cases) {
      const before = remoteHits;
      const r = await ad.fetchModels(acct, { token: "dt-x" });
      assert(r.ok === true && remoteHits === before + 1, `${name} → 落远程兜底成功`);
      assert(r.models[0].id === "dfmodel", `${name} → 远程条目形状保持上游口径`);
    }
    // 远程也失败时，message 必须同时带上本机原因与远程原因——只留一个就会把人引向错误的排查方向
    const adBoth = mk13({ PRODUCTS: { qoder: {} }, readCatalogBlob: () => null }, deps.signer);
    const saved = selfSign13.fetchModelsRemote;
    selfSign13.fetchModelsRemote = async () => ({ ok: false, message: "目录拉取失败（HTTP 403）" });
    const rf = await adBoth.fetchModels({ uid: "u1", meta: {} }, { token: "dt-x" });
    selfSign13.fetchModelsRemote = saved;
    assert(rf.ok === false && /本机无模型目录缓存/.test(rf.message) && /远程兜底/.test(rf.message) && /HTTP 403/.test(rf.message), "两侧都失败时两个原因一并上报: " + rf.message);
    // 未注入 selfSign 时必须保持上游原失败语义（不能凭空变成功）
    const adUp13 = makeQoder("qoder", { ...deps, auth: { PRODUCTS: { qoder: {} }, readCatalogBlob: () => null } });
    const ru = await adUp13.fetchModels({ uid: "u1", meta: {} }, { token: "dt-x" });
    assert(ru.ok === false && /本机无模型目录缓存/.test(ru.message) && !/远程兜底/.test(ru.message), "未注入 selfSign 时仍是上游语义");
  }

  // ===== 14. 推理主机按账号令牌选（jt- → api2）：两条签名路都要真的读它 =====
  // 端点闸 G 组判的是表里的取值，这里判的是「拼 URL 那两处真的按 secrets.token 取」。
  // 只看闸会漏掉整类缺陷：表写对了但调用点还在用工厂级常数，PAT 号恒定 403 且没人报警。
  console.log("\n[14] 推理基址按令牌种类分流（两条签名路）");
  {
    const EP14 = require("../electron/backend/proxy/qoderEndpoints.cjs");
    const qSS14 = require("../electron/backend/proxy/qoderSelfSign.cjs");
    const API2 = EP14.REGIONS.global.jobGateway;
    const API3 = EP14.inferGateway("qoder_intl");
    const seenUrl = [];
    const ssDeps = {
      fetchStream: async (url) => { seenUrl.push(url); return { resp: { body: sseStream(""), ok: true, status: 200 }, cancelTimer: () => {} }; },
      pumpSse: async () => {},
      httpJson: async (url) => { seenUrl.push(url); return { ok: true, status: 200, data: { chat: [] } }; },
    };
    const ssIntl = qSS14.makeSelfSign("qoder_intl", ssDeps);
    const e14 = { key: "auto", is_reasoning: false, is_vl: false, efforts: [] };
    const callChat = (token) => ssIntl.chat({
      account: { uid: "u1", meta: {} }, secrets: { token }, modelKey: "auto", entry: e14,
      body: { messages: [{ role: "user", content: "hi" }] }, emit: () => {},
    });
    seenUrl.length = 0;
    await callChat("jt-job-token");
    assert(seenUrl.length === 1 && seenUrl[0].startsWith(API2 + "/algo/"), `自签 chat 的 jt- 令牌落 api2（实得 ${seenUrl[0]}）`);
    seenUrl.length = 0;
    await callChat("dt-device-token");
    assert(seenUrl.length === 1 && seenUrl[0].startsWith(API3 + "/algo/"), `自签 chat 的 dt- 令牌仍落 api3（实得 ${seenUrl[0]}）`);
    seenUrl.length = 0;
    await ssIntl.fetchModelsRemote({ account: { uid: "u1" }, secrets: { token: "jt-job-token" } });
    assert(seenUrl.length === 1 && seenUrl[0].startsWith(API2 + "/algo/api/v2/model/list"), `目录拉取与对话同主机（实得 ${seenUrl[0]}）`);

    // wasm 路：prepareInferRequest 的第一实参就是基址，直接收下它
    const gwSeen = [];
    const mkSigner = () => ({
      createSession: async () => ({
        prepareInferRequest: (base) => { gwSeen.push(base); return { url: "https://gw.invalid/x", headers: {}, body: Buffer.from("{}") }; },
        modelCacheDecrypt: () => "{}",
        free() {},
      }),
    });
    // 注入一个与生产种子同形的 headers.json：gateway 有值（覆盖态），验证 jt- 不被它劫持。
    // 用 Object.create 而不是 {...rules}：展开会丢 this 绑定，catalogIndex 里的
    // rules.rulesDir() 直接炸（本文件 :145 记过同一个坑）。
    const cfgRules = Object.create(rules);
    cfgRules.get = (n) => (n === "headers.json"
      ? { qoder_intl: { gateway: API3 }, qoder: { gateway: EP14.inferGateway("qoder") } }
      : rules.get(n));
    const adIntl14 = makeQoder("qoder_intl", { ...deps, rules: cfgRules, signer: mkSigner() });
    const chatArgs = (token) => ({
      account: { uid: "u1", meta: {} }, secrets: { token }, model: "auto",
      body: { messages: [{ role: "user", content: "hi" }] }, emit: () => {}, meta: {},
    });
    await adIntl14.chat(chatArgs("jt-job-token"));
    assert(gwSeen.length === 1 && gwSeen[0] === API2, `wasm 路把 jt- 的基址换成 api2（实得 ${gwSeen[0]}）`);
    gwSeen.length = 0;
    await adIntl14.chat(chatArgs("eyJ.jwt-form"));
    assert(gwSeen.length === 1 && gwSeen[0] === API3, `wasm 路的非 jt- 令牌仍用 cfg.gateway（实得 ${gwSeen[0]}）`);
    gwSeen.length = 0;
    const adCn14 = makeQoder("qoder", { ...deps, rules: cfgRules, signer: mkSigner() });
    await adCn14.chat(chatArgs("jt-job-token"));
    assert(gwSeen.length === 1 && gwSeen[0] === EP14.inferGateway("qoder"), `CN 只有一台网关，jt- 不分流（实得 ${gwSeen[0]}）`);
  }

  console.log("\n[done] Qoder 适配器单元自测全部通过");
}

main()
  .then(() => process.exit(0)) // fetch keep-alive 句柄会让事件循环保持存活，测完显式退出（对齐 proxy-smoke 约定）
  .catch((e) => {
    console.error("\n[FAIL] " + ((e && e.stack) || e));
    process.exit(1);
  });
