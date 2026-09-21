# 设计：网关轻量后台模式（关窗回收 UI → 网关下沉独立进程）

日期：2026-09-21
状态：待评审
范围：两期交付，一期先出包（安装版 + 便携版本地打包，不走发布链路）

---

## 一、背景与目标

用户实际用法是「打开主界面配好一次，之后只用反代网关」。但当前关窗只是 `main.cjs:108-114` 的 `hide()`，UI 侧内存全程不回收；同时前端产物是单 chunk，重开窗口等于全量重解析。

目标（两期终态）：

| 阶段 | 形态 | 私有内存 | 依据 |
|---|---|---|---|
| 现状 | 关窗只 `hide()` | **321.5 MB** | 真实 app 关窗后实测（另一次独立读数 315.9 MB） |
| 一期后 | 关窗即销毁窗口 | **215.47 MB** | Task 7 真实打包版实测（无窗 3 进程，40 s 落定 5 次采样一字不差；相对开着窗的 424.86 省 209.39 MB / −49.3%） |
| 一期后（可选） | 启动即不建窗 | **166.05 MB** | Task 7 真实打包版实测（n=3，GPU 仅 32.2 MB，无建窗残留） |
| 二期后 | 主 App 退出，网关独立常驻 | **33.2 MB** | 探针实测 electron.exe-as-node（真实 app 的二期终态尚未量） |

> **这张表在 Task 7 之前被污染过一次，此处是更正后的版本**：原先「一期后 175.4 MB / 136.0 MB」两行引的是 §三那支**合成探针**（只建一个 `BrowserWindow` 的裸 Electron app，`tmp/gateway-probe/raw-window-longsettle.jsonl`）的数字，不是本应用的地板价。真实打包版无窗是 215.47，比合成探针的 176.94 高 38.5 MB，其中 **+27.7 MB 在 main**（反代网关 express、两个 SQLite、watch 快照器、两个调度器、配置与号池模块常驻）——这条有独立旁证：对用户自己那份实例做只读枚举得 `main:125.98`，与本构建关窗后的 `main:126.84` 同值，即**这块驻留与窗口无关，关窗路径回收不了它**。教训：探针量的是 Electron，不是 AgentHub，凡引探针数字进验收判据必须标注来源。

一期同时要满足：关窗后重开主界面**不掉体验**——这是「销毁窗口」方案不被察觉的前提。

**二期要付的代价，先写明白**：D3 选了单一拓扑，则「主 App 开着、窗口开着」的常态下内存比现状高约 **25 MB**（多一个 33.2 MB 子进程，主进程只从 99.17 瘦到 91.06）。**这两个 main 数是合成探针的，不是本应用的**——本应用真实 main 无窗驻留实测 126.84 MB（§一 表下说明），二期真正的靶子就是这 126.84 里网关 + 两个 SQLite 占的那部分，收益要按真实值重算，不能沿用 99.17→91.06 那 8 MB。这笔钱只在窗口开着时付，换来的是关窗后按一期实测的 215.47 MB、退出后的独立常驻进程（探针量 33.2 MB，真实终态待量），以及一套网关宿主实现。若不接受这个交换，退回 D3 的备选（可切换宿主），但那正是 D3 否掉的方向。

## 二、决策记录

| # | 决策 | 备选与被否原因 |
|---|---|---|
| D1 | 网关下沉到独立进程 | 曾估「只搬网关不改架构」，实测净亏：子进程 +33.2 MB，主进程 99.17→91.06 仅省 8 MB，净增约 25 MB。只有让窗口/主 App 一起消失才有收益 |
| D2 | 双拓扑并存，用户可选 | 用户明确要求「主 App 常驻」与「退出后继续转发」两者都要 |
| D3 | **单一宿主拓扑**：网关永远在子进程 | 备选「默认留主进程、常驻时才搬」被否：同一套网关代码两种宿主等于养两个 bug 面，且退出时需热迁移在途 SSE 流 |
| D4 | 常驻形态**无系统托盘** | `Tray` 需要 Electron main，纯 Node 进程建不了（探针实测：无窗 Electron 地板价 136.0 MB）。备选「koffi 自写 `Shell_NotifyIcon`」工作量和长期维护成本最高，不采纳 |
| D5 | 一期先出包，二期独立分支 | 二期含 4 个阻塞项（见 §五），任一卡住不该拖住一期已实测到位的关窗收益（Task 7：同一次运行 424.86 → 215.47 MB，−49.3%，4→3 进程） |

## 三、实测证据（本会话，探针脚本在 `tmp/gateway-probe/`）

私有内存（`PrivateMemorySize64`，WorkingSet 含共享页会虚高），每阶段采两次均值：

