# 网关新增 Cline / AutoClaw / Qoder 渠道设计

> 日期：2026-09-22　分支：`gateway-new-providers`
> 参考：github.com/aimod-cc/agent2api（Rust/Tauri）。协议常量唯一依据：同目录 `2026-09-22-new-providers-protocol-ref.md`（下称「协议参考」，引用格式 §1.2 = 其第一章程 1.2 节）。
> 前置文档：`2026-09-22-gateway-custom-providers-design.md`（自定义提供商机制，本文不重复其约束）。

## 〇 背景与目标

AgentHub 网关目前的上游覆盖：4 条内置渠道（trae / workbuddy / workbuddy_ai / raccoon，桌面客户端登录态型）+ 自定义提供商（openai_compat / anthropic_messages，API Key 型）。参考项目 agent2api 与本网关提供商集合几乎不重叠，其独有的是 6 家桌面客户端生态，其中 2 家（workbuddy、raccoon）已内置。本设计补齐其余 3 家生态、5 条渠道：

| 渠道 id | 生态 | 登录形态 |
|---|---|---|
| `cline_free` / `cline_pass` | Cline 官方（同一账号的两个额度池） | WorkOS 设备授权（网页）+ 粘贴 + 导入 `~/.cline` |
| `autoclaw` | 智谱 AutoClaw 国内 | 仅粘贴 + 导入 `%APPDATA%/AutoClaw/auth.json`（官方无网页 OAuth） |
| `autoclaw_intl` | 智谱 AutoClaw 国际 | Zai/Google OAuth（阿里云滑块）+ 粘贴 |
| `qoder` | 阿里 Qoder（国际/中国跟账号走） | PKCE 设备授权（网页）+ 粘贴 |

明确后置：CatPaw（有状态会话协议，工作量最大，单独一期）。

## 一 渠道建模

**`store.cjs` `BUILTIN_CHANNELS` 增 5 行**，`adapters.cjs` `ADAPTERS` 增 3 个条目（工厂展开）：

- `cline_free` / `cline_pass`：`makeCline(pool)` 工厂产两个静态实例（仿 `makeWorkBuddy(channelId)`）。拆两条而非一条加参数，理由同参考项目（协议参考 §1.8）：池过滤是渠道身份属性、模型启停键 `(渠道, 模型)` 互不影响、同名模型（deepseek-v4.1-flash 两池都有）短名归属不漂移；且与 workbuddy/workbuddy_ai 先例一致。
- `autoclaw` / `autoclaw_intl`：`makeAutoClaw(region)` 工厂，域名/账号 id 前缀（`user-` / `intl-user-`）随地区，头集合与签名两地逐字相同。
- `qoder`：单渠道。地区跟账号走，存 `accounts.meta.mode = "global" | "cn"`（meta 列已存在，store.cjs:140 在线迁移先例）；四组域名内置切换（协议参考 §3.1），模型目录按地区分开缓存、调度时取并集。

新渠道 id 经 `BUILTIN_IDS` 自动进保留名保护、自动出现在 `channelList()` / 号池页 / `/v1/models`（`mergedModels()` 遍历 `ADAPTERS`，零改动）。

## 二 适配器结构

每家一个对象，**raccoon 模板**（adapters.cjs:1427）：`models()` / `fetchModels()` / `rewriteBody()` / `chat({account,secrets,model,body,emit,meta})` / `refreshToken()` / `userInfo()`；有余额接口的补 `queryCredits()`（credits.cjs 靠缺席跳过，没有的不造假）。全部走既有 emit 四词汇（delta/usage/finish/error）、强制 `stream:true`、非流式 Aggregator 聚合、401 → `refreshTokenLocked` 单飞。

加密与凭证助手独立成模块（仿 `raccoonAuth.cjs` 先例，不继续膨胀 adapters.cjs）：

