# 网关轻量三期实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 先把上游 v1.16.2→v1.18.1 合进本分支（Task 0–2 构成不可逾越的前置），再把设置页四个互相灰置的窗口开关收敛成单一「轻量模式」入口（Task 5–6），并把二期未达的 WAL 判据做成可观测、可修、可验收（Task 3–4）。

**Architecture:** 两条不变式贯穿全程。① **进程边界不动**：proxy 域全部 43（合并后 44）条命令的实现在网关子进程的 `dispatchTable()`，主进程只注册转发体，preload 白名单 == 主进程注册面 == 一期基线、子进程表 ⊇ 基线，由 `dev-gateway-forward-parity-test.cjs` 逐条钉住——上游新命令并进来之所以安全，正因为这条闸会当场抓住漏改。② **判据不为过门而改**：任何判据数值/口径变更必须单独提交并写归因（沿用一期 D7 纪律）。

入口收敛采用「纯呈现层聚合」：不加配置字段、无迁移，聚合读 `liteOnClose`、写同写 `liteOnClose`+`launchHidden`；`minimizeToTray` 作为总门保持独立，`persistentGateway` 只改行位不改值（隐藏 ≠ 清零）。

**Tech Stack:** Electron 35.7.5 + Node 24（`node:sqlite` DatabaseSync）+ Vue 3 / Pinia / Element Plus；验证全部为纯 CJS 自跑脚本（`node scripts/dev-*-test.cjs`），无测试框架。

**Spec:** `docs/superpowers/specs/2026-09-23-gateway-lite-mode-phase3-design.md`（执行时与本计划一并读）

## Global Constraints

- 注释与 commit message 用中文；commit 格式 `<type>: <描述>`（feat/fix/refactor/docs/test/chore）。
- **不新增任何 npm 依赖**，不引入 vitest/jest 等测试框架；前端行为验证走 CDP 真机走查。
- **不发布 Release、不改发布链路**：`package.json` 的 `build.publish[].owner/repo`、`.github/workflows/release.yml`、`electron/backend/updater.cjs:8` 的 `GITHUB_REPO_URL`、`electron/backend/proxy/ccswitch.cjs` 的 `website_url`、`src/components/config/ConfigProxySection.vue:383` 五处保持指向上游，三期一律不碰。
- 探针卫生（规格 §八）：`APPDATA` + `AGENT_SKILLS_HOME` + `CCSWITCH_DB_PATH` 指进临时目录，且**必须早于任何产品代码 require**；打包实例额外需要 `AGENTHUB_USER_DATA`（主进程 userData，靠 asar 测试钩子）与 `APPDATA`（子进程回退）**成对注入**；探针端口一律用 `1953x`，**9527 归用户自己的实例**；收尾核对 HKCU Run 快照与真实 `stats.db` 未变。
- 打包/装机前置：先 `taskkill /F /IM AgentHub.exe /T`（含 `%TEMP%` 便携解压子进程），electron-builder 会被自己产物目录里的实例锁死；**用户自己安装的实例（`H:\AgentHub`）不在此列**，只在被授权的真机装更步骤里动。
- `release/win-unpacked/resources/app.asar` 里允许存在**只属于测试工件**的钩子（`AGENTHUB_USER_DATA`、批次的 `AGENTHUB_FAKE_UPDATE`），它们随 `electron:pack` 重打包而消失，**永远不入库**。
- 二期已实测并入库的结论不得回退：`applyAutoStart` 的 `.cmd` 目标走 `reg.exe` 直写（835dc94，因 Electron 35 带 `path` 会吃反斜杠）；装更/退出必须先 `stopAndWait` 且端口实测释放；NSIS 完成判据用 **ctime** 不用 mtime。

---

## 文件结构（本计划涉及的责任划分）

| 文件 | 责任 | 本计划里的动作 |
|---|---|---|
| `electron/preload.cjs` | IPC 命令白名单（唯一渲染层入口） | Task 1 并上游 2 条 |
| `electron/backend/gateway-client.cjs` | 主进程转发面：`ALL_PROXY_CMDS`(43) / UI_LOCAL / 薄包装 / `forward()` | Task 1 加 `proxy_account_rename` → 44 |
| `electron/backend/proxy/index.cjs` | 43(→44) 条命令体 + `gatewayStatus()`；子进程 `dispatchTable()` 同源 | Task 1 并上游体、Task 3 加 `walBytes` 字段、Task 7 删 `boot()` |
| `electron/backend/sync-ipc.cjs` | 主进程 sync/usage 域注册 | Task 1 并 `get_dimensions` |
| `electron/backend/proxy/store.cjs` | stats.db 唯一写者 + WAL 收敛（`checkpoint:633` / `walBytes:653` / `startCheckpointTimer:643`） | Task 3 留痕改造、Task 4 修根因 |
| `electron/gateway.cjs` | 子进程装配（`store.open()` + `startCheckpointTimer()` 在 :104-105） | Task 3 日志接线 |
| `electron/backend/config.cjs` | 默认值 + 深合并 + `applyAutoStart` | Task 5 改 `launchHidden` 默认 |
| `src/components/config/ConfigGeneralSection.vue` | 设置页「应用行为」卡（5 行，:292-328） | Task 6 收 4 行 + 聚合 |
| `src/stores/app.ts:20` / `src/api/mock.ts:37` / `src/types/index.ts:232-245` | 前端配置字面量与类型 | Task 5 三处同步 |
| `scripts/dev-config-lite-defaults-test.cjs` | 默认值/深合并闸 | Task 5 扩断言 |
| `scripts/dev-gateway-forward-parity-test.cjs` | 三处对齐闸（基线取 `git show main:`） | Task 1 扩一条 |
| `scripts/dev-wal-convergence-test.cjs` | **新建**：WAL 收敛闸（留痕→复现→修复的载体） | Task 3 建（红）、Task 4 转绿 |
| `scripts/dev-gateway-pipe-test.cjs` / `dev-gateway-interlock-test.cjs` | 管道面 / 停机互锁闸 | Task 7 各加一条断言 |
| `tools/`（探针）/ `docs/superpowers/specs/` | 验收工具与规格 | Task 2/9 |