| 形态 | 进程数 | main | renderer | GPU | 其它 | 合计 |
|---|---|---|---|---|---|---|
| 纯 Node 网关（electron.exe as node，Node 22.16） | 1 | 33.22 | – | – | – | **33.22** |
| 纯 Node 网关（系统 node v26.4 对照） | 1 | 29.55 | – | – | – | 29.55 |
| 无窗口 Electron + Tray | 3 | 91.06 | – | 32.14 | 12.75 | 135.95 |
| 建窗 `show()` 稳定 | 4 | 99.17 | 55.83 | 269.17 | 13.07 | 437.24 |
| `win.destroy()` 后 | 3 | 98.15 | 0 | 64.24 | 12.98 | **175.37** |

配套结论：

- **无窗口仍会起 GPU 进程**（32.14 MB）+ network utility（12.75 MB）。销毁窗口后 GPU 停在 64.24 而非 32.14——「建过窗」有约 32 MB 残留，只有从头不建窗才拿得到地板价。
- GPU 数值抖动大（`show()` 后瞬时 313.72，一次复跑衰减到 107.83），验收时按多次采样取中位，不按单点判定。
- `node:sqlite` 在 Electron 35.7.5（内嵌 Node 22.16.0）**无需 flag 可用**，建表 + 1000 行 insert 通过，仅 `ExperimentalWarning`。
- `ELECTRON_RUN_AS_NODE=1 <打包 exe> <asar 内 .cjs>` 实测退出码 0，asar 内 `express` / `koffi` 可 require，`process.resourcesPath` / `process.execPath` 正常。此路径下 `require('electron')` 抛 MODULE_NOT_FOUND，故**不抢单实例锁**（`main.cjs:324`）。

凭据形态（本会话读真实库副本验证后已删除副本，仅留 `tmp/dbcheck/verify-encoding.cjs`）：

- `accounts.token_enc` 实测 3 条全部为 `enc:v1:` + base64，内层 blob 头三字节 **`v10`**，长度 1553 B。
- `%APPDATA%\AgentHub\Local State` 含 `os_crypt.encrypted_key`，头五字节 `DPAPI`，长 283 B。
- 即：**Chromium AES-256-GCM + DPAPI 包裹主密钥**，不是裸 DPAPI。单调 `CryptUnprotectData` 解业务值解不出来（它解的是主密钥）。
- 本机 `config.json` 无 `enc:v1:`（WebDAV 未配），但号池凭据必有，阻塞项对网关热路径成立。

## 四、一期设计

### 4.1 窗口生命周期：关窗即销毁

`main.cjs:108-114` 的 `close` 分支由 `hide()` 改为 `destroy()`。`destroy()` 绕过 `close` 事件，无递归风险；`main.cjs:381` 的 `window-all-closed` 本就是空实现（Windows 常驻托盘），销毁最后一个窗口不会退出应用。

重开复用 `main.cjs:121-128` 的 `showWindow()`——它已有 `if (!mainWindow) createWindow()`，`createWindow()` 内的 `ready-to-show` 揭示（`:93-100`）与 `applyViewportZoom`（`:103-105`）都是每次重建走一遍，无需新增。

两处窗口依赖要兜底，不重构：`ipc.cjs:109` 与 `proxy/index.cjs:413` 的 `dialog.showOpenDialog(BrowserWindow.getAllWindows()[0], ...)`。这两个调用只可能由已打开的窗口发起，但仍补「取不到窗口则不传 parent」的分支，避免将来把入口挪到托盘时静默抛错。

新增配置（见 §六）。

**验收**（Task 7 已按此量过；绝对区间那一版判据是错的，见 §一 表下更正说明）：

- 关窗后进程数 4 → 3（renderer 消失），且**同一次运行内**相对开着窗的私有内存降幅 **≥45%**（实测 424.86 → 215.47 MB，−49.3%；工作集 618.95 → 348.37，−43.7%）。
- 无窗三进程合计 **≤220 MB，且 main 单列 ≤130 MB**（实测 215.47 / main 126.84）。拆出 main 这一条是刻意的：main 里驻着网关与两个 SQLite，与窗口无关，关窗路径回收不动它——它是二期的靶子，不该让一期的门为它失败或为它放行。
- 原「150–200 MB」绝对区间**不由关窗路径达成，移交二期**：`launchHidden` 实测 166.05 MB 已在区间内，剩下那 49 MB 要靠把网关搬出 main（§五）才拿得到。
- 托盘双击 / `second-instance` 都能重开，重开后各页正常；重开的首帧实测（同一实例内、缓存热）FCP 504 / 1880 ms、DCL 362–433 ms，优于冷启动，规格「销毁窗口不掉体验」由此撑住。

