# 实现计划：把 AgentHub 网关注册进 CC Switch（「生态接入」页）

日期：2026-09-20
状态：待评审
设计文档：`docs/superpowers/specs/2026-09-20-ccswitch-register-design.md`

## 目的与范围

新增后端模块 `electron/backend/proxy/ccswitch.cjs`（status / register：备份 → 表自检 → 固定 id upsert），注册两条 IPC（`proxy_ccswitch_status` / `proxy_ccswitch_register`），并在反代网关模块增加顶栏「生态接入」页 `src/views/proxy/ProxyCcSwitchView.vue`，提供 CC Switch 安装状态、Claude Code / Codex 两个注册按钮、API Key 下拉、默认模型输入（持久化 `config.proxy.ccSwitchModel`）。上游格式 = OpenAI Chat Completions（Claude 条目 `meta.apiFormat="openai_chat"`，翻译由 CC Switch 承担）。

不做：从 CC Switch 读入、切换器、修改 CC Switch 其它 provider、自动创建 Key。

## 步骤总览

1. 后端：新建 `ccswitch.cjs`（驱动加载 + status + register + 备份 + upsert）
2. 后端：`config.cjs` proxy 默认值加 `ccSwitchModel: ""`；`proxy/index.cjs` 挂载两条 IPC
3. 前端：`types/index.ts`（`CcSwitchStatus` / `CcSwitchRegisterResult` / `ProxyConfig.ccSwitchModel` / MODULES 加页）
4. 前端：`ipc.ts` + `mock.ts`
5. 前端：新页面 `ProxyCcSwitchView.vue` + `App.vue` 挂载
6. 验证：假 DB 脚本测 register 幂等/备份/内容；`dev:web` mock 走交互；构建编译检查

## 步骤明细

### 1. electron/backend/proxy/ccswitch.cjs（新建）

**What/Why**：只读写 CC Switch 库（`~/.cc-switch/cc-switch.db` 的 `providers` 表），不碰 AgentHub 自己的库；驱动加载方式照抄 store.cjs 第 13–25 行的 try 链（node:sqlite → better-sqlite3 → null）。

**实现**：

- `dbPath()`：`path.join(os.homedir(), ".cc-switch", "cc-switch.db")`；`openDb(readonly)`：`new Database(dbPath)` + `busy_timeout=3000`（CC Switch 可能开着 WAL），只读时 `readOnly: true`（仅 node:sqlite 支持则在打开后 `exec("PRAGMA query_only=ON")`，better-sqlite3 用 `new Database(path, {readonly:true})`——按驱动分支处理，尽力而为）。
- `status()`：
  - `installed = fs.existsSync(dbPath)`，未安装直接返回；
  - 只读查 `SELECT id, name, app_type FROM providers WHERE id IN ('agenthub-gateway-claude', 'agenthub-gateway-codex')` 两个固定 id：
    `agenthub-gateway-claude`、`agenthub-gateway-codex`；
  - 返回 `{ installed, dbPath, entries: [{ appType, registered, name? }] }`。
- `register({ appType, apiKey, model, port })`：
  1. `port ?? config.get().proxy.port ?? 9527`；`base = "http://127.0.0.1:" + port`；
  2. 校验 appType ∈ {claude, codex}、apiKey 非空、model 非空，否则 `fail`；
  3. 库不存在 → fail「未检测到 CC Switch，请先安装并启动一次」；
  4. **备份**：`backupsDir = ~/.cc-switch/backups`（mkdir -p），目标 `cc-switch.db.bak_agenthub_<YYYYMMDDHHmmss>`；逐个 copyFileSync：`.db`、`.db-wal`（存在则拷）、`.db-shm`（存在则拷）；任一步 throw → fail（不写库）；`backupPath` 存下供返回；
  5. **表自检**：`SELECT name FROM sqlite_master WHERE type='table' AND name='providers'` + 列检查（`PRAGMA table_info(providers)` 含 `id, app_type, name, settings_config, meta`），不符 → fail「CC Switch 数据库版本不兼容」；
  6. **构造行数据**（见下）；`UPDATE … WHERE id=?` 的 `changes === 0` 则 INSERT；`sort_index = COALESCE((SELECT MAX(sort_index)+1 FROM providers WHERE app_type=? AND id NOT IN (两个固定id)), 1)`——插到同 app 分组末尾；`created_at = Date.now()`；其余列按设计文档：`category='custom'`、`website_url='https://github.com/HUIdada1/AgentHub'`、`is_current='0'`、`in_failover_queue='0'`、icon/icon_color：claude→`anthropic`/`#D4915D`，codex→`openai`/`#10A37F`、`notes`=「由 AgentHub 生态接入页生成（<时间>）」；
  7. 返回 `{ ok:true, action:'inserted'|'updated', backupPath, dbPath, appType }`。

