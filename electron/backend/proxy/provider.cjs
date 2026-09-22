// 反代网关 · 自定义模型提供商（中转站 / 自建 OpenAI 兼容端点）
//
// 这一层只管「提供商这件事的规矩」：标识与地址校验、防遮蔽规则、模型名解析、连通性探测。
// 落库在 store.cjs（提供商就是 agents 表的一行），上游读写在 adapters.cjs（通用 OpenAI 兼容适配器）。
//
// 为什么值得单独一层：网关的渠道概念原本只有代码常量里那 4 家内置生态渠道，一旦允许用户自己加，
// 「这个模型名归谁」就不再是查表能答的问题——必须有一条不会让新条目悄悄顶掉内置池的解析顺序。
"use strict";
const crypto = require("node:crypto");
const config = require("../config.cjs");
const store = require("./store.cjs");
const adapters = require("./adapters.cjs");

// slug 就是路由前缀（`myslug/gpt-4o`），也是 accounts.channel 的键值，一旦有账号挂上去就不许改。
// 字符集刻意窄于可读性：小写字母数字加 -_，禁 '/'（分隔符本身），长度卡住是为了 UI 一行放得下。
const SLUG_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

// 保留名：4 个内置渠道 id 之外，再加几个会撞上网关自己路由/展示语义的词。
// 撞上的后果不是报错而是行为诡异——例如 slug="v1" 会让 `/v1/models` 的解析歧义。
const RESERVED = new Set(["auto", "all", "v1", "models", "healthz", "status", "readyz"]);

const KIND_OPENAI = "openai_compat";

/** base_url 归一化：只在**写入侧**做一次并存规范值，出站一律 `base + "/chat/completions"`。
 *  留两处拼接口径迟早会漂（尾斜杠、/v1 有无是中转站两种常见写法）。
 *  剥 /v1 尾缀时保留更深的挂载路径（如 /api/openai）——那是某些自建网关的路由，不是版本前缀。 */
function normalizeBaseUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) return { ok: false, message: "base_url 不能为空" };
  let u;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, message: "base_url 不是合法 URL（需含 http:// 或 https://）" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, message: "base_url 只支持 http(s)" };
  if (u.username || u.password) return { ok: false, message: "base_url 不要带账号信息，Key 请填在 Key 栏" };
  if (u.search || u.hash) return { ok: false, message: "base_url 不要带查询串或锚点" };
  let p = u.pathname.replace(/\/+$/, "");
  // 长后缀优先、剥到不动为止：先匹配 /chat/completions 会让 /v1/chat/completions 只掉一半，
  // 剩个 /v1 就得靠"再归一一次"才干净——写入侧存的就是脏值，读侧永远拼错端点。
  const TRAILING = ["/v1/chat/completions", "/chat/completions", "/v1/messages", "/v1"];
  for (let changed = true; changed; ) {
    changed = false;
    for (const suffix of TRAILING) {
      if (p.toLowerCase().endsWith(suffix)) {
        p = p.slice(0, -suffix.length);
        changed = true;
        break;
      }
    }
  }
  p = p.replace(/\/+$/, "");
  u.pathname = p + (p ? "/" : "");
  return { ok: true, url: u.toString().replace(/\/$/, ""), domain: u.hostname };
}

/** 模型清单归一：字符串或 {model,...} 混填都接受，落成 objects-only 存库（读侧再归一）。
 *  空清单允许存在：前缀路由对未列出的模型照样透传（中转站的实际能力常常领先于它的清单）。 */
function normalizeModels(raw) {
  const list = Array.isArray(raw) ? raw : String(raw || "").split(/[\n,]/);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const e = typeof item === "string" ? { model: item } : item;
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    const model = String(e.model || "").trim();
    if (!model) continue;
    if (model.includes("/")) return { ok: false, message: `模型名 "${model}" 含 /：斜杠是 provider/model 的分隔符，模型本身不能有` };
    const key = model.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      model,
      upstream: String(e.upstream || model).trim() || model,
      name: e.name ? String(e.name).slice(0, 64) : undefined,
      rate: e.rate != null && !Number.isNaN(Number(e.rate)) ? Number(e.rate) : undefined,
      capabilities: e.capabilities && typeof e.capabilities === "object" ? e.capabilities : undefined,
      contextLength: Number(e.contextLength) || undefined,
      maxOutputTokens: Number(e.maxOutputTokens) || undefined,
    });
  }
  return { ok: true, models: out };
}

