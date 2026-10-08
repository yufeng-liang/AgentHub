# Qoder 渠道归一·上（接上游主干 + 双路签名）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把上游的 `qoderAdapter.cjs` 接成 Qoder 渠道的生产主路径，同时保住 fork 独有的能力（零客户端自签可用 / 远程模型目录 / PAT 换取 / 跨片 thinking 剥离 / 403 双语义分类 / JWT 身份解析），并摘掉 `rules.cjs` 内置默认里那份「展示名口径」的模型目录污染。

**Architecture:** 上游的 `makeQoder(product, deps)` 成为唯一注册的适配器。fork 的自签路径整体抽成独立深模块 `qoderSelfSign.cjs`（纯函数 + `makeSelfSign(product, deps)` 产出的三条回落链），经 `deps.selfSign` / `deps.selfSignUtil` 注入上游适配器。上游四个文件里每处改动都带一行 `// fork-port：` 标记——本 fork 每轮都要合上游，这些标记是下次冲突定位的唯一抓手。

**Tech Stack:** Node CJS（Electron 主进程后端，无框架）、`node:sqlite`（部分自测需项目内 Electron 的 Node）、Vue + Element Plus 渲染层（本计划不动）、自研 `scripts/dev-*.cjs` 门禁体系。

**Spec:** 本计划实现 `C:\Users\15778\.qoder\projects\H--codex-project-AgentHub\memory\project-qoder-dual-implementation.md` 记录的归一决定（2026-10-08 用户拍板：上游为主干，`qoderCosy` 留作「客户端未装」的兜底签名器）。该文件 §「2026-10-08 re-verification」是本计划的事实基础，其中已更正原决定文档里四条过时前提。

## Global Constraints

- **本计划不动登录、不动 UI、不翻开关**：`store.cjs:156` 的 `QODER_INTL_ENABLED` 保持 `false`，`discovery.cjs` 两个 `beginQoderOAuth`（`1398` 上游 / `2268` fork，靠声明提升后者胜）保持现状。登录归一 + `qoder_intl` 注册 + 区服切换器改双渠道属计划二。
- **上游文件最小改动原则**：`qoderAdapter.cjs` / `qoderAuth.cjs` / `qoderSigner.cjs` / `qoderInstall.cjs` 只允许「加分支 + 打标记」，不得重排或删除上游既有逻辑。
- 注释与用户可见文案用中文；commit 用 `<type>: <中文描述>`。
- **判据只看输出里的 `[FAIL]` / `RED` / `SMOKE FAIL` 行，不看退出码**。长命令一律不接 `| tail` / `| head` / `| grep`（管道会等命令整体结束才吐，且会把失败洗成 0）。
- **所有验证必须在隔离数据目录里跑**：`config.cjs:51` 的真实覆盖键是 `AGENTHUB_DATA_DIR`（`process.env.APPDATA` 只在它缺省时生效）。`tools/*.cjs` 要求 `argv[2]` 传临时目录的必须传，不传会写真实数据。
- **门禁 `for t in scripts/dev-*.cjs` 必须独占跑**，与其他构建/探针并发会让 pipe-test 闪红。
- **绝不按镜像名杀进程**；收尾按 pid 精确清理。
- 号池当前 **0 个 qoder 账号**（`trae 2 / workbuddy 2 / workbuddy_ai 5 / zcode 3 / raccoon 1`）⇒ **不写任何「迁移存量账号」的代码**。但 `rules/catalog.json` 是第二份持久化数据，必须处理（Task 1）。
- 本机装有 `H:\Qoder CN\resources`（qoder）与 `H:\Qoder\resources`（qoder_intl），wasm 签名路径本机可达；但真发上游请求需要已登录的 qoder 账号，号池没有 ⇒ **一切联网断言只能用 stub**。

## 计划范围之外的已知遗留（不要在本计划里顺手修）

1. `qoder` 渠道语义从「按 `meta.mode` 切两区」收窄为 **CN**；`meta.mode === "global"` 的账号会打到 CN 网关。零账号 ⇒ 无实际影响，计划二注册 `qoder_intl` 时闭合。
2. `discovery.cjs` 两个 `beginQoderOAuth` 互相遮蔽（上游版 + 其 `saveQoderAccount` 目前是死码）。本计划不碰，但改 fork 版时必须意识到这点。
3. `meta.machineId`（上游读）与 `meta.machine_id` + `meta.mode`（fork 登录落库）**键名不一致**：fork 登录产出的账号在 wasm 路径下 `machineId` 取空（`qoderAdapter.cjs:149/347`）⇒ 只能走自签回落。这是计划一与计划二之间的已知不一致，必须写进提交说明，**不得**被当成「双路签名已打通验证」。

## 文件结构

| 动作 | 路径 | 职责 |
|---|---|---|
| Create | `electron/backend/proxy/qoderSelfSign.cjs` | fork 的「零客户端」自签路径：地区与域名常量、`ids`/`envelope`/`unpack`/`TagSplitter`/`classify`/`statusCodeOf`/`machineId` 纯函数，与 `makeSelfSign(product, deps)` 产出的 `chat`/`refreshToken`/`fetchModelsRemote`/`userInfo` |
| Modify | `electron/backend/proxy/qoderAdapter.cjs` | 五个 fork-port 触点：chat 签名回落、信封错误分类 + thinking 剥离、refreshToken 双判据、fetchModels 远程兜底、`userInfo`；`refreshWindowSec` 改 300 |
| Modify | `electron/backend/proxy/adapters.cjs` | 删内联段 `4297–4709`；在 `const ADAPTERS`(`5105`) 前用上游 `makeQoder` 实例化；尾部窥视口 `5354–5360` 改从 `qoderSelfSign` 转出 |
| Modify | `electron/backend/proxy/rules.cjs` | `DEFAULTS["catalog.json"].qoder`(`29` 起) 换成 key 口径 + 打 `keyIdSchema: 1` |
| Modify | `electron/backend/proxy/index.cjs` | `proxy_models_sync` 写回处(`861`)补 `keyIdSchema: 1` |
| Modify | `scripts/dev-qoder-test.cjs` | 适配器形状段（约 `120–142`）对齐新形状；其余五段不动 |

**测试面基线（逐条实测于 `4fd7b08`，工作区干净）**

| 门禁 | 现状 | 本计划完成时 |
|---|---|---|
| `scripts/dev-qoder-test.cjs` | GREEN（**61 条 `ok()`**；254 是行数不是断言数） | GREEN（含新增断言） |
| `tools/proxy-qoder-adapter-selftest.cjs` | **RED** @ `:121`「qoder(CN) 静态兜底含 dfmodel」 | GREEN（Task 1） |
| `tools/proxy-smoke.cjs` | **RED** @ `:245`「qoder 适配器十件套齐备」（`need` 实为 **8 个**标识符，名称虚标；fork 实例缺 `headers` 与 `queryCredits`） | GREEN（Task 3） |
| `tools/proxy-qoder-oauth-selftest.cjs` | RED（登录面） | 本计划不承诺 ⇒ 计划二 |
| `tools/proxy-qoder-integration-selftest.cjs` | RED（依赖 checkin 真实风控身份） | 本计划不承诺 ⇒ 计划二 |
| `tools/proxy-qoder-discovery-selftest.cjs` | GREEN，但**惰性绿**：`:50` 与 `:135` 两道判据都是 `if (!store.QODER_INTL_ENABLED) skip` | 仍惰性绿（预期，不得称验证） |
| `scripts/dev-sink-golden.cjs` | **零 qoder 用例** ⇒ 护不住本次改动，不得当路由语义护栏引用 | 同 |

---

## Task 1: 摘掉 catalog 口径污染并给目录打口径标记

**Files:**
- Modify: `electron/backend/proxy/rules.cjs`（`DEFAULTS["catalog.json"].qoder`，`29` 行起那一段）
- Modify: `electron/backend/proxy/index.cjs:861`
- Modify: `electron/backend/proxy/qoderAdapter.cjs:191-206`（`catalogIndex()`）
- Test: `tools/proxy-qoder-adapter-selftest.cjs`（既有 `[3b]`/`[3c]` + 新增 `[3d]`）

**Interfaces:**
- Consumes: 无
- Produces: `catalog.json` 的渠道条目可带 `keyIdSchema: 1`；`catalogIndex()` 对**无该标记的 qoder 条目返回空索引**（等价「未拉取过目录」⇒ `models()` 回落本产品静态兜底）。Task 7 的远程目录写回依赖该标记。

