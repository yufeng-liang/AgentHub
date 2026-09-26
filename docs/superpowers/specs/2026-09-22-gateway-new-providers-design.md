# 网关新增 Cline / AutoClaw / Qoder 渠道设计

> 日期：2026-09-22　分支：`gateway-new-providers`
> 参考：github.com/aimod-cc/agent2api（Rust/Tauri）。协议常量唯一依据：同目录 `2026-09-22-new-providers-protocol-ref.md`（下称「协议参考」，引用格式 §1.2 = 其第一章程 1.2 节）。
> 前置文档：`2026-09-22-gateway-custom-providers-design.md`（自定义提供商机制，本文不重复其约束）。
> 状态（实现回写 2026-09-23）：五条渠道已全部实现并过 11 项回归（3 个新渠道 `dev-*-test` 断言脚本 + `dev-provider-test` + 既有 5 道闸 + `dev-sink-golden` 黄金字节闸 + `tools/proxy-smoke.cjs` 假上游全链路），**真机验收未做**（清单在计划 Task 15 Step 2）。下文标「实现回写」处即与最终实现有偏差、已按代码事实修正的地方。

## 〇 背景与目标

AgentHub 网关目前的上游覆盖：4 条内置渠道（trae / workbuddy / workbuddy_ai / raccoon，桌面客户端登录态型）+ 自定义提供商（openai_compat / anthropic_messages，API Key 型）。参考项目 agent2api 与本网关提供商集合几乎不重叠，其独有的是 6 家桌面客户端生态，其中 2 家（workbuddy、raccoon）已内置。本设计补齐其余 3 家生态、5 条渠道：

| 渠道 id | 生态 | 登录形态 |
|---|---|---|
| `cline_free` / `cline_pass` | Cline 官方（同一账号的两个额度池） | WorkOS 设备授权（网页）+ 粘贴 + 导入 `~/.cline` |
| `autoclaw` | 智谱 AutoClaw 国内 | 仅粘贴 + 导入 `%APPDATA%/AutoClaw/auth.json`（官方无网页 OAuth） |
| `autoclaw_intl` | 智谱 AutoClaw 国际 | Zai/Google OAuth（阿里云滑块前置 + 回环回调换码）+ 粘贴；**无扫描源**（auth.json 无地区标记，导入只能落国内，见 §5.2） |
| `qoder` | 阿里 Qoder（国际/中国跟账号走） | PKCE 设备授权（网页）+ 粘贴；无扫描源 |

明确后置：CatPaw（有状态会话协议，工作量最大，单独一期）。

## 一 渠道建模

**`store.cjs` `BUILTIN_CHANNELS` 增 5 行**，`adapters.cjs` `ADAPTERS` 增 3 个条目（工厂展开）：

- `cline_free` / `cline_pass`：`makeCline(pool)` 工厂产两个静态实例（仿 `makeWorkBuddy(channelId)`）。拆两条而非一条加参数，理由同参考项目（协议参考 §1.8）：池过滤是渠道身份属性、模型启停键 `(渠道, 模型)` 互不影响、同名模型（deepseek-v4.1-flash 两池都有）短名归属不漂移；且与 workbuddy/workbuddy_ai 先例一致。
- `autoclaw` / `autoclaw_intl`：`makeAutoClaw(region)` 工厂，域名/账号 id 前缀（`user-` / `intl-user-`）随地区，头集合与签名两地逐字相同。
- `qoder`：单渠道。地区跟账号走，存 `accounts.meta.mode = "global" | "cn"`（meta 列已存在，store.cjs:140 在线迁移先例）；四组域名内置切换（协议参考 §3.1，`QODER_REGIONS` 每区 openApi/center/webOrigin/gateway 四条）。**目录不按地区分节缓存**（实现回写 2026-09-23）：`catalog.json` 只有一节 `qoder`（= global 快照），cn 清单内置在适配器 `QODER_FALLBACK.cn`；`models()/modelEntries()` 取「两区静态兜底并集（global 优先）+ catalog 条目合并」，没有 1h 地区缓存这一层——远程目录是用户在号池页点「拉取模型」时按需拉并整段覆盖该节。地区取账号的 `meta.mode`（`_regionOf`：非 `"cn"` 一律按 global）。地区只切换四组域名与目录拉取请求体里的 `region`（对话信封不含地区字段，模型名也不带地区标记）。注意 `meta.mode` 只有 OAuth 登录会写，粘贴/导入的账号恒按 global 解析（§5.1）。

新渠道 id 经 `BUILTIN_IDS` 自动进保留名保护、自动出现在 `channelList()` / 号池页 / `/v1/models`（`mergedModels()` 遍历 `ADAPTERS`，零改动）。

## 二 适配器结构

每家一个对象，**raccoon 模板**（adapters.cjs:1433）：`models()` / `fetchModels()` / `rewriteBody()` / `chat({account,secrets,model,body,emit,meta})` / `refreshToken()` / `userInfo()`；有余额接口的补 `queryCredits()`（credits.cjs 靠缺席跳过，没有的不造假）。全部走既有 emit 四词汇（delta/usage/finish/error）、强制 `stream:true`、非流式 Aggregator 聚合、401 → `refreshTokenLocked` 单飞。

实现落定的两处差异（实现回写 2026-09-23）：

- **`fetchModels()` 只有 cline 与 qoder 有**；autoclaw 两区刻意不接远程目录（§六、§九），号池页对 `autoclaw*` 点「拉取模型」会按既有判据回「未知渠道」。
- **新渠道一律不定义 `queryCredits`**，连带一个非显然后果：临期预刷新（`refreshWindowSec`）唯一的触发点在 `credits.refreshAccount` 内，而它被 `creditsCapable()` 整渠道跳掉——所以 `cline.refreshWindowSec=600` / `autoclaw*=300` / `qoder=300` 三个常量在线上**没有触发者**，新渠道实际只有「对话吃 401 → `refreshTokenLocked` 单飞刷新 → 同账号重试」这一条反应式路径（server.cjs:107）。

加密与凭证助手独立成模块（仿 `raccoonAuth.cjs` 先例，不继续膨胀 adapters.cjs）。导出名一律 camelCase（下表按最终实现的实际导出清单，实现回写 2026-09-23；`clineAuth.cjs` 只 require node 内置、`autoclawCredentials.cjs` 额外只碰 koffi，两者都不反向依赖 proxy 模块，防环）：