### 4.2 后台扫描异步化（不改任何行为）

`watch.cjs:22` 的 `fingerprint()` 每 15 秒（`INTERVAL_SECONDS`）对全部扫描目标做 `readdirSync`(`:28`) + `lstatSync`(`:35`) + `statSync`(`:45`)，全同步 syscall，跑在与网关 express 同一个主进程事件循环上——这是每 15 秒一次的阻塞尖刺。

改为 `fs.promises` 异步版本，指纹语义（条目名 + 类型 + mtime + 目录内 `SKILL.md` 的 mtime:size）与「连续两拍稳定才动作」的判定完全不变。

原方案里「轻量态停掉 `watch`/`scheduler`/`usageScheduler`」**不采纳**：那会静默停掉用户已主动开启的自动收纳与定时同步。真要关，用已有的 `watch.enabled`（`config.cjs:131`）与 `schedule.hourly/daily`。

二期网关下沉后，转发不再与主进程争事件循环，本项收益进一步体现为「技能仓库页面更顺」。

### 4.3 首屏分包

现状 `dist/assets/index-*.js` **2445 KB** + `index-*.css` **584 KB**，零分包（`vite.config.ts` 无 `build.rollupOptions`）。三个原因，逐个处理：

**(a) 视图按块切。** `src/App.vue:18-38` 静态 import 25 个视图（模板 `:560-589` 已是 `v-if="seen(...)"` 懒挂载，但代码没懒加载）。改 `defineAsyncComponent`，切 8 块（再细就碎，收益抵不上请求数）：

| chunk | 内容 | 理由 |
|---|---|---|
| entry | 壳 + `Sidebar`/`PageTabs` + 三个常驻弹窗 + **三个候选落点视图** | 首屏落点是 `skills/dashboard` ∪ `sync/overview` ∪ `proxy/home` 三选一：`stores/app.ts:53-54` 默认 skills，但 `:102-106` 会用用户自定义 `orderedModules[0]` 覆盖 |
| echarts | vendor 独立 | 只 sync 页需要 |
| skills-rest | skills 其余 5 视图（约 61 KB 源码） | skills 内部闭环，无跨模块跳转 |
| sync-rest | `detail`+`log`+`costs` | 30 KB |
| sync-billing | `BillingRulesView`（37.5 KB） | 单独成块，体量最大 |
| proxy-rest | `keys`+`models`+`ccswitch`+`poolsync`+`stats`（约 70 KB） | |
| proxy-agents | `ProxyAgentsView`（62.9 KB） | 单独成块 |
| config | 三个 Config 段（26.6+24.2+14.3 KB） | |

模块间唯一通道是 `Sidebar.vue:271` 的 `selectModule` 与 `PageTabs.vue:47/57`，异步边界不破坏跳转。

**(b) Element Plus 按需注册。** `src/main.ts:21` 现在 `app.use(ElementPlus)` 全量注册 + `element-plus/dist/index.css`（**361,258 B**）。改 `unplugin-vue-components` + `ElementPlusResolver`。实际用到 19 个标签（`el-option` 40 次 / `el-button` 29 / `el-select` 18 / `el-switch` 11 …）+ `ElMessageBox` 一个服务式组件，按需 CSS 约 140 KB + `base.css` 7.9 KB。

> **必须同批改的高危点**：`main.ts:21` 的 `{ locale: zhCn }` 是全库唯一 locale 注入点。按需注册后没有全局配置，`el-date-picker` 面板的月份/星期会**静默回退英文**（用在 `TrendChart.vue:286`、`DetailView.vue:178`）。改用 `<el-config-provider :locale="zhCn">` 包住根节点。`ElMessageBox` 需手动引样式（`el-message-box.css` + overlay/input/button）。

**(c) echarts 按需。** `TrendChart.vue:3` 与 `CostTrendChart.vue:3` 的 `import * as echarts`（全量 min 版 1,034,102 B）。实测只用到：series `LineChart`；组件 `GridComponent`/`TooltipComponent`/`LegendComponent` + `LegendScrollComponent`（`TrendChart.vue:223` 的 `legend.type:"scroll"`。这条**从来不是必需**——Task 3 用 `npm pack` 核对了 5.4.3 与 5.6.0，两者 `legend/install.js` 都自带 `use(installLegendScroll)`，只注册 `LegendComponent` 也能解析 `legend.scroll`；显式注册零成本，保留但别当必需、也别当冗余删）；`CanvasRenderer`；`graphic.LinearGradient`（`echarts/core` 已导出，无需注册）。
**不需要** `HeatmapChart`——`Heatmap.vue` 是纯 DOM 格子（`:157-202`），完全不碰 echarts。`TooltipComponent` 内部已 `use(installAxisPointer)`，不必显式注册。全库无 `registerTheme`。
`TrendChart.vue:15`/`CostTrendChart.vue:14` 的 `echarts.ECharts` 类型引用要转 `import type`，否则 `npm run build` 的 vue-tsc 会把整包重新拉回。