function normalizeHeaders(raw) {
  const o = typeof raw === "string" ? safeJson(raw) : raw;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: true, headers: {} };
  const headers = {};
  for (const [k, v] of Object.entries(o)) {
    const key = String(k).trim();
    // 鉴权头由网关按该渠道的 Key 生成，让用户覆盖等于给了一条绕过 Key 轮转与记账的路
    if (/^(authorization|proxy-connection|host|content-length|connection)$/i.test(key)) {
      return { ok: false, message: `不允许自定义请求头 "${key}"（鉴权头由网关按 Key 栏生成）` };
    }
    headers[key] = String(v);
  }
  return { ok: true, headers };
}

function normalizeBody(raw) {
  const o = typeof raw === "string" ? safeJson(raw) : raw;
  if (!o || typeof o !== "object" || Array.isArray(o)) return { ok: true, body: {} };
  for (const k of ["model", "messages", "prompt", "stream"]) {
    if (k in o) return { ok: false, message: `extra_body 不允许覆盖 "${k}"（由网关与调度层决定）` };
  }
  return { ok: true, body: o };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** 校验并归一一整条提供商输入（create 与 update 共用，避免两处规矩漂移） */
function validate(input, existing) {
  const id = String(input.id ?? (existing && existing.id) ?? "").trim();
  if (!SLUG_RE.test(id)) {
    return { ok: false, message: "标识需为 2~32 位小写字母、数字、- 或 _，且不能含 /" };
  }
  if (store.isBuiltinChannel(id)) return { ok: false, message: `标识 "${id}" 是内置渠道，不能占用` };
  if (RESERVED.has(id)) return { ok: false, message: `标识 "${id}" 是保留名` };
  const base = normalizeBaseUrl(input.baseUrl ?? (existing && existing.baseUrl));
  if (!base.ok) return base;
  const models = normalizeModels(input.models ?? (existing && existing.models));
  if (!models.ok) return models;
  const headers = normalizeHeaders(input.extraHeaders ?? (existing && existing.extraHeaders));
  if (!headers.ok) return headers;
  const body = normalizeBody(input.extraBody ?? (existing && existing.extraBody));
  if (!body.ok) return body;
  const enabled = input.enabled != null ? !!input.enabled : !existing || existing.enabled !== false;
  return {
    ok: true,
    row: {
      id,
      display: String(input.display ?? (existing && existing.display) ?? "").trim().slice(0, 64) || id,
      domain: base.domain,
      kind: KIND_OPENAI,
      baseUrl: base.url,
      models: models.models,
      extraHeaders: headers.headers,
      extraBody: body.body,
      enabled,
      // 一律 round_robin：expire_first 按到期时间排序，提供商的 Key 没有到期概念（全 0），
      // 结果恒选第一把，多 Key 轮转形同不存在。策略仍可在号池页手动改。
      poolStrategy: input.poolStrategy ?? (existing && existing.poolStrategy) ?? "round_robin",
    },
  };
}

/** 防遮蔽规则：新提供商的 slug 不得与既有模型目录里任何 `x/y` 形式的第一段撞名。
 *  撞上的后果是那条内置模型在 /v1/models 里的 id 与提供商前缀无法区分（mergedModels 会跳过重复 id，
 *  于是新提供商的模型一条都列不出来，而用户只会看到「配了却没生效」）。 */
function assertNoCatalogCollision(slug) {
  const prefix = `${slug}/`;
  const hit = adapters.mergedModels().map((m) => m.id).find((id) => id.toLowerCase().startsWith(prefix.toLowerCase()));
  if (hit) return { ok: false, message: `标识 "${slug}" 与模型目录里的 "${hit}" 冲突，换一个（否则该提供商的模型无法出现在 /v1/models）` };
  return { ok: true };
}

// ===== 管理面读写 =====

function list() {
  return store.listProviders().map((p) => ({
    ...p,
    keyCount: store.listAccounts(p.id).length,
    onlineCount: store.listAccounts(p.id).filter((a) => a.status === "online" && a.hasToken).length,
  }));
}

function create(input) {
  const v = validate(input, null);
  if (!v.ok) return v;
  if (store.getProvider(v.row.id)) return { ok: false, message: `标识 "${v.row.id}" 已存在` };
  const clash = assertNoCatalogCollision(v.row.id);
  if (!clash.ok) return clash;
  return { ok: true, provider: store.saveProvider(v.row) };
}

function update(id, input) {
  const existing = store.getProvider(id);
  if (!existing) return { ok: false, message: `提供商 "${id}" 不存在` };
  // 标识不可改：accounts.channel 以它为外键值，改一个 id 要连带迁移全部 Key 与历史流水，
  // 收益（少建一次）远小于风险（半路失败留下两个渠道的碎片数据）。UI 上把该栏置灰即可。
  if (input.id && String(input.id) !== String(id)) return { ok: false, message: "标识创建后不可修改，请新建一个并删除旧的" };
  const v = validate({ ...input, id }, existing);
  if (!v.ok) return v;
  return { ok: true, provider: store.saveProvider(v.row) };
}

function remove(id) {
  return store.deleteProvider(id) ? { ok: true } : { ok: false, message: `提供商 "${id}" 不存在` };
}

/** 加一把 Key。同一条重复粘贴直接拒：号池里两把一模一样的 Key 会让轮转把配额算成两倍。 */
function addKey(id, { name, key }) {
  if (!store.getProvider(id)) return { ok: false, message: `提供商 "${id}" 不存在` };
  const secret = String(key || "").trim();
  if (!secret) return { ok: false, message: "API Key 不能为空" };
  const hash = crypto.createHash("sha256").update(secret).digest("hex");
  for (const row of store.accountRows(id)) {
    if (crypto.createHash("sha256").update(config.decryptSecret(row.token_enc) || "").digest("hex") === hash) {
      return { ok: false, message: "这把 Key 已经在本提供商的号池里了" };
    }
  }
  const accId = store.addAccount({
    channel: id,
    uid: "",
    name: String(name || "").trim().slice(0, 64) || `Key ${store.listAccounts(id).length + 1}`,
    token: secret,
    refreshToken: "", // 空串而非 null：config.encryptSecret 对空串早退，不会留下解不开的空信封
    source: "paste",
    expiresAt: 0,
  });
  return { ok: true, id: accId };
}

function removeKey(accountId) {
  const acc = store.getAccount(accountId);
  if (!acc) return { ok: false, message: "账号不存在" };
  if (!store.getProvider(acc.channel)) return { ok: false, message: "该账号不属于任何自定义提供商" };
  return store.removeAccount(accountId) ? { ok: true } : { ok: false, message: "删除失败" };
}

// ===== 模型名解析（路由的唯一入口） =====

/** `slug/model` → 该提供商的 slug；首段不是启用中的提供商就回 null，交给内置目录判定。
 *  内置模型 id 本身可能含 '/'（如 google/gemini-xxx），所以判据是「首段命中启用中的提供商」，
 *  而不是「含斜杠就当提供商」。 */
function parseModelRef(model) {
  const s = String(model || "");
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  const slug = s.slice(0, i);
  const row = store.channelList().find((c) => c.id === slug && c.kind !== "builtin");
  return row ? slug : null;
}

/** 裸名兜底（proxy.allowBareProviderModel）：只在**没有任何内置渠道拥有该模型**时调用，
 *  且要求恰好唯一命中一个提供商——两个提供商都有 gpt-4o 时不猜，交回上层的 unknown model 提示，
 *  让用户用 slug/model 写清楚。内置优先 + 歧义不猜，这两条合起来就是「不会静默遮蔽」的全部含义。 */
function findUniqueByBareModel(model) {
  const target = String(model || "").toLowerCase();
  if (!target || target.includes("/")) return null;
  const hits = [];
  for (const row of store.channelList()) {
    if (row.kind === "builtin") continue;
    if ((row.models || []).some((m) => String(typeof m === "string" ? m : m.model).toLowerCase() === target)) hits.push(row.id);
  }
  return hits.length === 1 ? hits[0] : null;
}

// ===== 连通性探测 =====

/** 用一把 Key 发一次真实最小请求。Key 有两种来源：
 *  ① `key`：用户在表单里当场填的（新建时还没落库，只能这样试）；
 *  ② `accountId`：编辑已有提供商时表单不重填 Key，让用户从号池里挑一把，主进程按 id 解密——
 *     明文因此一次都不经过渲染层。
 *  两条路都刻意绕开 handleChat 与号池调度：不经 pickAccount（不动 lastUsed、不占租约）、
 *  不 insertUsage、不 applyCool。探测失败的后果绝不能是把号池里一把好 Key 打进冷却。
 *  这会产生真实上游计费，UI 文案要写清楚。 */
async function probe({ id, accountId, baseUrl, key, model, extraHeaders, extraBody }) {
  let secret = String(key || "").trim();
  if (!secret && accountId && id) {
    const acc = store.getAccount(String(accountId));
    // 只认「属于这个提供商」的账号：拿别人的 Key 去试别人的地址，既串了凭据也测不出真相
    if (acc && acc.channel === String(id)) secret = config.decryptSecret(acc.token_enc) || "";
  }
  if (!secret) return { ok: false, message: "请先填 API Key（或从号池里选一把已有的 Key）" };
  const base = normalizeBaseUrl(baseUrl);
  if (!base.ok) return base;
  const target = String(model || "").trim();
  if (!target) return { ok: false, message: "请先填要试的模型名" };
  const headers = normalizeHeaders(extraHeaders || {});
  if (!headers.ok) return headers;

  const adapter = adapters.makeOpenaiCompat({
    id: id || "__probe__",
    baseUrl: base.url,
    models: [{ model: target, upstream: target }],
    extraHeaders: headers.headers,
    extraBody: (extraBody && typeof extraBody === "object" ? extraBody : {}),
  });
  const started = Date.now();
  let sample = "";
  let finishReason = "";
  let usage = null;
  let streamErr = null;
  const emit = (ev) => {
    if (ev.type === "delta") sample += String((ev.delta && ev.delta.content) || "").slice(0, 200);
    else if (ev.type === "usage") usage = ev.usage;
    else if (ev.type === "finish") finishReason = ev.reason || finishReason;
    else if (ev.type === "error") streamErr = ev;
  };
  try {
    await adapter.chat({
      secrets: { token: secret, refreshToken: "" },
      model: target,
      body: { model: target, messages: [{ role: "user", content: "ping" }], max_tokens: 16, stream: true },
      emit,
    });
  } catch (e) {
    return { ok: false, status: Number(e && e.status) || 0, ms: Date.now() - started, message: String((e && e.message) || e) };
  }
  const ms = Date.now() - started;
  if (streamErr) return { ok: false, status: streamErr.status || 502, ms, message: `流内错误：${streamErr.message}` };
  if (!sample && !finishReason) return { ok: false, status: 502, ms, message: "上游没有任何内容返回（可能不支持该模型或不是 OpenAI 兼容端点）" };
  return { ok: true, ms, model: target, sample: sample.slice(0, 200), finishReason, usage };
}

/** 拉上游自己的模型清单：用号池里第一把可用 Key（与探测不同，这里没有"当场输入"的 Key）。 */
function fetchModels(id) {
  const provider = store.getProvider(id);
  if (!provider) return Promise.resolve({ ok: false, message: `提供商 "${id}" 不存在` });
  const row = store.accountRows(id).find((r) => r.status !== "disabled" && r.token_enc);
  if (!row) return Promise.resolve({ ok: false, message: "该提供商还没有可用 Key，先添加一把" });
  const adapter = adapters.makeOpenaiCompat({ ...provider, models: [] });
  return adapter.fetchModels({ token: config.decryptSecret(row.token_enc) || "", refreshToken: "" });
}

module.exports = {
  KIND_OPENAI,
  normalizeBaseUrl,
  normalizeModels,
  parseModelRef,
  findUniqueByBareModel,
  list,
  create,
  update,
  remove,
  addKey,
  removeKey,
  probe,
  fetchModels,
};
