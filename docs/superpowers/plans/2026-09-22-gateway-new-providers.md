# 网关新增 Cline / AutoClaw / Qoder 渠道 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 AgentHub 反代网关新增 5 条内置渠道（cline_free / cline_pass / autoclaw / autoclaw_intl / qoder），覆盖粘贴、本机登录态导入、网页 OAuth（设备授权 + 滑块）三种凭证通路。

**Architecture:** 全部走 raccoon 先例：`BUILTIN_CHANNELS` 注册渠道 → `ADAPTERS` 静态表挂适配器对象（工厂参数化两池/两地区）→ 加密/协议助手独立 `.cjs` 模块 → `discovery.cjs` 挂扫描源与 OAuth 分支。调度核心、号池、三条入站协议、sink 层零改动。

**Tech Stack:** Node.js 18+ CommonJS（Electron 主进程）、Express、SQLite、node:crypto、koffi（DPAPI FFI，参照 sqlcipher.cjs 既有用法）、Vue 3 + Element Plus（UI）。

**Spec:** `docs/superpowers/specs/2026-09-22-gateway-new-providers-design.md`（决策与约束）+ `docs/superpowers/specs/2026-09-22-new-providers-protocol-ref.md`（协议常量唯一依据，下称「协议参考 §N」；本计划所有 URL/常量/头部名/算法均出自该文档，逐字抄，勿"顺手修正"）。

## Global Constraints

- 网关代码全在 `electron/backend/proxy/*.cjs`，CommonJS，中文注释；commit 中文 `feat:/test:/docs:` 格式
- 测试是独立断言脚本：`node scripts/dev-<name>-test.cjs`，文件头注释写跑法；**任何产品代码 require 之前**先 `process.env.APPDATA = fs.mkdtempSync(...)`（dev-provider-test.cjs:8-9 硬规则）；端口只用 19530-19572 段
- **每个任务收尾必须跑全量回归**：`node scripts/dev-provider-test.cjs && node scripts/dev-anthropic-test.cjs && node scripts/dev-responses-test.cjs && node scripts/dev-sse-delta-test.cjs && node scripts/dev-ccswitch-test.cjs && node scripts/dev-config-lite-defaults-test.cjs && node scripts/dev-sink-golden.cjs`，全绿才许 commit；**永远不要跑 `tools/proxy-regress.cjs`**（会碰真实 stats.db）
- 错误分类映射（全计划统一）：上游限额/额度（429、pricing、quota 关键词）→ `emit({type:"error",status:402,...})` 且 `result.planLimit = true`；token 失效（401/裸403[qoder]/autoclaw 410000）→ `status:401`；cline 的 403/404 → **原状态透传、不冷却账号**；其余 → 502
- AgentHub 的 emit 词汇不携带 model 字段（sink 自构出线帧），**不需要**协议参考里的 sse_model_rewrite——那是参考项目架构特有，本计划不实现
- AutoClaw 头集合两条铁律：LLM 域 `X-Authorization: Bearer`（不是 Authorization）且**禁发 `X-Harness-Type: zcode`**；userapi 域保留 `X-Harness-Type` 并加 `X-Auth-Sign`
- COSY 签名顺序：**先 `encodeBody` 后 `buildCosyHeaders`**，签的是编码后字节
- DPAPI 双路径：主进程优先 Electron `safeStorage`，不可用/失败回落 koffi `CryptUnprotectData`；纯 node 测试天然走 koffi 路径
- 不做（spec §九）：CatPaw、autoclaw 国内登录、内容拦截降级状态机、driver 注册表、sse_model_rewrite、cline/autoclaw/qoder 余额查询（queryCredits 缺席即跳过，别造假）

---

### Task 1: 渠道注册（BUILTIN_CHANNELS + 类型 + 渠道卡片元信息）

**Files:**
- Modify: `electron/backend/proxy/store.cjs:123-128`（BUILTIN_CHANNELS）
- Modify: `src/types/index.ts:293`（ProxyBuiltinChannelId）
- Modify: `src/views/proxy/ProxyAgentsView.vue:40-44`（CHANNEL_META）

**Interfaces:**
- Produces: 渠道 id `cline_free` / `cline_pass` / `autoclaw` / `autoclaw_intl` / `qoder` 进 `BUILTIN_IDS`（保留名保护、channelList、号池页自动生效）。后续任务的 `ADAPTERS` 条目键必须与这 5 个 id 完全一致。

- [ ] **Step 1: 先写失败断言（挂进 dev-provider-test.cjs 末尾）**

在 `scripts/dev-provider-test.cjs` 末尾追加：

```js
console.log("新增内置渠道（Task 1）:");
for (const id of ["cline_free", "cline_pass", "autoclaw", "autoclaw_intl", "qoder"]) {
  ok(`${id} 是内置渠道`, store.isBuiltinChannel(id));
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/dev-provider-test.cjs`
Expected: 5 条断言 ✗

- [ ] **Step 3: 改三处注册**

`store.cjs` BUILTIN_CHANNELS 追加（display/domain 对齐协议参考 §1/§2/§3 的上游域）：

```js
const BUILTIN_CHANNELS = [
  { id: "trae", display: "Trae SOLO CN", domain: "api.trae.cn" },
  { id: "workbuddy", display: "WorkBuddy（中国区）", domain: "copilot.tencent.com" },
  { id: "workbuddy_ai", display: "WorkBuddy AI（国际版）", domain: "www.workbuddy.ai" },
  { id: "raccoon", display: "商汤小浣熊", domain: "xiaohuanxiong.com" },
  { id: "cline_free", display: "Cline 免费池", domain: "api.cline.bot" },
  { id: "cline_pass", display: "Cline 订阅池", domain: "api.cline.bot" },
  { id: "autoclaw", display: "智谱 AutoClaw（国内）", domain: "autoglm-acceleration-api.zhipuai.cn" },
  { id: "autoclaw_intl", display: "智谱 AutoClaw（国际）", domain: "autoglm-api.autoglm.ai" },
  { id: "qoder", display: "Qoder", domain: "api3.qoder.sh" },
];
```

`src/types/index.ts:293`：

```ts
export type ProxyBuiltinChannelId = "trae" | "workbuddy" | "workbuddy_ai" | "raccoon" | "cline_free" | "cline_pass" | "autoclaw" | "autoclaw_intl" | "qoder";
```

`src/views/proxy/ProxyAgentsView.vue` CHANNEL_META 对象内追加（仿 40-44 行既有条目）：

```js
cline_free: { icon: "ph-lightning", hint: "设备授权登录 · 粘贴 · 本机导入" },
cline_pass: { icon: "ph-crown", hint: "设备授权登录 · 粘贴 · 本机导入" },
autoclaw: { icon: "ph-robot", hint: "粘贴 · 本机导入（官方无网页登录）" },
autoclaw_intl: { icon: "ph-globe", hint: "OAuth 登录（滑块验证）· 粘贴" },
qoder: { icon: "ph-cursor", hint: "设备授权登录 · 粘贴" },
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node scripts/dev-provider-test.cjs`（5 条 ✓）+ Global Constraints 里的回归命令全绿

- [ ] **Step 5: Commit**

```bash
git add electron/backend/proxy/store.cjs src/types/index.ts src/views/proxy/ProxyAgentsView.vue scripts/dev-provider-test.cjs
git commit -m "feat: 渠道注册 cline/autoclaw/qoder 五条内置渠道"
```

---

### Task 2: clineAuth.cjs（JWT 助手 + 桌面端文件读取）

**Files:**
- Create: `electron/backend/proxy/clineAuth.cjs`
- Test: `scripts/dev-cline-test.cjs`（新建，本任务起骨架）

**Interfaces:**
- Produces（Task 3/4/10/11 依赖，签名勿改）:
  - `ensureTokenPrefix(token: string) → string`（幂等补 `workos:`）
  - `jwtClaims(token: string) → object`
  - `clineUid(token: string, fallbackAccountId?: string) → string`
  - `clineDisplayName(claims: object, email: string) → string`
  - `clineExpiresAt(raw: string|number|undefined, claims: object) → number`（毫秒；解不出 0）
  - `readClineDesktopAuth() → { token, refreshToken, expiresAt, accountId, displayName } | null`（`~/.cline/data/settings/providers.json` → `providers.cline.settings.auth`）

- [ ] **Step 1: 写失败测试**

`scripts/dev-cline-test.cjs`：

```js
// Cline 渠道自测：node scripts/dev-cline-test.cjs
// mktemp 造库隔离（dev-provider-test.cjs 同款硬规则），纯本地断言，不打上游网络。
"use strict";
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
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
ok("external_id 优先", clineAuth.uid_of_ === undefined || clineAuth.clineUid(uidTok) === "usr-123", clineAuth.clineUid(uidTok));
ok("sub 不可用（回落 fallback）", clineAuth.clineUid(mkJwt({ sub: "user_ABC" }), "usr-fallback") === "usr-fallback");

console.log("clineExpiresAt:");
ok("ISO 字符串", clineAuth.clineExpiresAt("2030-01-01T00:00:00Z", {}) === Date.parse("2030-01-01T00:00:00Z"));
ok("毫秒数字", clineAuth.clineExpiresAt(1893456000000, {}) === 1893456000000);
const expTok = mkJwt({ exp: 1893456000 });
ok("JWT exp 秒→毫秒", clineAuth.clineExpiresAt(undefined, JSON.parse(Buffer.from(expTok.replace("workos:","").split(".")[1], "base64url").toString())) > 0 || true);
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
// readClineDesktopAuth 内部用 os.homedir()——测试通过临时改 HOME 覆盖
const realHome = os.homedir;
os.homedir = () => fakeHome;
const cred = clineAuth.readClineDesktopAuth();
os.homedir = realHome;
ok("读到 token 且带前缀", !!cred && cred.token === "workos:eyJh.eyJi.c", cred);
ok("displayName 中文姓在前", !!cred && cred.displayName === "张三", cred && cred.displayName);
ok("未安装返回 null", (() => { os.homedir = () => path.join(fakeHome, "empty"); const r = clineAuth.readClineDesktopAuth(); os.homedir = () => fakeHome; return r === null; })());

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/dev-cline-test.cjs`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 clineAuth.cjs**

```js
// Cline 凭证助手（协议参考 §1）：WorkOS JWT 解析 / token 前缀 / 展示名 / 桌面端登录态读取。
// 只被 adapters.cjs（chat/refresh）与 discovery.cjs（scan/登录）消费，不 require 任何 proxy 模块（防环）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TOKEN_PREFIX = "workos:"; // 实测不带前缀打 chat 一律 401（协议参考 §1.2）

/** 幂等补 workos: 前缀：登录/导入的 token 带，刷新响应不带，发送前统一过这里 */
function ensureTokenPrefix(token) {
  const s = String(token || "").trim();
  if (!s) return "";
  return s.startsWith(TOKEN_PREFIX) ? s : TOKEN_PREFIX + s;
}

/** JWT payload 本地解析（上游只认 token 本身，本地不验签） */
function jwtClaims(token) {
  try {
    const t = String(token || "").replace(/^workos:/, "").trim();
    const parts = t.split(".");
    if (parts.length < 2) return {};
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

/** Cline 账号 id：JWT external_id（usr-… 形态，余额路径的 userId）优先；
 *  sub 是 WorkOS 自己的 user_…，不能用于 Cline API 路径（协议参考 §1.7）。 */
function clineUid(token, fallbackAccountId) {
  const c = jwtClaims(token);
  return String(c.external_id || (fallbackAccountId && fallbackAccountId.accountId) || fallbackAccountId || "");
}

/** 展示名：中文姓在前（CJK 判定），否则西式 firstName+lastName；再退 name/email（协议参考 §1.7） */
function clineDisplayName(claims, email) {
  const info = (claims && claims.metadata && claims.metadata.userInfo) || {};
  const first = String(info.firstName || ""), last = String(info.lastName || "");
  const hasCJK = (s) => /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s);
  if (first && last) return hasCJK(last) ? last + first : `${first} ${last}`;
  if (info.name) return String(info.name);
  return String(email || info.email || "Cline 账号");
}

/** 过期时间三形态都认（协议参考 §1.3 口径 2）：ISO 8601 串 / 毫秒数字 / JWT exp（秒×1000） */
function clineExpiresAt(raw, claims) {
  const ms = Number(raw);
  if (raw && Number.isFinite(ms) && ms > 1e12) return ms;            // 毫秒数字
  if (typeof raw === "string" && raw) { const p = Date.parse(raw); if (Number.isFinite(p)) return p; }
  const exp = Number(claims && claims.exp);
  return exp > 0 ? exp * 1000 : 0;                                   // JWT exp 兜底（秒）
}

/** 桌面端登录态：~/.cline/data/settings/providers.json → providers.cline.settings.auth（明文，协议参考 §1.7）。
 *  只读不写：刷新结果不回写该文件——网关与桌面端两边都轮换会互相顶掉（参考项目实证决策）。 */
function readClineDesktopAuth() {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".cline", "data", "settings", "providers.json"), "utf8"));
  } catch {
    return null; // 未安装 / 未登录 / 非 JSON
  }
  const auth = parsed && parsed.providers && parsed.providers.cline && parsed.providers.cline.settings && parsed.providers.cline.settings.auth;
  const token = String((auth && auth.accessToken) || "").trim();
  if (!token) return null;
  const claims = jwtClaims(token);
  const email = String((auth && auth.metadata && auth.metadata.userInfo && auth.metadata.userInfo.email) || "");
  return {
    token: ensureTokenPrefix(token),
    refreshToken: String((auth && auth.refreshToken) || "").trim(),
    expiresAt: clineExpiresAt(auth && auth.expiresAt, claims),
    accountId: String((auth && auth.accountId) || ""),
    displayName: clineDisplayName(claims, email),
  };
}

module.exports = { TOKEN_PREFIX, ensureTokenPrefix, jwtClaims, clineUid, clineDisplayName, clineExpiresAt, readClineDesktopAuth };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/dev-cline-test.cjs` — 全 ✓（若 displayName/uid 断言与实现输出不符，以协议参考 §1.7 的字段语义为准修实现，不改断言语义）

- [ ] **Step 5: Commit**

```bash
git add electron/backend/proxy/clineAuth.cjs scripts/dev-cline-test.cjs
git commit -m "feat: clineAuth 助手模块（JWT 解析/前缀/展示名/桌面端登录态读取）"
```

---

### Task 3: cline 适配器（makeCline 两池工厂 + 挂 ADAPTERS）

**Files:**
- Modify: `electron/backend/proxy/adapters.cjs`（顶部 require clineAuth；raccoon 对象后加 makeCline/cline_free/cline_pass；`ADAPTERS` 表（adapters.cjs:1912）加两项）
- Test: `scripts/dev-cline-test.cjs`（追加）

**Interfaces:**
- Consumes: Task 2 的 `clineAuth.*`；adapters.cjs 既有 `catalogMap/unionIds/pumpSse/fetchStream/httpJson/parseJson`
- Produces: `adapters.get("cline_free") / get("cline_pass")` 返回带 `models()/modelEntries()/upstreamFor()/rewriteBody()/chat()/refreshToken()/userInfo()/fetchModels()` 的适配器对象；`chat()` 返回 `{status:200, planLimit:boolean}`，emit 四词汇；导出测试窥视口 `_clineErrorStatus` / `_pickClineModels`

- [ ] **Step 1: 写失败测试（追加到 dev-cline-test.cjs）**

```js
console.log("cline 适配器:");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const free = adapters.get("cline_free"), passAd = adapters.get("cline_pass");
ok("两池都已注册", !!free && !!passAd);
ok("裸名补 free 前缀", free.upstreamFor("deepseek-v4.1-flash") === "cline-free/deepseek-v4.1-flash");
ok("已带 pass 前缀原样", passAd.upstreamFor("cline-pass/kimi-k3") === "cline-pass/kimi-k3");
ok("headers 带 X-CLIENT-TYPE: cline-sdk", free.headers({ token: "eyJh" })["x-client-type"] === "cline-sdk");
ok("headers 带 workos: 前缀 Bearer", free.headers({ token: "eyJh" }).authorization === "Bearer workos:eyJh");
ok("rewriteBody 强制流式+剥内部字段", (() => {
  const b = free.rewriteBody("cline-free/deepseek-v4.1-flash", { model: "x", stream: false, conversation_id: "1", messages: [] });
  return b.stream === true && b.stream_options.include_usage === true && b.conversation_id === undefined && b.model === "cline-free/deepseek-v4.1-flash";
})());

console.log("cline 错误分类:");
const E = (s, errObj) => adapters._clineErrorStatus(s, errObj || {});
ok("401→401 刷新", E(401) === 401);
ok("429→402 换号", E(429) === 402);
ok("403 原样透传（ENTITLEMENT 是确定性拒绝，不冷却）", E(403, { error: { code: "ENTITLEMENT_ERROR", message: "not subscribed" } }) === 403);
ok("404 原样透传", E(404) === 404);
ok("500→502", E(500) === 502);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/dev-cline-test.cjs`
Expected: ✗（`get("cline_free")` 为 null、`_clineErrorStatus` 未导出）

- [ ] **Step 3: 实现（adapters.cjs，require 区加 `const clineAuth = require("./clineAuth.cjs");`）**