**为什么先做**：`rules.init()` 会把 `DEFAULTS` 写进 rules 目录。当前 `DEFAULTS["catalog.json"].qoder` 是 17 条**展示名 id**（实测：`Qwen3.8-Flash, qwen3.8-max, auto, ultimate, performance, efficient, sonus, cantus, …`），连全新 mkdtemp 沙箱都会带上 ⇒ 这是随包出厂的脏，不是用户数据脏。上游 `catalogIndex()` 读同一文件 ⇒ `models()` 返回展示名 ⇒ `rewriteBody` 把 `model_config.key` 填成 `"ultimate"` 上行 ⇒ 400。又因 `rules.mergeMissing` 只补缺键、从不动已有值，用户真实文件里那 17 条会永久留存 ⇒ **运行时忽略**比删用户文件更稳妥（非破坏、可回退）。

- [ ] **Step 1: 记录既有失败点**

Run: `node tools/proxy-qoder-adapter-selftest.cjs`
Expected：`[FAIL] Error: 断言失败: qoder(CN) 静态兜底含 dfmodel`；且它前一行 `✓ 无目录时 models() 回退静态兜底表` 是**空跑通过**（17 ≥ 14）。

- [ ] **Step 2: 写新的失败断言**

在 `tools/proxy-qoder-adapter-selftest.cjs` 的 `[3c]` 段之后插入：

```js
  // ===== 3d. 出厂默认目录必须是 key 口径（归一移植的地基） =====
  // rules.cjs 的 DEFAULTS 会在首次 init 时写进 rules 目录。fork 期那份 qoder 用的是展示名 id
  // （Auto/Ultimate/…），上游 catalogIndex 读同一文件 ⇒ rewriteBody 把 model_config.key 填成
  // "ultimate" 打给上游 ⇒ 400。用户文件里的历史条目不删（非破坏），但必须运行时忽略。
  console.log("\n[3d] catalog.json 的 qoder 默认条目必须是上游 key 口径 + 带 keyIdSchema 标记");
  {
    const defaults = require("../electron/backend/proxy/rules.cjs").DEFAULTS;
    const q = defaults["catalog.json"].qoder;
    assert(q && q.keyIdSchema === 1, "DEFAULTS catalog.qoder 打了 keyIdSchema:1 标记");
    assert(q.models.every((m) => /^[a-z0-9_]+$/.test(String(m.id))), "DEFAULTS catalog.qoder 全部 id 是 key 形态（无展示名）");
    assert(q.models.some((m) => m.id === "dfmodel"), "DEFAULTS catalog.qoder 含 dfmodel");
    assert(!q.models.some((m) => m.id === "Ultimate"), "DEFAULTS catalog.qoder 不再含展示名 id");
    const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-stale-"));
    fs.writeFileSync(
      path.join(staleDir, "catalog.json"),
      JSON.stringify({ qoder: { syncedAt: 0, models: [{ id: "Ultimate", name: "Ultimate" }] } }),
      "utf8",
    );
    const staleRules = { ...rules, rulesDir: () => staleDir };
    const adStale = makeQoder("qoder", { ...deps, rules: staleRules });
    assert(adStale.models().includes("dfmodel"), "无 keyIdSchema 标记的历史 qoder 目录被忽略 → 回落静态兜底");
    assert(!adStale.models().includes("ultimate"), "被忽略的历史条目不得泄漏成模型 id");
  }
```

- [ ] **Step 3: 跑测试确认失败点未移动**

Run: `node tools/proxy-qoder-adapter-selftest.cjs`
Expected：仍停在 `:121` 的 `qoder(CN) 静态兜底含 dfmodel`（`[3d]` 在其后，尚未执行到）。这一步只确认失败点存在。

- [ ] **Step 4: 换掉 DEFAULTS 里的 qoder 条目**

把 `rules.cjs` 中 `"catalog.json"` 默认值的 `qoder:` 整段替换（id/rate/能力取自 `adapters.cjs:4330-4341` 的 `QODER_FALLBACK.cn`，名称与 key 对齐 `qoderAdapter.cjs:40-55` 的静态表）：

```js
    qoder: {
      // keyIdSchema:1 = 本条目的 id 是**上游真实 model key**（dfmodel/qmodel…），不是展示名。
      // 上游 catalogIndex 只认带此标记的条目；fork 期遗留的展示名条目（无标记）运行时忽略。
      // 口径必须与 rewriteBody 的 model_config.key 一致，否则展示名上行必 400。
      keyIdSchema: 1,
      syncedAt: 0,
      models: [
        { id: "auto", name: "Auto", rate: 1, capabilities: { reasoning: false, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "qfmodel", name: "Qwen3.8-Flash", rate: 0.1, capabilities: { reasoning: true, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "qmodel_38max", name: "Qwen3.8-Max", rate: 0.5, capabilities: { reasoning: true, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "qmodel", name: "Qwen3.7-Plus", rate: 0.1, capabilities: { reasoning: false, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "q37fmodel", name: "Qwen3.7-Flash", rate: 0.1, capabilities: { reasoning: true, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "qmodel_latest", name: "Qwen3.7-Max", rate: 0.5, capabilities: { reasoning: true, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "dfmodel", name: "DeepSeek-Flash", rate: 0.2, capabilities: { reasoning: true, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "dmodel", name: "DeepSeek-V4-Pro", rate: 0.8, capabilities: { reasoning: true, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "gfmodel", name: "GLM-5.3-Flash", rate: 0.1, capabilities: { reasoning: true, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "gmodel", name: "GLM-5.3", rate: 0.6, capabilities: { reasoning: true, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "gm51model", name: "GLM-5.2", rate: 0.6, capabilities: { reasoning: true, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "kmodel", name: "Kimi-K2.8-Preview", rate: 0.3, capabilities: { reasoning: true, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "kmodel_latest", name: "Kimi-K3", rate: 0.8, capabilities: { reasoning: true, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
        { id: "mmodel", name: "MiniMax-M2.7", rate: 0.2, capabilities: { reasoning: false, images: true, tools: true }, contextLength: 200000, maxOutputTokens: 0 },
      ],
    },
```

- [ ] **Step 5: `catalogIndex()` 只认带标记的条目**

`qoderAdapter.cjs` 的 `catalogIndex()`（`191-206`）里，把 `const entry = all[product];` 改为：

```js
    let entry = all[product];
    // fork-port：无 keyIdSchema 标记的历史条目（fork 期展示名口径）一律忽略，等价「未拉取过目录」
    // → models() 回落本产品静态兜底。用户文件里的旧条目不删（非破坏、可回退），
    // 但绝不能让它参与路由——展示名当 key 上行必 400。
    if (entry && entry.keyIdSchema !== 1) entry = null;
```

下方 `for (const m of (entry && Array.isArray(entry.models) ? entry.models : []))` 与 `catalogCache = { at: st, byKey, raw: entry || null }` 保持原样。

- [ ] **Step 6: `proxy_models_sync` 写回时补标记**

`index.cjs:861`：

```js
    cur[ch] = { syncedAt: Date.now(), keyIdSchema: 1, models: r.models };
```

- [ ] **Step 7: 跑测试确认 [3b]/[3c]/[3d] 全绿**

Run: `node tools/proxy-qoder-adapter-selftest.cjs`
Expected：`[3d]` 六条 `✓`，末尾无 `[FAIL]`。

- [ ] **Step 8: 负控制——证明 [3d] 的忽略断言不是空跑**

临时把 Step 5 的 `if (entry && entry.keyIdSchema !== 1) entry = null;` 注释掉再跑 Step 7，必须看到 `无 keyIdSchema 标记的历史 qoder 目录被忽略` 变 `[FAIL]`；确认后立即改回并重跑至绿。

- [ ] **Step 9: 提交**

```bash
git add electron/backend/proxy/rules.cjs electron/backend/proxy/index.cjs electron/backend/proxy/qoderAdapter.cjs tools/proxy-qoder-adapter-selftest.cjs
git commit -m "fix(qoder): 模型目录口径归一——DEFAULTS 展示名条目改上游 key 并加 keyIdSchema 标记，无标记历史条目运行时忽略"
```

---

## Task 2: 抽纯函数模块 `qoderSelfSign.cjs`（零行为变化）

**Files:**
- Create: `electron/backend/proxy/qoderSelfSign.cjs`
- Modify: `electron/backend/proxy/adapters.cjs`（删 `4299-4490` 的常量与纯函数定义、`4693-4708` 的 `qoderMachineId`；`makeQoder` 改调模块；`5354-5360` 窥视口转出）
- Test: `scripts/dev-qoder-test.cjs`（本 Task 结束时 61 条必须仍全绿 + 新增装配断言）

**Interfaces:**
- Consumes: `./qoderCosy.cjs`（`encodeBody` / `buildCosyHeaders` / `GATEWAY_COSY_VERSION`）
- Produces（完整导出面，Task 3–7 全部按这些名字取用）：