| 新模块 | 职责 |
|---|---|
| `clineAuth.cjs` | JWT 解析（uid 取 `external_id` 声明，`sub` 不可用）、`ensure_token_prefix`（幂等补 `workos:`）、展示名拼装（CJK 姓前） |
| `autoclawCredentials.cjs` | safeStorage 解密链：`Local State` → `os_crypt.encrypted_key`（剥 `DPAPI` 5 字节）→ CryptUnprotectData → 32 字节 AES key；`enc:` 字段 = `v10` + 12B nonce + AES-256-GCM（无 AAD，tag 后置）；`strip_bearer` |
| `autoclawPrompt.cjs` | system 白名单改写：五条外来身份句替换（长串在前）+ 身份前缀注入（幂等判据 `starts_with`，协议参考 §2.4） |
| `qoderCosy.cjs` | COSY 签名全套：身份 JSON 手写键序、AES-128-CBC（key=iv 同 16 字节）、RSA-1024 PKCS#1 v1.5（node:crypto `publicEncrypt` 从模数+指数构 JWK）、自定义 base64（含 `'=' → '$'`）、`encode_body` 三步变换、MD5 拼接签名 |

**DPAPI 实现选型**：优先 Electron `safeStorage.decryptString`（Windows 上同为 CryptUnprotectData 无 flags，应可解外部 Chromium blob），真机 `auth.json` 验收；不兼容再降级 koffi 声明 `CryptUnprotectData`。**先写探针脚本验证选型再动手**（风险登记 §十）。

**指纹头配置**：三家头常量写死在各自适配器内（参考项目同款内置做法），不进 `rules/headers.json`——那是热加载的渠道 UA 规则文件，v1 没有热调需求；后续上游改指纹再迁。

## 三 协议要点（细节一律看协议参考）

### cline（§1）
- 基址 `https://api.cline.bot/api/v1`（单层 v1）；body **完全透传**，唯一改写是 model 带池前缀原样发（`cline-free/deepseek-v4.1-flash`，前缀是计费通道选择器，剥掉 404）
- 头：`Authorization: Bearer workos:...`（**前缀必须**）+ `X-CLIENT-TYPE: cline-sdk`（**缺它免费池全 403**；`cline-cli` 值走兼容路径回 500，禁用）
- 刷新：`POST /auth/refresh`，body `{"refreshToken":...,"grantType":"refresh_token"}`（**camelCase**）；响应 accessToken **不带前缀**（入库前统一补）、`expiresAt` 是 ISO 字符串；临期窗口 10 分钟
- SSE：标准 OpenAI chunk 直透，但上游回内部模型名 → **逐帧 model 回写**；思考增量是 `delta.reasoning`（OpenRouter 形），不改名透传

### autoclaw（§2）
- LLM 域头：**`X-Authorization: Bearer`（不是 Authorization）**、`X-Product/X-Client-Type/X-Tm/X-Version/X-Lang/X-Channel/x_trace_id/X-Request-Id/X-Request-Model`；**chat 路径禁发 `X-Harness-Type: zcode`**（2026-09-22 起稳定 403/406）；userapi 域保留 `X-Harness-Type` 且加签名头
- userapi 域签名：`X-Auth-Sign = MD5("100003&{秒级时间戳}&38d2391985e2369a5fb8227d8e6cd5e5")` 小写 hex；`X-Auth-TimeStamp` 是**秒**
- 模型：`X-Request-Model` 发完整路由 id（`zaicoding_glm-5.3` 等），body.model 发剥前缀名；解析顺序 目录→远程→已知前缀→合法形态→兜底 `zai_auto`
- **system 白名单闸门**（2026-09-22 起）：首条 system 必须以身份句开头且带 `## Tooling` 段，否则 403/406——出线侧统一走 `autoclawPrompt.cjs` 改写（替换外来身份句 + 前缀注入，幂等）
- 刷新：`POST {userapi}/userapi/v1/refresh`（400002 降级 `/agent-refresh`），body 带 `device_id`（JWT `device_id` 声明）；临期窗口 5 分钟 + 每小时无条件强刷（「温着」refresh_token，服务端会轮换）