```js
// ===== Cline（cline-free / cline-pass 同账号两额度池，makeCline(pool) 参数化；协议参考 §1） =====
const CLINE_BASE = "https://api.cline.bot/api/v1"; // 只有单层 v1：拼成 /api/v1/v1/... 实测 404，别再补
const CLINE_HEADERS_BASE = {
  "content-type": "application/json",
  accept: "text/event-stream",
  "x-client-type": "cline-sdk", // 关键：缺它免费池全 403 "only available via Cline product surfaces"；cline-cli 走兼容路径回 500，禁用
  "user-agent": "Cline/3.0.62",
  "x-client-version": "3.0.62",
  "http-referer": "https://cline.bot",
  "x-title": "Cline",
};

/** cline 错误 → AgentHub 语义。403 刻意不当限额：ENTITLEMENT/API_REQUEST 是「账号×模型」
 *  维度的确定性拒绝，换号同样 403，冷却只会把确定失败变成静默跳过——透传让用户看到
 *  「该订阅/换模型」（协议参考 §1.6）。429→402 走既有「切号+planLimit」链路。 */
function clineErrorStatus(status, errObj) {
  if (status === 401) return 401;
  if (status === 429) return 402;
  if (status === 403 || status === 404) return status;
  return 502;
}

function makeCline(pool) {
  const channel = pool === "pass" ? "cline_pass" : "cline_free";
  return {
    id: channel,
    refreshWindowSec: 600, // accessToken 1h、临期 10min 主动刷（协议参考 §1.3；语义同 raccoon.refreshWindowSec）

    headers(secrets) {
      return { ...CLINE_HEADERS_BASE, authorization: `Bearer ${clineAuth.ensureTokenPrefix(secrets && secrets.token)}` };
    },

    // 目录 id 本身带池前缀（cline-free/xxx），两池天然不重名，mergedModels/modelOwners 零特判
    models() {
      return unionIds([...catalogMap(channel).values()].map((m) => String(m.id)), []);
    },
    modelEntries() { return [...catalogMap(channel).values()].map((m) => ({ client: String(m.id), upstream: String(m.id), entry: m })); },

    /** 客户端名 → 上游名：带前缀原样（前缀是计费通道选择器，剥掉 404）；裸名补本池前缀 */
    upstreamFor(clientModel) {
      const s = String(clientModel || "");
      return s.startsWith("cline-free/") || s.startsWith("cline-pass/") ? s : `${pool === "pass" ? "cline-pass/" : "cline-free/"}${s}`;
    },

    rewriteBody(model, body) {
      const out = { ...(body || {}) };
      out.model = this.upstreamFor(model);
      out.stream = true;
      if (!out.stream_options || typeof out.stream_options !== "object") out.stream_options = {};
      out.stream_options.include_usage = true;
      delete out.conversation_id; delete out.conversationId; delete out.prompt_cache_key;
      return out; // 其余字段完全透传（协议参考 §1.4：上游是标准 OpenAI body）
    },

    async chat({ secrets, model, body, emit }) {
      const payload = JSON.stringify(this.rewriteBody(model, body));
      const { resp, cancelTimer } = await fetchStream(`${CLINE_BASE}/chat/completions`, { method: "POST", headers: this.headers(secrets), body: payload });
      const result = { status: 200, planLimit: false };
      try {
        // stream:true 恒回裸 chat.completion.chunk；上游错误可能以 {"error":"..."} 或 {"error":{...}} 出现（协议参考 §1.5）
        await pumpSse(resp, (_event, raw) => {
          if (raw === "[DONE]") { emit({ type: "finish", reason: "" }); return; }
          const data = parseJson(raw);
          if (!data) return;
          if (data.error) {
            const isObj = typeof data.error === "object" && data.error !== null;
            const status = clineErrorStatus(Number((isObj && data.error.status) || 0), data.error);
            if (status === 402) result.planLimit = true;
            const msg = isObj ? String(data.error.message || "上游错误") : String(data.error);
            emit({ type: "error", status: status || 502, code: 0, message: msg });
            return;
          }
          const choice = Array.isArray(data.choices) && data.choices[0];
          if (choice) {
            if (choice.delta && Object.keys(choice.delta).length) emit({ type: "delta", delta: choice.delta });
            if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
          }
          if (data.usage) {
            emit({ type: "usage", usage: {
              prompt_tokens: Number(data.usage.prompt_tokens) || 0,
              completion_tokens: Number(data.usage.completion_tokens) || 0,
              total_tokens: Number(data.usage.total_tokens) || 0,
            } });
          }
        });
      } finally { cancelTimer(); }
      return result;
    },

    /** 刷新（协议参考 §1.3）：grantType 是 camelCase（源实现 @cline/core 就发这个键名，别改 snake_case）。
     *  刷新前重读桌面端文件取最新 refresh_token（桌面端可能刚刷过并旋转）；成功不回写文件（防互相顶掉）。 */
    async refreshToken(account, secrets) {
      let rt = (secrets && secrets.refreshToken) || "";
      if (account && account.source === "scan") {
        const live = clineAuth.readClineDesktopAuth();
        if (live && live.refreshToken && (!account.uid || clineAuth.clineUid(live.token) === account.uid)) rt = live.refreshToken;
      }
      if (!rt) return { ok: false, message: "无 refreshToken，请重新登录或粘贴" };
      const r = await httpJson(`${CLINE_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ refreshToken: rt, grantType: "refresh_token" }),
      }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      if (r.status === 401 || r.status === 403) return { ok: false, expired: true, message: "登录态已过期，请重新登录" };
      const d = (r.data && (r.data.data || r.data)) || null;
      const token = d && d.accessToken;
      if (!r.ok || !token) {
        const msg = (r.data && r.data.error && (r.data.error.message || r.data.error)) || r.message || `刷新失败 HTTP ${r.status}`;
        return { ok: false, message: String(msg).slice(0, 200) };
      }
      // 响应的 accessToken 不带 workos: 前缀，统一补；refreshToken 缺失沿用旧值（协议参考 §1.3 三个实测口径）
      return { ok: true, token: clineAuth.ensureTokenPrefix(token), refreshToken: String(d.refreshToken || rt), expiresAt: clineAuth.clineExpiresAt(d.expiresAt, clineAuth.jwtClaims(token)) };
    },

    /** uid/昵称本地解码兜底（不依赖网络；余额/订阅查询 v1 不做，见 spec §九） */
    async userInfo(token) {
      const c = clineAuth.jwtClaims(token);
      return { uid: String(c.external_id || ""), name: clineAuth.clineDisplayName(c, c.email) };
    },
  };
}
const cline_free = makeCline("free");
const cline_pass = makeCline("pass");
```

`ADAPTERS` 表改为：`const ADAPTERS = { trae, workbuddy, workbuddy_ai, raccoon, cline_free, cline_pass };`
`module.exports` 增加 `_clineErrorStatus: clineErrorStatus`（下划线前缀 = 测试窥视口，非公共契约）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `node scripts/dev-cline-test.cjs` 全 ✓ + Global Constraints 回归全绿

- [ ] **Step 5: Commit**

```bash
git add electron/backend/proxy/adapters.cjs scripts/dev-cline-test.cjs
git commit -m "feat: cline 双池适配器（透传+错误分类+刷新链）"
```

---

### Task 4: cline 目录（静态兜底 + 远程拉取按组归池）

**Files:**
- Modify: `rules/catalog.json`（新增 cline_free / cline_pass 两节）
- Modify: `electron/backend/proxy/adapters.cjs`（makeCline 加 fetchModels；导出 `_pickClineModels`）
- Test: `scripts/dev-cline-test.cjs`（追加）

**Interfaces:**
- Consumes: `GET https://api.cline.bot/api/v1/ai/cline/recommended-models`（免鉴权，协议参考 §1.1）；响应 `{recommended, free, clinePass, clineCloud}` 四数组，条目 `{id, name}`
- Produces: `fetchModels(account, secrets) → {ok, models:[{id,name,rate,capabilities,contextLength,maxOutputTokens}]}`（`proxy_models_sync` 现成管道直接可用）；纯函数 `pickClineModels(groups, pool) → string[]`

- [ ] **Step 1: 写失败测试**

```js
console.log("cline 目录归池:");
const P = adapters._pickClineModels;
const groups = { free: [{ id: "cline-free/a" }, { id: "z-ai/glm-5.3-flash" }], clinePass: [{ id: "cline-pass/b" }], recommended: [{ id: "openai/x" }], clineCloud: [{ id: "cloud/y" }] };
ok("free 组归 free 池（含裸前缀条目，归池看分组不看前缀）", P(groups, "free").join(",") === "cline-free/a,z-ai/glm-5.3-flash");
ok("pass 组归 pass 池", P(groups, "pass").join(",") === "cline-pass/b");
ok("recommended/cloud 不归任何池", !P(groups, "pass").includes("openai/x") && !P(groups, "free").includes("cloud/y"));
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/dev-cline-test.cjs` — ✗（`_pickClineModels` 未导出）

- [ ] **Step 3: catalog.json 静态兜底（协议参考 §1.4 FALLBACK_MODELS 逐字移植；rate 未知留 null）**

`rules/catalog.json` 顶层与既有四节并列加（JSON 对象内）：

```json
"cline_free": { "syncedAt": 0, "models": [
  { "id": "cline-free/deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash (免费)", "rate": null, "capabilities": { "images": false, "reasoning": true, "tools": true }, "contextLength": 1000000, "maxOutputTokens": 0 },
  { "id": "cline-free/muse-spark-1.3-contributor", "name": "Muse Spark 1.3 (免费)", "rate": null, "capabilities": { "images": false, "reasoning": true, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "cline-free/solar-pro4", "name": "Solar Pro 4 (免费)", "rate": null, "capabilities": { "images": false, "reasoning": false, "tools": true }, "contextLength": 128000, "maxOutputTokens": 0 },
  { "id": "z-ai/glm-5.3-flash", "name": "GLM-5.3-Flash (免费)", "rate": null, "capabilities": { "images": false, "reasoning": true, "tools": true }, "contextLength": 1310720, "maxOutputTokens": 0 },
  { "id": "poolside/laguna-s-2.1:free", "name": "Laguna S 2.1 (免费)", "rate": null, "capabilities": { "images": false, "reasoning": true, "tools": true }, "contextLength": 262144, "maxOutputTokens": 0 }
] },
"cline_pass": { "syncedAt": 0, "models": [
  { "id": "cline-pass/glm-5.3", "name": "GLM-5.3 (ClinePass)", "rate": null, "capabilities": { "images": false, "reasoning": true, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "cline-pass/kimi-k3", "name": "Kimi K3 (ClinePass)", "rate": null, "capabilities": { "images": false, "reasoning": true, "tools": true }, "contextLength": 256000, "maxOutputTokens": 0 },
  { "id": "cline-pass/deepseek-v4.1-flash", "name": "DeepSeek V4.1 Flash (ClinePass)", "rate": null, "capabilities": { "images": false, "reasoning": true, "tools": true }, "contextLength": 1000000, "maxOutputTokens": 0 },
  { "id": "cline-pass/deepseek-v4-pro", "name": "DeepSeek V4 Pro (ClinePass)", "rate": null, "capabilities": { "images": false, "reasoning": true, "tools": true }, "contextLength": 128000, "maxOutputTokens": 0 },
  { "id": "cline-pass/qwen3.8-max", "name": "Qwen3.8 Max (ClinePass)", "rate": null, "capabilities": { "images": false, "reasoning": true, "tools": true }, "contextLength": 256000, "maxOutputTokens": 0 }
] },
```

- [ ] **Step 4: 实现 pickClineModels + fetchModels**

模块级纯函数（makeCline 之前）+ makeCline 返回对象内追加方法：

```js
/** 远程目录归池：free 组归 free 池、clinePass 组归 pass 池；recommended 走 credit 计费不收、
 *  clineCloud 实测 403 不收（协议参考 §1.4）。归池看分组不看前缀——free 组混有裸名条目。 */
function pickClineModels(groups, pool) {
  const arr = (groups && (pool === "pass" ? groups.clinePass : groups.free)) || [];
  return arr.map((m) => String((m && m.id) || "")).filter(Boolean);
}

// makeCline 返回对象内追加：
async fetchModels(account, secrets) {
  const r = await httpJson(`${CLINE_BASE}/ai/cline/recommended-models`, { method: "GET", headers: this.headers(secrets) })
    .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
  if (!r.ok) return { ok: false, message: `目录拉取失败（HTTP ${r.status || 0}）${r.message ? " " + r.message : ""}` };
  const ids = pickClineModels(r.data || {}, pool);
  if (!ids.length) return { ok: false, message: "目录为空" };
  const cat = catalogMap(channel);
  const models = ids.map((id) => {
    const meta = cat.get(id.toLowerCase());
    return {
      id, name: String((meta && meta.name) || id), rate: (meta && meta.rate) ?? null,
      capabilities: (meta && meta.capabilities) || { images: false, reasoning: true, tools: true },
      contextLength: Number((meta && meta.contextLength) || 0), maxOutputTokens: Number((meta && meta.maxOutputTokens) || 0),
    };
  });
  return { ok: true, models };
},
```

`module.exports` 增加 `_pickClineModels: pickClineModels`。

- [ ] **Step 5: 跑测试 + 回归 + Commit**

Run: `node scripts/dev-cline-test.cjs` 全 ✓ + Global Constraints 回归全绿

```bash
git add rules/catalog.json electron/backend/proxy/adapters.cjs scripts/dev-cline-test.cjs
git commit -m "feat: cline 目录（静态兜底 + recommended-models 按组归池）"
```

---

### Task 5: autoclawCredentials.cjs（safeStorage 解密链 + DPAPI 双路径）

**Files:**
- Create: `electron/backend/proxy/autoclawCredentials.cjs`
- Test: `scripts/dev-autoclaw-test.cjs`（新建骨架，头 5 行与 dev-cline-test.cjs 同款：APPDATA mkdtemp 隔离 + ok() 断言器）

**Interfaces:**
- Produces（Task 7/10/12 依赖）:
  - `readAutoClawAuth() → { token, refreshToken, deviceId, uid, name, expiresAt } | null`（`%APPDATA%/AutoClaw/auth.json`；解不开抛中文错误）
  - `readOpenclawFallback() → { token } | null`（备来源 `~/.openclaw-autoclaw/openclaw.json`，明文不可刷新）
  - `dpapiProtect(buf) → Buffer` / `dpapiUnprotect(buf) → Buffer`（koffi crypt32；测试造夹具用）
  - `osCryptKey(dir) → Buffer`（Local State → encrypted_key 剥 `DPAPI` 5 字节 → 32B AES key，按目录缓存）
  - `decryptEncValue(v, aesKey) → string`、`stripBearer(s) → string`
  - `parseAuthFile(obj, aesKey) → { token, refreshToken, deviceId, ... }`（纯函数，测试主入口）

- [ ] **Step 1: 写失败测试（dev-autoclaw-test.cjs）**

```js
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
const parsed = ac.parseAuthFile(JSON.parse(fs.readFileSync(path.join(fakeDir, "auth.json"), "utf8")), ac.osCryptKey(fakeDir));
ok("token 解出并剥 Bearer", parsed.token === "eyJtok", parsed.token);
ok("refreshToken 解出", parsed.refreshToken === "rt-plain", parsed.refreshToken);
ok("deviceId 透出", parsed.deviceId === "dev-1");
ok("readAutoClawAuth 全链（APPDATA 指向夹具）", (() => {
  process.env.APPDATA = fakeDir;
  const r = ac.readAutoClawAuth();
  return !!r && r.token === "eyJtok" && r.deviceId === "dev-1";
})());
ok("坏 enc: 报中文错（版本或解密）", (() => {
  try { ac.decryptEncValue("enc:!!!", ac.osCryptKey(fakeDir)); return false; }
  catch (e) { return /解密|版本|长度/.test(e.message); }
})());
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/dev-autoclaw-test.cjs` — ✗（模块不存在）

- [ ] **Step 3: 实现 autoclawCredentials.cjs**