```js
module.exports = {
  REGIONS,            // 原 QODER_REGIONS {global, cn}；gateway 值**带尾斜杠**（fork 的拼接方式）
  PRODUCT_REGION,     // { qoder: "cn", qoder_intl: "global" } —— 地区由渠道 id 决定，不再读 meta.mode
  CHAT_PATH, MODEL_LIST_PATH, REFRESH_PATH,
  FALLBACK,           // 原 QODER_FALLBACK { global:[17], cn:[10] }，仅供 Task 3 换表时取 rate
  regionOf,           // 原 makeQoder()._regionOf（account.meta.mode/edition → "cn"|"global"）
  machineId,          // 原 qoderMachineId：**无参**，只碰文件，无网络/注册表
  classify,           // 原 qoderClassify({httpStatus, text}) → {status, message}
  statusCodeOf,       // 新增：信封 {statusCodeValue:number | statusCode:string} → 数字状态码
  unpack,             // 原 qoderUnpack(frame) → {ok:true,chunk} | {done:true} | {ok:false,status,text}
  ids,                // 原 qoderIds({userId, upstreamKey, maxTokens, seed})
  envelope,           // 原 qoderBody({internal, modelEntry, ids, requestId, lastUserText})
  TagSplitter,        // 原 class TagSplitter（含 QODER_TAG_OPEN/CLOSE、OPEN_KEEP=10、CLOSE_KEEP=11）
  jwtUserInfo,        // 原 makeQoder().userInfo(token)（读 JWT payload）
};
```

> **`makeSelfSign` 不在本 Task 的导出面里**——它随 Task 3 与「fork 的 chat/refresh/fetchModels 三条实例方法」同时出现。这里不留抛错占位：留了就等于把「未接线」写进生产导出面，Task 3 若漏改也不会有任何测试变红。

**关键约束：所有纯函数的调用元数必须与 `adapters._qoder*` 现状逐字一致。** 实测 `scripts/dev-qoder-test.cjs` 的调用形状：`_qoderIds({userId,upstreamKey,maxTokens,seed})`（`:73`、`:78`）、`_qoderBody({…})`（`:80`、`:94`）、`_qoderUnpack(frame)`（`:113/116/117`）、`new _TagSplitter()`（`:104`）、`_qoderClassify`（`:64`）。改成注入参数会让这约 40 条断言全红，而它们是本计划的安全网，不是要重写的对象。

- [ ] **Step 1: 建模块，逐字搬入常量与纯函数**

新建 `electron/backend/proxy/qoderSelfSign.cjs`，把 `adapters.cjs` 的下列段落**原样搬入**（不改一个字符，只重命名与加 `require`；搬运前用 `grep -n` 复核行号，本仓历史行号会漂）：

| 源（`adapters.cjs`） | 搬入后 |
|---|---|
| `4299-4302` `QODER_REGIONS` | `REGIONS` |
| `4303-4305` `QODER_CHAT_PATH` / `QODER_MODEL_LIST_PATH` / `QODER_REFRESH_PATH` | `CHAT_PATH` / `MODEL_LIST_PATH` / `REFRESH_PATH`（`4306` 的 `QODER_USERINFO_PATH` **全段未被引用，是死常量，不搬**） |
| `4310-4342` `QODER_FALLBACK` | `FALLBACK` |
| `4347-4354` `qoderClassify` | `classify` |
| `4357-4363` `qoderIds` | `ids` |
| `4366-4433` `qoderBody` | `envelope` |
| `4437-4448` `qoderUnpack` | `unpack` |
| `4450-4490` 两个正则 + 两个 KEEP + `class TagSplitter` | 同名 |
| `4497-4500` `_regionOf` 函数体 | `regionOf` |
| `4661-4665` `userInfo` | `jwtUserInfo` |
| `4693-4708` `_qoderMid` 缓存 + `qoderMachineId` | `machineId` |

文件头注释（保留「先编码后签名」这条铁律——它是本模块最容易踩且报错最不可读的坑）：

```js
// Qoder 自签路径（fork 独有）：本机未安装 Qoder 客户端时的可用链。
//
// 与上游 qoderAdapter 的形状差异：上游签名由客户端里的 wasm 逐请求产出（qoderSigner.cjs），
// 本模块用 qoderCosy.cjs 纯 JS 复现同一套 COSY 签名 ⇒ 零安装可用。
// 请求体必须**先 encodeBody、后 buildCosyHeaders**（签的是编码后字节），顺序颠倒只报「签名不匹配」，无从排查。
//
// 地区由**渠道 id** 决定（PRODUCT_REGION）；regionOf(account) 仅供过渡期读 meta.mode 的历史账号。
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const qcosy = require("./qoderCosy.cjs");

const PRODUCT_REGION = { qoder: "cn", qoder_intl: "global" };
```

- [ ] **Step 2: 补齐被搬段落的外部依赖（保持调用元数不变）**

实测依赖方向：`util.cjs` 只 require `node:crypto` 与 `package.json`；`store.cjs` 只 require `node:fs/path/crypto` 与 `../config.cjs`。**两者都不指回 `adapters.cjs`** ⇒ 本模块可以顶层直接 require，从而让 `ids`/`machineId`/`jwtUserInfo` 保持原有无注入签名：

```js
const U = require("./util.cjs");       // uuid / jwtDecode / normalizeOpenAiUsage（顶层 require 不成环：util 只依赖内置与 package.json）
const store = require("./store.cjs");  // proxyDir()（store 只依赖 config 与内置，不回指 adapters）
```

- `parseJson`（`adapters.cjs:272`）：`unpack` 用 ⇒ 在本模块内联等价实现并注释来源：

```js
/** 与 adapters.cjs 的同名私有 parseJson 等价（JSON.parse 失败回 null）。
 *  不复用是因为反向 require adapters 会成循环依赖——本仓 index.cjs:33 与 adapters.cjs:2873
 *  两处注释记录过同一教训：Node 下取到半初始化模块 → undefined。 */
function parseJson(s) { try { return JSON.parse(s); } catch { return null; } }
```

- `statusCodeOf` 是新函数，写在 `classify` 之后：

```js
/** 信封状态码归一：fork 链路给 statusCodeValue（数字，HTTP 恒 200 时错误码在内层），
 *  上游 wasm 解密后的信封给 statusCode（字符串，如 UNAUTHORIZED / OK）。两条路径共用 classify
 *  时必须先归一，漏掉哪一侧，403 双语义判据就整体失效。 */
function statusCodeOf(env) {
  const n = Number(env && env.statusCodeValue);
  if (Number.isFinite(n) && n > 0) return n;
  const s = String((env && env.statusCode) || "").toUpperCase();
  const map = { UNAUTHORIZED: 401, FORBIDDEN: 403, TOO_MANY_REQUESTS: 429, RATE_LIMITED: 429, PAYMENT_REQUIRED: 402 };
  return map[s] || 0;
}
```

- [ ] **Step 3: 写装配失败测试**

在 `scripts/dev-qoder-test.cjs` 顶部 `require` 区（现 `:18` 附近）之后新增：

```js
// ===== 0. 自签模块装配（归一移植地基：形状齐备 + 地区由渠道 id 定） =====
const qSelf = require("../electron/backend/proxy/qoderSelfSign.cjs");
ok("自签模块导出面齐备", ["REGIONS","PRODUCT_REGION","regionOf","machineId","classify","statusCodeOf","unpack","ids","envelope","TagSplitter","jwtUserInfo","FALLBACK","CHAT_PATH","MODEL_LIST_PATH","REFRESH_PATH"].every((k) => qSelf[k] !== undefined));
ok("纯函数调用元数与历史一致（dev-qoder-test 既有断言不得因注入而红）", qSelf.ids({ userId: "u1", upstreamKey: "qfmodel", maxTokens: 32768 }).sessionId.length > 0 && qSelf.unpack({ statusCodeValue: 200, body: "{}" }).ok === true && qSelf.jwtUserInfo.length === 1 && qSelf.machineId.length === 0);
ok("地区按渠道 id 判定", qSelf.PRODUCT_REGION.qoder === "cn" && qSelf.PRODUCT_REGION.qoder_intl === "global");
ok("statusCodeOf 两侧信封都吃", qSelf.statusCodeOf({ statusCodeValue: 403 }) === 403 && qSelf.statusCodeOf({ statusCode: "UNAUTHORIZED" }) === 401 && qSelf.statusCodeOf({ statusCode: "OK" }) === 0);
```

- [ ] **Step 4: 跑测试确认失败**

Run: `node scripts/dev-qoder-test.cjs`
Expected：`Cannot find module '…/qoderSelfSign.cjs'`，或（文件已建时）导出面缺项的失败行。不得静默通过。

- [ ] **Step 5: 让 `adapters.cjs` 从模块取同一批符号**

删除 Step 1 搬走的定义；在 `require("./qoderCosy.cjs")`（`:18`）附近加：

```js
const qoderSelfSign = require("./qoderSelfSign.cjs");
```

fork `makeQoder()`（`:4492`）体内改调用（**行为逐字不变，只换来源**）：