| 新模块 | 职责（实际导出） |
|---|---|
| `clineAuth.cjs` | `jwtClaims`（本地解 payload，不验签）、`ensureTokenPrefix`（幂等补 `workos:`）、`clineUid`（`external_id` > JWT 名域声明 `https://api.cline.bot/user_id` > 调用方 fallback，`sub` 永不采用）、`clineDisplayName`（CJK 姓前）、`clineExpiresAt`（ISO 串 / 毫秒数字 / JWT `exp` 三形态归一）、`readClineDesktopAuth`（`~/.cline/data/settings/providers.json` 只读，桌面端 `metadata.userInfo` 是展示名权威来源） |
| `autoclawCredentials.cjs` | 解密链：`Local State` → `os_crypt.encrypted_key`（剥 `DPAPI` 5 字节）→ CryptUnprotectData → 32 字节 AES key（`osCryptKey`，按目录进程级缓存）；`decryptEncValue` 解 `enc:` = `v10` + 12B nonce + AES-256-GCM（无 AAD，tag 尾置）；`stripBearer`、`readJsonGuarded`（普通文件 / ≤256KB / JSON 对象根）、`parseAuthFile`、`readAutoClawAuth`、`readOpenclawFallback`；另导出 `dpapiProtect`（测试造 DPAPI 夹具用）。**`parseAuthFile.expiresAt` 恒 0**——auth.json 没有过期字段，账号到期在刷新时按新 JWT `exp` 重算 |
| `autoclawPrompt.cjs` | system 白名单改写：`normalizeSystemPrompt(body)` 就地改写（返回同一引用）——全量替换 `FOREIGN_IDENTITIES` 五条外来身份句（长串在前，短串会把长匹配切碎）+ 首条 system 注入 `IDENTITY_PREFIX`（含 `## Tooling` 段，幂等判据只有 `startsWith(IDENTITY_LINE)` 一条）；`content` 三形态都处理（字符串 / 数组拼进第一个 text part / 其它整段换成前缀）；无 system 时 `unshift` 一条，不重排后面的消息 |
| `qoderCosy.cjs` | COSY 签名全套（导出 `encodeBody` / `buildCosyHeaders` / `sigPathOf` / `md5hex` / `randomAesKey` / `rsaEncryptKey` / `GATEWAY_COSY_VERSION`）：身份 JSON 手写键序、AES-128-CBC（key=iv 同 16 字节）、RSA-1024 PKCS#1 v1.5（node:crypto `publicEncrypt` 从模数 + `e=AQAB` 构 JWK）、自定义 base64（含 `'=' → '$'`）、`encodeBody` 三步变换、MD5 拼接签名。`sigPathOf` 判前缀用 **`/algo/`（带尾斜杠）**——`/algo` 会把 `/algorithm` 类路径误切 |

**DPAPI 实现选型**（实现回写 2026-09-23：结论与原计划相反）：**没有走 Electron `safeStorage`，koffi 直调 `crypt32!CryptUnprotectData` 是唯一运行时路径**。理由是模块要能在纯 node 下被 `dev-autoclaw-test.cjs` 真跑一遍 DPAPI round-trip（走 safeStorage 就等于要求 Electron 宿主 + 只能 mock 掉这条断言）；「safeStorage 能解外部 Chromium blob」这个假设因此未使用也不需要再验。koffi 3.3.0 的声明细节与原草案不符，按探针实机跑通后固化四条：① 顶层 `koffi.func(lib, ...)` 已移除，只能 `lib.func("C 原型字符串")`（与 `sqlcipher.cjs` 同款）；② Win32 `BOOL` 是 4 字节 int，返回类型写 `"int"` 不是 `"int8"`；③ 原型解析器只认 `_In_`/`_Out_`，`_In_opt_`/`_Out_opt_` 直接报未知类型，可选参数一律声明成裸 `void *` 传 null；④ `_Out_` 结构体出参要传 `[{}]` 数组并回读 `out[0]`，指针内容用 `koffi.decode(ptr, "uint8", cbData)` 取，**释放用 `kernel32!LocalFree` 而不是 `koffi.free`**（输出 blob 由 LocalAlloc 分配，`koffi.free` 只认 `koffi.alloc`，混用会破坏堆）。koffi 在非 Windows 会在首次调用处抛错并被 `readAutoClawAuth` 包成中文错误（本仓库网关与 `sqlcipher.cjs` 同为 Windows-only，未加平台守卫）。

**指纹头配置**：三家头常量写死在各自适配器内（参考项目同款内置做法），不进 `rules/headers.json`——那是热加载的渠道 UA 规则文件，v1 没有热调需求；后续上游改指纹再迁。

## 三 协议要点（细节一律看协议参考）

### cline（§1）
- 基址 `https://api.cline.bot/api/v1`（单层 v1）；body **完全透传**，唯一业务改写是 model 带池前缀原样发（`cline-free/deepseek-v4.1-flash`，前缀是计费通道选择器，剥掉 404；裸名则补本池前缀）。§二 的通用改写在 cline 侧同样生效（强制 `stream:true` + `stream_options.include_usage`、剥 `conversation_id`/`prompt_cache_key` 族），除此之外不加字段
- 头：`Authorization: Bearer workos:...`（**前缀必须**）+ `X-CLIENT-TYPE: cline-sdk`（**缺它免费池全 403**；`cline-cli` 值走兼容路径回 500，禁用）
- 刷新：`POST /auth/refresh`，body `{"refreshToken":...,"grantType":"refresh_token"}`（**camelCase**）；响应 accessToken **不带前缀**、`expiresAt` 是 ISO 字符串；临期窗口常量 10 分钟（但见 §二：该窗口在线上没有触发者）。**refreshToken 存裸值，绝不补前缀**（实现回写 2026-09-23）——`workos:` 只属于 accessToken：`refreshToken()` 把库存的 refreshToken 原样发进 `/auth/refresh`（adapters.cjs:1784/1793 无剥前缀逻辑），桌面端 `providers.json` 里也是裸值，带前缀入库的账号一小时后刷新必 401。前缀走**双保险幂等**：登录/刷新/扫描入库前补一次，`headers()` 发送前再 `ensureTokenPrefix` 一次（粘贴来源因此不需要入库预处理也能通）。
- SSE：标准 OpenAI chunk 直透。**上游回内部模型名（协议参考 §1.4 的 `sse_model_rewrite`）明确不实现**（实现回写 2026-09-23）：本网关的 emit 词汇只有 `delta/usage/finish/error` 四种、**不携带 model**，出线帧的 `model` 由 sink 用客户端请求名自构（`protocols/openai-out.cjs:22` 的 `requestedModel`，「响应始终回显它，路由改判不外泄」是既有契约）——上游内部名在结构上就到不了客户端，逐帧回写等于写一段永不生效的代码。结论：这条能力从规格里划掉，适配器与 sink 两侧都零代码。
- 思考增量是 `delta.reasoning`（OpenRouter 形），按规格**不改名透传**；后果要记清（实现回写 2026-09-23）：OpenAI 流式下它作为未知扩展字段原样带给客户端，但 sink 的思考合批与非流式 `Aggregator` 只认 `reasoning_content`（util.cjs:312），所以**非流式请求的思考链会被丢掉**。要两家都吃到就得在适配器里改名——本期按规格不改（真实上游是否恒发 `reasoning` 待真机确认，见 §八 真机未做项）。