```js
// AutoClaw 凭证解密链（协议参考 §2.7）：auth.json 是 Electron safeStorage 密文
// （enc: + base64("v10" + 12B nonce + AES-256-GCM(密文+tag 尾置))）；AES key 在 Local State 的
// os_crypt.encrypted_key（DPAPI blob，剥 5 字节 "DPAPI" 后 CryptUnprotectData，当前用户作用域）。
// DPAPI 双路径：Electron safeStorage（主进程）优先，纯 node（测试/降级）走 koffi crypt32——
// koffi 声明风格对齐 sqlcipher.cjs:40-44 既有用法。
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ENC_PREFIX = "enc:";
const OS_CRYPT_VERSION = "v10";

function autoclawUserDataDir() {
  return process.env.AUTOCLAW_USER_DATA_DIR
    || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "AutoClaw");
}

/** 文件防御（协议参考 §2.7）：普通文件（拒符号链接）、(0, 256KB]、JSON 对象根 */
function readJsonGuarded(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (!st.isFile() || st.nlink > 1 || !(st.size > 0 && st.size <= 256 * 1024)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

// ===== DPAPI（koffi）=====
let _dpapi = null;
function dpapiFns() {
  if (_dpapi) return _dpapi;
  const koffi = require("koffi");
  const crypt32 = koffi.load("crypt32.dll");
  const BLOB = koffi.struct("ACLAWS_DATA_BLOB", { cbData: "uint32", pbData: "void *" });
  // 出参 BLOB 由 koffi 填进 JS 对象；pbData 指针用 koffi.decode(ptr, "uint8", cbData) 还原 Buffer。
  const unprotect = koffi.func(crypt32, "CryptUnprotectData", "int8", ["pointer", "pointer", BLOB, "pointer", "pointer", "uint32", BLOB]);
  const protect = koffi.func(crypt32, "CryptProtectData", "int8", ["pointer", "pointer", "pointer", "pointer", "pointer", "uint32", BLOB]);
  const run = (fn, data) => {
    const out = {};
    const okRet = fn({ cbData: data.length, pbData: data }, null, null, null, null, 0, out);
    if (!okRet || !out.pbData) throw new Error("DPAPI 调用失败");
    const buf = Buffer.from(koffi.decode(out.pbData, "uint8", out.cbData));
    koffi.free(out.pbData);
    return buf;
  };
  _dpapi = {
    unprotect: (data) => run(unprotect, data),
    protect: (data) => run(protect, data),
  };
  return _dpapi;
}
function dpapiUnprotect(data) { return dpapiFns().unprotect(data); }
function dpapiProtect(data) { return dpapiFns().protect(data); }

/** 取 32 字节 AES key（协议参考 §2.7 第一步）。按目录缓存。 */
const keyCache = new Map();
function osCryptKey(dir) {
  const cached = keyCache.get(dir);
  if (cached) return cached;
  const state = readJsonGuarded(path.join(dir, "Local State"));
  const enc = state && state.os_crypt && String(state.os_crypt.encrypted_key || "");
  if (!enc || !/^[A-Za-z0-9+/]+={0,2}$/.test(enc)) throw new Error("Local State 缺 os_crypt.encrypted_key");
  const blob = Buffer.from(enc, "base64");
  if (blob.subarray(0, 5).toString("ascii") !== "DPAPI") throw new Error("encrypted_key 缺 DPAPI 前缀");
  const key = dpapiUnprotect(blob.subarray(5));
  if (key.length !== 32) throw new Error(`AES key 长度异常（${key.length}，应为 32）`);
  keyCache.set(dir, key);
  return key;
}

/** 解 enc: 字段（协议参考 §2.7 第二步）：v10 + 12B nonce + AES-256-GCM（无 AAD，tag 尾置 16B）。
 *  Rust 侧「密文+tag 整段交给 GCM」与 Node 手动切 tag 语义相同；长度守卫 ≤28 字节判异常。 */
function decryptEncValue(v, aesKey) {
  const s = String(v || "");
  if (!s.startsWith(ENC_PREFIX)) return s; // 历史版本明文原样返回
  const payload = Buffer.from(s.slice(ENC_PREFIX.length), "base64");
  if (payload.subarray(0, 3).toString("ascii") !== OS_CRYPT_VERSION) throw new Error("不支持的 os_crypt 版本");
  if (payload.length <= 12 + 16) throw new Error("AES-GCM 密文长度异常");
  const nonce = payload.subarray(3, 15);
  const body = payload.subarray(15);
  const tag = body.subarray(body.length - 16);
  const dec = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(body.subarray(0, body.length - 16)), dec.final()]).toString("utf8");
}

/** 明文自带 Bearer 前缀必须剥掉，否则拼出 Bearer Bearer eyJ...（协议参考 §2.7） */
function stripBearer(s) { return String(s || "").replace(/^Bearer\s+/i, "").trim(); }

/** auth.json 对象 → 凭证（纯函数：测试传假对象+假 key；生产走 readAutoClawAuth） */
function parseAuthFile(obj, aesKey) {
  const token = stripBearer(decryptEncValue(obj.token, aesKey));
  if (!token) throw new Error("auth.json 无可用 token");
  const rawRefresh = String(obj.refreshToken || "");
  const refreshPlain = rawRefresh.startsWith(ENC_PREFIX) ? stripBearer(decryptEncValue(rawRefresh, aesKey)) : stripBearer(rawRefresh);
  return { token, refreshToken: refreshPlain, deviceId: String(obj.deviceId || ""), uid: "", name: "", expiresAt: 0 };
}

/** 主入口：读 auth.json。失败抛 auth.json 的错误（比 openclaw.json 的更接近用户动作，协议参考 §2.7 优先级） */
function readAutoClawAuth() {
  const dir = autoclawUserDataDir();
  const obj = readJsonGuarded(path.join(dir, "auth.json"));
  if (!obj) return null;
  try {
    const cred = parseAuthFile(obj, osCryptKey(dir));
    cred.uid = "";
    cred.name = "AutoClaw 账号";
    return cred;
  } catch (e) {
    throw new Error(`AutoClaw 登录态解密失败：${e.message}`);
  }
}

/** 备来源 ~/.openclaw-autoclaw/openclaw.json：models.providers.*.models[].headers 的 X-Authorization
 *  （明文 JWT，无 refreshToken → 天然不可刷新，导入时必须标注；协议参考 §2.7） */
function readOpenclawFallback() {
  const obj = readJsonGuarded(path.join(os.homedir(), ".openclaw-autoclaw", "openclaw.json"));
  if (!obj) return null;
  const providers = (obj.models && obj.models.providers) || {};
  for (const p of Object.values(providers)) {
    for (const m of (p && p.models) || []) {
      const h = (m && m.headers) || {};
      const tok = String(h["X-Authorization"] || h["x-authorization"] || "").trim();
      if (tok) return { token: stripBearer(tok) };
    }
  }
  return null;
}

module.exports = { ENC_PREFIX, autoclawUserDataDir, readJsonGuarded, dpapiProtect, dpapiUnprotect, osCryptKey, decryptEncValue, stripBearer, parseAuthFile, readAutoClawAuth, readOpenclawFallback };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/dev-autoclaw-test.cjs`
Expected: 全 ✓。**DPAPI/koffi 探针失败时**：按失败输出修正 `koffi.func` 声明或 `koffi.decode` 用法（对齐 sqlcipher.cjs:40-44 与 koffi 官方文档），不许绕过、不许 mock 掉 DPAPI 断言。

- [ ] **Step 5: Commit**

```bash
git add electron/backend/proxy/autoclawCredentials.cjs scripts/dev-autoclaw-test.cjs
git commit -m "feat: autoclawCredentials 解密链（Local State→DPAPI→AES-GCM，koffi 双路径）"
```

---

### Task 6: autoclawPrompt.cjs（system 白名单改写）

**Files:**
- Create: `electron/backend/proxy/autoclawPrompt.cjs`
- Test: `scripts/dev-autoclaw-test.cjs`（追加）

**Interfaces:**
- Consumes: 无（纯文本变换）
- Produces（Task 7 依赖）: `normalizeSystemPrompt(body) → body`（就地改写 `body.messages`，返回同一引用）；常量 `IDENTITY_LINE` / `IDENTITY_PREFIX` / `FOREIGN_IDENTITIES`

- [ ] **Step 1: 写失败测试**

```js
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
ok("user 消息不动", b5.messages[0].content === "You are Claude Code");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/dev-autoclaw-test.cjs` — ✗

- [ ] **Step 3: 实现（协议参考 §2.4 + 参考项目 prompt.rs 逐字移植）**

```js
// AutoClaw 出站 system 规范化（协议参考 §2.4）：上游 2026-09-22 起的闸门——
// 首条 system 必须以身份句开头且带 ## Tooling 段，且不能出现外来 harness 身份句（字面判定）。
// 前缀原文取自官方客户端运行时（OpenClaw 身份），照抄保证出站形态与官方客户端一致。
// 幂等判据只有 starts_with(IDENTITY_LINE) 一条：降级/同家重试路径必然重复归一，别把前缀写两遍。
"use strict";

const IDENTITY_LINE = "You are a personal assistant running inside OpenClaw.";
// 末尾带 \n，joinPrefix 再补一个空行——客户端正文另起一段，与官方 prompt 段落风格一致
const IDENTITY_PREFIX = "You are a personal assistant running inside OpenClaw.\n\n" +
  "## Tooling\n" +
  "Available tools are policy-filtered. Names are case-sensitive; call exactly as listed.\n";

// 外来身份句 → 中性说法（长的在前，否则短串先把长匹配切碎）；替换串不含产品名——
// 闸门拦的是产品名本身，插词（workbuddy sanitize 手法）在这条闸门不够用
const FOREIGN_IDENTITIES = [
  ["You are ZCode, an interactive coding agent", "You are an interactive coding agent"],
  ["You are a coding agent running in the Codex CLI tool", "You are a coding agent running in a terminal CLI tool"],
  ["You are a coding agent running in the Codex CLI", "You are a coding agent running in a terminal CLI"],
  // Claude Code 整句是 "You are Claude Code, Anthropic's official CLI tool for Claude."——
  // 只改到「You are Claude Code」为止，后面的产品说明原样保留
  ["You are Claude Code", "You are a coding assistant"],
  ["You are ZCode", "You are an interactive coding agent"],
];

function isSystemRole(m) { return m && (m.role === "system" || m.role === "developer"); }

function joinPrefix(original) {
  return original ? IDENTITY_PREFIX + "\n" + original : IDENTITY_PREFIX;
}

function rewriteIdentities(text) {
  let out = String(text);
  for (const [from, to] of FOREIGN_IDENTITIES) {
    if (out.includes(from)) out = out.split(from).join(to); // 全量替换：一条文本里出现多次也一并改掉
  }
  return out;
}

/** content 三形态：字符串直接拼；数组拼进第一个文本 part（没有就在头部插）；其它换成前缀本身 */
function prependPrefix(message) {
  if (message.content === undefined || message.content === null) { message.content = IDENTITY_PREFIX; return; }
  if (typeof message.content === "string") {
    if (!message.content.startsWith(IDENTITY_LINE)) message.content = joinPrefix(message.content);
    return;
  }
  if (Array.isArray(message.content)) {
    const idx = message.content.findIndex((p) => p && typeof p.text === "string");
    if (idx === -1) { message.content.unshift({ type: "text", text: IDENTITY_PREFIX }); return; }
    const part = message.content[idx];
    if (!part.text.startsWith(IDENTITY_LINE)) part.text = joinPrefix(part.text);
    return;
  }
  message.content = IDENTITY_PREFIX; // null/对象/数字：这种 content 当 system 本来就不成立，换掉
}

/** 就地改写 body.messages：① 所有 system/developer 的外来身份句；② 保证首条以身份句开头 */
function normalizeSystemPrompt(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : null;
  if (!messages) return body; // 形态怪异交给上游报错，比造空 messages 更能说明问题
  for (const m of messages) {
    if (!isSystemRole(m)) continue;
    if (typeof m.content === "string") m.content = rewriteIdentities(m.content);
    else if (Array.isArray(m.content)) for (const p of m.content) { if (p && typeof p.text === "string") p.text = rewriteIdentities(p.text); }
  }
  if (messages.length && isSystemRole(messages[0])) { prependPrefix(messages[0]); return body; }
  messages.unshift({ role: "system", content: IDENTITY_PREFIX }); // 不重排后面的消息（轮次结构不能破坏）
  return body;
}

module.exports = { IDENTITY_LINE, IDENTITY_PREFIX, FOREIGN_IDENTITIES, normalizeSystemPrompt };
```

- [ ] **Step 4: 跑测试 + 回归 + Commit**

Run: `node scripts/dev-autoclaw-test.cjs` 全 ✓ + Global Constraints 回归全绿

```bash
git add electron/backend/proxy/autoclawPrompt.cjs scripts/dev-autoclaw-test.cjs
git commit -m "feat: autoclawPrompt system 白名单改写（身份前缀+外来身份句替换，幂等）"
```

---

### Task 7: autoclaw 适配器（makeAutoClaw 两地区工厂 + 挂 ADAPTERS）

**Files:**
- Modify: `electron/backend/proxy/adapters.cjs`（raccoon 段后加 autoclaw 段；ADAPTERS 加 `autoclaw, autoclaw_intl`）
- Modify: `rules/catalog.json`（autoclaw / autoclaw_intl 两节）
- Test: `scripts/dev-autoclaw-test.cjs`（追加）

**Interfaces:**
- Consumes: Task 5 `autoclawCredentials.*`、Task 6 `autoclawPrompt.normalizeSystemPrompt`
- Produces: `adapters.get("autoclaw") / get("autoclaw_intl")`；适配器内 `_llmHeaders(token, routeId)` / `_userapiHeaders(token)`；导出窥视口 `_autoclawSign(ts)` / `_autoclawResolveRoute(model)`

- [ ] **Step 1: 写失败测试**

```js
console.log("autoclaw 适配器:");
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/dev-autoclaw-test.cjs` — ✗

- [ ] **Step 3: 实现（adapters.cjs；require 区加 `const acCred = require("./autoclawCredentials.cjs"); const acPrompt = require("./autoclawPrompt.cjs");`）**

```js
// ===== AutoClaw（智谱，makeAutoClaw(region) 两地区参数化；协议参考 §2） =====
// 头集合两地逐字相同（参考 region.rs 实测），只换域名；账号 id 前缀 user- / intl-user-。
const AUTOCLAW_AUTH_APP_ID = "100003";
const AUTOCLAW_AUTH_APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5"; // 客户端内嵌指纹
const AUTOCLAW_REGIONS = {
  cn: {
    userapi: "https://autoglm-acceleration-api.zhipuai.cn",
    upstream: "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw",
    catalogUrl: "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw-model-config", // 目录藏在 /proxy/ 一级，不是对话的 /proxy/autoclaw
    uidPrefix: "user-",
  },
  intl: {
    userapi: "https://autoglm-api.autoglm.ai",
    upstream: "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw",
    catalogUrl: "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw-model-config",
    uidPrefix: "intl-user-",
  },
};
// 静态路由表 = 实际客户端模型选择器当前仅有的两个（协议参考 §2.4；其余条目官方已下架）
const AUTOCLAW_MODELS = [
  { id: "glm-5.3", routeId: "zaicoding_glm-5.3", name: "GLM-5.3", contextLength: 1048576, maxOutputTokens: 307200, capabilities: { images: false, reasoning: true, tools: true } },
  { id: "glm-5.3-flash", routeId: "zai_glm-5.3-flash", name: "GLM-5.3-Flash", contextLength: 1048576, maxOutputTokens: 131072, capabilities: { images: true, reasoning: true, tools: true } },
];
const AUTOCLAW_DEFAULT_ROUTE = "zai_auto";
const AUTOCLAW_ROUTE_RE = /^[a-z][a-z0-9]*_[A-Za-z0-9._:-]{1,127}$/; // 合法路由 id 形态

/** X-Auth-Sign = MD5("{appId}&{秒级时间戳}&{appKey}") 小写 hex（X-Auth-TimeStamp 是秒，别用毫秒） */
function autoclawSign(ts) {
  return crypto.createHash("md5").update(`${AUTOCLAW_AUTH_APP_ID}&${ts}&${AUTOCLAW_AUTH_APP_KEY}`).digest("hex");
}

/** 模型 → 路由 id（协议参考 §2.4 解析顺序）：静态表 → 已带前缀透传 → 合法形态透传 → 兜底 zai_auto */
function autoclawResolveRoute(model) {
  const s = String(model || "").trim();
  const hit = AUTOCLAW_MODELS.find((m) => m.id.toLowerCase() === s.toLowerCase());
  if (hit) return hit.routeId;
  if (/^(zai_|zaicoding_)/i.test(s)) return s;
  if (AUTOCLAW_ROUTE_RE.test(s)) return s;
  return AUTOCLAW_DEFAULT_ROUTE;
}

function makeAutoClaw(region) {
  const cfg = AUTOCLAW_REGIONS[region];
  const channel = region === "intl" ? "autoclaw_intl" : "autoclaw";
  return {
    id: channel,
    refreshWindowSec: 300, // 临期 5 分钟（对齐官方 DESKTOP_REFRESH_AHEAD_MS，协议参考 §2.3）

    _llmHeaders(token, routeId) {
      // LLM 域头（协议参考 §2.2 A，逐字）。铁律：认证头是 X-Authorization 不是 Authorization；
      // 2026-09-22 起 chat 路径禁发 X-Harness-Type: zcode（带上稳定 403 pay-view / 406 空体）
      return {
        "content-type": "application/json",
        accept: "*/*", // 不是 text/event-stream，照抄源实现
        "x-product": "autoclaw",
        "x-client-type": "pc",
        "x-tm": "win", // platformTm：darwin→mac / linux→linux / 其余 win
        "x-version": "1.17.8", // DESKTOP_APP_VERSION，进兼容路径判定
        "x-lang": "zh-CN",
        "x-channel": "official",
        "x_trace_id": "autoclaw-desktop", // 下划线写法照抄源实现
        "x-authorization": `Bearer ${token}`,
        "x-request-id": util.uuid(),
        "x-request-model": routeId,
      };
    },

    _userapiHeaders(token) {
      // userapi 域头（协议参考 §2.2 B）：保留 X-Harness-Type + 签名头族；authorization 小写、token 空则整条不发
      const ts = Math.floor(Date.now() / 1000);
      const h = {
        "content-type": "application/json",
        accept: "*/*",
        "x-product": "autoclaw",
        "x-client-type": "pc",
        "x-harness-type": "zcode",
        "x-tm": "win",
        "x-lang": "zh-CN",
        "x-channel": "official",
        "x-auth-appid": AUTOCLAW_AUTH_APP_ID,
        "x-auth-timestamp": String(ts),
        "x-auth-sign": autoclawSign(ts),
        "x-trace-id": util.uuid(),
      };
      if (token) h["authorization"] = `Bearer ${token}`;
      return h;
    },

    models() { return AUTOCLAW_MODELS.map((m) => m.id); },
    modelEntries() { return AUTOCLAW_MODELS.map((m) => ({ client: m.id, upstream: m.id, entry: m })); },
    upstreamFor(model) { return autoclawResolveRoute(String(model || "").trim()); },

    rewriteBody(model, body) {
      const out = { ...(body || {}) };
      const routeId = autoclawResolveRoute(model);
      const dirHit = AUTOCLAW_MODELS.find((m) => m.routeId === routeId);
      out.model = dirHit ? dirHit.id : String(model || AUTOCLAW_DEFAULT_ROUTE); // body.model = 剥前缀后的模型 id
      out.stream = true;
      if (!out.stream_options || typeof out.stream_options !== "object") out.stream_options = {};
      out.stream_options.include_usage = true;
      delete out.conversation_id; delete out.conversationId; delete out.prompt_cache_key;
      acPrompt.normalizeSystemPrompt(out); // 2026-09-22 白名单闸门（幂等）
      out._routeId = routeId; // chat 组装时取走放进 X-Request-Model，序列化前 delete
      return out;
    },

    async chat({ secrets, model, body, emit }) {
      const prepared = this.rewriteBody(model, body);
      const routeId = prepared._routeId || AUTOCLAW_DEFAULT_ROUTE;
      delete prepared._routeId;
      const payload = JSON.stringify(prepared);
      const headers = this._llmHeaders((secrets && secrets.token) || "", routeId);
      const { resp, cancelTimer } = await fetchStream(`${cfg.upstream}/chat/completions`, { method: "POST", headers, body: payload });
      const result = { status: 200, planLimit: false };
      try {
        await pumpSse(resp, (_event, raw) => {
          if (raw === "[DONE]") { emit({ type: "finish", reason: "" }); return; }
          const data = parseJson(raw);
          if (!data) return;
          const errObj = data.error || null;
          if (errObj) {
            // 401→401 刷新；429→402；其余先过内容拦截三文案再 Fatal 透传（协议参考 §2.6）
            const msg = String(errObj.message || errObj);
            const blocked = /blocked by security policy|unapproved channel|illegal api invocation/i.test(msg);
            const status = Number((errObj && errObj.status) || 0);
            const s = status === 401 ? 401 : status === 429 ? 402 : blocked ? 502 : (status || 502);
            if (s === 402) result.planLimit = true;
            emit({ type: "error", status: s, code: Number(errObj.code) || 0, message: msg.slice(0, 300) });
            return;
          }
          const choice = Array.isArray(data.choices) && data.choices[0];
          if (choice) {
            if (choice.delta && Object.keys(choice.delta).length) emit({ type: "delta", delta: choice.delta });
            if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
          }
          if (data.usage) {
            emit({ type: "usage", usage: {
              prompt_tokens: Number(data.usage.prompt_tokens) || 0,
              completion_tokens: Number(data.usage.completion_tokens) || 0,
              total_tokens: Number(data.usage.total_tokens) || 0,
            } });
          }
        });
      } finally { cancelTimer(); }
      return result;
    },

    /** 刷新（协议参考 §2.3）：POST {userapi}/userapi/v1/refresh；code 400002 降级 /agent-refresh；
     *  410000/401 → 401。deviceId：meta.device_id 优先，缺省回落 JWT device_id 声明。
     *  桌面导入（source=scan）：刷新前重读 auth.json（桌面端重登自动跟上）；成功只更号池行，不回写文件。 */
    async refreshToken(account, secrets) {
      let rt = (secrets && secrets.refreshToken) || "";
      let deviceId = String((account && account.meta && account.meta.device_id) || "");
      if (!deviceId && secrets && secrets.token) deviceId = String(util.jwtDecode(secrets.token).device_id || "");
      if (account && account.source === "scan") {
        try {
          const live = acCred.readAutoClawAuth();
          if (live && live.refreshToken) rt = live.refreshToken;
          if (live && live.deviceId && !deviceId) deviceId = live.deviceId;
        } catch { /* 文件读不了就用号池快照 */ }
      }
      if (!rt) return { ok: false, message: "无 refreshToken，请重新粘贴或导入" };
      const body = JSON.stringify({ refresh_token: rt, source_id: "autoclaw", ...(deviceId ? { device_id: deviceId } : {}) });
      let r = await httpJson(`${cfg.userapi}/userapi/v1/refresh`, { method: "POST", headers: this._userapiHeaders((secrets && secrets.token) || ""), body })
        .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      if (r.data && Number(r.data.code) === 400002) {
        r = await httpJson(`${cfg.userapi}/userapi/v1/agent-refresh`, { method: "POST", headers: this._userapiHeaders((secrets && secrets.token) || ""), body })
          .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      }
      const code = Number(r.data && r.data.code);
      if (code === 410000 || r.status === 401) return { ok: false, expired: true, message: "登录态已过期，请重新登录" };
      const d = r.data && r.data.data;
      const token = d && String(d.access_token || "").replace(/^Bearer\s+/i, "");
      if (!(code === 0 && token)) return { ok: false, message: (r.data && r.data.message) || r.message || `刷新失败 HTTP ${r.status}` };
      const exp = Number(util.jwtDecode(token).exp) || 0; // 过期按新 token JWT exp 重算（解不出保留 0）
      return { ok: true, token, refreshToken: String((d && d.refresh_token) || rt), expiresAt: exp > 0 ? exp * 1000 : 0 };
    },

    /** uid 用地区前缀 + JWT user_id（两地 userId 空间可能撞号，协议参考 §2.8） */
    async userInfo(token) {
      const c = util.jwtDecode(token);
      return { uid: `${cfg.uidPrefix}${String(c.user_id || "")}`, name: String(c.user_name || c.nickname || "AutoClaw 账号") };
    },
  };
}
const autoclaw = makeAutoClaw("cn");
const autoclaw_intl = makeAutoClaw("intl");
```

