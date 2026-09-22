# 设计：网关多协议入站 + 自定义模型提供商

日期：2026-09-22
状态：五片已全部实现并过闸，真机验收未做（见 §十）
范围：`feat/gateway-custom-providers`，从 `main@0c09f03` 起，与在制品 `perf/gateway-lite-mode-phase2` 不同树

---

## 一、背景与目标

网关此前有两处硬限制，缺一不可解：

1. **只能对接写死的 4 个生态渠道**（Trae SOLO CN / WorkBuddy 中国区 / WorkBuddy AI / 商汤小浣熊）。用户想把第三方中转站或自建 OpenAI 兼容端点接进来，此前零支持（全仓 grep「自定义提供商 / 中转站 / relay」无命中）。
2. **对外只有一个入站端点** `POST /v1/chat/completions`。Anthropic 与 Responses 的协议翻译外包给 CC Switch——`proxy/ccswitch.cjs` 的文件头注释当时就把这条约束写死在案。

目标：**编程客户端只填一个网关地址，就能调用任意提供商 / 任意模型**。

参考项目 TraeWorkAssistant 的建模被否：它「一条记录 = 一个模型」，一个中转站的 20 个模型要存 20 份 Key。业界（one-api 的 `Channel`、claude-code-router 的 `GatewayProviderConfig`、litellm 的 `model_list`）一致收敛到 **provider → models[]** 两层。协议侧同理：不是 N×N 互转，而是**内部规范形 + 每协议一个 driver** 的 hub-and-spoke。

---

## 二、决策

| 项 | 决定 | 备选与被否原因 |
|---|---|---|
| 入站协议面 | `/v1/chat/completions` + `/v1/messages` + `/v1/responses` 三者全做 | 只做 Messages：Codex 走不通（`wire_api="chat"` 已从 Codex 删除，写它硬报错）。只做 chat + 依赖 CC Switch：正是本次要拆掉的那一层 |
| 上游协议形态 | 自定义提供商支持 OpenAI Chat 与 Anthropic Messages | Responses 上游本期不做（Claude 中转生态没有这个需求，且它带会话存储语义） |
| Key 建模 | 复用现有号池：提供商 = `agents` 扩列，Key = `accounts` 行 | 新表 `providers`：租约 / 冷却 / 模型级负缓存 / 并发闸 / 用量统计 / 号池页全都要重做一遍 |
| CC Switch | 只改文案 + 埋两个默认关的开关，不翻转注册链路 | 直接翻默认：改动落在用户正在用的注册链路上，而提供商选择本来就只体现在模型名字符串里，不需要 CC Switch 配合即可用 |
| 工作树 | 从 `main` 建新支线 | 与二期同树：二期恰好重排了 `store.cjs:open()` 与 `index.cjs:register()`，冲突面叠加 |

---

## 三、架构

```
入站                        内部规范形                     出站
/v1/chat/completions  ─┐                        ┌─ OpenAI Chat emitter      → 客户端
/v1/messages          ─┼→ protocols/*-in.cjs →  │  Anthropic emitter          (Claude Code)
/v1/responses         ─┘   归一成 OpenAI body   └─ Responses emitter       → dispatch.cjs
                                                              (鉴权/配额/别名/回退链/号池/换号)
                                                                       ↓ adapter.chat()
                                                        内置 4 适配器（零改动，仍吃 OpenAI body）
                                                        通用 openai_compat 适配器
                                                        通用 anthropic_messages 上游适配器
```

**两条不可动摇的选择：**

1. **内部规范形 = OpenAI Chat 请求体 + `emit` 事件词汇（`delta` / `usage` / `finish` / `error`），词汇表不扩。** 4 个内置适配器共 1700+ 行逆向代码由 `scripts/dev-sse-delta-test.cjs` 守着它的输出形状，扩词汇等于适配器全改。Anthropic 的 `thinking` / `tool_use` 分块、Responses 的 `reasoning` item 全部由 **emitter 侧从现有 delta 推导边界**：`reasoning_content` → 开思考块；首个非空 `content` → 关思考、开正文块；`tool_calls[i].id`/`.function.name` 首现 → 开工具块，`arguments` 增量喂进去；finish → 关所有块。表达不出的只有 thinking/text 交替（OpenAI 形状先天丢失），只影响展示顺序。
2. **提供商不建新表。** 「复用号池」这个决策的全部红利都在这里：租约、冷却、模型级负缓存、并发闸、用量统计、号池页零改动生效。

全分支 32 个文件、+5423/−236（14 新增 / 18 修改，其余为闸的基线 fixture 与本文档）。后端集中在 `electron/backend/proxy/`：`provider.cjs`（校验 / 塑形 / 探测）、`adapters.cjs`（静态表 + 动态实例缓存）、`store.cjs`（`agents` 扩列 + `channelList()`）、`credits.cjs`（无 `queryCredits` 的渠道跳过）、`protocols/{openai,anthropic}-*`、`protocols/{responses-in,responses-out,anthropic-up}`、`server.cjs`（三个协议面 + 路由）、`ccswitch.cjs`（原生开关）。