- `_regionOf(account)` → `qoderSelfSign.regionOf(account)`
- `models()` / `modelEntries()` 里的 `QODER_FALLBACK` → `qoderSelfSign.FALLBACK`
- `chat()` 里 `qoderIds(...)` / `qoderBody(...)` / `qoderUnpack(...)` / `new TagSplitter()` / `qoderClassify(...)` / `qoderMachineId()` / `QODER_REGIONS` / `QODER_CHAT_PATH` → 对应 `qoderSelfSign.ids(…)` / `.envelope(…)` / `.unpack(…)` / `.TagSplitter` / `.classify(…)` / `.machineId()` / `.REGIONS` / `.CHAT_PATH`（**参数个数一律不变**，`util`/`store` 已在模块顶层 require）
- `refreshToken()` 里的 `QODER_REGIONS` / `QODER_REFRESH_PATH` → `qoderSelfSign.REGIONS` / `.REFRESH_PATH`
- `userInfo(token)` → `qoderSelfSign.jwtUserInfo(token)`

- [ ] **Step 6: 尾部窥视口改指向模块**

`adapters.cjs:5354-5360` 替换为：

```js
  // qoder 窥视口：错误分类/id 派生/信封体/双层解包/标签状态机纯函数，dev-qoder-test 直测。
  // 归一移植后实现住在 qoderSelfSign.cjs，此处只转出，保持既有调用点不变
  // （跨文件消费者：discovery.cjs:2341 用 _qoderMachineId 取自签机器标识）。
  _qoderClassify: qoderSelfSign.classify,
  _qoderIds: qoderSelfSign.ids,
  _qoderBody: qoderSelfSign.envelope,
  _qoderUnpack: qoderSelfSign.unpack,
  _qoderMachineId: qoderSelfSign.machineId,
  _TagSplitter: qoderSelfSign.TagSplitter,
```

- [ ] **Step 7: 跑测试确认全绿**

```bash
node scripts/dev-qoder-test.cjs
node tools/proxy-qoder-adapter-selftest.cjs
```
Expected：`dev-qoder-test` 无失败行且断言数 = 61 + 4；`adapter-selftest` 仍无 `[FAIL]`。

- [ ] **Step 8: 负控制——证明窥视口真的接上了新模块**

临时把 `_qoderClassify: qoderSelfSign.classify` 改成 `_qoderClassify: () => ({ status: 502, message: "x" })`，跑 Step 7，`dev-qoder-test` 里 403 双语义那条必须变红；改回后重跑至绿。

- [ ] **Step 9: 提交**

```bash
npm run build
git add electron/backend/proxy/qoderSelfSign.cjs electron/backend/proxy/adapters.cjs scripts/dev-qoder-test.cjs
git commit -m "refactor(qoder): 自签纯函数与常量抽入 qoderSelfSign.cjs——行为逐字不变，为接上游主干腾出单一落点"
```

---

## Task 3: 切换注册——上游 `makeQoder` 成为生产主路径

**Files:**
- Modify: `electron/backend/proxy/qoderSelfSign.cjs`（`makeSelfSign` 填实：`chat` / `refreshToken` / `fetchModelsRemote`）
- Modify: `electron/backend/proxy/adapters.cjs`（删 `4492-4709` 的 fork `makeQoder` 与实例；在 `const ADAPTERS`(`5105`) 前接上游）
- Modify: `scripts/dev-qoder-test.cjs`（`120–142` 适配器形状段重写）
- Test: `tools/proxy-smoke.cjs:239-268`（既有八件套断言，**不改**）、`tools/proxy-qoder-adapter-selftest.cjs` 新增 `[8]`

**Interfaces:**
- Consumes: `makeUpstreamQoder(product, deps)`（`qoderAdapter.cjs:122`）、`qoderSigner.createSession`、`qoderAuth.PRODUCTS/refreshDeviceToken/readCatalogBlob/readRiskIdentity`、`qoderSelfSign` 全部
- Produces:

```js
qoderSelfSign.makeSelfSign(product, deps) → {
  product, region,
  chat({account, secrets, modelKey, entry, body, emit}) → Promise<{status:number, planLimit:boolean}>,
    // entry = {key, is_reasoning, is_vl, efforts[]}，由调用方用 modelMeta 归一后传入
  refreshToken({account, secrets}) → Promise<{ok, token?, refreshToken?, expiresAt?, expired?, message?}>,
  fetchModelsRemote({account, secrets}) → Promise<{ok:boolean, models?:object[], scene?, modelCount?, message?}>,
    // models 条目 = 上游形状：id=**上游 key**、name=display_name、capabilities{reasoning,tools,images}、
    // reasoning: {effort:null, defaultEffort:"", supportedEfforts:[…]} | null、contextLength、maxOutputTokens、isFree、scene
}
adapters.get("qoder") → 上游实例，八件套齐备（cfg/models/fetchModels/headers/rewriteBody/chat/queryCredits/refreshToken）
```

本 Task 之后**「零客户端可用」暂时失效**（自签实现已在模块里但尚未接进 chat，Task 4 接上）：号池 0 账号 ⇒ 无用户影响，但提交说明必须写明这是中间态。

- [ ] **Step 1: 写注册形状失败测试**

在 `scripts/dev-qoder-test.cjs` 中删除 `120–142` 区间的 `models()/modelEntries()/upstreamFor()/_resolveEntry()` 断言，替换为（其余五段——`qoderCosy`、`_qoderClassify`、`_qoderIds`/`_qoderBody`、`_TagSplitter`/`_qoderUnpack`、设备流登录——**一律不动**：它们测的是自签模块与 discovery，切换后仍成立）：

```js
// ===== 7. 注册形状（归一移植后：上游 makeQoder 是生产主路径） =====
const qAd2 = adapters.get("qoder");
ok("八件套齐备（与 proxy-smoke 同判据）", ["cfg","models","fetchModels","headers","rewriteBody","chat","queryCredits","refreshToken"].every((k) => typeof qAd2[k] === "function"));
ok("refreshWindowSec=300", qAd2.refreshWindowSec === 300);
ok("模型 id 是上游 key", qAd2.models().includes("dfmodel") && !qAd2.models().some((m) => /[^a-z0-9_]/.test(String(m))));
ok("headers() 不含 Authorization（签名在 chat 内现场产）", !("authorization" in qAd2.headers()));
ok("rewriteBody 把请求模型落进 model_config.key", qAd2.rewriteBody("dfmodel", { messages: [{ role: "user", content: "x" }] }, { uid: "u" }, {}).model_config.key === "dfmodel");
ok("fork-port：自签纯函数仍从 adapters 转出（discovery:2341 依赖 _qoderMachineId）", typeof adapters._qoderMachineId === "function" && typeof adapters._qoderClassify === "function" && typeof adapters._TagSplitter === "function");
ok("fork-port：adapter 有 userInfo（discovery:1131 的导入路径要调，缺它会同步 TypeError）", typeof qAd2.userInfo === "function");
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/dev-qoder-test.cjs`
Expected：`八件套齐备` 与 `模型 id 是上游 key` 报失败（当前 fork 薄壳不满足）。

- [ ] **Step 3: 填实 `makeSelfSign`——把 fork 的三条实例方法搬进模块**

`deps = { fetchStream, pumpSse, httpJson }`（`util` / `store` 已在模块顶层 require，不再注入；`pumpSse` 只有 `chat` 用）。

从 `adapters.cjs` 搬入（搬运即删除，不留第二份）：

- `4557-4628`（fork `chat`）→ `makeSelfSign` 的 `chat`。改动仅限：`this._regionOf(account)` → 闭包持有的 `region`；`this._resolveEntry(model)` 与 `const entry = … || {key:"auto",…}` 整行删除，改由参数 `entry` 传入；体内 `entry._efforts` → `entry.efforts`；`model` → `modelKey`。其余（`qoderIds`/`qoderBody`/思考档位映射/`qcosy.encodeBody` → `buildCosyHeaders` 顺序/`TagSplitter` 挂载点/`flush` 位置）**逐字保留**。
- `4633-4659`（fork `refreshToken`）→ `makeSelfSign` 的 `refreshToken`。改动仅限：`QODER_REGIONS[this._regionOf(account)]` → `REGIONS[region]`；`this` 去除。PAT 分支（`segs[0]==="pat"` → `POST {openApi}/api/v1/jobToken/exchange`，体 `{personal_token: segs[1]}`，过期取 `util.jwtDecode(token).exp * 1000`，`refreshToken` 原串回写）与 3 段 center 分支**逐字保留**。
- `4668-4687`（fork `fetchModels`）→ `fetchModelsRemote`，**产出形状必须同时改成上游形状**（这是防止展示名 id 二次污染 catalog 的关键一步；`QODER_FALLBACK` 从此不参与 `models()`，上游规则是「有目录只认目录，绝不并静态表」issue #74）：