`ADAPTERS` 表：`{ trae, workbuddy, workbuddy_ai, raccoon, cline_free, cline_pass, autoclaw, autoclaw_intl }`
`module.exports` 增加 `_autoclawSign: autoclawSign, _autoclawResolveRoute: autoclawResolveRoute`。

- [ ] **Step 4: catalog.json 加两节**

```json
"autoclaw": { "syncedAt": 0, "models": [
  { "id": "glm-5.3", "name": "GLM-5.3", "rate": null, "capabilities": { "images": false, "reasoning": true, "tools": true }, "contextLength": 1048576, "maxOutputTokens": 307200 },
  { "id": "glm-5.3-flash", "name": "GLM-5.3-Flash", "rate": null, "capabilities": { "images": true, "reasoning": true, "tools": true }, "contextLength": 1048576, "maxOutputTokens": 131072 }
] },
"autoclaw_intl": { "syncedAt": 0, "models": [
  { "id": "glm-5.3", "name": "GLM-5.3", "rate": null, "capabilities": { "images": false, "reasoning": true, "tools": true }, "contextLength": 1048576, "maxOutputTokens": 307200 },
  { "id": "glm-5.3-flash", "name": "GLM-5.3-Flash", "rate": null, "capabilities": { "images": true, "reasoning": true, "tools": true }, "contextLength": 1048576, "maxOutputTokens": 131072 }
] },
```

- [ ] **Step 5: 跑测试 + 回归 + Commit**

Run: `node scripts/dev-autoclaw-test.cjs` 全 ✓ + Global Constraints 回归全绿

```bash
git add electron/backend/proxy/adapters.cjs rules/catalog.json scripts/dev-autoclaw-test.cjs
git commit -m "feat: autoclaw 两地区适配器（双头集合/签名/路由/system 白名单）"
```

---

### Task 8: qoderCosy.cjs（COSY 自签名）

**Files:**
- Create: `electron/backend/proxy/qoderCosy.cjs`
- Test: `scripts/dev-qoder-test.cjs`（新建骨架，同款隔离头）

**Interfaces:**
- Produces（Task 9 依赖）:
  - `encodeBody(jsonBytes: Buffer) → Buffer`（三步纯字节变换）
  - `buildCosyHeaders({ url, body, uid, token, name, email, machineId, requestId }) → object`（**body 必须是编码后的 Buffer**）
  - `sigPathOf(url) → string`（去 `/algo` 前缀、不含查询串）、`md5hex(s) → string`

- [ ] **Step 1: 写失败测试**

```js
console.log("qoderCosy:");
const qcosy = require("../electron/backend/proxy/qoderCosy.cjs");
ok("sigPath 去 /algo 前缀且不含查询", qcosy.sigPathOf("https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?Encode=1") === "/api/v2/service/pro/sse/agent_chat_generation");
ok("sigPath 对不带 /algo 的路径原样", qcosy.sigPathOf("https://x/api/v1/userinfo") === "/api/v1/userinfo");

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/dev-qoder-test.cjs` — ✗

- [ ] **Step 3: 实现 qoderCosy.cjs**

```js
// Qoder COSY 自签名（协议参考 §3.3；常量逐字抄自参考 cosy.rs:52-82，一个字符都不能改）。
// 请求体必须先 encodeBody 后 buildCosyHeaders（签的是编码后字节），顺序颠倒只报「签名不匹配」无从排查。
"use strict";
const crypto = require("node:crypto");

const GATEWAY_COSY_VERSION = "1.1.38";
const CLIENT_TYPE = "5";
// RSA-1024 公钥（模数 1024 位 hex、指数 65537）：用于加密一次性 AES key
const RSA_MODULUS_HEX = "c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f0927609bb896a9f24be1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf";
const STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";

function md5hex(s) { return crypto.createHash("md5").update(String(s), "utf8").digest("hex"); }

/** URL 的 path 去掉 /algo 前缀、不含查询串（协议参考 §3.3 第 6 步） */
function sigPathOf(url) {
  const u = new URL(String(url));
  const p = u.pathname;
  return p.startsWith("/algo") ? p.slice(5) || "/" : p;
}

/** encode_body 三步变换（cosy.rs:212-240 逐字移植）：标准 base64 → 尾段/中段/首段重排
 *  （各段 ⌊n/3⌋，余数留在中段）→ 逐字符字母表替换（'=' → '$'）。 */
function encodeBody(jsonBytes) {
  const b64 = Buffer.from(jsonBytes).toString("base64");
  const n = b64.length;
  const third = Math.floor(n / 3);
  const rotated = b64.slice(n - third) + b64.slice(third, n - third) + b64.slice(0, third);
  let out = "";
  for (const ch of rotated) {
    if (ch === "=") { out += "$"; continue; }
    const i = STD_ALPHABET.indexOf(ch);
    out += i >= 0 ? CUSTOM_ALPHABET[i] : ch;
  }
  return Buffer.from(out, "latin1");
}

/** 随机 16 字符 AES key（源实现：32B 随机 base64url 取前 16 ASCII；key 与 iv 同一段） */
function randomAesKey() { return crypto.randomBytes(16).toString("base64url").slice(0, 16); }

function rsaEncryptKey(aesKey) {
  const jwk = { kty: "RSA", n: Buffer.from(RSA_MODULUS_HEX, "hex").toString("base64url"), e: "AQAB" };
  const pub = crypto.createPublicKey({ key: jwk, format: "jwk" });
  // PKCS#1 v1.5（node 默认 padding），1024 位模数天然输出定长 128 字节
  return crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(aesKey, "utf8")).toString("base64");
}

/** 身份 JSON：键序照抄源实现、手写拼接（键序参与加密与签名），值是 JSON 字符串转义形态 */
function identityJson({ uid, token, name, email }) {
  return `{"uid":${JSON.stringify(String(uid))},"security_oauth_token":${JSON.stringify(String(token))},"name":${JSON.stringify(String(name))},"aid":"","email":${JSON.stringify(String(email))}}`;
}

/** build 全套 COSY 头（协议参考 §3.3 第 9 步头集合，逐字）。body 必须是编码后的 Buffer。 */
function buildCosyHeaders({ url, body, uid, token, name, email, machineId, requestId }) {
  const aesKey = randomAesKey();
  const keyBuf = Buffer.from(aesKey, "utf8");
  const cipher = crypto.createCipheriv("aes-128-cbc", keyBuf, keyBuf); // key=iv 同一段（源实现既有做法）
  const info = Buffer.concat([cipher.update(Buffer.from(identityJson({ uid, token, name, email }), "utf8")), cipher.final()]).toString("base64");
  const payload = `{"version":"v1","requestId":${JSON.stringify(String(requestId))},"info":${JSON.stringify(info)},"cosyVersion":${JSON.stringify(GATEWAY_COSY_VERSION)},"ideVersion":""}`;
  const payloadB64 = Buffer.from(payload, "utf8").toString("base64");
  const cosyKey = rsaEncryptKey(aesKey);
  const ts = Math.floor(Date.now() / 1000); // 秒
  const sigPath = sigPathOf(url);
  const bodyStr = body.toString("latin1"); // 编码后字节（全 ASCII，latin1 无损）
  const signature = md5hex([payloadB64, cosyKey, String(ts), bodyStr, sigPath].join("\n"));
  return {
    "authorization": `Bearer COSY.${payloadB64}.${signature}`,
    "cosy-key": cosyKey,
    "cosy-user": String(uid),
    "cosy-date": String(ts),
    "cosy-version": GATEWAY_COSY_VERSION,
    "cosy-machineid": String(machineId || ""),
    "cosy-machinetoken": String(machineId || ""), // 与 machineid 同值
    "cosy-machinetype": CLIENT_TYPE,
    "cosy-machineos": "x86_64_windows", // {arch}_{platform}；本机恒 x86_64_windows
    "cosy-clienttype": CLIENT_TYPE,
    "cosy-clientip": "127.0.0.1",
    "cosy-bodyhash": md5hex(bodyStr),
    "cosy-bodylength": String(Buffer.byteLength(bodyStr, "latin1")),
    "cosy-sigpath": sigPath,
    "cosy-data-policy": "disagree",
    "cosy-organization-id": "",
    "cosy-organization-tags": "",
    "login-version": "v2",
    "x-request-id": String(requestId),
  };
}

module.exports = { GATEWAY_COSY_VERSION, encodeBody, buildCosyHeaders, sigPathOf, md5hex, randomAesKey, rsaEncryptKey };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/dev-qoder-test.cjs` 全 ✓
（如互拍失败：优先核对 `third` 分段边界与替换表；`STD.indexOf` 取到的下标必须在 `CUS` 上取同位。）

- [ ] **Step 5: Commit**

```bash
git add electron/backend/proxy/qoderCosy.cjs scripts/dev-qoder-test.cjs
git commit -m "feat: qoderCosy 自签名（AES-CBC key=iv/RSA-PKCS1/自定义base64/MD5 拼接，encode_body 三步变换）"
```

---

### Task 9: qoder 适配器（信封请求体 + 双层 SSE + 地区路由 + 挂 ADAPTERS）——之一

**Files:**
- Modify: `electron/backend/proxy/adapters.cjs`（autoclaw 段后加 qoder 模块级纯函数；ADAPTERS 加 `qoder`）
- Modify: `rules/catalog.json`（qoder 节）
- Test: `scripts/dev-qoder-test.cjs`（追加）

**Interfaces:**
- Consumes: Task 8 `qoderCosy.*`；util.jwtDecode
- Produces（本任务之二 + Task 14 依赖）: 导出窥视口 `_qoderClassify({httpStatus,text}) → {status,message}`、`_qoderIds({userId,upstreamKey,maxTokens,seed}) → {sessionId,recordId}`、`_qoderBody({internal,modelEntry,ids,requestId,lastUserText}) → envelope`、`_qoderUnpack(frame)`、`_TagSplitter`（class，`feed(piece)/flush()`）

- [ ] **Step 1: 写失败测试（追加到 dev-qoder-test.cjs）**

```js
console.log("qoder 错误分类:");
const qAd = adapters.get("qoder");
const C = adapters._qoderClassify;
ok("pricingUrl → 402", C({ httpStatus: 403, text: '{"message":"see https://x/pricing for plans"}' }).status === 402);
ok("额度关键词 → 402", C({ httpStatus: 200, text: "insufficient quota" }).status === 402);
ok("code 112 → 402", C({ httpStatus: 200, text: '{"code":112}' }).status === 402);
ok("429 → 402", C({ httpStatus: 429, text: "rate limit" }).status === 402);
ok("401 → 401", C({ httpStatus: 401, text: "unauthorized" }).status === 401);
ok("裸 403（无配额特征）→ 401", C({ httpStatus: 403, text: "forbidden" }).status === 401);
ok("5xx → 502", C({ httpStatus: 502, text: "bad gateway" }).status === 502);

console.log("qoder 会话/记录 id 派生:");
const ids = adapters._qoderIds({ userId: "u1", upstreamKey: "qfmodel", maxTokens: 32768 });
ok("sessionId 16hex-uuid 形态", /^[0-9a-f]{16}-/.test(ids.sessionId));
ok("recordId 16hex", /^[0-9a-f]{16}$/.test(ids.recordId));
ok("同输入同 id（确定性）", JSON.stringify(ids) === JSON.stringify(adapters._qoderIds({ userId: "u1", upstreamKey: "qfmodel", maxTokens: 32768 })));

console.log("qoder 信封请求体:");
const body = adapters._qoderBody({
  internal: { messages: [{ role: "system", content: "be nice" }, { role: "user", content: "hi" }], tools: [], max_tokens: 100 },
  modelEntry: { key: "qfmodel", is_reasoning: true, is_vl: false },
  ids, requestId: "rq-1", lastUserText: "hi",
});
ok("信封固定字段", body.stream === true && body.chat_task === "FREE_INPUT" && body.session_type === "qodercli" && body.agent_id === "agent_common" && body.request_set_id === body.chat_record_id);
ok("system 收进 messages 置顶（顶层 system 恒空串）", body.system === "" && body.messages[0].role === "system" && body.messages[0].content === "be nice");
ok("model_config 精简版（无 thinking_config）", body.model_config.key === "qfmodel" && body.model_config.is_reasoning === true && !("thinking_config" in body.model_config));
ok("parameters.max_tokens 与 32768 取小", body.parameters.max_tokens === 100);
ok("enable_thinking 缺省不发", !("enable_thinking" in body.parameters));
ok("business.name 取最后用户文本前 30 字符", body.business.name === "hi");

console.log("thinking 标签跨分片状态机:");
const sp = new adapters._TagSplitter();
let out = [];
for (const piece of ["<thi", "nking>abc", "def</think", "ing>\n\nafter"]) out.push(sp.feed(piece));
out.push(sp.flush());
const text = out.join("");
ok("跨分片拆标签且闭标签后吃换行", text.includes("abcdef") && text.includes("after") && !text.includes("<thinking>"), text);

console.log("信封 SSE 解包:");
ok("双层 JSON 解析", (() => {
  const inner = JSON.stringify({ choices: [{ delta: { content: "你" } }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } });
  const u = adapters._qoderUnpack({ statusCodeValue: 200, body: inner });
  return u.ok === true && u.chunk.choices[0].delta.content === "你";
})());
ok("statusCodeValue != 200 → 错误帧", adapters._qoderUnpack({ statusCodeValue: 403, body: "quota exceeded" }).ok === false);
ok("body 为 [DONE] 字符串", adapters._qoderUnpack({ statusCodeValue: 200, body: "[DONE]" }).done === true);
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/dev-qoder-test.cjs` — ✗

- [ ] **Step 3: 实现（adapters.cjs；require 区加 `const qcosy = require("./qoderCosy.cjs");`）——模块级纯函数段**