**条目 JSON（settings_config 字符串化存储）**：

- claude（嵌套 env，key 都插 model）：

```json
{ "env": {
  "ANTHROPIC_BASE_URL": "http://127.0.0.1:<port>",
  "ANTHROPIC_AUTH_TOKEN": "<apiKey>",
  "ANTHROPIC_API_KEY": "<apiKey>",
  "ANTHROPIC_MODEL": "<model>",
  "ANTHROPIC_DEFAULT_SONNET_MODEL": "<model>",
  "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "<model>",
  "ANTHROPIC_DEFAULT_OPUS_MODEL": "<model>",
  "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "<model>",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL": "<model>",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "<model>",
  "CLAUDE_CODE_SUBAGENT_MODEL": "<model>" } }
```
  `meta = {"apiFormat":"openai_chat","commonConfigEnabled":false}`

- codex（toml 用模板字符串拼，`\n` 换行；最终 settings_config 是 JSON.stringify 后的字符串）：

```json
{ "auth": { "OPENAI_API_KEY": "<apiKey>" },
  "config": "model_provider = \"custom\"\nmodel = \"<model>\"\nmodel_reasoning_effort = \"high\"\ndisable_response_storage = true\n\n[model_providers.custom]\nname = \"AgentHub\"\nwire_api = \"responses\"\nrequires_openai_auth = true\nbase_url = \"http://127.0.0.1:<port>/v1\"\n" }
```
  `meta = {"commonConfigEnabled":false}`

**导出**：`module.exports = { status, register }`。

**测试方式**：见步骤 6 假 DB 脚本。

### 2. 后端接线

- `electron/backend/config.cjs`（proxy 段，第 135–154 行附近）：加 `ccSwitchModel: "", // 生态接入默认模型（CC Switch 注册用）`。
- `electron/backend/proxy/index.cjs`：
  - 顶部 require 区（第 4–20 行）加 `const ccswitch = require("./ccswitch.cjs");`；
  - 在 `register(ipcMain)` 任意空位（如 `proxy_models_sync` 之后）追加：

```js
ipcMain.handle("proxy_ccswitch_status", handle(() => ccswitch.status()));
ipcMain.handle("proxy_ccswitch_register", handle(({ appType, apiKey, model, port }) =>
  ccswitch.register({ appType, apiKey, model, port })));
```
  - `handle`/`ok`/`fail` 已有（第 185–199 行），直接复用。

### 3. src/types/index.ts

- `ProxyConfig` 接口（第 252 行起）加 `/** 生态接入默认模型（CC Switch 注册用） */ ccSwitchModel: string;`；
- 新增：

```ts
export interface CcSwitchEntry { appType: "claude" | "codex"; registered: boolean; name?: string; }
export interface CcSwitchStatus { installed: boolean; dbPath?: string; entries?: CcSwitchEntry[]; }
export interface CcSwitchRegisterResult { ok?: boolean; action?: "inserted" | "updated"; backupPath?: string; dbPath?: string; appType?: "claude" | "codex"; message?: string; }
```

- `MODULES` proxy pages（第 527–533 行）在 `poolsync` 之后加 `{ id: "ccswitch", name: "生态接入" }`。

### 4. src/api/ipc.ts + src/api/mock.ts

- `ipc.ts`（`call` 包装与 proxy 函数同区 / 第 186 行样式）：

