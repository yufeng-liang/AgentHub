# Cline / AutoClaw / Qoder 上游协议参考（自 agent2api 提取）

> **来源**：github.com/aimod-cc/agent2api（Rust/Tauri）本地浅克隆 `desktop-tauri/src-tauri/src/server/core/`，2026-09-22 提取。
> **地位**：本文档是「网关新增 Cline / AutoClaw / Qoder 渠道」实现的上游协议唯一依据；所有常量（client_id、appKey、RSA 模数、base64 字母表、端点 URL、头部名）均逐字取自源码并标注行号。
> **复验**：承重常量已与源码逐字抽查比对通过（cline client_id/设备端点、autoclaw X-Authorization/签名常量、qoder RSA 模数/自定义字母表/chat URL/enc: v10/machine_id 路径）。
> **时效**：含 2026-09-22 当天生效的两道上游闸门（AutoClaw chat 禁发 `X-Harness-Type: zcode`、system 白名单）；参考项目同日已适配，属最新语义。
>
> - 第一章 Cline（free/pass 两池）——端点、鉴权、刷新、SSE、错误分类、导入
> - 第二章 AutoClaw（国内/国际）——两套头集合、签名、模型路由、safeStorage 解密链、地区差异
> - 第三章 Qoder——COSY 签名完整算法、信封 SSE、地区选择、刷新串格式
> - 第四章（登录流程）Cline WorkOS 设备流 / Qoder PKCE 设备流 / AutoClaw 国内短信+国际 OAuth+阿里云滑块
> - 文末：源码中「未找到」的项与三处高频翻车点


===== 以下为第一份提取报告（chat/刷新/导入/签名） =====

所有源码已核对完毕。以下是完整的结构化报告。

---

# Agent2API 三家提供商上游协议规格（供 Node.js 重新实现）

**源码根**：`C:\Users\15778\AppData\Local\Temp\agent2api-ref\desktop-tauri\src-tauri\src\server\core\`（下文以 `providers/...`、`upstream/...` 缩写，行号均为该克隆内实际行号）

## 〇、公共编排约定（实现前必读）

来自 `providers/adapter.rs`（147-187 行）与 `upstream/provider_loop.rs`。错误只有四档，每档对应一个编排动作：

| 分类 | 判定 | 动作 |
|---|---|---|
| `QuotaLimited` | 限额/风控 | 标记该账号对该模型冷却 + 换下一个账号（冷却键 = 发给上游的**真模型名**，provider_loop.rs:846-856） |
| `TokenExpired` | 401/token 失效 | 刷新凭证后**同一账号**重试一次（仅一次，provider_loop.rs:771-821） |
| `ContentBlocked` | 内容策略拦截 | **不罚账号**：换中性提示词后同账号立即重试一次 + 触发降级状态机（provider_loop.rs:737-760） |
| `Fatal` | 其余 | 原样透传给客户端 |

补充（provider_loop.rs:159、210-227）：
- 瞬时状态码 `408/500/502/503/504`：按全局重试设置原地重发（**不含 429**——429 走换号）。
- `Fatal` 且非内容拦截：换账号前也先原地重发一次（`fallback_retry_advice`）。
- 传输层失败（DNS/代理/连接）同样按全局设置退避重发，用尽收敛 502。
- `ContentBlocked` 首次出现时跳过所有退避（同字节重发必然再撞），直接进动作 0。

**内容拦截共用判定**（`providers/content_block.rs`:39-74）：HTTP 状态 ≥ 400 且归一化 message（小写后）包含以下任一子串：
```text
blocked by security policy
unapproved channel
illegal api invocation
```
命中即 ContentBlocked，message 后附加提示常量 `CONTENT_BLOCK_HINT`（content_block.rs:60-62）。

---

# 第一章 Cline（`cline-free` / `cline-pass` 两家）

## 1.1 端点清单（全部只有一个变体，无国内/国际之分）

基址 `API_BASE_URL = "https://api.cline.bot/api/v1"`（credentials.rs:52）。注意路径只有**一个** `v1`：上游用 AI SDK 的 `createOpenAICompatible`，把 baseURL 当根拼（adapter.rs:4-8；拼成 `/api/v1/v1/...` 实测 404 `{"error":"Not Found"}`）。

| 用途 | 方法 + 完整 URL | 源码 |
|---|---|---|
| chat 补全 | `POST https://api.cline.bot/api/v1/chat/completions` | adapter.rs:183 |
| 模型列表 | `GET https://api.cline.bot/api/v1/ai/cline/recommended-models`（**无需鉴权**，实测无 Authorization 也 200） | models.rs:432-435 |
| 刷新令牌 | `POST https://api.cline.bot/api/v1/auth/refresh` | refresh.rs:5, 170 |
| 余额 | `GET https://api.cline.bot/api/v1/users/{userId}/balance`（userId 是 `usr-...` 形态） | balance.rs:123-133 |
| 订阅 | `GET https://api.cline.bot/api/v1/users/me/plan`（**没订阅时 404 是正常状态**） | balance.rs:141 |
| 用户信息（兜底取 userId） | `GET https://api.cline.bot/api/v1/users/me` → `data.id` | balance.rs:104 |
| 设备授权·发起 | `POST https://api.workos.com/user_management/authorize/device`，body `client_id=client_01K3A541FN8TA3EPPHTD2325AR`（x-www-form-urlencoded） | login.rs:86-95, credentials.rs:69 |
| 设备授权·轮询 | `POST https://api.workos.com/user_management/authenticate`，body `grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=...&client_id=...` | login.rs:226-233 |
| 设备授权·换会话 | `POST https://api.cline.bot/api/v1/auth/register`，body `{"accessToken":...,"refreshToken":...}`（**不能省**：WorkOS 令牌要换成 Cline 自己的带 `workos:` 前缀会话令牌） | login.rs:23, 327-352 |

WorkOS 轮询语义：200 → `{access_token, refresh_token}`；400 `{error:"authorization_pending"}` 继续；`slow_down` 间隔 +1s；`expired_token`/`access_denied` 终止（login.rs:274-316）。

## 1.2 鉴权

chat 请求头（adapter.rs:164-181，逐字）：

```
Content-Type: application/json
Accept: text/event-stream
Authorization: Bearer <token>          ← token 必须含 "workos:" 前缀（TOKEN_PREFIX, credentials.rs:75；去掉前缀实测 401）
X-CLIENT-TYPE: cline-sdk               ← 关键！缺它免费池模型一律 403 "only available via Cline product surfaces"（adapter.rs:11-15, 86-91）
User-Agent: Cline/3.0.62               ← 非必需但建议
X-CLIENT-VERSION: 3.0.62
HTTP-Referer: https://cline.bot        ← OpenRouter 风格来源标记
X-Title: Cline
```
取值 `cline-sdk` 而非 `cline-cli`：后者走另一条兼容路径回 500（adapter.rs:89-90）。token 类型：WorkOS 签发的 RS256 JWT。余额/目录等管理接口**实测不需要** X-CLIENT-TYPE，但实现统一带上（balance.rs:63-67）。

## 1.3 刷新流程（refresh.rs:3-15, 167-252）

请求：`POST {API_BASE_URL}/auth/refresh`，头 `Content-Type: application/json` + `Accept: application/json`，超时 30s。**无签名头**。

请求体（注意 `grantType` 是 camelCase，不是 OAuth 标准的 `grant_type`，源实现 `@cline/core` 就发这个键名）：
```json
{"refreshToken":"<rt>","grantType":"refresh_token"}
```

响应（信封）：
```json
{"data":{"accessToken":"eyJ...（裸 JWT，不带 workos: 前缀）","refreshToken":"<可能同一值，协议允许轮换>","expiresAt":"2026-09-19T19:30:04Z","tokenType":"Bearer","userInfo":{...}},"success":true}
```
三个实测口径（refresh.rs:17-25）：
1. 返回的 accessToken **不带** `workos:` 前缀（登录返回的带），写入/发送前统一过 `ensure_token_prefix`（幂等补前缀，credentials.rs:176-186）；
2. `expiresAt` 是 **ISO 8601 字符串**（与桌面端 providers.json 的毫秒数字是同名不同型，解析两者都要认，refresh.rs:262-279）；
3. HTTP 401/403 = refreshToken 被拒（登录态失效，需重新登录）；其余非 2xx 错误体是 `{"error":"...","success":false}` 或 `{"error":{"code":..,"message":..}}` 两种形态。

刷新后轮换字段：`accessToken`（补前缀）、`refreshToken`（响应缺失时沿用旧值）、`expiresAt`（解析失败回落 JWT `exp`×1000）、展示 account 优先 `userInfo.email`。单飞键 = `文件:账号id:access指纹:refresh指纹`（refresh.rs:139-145）。

**定时刷新参数**：accessToken 有效期实测 1 小时；临期窗口 10 分钟（`PROACTIVE_REFRESH_MARGIN_MS = 10*60*1000`，credentials.rs:109）；「判不出过期时间」的账号按官方口径 25 分钟兜底刷一次（`UNKNOWN_EXP_REFRESH_INTERVAL_MS = 25*60*1000`，credentials.rs:376）。

## 1.4 chat 请求体形态

**body 完全透传**（adapter.rs:139-141, 185：`body.clone()`，不改任何字段）——标准 OpenAI Chat Completions：`messages`/`tools`/`stream`/`temperature` 等全部原样，system 消息不注入不改写，无「默认模型」概念（`supports_default_model=false`）。唯一关键点：**model 参数必须含池前缀原样发上游**（`cline-free/deepseek-v4.1-flash`），前缀是计费通道选择器，剥掉转发 404 `model not found`（models.rs:41-44）。

两池模型名（models.rs:188-207 静态兜底 + 远程刷新）：
- **pass 池**（`clinePass` 组，实测 14 条，id 全带 `cline-pass/` 前缀）：`cline-pass/glm-5.3`、`cline-pass/kimi-k3`、`cline-pass/deepseek-v4.1-flash`、`cline-pass/deepseek-v4-pro`、`cline-pass/qwen3.8-max` 等；
- **free 池**（`free` 组，实测 5 条，**混着无前缀条目**）：`cline-free/deepseek-v4.1-flash`、`cline-free/muse-spark-1.3-contributor`、`cline-free/solar-pro4`，以及裸 id `z-ai/glm-5.3-flash`、`poolside/laguna-s-2.1:free`（这两条同样是免费池成员，**归池必须看响应分组不看前缀**，models.rs:22-29, 483-528）；
- `recommended` 组（4 条，如 `openai/gpt-6-astra`、`moonshotai/kimi-k3`）走 credit 计费（402 余额不足），无池归属；`clineCloud` 组实测 403，**不收录**。