```js
    async function fetchModelsRemote({ account, secrets }) {
      const cfg = REGIONS[region];
      const url = `${cfg.gateway}${MODEL_LIST_PATH}`;
      const requestId = U.uuid();
      const encoded = qcosy.encodeBody(Buffer.from(JSON.stringify({ region }), "utf8"));
      const headers = qcosy.buildCosyHeaders({ url, body: encoded, uid: (account && account.uid) || "", token: (secrets && secrets.token) || "", name: "", email: "", machineId: machineId(), requestId });
      const r = await httpJson(url, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String(e) }));
      const chat = r.data && (r.data.chat || (r.data.data && r.data.data.chat));
      if (!r.ok || !Array.isArray(chat)) return { ok: false, message: `目录拉取失败（HTTP ${r.status || 0}）` };
      // 形状对齐上游 qoderAdapter.fetchModels：id 用**上游 key**（fork 历史用 display_name 去空白，
      // 那正是随包出厂那份 catalog 污染的来源），展示名落 name，档位落 reasoning.supportedEfforts。
      const models = chat.filter((m) => m && m.key).map((m) => {
        const ctxTiers = m.context_config && typeof m.context_config === "object" ? Object.values(m.context_config) : [];
        const ctxMax = ctxTiers.reduce((n, t) => Math.max(n, Number((t && t.token_count) || 0)), 0);
        const efforts = (() => {
          const e = m.thinking_config && m.thinking_config.enabled && m.thinking_config.enabled.efforts;
          return e && typeof e === "object" ? Object.keys(e) : [];
        })();
        return {
          id: String(m.key),
          name: String(m.display_name || m.key),
          rate: m.price_factor != null ? Number(m.price_factor) : null,
          capabilities: { reasoning: !!m.is_reasoning, tools: true, images: !!m.is_vl },
          reasoning: efforts.length ? { effort: null, defaultEffort: "", supportedEfforts: efforts } : null,
          contextLength: ctxMax || Number(m.max_input_tokens) || 0,
          maxOutputTokens: 0,
          isFree: m.is_free === true || Number(m.price_factor) === 0,
          scene: "assistant",
        };
      });
      return models.length ? { ok: true, models, scene: "assistant", modelCount: models.length } : { ok: false, message: "目录为空" };
    }
```

- [ ] **Step 4: 写远程目录形状测试**

在 `tools/proxy-qoder-adapter-selftest.cjs` 插入：

```js
  // ===== 8. 自签模块的远程目录必须是 key 口径（防展示名二次污染） =====
  console.log("\n[8] makeSelfSign().fetchModelsRemote 产出上游形状");
  {
    let called = null;
    const stubHttpJson = async (url, o) => {
      called = url;
      return { ok: true, status: 200, data: { chat: [
        { key: "dfmodel", display_name: "DeepSeek-Flash", price_factor: 0.2, is_reasoning: true, is_vl: true, thinking_config: { enabled: { efforts: { low: {}, xhigh: {} } } }, max_input_tokens: 180000 },
        { key: "auto", display_name: "Auto", price_factor: 1, is_reasoning: false, is_vl: true },
      ] } };
    };
    const ss = qoderSelfSign.makeSelfSign("qoder", { fetchStream: deps.fetchStream, pumpSse: deps.pumpSse, httpJson: stubHttpJson });
    const r = await ss.fetchModelsRemote({ account: { uid: "u1" }, secrets: { token: "jwt" } });
    assert(r.ok === true, "远程目录拉取成功");
    assert(r.models.some((m) => m.id === "dfmodel"), "id 是上游 key");
    assert(!r.models.some((m) => m.id === "DeepSeek-Flash"), "绝不产出展示名 id");
    assert(r.models.find((m) => m.id === "dfmodel").name === "DeepSeek-Flash", "展示名落在 name");
    assert(JSON.stringify(r.models.find((m) => m.id === "dfmodel").reasoning.supportedEfforts) === JSON.stringify(["low", "xhigh"]), "档位落在 reasoning.supportedEfforts");
    assert(/model\/list/.test(String(called)), "确实打了 model/list");
    assert(ss.region === "cn", "qoder 产品的自签地区是 cn");
  }
```

（`qoderSelfSign` 需在文件顶部 require：`const qoderSelfSign = require("../electron/backend/proxy/qoderSelfSign.cjs");`）

- [ ] **Step 5: 换成上游实例注册**

删除 `adapters.cjs` 的 fork `makeQoder()` 与 `const qoder = makeQoder();`，在 `const ADAPTERS = {`(`:5105`) 之前插入：

```js
// ===== Qoder（归一移植：上游 qoderAdapter 为主干 + fork 自签兜底，地区由渠道 id 定） =====
// deps 必须注入：fetchStream/pumpSse/httpJson 是本模块私有（未导出），反向 require 会成循环依赖。
const qoderDeps = {
  fetchStream, pumpSse, httpJson, rules, store, util,
  auth: require("./qoderAuth.cjs"),
  signer: require("./qoderSigner.cjs"),
  selfSign: qoderSelfSign.makeSelfSign("qoder", { fetchStream, pumpSse, httpJson }),
  selfSignUtil: qoderSelfSign,
};
const qoder = makeUpstreamQoder("qoder", qoderDeps);
```

并在 `adapters.cjs` 顶部 require 区加：

```js
const { makeQoder: makeUpstreamQoder } = require("./qoderAdapter.cjs");
```

`qoder_intl` **不在本计划注册**（计划二随 `QODER_INTL_ENABLED` 同批翻）。

同一步里删掉 Task 2 留下的过渡件 `qoderSelfSign.regionOf`（唯一消费者是被删的 fork `_regionOf` 与 dev-qoder-test 的对应断言；留着就是无人调的死导出）。**但 `FALLBACK` 保留**：它的 global 17 行是 2026-09-20 实测的 rate/能力事实，此刻在仓库里没有第二个落点，而计划二要把它们安进 `STATIC_MODELS_BY_PRODUCT.qoder_intl`。这件事不在本计划做，因为 `adapter-selftest [3b]` 有一条**刻意**断言 `qoder_intl 静态兜底应为空`（上游 issue #74 的「宁缺勿错」闸），给 intl 补兜底必须先与那条闸对齐——属计划二的决策点。

- [ ] **Step 6: 给上游 adapter 补 `userInfo`（fork-port，否则导入路径静默崩）**

`discovery.cjs:1131` 是 `adapter.userInfo(accessToken).catch(...)`——方法不存在时抛的是**同步 TypeError**，`.catch` 兜不住。`qoderAdapter.cjs` 的返回对象里 `refreshToken` 之后追加：

```js
    /** fork-port：fork 的 device 登录落的是 JWT 凭据，身份直接从 payload 读；
     *  discovery.cjs:1131 的导入/扫描路径调此方法，方法缺失会同步抛 TypeError（不是 rejected promise，
     *  链上的 .catch 兜不住），表现为「导入 qoder 账号直接崩」。 */
    async userInfo(token) {
      const c = (U.jwtDecode(String(token || "")).payload) || {};
      return { uid: String(c.user_id || c.sub || U.jwtDecode(String(token || "")).uid || ""), name: String(c.nickname || c.name || "Qoder 账号") };
    },
```

- [ ] **Step 7: 跑 qoder 双闸**

```bash
node scripts/dev-qoder-test.cjs
node tools/proxy-qoder-adapter-selftest.cjs
```
Expected：两者无失败行；`dev-qoder-test` 断言数不少于 61 + 3 + 7（新形状段）。

- [ ] **Step 8: proxy-smoke 八件套转绿**

```bash
D=$(mktemp -d)
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-smoke.cjs "$D"
```
Expected：不再出现 `断言失败: qoder 适配器十件套齐备`。若 `:252 models()>=14` / `:260 headers 无 Authorization` / `:268 dfmodel 仅归 qoder` 任一变红，**按新形状修实现，不放宽断言**。

- [ ] **Step 9: 全量 dev 门禁（独占跑）**

```bash
node scripts/dev-bundle-check.cjs --check
for t in scripts/dev-*.cjs; do node "$t" >/dev/null 2>&1 || echo "RED: $t"; done
```
Expected：只允许既有红 `dev-import-batch`（项目记忆：恒 31/2 红，夹具在长 `%TEMP%` 撞 `reverseSessionDirName` 的 8 段防爆炸）。其它 `RED:` 一律按本计划回归处理。

- [ ] **Step 10: 类型检查 + 提交**

```bash
npm run build
git add electron/backend/proxy/adapters.cjs electron/backend/proxy/qoderAdapter.cjs electron/backend/proxy/qoderSelfSign.cjs scripts/dev-qoder-test.cjs tools/proxy-qoder-adapter-selftest.cjs
git commit -m "feat(qoder): 上游 qoderAdapter 接成生产主路径——删内联实例，deps 注入自签与分类工具，补 userInfo 防导入路径崩

注：本提交后「零客户端可用」暂时失效（自签实现已在模块里但未接进 chat，下一提交接上），
属归一移植的中间态；qoder_intl 与登录归一仍未闭合。"
```

