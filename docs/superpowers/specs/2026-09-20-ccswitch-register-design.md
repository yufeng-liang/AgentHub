# 设计：把 AgentHub 网关注册进 CC Switch（上游格式 = OpenAI Chat Completions）

日期：2026-09-20
状态：待评审

## 背景与目标

CC Switch（farion1231/cc-switch）管理 Claude Code / Codex 的应用配置并在 provider 之间切换。参考 [smart-open/TraeWorkAssistant] 的 cc-switch 注册实现，为 AgentHub 增加「生态接入」：把 AgentHub 反代网关（`http://127.0.0.1:{port}/v1`，仅 OpenAI Chat Completions 协议）**注册（upsert）为 CC Switch 的 provider 条目**，由 CC Switch 承担协议翻译：

- Claude Code 条目：`apiFormat = "openai_chat"`（CC Switch 判读字段，源码 `provider.meta?.apiFormat === "openai_chat"`），CC Switch 将 Anthropic Messages 翻译成 Chat Completions 打给 AgentHub；
- Codex 条目：`model_provider = "custom"` + 用户指定的 config.toml（`wire_api = "responses"`、`requires_openai_auth = true`、`base_url = http://127.0.0.1:9527/v1`）。

方向只做「注册进 CC Switch」，不做「从 CC Switch 读入」，也不做切换器。

## 方案选择

- **方案 A（采用）**：新建独立后端模块 `electron/backend/proxy/ccswitch.cjs`，复用 store.cjs 的 SQLite 驱动加载方式（node:sqlite 优先、better-sqlite3 回退），只读写 CC Switch 库；IPC 两条、前端新增「生态接入」顶栏页。
- 方案 B：并入 store.cjs —— 破坏其"只管 AgentHub stats 库"的单职，不采用。
- 方案 C：不写库、让用户手动粘贴 —— UX 差，不采用。

## 架构

```
前端 ProxyCcSwitchView.vue（反代网关顶栏新增「生态接入」页）
  → src/api/ipc.ts（proxyCcSwitchStatus / proxyCcSwitchRegister）
  → src/api/mock.ts（dev:web 预览 mock）
  → IPC: proxy_ccswitch_status / proxy_ccswitch_register
  → electron/backend/proxy/index.cjs register()
  → electron/backend/proxy/ccswitch.cjs（新模块）
       └─ status / register（读 ~/.cc-switch/cc-switch.db 的 providers 表）
```

## 后端模块：ccswitch.cjs

### location / DB

- CC Switch 库：`~/.cc-switch/cc-switch.db`（userHome 下，`process.env.CCSWITCH_CONFIG_DIR` 不存在则默认用户主目录）；表：`providers`。
- 复用 store.cjs 顶部的 SQLite 驱动加载代码（node:sqlite / better-sqlite3），打开时设 `busy_timeout`（CC Switch 可能在运行）。

### status()

只读流程：

1. 库文件不存在 → 返回 `{ installed: false }`（前端引导安装 CC Switch）。
2. 只读打开，查 `providers` 表中固定 id 是否存在。
3. 返回：

```ts
{
  installed: boolean;
  dbPath: string;
  entries: { appType: "claude" | "codex"; registered: boolean; name?: string }[];
}
```

### register({ appType, apiKey, model, port })

红线（对齐参考实现 + 现行 CC Switch schema 校验）：

1. **写前整库备份**：`~/.cc-switch/backups/cc-switch.db.bak_agenthub_<ts>`（拷 .db + -wal + -shm，existsSync 判断后逐个 copyFileSync）；备份失败不继续。
2. **表结构自检**（对当前官方 schema，见 `database/schema.rs`）：`providers` 表必须存在，且必需列 `id / app_type / name / settings_config / meta` 齐备；否则报「CC Switch 版本不兼容」。
3. **固定 id upsert**：
   - id：`agenthub-gateway-claude` / `agenthub-gateway-codex`；
   - 先 `UPDATE providers SET name = ?2, settings_config = ?3, notes = ?4, meta = ?5 WHERE id = ?1`，affectedRows === 0 则 `INSERT`；
   - INSERT 只列官方 schema 的 14 列（当前版本无 `cost_multiplier` 列，参考实现含该列会在现行版上报错——**不照抄**）：
     `id, app_type, name, settings_config, website_url, category, created_at, sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue`
     其中 `category='custom'`、`created_at=毫秒时间戳`、`sort_index=MAX+1`（首条 1）、`is_current='0'`、`in_failover_queue='0'`、网站 `https://github.com/HUIdada1/AgentHub`；
   - 只触碰这两个固定 id，绝不修改其它 provider。

### 条目内容