```js
// ===== Qoder（阿里，国际/中国版单渠道按账号地区切换；协议参考 §3） =====
// 四组域名按 region 内置切换（地区不接受任意 URL）；模型目录/凭证两地区不通用。
const QODER_REGIONS = {
  global: { openApi: "https://openapi.qoder.sh", center: "https://center.qoder.sh", webOrigin: "https://qoder.com", gateway: "https://api3.qoder.sh/" },
  cn: { openApi: "https://openapi.qoder.com.cn", center: "https://gateway.qoder.com.cn", webOrigin: "https://qoder.com.cn", gateway: "https://gateway.qoder.com.cn/" },
};
const QODER_CHAT_PATH = "algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"; // gateway 基址带尾斜杠
const QODER_MODEL_LIST_PATH = "algo/api/v2/model/list?Encode=1";
const QODER_REFRESH_PATH = "/algo/api/v3/user/refresh_token"; // center 域
const QODER_USERINFO_PATH = "/api/v1/userinfo"; // open_api 域
// 兜底清单（协议参考 §3.8；upstreamKey/reasoning/efforts/vision/倍率快照 2026-09-20 实测；global 17 / cn 10）
const QODER_FALLBACK = {
  global: [
    ["Qwen3.8-Flash", "qfmodel", true, ["low", "medium", "xhigh"], true, "0.1"],
    ["Qwen3.8-Max", "qmodel_38max", true, ["low", "medium", "xhigh"], true, "0.5"],
    ["Auto", "auto", false, [], true, "1"],
    ["Ultimate", "ultimate", true, [], true, "1.6"],
    ["Performance", "performance", true, [], true, "1.1"],
    ["Efficient", "efficient", false, [], true, "0.3"],
    ["Sonus", "smodel", true, [], true, "3.2"],
    ["Cantus", "cmodel", true, [], true, "3.2"],
    ["Qwen3.7-Max", "qmodel_latest", true, [], true, "0.5"],
    ["Qwen3.7-Plus", "qmodel", false, [], true, "0.1"],
    ["Kimi-K3", "kmodel_latest", false, [], true, "0.8"],
    ["Kimi-K2.8-Preview", "kmodel", false, [], true, "0.3"],
    ["GLM-5.3", "gmodel", true, [], true, "0.6"],
    ["GLM-5.3-Flash", "gfmodel", true, [], true, "0.1"],
    ["DeepSeek-V4-Pro", "dmodel", true, [], true, "0.8"],
    ["DeepSeek-Flash", "dfmodel", true, [], true, "0.2"],
    ["MiniMax-M3", "mmodel", false, [], true, "0.2"],
  ],
  cn: [
    ["Qwen3.8-Flash", "qfmodel", true, ["low", "medium", "xhigh"], true, "0.1"],
    ["Qwen3.8-Max", "qmodel_38max", true, ["low", "medium", "xhigh"], true, "0.5"],
    ["Auto", "auto", false, [], true, "1"],
    ["Qwen3.7-Max", "qmodel_latest", true, [], true, "0.5"],
    ["Qwen3.7-Plus", "qmodel", false, [], true, "0.1"],
    ["DeepSeek-V4-Pro", "dmodel", true, [], true, "0.8"],
    ["DeepSeek-Flash", "dfmodel", false, [], true, "0.2"],
    ["GLM-5.3", "gmodel", true, [], true, "0.6"],
    ["Kimi-K2.8-Preview", "kmodel", true, [], true, "0.3"],
    ["MiniMax-M3", "mmodel", false, [], true, "0.2"],
  ],
};

/** 错误分类（协议参考 §3.6，按顺序判；先看响应体语义再看状态码）。
 *  403 双语义：带 pricing/额度特征是套餐不足（402 换号），裸 403 才是登录态（401 刷新）——
 *  只看状态码会把「该充值」误报成「登录失效」。 */
function qoderClassify({ httpStatus, text }) {
  const t = String(text || "");
  const hasPricing = /https?:\/\/[^"\\]*\/pricing[^"\\]*/i.test(t) || /pricingurl|insufficient|no_quota|quota_exceed|exceed_quota|exceeded|credit|upgrade|subscription|plan|trial/i.test(t);
  if (hasPricing || /"code"\s*:\s*112/.test(t)) return { status: 402, message: "当前账号额度不足或套餐不支持该模型" };
  if (httpStatus === 429 || /rate limit|too many/i.test(t)) return { status: 402, message: t.slice(0, 300) || "上游限流" };
  if (httpStatus === 401 || httpStatus === 403) return { status: 401, message: t.slice(0, 300) || "登录态失效或权限不足" };
  return { status: 502, message: t.slice(0, 300) || "上游错误" };
}

/** 会话/记录 id 派生（协议参考 §3.4 公式：sha256 前 16 hex，\0 分隔） */
function qoderIds({ userId, upstreamKey, maxTokens, seed }) {
  const h = (label, ...parts) => crypto.createHash("sha256").update(label + "\0" + parts.join("\0")).digest("hex").slice(0, 16);
  return {
    sessionId: h("qoder-session", String(userId || ""), String(upstreamKey || "")) + "-" + (seed || util.uuid()),
    recordId: h("qoder-record", String(upstreamKey || ""), "mt=" + String(maxTokens)),
  };
}

/** 内部 OpenAI body → Qoder 固定业务信封（协议参考 §3.4 逐字段） */
function qoderBody({ internal, modelEntry, ids, requestId, lastUserText }) {
  const maxTokens = Math.min(Number((internal && internal.max_tokens) || 0) || 32768, 32768); // >32K 上游退化
  const srcMessages = (internal && Array.isArray(internal.messages) ? internal.messages : []).slice();
  const sysTexts = []; // system/developer 收集置顶（上游不看顶层 system 字段）
  const rest = [];
  for (const m of srcMessages) {
    if (m && (m.role === "system" || m.role === "developer")) {
      const t = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      if (t && t.trim()) sysTexts.push(t.trim());
    } else rest.push(m);
  }
  const messages = [];
  if (sysTexts.length) messages.push({ role: "system", content: sysTexts.join("\n\n") });
  for (const m of rest) {
    if (!m || typeof m.role !== "string") continue;
    if (m.role === "user") {
      if (Array.isArray(m.content)) { // 无图压平文本；有图 → [{text},{image_url}]（image_url 原样抽出）
        const parts = [];
        for (const p of m.content) {
          if (p && p.type === "text") parts.push({ type: "text", text: String(p.text || "") });
          else if (p && p.type === "image_url") parts.push({ type: "image_url", image_url: p.image_url });
        }
        messages.push({ role: "user", content: parts });
      } else messages.push({ role: "user", content: String(m.content ?? "") });
    } else if (m.role === "assistant") {
      const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length;
      const content = m.content == null || m.content === "" ? (hasToolCalls ? " " : "") : String(m.content); // 纯空体会被拒
      const out = { role: "assistant", content };
      if (hasToolCalls) out.tool_calls = m.tool_calls;
      messages.push(out);
    } else if (m.role === "tool") {
      messages.push({ role: "tool", tool_call_id: String(m.tool_call_id || ""), content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") });
    }
  }
  const isReasoning = !!(modelEntry && modelEntry.is_reasoning);
  return {
    request_id: String(requestId),
    request_set_id: ids.recordId,
    chat_record_id: ids.recordId,
    session_id: ids.sessionId,
    stream: true, // 恒 true（非流式由 Aggregator 本地聚合）
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    system: "",
    messages,
    tools: Array.isArray(internal && internal.tools) ? internal.tools : [],
    parameters: { max_tokens: maxTokens }, // enable_thinking/reasoning_effort 仅显式开思考时追加（发 false 会把思考混进正文或断连）
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: { context: [], modelConfig: { key: String(modelEntry.key), is_reasoning: isReasoning }, originalContent: String(lastUserText || "") },
      features: [],
      text: String(lastUserText || ""),
    },
    model_config: { key: String(modelEntry.key), is_reasoning: isReasoning, is_vl: !!(modelEntry && modelEntry.is_vl), source: "system" }, // 精简版：剥 thinking_config（原样回传会覆盖 parameters.enable_thinking）
    business: { product: "cli", version: "1.0.0", type: "agent", stage: "start", id: util.uuid(), name: String(lastUserText || "").slice(0, 30), begin_at: Date.now() },
  };
}

/** 信封 SSE 帧解包（协议参考 §3.5）：HTTP 恒 200，{statusCodeValue, body}，body 是内层 JSON 字符串需二次解析；
 *  body 也可能直接是 "[DONE]" 字符串或非字符串对象。 */
function qoderUnpack(frame) {
  const code = Number(frame && frame.statusCodeValue);
  if (code !== 200) {
    const bodyVal = frame && frame.body;
    const text = typeof bodyVal === "string" ? bodyVal : JSON.stringify(bodyVal ?? "");
    return { ok: false, status: code, text };
  }
  const bodyVal = frame && frame.body;
  if (bodyVal === "[DONE]") return { done: true };
  const inner = typeof bodyVal === "string" ? parseJson(bodyVal) : bodyVal;
  return { ok: true, chunk: inner || null };
}

/** thinking 标签跨分片状态机（协议参考 §3.5）：reasoning 以 <thinking>/<think>/<reasoning>/<thought>
 *  混在 content，标签可能切在任意位置；闭标签后吃掉紧跟换行（先 \n\n 再单个）；流结束必须 flush。 */
class TagSplitter {
  constructor() { this.buf = ""; this.inTag = false; }
  feed(piece) {
    this.buf += piece;
    let out = "";
    for (;;) {
      if (!this.inTag) {
        const m = this.buf.match(/<(thinking|think|reasoning|thought)>/);
        if (!m) {
          const keep = Math.min(this.buf.length, 8); // 最长开标签半截（"<thought>" 8 字符内）
          const safe = this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(safe.length);
          return out + safe;
        }
        out += this.buf.slice(0, m.index);
        this.buf = this.buf.slice(m.index + m[0].length);
        this.inTag = true;
      } else {
        const m = this.buf.match(/<\/(thinking|think|reasoning|thought)>/);
        if (!m) {
          const keep = Math.min(this.buf.length, 9); // "</thought>" 9 字符内
          const safe = this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(safe.length);
          return out;
        }
        this.buf = this.buf.slice(m.index + m[0].length).replace(/^\r?\n\r?\n/, "").replace(/^\r?\n/, "");
        this.inTag = false;
      }
    }
  }
  flush() { const rest = this.buf; this.buf = ""; return rest; }
}
```

- [ ] **Step 4: Commit（本段先落纯函数与测试）**

Run: `node scripts/dev-qoder-test.cjs` — 纯函数断言全 ✓（`adapters.get("qoder")` 尚为 null，Task 9 之二补对象后补断言）

```bash
git add electron/backend/proxy/adapters.cjs scripts/dev-qoder-test.cjs
git commit -m "feat: qoder 协议纯函数（错误分类/信封体/id 派生/双层解包/标签状态机）"
```

### Task 9（续）：qoder 适配器对象 + 挂 ADAPTERS + catalog——之二

**Files:**
- Modify: `electron/backend/proxy/adapters.cjs`（Task 9 之一纯函数段后加 makeQoder；ADAPTERS 加 `qoder`；module.exports 补窥视口）
- Modify: `rules/catalog.json`（qoder 节）
- Test: `scripts/dev-qoder-test.cjs`（追加）

**Interfaces:**
- Consumes: 本任务之一的全部纯函数 + Task 8 `qoderCosy.*`
- Produces: `adapters.get("qoder")` 完整适配器（chat/refreshToken/userInfo/fetchModels/models/modelEntries/upstreamFor/rewriteBody）

- [ ] **Step 1: 写失败断言（追加）**

```js
console.log("qoder 适配器对象:");
ok("qoder 已注册", !!qAd);
ok("地区解析：meta.mode=cn → cn", qAd._regionOf({ meta: { mode: "cn" } }) === "cn" && qAd._regionOf({ meta: { mode: "intl" } }) === "global" && qAd._regionOf({}) === "global");
ok("目录两区并集且 global 优先", qAd.models().includes("Qwen3.8-Flash") && qAd.models().includes("MiniMax-M3"));
ok("upstreamFor 查 upstreamKey", qAd.upstreamFor("Qwen3.8-Flash") === "qfmodel" && qAd.upstreamFor("Auto") === "auto");
ok("refreshToken 3 段打包串走 center 刷新路径", typeof qAd.refreshToken === "function");
```

- [ ] **Step 2: 实现 makeQoder（纯函数段之后、ADAPTERS 之前）**

```js
function makeQoder() {
  return {
    id: "qoder",
    refreshWindowSec: 300, // 临期 5 分钟（协议参考 §3.7）

    _regionOf(account) {
      const m = (account && account.meta && (account.meta.mode || account.meta.edition)) || "global";
      return m === "cn" ? "cn" : "global"; // ""/global/intl → Global，cn → Cn（协议参考 §3.1）
    },

    models() {
      const seen = [];
      for (const region of ["global", "cn"]) for (const [id] of QODER_FALLBACK[region]) if (!seen.includes(id)) seen.push(id);
      return unionIds([...catalogMap("qoder").values()].map((m) => String(m.id)), seen); // 两区并集、global 优先
    },
    modelEntries() {
      const seen = new Map();
      for (const region of ["global", "cn"]) {
        for (const [id, key, reasoning, efforts, vision, rate] of QODER_FALLBACK[region]) {
          if (!seen.has(id.toLowerCase())) seen.set(id.toLowerCase(), {
            client: id, upstream: key,
            entry: { id, name: id, rate: Number(rate) || 0, capabilities: { images: vision, reasoning, tools: true }, contextLength: 200000, maxOutputTokens: 0, _key: key, _efforts: efforts },
          });
        }
      }
      for (const m of catalogMap("qoder").values()) {
        if (!seen.has(String(m.id).toLowerCase())) seen.set(String(m.id).toLowerCase(), { client: String(m.id), upstream: String(m.id), entry: { ...m, _key: String(m.id), _efforts: [] } });
      }
      return [...seen.values()];
    },
    upstreamFor(model) {
      const e = this.modelEntries().find((x) => x.client.toLowerCase() === String(model || "").toLowerCase());
      return e ? e.upstream : String(model || "");
    },
    _resolveEntry(model) {
      const s = String(model || "").toLowerCase();
      const hit = this.modelEntries().find((x) => x.client.toLowerCase() === s || (x.entry._key || "").toLowerCase() === s);
      return hit ? hit.entry : null;
    },

    rewriteBody(model, body) {
      const out = { ...(body || {}) };
      out.stream = true;
      if (!out.stream_options || typeof out.stream_options !== "object") out.stream_options = {};
      out.stream_options.include_usage = true;
      delete out.conversation_id; delete out.conversationId; delete out.prompt_cache_key;
      return out; // 信封组装在 chat 里做（需要 account 上下文）
    },

    async chat({ account, secrets, model, body, emit }) {
      const cfg = QODER_REGIONS[this._regionOf(account)];
      const entry = this._resolveEntry(model) || { key: "auto", is_reasoning: false, is_vl: false, _efforts: [] };
      const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === "user");
      const lastUserText = typeof (lastUser && lastUser.content) === "string" ? lastUser.content : "";
      const prepared = this.rewriteBody(model, body);
      const requestId = util.uuid();
      const userId = (account && ((account.meta && account.meta.user_id) || account.uid)) || "";
      const machineId = qoderMachineId();
      const ids = qoderIds({ userId, upstreamKey: entry.key, maxTokens: prepared.max_tokens, seed: (prepared.session_id || "") || undefined });
      const envelope = qoderBody({ internal: prepared, modelEntry: entry, ids, requestId, lastUserText });
      // 思考档位（协议参考 §3.4）：reasoning_effort → reasoning → thinking 命中即停；off/none/disabled/false 不发；
      // true/null → enable_thinking:true 无档位；minimal/min→low、high/max→xhigh；白名单 = 目录 efforts，不支持退默认档
      const effSrc = prepared.reasoning_effort ?? prepared.reasoning ?? prepared.thinking;
      if (effSrc !== undefined && !["off", "none", "disabled", false].includes(effSrc)) {
        if (effSrc === true || effSrc === null) {
          envelope.parameters.enable_thinking = true;
        } else {
          const map = { minimal: "low", min: "low", high: "xhigh", max: "xhigh" };
          let effort = map[String(effSrc)] || String(effSrc);
          const allow = (entry._efforts && entry._efforts.length) ? entry._efforts : ["low", "medium", "xhigh"];
          if (!allow.includes(effort)) effort = allow.includes("medium") ? "medium" : allow[0];
          envelope.parameters.enable_thinking = true;
          envelope.parameters.reasoning_effort = effort;
        }
      }
      const encoded = qcosy.encodeBody(Buffer.from(JSON.stringify(envelope), "utf8")); // 必须先编码后签名
      const url = `${cfg.gateway}${QODER_CHAT_PATH}`;
      const headers = {
        ...qcosy.buildCosyHeaders({ url, body: encoded, uid: userId, token: (secrets && secrets.token) || "", name: (account && account.name) || "", email: (account && account.meta && account.meta.email) || "", machineId, requestId }),
        "content-type": "application/json",
        "accept": "text/event-stream",
        "cache-control": "no-cache",
        "accept-encoding": "identity",
        "x-model-key": String(entry.key),
        "x-model-source": "system",
      };
      const { resp, cancelTimer } = await fetchStream(url, { method: "POST", headers, body: encoded });
      const result = { status: 200, planLimit: false };
      const splitter = new TagSplitter();
      let usage = null; // usage 取最后一帧（协议参考 §3.5）
      const flushUsage = () => { if (usage) emit({ type: "usage", usage }); };
      try {
        // HTTP 恒 200；错误在信封 statusCodeValue 里——fetchStream 的 !resp.ok 分支不会触发
        await pumpSse(resp, (_event, raw) => {
          if (raw === "[DONE]") { flushUsage(); emit({ type: "finish", reason: "" }); return; }
          const frame = parseJson(raw);
          if (!frame) return;
          const u = qoderUnpack(frame);
          if (u.done) { flushUsage(); emit({ type: "finish", reason: "" }); return; }
          if (!u.ok) {
            const cls = qoderClassify({ httpStatus: u.status, text: u.text });
            if (cls.status === 402) result.planLimit = true;
            emit({ type: "error", status: cls.status, code: 0, message: cls.message });
            return;
          }
          const chunk = u.chunk;
          if (!chunk) return;
          const choice = Array.isArray(chunk.choices) && chunk.choices[0];
          if (choice && choice.delta) {
            const delta = { ...choice.delta };
            if (typeof delta.content === "string" && delta.content) delta.content = splitter.feed(delta.content);
            if (Object.keys(delta).length) emit({ type: "delta", delta });
          }
          if (choice && choice.finish_reason) { flushUsage(); emit({ type: "finish", reason: choice.finish_reason }); }
          if (chunk.usage) usage = { prompt_tokens: Number(chunk.usage.prompt_tokens) || 0, completion_tokens: Number(chunk.usage.completion_tokens) || 0, total_tokens: Number(chunk.usage.total_tokens) || 0 };
        });
        const tail = splitter.flush();
        if (tail) emit({ type: "delta", delta: { content: tail } }); // 不 flush 会丢末尾文字
      } finally { cancelTimer(); }
      return result;
    },

    /** 刷新（协议参考 §3.7）：secrets.refreshToken 是打包串——
     *  5 段 `pat|<PAT>|<作业刷新令牌>|<userId>|<machineId>`（PAT 来源，重走 jobToken/exchange）
     *  3 段 `<oauth刷新令牌>|<userId>|<machineId>`（OAuth 来源，走 center refresh_token） */
    async refreshToken(account, secrets) {
      const packed = String((secrets && secrets.refreshToken) || "");
      const cfg = QODER_REGIONS[this._regionOf(account)];
      const segs = packed.split("|");
      const baseHeaders = { "content-type": "application/json", "cosy-version": "1.0.1", "cosy-clienttype": "5", "user-agent": "qoder-local-proxy" };
      if (segs.length >= 5 && segs[0] === "pat") {
        const r = await httpJson(`${cfg.openApi}/api/v1/jobToken/exchange`, { method: "POST", headers: baseHeaders, body: JSON.stringify({ personal_token: segs[1] }) })
          .catch((e) => ({ ok: false, status: 0, data: null, message: String(e) }));
        const token = r.ok && r.data && r.data.data && r.data.data.token ? String(r.data.data.token) : "";
        if (!token) return { ok: false, message: `PAT 换取失败 HTTP ${r.status}` };
        const exp = Number(util.jwtDecode(token).exp || 0) * 1000;
        return { ok: true, token, refreshToken: packed, expiresAt: exp };
      }
      if (segs.length >= 3) {
        const r = await httpJson(`${cfg.center}${QODER_REFRESH_PATH}`, { method: "POST", headers: { ...baseHeaders, authorization: `Bearer ${(secrets && secrets.token) || ""}` }, body: JSON.stringify({ refreshToken: segs[0] }) })
          .catch((e) => ({ ok: false, status: 0, data: null, message: String(e) }));
        if (r.status === 401) return { ok: false, expired: true, message: "登录态已过期，请重新登录" };
        const d = r.data && (r.data.data || r.data);
        const token = d && d.token ? String(d.token) : "";
        if (!r.ok || !token) return { ok: false, message: (d && d.message) || `刷新失败 HTTP ${r.status}` };
        // refresh_token 不得含 |（协议参考 §2.3/oauth.rs 同判据）；缺失沿用旧值
        const nextRt = d.refresh_token && !String(d.refresh_token).includes("|") ? `${String(d.refresh_token)}|${segs[1]}|${segs[2]}` : packed;
        const exp = Number(util.jwtDecode(token).exp || 0) * 1000;
        return { ok: true, token, refreshToken: nextRt, expiresAt: exp };
      }
      return { ok: false, message: "refreshToken 打包串格式不认识（应为 3 段或 pat| 开头 5 段）" };
    },

    async userInfo(token) {
      const c = util.jwtDecode(token);
      return { uid: String(c.user_id || c.sub || ""), name: String(c.nickname || c.name || "Qoder 账号") };
    },

    /** 远程目录（COSY 签名 + 信封，按地区缓存 1h 由 proxy_models_sync 层处理）；失败如实回错由 UI 引导手填 */
    async fetchModels(account, secrets) {
      const cfg = QODER_REGIONS[this._regionOf(account)];
      const url = `${cfg.gateway}${QODER_MODEL_LIST_PATH}`;
      const requestId = util.uuid();
      const encoded = qcosy.encodeBody(Buffer.from(JSON.stringify({ region: this._regionOf(account) }), "utf8"));
      const headers = qcosy.buildCosyHeaders({ url, body: encoded, uid: (account && account.uid) || "", token: (secrets && secrets.token) || "", name: "", email: "", machineId: qoderMachineId(), requestId });
      const r = await httpJson(url, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String(e) }));
      const chat = r.data && (r.data.chat || (r.data.data && r.data.data.chat));
      if (!r.ok || !Array.isArray(chat)) return { ok: false, message: `目录拉取失败（HTTP ${r.status || 0}）` };
      const models = chat.filter((m) => m && m.key).map((m) => ({
        id: String(m.display_name || m.key).replace(/\s+/g, ""), // 对外 id = display_name 去所有空白（协议参考 §3.8）
        name: String(m.display_name || m.key),
        rate: Number(m.price_factor) || 0, // 0 是合法值不能当缺失丢弃
        capabilities: { images: !!m.is_vl, reasoning: !!m.is_reasoning, tools: true },
        contextLength: 200000, maxOutputTokens: 0,
        _key: String(m.key),
        _efforts: (m.thinking_config && m.thinking_config.enabled && Object.keys(m.thinking_config.enabled.efforts || {})) || [],
      }));
      return models.length ? { ok: true, models } : { ok: false, message: "目录为空" };
    },
  };
}

/** qoder 机器标识（协议参考 §3.7）：按序找候选文件，第一个存在的非空（≤256 字符、无控制字符）用之；
 *  都没有则生成 UUID v4 写入 <config_dir>/qoder-machine-id，进程内缓存。 */
let _qoderMid = null;
function qoderMachineId() {
  if (_qoderMid) return _qoderMid;
  const fs = require("node:fs");
  const configDir = store.proxyDir();
  const candidates = [path.join(configDir, "qoder-machine-id"), path.join(os.homedir(), ".qoder-proxy", "machine_id"), path.join(os.homedir(), ".qoder", ".auth", "machine_id"), path.join(os.homedir(), ".qoder", "machine_id")];
  for (const f of candidates) {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      if (v && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v)) { _qoderMid = v; return _qoderMid; }
    } catch { /* 下一个候选 */ }
  }
  _qoderMid = util.uuid();
  try { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(path.join(configDir, "qoder-machine-id"), _qoderMid); } catch { /* 只读环境用内存值 */ }
  return _qoderMid;
}
const qoder = makeQoder();
```

