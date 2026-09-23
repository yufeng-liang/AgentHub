# 网关轻量三期设计：合并上游 → 单一「轻量模式」入口 → WAL 收敛

日期：2026-09-23
分支基线：`perf/gateway-lite-mode-phase2` @ `0b836a5`（二期 34 提交，未合并）
上游基线：`upstream/main` @ `eafd005`（v1.18.1），与本地 merge-base 为 `27a84c3`（v1.16.1）
前置文档：`2026-09-21-gateway-lite-mode-design.md`（一期规格，§四 记有二期收口对账）
实现计划：达成批准后由 writing-plans 另出 `2026-09-23-gateway-lite-mode-phase3.md`

---

## 一、为什么是这三件事

二期真机批次（2026-09-23）留下的三类尾巴，按「用户可感知 → 判据可关闭 → 目标要重定」排序：

1. **入口语义没收**：二期计划原文把「`launchHidden` 与常驻合并成单一轻量模式入口」明确排除在外。今天设置页那张卡有 5 个开关，其中 3 个互相灰置驱动，用户要读文案才知道彼此关系。
2. **判据 4 半达标**：WAL「不再单调增长」达成，绝对值 64KB 未达，且失败原因不可观测。
3. **判据 1 未达标且方向被证否**：main 侧 ≤60MB 这个目标，二期实测证明"继续搬模块"拿不到——需要一次取证来决定注销还是重定靶子。

另有一条外部约束改变了开工顺序：**上游 v1.17.0 / v1.17.1 / v1.18.0 / v1.18.1 已落地 16 个提交**，其中 MiMo 用量源、用量统计性能优化（含连接级 PRAGMA）、会话头稳定性、SSE 出线判据都改在我们同一批 proxy 文件里。三期在合并前开工就是给自己造二次冲突。

## 二、前置事实（本期设计的依据，全部已实测）

| 事实 | 数值 / 结论 | 出处 |
|---|---|---|
| 常驻 detach 后单进程私有内存 | **76.94 MB**（判据 2 达标；一期靶子 215.47 MB） | 二期矩阵格 B |
| 关窗销毁后 main 自持私有内存 | **130.26 MB**（判据 1 未达 ≤60）；回收量在 renderer 47.90→0 与 GPU 页 | 二期矩阵格 A（memtree 按 root pid 自持行取值） |
| 导航 8 样本 main 序列 | `129.01, 136.40, 141.31, 134.88, 136.25, 135.29, 132.92, 132.10` → 一期 121.32→147.10 单点不成立为持续爬升 | 二期判据 3 |
| 泡机 WAL | 50 条 HTTP 失败请求后 **1,388,472 B**，t+3→t+30min 恒定不动 | 二期判据 4 |
| WAL 微测（纯 Node 直连 store） | 同样 50 条 `insertUsage` 得到 **一字不差的 1,388,472 B**，`checkpoint()` 返回 `true` 并截到 **0**；第二轮 494,432→0 | `tmp/gateway-probe/wal-micro-probe.cjs`（一次性微测，不入库；其结论由 §六 第 2 步的正式闸固化） |
| 子进程装配 | `electron/gateway.cjs:105` 在 `store.open()` 后**无条件** `startCheckpointTimer()`，`CHECKPOINT_MS=5min` | 代码 |
| 由此排除的假设 | ① 「TRUNCATE 机制缺失」——排除（微测里同一个 `checkpoint()` 把 1,388,472B 截到 0）；② 「失败请求泄漏事务」——**也已排除**：`electron/backend/proxy/*.cjs` 全文无 `BEGIN/COMMIT/ROLLBACK`，且 store 只用 `.all()`/`.get()`（无未耗尽游标）。剩「子进程里 `checkpoint()` 的返回值是 false 还是根本没被调用」二选一，**外部不可观测正是当前缺陷本身**，故 §六 第 1 步先做留痕 | grep 清点 |
| Electron 自启缺陷 | 35.7.5 的 `setLoginItemSettings({path})` 会吃掉路径反斜杠（实测 `H:\x\y.cmd` 落盘 `H:xy.cmd`），二期已改 reg.exe 直写并真机验证 | 提交 `835dc94` |
| 装更判据 | NSIS 保留包内 mtime，判"装成了"必须用 ctime；且安装器在应用仍运行时会静默放弃 | 二期批次③ |
| 打包态隔离 | 主进程 userData 由 Chromium 已知目录决定（APPDATA 环境变量无效），子进程 `ELECTRON_RUN_AS_NODE` 下 `dataDir()` 回退读 APPDATA → 两者必须成对注入 | 二期规格 §八 第六条 |