**(d) Phosphor 子集。** `src/assets/phosphor/style.css`（82,758 B）定义 **1530** 个 `.ph.ph-*:before`，src 实际用到 **82** 个类名，加后端 `toolIcon()` 下发的 8 个（`electron/backend/*.cjs`：`ph-brain ph-code ph-command ph-folder-open ph-package ph-robot ph-sparkle ph-terminal-window`）共 **88** 个，CSS 侧做规则子集约 5 KB。`Phosphor.woff2` 147,380 B 的字形子集**推迟**：需要 `fontTools/pyftsubset`（本机有 Python 无 fontTools，不擅自装系统依赖），且字体文件是按需缓存的静态资源、不参与解析，收益只在安装体积上。

**(e) 死重清理。** `src/api/ipc.ts:21` 无条件引 `mock.ts`(32.6 KB)、`src/api/sync.ts:7` 引 `sync-mock.ts`(26.4 KB)，仅 `dev:web` 浏览器预览用（`ipc.ts:49-50`）→ 约 58 KB 移出生产构建（改成浏览器回退分支里的动态 `import`）。`src/styles/element.css:320-355` 的 `.el-table` 整块删除（`<el-table` 全库零使用）。**`.el-textarea__inner` 不删**：它在 `:292`、`:301`、`:310` 是逗号选择器组的成员，删要拆组、收益不足 1 KB，风险与收益不成比例；`ProxyAgentsView.vue:885` 用的是原生 `<textarea>`，与 EP 那个类名无关，既不构成保留理由也不构成删除依据。

**(f) CSS 不能整文件延后的三处。** `sync.css`(72.3 KB) 与 `skills.css`(18.5 KB) 被常驻组件依赖：`SyncDialog.vue:51`、`ConfigDataSection.vue:146`、`ConfigUsageSection.vue:228`、`ConfigWebdavSection.vue:182,228` 根节点都带 `sync-scope`；`SkillsHelpDialog.vue` 全用 `sk-*`。`Heatmap.vue:190` 的 `.heat-tip` Teleport 到 body 且不受 scope 约束（`sync.css:3187`），`@keyframes` 也是全局规则。`element.css:526` 的 `.el-popper.glass-popper` 被壳用（`Sidebar.vue:285`）。→ 这两份 CSS 留在 entry，只按规则块瘦身，不做整文件懒加载。
`main.ts:5-13` 的引入顺序约束（EP index.css → dark css-vars → phosphor → global → skills → sync → element，注释在 `:6`）**保持不动**：分包只影响 JS 与异步 chunk 自带 CSS，entry CSS 内部相对顺序不变。

**验收**：首屏 entry JS 目标 ≤700 KB（现 2445 KB），回归门槛按 **800 KB** 硬失败（留机器与 tree-shaking 抖动余量）；entry CSS **≤325 KiB**（现 584 KB）——250 KB 与本节自己的约束矛盾（`sync.css` 72 KB、`skills.css` 18 KB 必须留 entry），320 KB 又错在按 phosphor **源码** 82 KB 估可省量（压缩后实占 60 KB、子集 3.7 KB，实省 57 KB）；按需 EP 约 140 KB + `global.css` 66 KB 等叠起来的实测地板价是 **321.0 KiB**，门槛取 325 KiB。echarts 不进 entry chunk。构建产物用 `dist/assets/` 文件名与字节数直接核，不看构建退出码。

## 五、二期设计：网关下沉独立进程

**二期继承的一期未达项（Task 7 实测带来，写死在这里免得丢）**：把无窗常驻从 215.47 MB 拉进原定的 150–200 MB 区间。靶子是 main 那 **126.84 MB**（与窗口无关，关窗回收不动；用户自己那份实例只读枚举同为 125.98 MB），二期把网关 express + 两个 SQLite + `credits`/`rules` 热路径下沉到子进程之后，必须重量这块并给出拆解，而不是沿用 §三 探针的 `99.17 → 91.06`（那是 Electron 的数，不是本应用的）。同一次量测要顺带回答一期留下的一个单点观测：一轮完整逐页导航后 main 从 121.32 涨到 147.10 MB（顾虑：会不会随使用继续爬）。

### 5.1 进程切分线

- **子进程**（`electron/gateway.cjs`，纯 Node）：`server` / `store` / `rules` / `pool` / `poolsync` / `adapters` / `credits` / `discovery` / `events`（改为写管道）/ `ideswitch` / `ccswitch` / `util` / `raccoonAuth`。
- **主进程**：窗口、托盘、`dialog`、`shell.openExternal/openPath`、配置写盘、技能仓库、用量同步、自动更新。