### autoclaw（§2）
- LLM 域头：**`X-Authorization: Bearer`（不是 Authorization）**、`X-Product/X-Client-Type/X-Tm/X-Version/X-Lang/X-Channel/x_trace_id/X-Request-Id/X-Request-Model`；**chat 路径禁发 `X-Harness-Type: zcode`**（2026-09-22 起稳定 403/406）；userapi 域保留 `X-Harness-Type` 且加签名头
- userapi 域签名：`X-Auth-Sign = MD5("100003&{秒级时间戳}&38d2391985e2369a5fb8227d8e6cd5e5")` 小写 hex；`X-Auth-TimeStamp` 是**秒**
- 模型：`X-Request-Model` 发完整路由 id（`zaicoding_glm-5.3` 等），body.model 发剥前缀名；解析顺序实现为**四级**（实现回写 2026-09-23，`autoclawResolveRoute`）：静态路由表 `AUTOCLAW_MODELS`（当前官方选择器仅剩的两个模型）→ 已带 `zai_`/`zaicoding_` 前缀透传 → 合法形态（`AUTOCLAW_ROUTE_RE`）透传 → 兜底 `zai_auto`。原写的「远程」那一级未接（`AUTOCLAW_REGIONS[].catalogUrl` 常量预留、无调用方，见 §六/§九）；`X-Request-Model` 由 `rewriteBody` 打的 `_routeId` 内部标记带出，chat 组装时取走并在序列化前 delete
- **system 白名单闸门**（2026-09-22 起）：首条 system 必须以身份句开头且带 `## Tooling` 段，否则 403/406——出线侧统一走 `autoclawPrompt.cjs` 改写（替换外来身份句 + 前缀注入，幂等）
- 刷新：`POST {userapi}/userapi/v1/refresh`（响应 `code` 400002 降级 `/agent-refresh`），body `{refresh_token, source_id:"autoclaw", device_id}`；`device_id` 取 `meta.device_id` 优先、缺省回落 JWT `device_id` 声明（`util.jwtDecode(...).payload`，声明不在顶层）；`410000`/401 → 判 expired 要求重登；桌面导入来源（`source==="scan"`）刷新前重读 auth.json 取最新令牌。**「每小时无条件强刷（温着 refresh_token）」未实现**（实现回写 2026-09-23）：本渠道没有 `queryCredits`，定时额度链路整渠道跳过，而临期预刷新只有那一个触发点（§二），所以实际只有对话 401 反应式刷新。已知代价：账号长期闲置后库存的 refresh_token 可能已被服务端轮换作废，表现为刷新报 expired 要重新登录/导入——不做状态机兜底，真机若高频出现再补定时刷新。