---

## 四、`accounts` 表承载 API Key 的六条约束

提供商的 Key 落在 `accounts`，必须绕开号池里四条「为余额型账号设计」的判据。每条都对应一段真实会被触发的代码：

| 字段 | 存什么 | 存别的会怎样 |
|---|---|---|
| `token_enc` | API Key，走 `config.encryptSecret` | `store.tokenUsable()` 会**真解一次**才算可用；`pickAccount` 只认 `hasToken` |
| `refresh_enc` | `''` 空串 | `secretbox.encrypt` 对空串早退返回 `''`，不产生空信封，因此不污染 `/readyz` 的解密失败判据 |
| `credits` + `credits_at` | **都保持 0，永不写 `credits_at`** | `pool.cjs:45`：`creditsAt > 0 && credits === 0` 会把好号直接打进「余额不足，已自动切换」冷却到次日 04:00 |
| `expires_at` | 0 | `pool.cjs:52`：`> 0 && <= now` 判「余额已到期」并置 exhausted |
| `pool_strategy` | **`round_robin`** | `expire_first` 按 `expiresAt` 排序，全 0 时恒打第一把 Key，轮转形同不存在 |
| `source` | `'paste'` | 号池同步 / 本机扫描一律不认领 |

两条容易漏的：

- **适配器刻意不定义 `queryCredits`**，`credits.cjs` 靠它缺席来跳过。原代码的 `.catch` 挂在**返回值**上而不是函数调用上，缺方法会同步抛 TypeError，把用户的第三方 Key 打向不存在的余额接口。
- **打包态无解密能力时 `secretbox.encrypt` 抛错**（拒写明文）。前端必须在 `proxy_vault_status.encrypted === false` 时禁用「添加 Key」并说明原因——今天那只是一个状态灯。

---

## 五、命名与路由：三条防遮蔽规则

TraeWorkAssistant 的实测缺陷是「自定义条目命中内置目录即静默遮蔽」：用户手滑填个 `claude-sonnet-5`，内置池就被悄悄顶掉。这里明确不学：

1. **slug 校验** `^[a-z0-9][a-z0-9_-]{1,31}$`，禁含 `/`；黑名单 = 4 个内置 id + `auto`/`all`/`v1`/`models`/`healthz`/`status`/`readyz`。
2. **创建时冲突即拒**：`mergedModels()` 已有 id 以 `slug + "/"` 开头 → 400，文案说明撞了内置目录。
3. **解析顺序**：`model` 含 `/` 且首段是**启用中的** slug → 前缀路由（剥前缀作上游模型名）；否则走原 `modelOwners()` 精确匹配 → **裸名永远内置优先**。自定义模型在 `/v1/models` 里只以 `slug/model` 出现，因此结构上不存在静默遮蔽。

另设 `proxy.allowBareProviderModel`（默认 true）：裸名无内置归属但唯一命中某 provider 时放行，并在 `usage_requests.error` 记 `bare→slug/model`。歧义（多家都有该裸名）不猜，直接 400。

`base_url` 归一化只在**写入侧**做一次并存规范值：trim → `new URL()` 失败即拒 → 剥尾斜杠 → 剥尾缀 `/v1`、`/v1/chat/completions`、`/v1/messages`（**按后缀长度倒序 + 循环剥**，第一版按顺序首匹配会漏掉 `/v1`，被闸的直接断言抓到）→ 保留 `/api/xxx` 之类挂载路径 → 拒非 http(s)、拒含 userinfo/query。出站只拼 `base + "/chat/completions"` 或 `base + "/messages"`。

**连通性探测绝不走 `handleChat`**：直接调 `adapter.chat()`，不经 `pickAccount`、不 `insertUsage`、不 `applyCool`、不写 `lastUsed`，用用户当场输入的那把 Key 而不是池内任何一把。探测绝不能把真号池的一个号打成冷却。

---

## 六、协议契约要点

以下几条是从客户端解析器实证来的，不是文档推演——改动前先看这里。

### 6.1 出线侧的「已出线」判据

Anthropic / Responses 下「已出线不可重发」比 OpenAI 严酷得多：`message_start` 或 `response.created` 一旦 flush，换号重发就是同一条流里两个开场帧，客户端必炸。因此这两个 sink 必须 **`deferredOpen`**：把开场帧与首个块起始帧扣在 sink 内部缓冲，直到第一个 `util.hasConsumableDelta()` 为真的 delta 才连同响应头一起落盘。**OpenAI sink 保持现状立即写 role 帧**（它的首帧可容忍，且基线字节不能动）。