依据：`index.cjs` 注册的 43 条 `proxy_*` 全部是「窗口打开时才需要」（`ProxyHomeView` 的 5s 轮询等）；后台自动路径（请求转发、`credits.startScheduler` 30min 自续、`checkinAutoTick` 60s、`rules.cjs:269` 的 chokidar 热加载）**不经任何 IPC**，可整体下沉。

### 5.2 命令通道：Windows named pipe

43 条 `ipcMain.handle` 的**名字全部保留**，实现体换成 `gw.call(cmd, args)` 转发 → `src/api/ipc.ts` 与 `preload.cjs` 白名单零改动（规避 AGENTS.md 第四节的「漏登记→未授权 IPC」坑）。

通道用 named pipe（`net.createServer()` 的 pipe path），**不开第二个 TCP 端口**：不占端口、无防火墙面、随进程消失。握手：主进程 spawn 时生成随机 token 经 stdin 传入，子进程把 `{pid, pipe, token, port, version, startedAt}` 写 `%APPDATA%\AgentHub\proxy\gateway.json`。

安全论证（写进规格以免将来误判为降级）：`proxy_keys_list` 等命令返回明文 secret，改经管道后暴露面不高于现状——能读 `gateway.json` 的进程必然已以同一 Windows 用户身份运行，而号池密文与 `Local State` 主密钥本就是用户级 DPAPI 绑定，该进程直接读 `stats.db` 也能自行解密。

**管道帧是双向的**，不是纯 request/response。子进程会主动推事件（现状 `events.cjs:11-15` 向所有窗口 `webContents.send("app:event", ...)`，调用点含请求完成、`credits` 刷新、`poolsync` 进度、`oauth-done`），主进程收到后转发给窗口。帧带 `type: "response" | "event"`，`response` 用 `id` 配对。主进程无窗口时事件帧直接丢弃（与现状 `getAllWindows()` 空转语义一致）。

**超时**：普通命令 10 s 上限。`proxy_poolsync_run`、`proxy_checkin_run`、`proxy_credits_refresh` 这类长任务**不设管道超时**——它们本就是立即返回、进度靠 `type:"event"` 回流（`poolsync` 现状即如此），超时留在任务自己内部。队列不得无界：待响应数超阈值时拒绝新命令并回错，避免主 App 卡死时子进程堆内存。

响应体量集中在 `proxy_pool`（全量号池 × 4 渠道）与 `proxy_stats_detail`（分页 ≤100 行），序列化成本可接受。

### 5.3 凭据解密（阻塞项，先做）

子进程内自带 v10 解密：koffi `Crypt32!CryptUnprotectData` 解 `Local State` 的 283 B `DPAPI`+wrapped key → 剥前缀得 AES-256 主密钥 → `node:crypto` AES-256-GCM 按 `v10` + 12 B nonce 解业务值。**对存量密文 100% 兼容**（同一套方案），无需迁移。

不能走「主进程 RPC 回填」：热路径上每次 chat completion 至少 4 次解密调用（`server.cjs:644` → `settings()`(`index.cjs:83`) → `config.loadConfig()` → `decryptSecret` ×2，加 `server.cjs:89` `store.accountSecrets` ×2），逐次跨进程往返直接劣化 TTFT；且与「主 App 可整体退出」自相矛盾。

配套闸门：

- `config.cjs:34` `encryptSecret` 在 `safeStorage` 不可用时**静默明文落盘**，而 `server.cjs:96` 的 401 刷新会写 token → 独立进程一旦跑起来就可能把明文 token 混进号池。改为「无加密能力则拒写并抛错」。纯 Node 自测环境（`scripts/dev-ccswitch-test.cjs`、`tools/proxy-smoke.cjs`）走只读降级路径，不受影响。
- `config.cjs:38-47` `decryptSecret` 解不开时返回 `""`，后果是 `store.cjs:279-292` `tokenUsable` 判所有账号不可用 → `pool.cjs:43` 无候选 → 503。改为**启动期即失败并报「凭据解密失败」**，而不是空号池空转。

### 5.4 数据与配置写权