### qoder（§3）
- chat：`POST {gateway}algo/api/v2/service/pro/sse/agent_chat_generation?...&Encode=1`，鉴权是 **COSY 自签名**（非 Bearer）
- **先 `encode_body` 后签名**（签的是编码后字节，顺序颠倒只报「签名不匹配」无从排查）
- 请求体是固定业务信封（非 OpenAI 形）：messages 规整（system 置顶、`__failed` 轮次丢弃、assistant 纯 tool_calls 补 `" "`）、`model_config` 精简版（剥 `thinking_config`）、`parameters.enable_thinking` 只在开思考时发（发 false 会混流）、会话/记录 id 用 sha256 派生（协议参考 §3.4 有公式）
- SSE：**HTTP 恒 200**，信封 `{statusCodeValue, body:"<内层JSON字符串>"}` 双层解析；usage 取最后一帧；思考可能以 `<thinking>` 类标签混在 content，需跨分片状态机；流结束必须冲刷尾行
- 错误：带 `pricingUrl`/额度关键词 → 402（换号）；裸 403 → 401（刷新）；`"code":112` → 402

## 四 错误分类 → AgentHub 既有链路映射

参考项目的「四档」收敛到 AgentHub 现有两条件发射：

| 上游语义 | 参考项目档位 | AgentHub 动作 |
|---|---|---|
| 限额/额度/风控（429、pricing、quota 关键词、autoclaw 429） | QuotaLimited | **emit 402**（走既有「切号 + planLimit 冷却」链路；raccoon 同款：只有 402 进这条链） |
| token 失效（401、autoclaw 410000、裸 403[qoder]） | TokenExpired | **emit 401**（`refreshTokenLocked` 单飞刷新后同账号重试） |
| 确定性拒绝（cline 403 ENTITLEMENT/API_REQUEST、404） | Fatal | **原状态透传，不冷却账号**——cline 403 刻意不当限额：换号同样 403，冷却只是把确定失败变静默跳过 |
| 内容拦截（三段文案判定，协议参考 §〇） | ContentBlocked | **v1 透传，不罚账号**（AgentHub 无中性提示词降级状态机，见 §九） |

## 五 凭证通路

### 5.1 粘贴（现成 IPC，零新增）
`proxy_account_add(channel, name, token, refreshToken, uid)`。各家字段提示：
- cline：token 自动补 `workos:` 前缀；refreshToken 可选（无则到期重登）
- autoclaw：token / refreshToken / deviceId（进 `meta`）；粘贴 `enc:` 原值走同一条解密链
- qoder：refreshToken 粘**打包串**（`pat|...|userId|machineId` 5 段 或 `oauthRT|userId|machineId` 3 段，协议参考 §3.7）；region 在表单选，落 `meta.mode`

### 5.2 扫描导入（`discovery.cjs` 增源，挂进 `scanAll()`）
- **scanCline**：`~/.cline/data/settings/providers.json` → `providers.cline.settings.auth`；uid 取 JWT `external_id`；**落库快照**（AgentHub 号池按账号记账，与参考项目「不落 token 实时读盘」架构不同，不做 desktop 指针模式）。防顶掉：cline 刷新前**重读文件取最新 refresh_token**（raccoon 同款），刷新成功**不回写文件**（参考项目实证：两边都轮换会互相顶掉）
- **scanAutoClaw**：`%APPDATA%/AutoClaw/auth.json`（解密链，文件防御：普通文件、≤256KB、JSON 对象根）+ 备来源 `~/.openclaw-autoclaw/openclaw.json`（明文 X-Authorization，无 refreshToken → 标注不可刷新）。**只导 `autoclaw`（国内）渠道**：auth.json 无地区标记，参考项目门禁同款（`local_credentials()` 对非 Cn 拒绝）。刷新成功只更号池行，**不回写 auth.json**（回写需同一把 os_crypt 密钥重新加密，且参考项目桌面来源也不回写）；刷新前重读文件、mtime 更新则以文件为准
- **scanQoder**：无桌面登录态可扫（参考项目只读 machine_id），v1 不提供扫描，引导网页登录/粘贴