sink 接口共 11 个方法，`onDelta` 的返回值就是「有没有实质内容」这个判据本身；调度核心对所有协议共用同一份鉴权 / 配额 / 别名 / 回退链 / 选号 / 冷却代码——这是 §三 那条「不扩 emit 词汇」决策的全部回报。

### 6.2 Anthropic 入站

- Key 读法：`x-api-key` 优先、回落 `Authorization: Bearer`；**两者都在且不等 → 401**，不静默挑一个。
- `GET /v1/models` 三条硬约束：按 `anthropic-version` 头协商形状；接受 `?limit=1000` 并**忽略 limit** 全量返回；**绝不 3xx**（Claude Code 把重定向判失败，故连尾斜杠都单独注册），且**绝不打上游**（纯本地目录 + DB，同步返回）。
- `POST /v1/messages/count_tokens`：官方标注可选，这里复用 `util.estimateTokens`（length/4，与客户端兜底同量级）。
- 工具名规则 `^[a-zA-Z0-9_-]{1,128}$` 比 OpenAI 严，出站做**可逆**别名表，响应侧还原；`tool_choice` 点名的工具必须走同一张表（否则等于拿上游没见过的名字去点名，必 400）。
- 上游错误体**原样回传**措辞：Claude Code 的 capability-rejection recovery 靠匹配文案决定要不要在被拒字段上重试并永久关闭该能力。

### 6.3 Responses 入站（Codex）

- **EOF 前必须出现 `response.completed`**，否则 Codex 报 `stream closed before response.completed`；`response.incomplete` 会被当**失败**，所以 `max_tokens` 截断也发 `completed`，截断信息放 `incomplete_details`。
- 每个 `reasoning` item 的 JSON 里 **`encrypted_content` 这个 key 必须存在**（可为 `null`）——它是 `Option<String>` 但没有 `serde(default)`，缺 key 会让整个 item 解析失败并被静默丢弃。
- 每个 `function_call` item 的 `name` / `arguments` / `call_id` 三键必需，**`call_id` 全程保真**（它就是 OpenAI 侧 `tool_calls[].id`，下一轮 `function_call_output` 靠它关联）。
- `store` / `background` / `include` **收下并忽略**：Codex 随请求发 `store`，对它回 400 会直接打死客户端。只有 `previous_response_id` 非空才 400（本期不做会话存储，而 Codex 实测全量重放历史、不发该字段）。
- `[DONE]` 不属于本协议。保活发 SSE 注释行，不编造事件（Codex 只读 `data:` 里的 JSON `type`，`event:` 行不参与判定——这既是余量也是「不能靠 event 行传语义」的约束）。

### 6.4 两家 CLI 拼 URL 的规矩正好相反

- Claude Code：`ANTHROPIC_BASE_URL` **不补 `/v1`**，填到端口即可（流量落 `<base>/v1/messages?beta=true`）。
- Codex：`base_url` **必须自带 `/v1`**（它的 `url_for_path` 只做 `base + "/" + "responses"`）。且自定义 `base_url` 时 `supports_api_key_models()` 为 false，Codex **根本不请求 `<base>/models`**，模型只能手填——不要给用户「能自动发现」的错误预期。

### 6.5 自定义渠道的错误分类必须分叉

`classifyUpstream` 的私有码表（6004 / 11102 / 4008 / 4001 / 11115 / 11101）与中文文案解析（认「将在 … 重置」）是逆向 4 家上游的产物，对任意中转站不成立。自定义渠道走 `classifyGeneric()`：只认 HTTP 状态（429/401/404/400/5xx 五档），中文文案解析只对 `kind === 'builtin'` 启用。Anthropic 形态上游另有 type 表，但**「欠费」无论 type 写成什么都按 402 处理**——只有 402 会走「切号 + planLimit」这条既有链路，落到 400/502 就是把坏 Key 当好 Key 反复打。

---

## 七、验证与证据

每片都跑：`npm run build`、`proxy-smoke.cjs`（临时 userData）、`dev-sse-delta-test`、`dev-ccswitch-test`；二期闸在 ② 之后叠加。`tools/proxy-regress.cjs` **不跑**——它在改 `process.env.APPDATA` 之前就 `require("store.cjs")`，会打开用户真实的 `stats.db` 并拿真实登录 token 发线上请求。

本次新增四道闸：`dev-provider-test`（118）、`dev-sink-golden`（13 场景黄金字节 + 基线 JSON）、`dev-anthropic-test`（77）、`dev-responses-test`（55），另加两道变异自证脚本。

**两起闸自身失效的事故，记下来防重犯：**