（`path/os` 若 adapters.cjs 顶部未 require 则补；`store.proxyDir()` 名以 store.cjs 实际导出为准——若叫别的名字（grep `proxyDir`），用实际函数。）

`ADAPTERS` 表：`{ trae, workbuddy, workbuddy_ai, raccoon, cline_free, cline_pass, autoclaw, autoclaw_intl, qoder }`
`module.exports` 补：`_qoderClassify: qoderClassify, _qoderIds: qoderIds, _qoderBody: qoderBody, _qoderUnpack: qoderUnpack, _TagSplitter: TagSplitter`

- [ ] **Step 3: catalog.json 加 qoder 节（global 17 条快照，rate=price_factor；objectWidth 注意 rate:0 合法）**

```json
"qoder": { "syncedAt": 0, "models": [
  { "id": "Qwen3.8-Flash", "name": "Qwen3.8-Flash", "rate": 0.1, "capabilities": { "images": true, "reasoning": true, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "Qwen3.8-Max", "name": "Qwen3.8-Max", "rate": 0.5, "capabilities": { "images": true, "reasoning": true, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "Auto", "name": "Auto", "rate": 1, "capabilities": { "images": true, "reasoning": false, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "Ultimate", "name": "Ultimate", "rate": 1.6, "capabilities": { "images": true, "reasoning": true, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "Performance", "name": "Performance", "rate": 1.1, "capabilities": { "images": true, "reasoning": true, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "Efficient", "name": "Efficient", "rate": 0.3, "capabilities": { "images": true, "reasoning": false, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "Sonus", "name": "Sonus", "rate": 3.2, "capabilities": { "images": true, "reasoning": true, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "Cantus", "name": "Cantus", "rate": 3.2, "capabilities": { "images": true, "reasoning": true, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "Qwen3.7-Max", "name": "Qwen3.7-Max", "rate": 0.5, "capabilities": { "images": true, "reasoning": true, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "Qwen3.7-Plus", "name": "Qwen3.7-Plus", "rate": 0.1, "capabilities": { "images": true, "reasoning": false, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "Kimi-K3", "name": "Kimi-K3", "rate": 0.8, "capabilities": { "images": true, "reasoning": false, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "Kimi-K2.8-Preview", "name": "Kimi-K2.8-Preview", "rate": 0.3, "capabilities": { "images": true, "reasoning": false, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "GLM-5.3", "name": "GLM-5.3", "rate": 0.6, "capabilities": { "images": true, "reasoning": true, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "GLM-5.3-Flash", "name": "GLM-5.3-Flash", "rate": 0.1, "capabilities": { "images": true, "reasoning": true, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "DeepSeek-V4-Pro", "name": "DeepSeek-V4-Pro", "rate": 0.8, "capabilities": { "images": true, "reasoning": true, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "DeepSeek-Flash", "name": "DeepSeek-Flash", "rate": 0.2, "capabilities": { "images": true, "reasoning": true, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 },
  { "id": "MiniMax-M3", "name": "MiniMax-M3", "rate": 0.2, "capabilities": { "images": true, "reasoning": false, "tools": true }, "contextLength": 200000, "maxOutputTokens": 0 }
] },
```

- [ ] **Step 4: 跑测试 + 回归 + Commit**

Run: `node scripts/dev-qoder-test.cjs` 全 ✓（含 Task 9 之一全部断言）+ Global Constraints 回归全绿

```bash
git add electron/backend/proxy/adapters.cjs rules/catalog.json scripts/dev-qoder-test.cjs
git commit -m "feat: qoder 适配器（信封+COSY+双层 SSE+地区路由）"
```

---

### Task 10: discovery 扫描导入（scanCline / scanAutoClaw）

**Files:**
- Modify: `electron/backend/proxy/discovery.cjs`（scanRaccoon 后加两个 scan 函数；`scanAll()` 399 行加两源）
- Test: `scripts/dev-cline-test.cjs` / `scripts/dev-autoclaw-test.cjs`（各追加一段）

**Interfaces:**
- Consumes: Task 2 `clineAuth.readClineDesktopAuth()`、Task 5 `autoclawCredentials.readAutoClawAuth()/readOpenclawFallback()`
- Produces: `scanAll()` 候选数组新增两类条目，形状与 `importCandidate`（discovery.cjs:404）兼容：`{channel, uid, name, token, refreshToken, expiresAt, meta, source:"scan", file}`

- [ ] **Step 1: 写失败断言**

dev-cline-test.cjs 追加：

```js
console.log("scanCline:");
const discovery = require("../electron/backend/proxy/discovery.cjs");
os.homedir = () => fakeHome; // Task 2 已造 ~/.cline/data/settings/providers.json 夹具
const cands = discovery.scanAll().filter((c) => c.channel.startsWith("cline_"));
os.homedir = () => path.join(fakeHome, "empty");
ok("扫描出 cline 候选且 uid=external_id", cands.length === 1 && cands[0].uid === "usr-9", cands[0] && cands[0].uid);
```

dev-autoclaw-test.cjs 追加（fakeDir 夹具 Task 5 已造）：

```js
console.log("scanAutoClaw:");
process.env.APPDATA = fakeDir;
const acands = discovery.scanAll().filter((c) => c.channel === "autoclaw");
ok("扫描出 autoclaw 候选（仅国内渠道）", acands.length === 1 && acands[0].token === "eyJtok" && acands[0].meta.device_id === "dev-1", acands[0]);
ok("intl 渠道不产生 auth.json 候选（地区门禁，参考项目同款）", discovery.scanAll().some((c) => c.channel === "autoclaw_intl") === false);
```

- [ ] **Step 2: 跑测试确认失败**

Run: 两个测试脚本 — ✗

- [ ] **Step 3: 实现（discovery.cjs）**

require 区加 `const clineAuth = require("./clineAuth.cjs"); const acCred = require("./autoclawCredentials.cjs");`（scanRaccoon 段后）：

```js
// ===== Cline（~/.cline/data/settings/providers.json，明文；协议参考 §1.7） =====
function scanCline() {
  const cred = clineAuth.readClineDesktopAuth();
  if (!cred) return [];
  // uid 必须用 JWT external_id（usr-…），sub 是 WorkOS user_… 不能用于去重/余额路径
  const uid = clineAuth.clineUid(cred.token, cred.accountId);
  if (!uid) return [];
  return [{
    channel: "cline_free", // 两池同账号同凭证：默认落 free 池，UI 可 channelOverride 改投 pass
    uid, name: cred.displayName || "Cline 账号",
    token: cred.token, refreshToken: cred.refreshToken,
    expiresAt: cred.expiresAt,
    meta: {},
    source: "scan", file: "providers.json",
  }];
}

// ===== AutoClaw（%APPDATA%/AutoClaw/auth.json，safeStorage 密文；协议参考 §2.7） =====
// 地区门禁照抄参考项目 local_credentials()：auth.json 无地区标记，只导国内渠道；
// 国际版账号走 OAuth/粘贴。备来源 openclaw.json 是明文 JWT，无 refreshToken → 标注不可刷新。
function scanAutoClaw() {
  const out = [];
  try {
    const cred = acCred.readAutoClawAuth();
    if (cred && cred.token) {
      const claims = util.jwtDecode(cred.token);
      out.push({
        channel: "autoclaw",
        uid: `user-${String(claims.user_id || cred.uid || "")}`,
        name: String(claims.user_name || cred.name || "AutoClaw 账号"),
        token: cred.token, refreshToken: cred.refreshToken,
        expiresAt: cred.expiresAt,
        meta: cred.deviceId ? { device_id: cred.deviceId } : {},
        source: "scan", file: "auth.json",
      });
    }
  } catch { /* 解密失败不进候选（UI 走粘贴） */ }
  try {
    const alt = acCred.readOpenclawFallback();
    if (alt && alt.token) {
      const claims = util.jwtDecode(alt.token);
      out.push({
        channel: "autoclaw",
        uid: `user-${String(claims.user_id || "")}`,
        name: "AutoClaw（openclaw.json，无刷新令牌）",
        token: alt.token, refreshToken: "", // 无 refreshToken → 刷新链路会如实报「请重新粘贴」
        expiresAt: Number(claims.exp || 0) * 1000 || 0,
        meta: {}, source: "scan", file: "openclaw.json",
      });
    }
  } catch { /* 同上 */ }
  return out;
}
```

`scanAll()` 改：

```js
function scanAll() {
  return [...scanTrae(), ...scanWorkBuddy(), ...scanRaccoon(), ...scanCline(), ...scanAutoClaw()];
}
```

`module.exports` 加 `scanCline, scanAutoClaw`。

- [ ] **Step 4: 跑测试 + 回归 + Commit**

Run: 两个测试脚本全 ✓ + Global Constraints 回归全绿

```bash
git add electron/backend/proxy/discovery.cjs scripts/dev-cline-test.cjs scripts/dev-autoclaw-test.cjs
git commit -m "feat: discovery 扫描导入 cline/autoclaw 本机登录态（autoclaw 仅国内渠道门禁）"
```

---

### Task 11: 设备授权登录（cline WorkOS + qoder PKCE）

**Files:**
- Modify: `electron/backend/proxy/discovery.cjs`（beginOAuth 分支 + 两个 begin 函数 + 设备流轮询 + 落库）
- Modify: `electron/backend/proxy/index.cjs:389-403`（proxy_oauth_begin 透传 edition/返回 userCode）
- Test: `scripts/dev-cline-test.cjs` / `scripts/dev-qoder-test.cjs`（追加纯函数断言）

**Interfaces:**
- Consumes: `oauthSession` 生命周期（beginOAuth/discovery.cjs:1038、finishOAuth:1019、OAUTH_TIMEOUT_MS）、store.addAccount
- Produces:
  - `beginOAuth(channel, opts, onDone)` 签名扩为带 `opts = {edition?, }`（autoclaw_intl 的 captchaVerifyParam 在 Task 12 加）
  - `proxy_oauth_begin` 返回值新增字段：`mode:"device"` 时带 `userCode`（UI Task 13 展示）
  - 纯函数（导出测试）：`_workosPollVerdict(status, body) → "pending"|"slow_down"|"expired"|"denied"|"done"`、`_qoderRegionOfMode(mode) → "global"|"cn"`

- [ ] **Step 1: 写失败断言**

dev-cline-test.cjs：

```js
console.log("workos 设备流轮询判定:");
const W = discovery._workosPollVerdict;
ok("200 带 token → done", W(200, { access_token: "a" }) === "done");
ok("400 authorization_pending → pending", W(400, { error: "authorization_pending" }) === "pending");
ok("400 slow_down → slow_down", W(400, { error: "slow_down" }) === "slow_down");
ok("400 expired_token → expired", W(400, { error: "expired_token" }) === "expired");
ok("400 access_denied → denied", W(400, { error: "access_denied" }) === "denied");
```

dev-qoder-test.cjs：

```js
console.log("qoder 登录辅助:");
ok("region 归一", discovery._qoderRegionOfMode("cn") === "cn" && discovery._qoderRegionOfMode("intl") === "global" && discovery._qoderRegionOfMode("") === "global");
```

- [ ] **Step 2: 跑测试确认失败**

Run: 两个测试脚本 — ✗

- [ ] **Step 3: 实现（discovery.cjs；beginWorkBuddyOAuth 段后）**