- `stats.db` 由子进程**独占**：主进程不再 require 网关 store（现状 `ipc.cjs:472` → `proxy.register` 会把整张依赖图包括 `store.cjs` 拉进主进程）。
- WAL：`store.cjs:128-129` 只设 `journal_mode=WAL` + `busy_timeout=5000`，全仓无 `wal_checkpoint`，`store.close()`(`:551`) **无任何调用点**（`proxy.shutdown()` `index.cjs:177-182` 只停 server）。实测本机 WAL 已 1.59 MB 且自 16:41 起零次 checkpoint。补：退出路径调 `close()`、运行期周期性 `PRAGMA wal_checkpoint(TRUNCATE)`。`busy_timeout=5000` 在双进程争锁时会卡转发 5 秒，故必须单一写者。
- `config.json` 唯一属主 = 主进程。子进程只读配置 + 通过管道请求写。`config.cjs:370` 用固定 `.tmp` 名，跨进程 rename 会互踩，临时文件名加 pid。
- `rules/*.json` 由子进程只读监听（`rules.cjs:269` chokidar）；写规则仍走主进程 `config` 域。

### 5.5 生命周期、认领与自启

- 主 App 启动 → 读 `gateway.json`：`kill(pid,0)` 存活探测 + 管道连通双检；通过则**认领**（界面标「后台常驻中」，不产生第二个进程），否则回收重启。
- 版本不匹配（升级后 exe 路径可能已失效，尤其便携版的 `%TEMP%` 解压目录）→ 回收重启，且**先停旧再起新**（顺序反了新进程会 EADDRINUSE）。代价是打断在途 SSE 转发；这只在主 App 启动时发现 `gateway.json` 的 version ≠ `app.getVersion()` 才发生，与 §5.6 的装更互锁是同一条「优雅停 → 超时兜底强杀 → 确认端口释放」实现，两个入口共用。
- 退出时按 `schedule.persistentGateway` 决定 kill 还是 detach。子进程带父 PID 看门狗：父进程没了且 `persistentGateway=off` 时自行退出，避免孤儿。
- 现状缺口：全 `electron/backend` 无文件日志、无 pidfile（`store.cjs:27` 注释宣称 logs 在 proxyDir，实际该目录不存在）。二期新增最小日志落盘（`proxyDir()/logs/gateway.log`，超 2 MB 轮转、保留 1 份旧档）与上述 `gateway.json`。
- `/healthz`(`server.cjs:654`) 现在把「进程活着」和「号池健康」混为一谈，监督器据此重启会对空号池打重启循环 → 拆成 liveness 与 readiness 两个语义。
- **开机自启常驻网关**：`config.cjs:395-401` 的 `setLoginItemSettings` 登记的是主 App，且注册表 Run 键无法设环境变量。改为随包安装一个启动器脚本（安装目录内 `agenthub-gateway.cmd`：`set ELECTRON_RUN_AS_NODE=1` + 以 asar 内 `electron/gateway.cjs` 为参数复跑同目录 exe），自启项登记该 `.cmd`。
- **便携版禁用后台常驻**：exe 从 `%TEMP%` 解压副本运行，主进程退出后解压目录被删而子进程仍锁着文件（与 AGENTS.md 记录的自启失效同源）。

### 5.6 自动更新互锁

`updater.cjs:268-287 triggerInstall` → `main.cjs:362-373` 的 `before-quit` 只调本进程 `proxy.shutdown()`(`index.cjs:181`)，够不到子进程：9527 仍被占、`AgentHub.exe` 映像仍被锁，NSIS 覆盖安装会失败或挂住（AGENTS.md 记录过 electron-builder 撞文件锁卡 10 分钟）。改为：停子进程 → 用 `server.stopAsync()`(`server.cjs:713-726`) 语义确认端口释放 → 才 `quitAndInstall`；停不下来要报错给用户而不是静默卡住。

### 5.7 归属划分（留主进程的四条）

`proxy_account_import_file`（`index.cjs:412-420` 文件框）、`proxy_open_rules_dir`(`:514`)、`proxy_open_data_dir`(`:519`)、`proxy_oauth_begin` 的 `shell.openExternal`(`:391`)。其余 39 条纯转发。

`ccswitch.cjs` 与 `ideswitch.cjs` 本身是纯文件/SQLite 写，不需要 UI，跟网关走；但 `ccswitch.cjs:342-344` 注册条目时的端口回落读 `config.proxy.port`，双拓扑下真实监听端口在子进程 → 必须改从子进程状态取，否则注册进 CC Switch 的 `base_url` 指向死端口。

## 六、配置项与语义变更

三个新字段全放 `config.cjs:122` 的 `schedule` 段（与 `minimizeToTray`/`autoStart` 同段），深合并自动补齐，存量 `config.json` 无需迁移代码。UI 落在设置 · 通用 · 应用行为（`ConfigGeneralSection.vue:294-304` 那组开关旁）。