远程目录解析：`{recommended, free, clinePass, clineCloud}` 四个数组，条目字段 `id`/`name`（models.rs:483-528）。

## 1.5 响应与 SSE 形态

**形态不对称**（adapter.rs:18-25）：
- `stream:true` → **裸 `chat.completion.chunk` 帧**，与 OpenAI 逐字同形，可直接透传，不解包。网关总是以 `stream:true` 请求上游。
- 非流式 → 信封 `{"data":{...chat.completion...},"success":true}`，内层才是标准形态（只影响自打非流式调试/管理接口）。

- SSE 帧里的 `model` 是**上游内部名**（实测请求 `cline-free/deepseek-v4.1-flash`，回帧 `model` 为 `deepseek/deepseek-v4.1-flash`，背后走 OpenRouter 类聚合）→ **必须做 model 回写**（`sse_model_rewrite=true`，adapter.rs:26-30, 341-343）。
- 思考增量用 OpenRouter 的 **`delta.reasoning`**（外加 `reasoning_details` 数组），不是 `reasoning_content`；透传时不改名字段（adapter.rs:329-340）。
- usage 在哪一帧：**源码未说明**（未找到；透传语义下跟随上游 chunk 原样携带）。
- SSE 结束标志未特殊处理（走通用 OpenAI `data: [DONE]` 语义）。

**错误体形态**（adapter.rs:32-50）：
```text
401  {"error":"Unauthorized: Please make sure you're using the latest version of Cline and re-authenticate your Cline account."}
403  {"error":{"code":"ENTITLEMENT_ERROR","message":"...not subscribed to required model plan"}}     ← pass 池无订阅
403  {"error":{"code":"API_REQUEST_ERROR_CODE","message":"... only available via Cline product surfaces"}}  ← 免费池缺产品面头
404  {"error":"model not found"}
429  （错误体无结构化恢复时间字段）
500  {"error":"empty response content","success":false}   ← max_tokens 给太小而模型要先输出大段 reasoning，非稳定性问题
```

## 1.6 错误分类（adapter.rs:211-229）

- `401` → **TokenExpired**（强制刷新后同账号重试一次）；
- `429` → **QuotaLimited**（`reset_at=None`，`upstream_code=None`——嵌套 code 是字符串放不进 i64 槽）；
- `403`（两种业务码都算）→ **Fatal，刻意不当 QuotaLimited**：这是「账号×模型」维度的确定性权限拒绝，换账号同样 403，冷却只会把确定失败变成静默跳过；当 Fatal 把 403 文案透给客户端，用户知道该订阅或换模型（adapter.rs:191-202）；
- `404` → **Fatal**（模型名不对，换账号无用）；
- 其余（含 5xx/400）→ 先过内容拦截判定，命中 → ContentBlocked，否则 Fatal。

## 1.7 本机登录态导入

**文件**：`~/.cline/data/settings/providers.json`（`USERPROFILE` 或 `HOME` + `.cline/data/settings/providers.json`，credentials.rs:78, 668-679）。明文 JSON，**不加密**，无 deviceId 之类附加字段，无环境变量旁路。

顶层键路径与字段（credentials.rs:7-20, 478-518）：
```jsonc
{
  "version": ...,
  "providers": {
    "cline": {
      "settings": {
        "auth": {
          "accessToken": "workos:eyJhbGciOiJSUzI1NiIs...",   // 必须 workos: 前缀
          "refreshToken": "N5EUfPqyERlpRhiF4WUXDPunz",
          "expiresAt": 1789842888000,                         // 毫秒时间戳
          "accountId": "usr-01M2VWEDWFWWRS3WQ7R425E817",
          "metadata": {
            "provider": "cline",
            "tokenType": "Bearer",
            "userInfo": { "subject": "user_...", "clineUserId": "usr-...",
                          "email": "...", "name": "...", "firstName": "亮", "lastName": "欧阳" }
          }
        }
      }
    }
  }
}
```

导入要点：
- 展示名：`lastName+firstName` 拼（中文姓在前，按是否含 CJK 字符区分语序）→ `userInfo.name` → `email`（credentials.rs:236-299, 491-507）；
- 账号 id：JWT 声明 **`external_id`**（`usr-...`，即余额路径要的 userId）> `clineUserId` > `sub`（credentials.rs:204-224；`sub` 是 WorkOS 的 `user_...`，**不能**用于 Cline API 路径）；
- `expiresAt` 兜底：JWT payload 的 `exp`（秒）× 1000（credentials.rs:195-202）；
- 存储策略（两种模式）：桌面端导入 = 记录只带 `desktop: true` **不落 token**，每次实时读文件（文件 mtime 变即缓存键 `providers:<mtime>` 失效）；手填/登录 = 记录存 `accessToken`/`refreshToken`/`expiresAt`/`displayName`。桌面端来源**刷新结果不回写文件**（避免与 Cline 客户端互相顶掉），只写进程内比较-再写缓存（refresh.rs:358-442, credentials.rs:520-621）。

## 1.8 Cline 额外：free 池 vs pass 池的本质区别

上游是**同一个账号上的两个额度池**，同端点、同协议、同凭证格式，唯一区别是**模型清单**（见 1.4）。拆成两个 provider 的理由（models.rs:56-75）：
1. 池过滤变成 provider 身份的固有属性（`cline-free` 只列 free 组、`cline-pass` 只列 clinePass 组），与账号状态解耦——「加了 Free 账号才看到 Free 模型」由既有的 provider 可用性口径自然给出；
2. 模型启停规则键是 `(provider, 模型 id)`，两池共用一个 provider 会互相影响同名模型；
3. 同名模型（`deepseek-v4.1-flash` 两池都有）的短名归属不再随账号漂移。
实现是**一套** `ClineAdapter` 按池参数化的两个静态实例（adapter.rs:102-121）；远程目录一次拉回两池、缓存共用、两家各自过滤（models.rs:327-400）。

---

# 第二章 AutoClaw（`autoclaw` 国内 / `autoclaw-intl` 国际）

## 2.1 端点清单（两地区）

域名唯一事实来源 `region.rs:131-144`：

| | 国内（Region::Cn） | 国际（Region::Intl） |
|---|---|---|
| userapi 基址（刷新/积分/签到/登录） | `https://autoglm-acceleration-api.zhipuai.cn` | `https://autoglm-api.autoglm.ai` |
| LLM 代理基址（含尾部 `/autoclaw`） | `https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw` | `https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw` |
| 环境变量覆盖 | `AUTOCLAW_UPSTREAM_BASE_URL` / `AUTOCLAW_USERAPI_BASE_URL` / `AUTOCLAW_DEFAULT_ROUTE` | `AUTOCLAW_INTL_*` 同名三个 |

路径（region 参数只换域名，除订阅外两地路径逐字相同）：

| 用途 | 方法 + 路径 | 源码 |
|---|---|---|
| chat 补全 | `POST {upstream}/chat/completions` | adapter.rs:217-224 |
| 模型目录 | `GET {upstream 砍掉尾部 "/autoclaw"}/autoclaw-model-config`，即 `.../autoclaw-proxy/proxy/autoclaw-model-config`。**注意**桌面端用 `lastIndexOf("/proxy/")` 切（catalog.rs:42-52）；目录藏在 `/proxy/` 一级而不是对话用的 `/proxy/autoclaw` | catalog.rs:55, 264 |
| 刷新 | `POST {userapi}/userapi/v1/refresh`；签名校验失败（`code==400002`）降级 `POST {userapi}/userapi/v1/agent-refresh` | refresh.rs:325-334, credentials.rs:96 |
| 积分钱包 v2 主链路 | `GET {userapi}/agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw` | balance.rs:58 |
| 积分钱包 v1 兜底 | `GET {userapi}/agent-assetmgr/api/v1/wallet-instances?wallet_type=all&wallet_scope=all` | balance.rs:60-61 |
| 即将过期积分 | `GET {userapi}/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw` | balance.rs:63 |
| 订阅（**按地区分叉**） | 国内 `POST {userapi}/agentpay/v1/assistant/subscribe-info`；国际 `POST {userapi}/agentpay/v1/assistant/oversea-subscribe-info`（国际走 Stripe） | balance.rs:75-80 |
| 每日签到 | `POST {userapi}/autoclaw-proxy/proxy/autoclaw-task-complete` body `{"task_id":"daily_signin"}`；任务列表 `GET {userapi}/autoclaw-proxy/proxy/autoclaw-task-list` | checkin.rs:55-61 |
| 短信登录（仅国内） | `POST {userapi}/userapi/v1/agent-send-code`；`POST {userapi}/userapi/v1/agent-login/` body `{"phone","code","platform":"web","source_id","device_id"}`（`platform:"web"` 是网页端与桌面端唯一差别，直接返回 token 对） | login.rs:107-109, 68-75 |
| OAuth（仅国际） | `POST {intl}/userapi/overseasv1/oauth-captcha-config`（阿里云风控，**强制**）；`POST {intl}/userapi/overseasv1/oauth-url`；`POST {intl}/userapi/overseasv1/zai-oauth-login` 或 `google-oauth-login` body `{"code","state","navigate_uri"}` → `data{access_token,refresh_token,user_id,...}`；不带 `ali_captcha_verify_param` 得 `631002 当前版本已停止服务` | oauth.rs:12-26, 79, 128-132 |

## 2.2 鉴权（两套头集合，别混用）

**A. LLM 代理域**（chat 用，adapter.rs:189-206 + 505-515，逐字）：
```
Content-Type: application/json
Accept: */*                          ← 不是 text/event-stream
X-Product: autoclaw
X-Client-Type: pc
X-Tm: win                            ← platformTm()：darwin→mac / linux→linux / 其余 win
X-Version: 1.17.8                    ← DESKTOP_APP_VERSION，进兼容路径判定
X-Lang: zh-CN
X-Channel: official
x_trace_id: autoclaw-desktop         ← 下划线写法照抄源实现，与 X-Request-Id 并存
X-Authorization: Bearer <token>      ← 认证头是 X-Authorization，不是 Authorization！
X-Request-Id: <每次请求新生成>
X-Request-Model: <完整路由 ID>
```
可选透传头（客户端带了才发，adapter.rs:111-115）：`X-Session-Id` ← 入站 `x-autoclaw-session-id`；`X-Agent-Id` ← `x-autoclaw-agent-id`；`X-ZCode-Invocation-Id` ← `x-autoclaw-zcode-invocation-id`。

**关键禁忌**：**不要发 `X-Harness-Type: zcode`**——上游 2026-09-22 起对 chat 路径上这个值区别对待：带上稳定 `403 pay-view`（`code 810001`，"当前使用人数较多…升级为连续包月会员"）或 406（空响应体）；不带或换成 `autoclaw` 都是 200（adapter.rs:33-42, 497-504）。