---

### Task 0: 切三期分支并合并上游 16 提交（冲突按规则解，闸不绿不收）

**Files:**
- Create: 分支 `perf/gateway-lite-mode-phase3`（自 `perf/gateway-lite-mode-phase2` @ `7166618` 切出）
- Modify: `electron/backend/proxy/index.cjs`、`electron/backend/proxy/store.cjs`、`electron/backend/proxy/adapters.cjs`、`electron/backend/proxy/discovery.cjs`、`electron/backend/proxy/server.cjs`、`electron/backend/proxy/util.cjs`、`electron/backend/proxy/ccswitch.cjs`、`electron/backend/proxy/pool.cjs`、`electron/backend/proxy/poolsync.cjs`、`electron/backend/proxy/events.cjs`、`electron/backend/proxy/rules.cjs`、`electron/backend/proxy/raccoonAuth.cjs`、`electron/backend/proxy/ideswitch.cjs`、`electron/backend/config.cjs`、`electron/backend/sync-config.cjs`、`electron/preload.cjs`、`package.json`、`src/App.vue`、`src/api/ipc.ts`、`src/api/mock.ts`、`src/api/sync.ts`、`src/api/sync-mock.ts`、`src/stores/{app,sync,usage}.ts`、`src/types/{index,sync}.ts`、`src/components/**`、`src/views/**`、`src/styles/element.css`、`scripts/dev-ccswitch-test.cjs`、`scripts/dev-sse-delta-test.cjs`、`tools/proxy-smoke.cjs`
- 只读参考：规格 §二/§四

**Interfaces:**
- Consumes：无（第一个任务）
- Produces：一个「上游 + 二期」共存且 14 道闸全绿的分支基线；Task 1 依赖它的 `get_dimensions` / `proxy_account_rename` 命令体已在工作区里

- [ ] **Step 1: 切分支（不改二期分支）**

```bash
git status --short          # 必须只有 src/components.d.ts 一类换行噪音；有真实改动先处理
git checkout -b perf/gateway-lite-mode-phase3
git log --oneline -1        # 应为 7166618 docs: 三期 spec 自我更正两处……
```

- [ ] **Step 2: 起合并，确认冲突面就是 §四 那张表**

```bash
git merge upstream/main --no-ff -m "merge: 并入上游 v1.16.2→v1.18.1（MiMo 用量源、用量统计性能优化、会话头稳定性、SSE 出线判据）"
git diff --name-only --diff-filter=U | sort > /d/merge-conflicts.txt
cat /d/merge-conflicts.txt
```

期望：冲突清单 ⊆ 规格 §四 表列的 10 个硬骨头 + 小改面。**若清单里出现 `electron/backend/proxy/secretbox.cjs`、`electron/gateway.cjs`、`electron/backend/gateway-client.cjs`、任一 `scripts/dev-gateway-*` 或 `tools/*`**，停下报告——上游不该碰它们，撞上说明二期架构面被上游改动侵入，属规格 R 级偏差，必须先归因再解。

- [ ] **Step 3: 按归属规则逐文件解冲突（规则先行，不是逐行手感）**

统一判据：**功能体在网关子进程侧的一律保留我们的结构，上游的实现内容往里并；主进程侧读用的以 upstream 为准。**

```bash
# (a) proxy 域：上游的 handler 体改动落在 register()/dispatchTable() 同一份实现里，
#     我们的改动是「把注册面挪进 gateway-client」的结构改动 → 结构留我们的、体留上游的。
git checkout --theirs electron/backend/proxy/adapters.cjs electron/backend/proxy/discovery.cjs
git checkout --ours   electron/backend/proxy/index.cjs   # 再手工把上游新增体并进来（Task 1 完成对齐）
# (b) 两侧都改、且我们改得更深的：手工逐 hunk，保我们的架构 + 并上游的新增
#     store.cjs(+21/−123)、server.cjs(+12/−67)、config.cjs(+26/−81)、preload.cjs(+2)、package.json(+3/−17)
# (c) 其余按 git status 提示逐个解
```

`electron/backend/config.cjs` 的 6 个 hunk 全部**取我们的**（规格 §四 表已注：上游那 6 处分别是 secretbox 回退、schedule 缺三字段、原子写回退、`applyAutoStart` 旧版），解完必须能查到这些标记还在：

```bash
grep -c "secretbox\|decryptSecretLenient\|RUN_KEY\|regExePath\|p + \"-\" + process.pid" electron/backend/config.cjs
```

期望：≥ 5（任一为 0 就说明那个 hunk 被上游版本盖掉了）。

- [ ] **Step 4: 确认「两侧都往 PRAGMA 伸手」没叠成互斥（规格 R3）**

```bash
grep -rn "PRAGMA" electron/backend/db.cjs electron/backend/proxy/store.cjs electron/backend/proxy/ccswitch.cjs
```

期望与处置：`db.cjs` 出现上游新增的 `mmap_size` / `cache_size` / `temp_store`（用量库读侧），`proxy/store.cjs` 仍只有 `journal_mode=WAL` + `busy_timeout=5000` 两条。**若 store.cjs 也出现了 mmap/cache 之类**，删掉它——两个库的连接级设置不能同名并存，且本期 §六 的 WAL 改动还没开工。

- [ ] **Step 5: 全量类型与构建闸**

```bash
npm run build
```

期望：`vue-tsc` 零报错 + `✓ built`。类型报错的常见来源是上游 `src/types/index.ts` 与我们的 schedule 块冲突解错（`liteOnClose`/`launchHidden`/`persistentGateway` 三行必须都在，见 `src/types/index.ts:232-245`）。