| 字段 | 默认 | 期 | 语义 |
|---|---|---|---|
| `schedule.liteOnClose` | `true` | 一 | 关窗即销毁窗口回收 UI 内存；关掉则回到今天的 `hide()` 秒开行为 |
| `schedule.launchHidden` | `false` | 一 | 启动不建窗，直接进托盘（再省约 39 MB GPU 残留） |
| `schedule.persistentGateway` | `false` | 二 | 主 App 退出时保留网关进程（无托盘） |

字段间的关系，避免实现时各写各的：

- `liteOnClose` 仅在 `minimizeToTray = true` 时有意义。`minimizeToTray = false` 时关窗就是退出应用（现状语义），销毁与否无从谈起。设置页在 `minimizeToTray` 关闭时把 `liteOnClose` 行灰掉。
- `launchHidden` 只影响**首次**建窗时机；窗口一旦被打开过，关闭仍走 `liteOnClose`。两者独立，不互斥。
- 三个字段都不新增 IPC 命令：走现有 `save_config` / `load_config` 通道。

**`proxy.restoreOnLaunch` 必须重定义**（`config.cjs:138`）。现义是「记住上次退出时网关开没开」，判断点在 `index.cjs:165 boot()` 里的 `if (settings().restoreOnLaunch) server.start(...)`。

二期在 D3 之下，**子进程常驻与网关是否在监听是两件事**：子进程可能活着但没 listen（用户从没开过网关，或开了又手动停了）。沿用旧定义会出现两种误读——「常驻进程在跑所以网关该通」和「上次是开的所以这次进程该在」。

新定义锁死在监听层：`restoreOnLaunch` = **本次启动时，是否让（可能新建或认领来的）子进程进入监听状态**。`persistentGateway = true` 时，detach 出去的不是进程而是「监听中」这个状态；主 App 下次启动认领回来即可。落到代码是子进程启动/认领后按该字段决定发一次 `server.start` 还是 `proxy_status` 查询。这条要在实现前同时落到设置页文案与 `index.cjs:165` 的注释。

## 七、错误处理

1. 子进程起不来（管道失败 / exe 被锁）：显式报错并给可操作提示，**不得让网关页卡在「检测中」假死**（AGENTS.md 第四节正是这类教训）。前端只把错误写进 state 就会卡住，需要错误态渲染。
2. `gateway.json` 陈旧（pid 复用 / 被任务管理器杀）：认领前 `kill(pid,0)` + 管道连通双检，任一失败即回收重启。
3. v10 解密失败：启动失败并报「凭据解密失败」，不得静默判所有账号不可用。
4. 在途转发时退出：沿用 `server.stopAsync()` 的 `closeAllConnections` + 1s 兜底（`server.cjs:713-726`）。
5. 端口 EADDRINUSE 且占用者是已运行的常驻网关：文案从「端口已被占用，请更换端口」(`server.cjs:695-697`) 改为「已接管后台常驻网关」。`server.cjs:686` 的 `already` 只判本进程 `runtime`，跨进程无感知。

## 八、测试与验证

| 项 | 手段 |
|---|---|
| 一期体积 | 核 `dist/assets/` 分块字节数（不用构建退出码代替产物检查）；目标见 §4.3 |
| 一期耗时 | CDP 实测「建窗 → 可交互」（AGENTS.md 第三节流程）；探针 `tmp/gateway-probe/memtree.ps1` 可复用 |
| 一期内存 | 关窗前后采 `PrivateMemorySize64`，对齐 **§4.1 更正后的判据**（相对降幅 + main 单列）。**不要**对齐 §三——那张表是合成探针，量的是 Electron 不是本应用（教训见 §一 表下说明） |
| 探针卫生（一期 Task 7 暴露，二期必须遵守） | 用临时 userData 起打包版实例**并不等于隔离**：`hubDir()` 按 `os.homedir()` 解析，仍会读写共享中央仓库 `~/.agent_skills`；packaged 且非便携的实例每次启动都调 `applyAutoStart`，`autoStart` 默认 false 时会把**用户自己的**开机自启 Run 项删掉。故探针三件套：`AGENT_SKILLS_HOME=<临时目录>`（或临时 config 里 `watch.enabled:false`）+ 网关端口改到非 9527（9527 归用户实例，拿它的应答当本构建的证据是错的）+ 收尾核对 HKCU Run 值列表未变。一期四个探针脚本在 gitignored 的 `tmp/gateway-probe/`，二期复用时**四个一起**提到 `tools/`，别只提 `.cjs`（会留下对 `memtree.ps1` 的悬空引用）。另注意 `proxy.boot()` 里的 `discovery.cjs:34,37,347` 会读**真实本机登录文件**（CodeBuddy/Trae 的本地 auth），临时 userData 挡不住它——一期那次隔离实例 `/v1/models` 能列出 `trae` 的模型就是这个原因（只读，discovery/adapter 侧无写入调用；但报告写「号池为空」时必须同时说明这点），二期把 discovery 下沉到子进程时要一并处理 |
| 按需注册静默坏掉 | 新增 CDP 冒烟：6 个 chunk 落点页各截一次 DOM，断言图表 canvas 存在、`el-date-picker` 面板月份为中文、图例已渲染 |
| 图标子集 | 纯静态比对：`src` 用到的类名 ∪ 后端 `toolIcon()` 下发集合 ⊆ 生成的子集 CSS |
| 二期 | 矩阵：安装版/便携版 × 常驻开关 × 升级装更。验「主 App 退出后 9527 仍通」「重开认领不起第二个进程」「WAL 不再单调增长」「装更前子进程已停」 |
| 回归底线 | `npm run build` + `tools/proxy-smoke.cjs` + `tools/proxy-regress.cjs` + `scripts/dev-ccswitch-test.cjs`（靠 `CCSWITCH_DB_PATH` 隔离，勿 `delete process.env` 构造缺库场景）+ `scripts/dev-sse-delta-test.cjs` 全绿 |