**B. userapi 域**（刷新/余额/签到/模型目录，refresh.rs:228-267，逐字）：
```
Content-Type: application/json
Accept: */*
X-Product: autoclaw
X-Client-Type: pc
X-Harness-Type: zcode                ← userapi 域保留（实测带着 200），与 X-Auth-Sign 一起构成官方客户端指纹
X-Tm: win | linux
X-Lang: zh-CN
X-Channel: official
X-Auth-Appid: 100003
X-Auth-TimeStamp: <秒级时间戳>
X-Auth-Sign: <md5hex>
X-Trace-Id: <随机请求 id>
authorization: Bearer <token>        ← 小写 "authorization"，token 为空则整条不发
```

## 2.3 刷新流程与签名

**签名公式**（refresh.rs:54-60, 215-234）：
```
AUTH_APP_ID  = "100003"
AUTH_APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5"
timestamp    = 当前秒级时间戳（十进制字符串）
X-Auth-Sign  = MD5("{AUTH_APP_ID}&{timestamp}&{AUTH_APP_KEY}") 的十六进制（小写、无填充，等价 Node digest('hex')）
```
appId/appKey 是 AutoClaw 客户端内嵌指纹，两地逐字相同（region.rs:9-12 实测确认）。

**刷新请求**（refresh.rs:277-319）：`POST {userapi}/userapi/v1/refresh`（**不走账号代理**：userapi 与 LLM 是两个站点），body：
```json
{"refresh_token":"<rt>","source_id":"autoclaw","device_id":"<非空才带>"}
```
**响应处理**（refresh.rs:322-393）：
- `code == 400002`（签名校验失败）→ 换 `/userapi/v1/agent-refresh` 同 body 再试一次；
- 成功判定 `code == 0 && data.access_token 非空`；轮换字段：`data.refresh_token`（缺失沿用旧值）、过期时间按**新 token 的 JWT `exp`**×1000 重算（解不出保留旧值）、`data.access_token` 去 `Bearer ` 前缀；
- 业务码 `410000`（JS 源码里的 `41e4`，注意是 41 万不是 4100 万）或 `401` → 报 401；其余失败 → 502。

**定时刷新参数**：临期窗口 5 分钟（`PROACTIVE_REFRESH_MARGIN_MS = 300_000`，credentials.rs:92，对齐官方 `DESKTOP_REFRESH_AHEAD_MS`）；另有**每小时无条件强制刷新**（`HOURLY_FORCED_REFRESH_INTERVAL_MS = 60*60*1000`，credentials.rs:173，目的是「温着」refresh_token——服务端会轮换，长期不用的那份会被判失效）。刷新结果：桌面端来源只进内存缓存（mtime 变即失效），账号记录来源回写 accounts.json（比较-再写，adapter.rs:583-649）。

## 2.4 chat 请求体形态

body 透传 + 只改两处（adapter.rs:153-165, 207-214）：

1. **`model` 字段换成剥前缀后的模型 ID**，同时发双模型标识（models.rs:10-22）：
   - `X-Request-Model` 头：完整**路由 ID**（带通道前缀）。前缀语义：`zai_` → 会员/按量付费；`zaicoding_` → Coding Plan；`zai_auto` → 服务端自动选型；
   - `body.model`：剥前缀后的模型 ID（`glm-5.3` 等）。
   - 静态路由表（models.rs:165-184）：`glm-5.3` → route `zaicoding_glm-5.3`；`glm-5.3-flash` → route `zai_glm-5.3-flash`。远程目录实测 4 条（多出 `zai_auto`/`zai_auto-fast`，它们剥前缀后 `auto-fast` 不满足路由 ID 形态 `[a-z][a-z0-9]*_[A-Za-z0-9._:-]{1,127}`，必须靠目录解析，models.rs:223-235）。
   - 解析顺序（models.rs:274-333）：目录条目（id/展示名/完整 routeId，忽略 ASCII 大小写）→ 远程目录 → 已知前缀原样透传 → 合法路由 ID 形态透传 → 手动登记的自定义模型透传 → 兜底 `zai_auto`（`AUTOCLAW_DEFAULT_ROUTE` 可覆盖，models.rs:66, 190-194）。
2. **system 提示词规范化**（prompt.rs）：上游 2026-09-22 起的白名单闸门，实测表（prompt.rs:8-18）：
   ```text
   身份句 + "## Tooling" 段                                  → 200
   身份句 + Tooling 段 + 客户端自己的提示词接在后面             → 200
   只有身份句、没有 ## Tooling 段                              → 403 pay-view
   中性句（You are a helpful assistant.）/ 完全没有 system     → 406（空响应体）
   身份句 + "You are ZCode…" / "You are Claude Code…"         → 406
   ```
   出站身份前缀逐字（prompt.rs:68, 74-76）：
   ```
   You are a personal assistant running inside OpenClaw.

   ## Tooling
   Available tools are policy-filtered. Names are case-sensitive; call exactly as listed.
   ```
   处理规则：所有 `system`/`developer` 消息正文里的外来身份句先改写（prompt.rs:87-104 的五条替换，长串在前：`"You are ZCode, an interactive coding agent"`→`"You are an

行代码 `You are an interactive coding agent`，以此类推；`"You are Claude Code"`→`"You are a coding assistant"`）；然后保证首条消息是 system 且正文以身份句开头：是则在原正文前拼前缀（客户端提示词逐字保留在后，前缀 + `\n` + 原文），否则在 `messages[0]` 插一条只带前缀的 system 消息。幂等判据只有 `starts_with("You are a personal assistant running inside OpenClaw.")` 一条，已带则只改写不再前置（prompt.rs:44-56, 115-140, 150-217）。

其余字段：`tools`、`stream`、未知字段全部原样（不做 `anthropic-messages` transport）；图片随 `messages[].content` 原样透传，无压缩改写。

## 2.5 响应与 SSE 形态

- 上游是 OpenAI 兼容 SSE 透传，但上游会回**自己的 model 名**（`zai_auto` 之类）→ 源实现逐帧回写成客户端请求的名字，`sse_model_rewrite = true`（adapter.rs:400-410）；非流式响应体同样回写 `payload.model`。
- usage：源码未做特殊处理（透传 OpenAI 兼容 chunk，usage 随帧原样下发；未找到专门说明）。
- HTTP 语义正常（401/403/404/429 等真实状态码），无业务信封。
- 特殊错误（adapter.rs:33-42）：`403 pay-view`（`code 810001`）= `X-Harness-Type: zcode` 触发；406 空响应体 = system 白名单不满足。

## 2.6 错误分类（adapter.rs:227-275）

- `401` → **TokenExpired**（刷新后同账号重试一次；源实现 `forwardModelRequest` 同款语义）；
- `429` → **QuotaLimited**（`reset_at=None` 落 10 分钟兜底冷却；`upstream_code` 取错误体里可能存在的 `code`；源实现无限额码——全仓 grep 429 零命中，只看 HTTP 状态码）;
- 其余 → 先过内容拦截三文案判定（命中 → ContentBlocked），否则 **Fatal**；
- 无 `retry_advice`（源实现唯一重试就是 401 刷新重试，无 WAF/退避码）。

## 2.7 本机登录态导入（safeStorage 解密全流程）

**文件路径**（credentials.rs:236-268）：
- `auth.json`：`%APPDATA%\AutoClaw\auth.json`（环境变量 `AUTOCLAW_USER_DATA_DIR` 可覆盖；非 Windows 返回 None，整条来源不可用）；
- `Local State`：与 auth.json 同目录 `%APPDATA%\AutoClaw\Local State`；
- 备来源：`~/.openclaw-autoclaw/openclaw.json`。
- 文件防御（credentials.rs:304-331）：必须是普通文件（拒绝符号链接）、大小 `(0, 256KB]`、根是 JSON 对象。

**auth.json 结构**（region.rs:41-42, credentials.rs:477-555）：
```jsonc
{
  "deviceId": "...",        // 设备 id（刷新接口要带；缺省回落 JWT 的 device_id 声明）
  "updatedAt": ...,
  "userInfo": {...},
  "token": "enc:<base64>",      // safeStorage 密文；历史版本可能是明文（非 enc: 原样返回）
  "refreshToken": "enc:<base64>"
}
```
解出明文自带 `Bearer ` 前缀，必须去掉（`strip_bearer` 大小写不敏感，crypto.rs:318-330），否则拼出 `Bearer Bearer eyJ...`。`user_id` 取 JWT `user_id` 声明，`expiresAt` 取 `exp`×1000。

**解密链第一步：取 AES 密钥**（crypto.rs:123-183）：
1. 读 `Local State` JSON → `os_crypt.encrypted_key` 字段（base64 字符串，先做形态校验 `^[A-Za-z0-9+/]+={0,2}$`）；
2. base64 解码后**前 5 字节是 ASCII `"DPAPI"`**（Chromium 标记），去掉；
3. 剩余 DPAPI blob 用 Win32 `CryptUnprotectData`（当前用户作用域，dwFlags=0）解出 **32 字节 AES-256 密钥**；长度必须正好 32。按路径做进程级缓存。

**第二步：解密 `enc:` 字段**（crypto.rs:226-253）：
```
"enc:" 前缀后 base64 解码 → 字节流：
[0..3)     "v10"        ← os_crypt 版本前缀（3 字节 ASCII，非 v10 报"不支持的版本"）
[3..15)    nonce        ← 12 字节
[15..n)    AES-256-GCM 密文
[n..n+16)  tag          ← 16 字节认证标签，附在密文尾部（Postfix，Electron 拼法）
```
- AES-256-GCM，**无 AAD**；「密文+tag」整段交给 GCM 解密，不自己切 tag；
- 长度守卫：去掉前 3 字节后 `payload.len() <= 12+16`（**含等于**，28 也算异常）直接报错；
- 解密失败统一「AES-GCM 解密失败（密钥或数据不匹配）」；明文按 UTF-8 解析（非法 UTF-8 报错，不替换字符）。

**备来源 openclaw.json**（credentials.rs:566-622）：遍历 `models.providers.*.models[].headers`，取第一个非空的 `X-Authorization`/`x-authorization` 明文 JWT。只有 access token，`refresh_token` 恒空 → **天然不可刷新**（维护任务必须先判 `can_refresh()`）。

**优先级**（credentials.rs:692-728）：先 auth.json，失败才试 openclaw.json；都失败时抛 **auth.json 的错误**（「没登录」比「没有 X-Authorization」更接近用户动作）。环境变量旁路最后：`{AUTOCLAW_|AUTOCLAW_INTL_}TOKEN`（必填）+ `REFRESH_TOKEN`/`DEVICE_ID`（可选），前缀按地区（credentials.rs:739-761）。

**地区歧义**：两个构建的 Electron 应用名都是 `autoclaw`，userData 落同一目录（Windows 大小写不敏感），**auth.json 没有任何地区标记**（region.rs:36-50）。region.rs 模块头声明「导入桌面端登录态两个地区都给，用户在哪项下点导入就归哪家」（记录 id `autoclaw-desktop` / `autoclaw-intl-desktop`，autoclaw_accounts.rs:82-100）；但**实际门禁** `credentials::local_credentials()`（credentials.rs:710-717）目前仍对非 Cn 返回 401「…只归国内版使用」。实现时这是一个策略决策点：文件本身无法判断地区，凭证明文里也没有地区信息。

**导入应存字段**：桌面端账号记录只存 `desktop: true` + 地区，不落 token（每次实时读文件，mtime 缓存键 `auth:<region>:<路径指纹>:<mtime>`）；手动账号记录可存明文 token 或直接粘贴 `enc:` 原值（自动走解密链，credentials.rs:809-827），外加 `deviceId`、`tokenExpiresAt`（优先于 JWT exp）。

## 2.8 AutoClaw 额外：国内/国际差异汇总

- **域名**：国内 `autoglm-acceleration-api.zhipuai.cn`（智谱加速域），国际 `autoglm-api.autoglm.ai`；LLM 代理路径 `/autoclaw-proxy/proxy/autoclaw` 两地相同，只换 host；
- **订阅路径**：国内 `/agentpay/v1/assistant/subscribe-info`（自有支付），国际 `/agentpay/v1/assistant/oversea-subscribe-info`（Stripe）——发错路径只影响订阅块查不出来（balance.rs:65-74）；
- **模型目录**：两站两份独立数据、各自缓存（catalog.rs:73-92）；静态兜底表两地共用；
- **登录方式**：国内 = 手机验证码（OAuth 关闭）；国际 = Zai/Google OAuth（强制阿里云验证码）+ 手机验证码被 `ensure_sms_region` 挡下（login.rs:123-137）；
- **签名/品牌头**：appId/appKey、头集合两地逐字相同（region.rs:9-12 实测确认）；
- **账号 id**：国内 `user-<userId>`（历史值不能变），国际 `intl-user-<userId>`（两地 userId 空间可能撞号，region.rs:169-192）；
- **桌面端登录态**：auth.json 只能确定属于其中一个构建（见 2.7 的地区门禁）；
- 闸门（X-Harness-Type + system 白名单）只在**国内版实测过**，国际版沿用同一套（两地是同一套客户端代码的两个构建，adapter.rs:48-50）。

---

# 第三章 Qoder（`qoder`，国际/中国版单 provider 内分 region）

## 3.1 端点清单与地区选择

地区枚举（endpoints.rs:7-94）：账号记录的 `mode`（或 `edition`）字段——`""`/`"global"`/`"intl"` → Global，`"cn"` → Cn，其余 400。**地区不接受任意 URL**，域名全部内置：

| 基址 | Global（国际版） | Cn（中国版） |
|---|---|---|
| open_api（机器接口） | `https://openapi.qoder.sh` | `https://openapi.qoder.com.cn` |
| center（凭证续期） | `https://center.qoder.sh` | `https://gateway.qoder.com.cn` |
| web_origin（授权页） | `https://qoder.com` | `https://qoder.com.cn` |
| gateway（推理网关 `/algo/...` 之根，**注意带尾斜杠**） | `https://api3.qoder.sh/` | `https://gateway.qoder.com.cn/` |