- [ ] **Step 6: 14 道闸全跑（Task 0 的验收即这 14 条）**

```bash
node scripts/dev-watch-test.cjs
node scripts/dev-config-lite-defaults-test.cjs
node scripts/dev-ccswitch-test.cjs
node scripts/dev-sse-delta-test.cjs
node scripts/dev-gateway-node-load-test.cjs
node scripts/dev-secretbox-test.cjs
node scripts/dev-write-ownership-test.cjs
node scripts/dev-gateway-pipe-test.cjs
node scripts/dev-gateway-forward-parity-test.cjs
node scripts/dev-gateway-interlock-test.cjs
node scripts/dev-gateway-launcher-test.cjs
node scripts/dev-usage-scheduler-test.cjs
node tools/proxy-smoke.cjs
node scripts/dev-bundle-check.cjs
```

期望：前 13 条 `OK`/全绿；`dev-bundle-check.cjs`（不带 `--check`）只做体积门槛。
**`dev-gateway-forward-parity-test.cjs` 在这里预期是红的**——上游带来的 `proxy_account_rename` 进了 `proxy/index.cjs` 注册体却没进 preload/`ALL_PROXY_CMDS`，这正是 Task 1 的活。除这一条外任何一条红都必须先修好再往下。

- [ ] **Step 7: 提交合并**

```bash
git add -A
git status --short | head -20       # 确认没有把 release/ 或 tmp/ 带进来
git commit -m "merge: 并入上游 v1.16.2→v1.18.1，proxy 域结构改动保留二期形态、上游实现体并入 dispatchTable"
```

---

### Task 1: 上游两条新命令过三处对齐（把 parity 闸做回绿）

**Files:**
- Modify: `electron/preload.cjs:71`（`get_dimensions`）、`:121`（`proxy_account_rename`）
- Modify: `electron/backend/gateway-client.cjs:348-364`（`ALL_PROXY_CMDS` 43→44）
- Modify: `electron/backend/sync-ipc.cjs`（`get_dimensions` 注册体，上游位在上游 `sync-ipc.cjs:142`）
- Modify: `electron/backend/proxy/index.cjs`（`proxy_account_rename` 体，上游版在上游 `index.cjs:336-342`，若 Task 0 已并则不重复）
- Modify: `src/api/ipc.ts`（两个前端出口）、`src/api/mock.ts`（mock 分支）、`src/types/index.ts`（`ProxyAccount` 相关类型若上游有改名）
- Test: `scripts/dev-gateway-forward-parity-test.cjs:94`（`newSubCmds`）与 `:95-100` 同型断言

**Interfaces:**
- Consumes：Task 0 的合并结果
- Produces：`proxy_account_rename` 在子进程 dispatch 表内、`get_dimensions` 在主进程 sync 域；preload 白名单 == 主进程注册面 == 一期基线 ∪ 上游新增，Task 2/7 依赖这条闸是绿的

- [ ] **Step 1: 先看闸怎么红，确认只差对齐、不是缺体**

```bash
node scripts/dev-gateway-forward-parity-test.cjs 2>&1 | grep -E "FAIL|多出|缺"
```

期望输出形如：`① preload 有基线没有：proxy_account_rename`、`④ 子进程多出来的键都在白名单外：proxy_account_rename`。若报的是「子进程表缺 …」说明上游的体没进 `dispatchTable()`，回到 Task 0 的解冲突规则 (a)。

- [ ] **Step 2: 扩闸到 44 条（改测试到红，再改实现到绿）**

`scripts/dev-gateway-forward-parity-test.cjs:94` 现值：

```js
const newSubCmds = ["proxy_account_import_blob", "proxy_poolsync_password_changed"];
```

改为并加一条专属断言（插在 `:99-100` 同型位置之后）：

```js
const newSubCmds = ["proxy_account_import_blob", "proxy_poolsync_password_changed", "proxy_account_rename"];
...
check("④ 子进程表含 proxy_account_rename（上游 v1.18.0 账号重命名，写号池故必须归子进程）",
  subKeys.includes("proxy_account_rename"),
  "重命名走主进程直连 = stats.db/sync-state.json 出现第二个写者，二期 §5.4 单一写者被破");
```

```bash
node scripts/dev-gateway-forward-parity-test.cjs 2>&1 | tail -6   # 期望：仍红，红在 ①==② / ①==③ 计数
```

- [ ] **Step 3: 三处对齐**

```bash
# ① preload 白名单（两条都要：get_dimensions 属主进程域，proxy_account_rename 属代理域）
#    electron/preload.cjs:71 之后
  "get_dimensions",
#    electron/preload.cjs:121 之后（proxy_account_toggle 之后）
  "proxy_account_rename",
```

② `electron/backend/gateway-client.cjs:348-364` 的 `ALL_PROXY_CMDS` 加 `"proxy_account_rename"`（数组长度变 44）；③ `electron/backend/sync-ipc.cjs` 里并上游体：

```js
ipcMain.handle("get_dimensions", (_e, args) => db.getDimensions(args.dim, args.source));
```

- [ ] **Step 4: 前端出口与 mock 同步（漏了会白屏，不是 lint 错）**

```bash
grep -n "get_aggregate\|get_records" src/api/ipc.ts src/api/mock.ts   # 沿既有形状各加 get_dimensions / proxy_account_rename 两条
```

`src/api/mock.ts` 的 switch 分支必须同时补 `case "get_dimensions"` 与 `case "proxy_account_rename"`，否则 `npm run dev:web` 预览态直接吃「未实现」。

- [ ] **Step 5: 闸与 IPC 对账脚本双验**

