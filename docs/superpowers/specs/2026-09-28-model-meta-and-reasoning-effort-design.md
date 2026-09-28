# 模型元数据统一层 + 思考强度贯通 — 设计文档

- 日期：2026-09-28
- 状态：待审
- 范围：反代网关（`electron/backend/proxy`）+ 模型目录页（`src/views/proxy`）
- 参考项目：`aimod-cc/agent2api`（Rust/Tauri，可编辑 tri-state 能力面板）、
  `linguo2625469/workbuddy2api-panel`（Go，per-realm 兜底档位表 + 思考链管线）

## 1. 目标与背景

把两个参考项目的长处合并、统一到本项目：

1. **模型能力可编辑**（移植 agent2api）：能力列从只读改为可手动覆盖，
   补 `video` 能力与输出上限，tri-state（未声明 / 开 / 关）。
2. **思考强度真正贯通**（移植 workbuddy2api-panel）：下游客户端设的思考强度，
   上游按模型能力遵循 / 降级；补上 WorkBuddy 等渠道的 per-realm 兜底档位表；
   补上 Anthropic `budget_tokens → reasoning_effort` 换算。

### 现状（已核实的证据）

- 能力列已存在但**只读**：`src/views/proxy/format.ts#capabilityTags()` 渲染 图/思/工 + 上下文；
  `ProxyModelsView.vue` 表格「能力」列。
- 目录条目已带 `capabilities:{images,reasoning,tools}` + `contextLength` + `maxOutputTokens`
  + `reasoning:{defaultEffort,supportedEfforts}`（`adapters.cjs:784-799`），
  但**只能从「拉取模型」填**，拉不到即空；无手动覆盖落盘位。
- 请求管线已接思考链：`util.normalizeReasoningEffort`（按 `supportedEfforts` 降级）、
  `util.injectThinking`（deepseek 强制 `thinking:{type:enabled}` + 补默认档）、
  `util.backfillReasoningContent`；Chat `reasoning_effort` 与 Codex/Responses `reasoning.effort`
  （`responses-in.cjs:57`）已遵循。
- 配置仅有 `modelOverrides` / `disabledModels` / `modelAliases`（`src/types/index.ts:281-289`），
  **无** per-model 能力覆盖 / 档位覆盖字段。
- `/v1/models` 把嵌套 `capabilities` 原样塞进 OpenAI 形状（`server.cjs:768`），
  **未扁平**成标准字段。
- Anthropic 客户端 `thinking:{budget_tokens}` 只透传进 extraBody（`anthropic-in.cjs:178`），
  **未换算**成 `reasoning_effort` —— 对 effort 档位型上游（WorkBuddy 等）不生效。
- WorkBuddy 的 `reasoning.supportedEfforts` **依赖上游目录自带**（`adapters.cjs:788-799`），
  **无** Repo2 那样的 per-realm 静态兜底表；上游不返 reasoning 时档位收敛无原料。

## 2. 架构：统一的 ModelMeta 层

每个模型（内置渠道 + 自定义提供商）解析出一份统一 `ModelMeta`：

```
ModelMeta {
  capabilities: { images, video, reasoning, tools }   // tri-state: true / false / undefined(未声明)
  maxInputTokens        // = contextLength
  maxOutputTokens
  reasoning: { defaultEffort: string, supportedEfforts: string[] }
  rate
}
```

### 2.1 三源分层合并（优先级低 → 高）

1. **静态 seed 表** —— 新增 `rules/effort_catalog.json`（context/maxOutput 与 effort 兜底），
   移植 Repo2 的 per-realm 表。拉不到上游也有兜底。
2. **上游目录拉取** —— 复用现有「拉取模型」通道，覆盖 seed（现状即走此处）。
3. **用户覆盖** —— 新增 `proxy.modelMeta`（见 2.2），稀疏 tri-state，最高优先。

**合并语义（硬边界）**：`supportedEfforts` / `defaultEffort` 采「取代」不「并集」——
最高优先级的**非空**源整体胜出。并集会造出模型不认的档位 → 上游 400。
`capabilities` 逐键合并：高优先层显式给值（true/false）即覆盖，`undefined`（未声明）不覆盖。

### 2.2 用户覆盖存储（地基决策：全局 map）

新增 `proxy.modelMeta: Record<canonicalModelId, Partial<ModelMeta>>`，按归并后的模型 id 存，
与现有 `disabledModels` / `modelAliases` / `modelOverrides` 同套路。`/v1/models` 本就是归并视图，
按 canonical id 键心智一致。稀疏写入：未覆盖的键不落盘，读取时回落拉取 / seed。

### 2.3 消费端

合并出的 `ModelMeta` 喂给两处：
- **`/v1/models` 出站**：扁平成标准字段（见 §4），同时保留嵌套 `capabilities`（现 UI 不破）。
- **请求管线**：`normalizeReasoningEffort` 用合并后 `supportedEfforts`；
  `injectThinking` 用合并后 `defaultEffort`；新增 Anthropic `budget_tokens → effort`（见 §3）。

## 3. 请求管线：思考强度贯通

### 3.1 Anthropic `budget_tokens → effort` 换算（补 P2）

在 `anthropic-in.cjs`（与 `responses-in.cjs:57` 同位置）按预算派生 `reasoning_effort`。
**加法语义**：保留原始 `thinking.budget_tokens` 给 Anthropic 原生上游，同时派生 `reasoning_effort`
给 effort 档位型上游；两类出站适配器各取所需。派生 effort 一样过 §3.3 收敛。