### qoder（§3）
- chat：`POST {gateway}algo/api/v2/service/pro/sse/agent_chat_generation?...&Encode=1`，鉴权是 **COSY 自签名**（非 Bearer）
- **先 `encodeBody` 后签名**（签的是编码后字节，顺序颠倒只报「签名不匹配」无从排查）
- 请求体是固定业务信封（非 OpenAI 形）：messages 规整（system/developer 收集置顶、顶层 `system` 恒空串、`assistant` 纯 tool_calls 时补 `" "`、非字符串 role 条目跳过）、`model_config` 精简版（剥 `thinking_config`）、`parameters.enable_thinking` 只在开思考时发（发 false 会混流）、`max_tokens` 与 32768 取小（>32K 上游退化）、`business.name` 取最后一段用户文本前 30 字、会话/记录 id 用 sha256 派生（协议参考 §3.4 有公式）。**`__failed` 轮次丢弃未实现也不需要**（实现回写 2026-09-23）：那是参考项目自存会话历史时的内部标记，本网关的 messages 全部来自入站协议归一后的 OpenAI 形，结构上不存在这种标记
- SSE：**HTTP 恒 200**，信封 `{statusCodeValue, body:"<内层JSON字符串>"}` 双层解析（`[DONE]` 短路）；usage 取最后一帧，且在 finish/`[DONE]`/异常三条出口上都先冲刷再收尾；思考标签的跨分片状态机 `TagSplitter` 覆盖 `thinking/think/reasoning/thought` 四种，**语义是「丢掉标签段内容、保留标签外正文」**（闭标签后先吃 `\n\n` 再吃单个 `\n`），不是「拆成 reasoning_content」；流结束必须 `flush()` 兜尾（不兜就丢末段文字）
- 错误：判定**先看响应体语义、后看状态码**（实现回写 2026-09-23，`qoderClassify` 的固定顺序）：带 `pricingUrl`/额度关键词或 `"code":112` → 402（换号，`planLimit` 置位）；429/限流文案 → 402；401/**裸 403** → 401（刷新）；其余 502。顺序颠倒的后果要记着：一个带额度文案的 403 若先按状态码判就成了「登录失效」，实际是「该充值」
- 会话/记录 id（`qoderIds`）：`sha256(标签 \0 字段).hex[:16]`，`sessionId` 再拼 `-` + seed；**seed 缺省是随机 uuid**（协议参考 §3.4「新会话」语义），要可复现必须显式传 `session_id`

## 四 错误分类 → AgentHub 既有链路映射

参考项目的「四档」收敛到 AgentHub 现有两条件发射：

| 上游语义 | 参考项目档位 | AgentHub 动作 |
|---|---|---|
| 限额/额度/风控（429、pricing、quota 关键词、autoclaw 429） | QuotaLimited | **emit 402**（走既有「切号 + planLimit 冷却」链路；raccoon 同款：只有 402 进这条链） |
| token 失效（401、autoclaw 410000、裸 403[qoder]） | TokenExpired | **emit 401**（`refreshTokenLocked` 单飞刷新后同账号重试） |
| 确定性拒绝（cline 403 ENTITLEMENT/API_REQUEST、404） | Fatal | **原状态透传，不冷却账号**——cline 403 刻意不当限额：换号同样 403，冷却只是把确定失败变静默跳过。实现回写 2026-09-23：出线状态取适配器 emit 的 `status`（server.cjs:585），403 到客户端仍是 403；404 走 `not_found` 档 60s 短冷却不累计，403 落通用 `server` 档单次不罚号 |
| 内容拦截（三段文案判定，协议参考 §〇） | ContentBlocked | **v1 透传，不罚账号**（AgentHub 无中性提示词降级状态机，见 §九）。实现回写 2026-09-23：只有 autoclaw 有这条判据——错误文案命中 `blocked by security policy` / `unapproved channel` / `illegal api invocation` 三者之一时 emit **502**，落到调度核心是通用 `server` 档（单次不罚号、只由外层轮转换号，连续 3 次才 30m 起指数熔断，server.cjs:234）；qoder/cline 侧没有内容拦截分支，按各自分类表走 |

## 五 凭证通路

### 5.1 粘贴（现成 IPC，零新增）
`proxy_account_add(channel, name, token, refreshToken, uid)`——**签名逐字未动**，它只收这五个字段、不写 `accounts.meta`（store.addAccount 支持 meta，但这个 IPC 没传）。各家字段提示（实现回写 2026-09-23，按 `index.cjs:312` 与 `normalizeAccountJson` 的真实能力面收窄）：
- cline：token 自动补 `workos:` 前缀（实际是发送时 `headers()` 幂等补，入库不预处理，见 §三）；refreshToken 可选（无则到期重登）
- autoclaw：token / refreshToken。两处与原文不同：① **`deviceId` 没有粘贴通道**——粘贴 JSON 走 `normalizeAccountJson`，它只认 token 别名 / refreshToken / uid / name / expiresAt，**多余键直接丢弃**；刷新用的 `device_id` 由适配器从 token 的 JWT 声明回落（adapters.cjs:1968-1973），所以 UI 文案不承诺「把 device_id 一起粘进来」。② **`enc:` 原值不能粘**——解密入口只有 `readAutoClawAuth()`（读 `%APPDATA%/AutoClaw/auth.json`），粘贴通道不解密，粘 `enc:` 会原样入库并稳定 401；要 `enc:` 必须走「从本机软件导入」
- qoder：refreshToken 粘**打包串**（`pat|...|userId|machineId` 5 段 或 `oauthRT|userId|machineId` 3 段，协议参考 §3.7）；**「region 在表单选」未做**——粘贴面板没有地区字段，粘贴账号 `meta` 为空，`_regionOf` 因而恒按 global 解析。要 cn 区只能走 OAuth 登录（登录流有「国际版 / 中国版」二选，落 `meta.mode`）；「粘贴 JSON 里带 region」也救不了，同一处 meta 不落。这条限制要真机验证是否有用户需要，再决定给 `proxy_account_add` 加 meta 入参

### 5.2 扫描导入（`discovery.cjs` 增源，挂进 `scanAll()`）
- **scanCline**：`~/.cline/data/settings/providers.json` → `providers.cline.settings.auth`；uid 走 `clineAuth.clineUid(token, accountId)`（`external_id` 优先，回落 JWT 名域声明与文件 `accountId`，`sub` 永不采用）；uid 取不到就**不出候选**（不落空号行）。**落库快照**（AgentHub 号池按账号记账，与参考项目「不落 token 实时读盘」架构不同，不做 desktop 指针模式）。候选默认落 `cline_free`，两池共用同一套凭据，UI 的 `channelOverride` 可改投 `cline_pass`。防顶掉：cline 刷新前**重读文件取最新 refresh_token**（raccoon 同款，且只在解出的 uid 与账号 uid 一致时才换用），刷新成功**不回写文件**（参考项目实证：两边都轮换会互相顶掉）
- **scanAutoClaw**：`%APPDATA%/AutoClaw/auth.json`（解密链，文件防御：普通文件、无硬链接、≤256KB、JSON 对象根）+ 备来源 `~/.openclaw-autoclaw/openclaw.json`（明文 X-Authorization，无 refreshToken → 候选名直书「AutoClaw（openclaw.json，无刷新令牌）」、`refreshToken` 留空，刷新时适配器如实报「请重新粘贴或导入」）。解密抛错的文件防御失败一律**静默不出候选**（UI 回落粘贴）。**只导 `autoclaw`（国内）渠道**：auth.json 无地区标记，参考项目门禁同款（`local_credentials()` 对非 Cn 拒绝）。刷新成功只更号池行，**不回写 auth.json**（回写需同一把 os_crypt 密钥重新加密，且参考项目桌面来源也不回写）。原文的「mtime 更新则以文件为准」未实现（实现回写 2026-09-23）：`source === "scan"` 的账号刷新前**无条件重读并优先采用文件里的 refreshToken / deviceId**，不做 mtime 比较——文件比库新与比库旧在网关侧动作相同（都以文件为准），少一层状态；代价是若用户在桌面端登出而文件仍在，会照用文件里的旧令牌，由上游 401/expired 收口
- **scanQoder**：无桌面登录态可扫（参考项目只读 machine_id，而机器码已由 §5.3 的登录流复用），v1 不提供扫描，引导网页登录/粘贴

### 5.3 网页 OAuth（`discovery.cjs` `beginOAuth` 增分支）
- **cline（设备流，新 session 类型 `mode:"device"`）**：`POST api.workos.com/user_management/authorize/device`（body 仅 `client_id=client_01K3A541FN8TA3EPPHTD2325AR`，form-urlencoded）→ 拿 `verification_uri_complete`（**免手输码**；上游没给则回落 `verification_uri`，再没有则兜底 `https://authkit.cline.bot/device`）+ `userCode` 兜底展示 → 按 `interval`（5s，`slow_down` +1s、上限 30s）轮询 `authenticate`（`grant_type=urn:ietf:params:oauth:grant-type:device_code`，400 `authorization_pending` 继续）→ 成功后**必做** `POST api.cline.bot/api/v1/auth/register`（头带 `X-CLIENT-TYPE: cline-sdk`）换 Cline 会话令牌 → 落库（两池入口同构，账号落用户点的那条渠道；同 uid 二次登录更新不新建）。会话 `deadline = max(3min, 上游 expires_in)`；`external_id` 与 `accountId` 双缺时**直接报错不落空 uid**（空 uid 会跳过同 uid 查找，每次重登堆一个「未命名账号」——cline/qoder/autoclaw_intl 三条流同一判据）
- **qoder（PKCE 设备流，同 `mode:"device"`）**：无起始请求，本地拼授权页 `{web_origin}/device/selectAccounts?challenge=S256(verifier)&challenge_method=S256&machine_id=&nonce=`（`challenge` 是 base64url(sha256(verifier))、43 字符无 `=` 填充；verifier 只留后端）；2s 定间隔轮询 `{open_api}/api/v1/deviceToken/poll?nonce&verifier&challenge_method=S256`（**202/404/网络错误 = 继续**，`refresh_token` 含 `|` 视为无效票继续轮）→ 成功拿 token 集 → userinfo 补 name/email（**容忍规则**：poll 已带 `user_id` 时才允许 userinfo 失败并回落，否则报错不落空号）→ 落库 `meta = {mode,email,machine_id,user_id}`、`refreshToken` 打包成三段、`expires_at` 用 `util.toMs` 认毫秒|秒|RFC3339 三形态（缺省 now+30 天）。UI 登录入口给「国际版 / 中国版」二选（→ `opts.edition`）。会话超时给足 6 分钟（授权页还要登录 + 选号）。`machine_id` **只有一个实现**（实现回写 2026-09-23）：`adapters._qoderMachineId()` 导出，discovery 侧 `qoderMachineIdOf()` 是一行委托——两侧各写一份读文件逻辑迟早漂（四个候选文件 + 生成后写回 `<proxyDir>/qoder-machine-id` + 进程内缓存，只能有一处真值），对话签名与登录上报也因此必然同码
- **autoclaw_intl（OAuth + 滑块，唯一走回调的）**：三步——① renderer 加载阿里云官方 SDK（`o.alicdn.com/.../AliyunCaptcha.js`，**`window.AliyunCaptchaConfig` 必须先于脚本注入赋值**，顺序反了弹窗一直转圈；popup 模式必须给 `button` 触发元素，初始化后至少等 2.1s 再 `.click()`），滑块回调拿 `captchaVerifyParam`；② 主进程 `POST {intl}/userapi/overseasv1/{zai|google}-oauth-url`（body `source_id/device_id(64hex)/navigate_uri/ali_captcha_verify_param`，vendor 只认 `zai`/`google` 白名单）拿 `oauth_url`，滑块配置由前一次 `POST {intl}/userapi/overseasv1/oauth-captcha-config`（body `{}`）给出，`navigate_uri` 指向 discovery 回环服务新路径 `/aclaw-cb/{vendor}/{32hex 任务 state}`（**上游不校验回调主机**，实测只非空校验；端口由 `listenLoopback` 实听后才拼）；③ 系统浏览器完成登录 → 302 回环 → **换码必须用查询串里上游回的 `state`，路径里的是我们的任务 state（双 state 陷阱，混用稳定 `631001`）** → `oauth-login` 换 token（`navigate_uri` 要逐字重复上一跳的值）→ 落库 `uid = intl-user-<user_id>`、`meta.device_id`。回环侧三条防御：任务 state 不符只回 400 拒本次请求**不杀会话**、上游登录前的**空参探测回调**回等待页继续等（照 Trae 同源实测坑）、`settled` 位保证重复回调幂等回成功页且只换码一次。滑块配置 `enabled=false`（国内版形态）与上游异常回同一条文案
- **autoclaw（国内）**：`beginOAuth` raccoon 式明确抛错提示不支持（官方只有客户端手机号+验证码登录，无可代收的网页授权；短信息登录参考项目有实现，本期按用户裁定不做，见 §九），UI 侧同步**整档隐藏 OAuth 标签页**并默认落在「从本机软件导入」
- 超时/取消/单会话沿用 `oauthSession` 生命周期（同一时刻只允许一个登录在进行）；设备流无回调地址可粘，`submit` 给明确提示（workbuddy 同款）。两条流的轮询在 `await` 之后复查「会话还是不是本次那次」——期间用户可能已取消或改登别的渠道，否则会对 `null` 写 `timer` 抛未处理 rejection
- **不新增 IPC**（实现回写 2026-09-23）：原计划的 `proxy_oauth_captcha_config` / `proxy_oauth_captcha_continue` 两条通道都没建。滑块两跳复用同一个 `proxy_oauth_begin`：第一次不带 `captchaVerifyParam` 只回 `{needCaptcha:true, captcha:{region,prefix,sceneId,supplier}}`，第二次带参回 `{url, mode:"callback"}`。好处是 preload 白名单与 `oauth-done` 事件面零改动、renderer 只学一个调用；代价是第一跳**没有 url**，返回体必须把 `needCaptcha/captcha` 一路透传出去（丢了这两个键 UI 分不清「要滑块」还是「已打开登录页」，会停在「已在浏览器打开…」的假等待里干等——这是一次真实回归的根因），且 `ProxyAgentsView` 里「发起中(busy，含等滑块)」与「等回调/轮询(waiting)」两态必须分开。`proxy_oauth_begin` 最终形态：入参 `{channel, edition, vendor, captchaVerifyParam}`，返回 `{url, mode, userCode, needCaptcha, captcha}`；授权页由**主进程** `shell.openExternal` 打开，前端只负责展示等待态与 `userCode`
- CSP：`index.html` 为滑块 SDK 放行的是**窄域清单**（实现回写 2026-09-23），不是「`*.alicdn.com` + `*.aliyuncs.com` 两个通配一把梭」：`script-src` 与 `connect-src` 只逐个列 `o.alicdn.com` / `g.alicdn.com` / `x.alicdn.com`（官方 CDN 全部就在这三个主机上），`style-src`/`img-src` 才用 `*.alicdn.com` 并另列 `static-captcha.aliyuncs.com` / `static-captcha.sgp.aliyuncs.com`，验证接口与 `frame-src` 只给 `*.captcha-open.aliyuncs.com` / `*.captcha-open-sgp.aliyuncs.com`。**`https://*.aliyuncs.com` 一律不放**：那张表下含用户可写的 OSS 域（`<任意 bucket>.oss-*.aliyuncs.com`），放开等于给渲染进程开一条把网关 Key 往站外 POST 的通道（contextIsolation + IPC 白名单挡不住页面自己发请求）。阿里云换域的表现是 SDK 初始化失败（UI 有可读报错），不是静默降级——宁可报错也不放宽

## 六 模型目录

- **静态兜底的落点是 `rules.cjs` 的 `DEFAULTS["catalog.json"]`，不是仓库里的某个 `rules/catalog.json` 文件**（实现回写 2026-09-23，规格/计划原写法有误）：`rules/*.json` 是运行时从内置默认值拷到用户数据目录（`store.proxyDir()/rules/`）的产物，仓库里根本没有这个文件——所以「改 catalog.json」在代码上等价于「改 DEFAULTS 里的那一节」。好处是 `ensureFiles()` 的 `mergeMissing` 递归只补缺失键、不动用户已有值，老装机升级后**自动获得新渠道的目录节**，不必删文件重来。新增节：`cline_free` / `cline_pass`（两池分组，协议参考 §1.4 FALLBACK_MODELS 逐字，rate 未知留 null）、`autoclaw` / `autoclaw_intl`（两地目录一致但各占一节防串区）、`qoder`（global 区 17 条快照，`rate = price_factor`，**0 是合法值不能当缺失丢掉**）。cn 区的 10 条不单独落目录节，随 §一 的说明内置在适配器 `QODER_FALLBACK.cn`
- `fetchModels()` 拉远程：**只有 cline 与 qoder 两家**。cline `GET /ai/cline/recommended-models`（免鉴权，按 `{recommended,free,clinePass,clineCloud}` 分组归池——**归池看响应分组不看前缀**，free 组混有裸名条目 `z-ai/...`、`poolside/...`；`recommended` 走 credit 计费不收、`clineCloud` 实测 403 不收；元数据从静态目录按大小写不敏感回填，缺条目时兜底 `name=id` + `{images:false,reasoning:true,tools:true}` + 长度 0）；qoder `GET {gateway}algo/api/v2/model/list?Encode=1`（COSY 签名，信封 `{statusCodeValue, chat:[...]}`；对外 id = `display_name` 去所有空白，`_key`/`_efforts` 作内部字段随行保留）
- **autoclaw 的远程目录 `GET .../autoclaw-model-config` 未接**（实现回写 2026-09-23）：`AUTOCLAW_REGIONS[].catalogUrl` 常量按协议照抄但无调用方。这是计划层的裁剪（T7 简报里没有这一步），要付的账写明白：协议参考 §2.4 记录远程实测 4 条，比静态表多出 `zai_auto` / `zai_auto-fast` 两个「自动路由」条目，且它们剥前缀后（`auto-fast`）不满足合法路由形态、只能靠目录识别——所以**这两个条目不会出现在 `/v1/models` 里，用户无法显式选自动模式**；`zai_auto` 仍作为解析兜底命中（形态不合法时）。真出现「目录里有、表里没有且兜底兜不住」的模型时再加这一级
- **qoder 也没有「按地区缓存 1h」**：目录是号池页点「拉取模型」时按需拉一次、整段覆盖 catalog 对应节并热生效（`proxy_models_sync` 写回 + `rules.reload`），失败不写空。这条缓存原样照搬的是参考项目的进程内 HTTP 缓存语义，本网关的目录本就是磁盘态、无 TTL 需求
- **写回目录的真实上游键必须原样留在 `catalog.json` 里**：`_key`/`_efforts` 是 qoder 打上游与思考档位白名单的唯一依据，`modelEntries()` 合并 catalog 时只能补 `m._key || m.id`、不能拿展示 id 覆盖（曾覆盖过一次，后果见 §八 实现踩坑）
- `/v1/models` 聚合零改动；cline 对外模型名带池前缀（目录 id 本身就带 `cline-free/`，两池天然不重名，`mergedModels()`/`modelOwners()` 零特判）

## 七 UI 增量

- 渠道卡片 / 扫描导入列表随 `BUILTIN_CHANNELS`/`scanAll()` 自动出现；号池页的渠道分区来自 `channelList()`，同样零改动。**一处例外**（实现回写 2026-09-23）：号池同步视图 `ProxyPoolSyncView.vue` 的「目标渠道」下拉是硬编码 4 家，新渠道只能靠「全部渠道」整池同步，未随 `BUILTIN_CHANNELS` 扩（`poolsync` 本身按字符串过滤，改的只是这一处 UI 数组）
- 登录按钮：`mode:"device"` 结果带 `{url, userCode}`，前端在等待面板里展示「如页面未自动带上验证码，请手动输入：XXX」（qoder 无用户码 → 该行不出现）；`proxy_oauth_begin` 返回值除 `userCode` 还要带 `needCaptcha/captcha`（见 §5.3）
- autoclaw_intl 登录：先弹滑块（renderer 内嵌 `#aliyun-captcha-element` + 1×1 透明触发按钮，初始化后至少等 2.1s 再 click）；主按钮文案是「滑块验证并打开登录页」，滑块阶段绝不能显示「已在浏览器打开」——因此 `oauthBusy`（发起中，含等滑块）与 `oauthWaiting`（浏览器已开）两态必须分开，**只有二次调用拿到 url 才进等待态**；滑块有 120s 超时与 `onError` 落地成可读文案，取消时 `instance.hide()` 收口
- 粘贴表单按渠道给字段说明与占位符（`PASTE_HINT` 五句 + 渠道化 placeholder）
- **不做 i18n**（实现回写 2026-09-23，撤销原文的「走项目现成机制补四语」）：这个 Vue 前端**没有任何 i18n 设施**——无 `vue-i18n` 依赖、无 `locales/` 目录、`index.html lang="zh-CN"`、全仓视图文字一律中文字面量；AGENTS.md 的国际化条款（`stringResource`/`strings.xml` 四语）是 Android 侧规范，不适用于此。故新文案沿用本文件既有的「渠道 → 文案表」写法（`OAUTH_HELP` / `OAUTH_WAIT_MSG` / `PASTE_HINT` 三张表），要做多语言时这三张表就是现成的抽取边界。附带一处必要修正：等待文案里的**超时数字按渠道出**（旧代码写死「3 分钟」，cline 实际是 `max(3min, 上游 expires_in)`≈5min、qoder 与 autoclaw_intl 是 6min）
- `autoclaw`（国内）整档隐藏「OAuth 登录」标签页并在 `openAdd()` 里把默认档落到「从本机软件导入」；`raccoon` 同款处理（`addTabAllowed` 按渠道门禁，不是新增函数）

## 八 测试

沿用 `scripts/dev-*-test.cjs` 独立断言脚本模式（文件头注释写跑法；探针隔离硬规则：require 产品代码前把 `APPDATA` 指到 `mkdtemp`；端口 19530-19572 段）：

- `dev-cline-test.cjs`：池前缀透传/剥前缀规则、错误分类表（401→刷新、429→402、**403→Fatal 不冷却**、404→Fatal）、displayName 拼装、目录按组归池、`fetchModels` 假 fetch 全链路、`scanCline` 候选、设备流轮询状态机（pending/slow_down/expired/denied 假上游 + 假时钟一秒不真等）。**原列的「SSE model 回写」断言不存在**（实现回写 2026-09-23）：那条能力结构性不需要，见 §三
- `dev-autoclaw-test.cjs`：两套头集合逐字断言（**chat 无 X-Harness-Type、userapi 有**）、X-Auth-Sign 公式（已知输入→已知 MD5）、模型路由解析、system 白名单改写幂等性（改写→再改写不变）、解密链（自造夹具：koffi `CryptProtectData` 造真 DPAPI blob + 手工 AES-256-GCM 造 `enc:` 字段，**不打 mock**）、`scanAutoClaw` 国内门禁、国际版 OAuth 全链（滑块透传 / 回环回调 / 双 state 换码 / 幂等 / 竞态）
- `dev-qoder-test.cjs`：**COSY 签名**——无官方测试向量，用三层断言：结构断言（cosy_key 定长 128 字节、PS 非零、payload 可解码回原 JSON）、可逆性（AES 自加密自解密、RSA 公钥加密后无法逆向但长度/布局校验）、字段布局（MD5 拼接顺序固定串对照）；`encodeBody`（协议的 encode_body 三步变换）与测试内独立第二实现互拍（含余数/无余数边界）；信封双层解析、usage 末帧、thinking 标签跨分片状态机（`<thi`+`nking>` 切片用例）、错误分类（pricing→402 / 裸 403→401）、PKCE 配对与轮询节奏
- `tools/proxy-smoke.cjs` 增假上游全链路：**五渠道各一条**（cline 双池含 401→刷新→重试的完整链路、autoclaw 双地区、qoder COSY 信封）——**上游改指手段不是注入 `headers.json` 而是 monkey-patch `globalThis.fetch`**（实现回写 2026-09-23）：trae/wb 的 chatUrl 是可配 URL，而这三家的上游域是适配器里的常量，按 hostname 把 `api.cline.bot` / `autoglm-*` / `api3.qoder.sh` 改指 `http://127.0.0.1:19530/<渠道>/<末两级路径>`（保留原路径会被假服务 404 全部吃掉），客户端↔网关的 127.0.0.1 直连原样放过，场景结束还原 fetch。qoder 场景在测试内实现 `encodeBody` **逆变换**并与 `qcosy.encodeBody` 互拍。运行方式：worktree 没下载 electron dist 时直接 `node tools/proxy-smoke.cjs <临时目录>`（需自带 `node:sqlite` 的 Node 22+）
- **`tools/proxy-regress.cjs` 禁止在本期任务里跑**（实现回写 2026-09-23）：它 require `store.cjs` 前不做 APPDATA 隔离，直碰真实 `%APPDATA%/AgentHub/proxy/stats.db`（真号池、真流水），与「探针隔离」硬规则冲突。全量回归的 11 项 = 上述 3 个新脚本 + `dev-provider-test` + `dev-anthropic / dev-responses / dev-sse-delta / dev-ccswitch / dev-config-lite-defaults` 5 道既有闸 + `dev-sink-golden` + `proxy-smoke`
- **`dev-sink-golden`（黄金字节闸）必须每波都跑**：它是唯一守「调度核心的出线字节」的闸，13 个场景逐字比对，**变红即停、禁止随手 `--write` 重录基线**。本期确实重录过一次，且是核对过才录的：13 场景键集不变，只有 unknown-model 的 400 提示里「可用模型」枚举从 70 条追加到 91 条（旧顺序原样作前缀、零删除）——这是新渠道目录进聚合的既定后果，不是语义变化，才允许重录并单独 `test:` 提交
- 真机联调：三家各配一个真实账号手工过一遍（登录/导入→对话→额度→断流重连），作为验收步骤写进实现计划。**截至本文回写时未做**：闸守的全是假上游，覆盖不到「真实上游字段形状」这一类风险（`delta.reasoning` 是否真发、qoder `fetchModels` 的 GET 验签、`model_config.is_reasoning` 上游是否校验、滑块真 sceneId 下的快乐路径、真实 AutoClaw auth.json 解密，都只能真机确认）

**实现踩坑（两条集成期形状错位，都由闸抓到，记下来防重犯）**

1. **条目字段前缀 `_` 与消费面键名不同名**：`modelEntries()` 产物把上游键放在 `_key`，而 `chat()`/`qoderBody()` 读 `.key` —— 单测手工构造 `{key:"qfmodel"}` 形状的条目直测纯函数，把它完整掩盖了；真链路发给上游的是字符串 `"undefined"`（`model_config.key`、`x-model-key`、以及由它派生的 session/record id 全污染），只有 smoke 走「`_resolveEntry` 产物喂 chat」才抓到。修法是 `_resolveEntry` 归一化时浅拷贝补 `key`（不动缓存对象）。**同一族的错位仍在**：`qoderBody` 还读顶层 `modelEntry.is_reasoning` / `is_vl`，而条目把能力放在 `capabilities.{reasoning,images}` 下，静态兜底路径上这两个字段恒 false——是否要在归一化处一并补齐属未裁定项，先记事实不记设计。
2. **catalog 合并不得把上游真值覆盖成展示 id**：`modelEntries()` 的 catalog 分支一度写成 `{...m, _key: String(m.id)}`，把 `fetchModels` 写回的真实 `_key`/`_efforts` 抹平，等于「拉一次模型目录之后 qoder 就打不通」；现按 `upKey = m._key || m.id` 保留。教训是：**写回磁盘的内部字段与展示字段共存于同一条目时，合并侧只能补空不能覆盖**，且夹具必须真跑一次 `rules.init()` 落盘再断言，否则这类错只在装配路径上出现。

## 九 明确不做（YAGNI）

- **CatPaw**（后置一期）
- **autoclaw 国内短信登录**：参考项目有实现，但用户裁定本渠道只做粘贴 + 导入；两个 HTTP 调用的量级，二期要加随时可加
- **内容拦截降级状态机**（参考项目 ContentBlocked 的中性提示词重试）：AgentHub 无此机制，v1 只 emit 502 不进 `planLimit` 冷却档（单次不罚号，连续 3 次才走通用 5xx 熔断，见 §四）
- **driver 注册表重构**（设计文档 §九预留方向）：为 3 家生态提前重构收益不划算
- **参考项目协议精修**（/v1/responses freeform 工具降级等）：入站三条线零改动
- **cline 余额/订阅接口**、qoder quota 展示、autoclaw 积分等管理面扩展：三家一律不定义 `queryCredits`，号池展示够用即可。**连带效应必须知道**：`credits.cjs` 靠这个方法缺席整渠道跳过，而临期预刷新只有那一个触发点，所以新渠道也就没有主动刷新（§二）
- 实现回写 2026-09-23 追加的裁剪（都是「规格写了、实现按 YAGNI 或按结构事实没做」）：**SSE model 逐帧回写**（出线帧的 model 由 sink 自构，无处可使，见 §三）、**autoclaw 远程模型目录**（§六）、**qoder 目录按地区分节 + 1h 缓存**（§六/§一）、**autoclaw refresh_token 每小时温刷**（§三）、**`proxy_oauth_captcha_config` / `_continue` 两条新 IPC**（复用 `proxy_oauth_begin` 两跳，§5.3）、**粘贴面板的 qoder 地区选择器与 autoclaw device_id 字段**（`proxy_account_add` 不写 meta，§5.1）、**qoder 扫描导入源**（§5.2）、**UI 四语文案**（前端无 i18n 设施，§七）

## 十 风险登记

1. **上游闸门新鲜**（2026-09-22）：X-Harness-Type 禁发、system 白名单随时可能再变；指纹头集中在适配器常量，跟进成本可控
2. **AutoClaw appId/appKey** 是客户端内嵌指纹，泄露面与参考项目等同（公开仓库已含）。实现回写 2026-09-23：全仓只存 `adapters.cjs` 一处常量，国际版 OAuth 的签名头族不复制第二份，而是委托 `adapters.get("autoclaw_intl")._userapiHeaders(token)`——两处各写一份密钥与 MD5 公式迟早漂
3. **COSY 无官方测试向量**：三层断言 + 真机联调兜底；签名错只报「签名不匹配」难排查——实现顺序**先 `encodeBody` 后 `buildCosyHeaders`** 已按硬约束落定（adapters.cjs:2272 的注释与 smoke 的逆变换互拍各自钉住一次）。遗留：`fetchModels` 走 GET 时的验签形态（编码体是 `{region}` 小对象）只有真机能判，假上游不校验签名
4. ~~Electron safeStorage 解外部 DPAPI blob 的兼容性未验证~~（实现回写 2026-09-23：选型已改道，风险换了一条）：运行时只走 koffi `CryptUnprotectData` 单路径，safeStorage 不接入。新风险是**真实 `auth.json` 的 os_crypt 版本/结构**——闸用的是自造夹具（真 DPAPI round-trip + 手工 AES-GCM），只证明算法链通，不证明 AutoClaw 落盘形态与协议参考 §2.7 一致；`v10` 之外的版本号会直接抛「不支持的 os_crypt 版本」。真机首验必须包含一次真实导入
5. **AliyunCaptcha SDK** 依赖外域脚本与官方 scene 配置：SDK 失效时滑块弹不出，回落「粘贴 token / 导入本机登录态」两条通路都在。实现回写 2026-09-23：CSP 已按 §5.3 的窄清单放行（不给 `*.aliyuncs.com` 通配，理由同处）；SDK 侧 `onError` + 120s 超时把失败落成可读文案并退出等待态，不会挂死；预览态用假 sceneId 实测过 `INIT_FAIL` 分支，**滑块成功弹层 → 二次调用 → 开浏览器这条快乐路径没有真账号无法核验**
6. **cline 免费池 403 文案**是产品面拦截而非配额：UI 提示语要引导「订阅或换模型」而不是「账号失效」。实现回写 2026-09-23：403 走 Fatal 档不判 relogin、不改写文案（上游 message 原样到客户端，server.cjs:585 用 emit 的 status），所以不会误报「账号失效」；但「引导订阅或换模型」这句本网关不代写，展示的就是上游那句英文 ENTITLEMENT 提示——真要中文化得另开一条按 status+code 的文案映射

## 十一 触及文件清单

实现回写 2026-09-23：按最终提交集（`b074c01..HEAD`，21 个文件 +5809/−48）修正原清单——

- 改：`electron/backend/proxy/store.cjs`（`BUILTIN_CHANNELS` 5 行）、`adapters.cjs`（`ADAPTERS` 9 家 + 3 组工厂/适配器 + 10 个下划线测试窥视口（`_clineErrorStatus` / `_pickClineModels` / `_autoclawSign` / `_autoclawResolveRoute` / `_qoderClassify` / `_qoderIds` / `_qoderBody` / `_qoderUnpack` / `_qoderMachineId` / `_TagSplitter`）、`discovery.cjs`（2 个 scan 源 + `beginOAuth` 扩三参 + 设备流×2 + 回环回调流×1 + 共用落库 `saveDiscoveredAccount` + 3 个窥视口）、`index.cjs`（**只扩 1 个既有 IPC**：`proxy_oauth_begin` 入参加 edition/vendor/captchaVerifyParam、出参加 userCode/needCaptcha/captcha；**没有新增 IPC，preload 白名单未动**）、`rules.cjs`（新渠道目录的静态兜底写在这里 = 原清单写的 `rules/catalog.json`）、`src/types/index.ts`（`ProxyBuiltinChannelId` 9 个字面量）、`src/api/ipc.ts`（`proxyOauthBegin` 扩参/扩返回类型）、`src/api/mock.ts`（`proxy_oauth_begin` 按渠道真实 mode 分支 + 预览号池补 5 张卡）、`src/views/proxy/ProxyAgentsView.vue`（登录面板 / 滑块 / 设备码 / edition / 粘贴提示 / 三张文案表）、`index.html`（**CSP 为滑块加窄域清单**，原清单漏了这一项）、`scripts/dev-provider-test.cjs`（渠道数断言去掉硬编码 5）、`tools/proxy-smoke.cjs`（假上游 4 分支 + 5 场景）、`scripts/fixtures/gateway-sink-baseline.json`（黄金基线重录，理由见 §八）
- 新：`clineAuth.cjs`、`autoclawCredentials.cjs`、`autoclawPrompt.cjs`、`qoderCosy.cjs`、3 个 `dev-*-test.cjs`
- 不动：`protocols/*`（内部规范形与三条出线零改动——§三 cline 的「model 回写」不成立正因为这里不用改）、`server.cjs` 调度核心、`pool.cjs`、`provider.cjs`（保留名经 `BUILTIN_IDS` 自动生效）、`credits.cjs`（新渠道无 `queryCredits`，靠既有缺席判据跳过）、`ProxyPoolSyncView.vue`（见 §七 那处例外，本期未动）