```bash
node scripts/dev-gateway-forward-parity-test.cjs | tail -4
node -e "
const fs=require('fs');
const pre=fs.readFileSync('electron/preload.cjs','utf8');
const allow=new Set([...pre.matchAll(/^\s+\"([a-z0-9_]+)\",/gm)].map(m=>m[1]));
const files=['electron/backend/ipc.cjs','electron/backend/sync-ipc.cjs','electron/backend/proxy/index.cjs'];
const reg=new Set();
for(const f of files){const s=fs.readFileSync(f,'utf8');for(const m of s.matchAll(/ipcMain\.handle\(\s*\"([a-z0-9_]+)\"/g))reg.add(m[1]);}
console.log('missing:', [...reg].filter(x=>!allow.has(x)).join(', ')||'none');
console.log('extra:', [...allow].filter(x=>!reg.has(x)).join(', ')||'none');
"
```

期望：闸 `OK …全绿`；对账脚本两行**按 AGENTS.md 第四节**判读——`proxy` 域的 missing/extra 属预期（子进程侧），只有主进程侧命令（`get_dimensions`）出现在任一列表才算真问题。

- [ ] **Step 6: 提交**

```bash
git add electron/preload.cjs electron/backend/gateway-client.cjs electron/backend/sync-ipc.cjs src/api scripts/dev-gateway-forward-parity-test.cjs
git commit -m "feat: 上游新增两条命令过三处对齐——proxy_account_rename 入子进程 dispatch 表（44 条，写号池必须单一写者）、get_dimensions 入主进程 sync 域，parity 闸加专属断言钉住"
```

---

### Task 2: 版本号对齐 1.18.1 + 打包与产物基线

**Files:**
- Modify: `package.json`（`version` → `1.18.1`）
- Modify: `scripts/.bundle-baseline.json`（基线刷新，**单独提交**）
- 只读：`release/`（产物，gitignored）

**Interfaces:**
- Consumes：Task 1 的绿色 parity 闸
- Produces：`1.18.1` 的可打包工作区 + 刷新后的体积基线；Task 9 的重量化矩阵以此为版本基准

- [ ] **Step 1: 改版本号**

```bash
node -p "require('./package.json').version"          # 现值 1.16.1
npm version 1.18.1 --no-git-tag-version             # 跟上游走，减少后续冲突
git checkout -- package-lock.json 2>/dev/null || true
```

- [ ] **Step 2: 构建闸 + 基线漂移闸（预期漂移）**

```bash
npm run build && node scripts/dev-bundle-check.cjs --check
```

期望：`--check` **报漂移并红**（上游 v1.18.0 改了 Heatmap/TrendChart 与按需注册面）。这正是它该做的事。

- [ ] **Step 3: 重录基线并单独提交（该闸**故意**不自动重写：`dev-bundle-check.cjs:341/367` 要求「删掉基线文件重跑 --check」才重录）**

```bash
rm scripts/.bundle-baseline.json
node scripts/dev-bundle-check.cjs --check      # 无基线 → :356 写当前值并入盘，本次判「跳过」为绿
node scripts/dev-bundle-check.cjs --check      # 第二次跑：与刚录的基线零漂移，必须绿
git add scripts/.bundle-baseline.json
git commit -m "chore: bundle 基线随上游 v1.18.0 的图表与按需注册改动重录（漂移闸不自动重写，重录单独提交，不混进功能提交）"
```

两次 `--check` 都要留输出：第一次证明"重录"，第二次证明"录进去的值自洽"。

- [ ] **Step 4: 打包一次，确认产物与启动器落位**

```bash
taskkill //F //IM AgentHub.exe //T 2>/dev/null; npm run electron:pack
ls release/win-unpacked/AgentHub.exe release/win-unpacked/agenthub-gateway.cmd
node -p "require('./release/win-unpacked/resources/app.asar')&&0" 2>/dev/null; echo "asar 存在性用下一条确认"
ls -la release/win-unpacked/resources/app.asar
```

期望：两个文件都在（`agenthub-gateway.cmd` 是 `build.extraFiles` 落位证据），asar 时间戳为刚才。

- [ ] **Step 5: 提交版本号**

```bash
git add package.json
git commit -m "chore: 版本号对齐上游 1.18.1——fork 跟上游版本以减少后续合并冲突，代价是二期真机结论需在期末重量一遍（规格 §四）"
```

---

### Task 3: WAL 留痕 + 收敛闸（预期先红）

**Files:**
- Modify: `electron/backend/proxy/store.cjs:629-655`（`checkpoint()` 返回结构、新增 `lastCheckpoint` 观测）、`:678-692`（导出）
- Modify: `electron/gateway.cjs:104-105`（把周期 checkpoint 的成败写进子进程日志）
- Modify: `electron/backend/proxy/index.cjs:297-311`（`gatewayStatus()` 加 `walBytes`）
- Modify: `src/types/index.ts:388-400`（`ProxyGatewayStatus.walBytes: number`）、`src/api/mock.ts:400`（mock 同字段）
- Create: `scripts/dev-wal-convergence-test.cjs`
- Test: 上述新闸

**Interfaces:**
- Consumes：Task 1 后稳定的 `proxy_status` 转发链
- Produces：`store.checkpoint()` 返回 `{ ok: boolean, before: number, after: number, err: string }`；`store.lastCheckpoint()` 返回同结构或 `null`；`proxy_status.walBytes: number`。Task 4 与 Task 9 判据都读这三个出口

- [ ] **Step 1: 写新闸（此刻它必红——留痕还没做）**

`scripts/dev-wal-convergence-test.cjs` 骨架照抄 `dev-write-ownership-test.cjs` 的沙箱手法（`APPDATA`/`AGENT_SKILLS_HOME` 指临时目录、真实子进程、`--persistent` 走 `cwd=work` 中立目录、结尾 `stopAndWait` 收摊），判据段写成：