**Claude**（`app_type = "claude"`；icon = anthropic）：**嵌套 env 结构**（现行 CC Switch 读取 `settings_config.env.*`，见 `stream_check.rs` 的 `/env/ANTHROPIC_BASE_URL` 与 `extract_env_vars_from_config`；参考实现的扁平结构是旧版兼容，不照抄）：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9527",
    "ANTHROPIC_AUTH_TOKEN": "sk-…",
    "ANTHROPIC_API_KEY": "sk-…",
    "ANTHROPIC_MODEL": "<model>",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "<model>",
    "ANTHROPIC_DEFAULT_SONNET_MODEL_NAME": "<model>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "<model>",
    "ANTHROPIC_DEFAULT_OPUS_MODEL_NAME": "<model>",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "<model>",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME": "<model>",
    "CLAUDE_CODE_SUBAGENT_MODEL": "<model>"
  }
}
```

`meta = { "apiFormat": "openai_chat", "commonConfigEnabled": false }`（`apiFormat: "openai_chat"` = 上游格式 chat，CC Switch 负责翻译）。

**Codex**（`app_type = "codex"`；icon = openai）：按用户指定：

```json
{
  "auth": { "OPENAI_API_KEY": "sk-…" },
  "config": "model_provider = \"custom\"\nmodel = \"<model>\"\nmodel_reasoning_effort = \"high\"\ndisable_response_storage = true\n\n[model_providers.custom]\nname = \"AgentHub\"\nwire_api = \"responses\"\nrequires_openai_auth = true\nbase_url = \"http://127.0.0.1:9527/v1\"\n"
}
```

`meta = { "commonConfigEnabled": false }`。

### 返回值

`{ ok: true, action: "inserted" | "updated", backupPath, dbPath, appType }`；失败 `{ ok: false, message }`。

### 关键默认值

- **端口**：`register` 的 port 参数缺省取 `config.proxy.port`（默认 9527），与网关实际端口一致；条目 base URL 由该 port 拼出 `http://127.0.0.1:{port}`（claude 不带 /v1、codex 带 /v1，按各自协议约定）。
- **模型**：前端「默认模型」输入，存 `config.proxy.ccSwitchModel`，缺省取 `config.proxy.fallbackModel`。
- **API Key**：前端下拉选已有 Key（复用 `proxyKeysList()`）；无 Key 时引导到 API Keys 页生成。

## IPC 接入

- 在 `electron/backend/proxy/index.cjs` 的 `register(ipcMain)` 挂两条（沿用现有 `handle()` 包装）：`proxy_ccswitch_status` / `proxy_ccswitch_register`。模块顶部 `require("./ccswitch.cjs")`。

## 前端

- `src/types/index.ts`：
  - `CcSwitchStatus`、`CcSwitchRegisterResult` 类型；
  - `ProxyConfig` 增加 `ccSwitchModel: string`（生态接入页的默认模型，持久化随整体配置）。
- `electron/backend/config.cjs`：`defaultConfig().proxy` 增加 `ccSwitchModel: ""`。
- `src/api/ipc.ts`：`proxyCcSwitchStatus()` / `proxyCcSwitchRegister({ appType, apiKey, model, port })`。
- `src/api/mock.ts`：两条 mock（installed=true、已注册/未注册 示例）。
- **页面导航**：`src/types/index.ts` 的 `MODULES` 中 proxy 模块 `pages` 新增 `{ id: "ccswitch", name: "生态接入" }` —— 顶栏（PageTabs 遍历 `app.pagesOf`）自动出现该 tab，与 总览 / API Keys / 号池 / 模型目录 / 用量统计 / 号池同步 平级。
- **新页面** `src/views/proxy/ProxyCcSwitchView.vue`，在 `src/App.vue` proxy 区块挂载（`v-if/v-show` 懒挂载，同其它页）：
  - 内容：CC Switch 安装状态徽标（未安装 → 提示去装 CC Switch）；Claude Code / Codex 两个注册按钮（busy 态）；API Key 下拉（复用 `proxyKeysList()`，无 Key 时引导去 API Keys 页生成）；**默认模型输入**（存 `app.config.proxy.ccSwitchModel`，缺省取 `fallbackModel`，注册时传入 register 的 model 参数，即 CC Switch Codex 配置的 model 字段）；
  - 成功文案：注册结果 + 备份路径 + 「重启 CC Switch 生效」。

## 安全与错误处理

- Key 只写入 CC Switch 自己库的 settings_config，不进 AgentHub 日志 / 前端不回显（注册后不返回 Key）；
- 只读/写死固定 id，写入前备份 + 表结构自检；
- 错误分类返回 message：库不存在 / 版本不兼容 / 备份失败 / 写入失败。

## 验证

- 临时 `mktemp` 目录放假 `cc-switch.db`（建 providers 表），用 node 跑 status → register(claude) → register(codex) → 重复 register（验 upsert 不重复）→ 检查备份文件与 settings_config 内容；
- `dev:web` 用 mock 走一遍前端交互；
- 真机可选：本机装 CC Switch 后实测注册 + 重启生效。