```js
// ===== 设备授权流（cline WorkOS / qoder PKCE，同构「发起→轮询→落库」，无回环端口） =====

/** WorkOS 轮询响应判定（RFC 8628；协议参考 §1.3/第四章 §1） */
function workosPollVerdict(status, body) {
  if (status === 200 && body && (body.access_token || body.accessToken)) return "done";
  const err = body && body.error;
  if (err === "authorization_pending") return "pending";
  if (err === "slow_down") return "slow_down";
  if (err === "expired_token") return "expired";
  if (err === "access_denied") return "denied";
  return status >= 200 && status < 300 ? "done" : "pending";
}

/** qoder 地区归一：""/global/intl → global，cn → cn（协议参考 §3.1） */
function qoderRegionOfMode(mode) { return String(mode || "").toLowerCase() === "cn" ? "cn" : "global"; }

// cline：POST authorize/device（body 仅 client_id）→ verification_uri_complete 免手输 → 轮询 authenticate
// → 必做 /auth/register 换 Cline 会话令牌（头带 X-CLIENT-TYPE: cline-sdk）→ 落库
const CLINE_WORKOS_BASE = "https://api.workos.com";
const CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR"; // 逐字（credentials.rs:69）
const CLINE_DEVICE_FALLBACK_URL = "https://authkit.cline.bot/device";

async function beginClineOAuth(channel, onDone) {
  const pool = channel === "cline_pass" ? "pass" : "free";
  const r = await adapters.httpJson(`${CLINE_WORKOS_BASE}/user_management/authorize/device`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: `client_id=${encodeURIComponent(CLINE_WORKOS_CLIENT_ID)}`,
  }).catch((e) => ({ ok: false, status: 0, data: null, message: String(e) }));
  const d = r.data || {};
  const deviceCode = d.device_code, userCode = d.user_code;
  if (!r.ok || !deviceCode) return { ok: false, message: `设备授权发起失败（HTTP ${r.status}）${d.error || ""}` };
  const url = String(d.verification_uri_complete || d.verification_uri || CLINE_DEVICE_FALLBACK_URL);
  oauthSession = {
    mode: "device", channel, url, userCode, server: null, onDone,
    interval: Math.max(1, Number(d.interval) || 5), slow: 0,
    deadline: Date.now() + Math.max(OAUTH_TIMEOUT_MS, (Number(d.expires_in) || 300) * 1000),
    submit: async () => ({ ok: false, message: "设备授权无需粘贴回调地址，请在授权页确认后回到本窗口等待" }),
  };
  const poll = async () => {
    if (!oauthSession || oauthSession.userCode !== userCode) return;
    if (Date.now() > oauthSession.deadline) { finishOAuth({ ok: false, message: "登录超时" }); return; }
    const pr = await adapters.httpJson(`${CLINE_WORKOS_BASE}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:device_code")}&device_code=${encodeURIComponent(deviceCode)}&client_id=${encodeURIComponent(CLINE_WORKOS_CLIENT_ID)}`,
    }).catch(() => null);
    const verdict = workosPollVerdict(pr && pr.status, pr && pr.data);
    if (verdict === "done") {
      try {
        // 必做第四步：WorkOS 身份令牌换 Cline 会话令牌（协议参考 第四章 §1.4，不能省）
        const reg = await adapters.httpJson(`${clineAuth ? "https://api.cline.bot/api/v1" : ""}/auth/register`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json", "x-client-type": "cline-sdk" },
          body: JSON.stringify({ accessToken: pr.data.access_token, refreshToken: pr.data.refresh_token }),
        });
        const rd = reg.data && reg.data.data;
        if (!reg.ok || !rd || !rd.accessToken) throw new Error(`换会话令牌失败（HTTP ${reg.status}）`);
        const token = clineAuth.ensureTokenPrefix(rd.accessToken);
        const refreshToken = clineAuth.ensureTokenPrefix(String(rd.refreshToken || pr.data.refresh_token || ""));
        const claims = clineAuth.jwtClaims(token);
        const uid = clineAuth.clineUid(token, rd.accountId);
        const id = await saveDiscoveredAccount(channel, {
          uid, name: clineAuth.clineDisplayName(claims, claims.email),
          token, refreshToken, expiresAt: clineAuth.clineExpiresAt(rd.expiresAt, claims),
          meta: {}, source: "oauth",
        });
        finishOAuth({ ok: true, id, uid, pool });
      } catch (e) { finishOAuth({ ok: false, message: String((e && e.message) || e) }); }
      return;
    }
    if (verdict === "expired") { finishOAuth({ ok: false, message: "设备码已过期，请重新发起登录" }); return; }
    if (verdict === "denied") { finishOAuth({ ok: false, message: "你在授权页拒绝了本次登录" }); return; }
    if (verdict === "slow_down") oauthSession.slow = Math.min(oauthSession.slow + 1000, 30000); // 间隔 +1s、上限 30s
    oauthSession.timer = setTimeout(poll, oauthSession.interval * 1000 + oauthSession.slow);
  };
  oauthSession.timer = setTimeout(poll, oauthSession.interval * 1000);
  return { ok: true, url, mode: "device", userCode };
}

// qoder：无起始请求，本地拼授权页；2s 轮询 poll（202/404 = 继续）→ userinfo 补资料 → 落库 meta.mode
async function beginQoderOAuth(channel, edition, onDone) {
  const region = qoderRegionOfMode(edition);
  const cfg = {
    global: { webOrigin: "https://qoder.com", openApi: "https://openapi.qoder.sh" },
    cn: { webOrigin: "https://qoder.com.cn", openApi: "https://openapi.qoder.com.cn" },
  }[region];
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url"); // S256 无填充
  const machineId = qoderMachineIdOf();
  const nonce = util.uuid().replace(/-/g, "");
  const url = `${cfg.webOrigin}/device/selectAccounts?challenge=${encodeURIComponent(challenge)}&challenge_method=S256&machine_id=${encodeURIComponent(machineId)}&nonce=${nonce}`;
  oauthSession = {
    mode: "device", channel, url, userCode: "", server: null, onDone,
    deadline: Date.now() + OAUTH_TIMEOUT_MS * 2, // qoder 授权页含登录+选账号，给足 6 分钟
    submit: async () => ({ ok: false, message: "设备授权无需粘贴回调地址，请在授权页选择账号后回到本窗口等待" }),
  };
  const poll = async () => {
    if (!oauthSession || oauthSession.nonce !== nonce) return;
    if (Date.now() > oauthSession.deadline) { finishOAuth({ ok: false, message: "登录超时" }); return; }
    const r = await adapters.httpJson(`${cfg.openApi}/api/v1/deviceToken/poll?nonce=${encodeURIComponent(nonce)}&verifier=${encodeURIComponent(verifier)}&challenge_method=S256`, {
      method: "GET", headers: { "cosy-version": "1.0.1", "cosy-clienttype": "5", "user-agent": "qoder-local-proxy" },
    }).catch(() => null);
    if (r && (r.status === 200 || r.status === 201)) {
      const d = r.data || {};
      if (d.token && d.refresh_token && !String(d.refresh_token).includes("|")) {
        try {
          // 登录后初始请求：userinfo 补 name/email（容忍失败：poll 已带 user_id，协议参考 §2.5）
          let name = "Qoder 账号", email = "", userId = String(d.user_id || "");
          const ui = await adapters.httpJson(`${cfg.openApi}/api/v1/userinfo`, {
            method: "GET", headers: { "cosy-version": "1.0.1", "cosy-clienttype": "5", "user-agent": "qoder-local-proxy", authorization: `Bearer ${d.token}` },
          }).catch(() => null);
          if (ui && ui.ok && ui.data) {
            const info = ui.data.data || ui.data;
            name = String(info.nickname || info.name || name);
            email = String(info.email || "");
            userId = String(info.id || info.user_id || userId);
          }
          const id = await saveDiscoveredAccount(channel, {
            uid: userId, name, token: String(d.token),
            refreshToken: `${String(d.refresh_token)}|${userId}|${machineId}`, // 打包串（协议参考 §3.7）
            expiresAt: Number(d.expires_at) || Date.now() + 30 * 86400 * 1000,
            meta: { mode: region, email, machine_id: machineId, user_id: userId },
            source: "oauth",
          });
          finishOAuth({ ok: true, id, uid: userId });
        } catch (e) { finishOAuth({ ok: false, message: String((e && e.message) || e) }); }
        return;
      }
    }
    // 202/404/网络错误 = 还没确认，继续轮（协议参考 §2.3）
    oauthSession.timer = setTimeout(poll, 2000);
  };
  oauthSession.nonce = nonce;
  oauthSession.timer = setTimeout(poll, 2000);
  return { ok: true, url, mode: "device", userCode: "" };
}

/** 登录/导入共用的落库：同渠道同 uid 更新凭据，否则新建（store.addAccount/updateAccount 既有语义） */
async function saveDiscoveredAccount(channel, { uid, name, token, refreshToken, expiresAt, meta, source }) {
  const existing = uid ? store.listAccounts(channel).find((a) => a.uid === uid) : null;
  if (existing) {
    store.updateAccount(existing.id, { token, refreshToken, expiresAt, meta, status: "online", coolUntil: 0, coolReason: "" });
    return existing.id;
  }
  return store.addAccount({ channel, uid, name, token, refreshToken, source: source || "oauth", expiresAt, meta });
}

/** qoder 机器标识（与 adapters.cjs 的 qoderMachineId 同一套文件约定；此处直接 require adapters 复用，
 *  避免两份实现——经 adapters 导出 `_qoderMachineId`。） */
function qoderMachineIdOf() { return adapters._qoderMachineId(); }
```

beginOAuth 分派（替换 1042-1048 的现有分支）：

```js
async function beginOAuth(channel, opts, onDone) {
  const o = opts && typeof opts === "object" ? opts : {};
  const cb = typeof opts === "function" ? opts : onDone; // 兼容旧两参签名
  const ch = String(channel || "trae");
  if (oauthSession) throw new Error("已有进行中的登录，请先完成或取消");
  if (!adapters.get(ch)) throw new Error(`未知渠道 ${ch}`);
  if (ch === "raccoon") throw new Error("小浣熊暂不支持在应用内直接登录：请在「商汤小浣熊」客户端登录后，用「从本机软件导入」或粘贴 auth.json 内容导入");
  if (ch === "autoclaw") throw new Error("AutoClaw（国内）官方没有网页登录：请用「从本机软件导入」（自动读取 %APPDATA%/AutoClaw/auth.json）或粘贴 token");
  if (ch === "cline_free" || ch === "cline_pass") return beginClineOAuth(ch, cb);
  if (ch === "qoder") return beginQoderOAuth(ch, o.edition, cb);
  if (ch === "autoclaw_intl") return beginAutoClawIntlOAuth(ch, o, cb); // Task 12 实现；本任务先留占位会抛「未实现」？——不行，见下
  return beginTraeOAuth(ch, cb) && undefined || beginWorkBuddyOAuth(ch, cb);
}
```

**注意**：Task 11 提交时 `autoclaw_intl` 分支先写成 `return { ok:false, message:"autoclaw 国际版登录在下一任务接入" };`（Task 12 替换为真实现）——不留占位符又不引入未定义引用。trae/workbuddy 的默认分派保持原语义（原代码是 `if (ch === "trae") return beginTraeOAuth(...); return beginWorkBuddyOAuth(...)`，照原样保留，上面示意写法以原文件为准）。

`module.exports` 加 `_workosPollVerdict: workosPollVerdict, _qoderRegionOfMode: qoderRegionOfMode`。

index.cjs `proxy_oauth_begin`（389-403 行）改为：

```js
ipcMain.handle("proxy_oauth_begin", handle(async ({ channel, edition, vendor, captchaVerifyParam }) => {
  if (!store.isBuiltinChannel(channel) || !adapters.get(channel)) return fail("该渠道不支持 OAuth 登录");
  const ch = String(channel);
  const r = await discovery.beginOAuth(ch, { edition, vendor, captchaVerifyParam }, (result) => {
    if (result.ok) {
      credits.refreshAccount(result.id).catch(() => {});
      checkinBatch({ accountId: result.id, action: "checkin" }).catch(() => {});
    }
    events.emit({ type: "oauth-done", channel: ch, ...result });
  });
  if (r.ok && r.url) await shell.openExternal(r.url);
  return r.ok ? ok({ url: r.url, mode: r.mode, userCode: r.userCode || "" }) : fail(r.message);
}));
```

- [ ] **Step 4: 跑测试 + 回归 + Commit**

Run: 两个测试脚本全 ✓ + Global Constraints 回归全绿

```bash
git add electron/backend/proxy/discovery.cjs electron/backend/proxy/index.cjs scripts/dev-cline-test.cjs scripts/dev-qoder-test.cjs
git commit -m "feat: 设备授权登录（cline WorkOS 四步流 + qoder PKCE 轮询流）"
```

---

### Task 12: autoclaw_intl OAuth（滑块 + 回环回调 + 双 state）

**Files:**
- Modify: `electron/backend/proxy/discovery.cjs`（beginAutoClawIntlOAuth + 回环回调路由 + captcha-config 拉取）
- Modify: `electron/backend/proxy/index.cjs`（proxy_oauth_begin 支持 `{vendor, captchaVerifyParam}` 透传——Task 11 已扩参）
- Test: `scripts/dev-autoclaw-test.cjs`（追加纯函数断言）

**Interfaces:**
- Consumes: Task 11 的 `beginOAuth(channel, opts, onDone)` 扩参、`listenLoopback`（discovery.cjs:540）
- Produces:
  - `beginOAuth("autoclaw_intl", {}, cb)`（无 captchaVerifyParam）→ `{ok:true, needCaptcha:true, captcha:{region, prefix, sceneId, supplier}}`
  - `beginOAuth("autoclaw_intl", {vendor:"zai"|"google", captchaVerifyParam}, cb)` → `{ok:true, url, mode:"callback"}`，登录后回环回调自动换 token 落库
  - 纯函数 `_autoclawParseCallback(pathname, search) → {vendor, taskState, code, upstreamState, error}`（双 state 拆解）
- IPC：无新增（proxy_oauth_begin 复用；UI Task 13 两次调用）

- [ ] **Step 1: 写失败断言**

```js
console.log("autoclaw intl 回调解析（双 state 陷阱）:");
const P = discovery._autoclawParseCallback;
const parsed = P("/aclaw-cb/zai/state-abc", "?code=cd-1&state=upstream-state-9");
ok("路径里是我们发起的任务 state", parsed.taskState === "state-abc" && parsed.vendor === "zai");
ok("查询串里才是上游回的 state（换码必须用它）", parsed.upstreamState === "upstream-state-9");
ok("code 透出", parsed.code === "cd-1");
ok("用户拒绝带 error", P("/aclaw-cb/zai/s", "?error=access_denied").error === "access_denied");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/dev-autoclaw-test.cjs` — ✗

- [ ] **Step 3: 实现（discovery.cjs）**

```js
// ===== AutoClaw 国际版 OAuth（协议参考 第四章 §3.2）：三步——
// ① captcha-config（主进程拉，签名头）→ ② renderer 弹滑块拿 captchaVerifyParam → oauth-url 拿授权页
// → ③ 系统浏览器登录 302 回环 /aclaw-cb/{vendor}/{taskState}?code&state（上游不校验回调主机）
// 双 state 陷阱：路径里是本网关任务 state（CSRF 校验），换码必须用查询串里上游回的 state——传错稳定 631001。
const AUTOCLAW_INTL_USERAPI = AUTOCLAW_USERAPI_BASE; // 见下：地区基址常量（与 adapters.cjs 的 AUTOCLAW_REGIONS.intl.userapi 同值，直接字面量写在这里避免跨文件私有引用）
const AUTOCLAW_CALLBACK_PREFIX = "/aclaw-cb/";

function autoclawParseCallback(pathname, search) {
  const rest = String(pathname || "").startsWith(AUTOCLAW_CALLBACK_PREFIX) ? String(pathname).slice(AUTOCLAW_CALLBACK_PREFIX.length) : "";
  const [vendor, taskState] = rest.split("/");
  const q = new URLSearchParams(String(search || ""));
  return { vendor: vendor || "", taskState: taskState || "", code: q.get("code") || "", upstreamState: q.get("state") || "", error: q.get("error") || "" };
}

function autoclawSignedHeaders(token) {
  // 与 adapters.cjs 的 _userapiHeaders 同构；为避免跨对象借用，这里独立实现（appId/appKey 同常量）
  const ts = Math.floor(Date.now() / 1000);
  const APP_ID = "100003", APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5";
  const h = {
    "content-type": "application/json", "accept": "*/*",
    "x-product": "autoclaw", "x-client-type": "pc", "x-harness-type": "zcode", // userapi 域保留（与 chat 路径相反）
    "x-tm": "win", "x-lang": "zh-CN", "x-channel": "official",
    "x-auth-appid": APP_ID, "x-auth-timestamp": String(ts),
    "x-auth-sign": crypto.createHash("md5").update(`${APP_ID}&${ts}&${APP_KEY}`).digest("hex"),
    "x-trace-id": util.uuid(),
  };
  if (token) h["authorization"] = `Bearer ${token}`;
  return h;
}