```js
// ① 留痕出口存在且可读：store.lastCheckpoint() 必须是 {ok,before,after}
const lc = store.lastCheckpoint();
assert.ok(lc && typeof lc.ok === "boolean" && typeof lc.after === "number",
  "① checkpoint 的成败不可观测（三期判据的前置，缺它任何修法都无法验收）：实得 " + JSON.stringify(lc));
// ② 走真实 HTTP 打 50 条**注定失败**的请求（空号池 → 非 200），随后一次 checkpoint 必须把 WAL 截到 ≤64KB
for (let i = 0; i < 50; i++) await postChat(i);            // 复用 write-ownership 的 fetch 夹具
const w = store.walBytes();
assert.ok(w > 0, "② 50 条失败请求后 WAL 竟为 0，说明本轮没写库（夹具失效，判据无意义）");
store.checkpoint();
const after = store.walBytes();
assert.ok(after <= 64 * 1024, `② checkpoint 后 WAL 仍 ${after} B（>64KB）——三期判据 4 的本体，红即待修缺陷`);
```

- [ ] **Step 2: 跑一次，收「为什么没收敛」的第一手证据**

```bash
node scripts/dev-wal-convergence-test.cjs 2>&1 | tail -20
```

期望：`①` 先红（`lastCheckpoint` 不存在）。**先补 ① 的实现（Step 3），再跑一次让 `②` 暴露真值**，把 `②` 的输出（before/after/`ok`/`err`）原样留进 Task 3 报告——它就是 Task 4 选分支的依据。

- [ ] **Step 3: 实现留痕（最小改动，不夹带修法）**

`electron/backend/proxy/store.cjs:633-636` 现为：

```js
function checkpoint() {
  if (!db) return false;
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); return true; } catch { return false; }
}
```

改为（返回结构向后兼容：`close()` 与既有闸只把它当"调用过"，无返回值消费方，已 grep 确认）：

```js
let lastCk = null;
function checkpoint() {
  const before = walBytes();
  if (!db) { lastCk = { ok: false, before, after: before, err: "db-not-open" }; return lastCk; }
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    lastCk = { ok: true, before, after: walBytes(), err: "" };
  } catch (e) {
    lastCk = { ok: false, before, after: walBytes(), err: String((e && e.message) || e) };
  }
  return lastCk;
}
function lastCheckpoint() { return lastCk; }
```

`electron/gateway.cjs:105` 由裸调用改成注入回调（唯一方案：store 不认识日志层，回调由装配方给，避免跨层 require；这份回调同时就是 Task 4 分支 (c) 的判别证据）：

```js
store.startCheckpointTimer((r) => log.line("wal-checkpoint", { ok: r.ok, before: r.before, after: r.after, err: r.err }));
```

`store.cjs:643` 签名改成向后兼容的可选回调（既有 `startCheckpointTimer()` 与 `startCheckpointTimer(ms)` 两种调用必须照常工作）：

```js
function startCheckpointTimer(onResult) {
  const ms = typeof onResult === "number" ? onResult : 0;
  const cb = typeof onResult === "function" ? onResult : null;
  stopCheckpointTimer();
  ckTimer = setInterval(() => { const r = checkpoint(); if (cb) cb(r); }, ms || CHECKPOINT_MS);
  if (ckTimer.unref) ckTimer.unref();
  return stopCheckpointTimer;
}
```

`walBytes` 与 `lastCheckpoint` 都要加进 `module.exports`（:683 行区）。观测不能只挂在回调上：`lastCk` 本身就是无回调时的兜底。

`gatewayStatus()`（`electron/backend/proxy/index.cjs:297-311`）在 `dbDriver` 之后加：

```js
    walBytes: store.walBytes(),
    lastCheckpoint: store.lastCheckpoint(),
```

`src/types/index.ts` 的 `ProxyGatewayStatus`（:388-400）加 `walBytes: number;` 与 `lastCheckpoint: { ok: boolean; before: number; after: number; err: string } | null;`，`src/api/mock.ts:400` 分支同补（假值 `0` / `null`）。

- [ ] **Step 4: 闸转「① 绿 ② 红」——缺陷此刻变得可证伪**

```bash
node scripts/dev-wal-convergence-test.cjs 2>&1 | tail -12
```

期望：① 通过；② 红并带出 `ok/before/after/err`。**若 ② 直接绿**：说明冻结只在真常驻形态下出现（父进程没了、被 detach），把闸补成「detach 后再来 50 条」的第二腿（Task 4 分支 C 的依据），并在报告里记这一笔。

- [ ] **Step 5: 其余闸不被留痕改动打红**

```bash
node scripts/dev-write-ownership-test.cjs | tail -3
node scripts/dev-gateway-forward-parity-test.cjs | tail -3
node scripts/dev-gateway-pipe-test.cjs | tail -3
```

期望：三条全绿（`checkpoint()` 返回值形状变了，但 `close()` 里 `checkpoint();` 是弃值调用，已确认 `store.cjs:620-621`）。

- [ ] **Step 6: 提交**

```bash
git add electron/backend/proxy/store.cjs electron/gateway.cjs electron/backend/proxy/index.cjs src/types/index.ts src/api/mock.ts scripts/dev-wal-convergence-test.cjs
git commit -m "feat: WAL 收敛留痕——checkpoint() 返回 {ok,before,after,err} 并周期回调落日志、proxy_status 暴露 walBytes/lastCheckpoint，新增收敛闸判据②此刻红（二期 1,388,472B 冻结的可观测化，规格 §六）"
```

---

### Task 4: WAL 根因二选一并修到绿（决策表驱动，不预设改法）

**Files:**
- Modify: 由分支决定，候选面 `electron/backend/proxy/store.cjs`（`startCheckpointTimer` / `open()`）或 `electron/gateway.cjs`（装配序）
- Test: `scripts/dev-wal-convergence-test.cjs`（补对应分支的判别断言）

**Interfaces:**
- Consumes：Task 3 的 `②` 输出四元组
- Produces：判据 4 转绿的实现 + 一条防回退断言

- [ ] **Step 1: 用 Task 3 留下的四元组选分支（判据写死，三选一）**