路径常量（endpoints.rs:99-104）：`DEVICE_LOGIN_PATH=/device/selectAccounts`、`DEVICE_POLL_PATH=/api/v1/deviceToken/poll`、`EXCHANGE_PATH=/api/v1/jobToken/exchange`、`USER_INFO_PATH=/api/v1/userinfo`、`USAGE_PATH=/api/v2/quota/usage`、`REFRESH_PATH=/algo/api/v3/user/refresh_token`。

| 用途 | 方法 + 完整 URL | 源码 |
|---|---|---|
| chat 补全 | `POST {gateway}algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1` | chat.rs:143-147 |
| 模型列表 | `GET {gateway}algo/api/v2/model/list?Encode=1`（同一套 COSY 签名，缓存 1 小时） | models.rs:387 |
| 刷新令牌（OAuth 来源） | `POST {center}/algo/api/v3/user/refresh_token`，body `{"refreshToken":"<串首段>"}` | refresh.rs:62-68 |
| PAT 换令牌 | `POST {open_api}/api/v1/jobToken/exchange`，body `{"personal_token":"<PAT>"}` | auth.rs:100-107 |
| 用户资料 | `GET {open_api}/api/v1/userinfo` | auth.rs:62-66 |
| 余额/额度 | `GET {open_api}/api/v2/quota/usage` | balance.rs:22-27 |
| 设备授权页 | `GET {web_origin}/device/selectAccounts?challenge=<S256(verifier)>&challenge_method=S256&machine_id=<mid>&nonce=<uuid去连字符>`（未登录 302 到 `/users/sign-in?oauth_callback=…`） | oauth.rs:29-42 |
| 设备授权轮询 | `GET {open_api}/api/v1/deviceToken/poll?nonce=<nonce>&verifier=<verifier>&challenge_method=S256`；**202/404 = 还没确认（继续轮询）**；成功响应 `{token, refresh_token, user_id, expires_at}`（refresh_token 不含 `\|`） | oauth.rs:36-48, 51-75 |

verifier 只留在后端（`random_secret()` = 32 字节 getrandom 的 URL-safe base64），challenge = `BASE64URL(SHA256(verifier))` 无填充（oauth.rs:24-41）。

## 3.2 鉴权（两套）

**A. openapi 域**（userinfo/quota/deviceToken/jobToken，endpoints.rs:106-116）：
```
Cosy-Version: 1.0.1
Cosy-ClientType: 5
User-Agent: qoder-local-proxy
Authorization: Bearer <accessToken>    ← 部分端点（PAT 换取、设备轮询）不带
```

**B. gateway 域（`/algo/...`）**：**不是普通 Bearer**，是 COSY 自签名（见 3.3）。chat 在 COSY 头之外追加（chat.rs:156-162）：
```
Content-Type: application/json
Accept: text/event-stream
Cache-Control: no-cache
Accept-Encoding: identity
X-Model-Key: <upstreamKey>       ← 上游靠它做模型路由
X-Model-Source: system
```

## 3.3 COSY 签名完整算法（cosy.rs —— 实现核心）

**常量**（cosy.rs:52-82）：
```
GATEWAY_COSY_VERSION = "1.1.38"
CLIENT_TYPE          = "5"        （Cosy-Clienttype / Cosy-Machinetype 都是 "5"）
DATA_POLICY          = "disagree"
LOGIN_VERSION        = "v2"
CLIENT_IP            = "127.0.0.1"（Cosy-Clientip 写死）
RSA_EXPONENT         = 65537
RSA_MODULUS_HEX（1024 位，逐字）：
c0f22307e5cd362e296bb04470f6de8fbf935ce24e8fcf511a0e2701329769c4a76e499bb938036a52af1eaf818cf79a2600620e3ce87e371d2ca6d85803606a1b3fa5e874643c9ed2db7e85673ef7227fca56e2e7c08f0927609bb896a9f24be1782099a66016a5bfdc3f1ff756bfc9e88d7b5dc5be30bf45a0223a00ebcecf
CUSTOM_ALPHABET（64 字符，逐字）：
_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!
STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
```

**步骤**（cosy.rs:103-201）：

1. **身份 JSON**（键序照抄源实现，手写不引 JSON 库——键序参与加密与签名）：
```json
{"uid":<user_id>,"security_oauth_token":<access_token>,"name":<name>,"aid":"","email":<email>}
```
每个值是 `serde_json::to_string(&str)` 的转义形态（带引号）。

2. **生成 AES 密钥**：`random_secret()`（32 字节随机 → URL-safe base64 无填充）取**前 16 个 ASCII 字符**；源实现是 UUID 去连字符后前 16 位，同一语义。

3. **`info`** = AES-128-CBC(key, 身份JSON) 的标准 base64。**key 和 iv 取同一段 16 字节**（源实现 `aesEncrypt` 既有做法），PKCS#7 补位（补 1..16 字节，值=补位长度），CBC 链式异或。

4. **`cosy_key`（Cosy-Key 头）** = RSA PKCS#1 v1.5 加密 AES 密钥的 base64：布局 `00 || 02 || PS || 00 || M`，PS 为**非零随机**字节（抽到 0 映射成 1）；按模数 1024 位输出**定长 128 字节**，不足左侧补零；`modpow(65537, n)` 即可，无需完整 RSA 库。

5. **`payload`** = 以下 JSON（同样键序手写）的标准 base64：
```json
{"version":"v1","requestId":"<uuid>","info":"<info>","cosyVersion":"1.1.38","ideVersion":""}
```

6. **签名路径**（cosy.rs:252-257）：URL 的 path **去掉 `/algo` 前缀**、**不含查询串**（`/algo/api/v2/service/pro/sse/agent_chat_generation` → `/api/v2/service/pro/sse/agent_chat_generation`）。

7. **签名**（时间戳为**秒**）：
```
signature = MD5( payload + "\n" + cosy_key + "\n" + timestamp + "\n" + body + "\n" + sig_path )  十六进制
```
**请求体参与签名，且签的是编码后的字节**——必须先 `encode_body` 再 `build_auth_headers`，顺序颠倒只能得到「签名不匹配」且无从排查（cosy.rs:16-17, 100-102）。

8. **Cosy-Bodyhash** = MD5(body) hex；**Cosy-Bodylength** = body 字节数。

9. **完整头集合**（cosy.rs:176-199，逐字）：
```
Authorization: Bearer COSY.<payload>.<signature>
Cosy-Key: <cosy_key>
Cosy-User: <user_id>
Cosy-Date: <秒级时间戳>
Cosy-Version: 1.1.38
Cosy-Machineid: <machine_id>
Cosy-Machinetoken: <machine_id>     ← 与 Machineid 同值
Cosy-Machinetype: 5
Cosy-Machineos: x86_64_windows      ← {arch}_{platform}：x86_64/aarch64 + windows/darwin/linux
Cosy-Clienttype: 5
Cosy-Clientip: 127.0.0.1
Cosy-Bodyhash: <md5hex>
Cosy-Bodylength: <字节数>
Cosy-Sigpath: <sig_path>
Cosy-Data-Policy: disagree
Cosy-Organization-Id:               ← 空串
Cosy-Organization-Tags:             ← 空串
Login-Version: v2
X-Request-Id: <requestId>           ← 与 payload 内 requestId 同值
```