```ts
export const proxyCcSwitchStatus = () => call<CcSwitchStatus>("proxy_ccswitch_status");
export const proxyCcSwitchRegister = (args: { appType: "claude" | "codex"; apiKey: string; model: string; port?: number }) =>
  call<CcSwitchRegisterResult>("proxy_ccswitch_register", args);
```

- `mock.ts` 的 switch（第 404 行一带）加两个 case：status 返回 `{ ok:true, installed:true, dbPath:"~/.cc-switch/cc-switch.db", entries:[{appType:"claude",registered:false},{appType:"codex",registered:false}] }`；register 返回 `{ ok:true, action:"inserted", backupPath:"~/.cc-switch/backups/cc-switch.db.bak_agenthub_demo", dbPath:"~/.cc-switch/cc-switch.db", appType: args?.appType }`。

### 5. src/views/proxy/ProxyCcSwitchView.vue（新建）+ App.vue

- 页面结构照 `ProxyPoolSyncView.vue`：`<section class="page">` → `.page-head`（`.page-title`「生态接入」+ `.page-sub` 说明 + `.page-actions`）→ `.page-body`；
- 卡片一「注册到 CC Switch」：状态徽标（`.tag-ok`/`.tag-warn`，未安装时 `.tag-warn`+引导文案）、API Key 下拉（`proxyKeysList()` 返回 `ProxyKeyRow[]`，取 id/name/mask 显示，无 Key 显示空态「去 API Keys 页生成」）、默认模型输入（`app.config.proxy.ccSwitchModel || fallbackModel`，失焦/保存时写回并 `app.save()`）、端口展示（`config.proxy.port`，不用改）；两个注册按钮（`.btn.btn-primary`，busy 态 `disabled`），成功后在卡片显示 `action==='inserted'?'新注册':'已更新'` + 备份路径（`.mono`）+ 「重启 CC Switch 使配置生效」；
- 卡片二「说明」：上游格式 chat、CC Switch 负责协议翻译、每次注册自动备份数据库（路径同上）——用 `.set-desc` 纯文案；
- mounted 拉 `proxyCcSwitchStatus()` 刷新状态；组件样式只用全局变量（`var(--text-*)`、`var(--card-*)`/`var(--bg-*)`、`var(--line)`、`var(--r-*)`、`var(--accent-*)`），不新增色值。
- `App.vue`：import `ProxyCcSwitchView`（第 37 行一带），挂载行（第 576 行后）：

```html
<ProxyCcSwitchView v-if="seen('proxy', 'ccswitch')" v-show="on('proxy', 'ccswitch')" :class="{ 'page-anim': on('proxy', 'ccswitch') }" />
```

### 6. 验证

- **假库脚本** `scripts/dev-ccswitch-test.cjs`（临时，验证后删除或留 tools/）：
  - `mktemp` 目录造 `cc-switch.db`（`CREATE TABLE providers (14 列与官方 schema 一致)`），临时把 `os.homedir` 指向它（脚本内直接对内层函数，或 ccswitch.cjs 支持 `CCSWITCH_DB_PATH` 环境变量覆盖——采用后者，一行 `process.env.CCSWITCH_DB_PATH || default`，便于测试也便于用户自定义）；
  - 跑：status（未注册）→ register(claude) → register(codex) → 重复 register(claude) 验 `updated` 且不重复 → 检查 backups/ 下有新备份文件 → 检查行内容（env 嵌套、meta.apiFormat、codex toml 含 model/wire_api/base_url）。
- **前端**：`npm run dev:web` 打开反代网关 → 顶部出现「生态接入」→ mock 数据下按钮注册成功流程、无 Key 空态、模型默认值回显。
- **编译**：`npm run build`（或 vite build）过一遍类型检查。

## 范围外（不做）

- 自动创建 Key、CC Switch 切换器、从 CC Switch 反向读配置、删除 CC Switch 条目、多语言文案体系外新增文案处理。

## 完成标准

1. `status`/`register` 假库脚本全绿（幂等、备份、schema 兼容）；
2. dev:web 生态接入页交互完整、风格与号池同步页一致、双主题正常；
3. `npm run build` 类型检查通过。