| Task 3 `②` 实测 | 结论 | 修法（下面 Step 2 的 a/b/c） |
|---|---|---|
| `ok:false` 且 `err` 含 `busy`/`SQLITE_BUSY` | WAL 被别的读事务挡住 | (a) |
| `ok:true` 但 `after === before`（截不动） | `unref` 计时器语义/被调用但无效 | (b) |
| `lastCheckpoint` 始终 `null`（① 绿 ② 里 `①` 的 `err:"db-not-open"` 或从未被写） | 周期回调压根没跑 / store 模块两份 | (c) |

- [ ] **Step 2a（若 busy）**：把收敛从「独占 TRUNCATE」降为「先 PASSIVE 再 TRUNCATE」，并给 `open()` 加 `PRAGMA journal_size_limit=65536;`：

```js
db.exec("PRAGMA journal_size_limit=65536;");   // 紧跟 store.cjs:130 的 busy_timeout 之后
// checkpoint 内：TRUNCATE 失败先退一档，别把整次收敛丢掉
try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); }
catch { try { db.exec("PRAGMA wal_checkpoint(PASSIVE);"); } catch { /* 下轮再试 */ } }
```

- [ ] **Step 2b（若 ok 却不动）**：TRUNCATE 需要 WAL 无活跃读者，`checkpoint(TRUNCATE)` 返回码在 `node:sqlite` 里被丢弃。改为读返回值：

```js
// db.prepare 而非 exec：拿回 [busy, log, counter] 三列，busy=1 就是被挡
const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE);").get();
lastCk = { ok: !!(row && row.busy === 0), before, after: walBytes(), err: row ? "busy=" + row.busy + " log=" + row.log : "no-row" };
```

- [ ] **Step 2c（若压根没跑）**：先证「是不是被 require 成了两份 store」：

```bash
grep -rn "require(.*proxy/store" electron scripts | wc -l
node -e "const a=require('./electron/backend/proxy/store.cjs'),b=require('./electron/backend/proxy/store.cjs');console.log(a===b)"
```

若同进程内为同一对象，则问题在 `startCheckpointTimer` 的 `unref`：常驻子进程在**无 HTTP 连接、无管道流量**时的空闲期由 `srvRef`/pipe 保活，但 `ckTimer` 若在 `open()` 之前注册就会被 `stopCheckpointTimer()` 清掉。修法是把注册点收敛到 `open()` 成功后并由 `open()` 幂等重挂（**回调必须一起搬走**，否则 Task 3 的留痕会随这次改动消失）：

```js
// store.open() 末尾（:130 两条 PRAGMA 之后）：内部重挂，保留既有回调引用
if (!ckTimer) ckTimer = setInterval(() => { const r = checkpoint(); if (ckOnResult) ckResult(r); }, CHECKPOINT_MS);
```

即 `startCheckpointTimer` 与 `open()` 共用一个 `ckTimer` 守卫，`ckOnResult` 存在模块变量里由 `startCheckpointTimer(onResult)` 首次设置。同时删掉 `gateway.cjs:105` 的独立调用，避免两处注册互相 `clearInterval`——改完后 Task 3 的 ① 断言（`lastCheckpoint()` 可读）与 ② 断言都必须仍然成立，否则本次修改即为回退。

- [ ] **Step 3: 把选中的分支写成断言补进闸（防回退）**

无论走 a/b/c，都在 `dev-wal-convergence-test.cjs` 末尾补一条：

```js
const lc2 = store.lastCheckpoint();
assert.ok(lc2.ok === true, "修复后周期 checkpoint 仍报不成：err=" + lc2.err);
assert.ok(lc2.after < lc2.before, `收敛必须是净下降：before=${lc2.before} after=${lc2.after}`);
```

- [ ] **Step 4: 全闸回归 + 提交**

```bash
node scripts/dev-wal-convergence-test.cjs | tail -4
node scripts/dev-write-ownership-test.cjs | tail -2
node scripts/dev-gateway-pipe-test.cjs | tail -2
git add electron/backend/proxy/store.cjs electron/gateway.cjs scripts/dev-wal-convergence-test.cjs
git commit -m "fix: WAL 收敛根因修复（分支 x：…）——二期 1,388,472B 冻结转绿，判据 4 达成「一次 checkpoint 后 ≤64KB」（规格 §六）"
```

---

### Task 5: 轻量模式的数据面（默认值 + 四处一致 + 闸）

**Files:**
- Modify: `electron/backend/config.cjs:123`、`src/stores/app.ts:20`、`src/api/mock.ts:37`
- Test: `scripts/dev-config-lite-defaults-test.cjs:29-32`

**Interfaces:**
- Consumes：无
- Produces：`schedule.launchHidden` 默认 `true`（开机不建窗）；Task 6 的聚合读规则依赖「默认两真」才自洽

- [ ] **Step 1: 扩闸到四处一致（先红）**

`scripts/dev-config-lite-defaults-test.cjs:30` 现值 `assert.strictEqual(cfg.schedule.launchHidden, false, ...)` 改为 true 并追加三条：

```js
assert.strictEqual(cfg.schedule.launchHidden, true, "三期起 launchHidden 默认 true：轻量态自洽要求两字段同真（规格 §五）");
// 四处字面量一致性（前端两处 + 后端一处 + 本闸夹具），漏一处就是「UI 显示关、后端生效开」
const src = {
  store: fs.readFileSync(path.join(ROOT, "src/stores/app.ts"), "utf8"),
  mock: fs.readFileSync(path.join(ROOT, "src/api/mock.ts"), "utf8"),
  backend: fs.readFileSync(path.join(ROOT, "electron/backend/config.cjs"), "utf8"),
};
for (const [k, s] of Object.entries(src))
  assert.match(s, /launchHidden: true/, `${k} 的 schedule 字面量里 launchHidden 必须是 true（三处同源，一期 Task 6 就因漏改前端两处红过）`);
```

- [ ] **Step 2: 跑红**

```bash
node scripts/dev-config-lite-defaults-test.cjs 2>&1 | tail -4
```