**请求体编码 `encode_body`**（cosy.rs:212-240，`Encode=1` 时请求体不是裸 JSON）——三步纯字节变换：
1. 对 JSON 字节做**标准 base64** 得到文本；
2. 按「**尾段 → 中段 → 首段**」重排：三段各长 `⌊n/3⌋`，余数留在中段（拼回仍等长）；
3. 逐字符字母表替换：`STD_ALPHABET[i] → CUSTOM_ALPHABET[i]`，另 **`'=' → '$'`**。

## 3.4 chat 请求体形态（protocol.rs:358-455）

上游不是 OpenAI 形态，是**固定业务信封**（`json!` 逐字段，值逐字）：

```jsonc
{
  "request_id": "<uuid>",
  "request_set_id": "<recordId>",       // = chat_record_id
  "chat_record_id": "<recordId>",
  "session_id": "<sessionId>",
  "stream": true,                        // 恒 true（网关非流式也是内部拉流再聚合）
  "chat_task": "FREE_INPUT",
  "is_reply": true,
  "is_retry": false,
  "source": 1,
  "version": "3",
  "session_type": "qodercli",
  "agent_id": "agent_common",
  "task_id": "common",
  "code_language": "",
  "chat_prompt": "",
  "image_urls": null,
  "aliyun_user_type": "",
  "system": "",                          // 上游不看这个顶层字段（必须放 messages 里）
  "messages": [...],                     // 见下
  "tools": [...],                        // OpenAI tools 原样（type/function/name/description/parameters），空则 []
  "parameters": {
    "max_tokens": 32768,                 // 客户端值与 32768 取小（MAX_OUTPUT_TOKENS，models.rs:57；实测 >32K 上游退化）
    "enable_thinking": true,             // 仅显式开思考时发；关闭思考 = 整个不指定（不发 false！Qwen3.8 传 false 会把思考混进正文或断连）
    "reasoning_effort": "low"            // 仅 effort 有值时发
  },
  "chat_context": {
    "chatPrompt": "",
    "imageUrls": null,
    "extra": {
      "context": [],
      "modelConfig": { "key": "<upstreamKey>", "is_reasoning": <bool> },
      "originalContent": "<最后一条用户文本>"
    },
    "features": [],
    "text": "<最后一条用户文本>"
  },
  "model_config": {                      // 精简版（slim_model_config），必须剥掉 thinking_config
    "key": "<upstreamKey>",              // —— 原样回传会覆盖 parameters.enable_thinking（protocol.rs:9-15）
    "is_reasoning": <bool>,              // 以下四个键仅在目录条目非空时携带
    "is_vl": <bool>,
    "source": "system",
    "format": <仅上游给了才带>
  },
  "business": {
    "product": "cli",
    "version": "1.0.0",
    "type": "agent",
    "stage": "start",
    "id": "<uuid>",
    "name": "<最后一条用户文本前 30 字符>",
    "begin_at": <毫秒时间戳>
  }
}
```

**messages 规整**（protocol.rs:100-211）：
- **system 提示必须放进 messages 且排最前**（顶层 `system` 字段无效）：所有 `system`/`developer` 消息的文本收集后以 `{role:"system",content:text}` 置顶（chat.rs:87-116）；
- `__failed`/`__aborted` 的 assistant 轮次连同其 tool 结果（按 `tool_call_id` 匹配）一起丢弃；
- assistant 只有 tool_calls 时 content 给 `" "`（纯空体会被拒）；
- user 消息无图 → `content` 压平为文本；有图 → `[{type:"text",text},{type:"image_url",image_url}]`（`image_url` 块从 OpenAI 消息里原样抽出）；
- tool 消息 → `{role:"tool",tool_call_id,content:文本}`。

**model 映射**：客户端名 → 目录条目（`resolve`：先账号地区目录，再另一地区，再兜底清单；匹配序 id → name → upstreamKey，忽略大小写，models.rs:308-348）→ 取条目 `upstreamKey`（如 `qfmodel`/`qmodel_38max`/`auto`/`gmodel`）发 `model_config.key`、`chat_context.extra.modelConfig.key` 与 `X-Model-Key` 头。解析不到 → 400 `model_not_found`（chat.rs:68-73）。

**思考档位**（protocol.rs:295-351）：取值链 `reasoning_effort` → `reasoning` → `thinking`（命中第一个存在的键即停）；`off/none/disabled/false` → 不指定；`true/null` → `enable_thinking:true` 无档位；`minimal/min→low`、`high/max→xhigh`；档位白名单 = 目录条目 `thinking_config.enabled.efforts` 的键集（Qwen3.8 系是 `low/medium/xhigh`），不支持时退回该模型默认档（优先 `medium`）。

**会话/记录 id**（protocol.rs:477-531）：
```
sessionId = sha256("qoder-session" \0 user_id \0 upstreamKey) 前 16 hex
            + "-" + (body.user||body.session_id 有值 ? seed : 新uuid)
recordId  = sha256("qoder-record" \0 upstreamKey (\0 role \0 content)* [\0 tools串] \0 "mt=<max_tokens>") 前 16 hex
```

**发送顺序**：`upstream_body → serde_json 序列化 → encode_body（编码）→ build_auth_headers(编码字节, url)（签名）`（chat.rs:141-155）。

## 3.5 响应与 SSE 形态

**HTTP 永远 200**；业务错误在 SSE 信封的 `statusCodeValue` 里（stream.rs:8-11, mod.rs:20-24）。流形态：

```text
data: {"statusCodeValue":200,"body":"{\"choices\":[{\"delta\":{\"content\":\"你\"}}]}"}
data: [DONE]
```

- 外层信封 `{statusCodeValue, body}`；`body` 是**内层 JSON 字符串**（OpenAI chunk 形状），需二次 `JSON.parse`；`body` 也可能直接是 `"[DONE]"` 字符串或非字符串对象（stream.rs:88-104）；
- `statusCodeValue != 200` → 错误帧：`body` 字段（字符串或对象序列化）作为原文交给分类器（截断 500 字符），见 3.6；
- 上游 chunk 内字段：`choices[0].delta.{content, reasoning_content, tool_calls[{index,id,function.{name,arguments}}]}`、`choices[0].finish_reason`、顶层 `model`（上游真实 key 或展示名，需反查映射回对外 id：先按 upstreamKey 查、再按 id/name，protocol.rs:534-546）、顶层 `usage`（**取最后一次出现的**；网关在流末尾独立发一帧 `{"choices":[],"usage":{...}}`，chat.rs:504-513）；
- 思考：`delta.reasoning_content` 优先（去掉偶带标签）；也可能混在 `content` 里用 `<thinking>…</thinking>`/`<think>`/`<reasoning>`/`<thought>` 标签包裹，需要**跨分片**的状态机拆解（标签可能切在任意位置，如 `<thi`+`nking>`；闭标签后吃掉紧跟的换行，先试 `\n\n` 再试单个；流结束必须 flush 缓冲，否则末尾少字，stream.rs:191-420）；
- 上游可能**不发收尾换行**，行解析器必须在流结束时冲刷尾行（丢掉会丢最后的 finish_reason/usage，stream.rs:152-168）；
- 下发帧：网关重组成标准 OpenAI `chat.completion.chunk`（id `chatcmpl-<24hex>`、首 delta 前补 role 帧、finish_reason 最后非空、有工具调用则 `tool_calls`），错误收尾补一帧 `{"error":{"message":...,"type":"proxy_error"}}` + `data: [DONE]`（mod.rs:636-674）。

## 3.6 错误分类（protocol.rs:554-666；先看响应体语义再看状态码）

| 判定（按顺序） | 分类 | 网关映射 |
|---|---|---|
| 响应含 pricingUrl（正则 `/https?:\/\/[^"\\]*\/pricing[^"\\]*/i`）或文本含 `pricingurl`/`insufficient`/`no_quota`/`quota_exceed`/`exceed_quota`/`exceeded`/`credit`/`upgrade`/`subscription`/`plan`/`trial` | **Quota**（额度/套餐不足，文案「当前账号额度不足或套餐不支持该模型」，带定价页链接） | **429** → 编排层换账号 + 落冷却 |
| HTTP 429 或含 `rate limit`/`too many` | **Rate** | **429** → 同上 |
| HTTP 401 | **Auth** | **401** → 刷新后同账号重试一次 |
| HTTP 403（无配额特征时） | **Auth**（「可能是登录态失效或权限不足」） | **401** |
| 文本含 `"code":112` 或 `"code": 112` | **Quota**（兜底再认一次） | **429** |
| HTTP >= 500 | **Server** | **502** 透传 |
| 其余 | **Unknown** | **502** |

**注意**：上游用 403 表达多种情况——带 pricingUrl 是套餐不足、裸 403 才是鉴权，只看状态码会把「该充值」误报成「登录失效」（protocol.rs:548-556, 592-602）。冷却落库键为账号记录内 `rateLimits[model]`，`reset_at=None` 落 10 分钟兜底（mod.rs:105-125）。

## 3.7 本机登录态

**Qoder 不读桌面端/CLI 登录态**——`importDesktop: true` 直接 400「Qoder 请使用网页登录或个人访问令牌（PAT）添加」（auth.rs:130-133）。本机唯一读取的是**机器标识**（machine.rs:36-65），查找顺序（第一个存在的非空文件，≤256 字符、无控制字符）：
```
<config_dir>/qoder-machine-id
~/.qoder-proxy/machine_id          ← Qoder-Proxy CLI 的
~/.qoder/.auth/machine_id          ← Qoder 桌面端/CLI 的
~/.qoder/machine_id
```
都没有则生成 UUID v4 写入 `<config_dir>/qoder-machine-id`，进程内缓存。

**账号记录结构**（accounts.json 的 qoder 记录，credentials.rs:123-139 `to_value`）：
```jsonc
{
  "mode": "global" | "cn",
  "accessToken": "...",
  "refreshToken": "<刷新串>",      // 格式见下
  "expiresAt": <毫秒|秒|RFC3339 自动识别, credentials.rs:175-182>,
  "userId": "...",                  // ≤256 字符、无 |、无控制字符
  "email": "...",
  "nickname": "...",
  "machineId": "..."
}
```
**refreshToken 刷新串格式**（credentials.rs:34-52, 74-101）：
- 5 段 `pat|<PAT>|<作业刷新令牌>|<userId>|<machineId>` —— PAT 来源；
- 3 段 `<oauth刷新令牌>|<userId>|<machineId>` —— OAuth 设备授权来源；
- 1 段 → 补全为 3 段；`complete_identity()` 只重写尾部两段（按段数分支，PAT 内部含 `|` 不能按下标切）。
- `can_refresh` = 有 PAT（`pat|` 前缀取第 2 段）或有 oauth 刷新串首段。