---

## Task 4: `chat` 双路签名（wasm 不可用 ⇒ 回落自签）

**Files:**
- Modify: `electron/backend/proxy/qoderAdapter.cjs:344-356`
- Test: `tools/proxy-qoder-adapter-selftest.cjs` 新增 `[9]`

**Interfaces:**
- Consumes: `deps.selfSign.chat({account, secrets, modelKey, entry, body, emit})`（Task 3 产出）、`modelMeta(key)`（`qoderAdapter.cjs:209`）
- Produces: `chat()` 在 `signer.createSession` 抛错（`status:503, qoderSignerDown:true`）时返回自签路径结果；`deps.selfSign` 缺省时与上游行为逐字一致。

- [ ] **Step 1: 写失败测试**

```js
  // ===== 9. 双路签名：签名器不可用时回落自签（fork「零安装可用」卖点） =====
  console.log("\n[9] 签名器不可用 → 回落 qoderSelfSign");
  {
    let selfArgs = null;
    const selfSign = {
      chat: async (a) => { selfArgs = a; return { status: 200, planLimit: false, viaSelfSign: true }; },
      refreshToken: async () => ({ ok: true, token: "t", refreshToken: "rt", expiresAt: 1 }),
      fetchModelsRemote: async () => ({ ok: false, message: "n/a" }),
    };
    const adDown = makeQoder("qoder", { ...deps, selfSign });
    const r = await adDown.chat({
      account: { uid: "u1", meta: { machineId: "m1" } }, secrets: { token: "dt-x" },
      model: "dfmodel", body: { messages: [{ role: "user", content: "hi" }] }, emit: () => {}, meta: {},
    });
    assert(r.viaSelfSign === true, "签名器抛错时走了自签回落");
    assert(selfArgs && selfArgs.entry.key === "dfmodel", "回落传出的 entry.key 是请求模型 key");
    assert(Array.isArray(selfArgs.entry.efforts), "回落传出的 entry.efforts 是数组");
    assert(selfArgs.account.uid === "u1" && typeof selfArgs.emit === "function", "回落转出 account/emit 原样");
    const adNo = makeQoder("qoder", { ...deps });
    let threw = null;
    await adNo.chat({ account: { uid: "u1", meta: {} }, secrets: { token: "dt-x" }, model: "dfmodel", body: { messages: [] }, emit: () => {}, meta: {} }).catch((e) => { threw = e; });
    assert(threw && threw.status === 503 && threw.qoderSignerDown === true, "未注入 selfSign 时保持上游 503 语义（不静默降级）");
  }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/proxy-qoder-adapter-selftest.cjs`
Expected：`[FAIL] Error: 断言失败: 签名器抛错时走了自签回落`

- [ ] **Step 3: 实现回落分支**

`chat()` 里 `const entry = await acquireSession(account, secrets);`（`:355`）替换为：

```js
      // fork-port：本机未装 Qoder 客户端时 signer.createSession 抛 503 qoderSignerDown。
      // 上游的选择是「渠道级故障、不罚账号」；fork 还有第二条签名路（qoderSelfSign 纯 JS 自签，零安装可用）。
      // 缺 selfSign 注入时保持上游原语义，绝不静默降级——静默降级会让「客户端没装」伪装成别的错误。
      let entry;
      try {
        entry = await acquireSession(account, secrets);
      } catch (e) {
        if (deps.selfSign && e && e.qoderSignerDown) {
          const mm = modelMeta(key);
          return deps.selfSign.chat({
            account, secrets, modelKey: key, body, emit,
            entry: {
              key,
              is_reasoning: !!(mm.capabilities && mm.capabilities.reasoning),
              is_vl: !!(mm.capabilities && mm.capabilities.images),
              efforts: (mm.reasoning && mm.reasoning.supportedEfforts) || [],
            },
          });
        }
        throw e;
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tools/proxy-qoder-adapter-selftest.cjs`
Expected：`[9]` 段五条 `✓`，末尾无 `[FAIL]`。

- [ ] **Step 5: 负控制**

把 `if (deps.selfSign && e && e.qoderSignerDown)` 临时改为 `if (false && e)`，重跑 Step 4 必须见 `签名器抛错时走了自签回落` 变 `[FAIL]`；改回后重跑至绿。

- [ ] **Step 6: 提交**

```bash
git add electron/backend/proxy/qoderAdapter.cjs tools/proxy-qoder-adapter-selftest.cjs
git commit -m "feat(qoder): 双路签名——wasm 签名器不可用时回落 fork 自签，恢复零客户端可用"
```

---

## Task 5: 信封错误分类与跨片 thinking 剥离接进共享出口

**Files:**
- Modify: `electron/backend/proxy/qoderAdapter.cjs:123`（dep 解构）、`:392-450`（`pumpSse` 回调）
- Test: `tools/proxy-qoder-adapter-selftest.cjs` 新增 `[10]`

**Interfaces:**
- Consumes: `deps.selfSignUtil`（= `qoderSelfSign` 模块本体，Task 3 已注入）的 `classify` / `statusCodeOf` / `TagSplitter`
- Produces: `chat()` 在信封层错误上产出 `402` 并置 `result.planLimit = true`（额度/限流 → 换号触发），裸 `403` → `401`（登录态 → 刷新）；`emit({type:"delta"})` 的 `content` 已过 `TagSplitter`，流末补发 `flush()` 尾巴。

- [ ] **Step 1: 写失败测试**

```js
  // ===== 10. fork-port：403 双语义 / 429→402 / <thinking> 跨片剥离 =====
  console.log("\n[10] 信封分类与 thinking 剥离");
  {
    const SU = require("../electron/backend/proxy/qoderSelfSign.cjs");
    const mk = (text) => makeQoder("qoder", {
      ...deps,
      selfSignUtil: SU,
      selfSign: undefined,
      signer: { createSession: async () => ({ prepareInferRequest: () => ({ url: "http://x/y", headers: {}, body: Buffer.from("{}") }), modelCacheDecrypt: () => "{}", free() {} }) },
      fetchStream: async () => ({ resp: { body: sseStream(text), ok: true, status: 200 }, cancelTimer: () => {} }),
    });
    const e1 = [];
    const r1 = await mk(frame({ message: "please see https://qoder.com/pricing to upgrade your plan" }, "FORBIDDEN")).chat({ account: { uid: "u", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: (x) => e1.push(x), meta: {} });
    assert(e1.some((x) => x.type === "error" && x.status === 402), "403 带 pricing 判成 402");
    assert(r1.planLimit === true, "402 同时置 planLimit（换号触发口径）");
    const e2 = [];
    await mk(frame({ message: "permission denied" }, "FORBIDDEN")).chat({ account: { uid: "u", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: (x) => e2.push(x), meta: {} });
    assert(e2.some((x) => x.type === "error" && x.status === 401), "裸 403 判成 401 登录态");
    const e3 = [];
    await mk(frame({ message: "rate limit exceeded" }, "TOO_MANY_REQUESTS")).chat({ account: { uid: "u", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: (x) => e3.push(x), meta: {} });
    assert(e3.some((x) => x.type === "error" && x.status === 402), "429 转 402（限流交交换号，不算硬故障）");
    const e4 = [];
    const two = frame({ choices: [{ delta: { content: "A<thin" } }] }, "OK") + frame({ choices: [{ delta: { content: "king>B秘密</thinking>C" } }] }, "OK");
    await mk(two).chat({ account: { uid: "u", meta: {} }, secrets: { token: "t" }, model: "dfmodel", body: { messages: [] }, emit: (x) => e4.push(x), meta: {} });
    const text = e4.filter((x) => x.type === "delta").map((x) => (x.delta && x.delta.content) || "").join("");
    assert(text === "AC", "跨片 thinking 剥离干净（实得 " + JSON.stringify(text) + "）");
    assert(!/think/.test(text), "正文不残留标签碎片");
  }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/proxy-qoder-adapter-selftest.cjs`
Expected：`[FAIL] Error: 断言失败: 403 带 pricing 判成 402`

- [ ] **Step 3: 解构新 dep**

`qoderAdapter.cjs:123` 之后加：

```js
  // fork-port：纯函数分类/剥离工具（与 product 无关，整模块传入）
  const SU = deps.selfSignUtil || null;
```

- [ ] **Step 4: 信封错误兜底分支改用 classify**

把 `:413-415` 的

```js
            const st = code === "UNAUTHORIZED" || /token|unauthor/i.test(String(msg)) ? 401 : 502;
            emit({ type: "error", status: st, code: innerCode || code, message: String(msg) });
            return;
```

替换为：