期望：三条 `launchHidden: true` 断言全红（现值 false）。

- [ ] **Step 3: 改三处字面量**

`electron/backend/config.cjs:123`、`src/stores/app.ts:20`、`src/api/mock.ts:37`：`launchHidden: false` → `launchHidden: true`，注释同步为 `// 启动不建窗（三期：并入「轻量模式」，默认开）`。

- [ ] **Step 4: 探针显式值不能被默认值漂走（规格 §七）**

```bash
grep -n "launchHidden" tools/phase1-browser-pass.cjs tools/tray-reopen-watch.cjs scripts/dev-gateway-interlock-test.cjs 2>/dev/null
```

期望：前两者显式 `launchHidden: false` **保持**，并在其夹具行上加一行注释说明「本探针测建窗→销毁路径，显式钉 false，不随默认漂移」。第三处若无命中属正常。

- [ ] **Step 5: 绿 + 回归 + 提交**

```bash
node scripts/dev-config-lite-defaults-test.cjs | tail -3 && node scripts/dev-watch-test.cjs | tail -2 && npm run build | tail -2
git add electron/backend/config.cjs src/stores/app.ts src/api/mock.ts scripts/dev-config-lite-defaults-test.cjs tools/phase1-browser-pass.cjs tools/tray-reopen-watch.cjs
git commit -m "feat: launchHidden 默认改 true（开机不建窗）+ 三处字面量一致性入闸，探针显式钉 false 防默认漂移（规格 §五/§七）"
```

---

### Task 6: 设置页 5 行收 4 行（聚合开关 + 常驻行升降）

**Files:**
- Modify: `src/components/config/ConfigGeneralSection.vue:299-328`
- Create: `tmp/gateway-probe/phase3-lite-entry.cjs`（CDP 走查，不入库）

**Interfaces:**
- Consumes：Task 5 的默认两真
- Produces：UI 上的 `轻量模式` 行（读写 `liteOnClose`+`launchHidden`），`persistentGateway` 行随 `minimizeToTray`/`liteOnClose` 位置升降

- [ ] **Step 1: 加聚合 computed 与写 handler（`<script setup>` 内，紧邻 `toggleAppBehavior` :140-144）**

```ts
/** 轻量模式：liteOnClose + launchHidden 的聚合视图（三期定案：读看主特征 liteOnClose，写同写两条）。
    部分为真只可能来自手改 JSON，点一次即归一，故不做 indeterminate。 */
const liteMode = computed({
  get: () => app.config.schedule.liteOnClose,
  set: (v) => { app.config.schedule.liteOnClose = v; app.config.schedule.launchHidden = v; },
});
```

- [ ] **Step 2: 三行文案与结构改造**

- `:301` 行名 `关闭最小化到托盘` → `关窗后留在托盘（不退出）`，描述改为「点关闭不退出程序，缩在托盘继续跑；托盘菜单「退出」才是真正退出（关掉它 = 关窗即退出）」；字段与 `v-model` 不动。
- 删 `:306-312`（关窗后释放界面内存）与 `:313-319`（启动不打开主界面）两行，换成一行：

```html
      <div class="set-row">
        <div class="set-info">
          <div class="set-name">轻量模式</div>
          <div class="set-desc">关窗即结束界面进程、下次启动不自动开界面，需要时点托盘图标打开。代价是重新打开要多加载一次界面</div>
        </div>
        <el-switch v-model="liteMode" :disabled="!app.config.schedule.minimizeToTray" @change="toggleAppBehavior" />
      </div>
```

- 常驻行（`:320-328`）改为**位置随档位升降**：轻量开 → 紧跟在轻量模式行内作子行；轻量关 → 作为独立平级行。实现用同一块模板 + `v-if` 两处（`liteMode` 真时渲染在聚合行之后、假时渲染在 `minimizeToTray` 之后），字段与 `:disabled="isPortable"` 一字不动。**绝不写 `persistentGateway`**。

- [ ] **Step 3: 写 CDP 走查（唯一验证手段，本仓无前端测试宿主）**

`tmp/gateway-probe/phase3-lite-entry.cjs`：`electron:pack` 产物 + `AGENTHUB_USER_DATA`/`APPDATA` 成对注入 + 独立 CDP 端口，四步断言：

```js
// ① 默认态：轻量=开（两真）、常驻行存在
// ② 点轻量关 → config.json: liteOnClose=false && launchHidden=false && persistentGateway 未被写
// ③ 点轻量开 → 两条同时 true
// ④ 关 minimizeToTray → 常驻行仍在（平级可关），且 disabled 只由 isPortable 决定
const cfg = JSON.parse(fs.readFileSync(path.join(TMPD, "appdata", "AgentHub", "config.json"), "utf8"));
assert.ok(cfg.schedule.launchHidden === false && cfg.schedule.liteOnClose === false, "关轻量没同写两条：" + JSON.stringify(cfg.schedule));
assert.strictEqual(cfg.schedule.persistentGateway, beforePg, "轻量切换顺手动了常驻字段（违反「隐藏≠清零」硬约束）");
```

- [ ] **Step 4: 跑走查并留真机截图两张（设置页开/关两态）**

```bash
taskkill //F //IM AgentHub.exe //T 2>/dev/null; npm run electron:pack
node tmp/gateway-probe/phase3-lite-entry.cjs
```

期望：四步全 PASS；截图按用户偏好先看真机再定稿。**若某步红，回到 Step 1/2 改，不许放宽走查断言。**

- [ ] **Step 5: 门禁回归 + 提交**

```bash
npm run build | tail -2 && node scripts/dev-config-lite-defaults-test.cjs | tail -2
git add src/components/config/ConfigGeneralSection.vue
git commit -m "feat: 设置页应用行为卡 5 行收 4 行——单一「轻量模式」聚合 liteOnClose+launchHidden（读主特征/写两条/零 schema 变更），常驻行随档位升降但绝不清零，minimizeToTray 作总门保留（规格 §五）"
```