**刷新流程**（refresh.rs:50-100）：
- PAT 来源：重新走 `POST {open_api}/api/v1/jobToken/exchange`（`{"personal_token":<PAT>}`），保留原 machineId；
- OAuth 来源：`POST {center}/algo/api/v3/user/refresh_token`（`{"refreshToken":<首段>}`，带 open_api 头 + Bearer），响应取 `data.token`（新 accessToken）与 `data.refresh_token`（**不得含 `|`**，缺失沿用旧值），`expires_at` 缺省 = now + 30 天；
- 刷新后校验 userId 与 region 未变（变了拒绝覆盖）；比较-再写回账号库（`update_qoder_credentials_if_current`）。
- 临期窗口 5 分钟（`REFRESH_MARGIN_MS = 5*60*1000`，credentials.rs:11）。

## 3.8 Qoder 额外要点汇总

- **国内/国际选择**：完全由账号记录 `mode`/`edition` 字段决定（默认 global）；四组域名（open_api/center/web_origin/gateway）按 region 内置切换；两地区**模型目录与凭证不通用**，目录按地区分开缓存（TTL 1 小时），`list()` 返回两地区**并集**（按 id 去重、global 优先），请求时先在账号所属地区解析、再退另一地区（models.rs:11-16, 269-331）；
- **模型目录解析**（models.rs:500-567）：响应信封 `{statusCodeValue, chat:[...]}`（业务错误也在 200 里）；条目字段 `key`（上游标识）、`display_name`（对外 id = display_name **去所有空白**）、`enable`、`is_vl`（视觉）、`is_reasoning`/`thinking_config`（思考）、`thinking_config.enabled.efforts`（**对象，键集即档位白名单**）、`context_config.*.token_count`（取最大为上下文窗口，缺省 200000）、`source`、`price_factor`（倍率 0~3.2，`0` 是合法值不能当缺失丢弃；`original_price_factor` 是原价）；
- **静态兜底清单**（models.rs:76-128）：global 17 条 / cn 10 条，含 upstreamKey、reasoning、efforts、price_factor 快照（2026-09-20 实测）；请求体构造取自 `FALLBACK`/远程的 `upstreamKey` 与 `config`；
- **限额记账**：Qoder 走会话式转发（`is_stateful=true`，但上游仍是一次请求一次回答），编排层看不到错误分类，适配器在信封错误现场自行把 Quota/Rate 落冷却（mod.rs:92-125），非流式时再把带状态码的错误交回编排层换账号。

---

# 附：源码中「未找到」的项

- Cline：usage 在 SSE 流的哪一帧——源码未提及（透传语义下随上游 chunk 原样携带）；Cline 无 deviceId 类附加字段。
- AutoClaw：usage 处理无特殊说明（OpenAI 兼容透传）；转发路径无刷新码/退避码（源实现 grep 429 零命中）。
- Qoder：桌面端登录态文件结构——**不存在读取逻辑**（仅 machine_id 三条候选路径）；除 `code 112` 外无其他枚举过的业务错误码表。

**实现提醒（三份规格共同的三处高频翻车点）**：Cline 的 `workos:` 前缀与 `X-CLIENT-TYPE: cline-sdk`；AutoClaw 的 `X-Authorization`（非 Authorization）、禁发 `X-Harness-Type: zcode`、system 必须以 OpenCl
===== 以下为第二份提取报告（网页登录流程） =====

研究完成。以下是基于源码的完整规格报告。

---

# 三家提供商「网页登录/授权」流程规格（供 Node.js/Electron 重新实现）

**路径约定**（下文以 `BASE` 代指）：
- `BASE` = `C:\Users\15778\AppData\Local\Temp\agent2api-ref\desktop-tauri`
- `PROV` = `BASE\src-tauri\src\server\core\providers`（Rust 后端核心层）
- 后端 HTTP 路由层 = `BASE\src-tauri\src\server\api\session.rs`；路由注册 = `BASE\src-tauri\src\server\http.rs`
- 壳侧登录窗口 = `BASE\src-tauri\src\login.rs`；Tauri 命令 = `BASE\src-tauri\src\commands.rs`
- 前端 = `BASE\ui\*.js`

---

## 0. 三家共用的网关侧任务框架（先读这个）

登录任务统一走这套 HTTP API（管理 API，需 API Key；响应信封 `{success:true, data:…}`，`http.rs:560-562`）：

| 端点 | 方法 | 说明 | 注册处 |
|---|---|---|---|
| `/api/session/login/start` | POST | 发起，body `{provider, edition?}`，等 authUrl 最多 15s | `http.rs:206` |
| `/api/session/login/wait?state=<state>` | GET | 轮询结果 | `http.rs:207` |
| `/api/session/login/cancel` | POST | 取消，body `{state}` | `http.rs:208` |

- `/start` 处理：`session.rs:170-230`。按 `provider` 分流；Qoder 走 `start_qoder_login(edition)`（`session.rs:191-199`），Cline 走 `start_cline_device_login(provider, name)`（`session.rs:212-230`），两者同步拿到 `{state, authUrl, edition, provider}` 立即返回。
- `/wait` 三分支响应：`{pending:true}` / `{done:true, error}` / `{done:true, session:{accountUid, nickname, edition, provider}}`（`server\core\login.rs:87-95`；qoder/autoclaw 成功时 session 见 `login\qoder.rs:80-85`、`login\autoclaw.rs:288-294`；cline 用 `{account:{uid,nickname}, edition:""}` 形状 `core\login.rs:436-442`）。
- 超时常量：`LOGIN_TIMEOUT_MS = 5*60*1000`、`AUTH_URL_WAIT_MS = 15_000`、任务完成后保留 10 分钟（`core\login.rs:54-58`）。
- 壳侧：开内嵌 WebView 窗口（每次登录用全新临时数据目录）或系统浏览器，然后每 2 秒 `GET /wait`（`src-tauri\login.rs:62-63`，`poll_once` 在 `452-465`）。窗口对 qoder/cline/autoclaw **不设域名白名单**（`src-tauri\login.rs:227-244`，`"catpaw" | "qoder" | "cline-free" | "cline-pass" | "autoclaw" | "autoclaw-intl" => None`）。
- AutoClaw 两条链走**另外的端点**（见 §3），不经过 `/login/start`。

---

## 1. Cline —— WorkOS 设备授权（RFC 8628）

文件：`PROV\cline\login.rs`（主）、`PROV\cline\credentials.rs`（常量）、`PROV\cline\adapter.rs`（CLIENT_TYPE）、`core\login.rs:346-448`（编排）。

### 1.1 发起（第一步）
- `POST https://api.workos.com/user_management/authorize/device`（`WORKOS_BASE_URL = "https://api.workos.com"`，`credentials.rs:55`）
- 请求头：`Content-Type: application/x-www-form-urlencoded`、`Accept: application/json`（`login.rs:89-93`）；单请求超时 30s（`login.rs:63`）
- 请求体（全部参数，就一个）：`client_id=client_01K3A541FN8TA3EPPHTD2325AR`（`WORKOS_CLIENT_ID`，`credentials.rs:69`；来源：该值取自已登录 JWT 的 `iss` 声明，与 `@cline/core` 运行时一致）
- 成功响应（200）字段（`login.rs:5-11` 模块头 + `135-164` 解析）：
  - `device_code`（64 字符）、`user_code`（形如 `PXQF-MWRC`）、
  - `verification_uri`：`https://authkit.cline.bot/device`（兜底常量 `DEVICE_VERIFY_FALLBACK = "https://authkit.cline.bot/device"`，`credentials.rs:72`）
  - `verification_uri_complete`：`https://authkit.cline.bot/device?user_code=PXQF-MWRC`
  - `expires_in: 300`、`interval: 5`

### 1.2 用户交互
- 网关把 `authUrl = verification_uri_complete`（缺失时退回 `verification_uri`）交给壳开窗口；用户**点开即免手输码**（码已在 URL 里）。`state`（任务键）= `"cline-" + device_code 前 12 字符`（`core\login.rs:383-390`）。
- **没有 loopback 回调、没有深链**——这是有意的：源实现 `@cline/core` 起过本地回调端口 48801..48811，但设备流不用它，本实现干脆不起（`login.rs:36-41` 模块头）。用户在任何设备的浏览器上确认都行，网关只轮询。

### 1.3 轮询（第三步）
- `POST https://api.workos.com/user_management/authenticate`（`login.rs:226`）
- 头同上（form-urlencoded + Accept json）
- 请求体：`grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=<device_code>&client_id=<client_id>`（`login.rs:230-233`）
- 间隔 = 上游返回的 `interval`（缺省 5s，`login.rs:69`）；收到 `slow_down` 时间隔 +1s、上限 30s（`login.rs:286`）；总上限 = `expires_in`（300s，`MAX_POLL_MS login.rs:66`）
- 各状态返回体（`login.rs:18-21, 274-316`）：
  - 成功 2xx：`{access_token, refresh_token}`
  - 400 `{error:"authorization_pending"}` → 继续轮
  - 400 `{error:"slow_down"}` → 拉长间隔继续
  - 400 `{error:"expired_token"}` → 终止（408）
  - 400 `{error:"access_denied"}` → 用户拒绝（400）

### 1.4 登录后的必做后续（第四步，**不能省**）
- `POST https://api.cline.bot/api/v1/auth/register`（`API_BASE_URL = "https://api.cline.bot/api/v1"`，`credentials.rs:52`；路径拼接 `login.rs:330`）
- 头：`Content-Type: application/json`、`Accept: application/json`、**`X-CLIENT-TYPE: cline-sdk`**（`CLIENT_TYPE`，`adapter.rs:91`）
- 请求体：`{"accessToken": <WorkOS access>, "refreshToken": <WorkOS refresh>}`
- 响应：`{"data":{accessToken, refreshToken, expiresAt, userInfo, accountId}, "success":true}`（`login.rs:23-24` 模块头；解析在 `327-393`）。WorkOS 给的是身份令牌，必须经此换成 Cline 自己的会话令牌才能打 LLM 端点。
- 返回的 `accessToken` 统一补 **`workos:`** 前缀（幂等，`ensure_token_prefix`，`credentials.rs:176-186`；`TOKEN_PREFIX = "workos:"`，`credentials.rs:75`；实测不带前缀上游 401）。