默认阈值（可调常量，对齐现有 `EFFORT_RANK`）：

| budget_tokens | → effort |
|---|---|
| type=disabled / 0 | off（删除档位） |
| 1 – 4096 | low |
| 4097 – 16384 | medium |
| 16385 – 32768 | high |
| > 32768 | max |

非法 / 负 `budget_tokens` → 当 enabled 无档（补默认档），不派生。

### 3.2 各渠道 effort 兜底表（补 C3，移植 Repo2）

新建 `rules/effort_catalog.json`（同 `catalog.json` / `headers.json` 目录，热加载），作为 §2.1 第 1 层 seed：

```json
{
  "workbuddy":    { "deepseek-v4-pro": {"efforts":["low","high","xhigh"],"default":"high"}, "glm-5.3": { "...": "..." } },
  "workbuddy_ai": { "deepseek-v4.1-flash": {"efforts":["high"]}, "gpt-6-astra": {"efforts":["low","medium","high","xhigh","max"]} },
  "qoder":        { "...收编现有内联 QODER_FALLBACK...": "..." }
}
```

同时收编 Qoder 现写死在 `adapters.cjs` 的内联兜底，统一进此文件。具体条目在实现时以
Repo2 表 + 本项目实测为准（seed 值随时间可能过期，落盘并可被上游拉取覆盖）。

### 3.3 收敛口径

- 降级算法沿用 `util.normalizeReasoningEffort`（不改）：请求档不在支持集 → 降到 ≤ 请求档的最高支持档；
  支持档全高于请求 → 取最低档。仅把喂入的 `supportedEfforts` 换成合并后值。
- 档位词表在 `EFFORT_RANK {off,minimal,low,medium,high,xhigh,max}` 基础上，把 Repo1 的 `none` 收为 `off` 别名。
- 请求 effort 越界 → 一律降级，**绝不 400 透传**；合并集为空 → 不发档位字段。

## 4. UI + 下游发现

### 4.1 能力 / 档位编辑器（行内抽屉，合并 U1/U2/U3）

点模型行（或能力单元格）弹出该模型编辑面板，统一编辑三块：
- **能力（tri-state）**：图 / 视频 / 思考 / 工具，每项三态 未声明 / 开 / 关；未声明 = 沿用拉取 / seed。
- **推理档位**：从 `EFFORT_LEVELS` 多选「允许档位」（supportedEfforts）+ 「默认档」下拉（defaultEffort）。
- **输出上限**：`maxOutputTokens` 数字输入；`maxInputTokens` / contextLength 只读展示。

面板标来源（seed / 拉取 / 用户覆盖 三层生效值 + 哪些键被覆盖），给「清除覆盖」回落——
对应 §2.2 `proxy.modelMeta` 的稀疏写入 / 删除。能力列只读标签补 视频 与 输出上限缩写。

### 4.2 `/v1/models` 扁平化（补 P3）

OpenAI 形状条目保留嵌套 `capabilities` 的同时**追加**标准扁平字段：
`supports_images` / `supports_video` / `supports_reasoning` / `supports_tool_call` /
`max_input_tokens` / `max_output_tokens` / `input_modalities`（`["text"]` + 有图加 `"image"` + 有视频加 `"video"`）。
Anthropic 形状 `/v1/models` 维持精简（Claude Code 只读 id / display_name，不动）。

## 5. 健壮性 / 迁移 / 门禁

### 5.1 兜底
- 档位越界 → 降级，绝不 400；合并集空 → 不发字段。
- `budget` 非法 → 当 enabled 无档；`type:disabled` → 删档。
- `effort_catalog.json` / `modelMeta` 解析失败 → 按空表（不崩、退回拉取值）；未知渠道 / 模型 → 透传不改。
- `modelMeta` 未知键忽略；tri-state 未声明 = 不写入，读取回落。

### 5.2 迁移兼容
- 新增 `proxy.modelMeta`（默认 `{}`）、`rules/effort_catalog.json`（随包分发）。旧配置零改造，缺字段即空 = 现状行为。
- `/v1/models` 追加扁平字段，不删不改嵌套 `capabilities`；现有 UI 与老客户端不受影响。
- 若新增 `proxy_*` IPC，走 `dev-gateway-forward-parity-test.cjs` 对账（AGENTS.md 四节）；
  预计复用现有 config 保存通道，大概率不新增 IPC。

### 5.3 测试门禁（对齐 AGENTS.md 15 项）
- 新增 `scripts/dev-effort-catalog-test.cjs`：seed 加载 + 三源取代式合并 + 越界降级
  + budget→effort 阈值 + `none`→`off` 别名 + capabilities 逐键合并。
- 复用：`npm run build`（vue-tsc）、`dev-bundle-check`、`tools/proxy-smoke.cjs`（补管线断言）。
- 收尾逐条取 EXIT 全 15 项门禁作为验收。

## 6. 待实现时确认的开放项
- WorkBuddy 上游 `/v1/models` 是否真返 `reasoning.supportedEfforts`：决定 seed 表是「兜底」还是「唯一来源」。
  实现首步抓一次真实返回核实（未核实，不阻塞设计——两种情况本设计都覆盖）。
- budget→effort 阈值具体数值：以上为默认，可在实现 / 联调时按客户端实际预算分布微调。