### 5.3 网页 OAuth（`discovery.cjs` `beginOAuth` 增分支）
- **cline（设备流，新 session 类型 `mode:"device"`）**：`POST api.workos.com/user_management/authorize/device`（body 仅 `client_id=client_01K3A541FN8TA3EPPHTD2325AR`）→ 拿 `verification_uri_complete`（**免手输码**）交前端打开 + `userCode` 兜底展示 → 按 `interval`（5s，`slow_down` +1s）轮询 `authenticate`（400 `authorization_pending` 继续）→ 成功后**必做** `POST api.cline.bot/api/v1/auth/register`（头带 `X-CLIENT-TYPE: cline-sdk`）换 Cline 会话令牌 → 落库（两池入口同构，账号落用户点的那条渠道）
- **qoder（PKCE 设备流，同 `mode:"device"`）**：无起始请求，本地拼授权页 `{web_origin}/device/selectAccounts?challenge=S256(verifier)&challenge_method=S256&machine_id=&nonce=`；verifier 只留后端；2s 轮询 `{open_api}/api/v1/deviceToken/poll`（**202/404 = 继续**）→ 成功拿 token 集 → userinfo 补资料 → 落库 `meta.mode`。UI 登录入口给「国际版 / 中国版」二选
- **autoclaw_intl（OAuth + 滑块，唯一走回调的）**：三步——① renderer 加载阿里云官方 SDK（`o.alicdn.com/.../AliyunCaptcha.js`，先设 `window.AliyunCaptchaConfig={region,prefix}`；CSP 放行 `o.alicdn.com`/`*.alicdn.com`），滑块回调拿 `captchaVerifyParam`；② 主进程 `POST {intl}/userapi/overseasv1/{zai|google}-oauth-url`（带 captcha 参数）拿 `oauth_url`，`navigate_uri` 指向 discovery 回环服务新路径（**上游不校验回调主机**，实测只非空校验）；③ 系统浏览器完成登录 → 302 回环 → **换码必须用查询串里上游回的 `state`，路径里的是我们的任务 state（双 state 陷阱）** → `oauth-login` 换 token → 落库 `meta.deviceId`
- **autoclaw（国内）**：`beginOAuth` raccoon 式明确提示不支持（官方无网页 OAuth，短信息入口参考项目有但本期不做，见 §九）
- 超时/取消/单会话沿用 `oauthSession` 生命周期；设备流无回调地址可粘，`submit` 给明确提示（workbuddy 同款）
- 新增 IPC：`proxy_oauth_captcha_config`（读滑块配置）与 `proxy_oauth_captcha_continue`（交 `captchaVerifyParam` 换授权 URL）；事件面 `oauth-done` 复用

## 六 模型目录

- `rules/catalog.json` 增三家静态兜底（自参考项目静态表移植：cline 两池分组、autoclaw 路由表、qoder global 17 条/cn 10 条含 upstreamKey/思考档位/倍率快照）
- `fetchModels()` 拉远程：cline `GET /ai/cline/recommended-models`（免鉴权，按 `{recommended,free,clinePass,clineCloud}` 分组归池——**归池看分组不看前缀**，free 组混有裸名条目；clineCloud 组 403 不收录）；autoclaw `GET .../autoclaw-model-config`（路径藏在 `/proxy/` 一级，桌面端用 `lastIndexOf("/proxy/")` 切）；qoder `GET {gateway}algo/api/v2/model/list?Encode=1`（COSY 签名，信封 `{statusCodeValue, chat:[...]}`，按地区缓存 1h、两区并集、global 优先）
- `/v1/models` 聚合零改动；cline 对外模型名带池前缀

## 七 UI 增量

- 渠道卡片 / 号池页 / 扫描导入列表随 `BUILTIN_CHANNELS`/`scanAll()` 自动出现
- 登录按钮：`mode:"device"` 结果带 `{url, userCode}` → 前端弹窗展示「打开授权页 + 验证码」；`proxy_oauth_begin` 返回值增 `userCode` 字段
- autoclaw_intl 登录：先弹滑块（renderer 内嵌 element + 1×1 触发按钮，初始化后至少等 2.1s 再 click）
- 粘贴表单按渠道给字段说明与占位符；i18n 走项目现成机制补四语

## 八 测试

沿用 `scripts/dev-*-test.cjs` 独立断言脚本模式（文件头注释写跑法；探针隔离硬规则：require 产品代码前把 `APPDATA` 指到 `mkdtemp`；端口 19530-19572 段）：