1. **黄金闸一度是空转的**：把 `resetAttemptState()` 整行删掉，12 个场景全绿——因为当时没有「非流式 + 换号」的组合用例。补 `nonstream-plan-limit-rotate` 之后变异才变红。一条不红的安全网比没有安全网更危险：它让人相信那条耦合已经被守住。
2. **⑤ 的一条保护是靠闸崩溃而非断言变红被抓到的**：断言写成 `frameOf(...).data.response`，帧缺失时先抛 TypeError，闸只报一句「闸自身异常」，看不出是哪条保护没了。改成缺帧先判空后，同一次变异以断言形式变红。

**两个 sink 的真实缺陷都由闸抓到（同一类：hang）**：非流式请求写了 SSE 帧 → `res.json` 抛「headers already sent」→ 二次抛出后没人应答；首帧被 deferred 后响应头一次都没写过 → 客户端拿到没有内容类型的流。两处都修在 ③。

探针隔离是硬闸而非纪律：所有新脚本在任何产品代码 `require` 之前把 `APPDATA` 指到 mkdtemp，网关端口用 19530-19572 段，号池只放假 Key，`CCSWITCH_DB_PATH` 指到临时副本（**不要**用 `delete process.env.CCSWITCH_DB_PATH` 构造缺库场景，那会回退到真实库）。端口 9527 与 `H:\AgentHub` 是用户自己在用的实例，探针绝不触碰、绝不 kill。

---

## 八、已知语义损失（转为 OpenAI-only 内部形时不可逆）

多段 `system` 需拼接；`thinking` / `signature` 历史无法回投（签名伪造不了）；`cache_control` 丢弃；服务端工具（`web_search_tool_result` 等）丢弃；`document` 块与 `file` 型图源丢弃；`redacted_thinking` 丢弃；Anthropic 的 thinking/text 交替顺序丢失；`reasoning` item 与 `item_reference` 丢弃。每一处都在转换时写进 `notes`，由路由层打到日志——损失不可避免，不可追溯才是问题。

`[1m]` 之类的模型 id 后缀影响 Claude Code 的上下文兜底（未知 id 兜底 200K），真实上限引导用户用 `modelOverrides` 映射，不为了迎合客户端过滤器伪造 id。

---

## 九、本期明确不做（YAGNI）

one-api 的 `Type` int 全局枚举 + switch 工厂（桌面端不需要 60 种上游，新增类型还要改核心 switch；改为字符串 id + 可注册 driver）；new-api 的 `ParamOverride` DSL（30 种 mode + conditions + gjson/sjson，是多租户服务端运维工具，成本极高且能把配置配坏）；claude-code-router 的 Node.js 脚本路由规则（桌面应用引入任意脚本执行面，收益不抵风险）；Responses 上游形态；Responses 会话存储与 `previous_response_id`；`account.connectors` 用量抓取；`model_mapping` 之外的 body 字段改写；发布链路与 `build.publish` / `updater.cjs` 的仓库指向（AGENTS.md §一：只本地打包，不擅自改成发布链路）。

---

## 十、真机验收状态

**未做，需要用户在场。** 本机装有 Claude Code 与 Codex CLI，验收动作：

- Claude Code：`ANTHROPIC_BASE_URL` 指到测试端口，跑单轮对话 + 一次工具调用（`Read` 一个文件）+ 带思考链的模型，全程 `| tee` 存日志。
- Codex CLI：`codex exec` 一个最小任务，确认 `response.completed` 收束与一次 function_call 回环。
- 提供商侧：填一家真实中转站（只有用户有 Key）打通 `myprov/gpt-4o`，并接一家只开 `/v1/messages` 的 Claude 中转站验 ④ 的双入口。

四道闸覆盖的都是假上游，覆盖不到「真实上游的字段形状与我们的假设不符」这一类风险——这是本设计目前最大的未知。

---

## 十一、与二期支线的关系

二期（网关下沉独立进程）动了本功能的改动面：`store.cjs` +144、`index.cjs` +139、新增 `secretbox.cjs`。本支线从 `main` 起，`main` 上**没有 `secretbox.cjs`**，因此立了一条全程规则：**只调 `config.encryptSecret`，绝不 require secretbox**——二期改的是那个函数的实现而不是调用点，所以 v10 信封与「拒写明文」的闸门会在 rebase 后自动到位。

若二期先合：① 单独一次 `git rebase --onto perf/gateway-lite-mode-phase2 main`，冲突集中在 `store.cjs:open()` 与 `index.cjs:register()` 两处（已用「单行迁移调用 + 新命令段追加到文件尾」两条约束压小）→ **② 搬家片绝不跨 rebase**（搬家后再 rebase，diff 才看得清）→ ③④⑤ 各一次。

二期与本次规划期间的实测提醒：规划期间本仓库 HEAD 被并发会话推进过（`b7c4a3a → b6aad8f`，脏项从 16 个变成 1 个），所以「基点在动手前重新核对」写进了执行规程，而不是当作一次性动作。