### 1.5 token 集
- 最终落库 payload：`{"accessToken": "workos:eyJ…", "refreshToken": "…"}`，走 `add_cline_account(provider, payload, name)`（`login.rs:182-188`）。
- `accountId` 在 JWT 的 **`external_id`** 声明里（`usr-…` 形态；`sub` 是 WorkOS 自己的 `user_…` 不能用），见 `credentials.rs:204-224`。accessToken 有效期 1 小时（`exp-iat=3600`，`credentials.rs:102-108`）。

### 1.6 cline 额外问题的答案
- **scope 参数：未找到**。整个 `cline/` 目录 grep `scope|organization` 零匹配——请求体只有 `client_id`，没有 scope、没有 organization/环境参数。
- **free 池与 pass 池登录无区别**：登录流程与池无关（只有 api.cline.bot 一台站点、一套设备授权），provider id（`cline-free` / `cline-pass`）只决定账号落到哪家（`core\login.rs:366-369`；`session.rs:205-211`）。旧版前端发的 `pool` 字段直接忽略。UI 两个表单同构（`ui\add-cline.js:80-91`）。
- 桌面端登录态文件（另一条非登录的导入路径）：`~/.cline/data/settings/providers.json` 的 `providers.cline.settings.auth`（`credentials.rs:78, 478-518`）。

---

## 2. Qoder —— PKCE 设备授权（国际/中国版同构）

文件：`PROV\qoder\oauth.rs`（主）、`endpoints.rs`（端点/地区）、`machine.rs`（随机与 machine_id）、`auth.rs`（请求/资料）、`credentials.rs`（凭证格式）、`core\login\qoder.rs`（编排）、`ui\add-qoder.js`。

### 2.1 发起
**没有起始 HTTP 请求**——授权页 URL 是本地拼的（`DeviceLogin::new`，`oauth.rs:24-49`）：
- 授权页 = `{web_origin}/device/selectAccounts` + query：
  - `challenge` = `URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))`（**PKCE S256：SHA256 后 base64url 无填充**，`oauth.rs:26`）
  - `challenge_method` = `S256`
  - `machine_id`（见 2.7）
  - `nonce` = UUID v4 去掉连字符（`oauth.rs:27`、`machine.rs:20-28`）
- 站点（`endpoints.rs:71-76`）：Global `https://qoder.com`；Cn `https://qoder.com.cn`
- `verifier` = 32 字节 CSPRNG → base64url 无填充（`machine.rs:13-18`），**只留在后端**，进轮询 URL 不进授权页
- 未登录时授权页 302 到各自 `/users/sign-in?oauth_callback=…`（`endpoints.rs:96-98`；四个 query 参数两站都认）

### 2.2 用户交互
- 前端 `POST /api/session/login/start` body `{provider:"qoder", edition:"intl"|"cn"}`（缺省 `intl`，`core\login\qoder.rs:17-18`；壳侧把 `global` 归一成 `intl`，`src-tauri\login.rs:530-532`）。
- `state` = `random_secret()`（32B base64url，`oauth.rs:43`），同时是任务表键。
- 用户在授权页登录并**选择账号**（页面名 `selectAccounts`），无需手输任何码。窗口不设域名白名单（`src-tauri\login.rs:241`）。

### 2.3 轮询
- `GET {open_api}/api/v1/deviceToken/poll?nonce=<nonce>&verifier=<verifier>&challenge_method=S256`（`oauth.rs:36-41, 51-52`；`DEVICE_POLL_PATH = "/api/v1/deviceToken/poll"`，`endpoints.rs:100`）
  - Global：`https://openapi.qoder.sh/api/v1/deviceToken/poll`；Cn：`https://openapi.qoder.com.cn/api/v1/deviceToken/poll`（`endpoints.rs:52-57`）
- 请求头（`open_api_headers(None)`，`endpoints.rs:106-116`）：
  - `Cosy-Version: 1.0.1`、`Cosy-ClientType: 5`、`User-Agent: qoder-local-proxy`（无 Authorization、**无 COSY 签名**）
- 间隔与超时：网关循环**每 2 秒**一次（`core\login\qoder.rs:48`），总超时 5 分钟（`LOGIN_TIMEOUT_MS`）；传输层错误（`qoder_transport`）不终止、继续等（`qoder.rs:58-60`）
- 各状态：
  - pending：**HTTP 202 或 404** → `Ok(None)` 继续轮（`oauth.rs:53-55`）
  - success（200 JSON）：`token`、`refresh_token`、`user_id`、`expires_at`（`oauth.rs:56-75`；`expires_at` 缺省 now+30 天）
  - `refresh_token` 含 `|` 直接判无效（`oauth.rs:62-64`）

### 2.4 回调/重定向
无 loopback、无深链——纯轮询。

### 2.5 登录后的初始请求
- `GET {open_api}/api/v1/userinfo`，头 = 同上 + `Authorization: Bearer <token>`（`oauth.rs:76`；`auth.rs:57-70`；`USER_INFO_PATH`，`endpoints.rs:102`）。`apply_profile` 校验 user_id 一致并补 name/email（`auth.rs:72-89`）。
- 容忍规则：poll 响应已带 `user_id` 时 userinfo 失败可容忍，否则报错（`oauth.rs:76-80`）。

### 2.6 token 集（落库形状）
`credentials.to_value()`（`credentials.rs:123-139`）：`{mode:"global"|"cn", accessToken, refreshToken, expiresAt, userId, email, nickname, machineId}`。其中 **`refreshToken` 打包串 = `"{refresh_token}|{user_id}|{machine_id}"`**（`oauth.rs:69-70`；后缀两段固定，由 `complete_identity` 重写，`credentials.rs:74-101`）。

### 2.7 qoder 额外问题的答案
- **设备注册/绑定**：登录流程**没有**独立的设备注册调用，也没有 COSY 签名参与（COSY 自签名 `cosy.rs`、`GATEWAY_COSY_VERSION = "1.1.38"` 只用于 `/algo` 对话网关与刷新链，是另一代理的范围）。设备身份就是 `machine_id`：本地生成并持久化到 `<config_dir>/qoder-machine-id`，读取顺序回退 `~/.qoder-proxy/machine_id` → `~/.qoder/.auth/machine_id` → `~/.qoder/machine_id` → 新 UUID v4（`machine.rs:36-65`）；它同时进授权页 query 与 refresh 打包串。
- **国内/国际差异**：仅域名四组（授权页 `qoder.com`/`qoder.com.cn`、openapi `openapi.qoder.sh`/`openapi.qoder.com.cn`、center `center.qoder.sh`/`gateway.qoder.com.cn`、推理网关 `api3.qoder.sh/`/`gateway.qoder.com.cn/`，`endpoints.rs:52-93`）；协议、路径、参数两站逐字相同。region 解析：`""|"global"|"intl"` → Global，`"cn"` → Cn（`endpoints.rs:14-19`）。
- 另有 PAT 换 token 路径（非设备流）：`POST {open_api}/api/v1/jobToken/exchange` body `{"personal_token": pat}`（`auth.rs:91-128`；`EXCHANGE_PATH` `endpoints.rs:101`），refresh 串形态 `pat|<PAT>|<job_refresh>|<user>|<machine>`。

---

## 3. AutoClaw —— 国内短信验证码 / 国际 OAuth+阿里云滑块

文件：`PROV\autoclaw\login.rs`（国内短信）、`oauth.rs`（国际 OAuth 服务端两跳）、`region.rs`（域名）、`refresh.rs`（签名头）、`core\login\autoclaw.rs`（编排）、`api\session.rs:538-795`（HTTP 层）、`ui\sms-login.js`、`ui\autoclaw-oauth.js`。

### 3.0 地区/入口矩阵（`login.rs:9-23` 模块头，实测 2026-09-22）
- **国内版**（provider id `autoclaw`）：手机号+短信验证码是**唯一**官方登录方式；`oauth-captcha-config` 返回 `enabled:false` 且 `prefix`/`scene_id` 为空串 → 无 OAuth。
- **国际版**（provider id `autoclaw-intl`）：OAuth 网页登录（Zai/Google）是**唯一**登录方式（官方登录页只渲染两个 OAuth 按钮）；短信接口实测仍通但官方已移除入口，网关在 `ensure_sms_region` 直接拒绝国际版请求（`login.rs:123-131`）。
- userapi 基址（`region.rs:139-144`）：CN `https://autoglm-acceleration-api.zhipuai.cn`；Intl `https://autoglm-api.autoglm.ai`。**两地路径逐字相同，只有域名不同**。
- 两地共用同一套 `X-Auth-Sign` 客户端指纹（appId/appKey 逐字相同，`region.rs:6-7`）。

### 3.1 国内版：手机验证码登录

**① 发送验证码**
- `POST {userapi}/userapi/v1/agent-send-code`（`SEND_CODE_PATH`，`login.rs:107`）
- 头 = `signed_auth_headers("")`（无 token 时不加 authorization，`login.rs:215-246` + `refresh.rs:228-267`），全套头逐字如下（`refresh.rs:234-266`）：
  - `Content-Type: application/json`、`Accept: */*`、`X-Product: autoclaw`、`X-Client-Type: pc`、`X-Harness-Type: zcode`、`X-Tm: win`（Windows）/`linux`、`X-Lang: zh-CN`、`X-Channel: official`、`X-Auth-Appid: 100003`、`X-Auth-TimeStamp: <秒级时间戳>`、`X-Auth-Sign: <md5>`、`X-Trace-Id: <随机请求id>`
- **签名常量**（`refresh.rs:59-60`）：`AUTH_APP_ID = "100003"`、`AUTH_APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5"`；**`X-Auth-Sign = MD5("{appId}&{秒级ts}&{appKey}")` 小写 hex 无填充**（`refresh.rs:229-233`）
- 请求体：`{"phone": <11位数字串>, "source_id": "autoclaw", "device_id": <64位hex>}`（`login.rs:310-314`）
  - phone 规范化：11 位、`1[2-9]` 开头，容忍 `+86`/`86` 前缀与空白/连字符（`login.rs:140-153`）
  - `device_id` = 32 随机字节 → 64 hex（官方客户端是 ed25519 公钥的 SHA-256，服务端只当不透明串；`login.rs:86-94, 188-207`）
  - 缺 `device_id` 实测 `400001`（`login.rs:92-94`）
- 响应：`{code:0, data:{result:true}}`；`code≠0` 或 `result=false` 都算失败（`login.rs:316-332`）
- 网关把 `{deviceId}` 回给前端，前端随 verify 请求带回（两次调用必须同一 device_id，`login.rs:300-303`；UI `ui\sms-login.js:181-186, 221`）