打包前置：electron-builder 会被**自己产物目录里**的运行实例锁住（`release\win-unpacked\AgentHub.exe` 及其子进程、`%TEMP%` 里便携版解出的子进程），打包前只清这些。**用户自己安装的实例不在清理之列**（本机装在 `H:\AgentHub`，它不锁仓库产物）；真撞锁且归因不到自己头上，停下来报告，不擅自终止用户进程。

## 九、顺手修的既存缺陷

只限于本次改动确实经过的文件：

- `ph-radar`（`ConfigSkillsSection.vue:266`）、`ph-packages`（`SkillsHelpDialog.vue:56`）在字体表里不存在，现状即空白图标。子集化会让人误判为分包引起，一并纠正为已存在字形。
- `src/assets/phosphor/style.css:4-7` 的 `@font-face` 声明了 `.woff`/`.ttf`/`.svg` 三个不存在于目录的文件，产物里仍留着这三条死 URL。子集重写时清掉。`font-display: block`（`:10`）改 `swap` 与否按首帧表现定，不作为本期目标。
- `store.cjs:13-25` 的 `better-sqlite3` 回退分支是死代码（不在 `package.json` 依赖里）。二期中改 `store.cjs` 时顺手删。
- `echarts` 在 `devDependencies` 且声明 `^5.4.3` 而实装 5.6.0；`Heatmap` 相关的历史注释若与实际不符一并订正。
- `main.cjs:328` 的 `second-instance` 忽略 argv，无法区分「点图标」与「重复启动带参数」，二期认领逻辑需要参数区分时补。

## 十、非目标

- 不碰发布链路：`package.json` 的 `build.publish`、`.github/workflows/release.yml`、`updater.cjs:8` 的 `GITHUB_REPO_URL`、`ccswitch.cjs:274` 的 `website_url`、`ConfigProxySection.vue:383` 的展示文案——全指向上游仓库，是否改成 fork 是产品决策。
- 不改 `extraResources`、不改 `resources/sqlcipher` 归属（只被 UI 侧动作 `proxy_scan` 经 `adapter-trae-common.cjs:116-140` 使用，转发链路不需要，留主进程）。
- 不引入上游贡献、不发 Release（AGENTS.md 第一节：只本地打包）。
- 不做大 UI 改版；新开关复用现有设置行样式。

## 十一、落地顺序

**一期**（一个计划内可完成，四个可独立回滚的提交）：
1. `watch.cjs` 指纹扫描异步化（零行为变更，先落）。
2. 前端分包 (b)(c)(d)(e)（含 locale 与类型引用两处必修点）。
3. 视图分块 (a) + CSS 处理 (f)。
4. 关窗即销毁 + `launchHidden` + 两处 dialog 兜底 + 设置项。

**二期**（阻塞项按依赖排序，任一不通不得继续）：
1. 凭据自带解密 + 拒写明文闸门。
2. 写权归属（`stats.db` 独占、`config.json` 单属主、WAL checkpoint、`store.close()` 调用点）。
3. 生命周期基座（`gateway.json` + 认领双检 + 看门狗 + 日志 + liveness/readiness 拆分 + 启动器 `.cmd` + 便携版禁用）。
4. 更新/卸载互锁。
5. 43 条命令转发化 + 管道层 + `ccswitch` 端口取自子进程 + UI 文案。

**计划切分**：本规格覆盖两期终态，但实现计划**分开两份**——`writing-plans` 先只出第一期（§四 + §六 的两个一期字段），一期打包验收（内存对齐 §三、体积对齐 §4.3）通过后，再为 §五 出第二份计划。两期各自的提交都要能独立回滚。