---

### Task 7: 终审 5 条 Minor 收账（一条一提交）

**Files / 判据:**

| # | 落点 | 动作 |
|---|---|---|
| 7a | `gateway-client.cjs:451` 调用点 + `gateway-proto.cjs:7` | 给 `proxy_account_import_blob` 显式超时：`call("proxy_account_import_blob", {...}, { timeoutMs: 30000 })`（5MB 上限 `IMPORT_BLOB_MAX:374` 的 base64 写入不该吃默认 10s），并在 `dev-gateway-pipe-test.cjs` ⑨c 同型位置（:1310-1328 手法）加一条「显式 timeoutMs 说了算」断言 |
| 7b | `main.cjs` `before-quit` + `dev-gateway-interlock-test.cjs:247-270` | stopping 窗口托盘竞态：用该闸现成的 `mainSrc.slice('app.on("before-quit"')` 静态手法钉「installPhase==="stopping" 期间托盘菜单不得触发第二次停机」，再补一条运行期判据 |
| 7c | `ConfigGeneralSection.vue:325`（常驻行 `set-desc`）+ 规格 §六 | 描述改为定稿文案：「主 App 退出后网关继续常驻，额度刷新与自动签到随它一起留在后台跑（便携版不支持）」；规格 §六 同段补一句同源说明 |
| 7d | `docs/gateway-troubleshooting.md`（不存在则新建，标题「网关凭据后端与首启」）| 注记原文：「打包首启若报『凭据解密失败：打包环境既无 safeStorage 也无本机 v10 主密钥』，先确认同目录是否已生成 `Local State`（Chromium 建完 profile 才落盘）；子进程早于它启动会判 `none` 并 fatal 退出（实测竞速窗口 8–12s），重开一次设置页的启动服务即可」 |
| 7e | `electron/backend/proxy/index.cjs:188-198` | **只删 `boot()`**（全仓零调用点已核实：仅注释与 `:680` 导出行）；**`shutdown()` 保留**——`dev-write-ownership-test.cjs:160` 有真实调用、`:434-438` 有静态判据（此处更正 spec §七 的说法，见下方偏差） |

- [ ] **Step 1（7a）: 改测试到红 → 改实现到绿 → 提交 `fix:`**
- [ ] **Step 2（7b）: 同上，提交 `fix:`**
- [ ] **Step 3（7c/7d）: 文案 + docs，提交 `docs:`**
- [ ] **Step 4（7e）: 删 `boot()` + 导出行，`grep -rn "boot(" electron scripts` 归零后跑 `dev-gateway-interlock-test`/`dev-write-ownership-test`，提交 `refactor:`**

每条都是独立提交、独立可批，评审可以只批前四条打回 7e。

---

### Task 8: main-60MB 取证 spike（产出是结论，不是代码）

**Files:** 仅 `tmp/gateway-probe/phase3-main-heap.cjs`（不入库）

- [ ] **Step 1:** 起常驻 + 关窗销毁态，采 `process.getHeapSpaceStatistics()` + V8 heap snapshot（`Debugger.enable`/`HeapProfiler.takeHeapSnapshot` 走 CDP，主进程需 `--inspect`），逐桶归类：V8 堆 / detached 元素 / native / 模块图。
- [ ] **Step 2:** 报告二选一并给数字：「正式注销 ≤60MB 目标」（附 main 构成表）或「立新靶子」（附可达成的具体回收项与其字节数）。
- [ ] **Step 3:** 若改判据，**单独提交 + 归因**（一期 D7 纪律），本任务不夹带任何产品代码改动。

---

### Task 9: 三期末数字重量化 + 规格回写

**Files:**
- Modify: `docs/superpowers/specs/2026-09-21-gateway-lite-mode-design.md`（§一 表、§5.4/§四 判据 4、§六 语义三处同源）
- Test: 复用二期矩阵探针（`tmp/gateway-probe/real-batch2-retry.cjs`、`real-batch3-install.cjs`、`real-batch4-matrix.cjs`、`real-batch4-portable.cjs`、`real-batch4-walsoak.cjs`）+ 新入口走查

- [ ] **Step 1:** `npm run build` + §四 列明的 14 道闸 + `node scripts/dev-bundle-check.cjs --check`（合计 15 项）一次连跑，完整输出留档。
- [ ] **Step 2:** 重量矩阵四项：常驻 detach 单进程私有内存、关窗销毁 main 自持值、导航 8 样本、WAL 收敛后终值（数字必须来自 1.18.1，**不得复用 76.94 / 130.26**）。
- [ ] **Step 3:** 真机两条回归：常驻 detach 存活、自启 Run 项目标正确（`electron:pack` 后真装一次，判据用 ctime）。
- [ ] **Step 4:** 规格回写：§一 换实测终态；§四 判据 4 改写成「50 条失败请求后一次 `checkpoint()` 必须截到 ≤64KB」；§六 轻量模式新入口 + 常驻子行语义 + 代码注释/设置页文案三处同源；§八 追加本期新踩的隔离/判据事实（若有）。
- [ ] **Step 5:** 提交 `docs:`；完成定义逐条对照报告（规格 §八）。

---

## 偏差登记（执行时逐条回写，不留空白）

- **D-P3-1（写计划期发现）**：spec §七 说「`boot()/shutdown()` 死代码 → 删除 + grep 证明零引用」对 `shutdown()` **不成立**——`scripts/dev-write-ownership-test.cjs:160` 有真实运行期调用、`:434-438` 有要求它存在的静态判据。Task 7e 收窄为只删 `boot()`。
- **D-P3-2（写计划期发现）**：spec §二 的「失败请求泄漏事务」假设被 grep 否证（proxy 全域无 `BEGIN/COMMIT/ROLLBACK`；store 只有 `.all()`/`.get()`，无未耗尽游标）。已回写 spec §二/§六/R2，Task 4 改为三分支决策表，不预设改法。