```js
            // fork-port：上游只看 statusCode 字符串；这里的 403 有两种含义——带 pricing/额度特征的是
            // 套餐不足（402 → 换号），裸 403 才是登录态（401 → 刷新）。只看状态码会把「该充值」误报成「登录失效」。
            let st = code === "UNAUTHORIZED" || /token|unauthor/i.test(String(msg)) ? 401 : 502;
            let outMsg = String(msg);
            if (SU) {
              const cls = SU.classify({ httpStatus: SU.statusCodeOf(env) || st, text: `${code} ${msg}` });
              st = cls.status;
              outMsg = cls.message;
              if (st === 402) result.planLimit = true;
            }
            emit({ type: "error", status: st, code: innerCode || code, message: outMsg });
            return;
```

- [ ] **Step 5: delta 出口挂 TagSplitter，流末 flush**

`await pumpSse(resp, …)` 之前：

```js
      // fork-port：Qoder 把 reasoning 以 <thinking>/<think>/<reasoning>/<thought> 混在 content 下发，
      // 标签还会切在任意分片边界；不剥离会把思考链当正文计费并透给下游客户端。
      const splitter = SU ? new SU.TagSplitter() : null;
```

回调里 `emit({ type: "delta", delta: choice.delta });`（`:435`）替换为：

```js
              if (splitter && typeof choice.delta.content === "string" && choice.delta.content) {
                choice.delta.content = splitter.feed(choice.delta.content);
              }
              if (Object.keys(choice.delta).length) emit({ type: "delta", delta: choice.delta });
```

`pumpSse` 的 `try` 末尾（`catch` 之前）补：

```js
        if (splitter) {
          const tail = splitter.flush();
          if (tail) emit({ type: "delta", delta: { content: tail } }); // 不 flush 会丢末尾文字
        }
```

- [ ] **Step 6: 跑测试确认通过**

Run: `node tools/proxy-qoder-adapter-selftest.cjs`
Expected：`[10]` 段六条 `✓`，无 `[FAIL]`。

- [ ] **Step 7: 负控制（两条都要）**

(a) 注释掉 `choice.delta.content = splitter.feed(...)` 一行，`跨片 thinking 剥离干净` 必须变 `[FAIL]`——若仍绿，说明帧构造或断言是空跑。
(b) 把 Step 4 的 `if (SU)` 改成 `if (false)`，`403 带 pricing 判成 402` 必须变 `[FAIL]`。
两条确认后分别改回并重跑至绿。

- [ ] **Step 8: 提交**

```bash
git add electron/backend/proxy/qoderAdapter.cjs tools/proxy-qoder-adapter-selftest.cjs
git commit -m "feat(qoder): 信封 403 双语义与 429→402 分类、跨片 thinking 剥离接进上游 chat 出口"
```

---

## Task 6: `refreshToken` 双判据（打包串 vs 裸 dt-）

**Files:**
- Modify: `electron/backend/proxy/qoderAdapter.cjs:216`（`refreshWindowSec`）、`:667-673`（`refreshToken`）
- Test: `tools/proxy-qoder-adapter-selftest.cjs` 新增 `[11]`

**Interfaces:**
- Consumes: `deps.selfSign.refreshToken({account, secrets})`（Task 3 产出）
- Produces: 统一返回 `{ok, token, refreshToken, expiresAt, refreshTokenExpiresAt?}`；失败 `{ok:false, message, expired?}`。

- [ ] **Step 1: 写失败测试**

```js
  // ===== 11. 续期双判据：打包串走自签，裸 dt- 走 deviceToken =====
  console.log("\n[11] refreshToken 按凭据形态分流");
  {
    let authCalled = null;
    const selfSign = { chat: async () => ({}), fetchModelsRemote: async () => ({ ok: false }), refreshToken: async (a) => ({ ok: true, via: "self", token: a.secrets.token }) };
    const fakeAuth = {
      PRODUCTS: { qoder: { gateway: "https://gw" } },
      refreshDeviceToken: async (product, rt, machineId) => { authCalled = { product, rt, machineId }; return { ok: true, token: "T2", refreshToken: "rt2", expiresAt: 111, refreshTokenExpiresAt: 222 }; },
      readCatalogBlob: () => null, readRiskIdentity: () => null,
    };
    const ad = makeQoder("qoder", { ...deps, selfSign, auth: fakeAuth });
    const packed = await ad.refreshToken({ uid: "u", meta: { machineId: "m" } }, { refreshToken: "RT|u|m", token: "jwt.x.y" });
    assert(packed.via === "self", "3 段打包串走自签刷新");
    const pat = await ad.refreshToken({ uid: "u", meta: {} }, { refreshToken: "pat|PAT|RT|u|m", token: "jwt.x.y" });
    assert(pat.via === "self", "pat| 5 段走自签（PAT 换取在自签内部）");
    const bare = await ad.refreshToken({ uid: "u", meta: { machineId: "m" } }, { refreshToken: "drt-abc", token: "dt-abc" });
    assert(bare.ok === true && bare.token === "T2" && bare.refreshTokenExpiresAt === 222, "裸 dt- 走上游 deviceToken 刷新");
    assert(authCalled && authCalled.product === "qoder" && authCalled.machineId === "m", "deviceToken 刷新带 product 与 machineId");
    const none = await ad.refreshToken({ uid: "u", meta: {} }, {});
    assert(none.ok === false && /无 refreshToken/.test(String(none.message)), "无凭据如实报错");
    // 窗口必须 300：credits.cjs:44 仅在 util.jwtDecode(token).exp 存在时按窗口预刷。
    // dt- 无 exp ⇒ 对上游账号是 no-op；JWT（自签账号）用 86400 会把每轮额度刷新都变成一次 token 轮换。
    assert(ad.refreshWindowSec === 300, "refreshWindowSec 取 300（JWT 账号不得每轮都刷）");
    assert(!require("../electron/backend/proxy/util.cjs").jwtDecode("dt-abc123").exp, "dt- 裸串不解析出 exp（窗口分流的前提）");
  }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/proxy-qoder-adapter-selftest.cjs`
Expected：`[FAIL] Error: 断言失败: 3 段打包串走自签刷新`

- [ ] **Step 3: 实现分流**

`qoderAdapter.cjs:667-673` 的 `refreshToken` 替换为：

```js
    async refreshToken(account, secrets) {
      const packed = String((secrets && secrets.refreshToken) || "");
      // fork-port：fork 的 device 登录落的是打包串（3 段 `<rt>|<uid>|<machineId>`，或 `pat|` 开头 5 段），
      // PAT 换取与 center 域 refresh 只有自签路会做；上游的 deviceToken 刷新吃裸 dt-，喂打包串必失败。
      // 判据只看「含 |」——dt-/drt- 系列不含该字符，无需再分辨段数。
      if (deps.selfSign && packed.includes("|")) return deps.selfSign.refreshToken({ account, secrets });
      if (!secrets.refreshToken) return { ok: false, message: "无 refreshToken，请从本机重新导入" };
      const machineId = (account.meta && account.meta.machineId) || account.machineId || "";
      const r = await auth.refreshDeviceToken(product, secrets.refreshToken, machineId);
      if (!r.ok) return { ok: false, message: r.message || `刷新失败 HTTP ${r.status}` };
      return { ok: true, token: r.token, refreshToken: r.refreshToken, expiresAt: r.expiresAt, refreshTokenExpiresAt: r.refreshTokenExpiresAt };
    },
```

`:216` 改：

```js
    // fork-port：上游按 dt-（30 天、非 JWT、靠落库 expiresAt）取 86400；fork 的自签账号是 JWT，
    // credits.cjs 的临期预刷按此窗口比较 jwtDecode(token).exp，24h 会把每轮额度刷新变成 token 轮换。
    // dt- 无 exp ⇒ 该分支对上游账号是 no-op，故统一贴回 fork 的 300s。
    refreshWindowSec: 300,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node tools/proxy-qoder-adapter-selftest.cjs`
Expected：`[11]` 段八条 `✓`，无 `[FAIL]`。

- [ ] **Step 5: 提交**

```bash
git add electron/backend/proxy/qoderAdapter.cjs tools/proxy-qoder-adapter-selftest.cjs
git commit -m "feat(qoder): 续期按凭据形态分流——打包串走自签含 PAT 换取，裸 dt- 走 deviceToken，窗口贴回 300s"
```

---

## Task 7: `fetchModels` 远程兜底接线

**Files:**
- Modify: `electron/backend/proxy/qoderAdapter.cjs:238-292`
- Test: `tools/proxy-qoder-adapter-selftest.cjs` 新增 `[12]`

**Interfaces:**
- Consumes: `auth.readCatalogBlob(product, uid)`、签名会话 `modelCacheDecrypt`、`deps.selfSign.fetchModelsRemote({account, secrets})`
- Produces: `fetchModels` 在「本机无缓存 / 该 uid 没目录 / 签名器不可用 / 解密失败 / 目录为空」五种失败原因下**都尝试远程兜底**；两条都失败才回 `{ok:false, message}`，且 message 同时带两侧原因。