## 三、范围与非范围

**范围内**：合并上游 16 提交；设置页入口收敛（含 `launchHidden` 默认值变更）；WAL 收敛的留痕→取证→修复→（可选）兜底；终审遗留 5 条 Minor；一次 main-60MB 取证 spike；三期末按同一套矩阵重量数字。

**范围外**（明确不做）：
- 不改 D3 的单一拓扑决策，不引入可切换宿主（一期已否）。
- 不换架构（Tauri 迁移已于 2026-09-22 评估否决）。
- 不为上游同步改发布链路：`build.publish`、`release.yml`、`updater.cjs:8` 的 `GITHUB_REPO_URL`、`ccswitch.cjs` 的 `website_url`、`ConfigProxySection.vue` 展示文案**五处保持指向上游**，三期不碰（产品决策，需另议）。
- 不引入前端测试框架（vitest 等）：入口合并的验证走 CDP 真机，理由见 §七。

## 四、Task 0：先合上游（阻塞其余全部工作）

**分支策略**：从 `perf/gateway-lite-mode-phase2` 切 `perf/gateway-lite-mode-phase3`，二期分支保持不动作为回退点。`git merge upstream/main` 在新分支上进行。

**冲突量的真相**（`git diff --numstat HEAD upstream/main`，+ = 上游独有，− = 我们独有）：二期资产几乎全是单边新增（`dev-gateway-*` 六闸、`tools/*` 探针、`secretbox.cjs` +0/−192），合并不会碰它们。真正两侧都改的是 10 个文件：

| 文件 | 量 | 解法 |
|---|---|---|
| `electron/backend/proxy/index.cjs` | +55 / −189 | 上游的 handler 体改动一律落在**子进程 `dispatchTable()` 一侧**（二期架构规则不变）；冲突是文本级不是结构级 |
| `electron/backend/proxy/store.cjs` | +21 / −123 | 上游改 stats 读侧、我们改写侧句柄归属；两侧都留。**注意**：上游的连接级 PRAGMA 在 `electron/backend/db.cjs`（用量库），不得与这里的 WAL PRAGMA 叠成互斥设置 |
| `proxy/adapters.cjs` +70/−25、`proxy/discovery.cjs` +101/−5 | 上游新功能（MiMo 适配器、discovery 扩展） | 基本取上游，我们那几行手工回并 |
| `electron/backend/config.cjs` | +26 / −81 | 保我们的 `applyAutoStart`（reg.exe 版）+ 深合并默认；手工并上游那 1 行默认值 |
| `electron/preload.cjs` | +2 | 上游新增命令名 → **同一提交内**同步进 `dev-gateway-forward-parity-test.cjs` 基线，否则该闸当场红 |
| `package.json` | +3 / −17 | 版本取上游 **1.18.1**（跟上游走以减少后续冲突；代价见下）；我们的 `build.extraFiles` / `allowScripts` 块保留 |
| `App.vue` `api/ipc.ts` `api/mock.ts` `api/sync.ts` `stores/*` `types/sync.ts` `views/proxy/ProxyAgentsView.vue` `tools/proxy-smoke.cjs` `dev-sse-delta-test.cjs` | 小 | 同一动作：新命令过「preload 白名单 == 主进程一期基线 == 子进程 dispatch 表」三处对齐 |

**三个提交，顺序固定**：① merge 解冲突；② 新命令归属判定 + 白名单 + parity 基线对齐；③ 版本号 1.18.1（含 `electron:pack` 重建）。

**代价（写明白）**：版本跳到 1.18.1 意味着二期真机验过的两条要在三期末重验（常驻 detach 存活、自启 Run 项目标正确），且本机 `H:\AgentHub` 要重装一次 1.18.1。

**Task 0 验收（不另发明标准）**：`npm run build` + 下列 14 道闸全绿——一期 4（`dev-watch-test` / `dev-config-lite-defaults-test` / `dev-ccswitch-test` / `dev-sse-delta-test`，含上游带入的 33 条断言）+ 二期 8（`dev-gateway-node-load-test` / `dev-secretbox-test` / `dev-write-ownership-test` / `dev-gateway-pipe-test` / `dev-gateway-forward-parity-test` / `dev-gateway-interlock-test` / `dev-gateway-launcher-test` / `dev-usage-scheduler-test`）+ `tools/proxy-smoke.cjs` + `dev-bundle-check --check`（基线刷新以**单独提交**入库）。**Task 0 不绿，§五之后一律不开工。**