**② 用码换 token**
- `POST {userapi}/userapi/v1/agent-login/` —— **结尾斜杠是上游要求的**（`LOGIN_PATH`，`login.rs:109`）
- 请求体：`{"phone": <string>, "code": <JSON 数字>, "platform": "web", "source_id": "autoclaw", "device_id": <同一 device_id>}`（`login.rs:365-372`）
  - **`code` 必须是 JSON 数字**：传字符串稳定 `400001 请求数据有问题`（实测对照：字符串→400001，数字→630202，`login.rs:157-174`）
  - `platform: "web"` 是网页端与桌面端唯一差别（源实现 `loginWebWithPhoneCode`）
- 响应 `data`：`{access_token, refresh_token}`（`login.rs:388-407`）
- 凭证 payload：`{token, refreshToken?, deviceId, phoneTail}`（与「粘贴 token 添加」逐字一致，直接 `add_autoclaw_account`；`login.rs:341-419`）
- **无回调、无轮询、无登录后必做调用**（`api\session.rs:562-566`）
- 网关端点：`POST /api/session/login/sms/send` body `{phone, provider}` → `{deviceId}`（`session.rs:582-590`）；`POST /api/session/login/sms/verify` body `{phone, code, deviceId?, name?, provider?}` → `{account, list}`（`session.rs:599-642`）

**业务码表**（`login.rs:263-297`，上游 msg 不可直出）：`400001` 参数错误（≠验证码错误）；`630202` 验证码错误；`630101` 发码过频；`400002` 签名校验失败（时钟漂移）；`410000`/`400000` 登录态失效；`631002` 上游要求风控验证；`630014` 风控验证未通过。

### 3.2 国际版：OAuth（Zai / Google）+ 阿里云滑块

协议总览（`oauth.rs:11-23`）：
```
① POST {intl}/userapi/overseasv1/oauth-captcha-config   {}
   → data {enabled, region, prefix, scene_id, captcha_supplier}
② POST {intl}/userapi/overseasv1/{zai|google}-oauth-url
     {source_id, device_id, navigate_uri, ali_captcha_verify_param}
   → data.oauth_url（官方登录页）
③ 浏览器登录 → 302 到 {navigate_uri}?code=…&state=…
   POST {intl}/userapi/overseasv1/{zai|google}-oauth-login
     {source_id, device_id, code, state, navigate_uri} → token 对
```

**① 取验证码配置**
- `POST {intl}/userapi/overseasv1/oauth-captcha-config` body `{}`（`CAPTCHA_CONFIG_PATH`，`oauth.rs:79`；处理 `oauth.rs:238-263`）
- 响应 `data`：`{enabled, region, prefix, scene_id, captcha_supplier}`（网关归一成 `{enabled, region, prefix, sceneId, supplier}`）
- 国际版 `enabled:true`、supplier `aliyun`；国内版 `enabled:false` + 空 prefix/scene_id。场景值实测 `sq51tr` / `18vhnjxl`（`login.rs:56` 注释；运行时以接口返回为准）
- 网关端点：`GET|POST /api/session/login/oauth/captcha-config`（`http.rs:230-234`；前端经 bridge `call('POST', …, {provider})`，`bridge.rs:181-184`）

**② 滑块验证码的运行方式（关键，纠正一个理解）**
- 不是独立 WebView 窗口跑组件——是**在主窗口（网关管理页）里加载官方浏览器端 SDK**：主窗口 CSP 为 `null`，外域脚本可原样运行（`ui\autoclaw-oauth.js:35-41`）。实现是从客户端 `chatStore-*.js` 的 `requestAliyunCaptcha`/`initializeAliyunCaptcha`/`captchaVerifyCallback` 逐条移植的（`autoclaw-oauth.js:24-33`）。
- 组件 URL：`https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js`（`autoclaw-oauth.js:51-52`）。**必须在脚本加载前设 `window.AliyunCaptchaConfig = { region, prefix }`**，否则弹窗转圈（`autoclaw-oauth.js:188-194`）。
- 初始化参数（`autoclaw-oauth.js:322-368`）：`{ SceneId, mode:'popup', element:'#aliyun-captcha-element', button:'#aliyun-captcha-trigger', captchaVerifyCallback, onBizResultCallback, getInstance, slideStyle:{width:360,height:40}, language, onError }`；语言归一（`zh-CN`→`'cn'` 等，`autoclaw-oauth.js:89-107`）。
- 触发：SDK 要求一个 button 选择器；代码造 1×1 透明按钮，初始化后至少等 **2.1 秒**再 `button.click()` 弹滑块（`autoclaw-oauth.js:56-64, 381-384`）。超时：脚本/初始化各 40s、验证 120s、实例复用 19 分钟（`autoclaw-oauth.js:60-66`）。
- **验证完成判定**：SDK 拖动完成后回调 `captchaVerifyCallback(captchaVerifyParam)`（不透明串）→ 前端**立即**拿它调 `POST /api/session/login/oauth/start` 换授权地址，并把结果以 `{captchaResult, bizResult}` 返回给 SDK——两者都 true 才收起滑块（`autoclaw-oauth.js:243-280, 559-591`）。若加 CSP 须放行 `https://o.alicdn.com` 与 `https://*.alicdn.com`。

**③ 换授权地址（网关 → 上游第一跳）**
- 前端：`POST /api/session/login/oauth/start` body `{provider:"autoclaw-intl", vendor:"zai"|"google", captchaVerifyParam}`（`session.rs:682-722`；`bridge.rs:185-190`）。vendor 不认识一律 400 不静默回落（`session.rs:650-658`）。
- 网关生成：`state` = 16 字节 CSPRNG → 32 位小写 hex（`login\autoclaw.rs:316-320`）；`device_id` = 新 64hex（`oauth.rs:413-415`）；`navigate_uri = http://127.0.0.1:<网关端口>/api/session/login/autoclaw-oauth-callback/{vendor}/{state}`（`CALLBACK_PATH_PREFIX = "/api/session/login/autoclaw-oauth-callback"`，`oauth.rs:146-160`；端口 `session.rs:706`）。
- 上游：`POST {intl}/userapi/overseasv1/zai-oauth-url`（或 `google-oauth-url`），body `{"source_id":"autoclaw","device_id":…,"navigate_uri":…,"ali_captcha_verify_param":…}`（端点 `oauth.rs:120-124`；body `oauth.rs:286-291`），头同 §3.1 的签名头（`signed_auth_headers("")`，15s 超时 `oauth.rs:83`）
- 响应 `data.oauth_url` → 网关回前端 `{state, authUrl, edition:"intl", provider}`（与其他登录链同形状，`session.rs:716-721`）
- **实测要点**：不带 `ali_captcha_verify_param` → `631002 当前版本已停止服务`（误导性错误码，换任何 X-Version 都一样）；带假值 → `630014 抱歉,审核失败`；校验顺序**先验证码后 navigate_uri**（传 `not-a-url` 也只回 630014，`oauth.rs:25-31`）。**上游对 `navigate_uri` 只做非空校验，不校验形态与主机**——所以可用本网关 loopback 地址（`oauth.rs:47-55`）。码表：`631002`/`630014`/`631001`/`400001`/`400002`（`oauth.rs:209-228`）。

**④ 用户登录 + 回调截获**
- 前端把 `{state, authUrl}` 交给壳：Tauri 命令 `start_autoclaw_oauth_login`（`commands.rs:273-287`；`bridge.rs:167-173`，mode `embedded`/`external`）→ 内嵌 WebView 开官方登录页（**窗口不设白名单**，否则会拦掉 loopback 回调，`src-tauri\login.rs:218-244`）或系统浏览器。
- 浏览器完成登录 → **顶层 302 GET** 到 `http://127.0.0.1:<port>/api/session/login/autoclaw-oauth-callback/{vendor}/{task_state}?code=…&state=…`（免鉴权 public 组，`http.rs:87-90`；处理 `session.rs:739-764`）。用户拒绝时查询串带 `error`（`session.rs:752-755`）。响应是 HTML 页「登录成功，已返回网关，可以关闭此页面。」（`session.rs:761, 771-795`）。
- **两个 state 是两个不同的值（实测坑，`login\autoclaw.rs:163-176`）**：路径里的 `task_state` 是网关生成的任务键（CSRF 校验用）；**换码必须传查询串里上游回的 `state`**——传错稳定 `631001 授权码无效`。
- 校验：task_state 必须对应进行中任务、provider 必须是 autoclaw 系、待办表变体与 URL 一致、重复回调幂等返回成功（`login\autoclaw.rs:179-246`）。无轮询（回调是唯一入口），5 分钟超时兜底（`login\autoclaw.rs:109-120, 149-161`）。

**⑤ 换码（第二跳，不需要验证码）**
- `POST {intl}/userapi/overseasv1/zai-oauth-login`（或 `google-oauth-login`），body `{"source_id":"autoclaw","device_id":…,"code":…,"state":<上游state>,"navigate_uri":<与第③步逐字相同>}`（端点 `oauth.rs:127-133`；body `oauth.rs:343-349`）。实测假 code 回 `631001 User login error` 而非 630014 → 此跳不要求风控参数（`oauth.rs:42-46`）。
- 响应 `data`：`{access_token, refresh_token, user_id, user_name, first_login}`（`oauth.rs:22`）
- 凭证 payload：`{token, refreshToken?, deviceId, userName?}` → `add_autoclaw_account`（`oauth.rs:388-405`）

**登录后初始请求：无必做调用**（token 直接入库；`device_id` 两跳必须同值——`oauth.rs:329-334`）。

---

## 4. 对 Node.js/Electron 实现的几个提醒

1. 三家的 `/start` → `{state, authUrl}`、`/wait` 三分支协议完全同构，前端/壳只认这两个键（`core\login.rs:355-359`）。
2. Cline 的 `poll_and_register` 是**阻塞式 await 循环**（轮询+换码+落账号一气呵成，`login.rs:167-177`），`/wait` 只是读任务快照。
3. Qoder 的 `verifier`/`nonce`/`machine_id` 必须在一次登录内自洽：verifier 只进轮询 URL、machine_id 同时进授权页与轮询结果打包。
4. AutoClaw 签名的 `X-Auth-TimeStamp` 是**秒**（极易与毫秒搞混，`refresh.rs:216`）；MD5 输出小写 hex 无填充（与 Node `digest('hex')` 一致，`refresh.rs:232-233`）。
5. cline accessToken 的 `workos:` 前缀与 AutoClaw `code` 必须为 JSON 数字、Qoder refresh 打包串格式，是三个实测踩出来的硬约束，别“顺手修正”。

**未找到项汇总**：cline 无 scope/organization 参数、无 free/pass 登录差异；qoder 登录链无 COSY 签名、无独立设备注册调用；autoclaw 国际版 `navigate_uri` 上游不校验主机（因此无固定 redirect_uri 白名单需求）；autoclaw 国内版无 OAuth、国际版无短信入口。