- `dev-cline-test.cjs`：池前缀透传/剥前缀规则、错误分类表（401→刷新、429→402、**403→Fatal 不冷却**、404→Fatal）、SSE model 回写、displayName 拼装、设备流轮询状态机（pending/slow_down/expired/denied 假上游）
- `dev-autoclaw-test.cjs`：两套头集合逐字断言（**chat 无 X-Harness-Type、userapi 有**）、X-Auth-Sign 公式（已知输入→已知 MD5）、模型路由解析顺序、system 白名单改写幂等性（改写→再改写不变）、safeStorage 解密链（自造夹具：koffi `CryptProtectData` 造 DPAPI blob + 手工 AES-256-GCM 造 `enc:` 字段）、错误分类
- `dev-qoder-test.cjs`：**COSY 签名**——无官方测试向量，用三层断言：结构断言（cosy_key 定长 128 字节、PS 非零、payload 可解码回原 JSON）、可逆性（AES 自加密自解密、RSA 公钥加密后无法逆向但长度/布局校验）、字段布局（MD5 拼接顺序固定串对照）；`encode_body` 三步变换已知输入输出对照；信封双层解析、usage 末帧、thinking 标签跨分片状态机（`<thi`+`nking>` 切片用例）、错误分类（pricing→402 / 裸 403→401）
- `tools/proxy-smoke.cjs` 增三家假上游全链路（各一条 golden 请求 + SSE 流）
- 真机联调：三家各配一个真实账号手工过一遍（登录/导入→对话→额度→断流重连），作为验收步骤写进实现计划

## 九 明确不做（YAGNI）

- **CatPaw**（后置一期）
- **autoclaw 国内短信登录**：参考项目有实现，但用户明确本渠道只做粘贴+导入；两个 HTTP 调用的量级，二期要加随时可加
- **内容拦截降级状态机**（参考项目 ContentBlocked 的中性提示词重试）：AgentHub 无此机制，v1 透传不罚账号
- **driver 注册表重构**（设计文档 §九预留方向）：为 3 家生态提前重构收益不划算
- **参考项目协议精修**（/v1/responses freeform 工具降级等）：入站三条线零改动
- **cline 余额/订阅接口**、qoder quota 展示等管理面扩展：号池展示够用即可，未列入

## 十 风险登记

1. **上游闸门新鲜**（2026-09-22）：X-Harness-Type 禁发、system 白名单随时可能再变；指纹头集中在适配器常量，跟进成本可控
2. **AutoClaw appId/appKey** 是客户端内嵌指纹，泄露面与参考项目等同（公开仓库已含）
3. **COSY 无官方测试向量**：三层断言 + 真机联调兜底；签名错只报「签名不匹配」难排查——实现顺序必须先 encode 后 sign
4. **Electron safeStorage 解外部 DPAPI blob** 的兼容性未验证：探针先行，备选 koffi `CryptUnprotectData`
5. **AliyunCaptcha SDK** 依赖外域脚本与官方 scene 配置：SDK 失效时滑块弹不出，回落「粘贴 token」通路（文档引导）
6. **cline 免费池 403 文案**是产品面拦截而非配额：UI 提示语要引导「订阅或换模型」而不是「账号失效」

## 十一 触及文件清单

- 改：`electron/backend/proxy/store.cjs`（BUILTIN_CHANNELS）、`adapters.cjs`（ADAPTERS + 3 组适配器/工厂）、`discovery.cjs`（3 个 scan 源 + beginOAuth 三分支 + 设备流/回调 session）、`electron/backend/proxy/index.cjs`（2 个 captcha IPC）、`rules/catalog.json`、`src/views/proxy/*`（登录弹窗/表单提示）、i18n
- 新：`clineAuth.cjs`、`autoclawCredentials.cjs`、`autoclawPrompt.cjs`、`qoderCosy.cjs`、3 个 `dev-*-test.cjs`
- 不动：`protocols/*`（内部规范形与三条出线零改动）、`server.cjs` 调度核心、`pool.cjs`、`provider.cjs`（保留名经 BUILTIN_IDS 自动生效）