## 五、入口收敛：单一「轻量模式」

**四个字段并不正交**，这是本节全部设计的前提：`minimizeToTray` 是总门（它一关，`liteOnClose`/`launchHidden` 就无意义）；`persistentGateway` 是跨登录会话的承诺（还牵动开机自启注册目标）；`restoreOnLaunch` 与"轻不轻"正交，**留在代理页不动**。

**数据模型：纯呈现层聚合，零 schema 变更（不加新字段、无迁移）**
- 读 = `liteOnClose`（主特征"关窗即释放界面内存"）；写 = 一次同写 `liteOnClose` + `launchHidden` 两条。
- `main.cjs:454` 与关窗销毁两处读取点一字不动；`sync-config.cjs` / `stores/sync.ts` / `types/sync.ts` 对 `minimizeToTray` 的镜像关系不动（该字段引用面 13 个文件，是全场最宽的耦合点）。
- 取舍如实写明：磁盘上仍是两个布尔（它们确实是两个时刻），代价是"部分为真"的老配置在 UI 显示为关，用户点一下即归一；不做三态/indeterminate，不做"高级"逃生口。

**设置页那张卡 5 行 → 4 行**
1. `开机自启` —— 原样（`autoStart`，`isPortable` 灰置）。
2. `关窗后留在托盘（不退出）` —— 即 `minimizeToTray`，**只改行名与文案**（现在是绕口的否定式"关闭最小化到托盘"），字段与语义一字不动。
3. **`轻量模式`（新行，灰置条件 `!minimizeToTray`）** —— 聚合行，副标题："关窗即结束界面进程、下次启动不自动开界面，需要时点托盘图标打开。代价是重新打开要多加载一次界面。"
4. └ `主 App 退出后网关继续常驻` = `persistentGateway` —— **轻量模式开时作子行，关时升为平级独立行**（仍受 `isPortable` 灰置）。

**「隐藏 ≠ 清零」是硬约束**：关掉轻量模式会把 `launchHidden` 一并写 false（下次启动恢复弹界面），但**绝不允许顺手清掉 `persistentGateway`**——它可能对应一个正在后台常驻的网关和一条已注册的开机自启项。规则因此是"这一行的位置会变，但它永远有地方关"。

**唯一的真实行为变更（已确认）**：`launchHidden` 默认 `false → true`，即**装好后开机默认不再自动弹出主界面**，直接缩在托盘。聚合读规则要与默认态自洽，这一条必须一起改，否则出现 UI 与磁盘不一致的窗口期。

## 六、WAL 收敛：先留痕，再取证，再修，最后才谈 PRAGMA

1. **留痕先行**：`store.checkpoint()` 的返回值与前后 `walBytes()` 落子进程日志（`log.line("wal-checkpoint", {ok, before, after})`），并把 `walBytes()` 挂进 `proxy_status`（或 `/status`）一个字段。理由：现状是"做没做成没人知道"——注释里写着"不假装成功"，但没人接这个返回值。
2. **一条预期先红的闸**（红的是没收敛这件事本身，不再预设它是事务泄漏）：`scripts/dev-wal-convergence-test.cjs`（**新文件**，与 `dev-write-ownership-test` 分开——那条测写权，这条测收敛）。步骤：起子进程 → 走真实 HTTP 打 50 条**注定失败**的请求 → 调 `checkpoint()` → 断 WAL ≤64KB 且留痕字段可见。按 §二 微测指向，它现在应该红；红即是三期第一个缺陷的证据。若它直接绿，则冻结另有其因（候选：credits 后台作业的读事务），当场改判并写偏差。
3. **修根因，不预先承诺改法**：取决于第 2 步暴露的是"未提交事务"还是"未耗尽语句/未 finalize"，改法是资源收尾进 `finally` 或失败路径显式回滚——写在设计里就是猜，故不写。
4. **`PRAGMA journal_size_limit=65536` 只作第二道保险**，在 1–3 完成之后再评估。顺序不可反：它能压住 WAL 峰值，但会掩盖事务泄漏这个真问题。
5. **判据 4 正式改写**为一条可核命题：「50 条失败请求之后，一次 `checkpoint()` 必须把 WAL 截到 ≤64KB」。原「30 分钟额度刷新后 <64KB」里那 30 分钟只是凑时长，不承载判据，**删除**。若第 4 步最终采纳 `journal_size_limit`，再追加第二条「持续写入下 WAL 峰值不越过该上限」——它依附于可选步骤，故不作为本期门槛。