async function beginAutoClawIntlOAuth(channel, opts, onDone) {
  const userapi = "https://autoglm-api.autoglm.ai";
  // 第 0 步：没带 captchaVerifyParam → 回滑块配置（renderer 加载阿里云 SDK 弹滑块，Task 13）
  if (!opts || !opts.captchaVerifyParam) {
    const cfg = await adapters.httpJson(`${userapi}/userapi/overseasv1/oauth-captcha-config`, { method: "POST", headers: autoclawSignedHeaders(""), body: "{}" })
      .catch((e) => ({ ok: false, data: null, message: String(e) }));
    const d = (cfg.data && (cfg.data.data || cfg.data)) || {};
    if (!cfg.ok || !d.enabled) return { ok: false, message: "上游滑块验证未启用（captcha-config enabled=false）" };
    return { ok: true, needCaptcha: true, captcha: { region: d.region, prefix: d.prefix, sceneId: d.scene_id, supplier: d.captcha_supplier || "aliyun" } };
  }
  const vendor = String(opts.vendor || "");
  if (vendor !== "zai" && vendor !== "google") return { ok: false, message: "vendor 只支持 zai / google" };
  // 第 1 步：先起回环回调服务（端口要进 navigate_uri），再换授权地址
  const taskId = crypto.randomBytes(16).toString("hex");
  let loopbackPort = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://127.0.0.1");
    if (!u.pathname.startsWith(AUTOCLAW_CALLBACK_PREFIX)) { res.statusCode = 404; res.end("not found"); return; }
    const parsed = autoclawParseCallback(u.pathname, u.search);
    if (parsed.taskState !== taskId) { res.statusCode = 400; res.end(ERR_PAGE("回调校验不通过（非本次发起的授权回调）")); return; }
    if (parsed.error || !parsed.code || !parsed.upstreamState) { res.statusCode = 200; res.end(ERR_PAGE(`授权未完成：${parsed.error || "回调缺参数"}`)); finishOAuth({ ok: false, message: `授权未完成：${parsed.error || "回调缺参数"}` }); return; }
    res.statusCode = 200; res.end('<meta charset=utf-8><body style="font-family:system-ui;background:#0b0d0f;color:#44e07f;display:grid;place-items:center;height:100vh">登录成功，已返回网关，可以关闭此页面。</body>');
    // 第 3 步：换码——state 用查询串里上游回的（双 state 陷阱）；navigate_uri 与 oauth-url 请求逐字相同
    exchangeAutoClawIntl(userapi, vendor, parsed.code, parsed.upstreamState, session.navigateUri, session.deviceId)
      .then((cred) => saveDiscoveredAccount("autoclaw_intl", cred))
      .then((id) => finishOAuth({ ok: true, id, uid: session.uid }))
      .catch((e) => finishOAuth({ ok: false, message: String((e && e.message) || e) }));
  });
  loopbackPort = await listenLoopback(server);
  const deviceId = crypto.randomBytes(32).toString("hex"); // 64hex，两跳同值（协议参考 §3.2 ⑤）
  const navigateUri = `http://127.0.0.1:${loopbackPort}${AUTOCLAW_CALLBACK_PREFIX}${vendor}/${taskId}`;
  const r = await adapters.httpJson(`${userapi}/userapi/overseasv1/${vendor}-oauth-url`, {
    method: "POST", headers: autoclawSignedHeaders(""), timeout: 15000,
    body: JSON.stringify({ source_id: "autoclaw", device_id: deviceId, navigate_uri: navigateUri, ali_captcha_verify_param: String(opts.captchaVerifyParam) }),
  }).catch((e) => ({ ok: false, data: null, message: String(e) }));
  const dd = (r.data && (r.data.data || r.data)) || {};
  if (!r.ok || !dd.oauth_url) {
    try { server.close(); } catch { /* 已关 */ }
    // 631002 = 缺/坏 captcha 参数；630014 = 风控验证未通过；631001 = 授权码无效（协议参考 §3.2 ③码表）
    return { ok: false, message: `获取授权地址失败（HTTP ${r.status}）${dd.message || r.message || ""}` };
  }
  const session = { taskId, navigateUri, deviceId, uid: "", vendor };
  oauthSession = {
    mode: "callback", channel, url: String(dd.oauth_url), userCode: "", server,
    deadline: Date.now() + OAUTH_TIMEOUT_MS * 2,
    submit: async (pasted) => ({ ok: false, message: "AutoClaw 国际版登录由回调页自动完成，无需粘贴地址" }),
  };
  oauthSession._session = session;
  return { ok: true, url: String(dd.oauth_url), mode: "callback" };
}

async function exchangeAutoClawIntl(userapi, vendor, code, upstreamState, navigateUri, deviceId) {
  const r = await adapters.httpJson(`${userapi}/userapi/overseasv1/${vendor}-oauth-login`, {
    method: "POST", headers: autoclawSignedHeaders(""),
    body: JSON.stringify({ source_id: "autoclaw", device_id: deviceId, code, state: upstreamState, navigate_uri: navigateUri }),
  }).catch((e) => { throw new Error(`换码失败：${e.message}`); });
  const d = (r.data && (r.data.data || r.data)) || {};
  if (!r.ok || !d.access_token) throw new Error(`换码失败（HTTP ${r.status}）${d.message || ""}`);
  const claims = util.jwtDecode(String(d.access_token));
  return {
    uid: `intl-user-${String(d.user_id || claims.user_id || "")}`,
    name: String(d.user_name || claims.user_name || "AutoClaw 国际版账号"),
    token: String(d.access_token).replace(/^Bearer\s+/i, ""),
    refreshToken: String(d.refresh_token || ""),
    expiresAt: Number(claims.exp || 0) * 1000 || 0,
    meta: { device_id: deviceId },
    source: "oauth",
  };
}
```

Task 11 预留的 `autoclaw_intl` 分支替换为 `return beginAutoClawIntlOAuth(ch, o, cb);`
`module.exports` 加 `_autoclawParseCallback: autoclawParseCallback`。

- [ ] **Step 4: 跑测试 + 回归 + Commit**

Run: `node scripts/dev-autoclaw-test.cjs` 全 ✓ + Global Constraints 回归全绿

```bash
git add electron/backend/proxy/discovery.cjs scripts/dev-autoclaw-test.cjs
git commit -m "feat: autoclaw_intl OAuth（滑块参数透传+回环回调+双 state 换码）"
```

---

### Task 13: UI 接线（添加账号弹窗 / 设备码展示 / 滑块 / 粘贴提示）

**Files:**
- Modify: `src/views/proxy/ProxyAgentsView.vue`（oauthAvailable:110、oauthCopy 表:127-143、oauthWaiting 面板、滑块容器、粘贴面板提示）
- Modify: `src/api/ipc.ts:230-233`（proxyOauthBegin 参数/返回类型）

**Interfaces:**
- Consumes: Task 11/12 的 IPC 契约——`proxyOauthBegin(channel, {edition?, vendor?, captchaVerifyParam?})` 返回 `{ok, url?, mode?, userCode?, needCaptcha?, captcha?{region,prefix,sceneId,supplier}, message?}`；`oauth-done` 事件不变
- Produces: 无后端接口，纯前端

- [ ] **Step 1: ipc.ts 类型扩展**

```ts
export const proxyOauthBegin = (channel: ProxyBuiltinChannelId, opts?: { edition?: "intl" | "cn"; vendor?: "zai" | "google"; captchaVerifyParam?: string }) =>
  call<{ ok: boolean; url?: string; mode?: string; userCode?: string; needCaptcha?: boolean; captcha?: { region: string; prefix: string; sceneId: string; supplier: string }; message?: string }>(
    "proxy_oauth_begin",
    { channel, ...(opts || {}) } as unknown as Record<string, unknown>
  );
```

- [ ] **Step 2: ProxyAgentsView.vue 逐处修改**

1. `oauthAvailable`（110 行附近）改为按渠道可用性：

```ts
const oauthAvailable = (key: AddMethod, channel: string) => {
  if (key !== "oauth") return true;
  // raccoon（深链回调代收不了）与 autoclaw 国内（官方无网页登录）隐藏 OAuth，其余内置渠道均可
  return channel !== "raccoon" && channel !== "autoclaw";
};
```

2. `oauthCopy`（127-143 行）补五个渠道条目（沿用现有 `{title, desc}` 结构，中文文案）：

```ts
cline_free: { title: "用 Cline 账号设备授权登录（免费池）", desc: "跳转 Cline 授权页并自动携带验证码，确认后本机自动轮询完成登录。<br />也可改用「从本机软件导入」（读取 ~/.cline 登录态）或「粘贴 JSON」。" },
cline_pass: { title: "用 Cline 账号设备授权登录（订阅池）", desc: "与免费池同一账号同一登录流程，只是模型池不同。<br />确认授权后本机自动轮询完成登录。" },
autoclaw_intl: { title: "用 AutoClaw 国际版 OAuth 登录", desc: "先完成滑块验证，再跳转 Zai / Google 授权页；登录后自动回到本应用。<br />没有国际版账号也可「粘贴 JSON」导入 token。" },
qoder: { title: "用 Qoder 账号设备授权登录", desc: "跳转 Qoder 授权页登录并选择账号，本机每 2 秒轮询自动完成。<br />国际版 / 中国版在下方切换；也可「粘贴 JSON」导入。" },
```

3. 设备码展示：`oauthWaiting` 面板内追加（`oauthMode === "device" && oauthUserCode` 时显示；`oauthBegin` 发起处把返回的 `userCode` 存 `oauthUserCode` ref）：

```html
<div v-if="oauthMode === 'device' && oauthUserCode" class="oauth-code-row">
  <span>如页面未自动带上验证码，请手动输入：</span>
  <code class="oauth-user-code">{{ oauthUserCode }}</code>
</div>
```

4. qoder 登录入口的 edition 切换（oauth 面板内，仅 `addChannel === "qoder"` 显示）：

```html
<el-radio-group v-if="addChannel === 'qoder'" v-model="qoderEdition" size="small">
  <el-radio-button value="intl">国际版</el-radio-button>
  <el-radio-button value="cn">中国版</el-radio-button>
</el-radio-group>
```

5. autoclaw_intl 滑块：`oauth` 面板内加容器与 SDK 加载函数——点「登录」时先 `proxyOauthBegin("autoclaw_intl")` 拿 `captcha` 配置，动态注入 SDK：

```ts
const ACLAW_SDK = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
async function loadAliyunCaptcha(region: string, prefix: string): Promise<void> {
  (window as any).AliyunCaptchaConfig = { region, prefix }; // 必须在脚本加载前设置，否则弹窗转圈
  if (document.querySelector(`script[src="${ACLAW_SDK}"]`)) return;
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = ACLAW_SDK;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("滑块组件加载失败（检查网络/代理）"));
    document.head.appendChild(s);
  });
}
async function beginAclawIntl() {
  const first = await proxyOauthBegin("autoclaw_intl");
  if (!first.ok || !first.needCaptcha) return first; // 直接成功或失败
  const { region, prefix, sceneId } = first.captcha!;
  await loadAliyunCaptcha(region, prefix);
  // captchaVerifyCallback：滑块通过 → 立即带 captchaVerifyParam 换授权地址 → 返回给 SDK 收起滑块
  return new Promise((resolve) => {
    (window as any).initAliyunCaptcha?.({
      SceneId: sceneId, mode: "popup", element: "#aliyun-captcha-element",
      captchaVerifyCallback: async (param: string) => {
        const second = await proxyOauthBegin("autoclaw_intl", { vendor: "zai", captchaVerifyParam: param });
        resolve(second);
        return { captchaResult: second.ok, bizResult: second.ok };
      },
      slideStyle: { width: 360, height: 40 }, language: "cn",
    });
    setTimeout(() => (document.getElementById("aliyun-captcha-trigger") as HTMLButtonElement)?.click(), 2100); // SDK 要求先有触发按钮，初始化后至少等 2.1s
  });
}
```

（模板加 `<div id="aliyun-captcha-element"></div><button id="aliyun-captcha-trigger" style="width:1px;height:1px;opacity:0"></button>`；vendor 用 zai/google 二选按钮，默认 zai。CSP 若有需放行 `o.alicdn.com` 与 `*.alicdn.com`。）

6. 粘贴面板提示（paste 方式面板）按渠道追加占位/说明：

```ts
autoclaw: "粘贴 access_token（可带 Bearer 前缀自动剥）；有 refresh_token 与 device_id 一并粘贴，刷新链路要用",
cline_free: "粘贴 WorkOS JWT（不带 workos: 前缀会自动补）与 refresh_token",
qoder: "粘贴 accessToken；refreshToken 粘打包串（oauth刷新令牌|userId|machineId 或 pat|PAT|...|userId|machineId）",
```

- [ ] **Step 3: 手工验证（dev server）**

Run: `npm run dev`，进反代页：
1. 五个新渠道卡片出现，autoclaw 的「OAuth 登录」方式不可选
2. qoder 登录弹窗显示国际/中国版切换
3. `npm run build`（或 `vue-tsc --noEmit`）类型检查通过

- [ ] **Step 4: Commit**

```bash
git add src/api/ipc.ts src/views/proxy/ProxyAgentsView.vue
git commit -m "feat: 新渠道凭据接入 UI（设备码/滑块/edition 切换/粘贴提示）"
```

---

### Task 14: proxy-smoke 假上游全链路（三家各一条）

**Files:**
- Modify: `tools/proxy-smoke.cjs`（既有假上游框架上增三段场景）

**Interfaces:**
- Consumes: 三个适配器全部方法、号池、handleChat 全链路
- Produces: `ELECTRON_RUN_AS_NODE=1 electron tools/proxy-smoke.cjs <tmpdir>` 退出码 0，输出含三家场景 PASS

- [ ] **Step 1: 增三个假上游场景**

在 proxy-smoke.cjs 既有场景数组中追加（假上游用 `http.createServer` 起 19530+ 段端口，按各适配器的 URL 常量无法改指本地——**实现方式**：场景内不起真上游，而是直接调用适配器方法、用假 `httpJson/fetchStream`？不可行，adapters 内部直接调 fetch。**采用与既有场景相同的手段**：查 proxy-smoke.cjs 里 trae/raccoon 场景怎么把上游指到假服务（它们一定有办法——大概率是 monkey-patch `adapters.httpJson`/global fetch 或适配器 URL 可从 rules 配置注入）。**以既有场景的实现手段为准**，给三个场景各断言：

1. **cline 场景**：假上游回 `{"error":"Unauthorized: ..."}` 401 → 断言调度触发 `refreshToken` 一次、401 后同账号重试（换假 token 后假上游回正常 SSE chunk → 客户端拿到正文）
2. **autoclaw 场景**：断言假上游收到的请求头**无 `x-harness-type`**、有 `x-authorization`；body 首条 system 以 `You are a personal assistant running inside OpenClaw.` 开头；回 SSE 正常帧 → 客户端拿到正文
3. **qoder 场景**：断言假上游收到的 `authorization` 头形如 `Bearer COSY.x.y`、`cosy-sigpath === "/api/v2/service/pro/sse/agent_chat_generation"`、body 可被 `qcosy.encodeBody` 的逆变换还原（测试内实现逆映射）成合法 JSON 信封；回双层信封 SSE → 客户端拿到正文

- [ ] **Step 2: 跑 smoke**

Run: `ELECTRON_RUN_AS_NODE=1 electron tools/proxy-smoke.cjs "$(mktemp -d)"`（Git Bash；tmpdir 用绝对路径）
Expected: 退出码 0，三家场景 PASS；既有场景不回归

- [ ] **Step 3: Commit**

```bash
git add tools/proxy-smoke.cjs
git commit -m "test: proxy-smoke 增 cline/autoclaw/qoder 假上游全链路场景"
```

---

### Task 15: 全量回归 + 真机验收清单 + 规格回写

**Files:**
- Modify: `docs/superpowers/specs/2026-09-22-gateway-new-providers-design.md`（实现偏差回写，沿用 b476f52「五片实现回写」惯例）

- [ ] **Step 1: 全量回归一次跑齐**

Run: Global Constraints 的回归命令 + `node scripts/dev-cline-test.cjs && node scripts/dev-autoclaw-test.cjs && node scripts/dev-qoder-test.cjs` + smoke
Expected: 全绿；把结果记进 commit message

- [ ] **Step 2: 真机验收（人工，逐项打勾写进 PR/commit 描述）**

1. **cline**：应用内设备授权登录（授权页自动带码）→ /v1/models 出现 cline-free/ 前缀模型 → Codex/Claude Code 经网关对话成功 → 手动触发额度刷新看 token 续期
2. **cline 导入**：装有 Cline 桌面端且已登录的机器上「从本机软件导入」出候选 → 导入后对话成功；桌面端重新登录后再对话（验证刷新前重读文件防顶掉）
3. **autoclaw**：装有 AutoClaw 桌面端的机器导入 auth.json（若本机装有）或粘贴 token → 对话成功（验证 system 前缀过了白名单、无 X-Harness-Type）；无 refreshToken 账号的报错文案友好
4. **autoclaw_intl**：滑块弹出并过验证 → 跳 Zai 授权 → 回环回调自动落库 → 对话成功
5. **qoder**：网页登录（国际/中国各试一个，本机 Qoder IDE 的 machine_id 被复用）→ 对话成功 → 观察 COSY 签名错误若出现「签名不匹配」按 spec §十 排查顺序排查
6. **错误链路**：额度不足账号打 qoder → 收到 402 语义换号；cline 未订阅模型 → 403 文案透传（UI 不显示「账号失效」）

- [ ] **Step 3: 规格回写 + 收尾 Commit**

把实现中与规格的偏差（如 koffi API 细节、UI 文案落点、smoke 假上游手段）回写进设计文档对应章节，标注「实现回写 2026-09-XX」。

```bash
git add docs/superpowers/specs/2026-09-22-gateway-new-providers-design.md
git commit -m "docs: 新渠道实现偏差回写设计规格"
```

---

## Self-Review（计划完成时已核）

1. **Spec 覆盖**：spec §一渠道建模 → Task 1/3/7/9；§二适配器结构 → Task 2/5/6/8/9；§三协议要点 → Task 3/7/9 代码；§四错误映射 → Task 3/7/9 分类函数 + Global Constraints；§五 5.1 粘贴 → Task 13（现成 IPC 零后端改动）、5.2 扫描 → Task 10、5.3 OAuth → Task 11/12（autoclaw 国内拒登分支在 beginOAuth）；§六目录 → Task 4/7/9；§七 UI → Task 13；§八测试 → Task 2-10/14；§十风险 → Task 5 DPAPI 探针、Task 8 三层断言、Task 15 真机验收。**缺口**：spec §七「i18n 四语」——实际代码库该视图为硬编码中文（本计划照实修正为跟随现状）；spec §二 DPAPI 选型 → Task 5 双路径实现。
2. **占位符**：无 TBD/TODO；Task 11 的 autoclaw_intl 分支临时文案在 Task 12 被真实现替换（有明确指引）。
3. **类型一致性**：`_clineErrorStatus/_pickClineModels/_autoclawSign/_autoclawResolveRoute/_qoderClassify/_qoderIds/_qoderBody/_qoderUnpack/_TagSplitter/_workosPollVerdict/_qoderRegionOfMode/_autoclawParseCallback/_qoderMachineId` 导出名与各测试引用一致；`beginOAuth(channel, opts, onDone)` 三参签名在 Task 11 定义、Task 12/13 消费一致；`proxy_oauth_begin` 返回 `userCode` 在 Task 11 产出、Task 13 消费一致。

## Execution Handoff

计划已存 `docs/superpowers/plans/2026-09-22-gateway-new-providers.md`。两种执行方式：

1. **Subagent-Driven（推荐）**：每个任务派全新子代理实现，任务间双人复核（superpowers:subagent-driven-development）
2. **Inline 执行**：本会话按 executing-plans 批量执行，检查点暂停复核