- [ ] **Step 1: 写失败测试**

```js
  // ===== 12. 目录双轨：本机 catalog 解密不可用 → 远程 model/list =====
  console.log("\n[12] fetchModels 远程兜底接线");
  {
    const remoteOk = { ok: true, models: [{ id: "dfmodel", name: "DeepSeek-Flash" }], scene: "assistant", modelCount: 1 };
    const selfSign = { chat: async () => ({}), refreshToken: async () => ({ ok: false }), fetchModelsRemote: async () => remoteOk };
    // ① 无 uid → 直接远程
    const adNoUid = makeQoder("qoder", { ...deps, selfSign, auth: { PRODUCTS: { qoder: {} }, readCatalogBlob: () => null } });
    assert((await adNoUid.fetchModels({ uid: "", meta: {} }, { token: "t" })).ok === true, "无 uid 时落远程而非直接失败");
    // ② 本机无 blob → 远程
    const adNoBlob = makeQoder("qoder", { ...deps, selfSign, auth: { PRODUCTS: { qoder: {} }, readCatalogBlob: () => null } });
    assert((await adNoBlob.fetchModels({ uid: "u1", meta: {} }, { token: "t" })).ok === true, "本机无目录缓存时落远程");
    // ③ 签名器不可用 → 远程
    const adNoSigner = makeQoder("qoder", {
      ...deps, selfSign,
      auth: { PRODUCTS: { qoder: {} }, readCatalogBlob: () => "blobtext" },
      signer: { createSession: async () => { throw Object.assign(new Error("客户端未装"), { status: 503, qoderSignerDown: true }); } },
    });
    assert((await adNoSigner.fetchModels({ uid: "u1", meta: {} }, { token: "t" })).ok === true, "签名器不可用时落远程");
    // ④ 无 selfSign 时保持上游原语义（不得凭空变成功）
    const adUp = makeQoder("qoder", { ...deps, auth: { PRODUCTS: { qoder: {} }, readCatalogBlob: () => null } });
    const rUp = await adUp.fetchModels({ uid: "u1", meta: {} }, { token: "t" });
    assert(rUp.ok === false && /本机无模型目录缓存/.test(String(rUp.message)), "未注入 selfSign 时仍是上游失败语义");
  }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node tools/proxy-qoder-adapter-selftest.cjs`
Expected：`[FAIL] Error: 断言失败: 无 uid 时落远程而非直接失败`

- [ ] **Step 3: 加统一兜底出口**

`qoderAdapter.cjs:238-247` 的函数开头改为：

```js
    async fetchModels(account, secrets) {
      const uid = (account && account.uid) || "";
      // fork-port：上游目录来自本机 catalog-v6 解密（需装客户端且该 uid 用过）；不满足时回落
      // 远程 model/list?Encode=1（qcosy 自签，零安装可用）。两条都失败才如实回错。
      // 用 bail() 而不是就地 return：否则四种失败原因要各写一遍兜底，必漏。
      const bail = (localMsg) => (deps.selfSign
        ? deps.selfSign.fetchModelsRemote({ account, secrets }).then((r) => (r && r.ok ? r : { ...r, message: `${localMsg}；远程兜底：${(r && r.message) || "失败"}` }))
        : Promise.resolve({ ok: false, message: localMsg }));
      if (!uid) return bail("缺少 uid，无法定位模型目录缓存");
      const blob = auth.readCatalogBlob(product, uid);
      if (!blob) return bail("本机无模型目录缓存（该客户端尚未登录使用过）");
```

再把体内三处早退改为 bail（**只换 return，不动其它逻辑**）：
`return { ok: false, message: \`签名器不可用：…\` }` → `return bail(\`签名器不可用：${String((e && e.message) || e).slice(0, 120)}\`)`
`return { ok: false, message: \`目录解密失败：…\` }` → `return bail(\`目录解密失败：${String((e && e.message) || e).slice(0, 120)}\`)`
`if (!models.length) return { ok: false, message: "目录为空（结构可能已变更）" }` → `if (!models.length) return bail("目录为空（结构可能已变更）")`

- [ ] **Step 4: 跑测试确认通过**

Run: `node tools/proxy-qoder-adapter-selftest.cjs`
Expected：`[12]` 段四条 `✓`，无 `[FAIL]`。

- [ ] **Step 5: 重跑 Task 1 的 [3d]，确认远程兜底没把展示名带回**

Run: `node tools/proxy-qoder-adapter-selftest.cjs`
Expected：`[3d]` 仍全 `✓`。

- [ ] **Step 6: 提交**

```bash
git add electron/backend/proxy/qoderAdapter.cjs tools/proxy-qoder-adapter-selftest.cjs
git commit -m "feat(qoder): 模型目录双轨——本机 catalog 解密不可用时回落远程 model/list，两侧原因一并上报"
```

---

## Task 8: 全量门禁收口与如实记录

**Files:**
- Modify: `C:\Users\15778\.qoder\projects\H--codex-project-AgentHub\memory\project-qoder-dual-implementation.md`

- [ ] **Step 1: 全量 dev 门禁（独占跑，不加截断管道）**

```bash
node scripts/dev-bundle-check.cjs --check
for t in scripts/dev-*.cjs; do node "$t" >/dev/null 2>&1 || echo "RED: $t"; done
```
Expected：只允许既有红 `dev-import-batch`。其它 `RED:` 一律按本计划回归处理。

- [ ] **Step 2: 必须用项目内 Electron Node 的三条**

```bash
D=$(mktemp -d)
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-smoke.cjs "$D"
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-zcode-selftest.cjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-wb-selftest.cjs
```
Expected：三条均无 `FAIL`。`proxy-smoke` **必须传 argv[2]**，不传会写真实数据。

- [ ] **Step 3: qoder 专项逐条跑并如实记录**

```bash
node tools/proxy-qoder-adapter-selftest.cjs
node scripts/dev-qoder-test.cjs
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-qoder-discovery-selftest.cjs
node tools/proxy-qoder-oauth-selftest.cjs
node tools/proxy-qoder-integration-selftest.cjs
```
Expected：前两条无 `[FAIL]`；第三条**仍是惰性绿**（判据被 `QODER_INTL_ENABLED=false` 短路）；后两条**仍红**（属登录面/真实风控身份，计划二）——这三项状态必须原样写进提交说明，不得合并成「qoder 全绿」。

- [ ] **Step 4: IPC 白名单对账**

按 `AGENTS.md §四` 的脚本跑一次。Expected：主进程侧 `missing: none`（本计划未加新 IPC 命令）；proxy 域报出的 missing/extra 属预期。

- [ ] **Step 5: 更新项目记忆**

把 `project-qoder-dual-implementation.md` 的 Interim/遗留段落改为：Task 1–7 已落地（catalog 口径 / 自签抽模块 / 上游主干注册 / 双路签名 / 分类与剥离 / 续期分流 / 目录双轨），保留计划二三项未闭合（`beginQoderOAuth` 去重与登录归一、`qoder_intl` 注册与 `QODER_INTL_ENABLED` 同批翻、UI 区服切换器改双渠道 + `ProxyAgentsView:299/303` 文案复核）。并补记本计划新发现的三条事实：`meta.machineId` 与 `meta.machine_id` 键名不一致导致 fork 登录账号只能走自签；`discovery.cjs:1131` 需要 `adapter.userInfo`；`makeSelfSign` 的地区来自渠道 id 后 `meta.mode` 不再是真相源。

- [ ] **Step 6: 提交**

```bash
git add -A electron/backend/proxy scripts tools docs/superpowers/plans
git commit -m "test(qoder): 归一移植全量门禁收口——记录惰性绿与未闭合项，避免把跳过当验证"
```

---

## 验证边界（必须对用户如实说明）

1. **真发上游请求没有被证明。** 号池 0 个 qoder 账号，全部联网断言都是 stub。自签路径 2026-09-20 实测可用过（cosy-version `1.1.38` / clienttype `5`），服务端**今天是否仍接受这一版签名未在本次验证**。闭合它需要真实 qoder 登录 ⇒ 用户操作。注意上游 wasm 路走的是 `0.4.3` / clienttype `10`，两套常量对应两个都被接受过的客户端版本，**不要「统一」它们**。
2. **`qoder` 渠道语义收窄为 CN**，`qoder_intl`（global 区）在计划二注册。
3. **fork 登录账号只能走自签回落**：其 `meta.machine_id`（蛇形）与上游读的 `meta.machineId`（`qoderAdapter.cjs:149/347`）不同名 ⇒ wasm 路拿不到 machineId。本计划不修（属登录归一），但它意味着「双路签名」在真实数据上只会走自签一侧。
4. `oauth` / `integration` 两个 selftest 的红**不由本计划消除**——引用它们时不得说成移植回归。