## 七、验证面（各条改动用什么证明）

- **入口合并 → CDP 真机走查**（不引测试框架）：本仓现有闸全是 cjs 直跑 Node，纯前端 `.ts` 没有可运行宿主，为一个 computed 引 vitest 不划算。走查步骤：打开设置页 → 读三行开关态 → 点一次轻量模式 → 读临时 `config.json` 断 `liteOnClose` 与 `launchHidden` **同时**变且 `persistentGateway` 未被动 → 关 `minimizeToTray` 断常驻行升为平级仍可关。探针隔离按 §二 最后一条：`AGENTHUB_USER_DATA` + `APPDATA` 成对注入。
- **默认值 → 真闸**：`scripts/dev-config-lite-defaults-test.cjs` 扩断言（`launchHidden` 默认 true + 四处字面量一致）。
- **`tools/phase1-browser-pass.cjs:27`、`tools/tray-reopen-watch.cjs:20` 显式保留 `launchHidden:false` 并加注释**——这两支探针测的是"建过窗再销毁"的路径，默认值漂移会让它们悄悄改变被测对象却仍然绿。
- **WAL → §六 的新闸（先红后绿两份输出）**。
- **5 条 Minor 的落点**：`import_blob` 10s 超时 → `dev-gateway-pipe-test` 加一条；stopping 窗口托盘竞态 → `dev-gateway-interlock-test` 加一条；常驻期后台作业 → 设置页文案 + 规格一句明示；首启无 Local State 排障 → 纯 docs；`boot()/shutdown()` 死代码 → 删除 + grep 证明零引用。
- **main-60MB spike**：30 分钟取证（heap snapshot + V8 统计），产出只有两种——正式注销这条目标，或立新靶子并**单独提交 + 归因**（沿用一期 D7 纪律：不为过门改判据）。不进三期承诺范围。

## 八、完成定义

1. Task 0 合并先绿：`npm run build` + §四 列明的 14 道闸全绿，`dev-bundle-check --check` 基线刷新单独提交。
2. §五、§六 各自带证据：入口合并有 CDP 走查记录；WAL 有"先红后绿"两份输出且留痕字段可见。
3. **数字必须重量，不复用二期**：`electron:pack` 后跑同一套矩阵（常驻 detach、关窗销毁、导航 8 样本、WAL 收敛），因为上游改了 `server.cjs`/`store.cjs`，76.94 与 130.26 均不算已证。
4. 规格回写三处：`§一`（1.18.1 后的实测终态）、`§六`（轻量模式新入口与常驻子行语义，代码注释 / 设置页文案 / 规格三处同源）、判据 4 的正式改写落 `2026-09-21` 规格 §5.4 与 §四 对账段。
5. 真机回归两条不可省：常驻 detach 存活、自启 Run 项目标正确（1.18.1 重装后重验）。

## 九、风险与偏差登记（执行时逐条回写，不留空白）

- **R1 合并后判据数字失效**：上游改了 `server.cjs`（status/healthz）与 `store.cjs`。处置：完成定义第 3 条强制重量。
- **R2 WAL 根因未定**：两条主流假设已被 §二 的 grep 与微测排除，剩下「TRUNCATE 返回 false（被挡）」与「计时器压根没跑（unref 后事件循环语义 / store 模块被加载成两份）」两种。处置：留痕先行，再由实现计划的决策表二选一，**不预设改法也不预设判据**。
- **R3 上游 PRAGMA 与本节 PRAGMA 叠放**：两处不同库不同文件，但要防"连接级设置在两侧被设成互斥值"。处置：合并提交里 grep 双侧全部 `PRAGMA` 并列一次。
- **R4 默认不弹界面的可发现性**：新装用户可能找不到界面。缓解：托盘菜单已有「显示主界面」，且首次常驻时已有 detach 提示；三期 CDP 走查项包含"托盘图标可见 + 菜单能开界面"。

## 十、留待用户决定（不并入本期承诺）

- 二期与三期分支的合并动作（谁先合 main、开不开 PR）。
- 五处硬编码上游地址是否改指 fork（产品决策）。
