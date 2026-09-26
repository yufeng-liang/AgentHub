# 网关下沉独立进程（二期）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把反代网关从 Electron 主进程整体下沉为一个纯 Node 角色的常驻子进程，使「关窗后 main 不再驻留网关」与「主 App 整体退出后 9527 仍可用」两件事同时成立。

**Architecture:** 子进程 = 用打包版自己的 exe 以 `ELECTRON_RUN_AS_NODE=1` 跑 asar 内的 `electron/gateway.cjs`（已实测：asar 虚拟 FS 在该角色下完整可用，koffi 原生模块与 `node:sqlite` 都能加载，无需 `asarUnpack`）。主进程与子进程之间用 **Windows named pipe**（NDJSON 帧，双向）通信：43 条 `proxy_*` 命令名一条不改，主进程侧把 `ipcMain.handle` 换成「转发 + 事件回流」，渲染层与 `preload.cjs` 白名单零改动。`stats.db` 由子进程独占，`config.json` 唯一属主仍是主进程，凭据解密由子进程自带（DPAPI 解 `Local State` 的 `os_crypt.encrypted_key` → AES-256-GCM 解 `v10` 载荷，已实测该形态）。

**Tech Stack:** Electron 35.7.5（内嵌 Node 22.16）、`node:sqlite`、`net`（named pipe）、`koffi@3.3.0`（`Crypt32!CryptUnprotectData`）、`node:crypto`（AES-256-GCM）、electron-builder NSIS（`extraFiles` 装启动器 `.cmd`）、Vue 3 + Element Plus（设置页与网关页文案/错误态）。

**Spec:** `docs/superpowers/specs/2026-09-21-gateway-lite-mode-design.md` §五（二期设计）、§六（配置语义）、§七（错误处理）、§八（测试与验证）、§九（顺手修）、§十（非目标）、§十一（落地顺序）。一期实现与实测见 `docs/superpowers/plans/2026-09-21-gateway-lite-mode-phase1.md` 与其台账 `.superpowers/sdd/2026-09-21-gateway-lite-mode-phase1/progress.md`。

**本计划的两份实测前置**（写进计划以免执行者重复调查，但任何一条与代码冲突时以代码为准并回写本文件）：
- `tmp/gateway-probe/phase2-runtime-probes.md` —— asar/koffi/node:sqlite 三底座实证明细、便携版判定三份口径、装更调用链真实行号、四处固定 `.tmp` 名清单。
- `tmp/gateway-probe/phase2-ipc-inventory.md`（若不存在则本次会话已把结论抄进本文件 §偏差 D1）—— 43 条命令逐条归类、13 处推送调用点、逐文件 electron 依赖。

## Global Constraints

- **只本地打包，绝不碰发布链路**：`package.json` 的 `build.publish`、`.github/workflows/release.yml`、`electron/backend/updater.cjs:8` 的 `GITHUB_REPO_URL`、`electron/backend/proxy/ccswitch.cjs:274` 的 `website_url`、`src/components/config/ConfigProxySection.vue:383` 的展示文案，一律不改（规格 §十）。
- **不改 `extraResources`、不改 `resources/sqlcipher` 归属**（规格 §十）。本计划新增的是 `build.extraFiles`（装到安装根目录，与 `extraResources` 不同键），Task 6 里用产物实测证明它没顺手改掉 `extraResources`。
- **43 条 `proxy_*` 命令名全部保留**，`src/api/ipc.ts` 与 `electron/preload.cjs:109-153` 的 `ALLOWED_COMMANDS` 零改动（AGENTS.md 第四节：漏登记 → 「未授权的 IPC 命令」且界面卡在假死态）。
- **探针卫生四件套**（规格 §八 + 二期新增）：临时 userData **不等于隔离**；`AGENT_SKILLS_HOME=<临时目录>`；网关端口改到非 9527；收尾核对 HKCU Run 值列表未变。**二期新增第五条：任何「asar 内可 require / electron 不可得」类断言必须从中立 cwd（`%TEMP%`）起跑**——在仓库目录里 `require("electron")` 会命中 devDependency 的 `node_modules/electron/index.js` 而返回一个字符串路径，把假绿当真绿。
- **子进程入口必须留在 `app.asar` 内**（Task 3 的 `electron/gateway.cjs` 与 Task 6 的启动器都不得把它挪到 `extraResources` 或 asar 外）。理由不是打包习惯而是安全判据：`secretbox.packaged()` 就是 `__dirname.includes("app.asar")`，入口一旦跑出 asar，打包版会被判成开发态 → `plain-dev` → **凭据明文落盘**，正是 §5.3 那道闸门要堵的洞。Task 6 的启动器断言里必须包含「入口路径含 `app.asar`」。
- **绝不终止用户自己的实例**（本机装在 `H:\AgentHub`，监听 9527）。打包前只清 `release\win-unpacked` 下自起实例；清理脚本的可选 kill 参数为空时必须等价于「只列不杀」。
- **不得把真实 `%APPDATA%\AgentHub` 的库/配置拷进仓库，不得打印凭据内容**（连密文前缀之外的部分也不行）。本计划里凡是读真实 `stats.db` 的步骤都只读**长度与头 8 字节**做形态判定。
- 用户可见文字用中文；代码注释用中文；commit message 用中文，格式 `<type>: <描述>`。
- 测试形态沿用仓库既有约定：独立可执行脚本 `scripts/dev-*-test.cjs`，`assert` + `console.log` + 非零退出码，不引入测试框架。
- 退出路径**必须是拦下 → 异步停 → 续跑**的形状（`main.cjs:399-416` 的 `before-quit` 整体同步，不能 `await`）。

## 文件结构（本计划落地后的样子）

**新建**

| 文件 | 职责（一句话） |
|---|---|
| `electron/gateway.cjs` | 子进程入口：stdin 读 token → 装配 proxy 模块 → 起 pipe server → 写 `gateway.json` → 看门狗。不含任何业务逻辑，只做装配与生命周期 |
| `electron/backend/gateway-proto.cjs` | 帧协议单一定义处：编解码、帧上限、默认超时、免超时命令集、待响应上限。两端共用，纯 Node |
| `electron/backend/gateway-pipe.cjs` | named pipe 的 `serve()` / `connect()`：id 配对、事件帧分流、token 握手、背压 |
| `electron/backend/gateway-client.cjs` | 主进程侧监督器：读 `gateway.json`、认领双检、spawn、`call()`、事件扇出给窗口、停机/卸载互锁、`config.json` 的 `restoreOnLaunch` 归属 |
| `electron/backend/proxy/secretbox.cjs` | 凭据加解密的唯一实现：`safeStorage` → `v10`(DPAPI+koffi) → `plain-dev` → `none` 四级后端选择，含「打包态无能力即拒写」闸门 |
| `build/gateway-launcher.cmd` | 安装根目录里的自启启动器：`set ELECTRON_RUN_AS_NODE=1` + 用同目录 exe 跑 asar 内 `electron/gateway.cjs` |
| `scripts/dev-gateway-node-load-test.cjs` | Task 0 闸：从中立 cwd 用 Electron-as-Node 逐个 require 13 个下沉候选，断言零 electron |
| `scripts/dev-secretbox-test.cjs` | Task 1 闸：`enc:v1:`+`v10` 双向互解、闸门必抛、启动期失败可诊断 |
| `scripts/dev-write-ownership-test.cjs` | Task 2 闸：`config.json` 单属主、四处 `.tmp` 带 pid、WAL 有 checkpoint、`store.close()` 有调用点 |
| `scripts/dev-gateway-pipe-test.cjs` | Task 3/4 闸：帧配对、事件回流、超时、队列有界、token 拒斥、**带写副作用的命令不重放** |
| `scripts/dev-gateway-forward-parity-test.cjs` | Task 5 闸：转发面命令名与 `preload` 白名单/旧 43 条**逐字相等**，漏一条即红 |
| `scripts/dev-gateway-launcher-test.cjs` | Task 6 闸：启动器内容断言 + 便携版拒常驻 + Run 项目标随 `persistentGateway` 切换 |
| `scripts/dev-gateway-interlock-test.cjs` | Task 7 闸：三个装更/退出入口都「先停干净子进程再放行」，超时兜底会强杀 |

**修改**

- `electron/backend/proxy/index.cjs` —— `:7` 顶层 `require("electron")` 惰性化；`vaultOk()`、`rememberRunning()` 撤出子进程可达面；`settings()` 与 `boot()` 的角色改写；`register(ipcMain)` 保留但只在主进程侧用。
- `electron/backend/proxy/events.cjs` —— `emit()` 的出口从 `BrowserWindow.getAllWindows()` 改为可注入 sink（主进程=广播窗口，子进程=写管道）。
- `electron/backend/proxy/server.cjs` —— `/healthz` 拆 liveness / `/readyz` readiness；`start()` 的 EADDRINUSE 文案区分「已接管常驻网关」。
- `electron/backend/proxy/store.cjs` —— `close()` 落地调用、`checkpoint()` 新增、`tokenUsable` 对解密抛错的处置、删 `better-sqlite3` 死回退。
- `electron/backend/proxy/poolsync.cjs` —— `appVersion()` 不再依赖 electron；`onSharedPasswordMaybeChanged` 改由管道命令触达。
- `electron/backend/proxy/ccswitch.cjs:342-344` —— 端口回落从读 `config.json` 改为读子进程 `server.status()`。
- `electron/backend/config.cjs` —— `encryptSecret`/`decryptSecret` 委派给 `secretbox`；`saveConfig` 临时文件名加 pid；`schedule` 段加 `persistentGateway`；`applyAutoStart` 的 Run 项目标按 `persistentGateway` 切换。
- `electron/backend/ipc.cjs` —— `:18`/`:474` 不再把 proxy 依赖图拉进主进程；`:176` 反向跨界写改走管道。
- `electron/main.cjs` —— `:378` `proxy.boot()` → 监督器启动；`:407`/`:415` 两条退出路径与 `ipc.cjs:120` 短路一起收敛到停机互锁。
- `electron/backend/updater.cjs` —— `triggerInstall` 与互锁的衔接点。
- `src/components/config/ConfigGeneralSection.vue` —— `persistentGateway` 开关（便携版灰置 + 生效时机文案）。
- `src/views/proxy/*` —— 子进程起不来的错误态渲染，不得卡在「检测中」。
- `package.json` —— `build.extraFiles`。
- `AGENTS.md`（不入库，本机）—— 第四节 IPC 白名单核对脚本改成含转发面。

**任务顺序即依赖顺序**：Task 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9。任前不通不得继续（规格 §十一「阻塞项按依赖排序，任一不通不得继续」）。

---

### Task 0: 下沉前置——网关依赖图在纯 Node 下可加载

**Files:**
- Modify: `electron/backend/proxy/index.cjs:7`、`electron/backend/proxy/index.cjs:233-240`（`vaultOk`）、`electron/backend/proxy/poolsync.cjs:462-464`（`appVersion`）、`electron/backend/proxy/util.cjs`（新增 `appVersion` 导出）
- Create: `scripts/dev-gateway-node-load-test.cjs`
- Test: 同上

**Interfaces:**
- Consumes: 无（本任务是地基）
- Produces: `util.appVersion(): string` —— 两端同源（主进程与子进程都返回 `package.json` 的 `version`），Task 3 的 `gateway.json.version` 与 Task 7 的版本比对依赖它；`index.cjs` 在**没有 electron 绑定**的环境里 `require` 不抛错——Task 3 的子进程入口直接 `require("./backend/proxy/index.cjs")` 才成立。

**为什么排第一**：实测把整条网关依赖图逐个 require 过，13 个候选模块里**只有 `index.cjs` FAIL**，原因是一行顶层 `const { shell } = require("electron");`（`:7`，无 try）。这不是重构，是一行惰性化；不先做掉，后面所有子进程侧的测试都跑不起来。

- [ ] **Step 1: 写失败的测试**

`scripts/dev-gateway-node-load-test.cjs`：

```js
// 二期 Task 0 闸：网关依赖图必须在「纯 Node 角色」下可加载。
// 关键：必须从中立 cwd 跑。在仓库目录里 require("electron") 会命中 devDependency 的
// node_modules/electron/index.js，它返回一个 exe 路径**字符串**（不是 Electron 绑定），
// 于是 typeof electron === "object" 为假、看似"降级成功"实则是假绿。探针卫生第五条。
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-gwnode-"));
fs.copyFileSync(path.join(ROOT, "electron/backend/proxy/index.cjs"), path.join(work, "sentinel.cjs"));

// 子进程里跑的最小断言集：能 require 全部候选 + util.appVersion 不依赖 electron
const child = `"use strict";
const path = require("node:path");
const names = ["server","store","rules","pool","poolsync","adapters","credits","discovery","events","ideswitch","ccswitch","util","raccoonAuth","index"];
for (const n of names) { require(path.join(${JSON.stringify(path.join(ROOT, "electron/backend/proxy").replace(/\\/g, "/"))}, n + ".cjs")); }
require(path.join(${JSON.stringify(path.join(ROOT, "electron/backend").replace(/\\/g, "/"))}, "config.cjs"));
const util = require(path.join(${JSON.stringify(path.join(ROOT, "electron/backend/proxy").replace(/\\/g, "/"))}, "util.cjs"));
const v = util.appVersion();
if (!/^\\d+\\.\\d+\\.\\d+/.test(String(v))) throw new Error("appVersion 不是版本号: " + JSON.stringify(v));
const el = require("node:fs").existsSync(path.join(process.cwd(), "node_modules/electron"));
if (el) throw new Error("cwd 污染：中立 cwd 里不该有 node_modules/electron");
console.log("CHILD-OK " + v);
`;

const r = spawnSync(process.execPath, ["-e", child], {
  cwd: work, encoding: "utf8",
  env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1", AGENT_SKILLS_HOME: path.join(work, "hub") }),
});
const out = (r.stdout || "") + (r.stderr || "");
assert.strictEqual(r.status, 0, "纯 Node 加载网关依赖图失败：\n" + out.slice(0, 1200));
assert.match(out, /CHILD-OK \d+\.\d+\.\d+/, "子进程没打出 CHILD-OK：\n" + out.slice(0, 400));
try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows 偶发 EBUSY，交给系统回收 */ }
console.log("OK 网关依赖图在纯 Node（无 electron 绑定）下可整体加载");
```

- [ ] **Step 2: 跑到失败**

Run: `node scripts/dev-gateway-node-load-test.cjs`
Expected: FAIL —— `Cannot find module 'electron'`（`index.cjs:7`）与 `util.appVersion is not a function` 两类错各至少一条。若此处**通过**，先怀疑测试自己被污染：核对 `cwd` 确实是 `os.tmpdir()` 下的目录，且报错信息里不出现 `H:\codex-project`。

- [ ] **Step 3: `index.cjs` 的 shell 惰性化**

删掉 `:7` 的顶层 require，改成与 `events.cjs:5-7` 同一口径的惰性取用：

```js
// shell 只在 4 条「留主进程」的命令里用到（openExternal / openPath）。
// 顶层 require("electron") 会让整张依赖图在纯 Node 子进程里加载不了（Task 0 实测唯一 FAIL 点），
// 故惰性取 + 拿不到时明确抛错，而不是让子进程 require 到一半炸掉。
function getShell() {
  try {
    const el = require("electron");
    return el && typeof el === "object" ? el.shell : null;
  } catch {
    return null;
  }
}
```

三处调用点各改成 `const shell = getShell(); if (!shell) throw new Error("该操作需要主进程界面，不能由后台常驻网关执行");` 再照原样用 `shell.openExternal(...)` / `shell.openPath(...)`（`index.cjs:391`、`:517`、`:521`）。

- [ ] **Step 4: `vaultOk()` 撤出子进程可达面**

`index.cjs:233-240` 的 `vaultOk()` 现在读 `require("electron").safeStorage`，纯 Node 下恒 `false`，会让 `gatewayStatus()`（`:228`）向界面报「凭据保险不可用」。改成读 Task 1 的 `secretbox.backend()`：

```js
const secretbox = require("./secretbox.cjs");   // Task 1 建；本步先建空壳返回 "pending"
// 保险可用性 = 「凭据能不能被解」，与在哪个进程无关。旧实现只看 safeStorage，
// 子进程里没有 electron 绑定 → 恒 false → 网关页误报（见 §5.7 更正：这条命令因此可转发）。
function vaultOk() { return secretbox.backend() !== "none"; }
```

Task 1 未完成前，本步先落 `secretbox.cjs` 的骨架（`backend()` 返回 `"safeStorage"`/`"none"` 两种，按 safeStorage 是否可得），Task 1 再补 `v10` 分支。

- [ ] **Step 5: `appVersion` 收口到 `util.cjs`**

`util.cjs` 末尾导出新增：

```js
/** 版本号：两端同源。旧实现 poolsync.cjs:463 用 require("electron").app.getVersion()，
 *  try 吞错后在子进程里恒返回 ""，会让 gateway.json 的版本比对（Task 3/7）永远"不匹配"→ 每次启动都重杀子进程。 */
function appVersion() {
  try { return require("../../../package.json").version || ""; } catch { return ""; }
}
```

`poolsync.cjs:462-464` 改为 `const util = require("./util.cjs");` + 调用点用 `util.appVersion()`；`grep -n "require(\"electron\")" electron/backend/proxy/poolsync.cjs` 应零命中。

- [ ] **Step 6: 跑到通过并核无残留**

Run: `node scripts/dev-gateway-node-load-test.cjs`
Expected: `OK 网关依赖图在纯 Node（无 electron 绑定）下可整体加载`
Run: `node scripts/dev-gateway-node-load-test.cjs && grep -rn "require(\"electron\")" electron/backend/proxy/ | wc -l`
Expected: 计数从 6 降到 3（只剩 `events.cjs:6`、`index.cjs` 的 `getShell`/`vaultOk` 系惰性位；`store.cjs`/`config.cjs` 本就在 try 里）。

- [ ] **Step 7: 提交**

```bash
git add electron/backend/proxy/index.cjs electron/backend/proxy/poolsync.cjs electron/backend/proxy/util.cjs electron/backend/proxy/secretbox.cjs scripts/dev-gateway-node-load-test.cjs
git commit -m "refactor: 网关依赖图在纯 Node 下可整体加载（index.cjs 顶层 electron 惰性化、appVersion 收口 util）"
```

---

### Task 1: 凭据自带解密（v10）+ 打包态拒写明文闸门

**Files:**
- Create: `electron/backend/proxy/secretbox.cjs`（Task 0 Step 4 已建骨架，此处补全）
- Modify: `electron/backend/config.cjs:25-47`（`encryptSecret`/`decryptSecret` 委派）、`electron/backend/proxy/store.cjs:276-292`（`tokenUsable` 对抛错的处置）
- Modify: `electron/backend/proxy/store.cjs:13-25`（删 `better-sqlite3` 死回退，规格 §九 指定二期改 store.cjs 时顺手做）
- Test: `scripts/dev-secretbox-test.cjs`

**Interfaces:**
- Consumes: Task 0 的 `vaultOk()` 接入点
- Produces: `secretbox.backend(): "safeStorage" | "v10" | "plain-dev" | "none"`；`secretbox.encrypt(plain: string): string`（**打包态且无能力时 throw**）；`secretbox.decrypt(stored: string): string`（解不开时 throw）；`secretbox.assertUsable(): void`（Task 3 子进程启动期调用，失败即不 listen）

**方案定案证据（不要重新推导）**：真实 `stats.db` 的 `keys.key_enc` / `accounts.token_enc` / `accounts.refresh_enc` 三类密文，base64 解码后头三字节都是 ASCII `v10`（`763130...`）；`%APPDATA%\AgentHub\Local State` 的 `os_crypt.encrypted_key` 长 **283 B**、头五字节是 ASCII `DPAPI`。所以规格 §5.3 那条链是对的：**DPAPI 解包 283 B（剥掉 5 字节 `DPAPI` 前缀）→ 得 32 B AES-256 主密钥 → `node:crypto` AES-256-GCM，载荷 = `v10`(3B) + nonce(12B) + 密文 + tag(16B)**。全仓 grep 证实没有任何现成实现可复用（`encrypted_key`/`v10`/`Local State` 零命中），这是净新增。
koffi 侧写法照 `tmp/gateway-probe/probe-koffi-dpapi2.cjs` 抄，**别照文档默认猜测**：`lib.func('bool __stdcall CryptUnprotectData(_Inout_ DATA_BLOB *a, ..., _Out_ DATA_BLOB *b)')` 这种单串声明才对；`'uint32_t __stdcall Name()'` 同理；两参 `koffi.encode` 与 `koffi.view()` 都会踩坑（后者 koffi 文档自己标「Electron 禁用」），全程用 `koffi.decode` 拷出。

**为什么不能走「主进程 RPC 回填」**：热路径上每次 chat completion 至少 4 次解密（`server.cjs:644` → `settings()`(`index.cjs:83`) → `config.loadConfig()` → `decryptSecret`×2，加 `store.accountSecrets`(`server.cjs:89`) ×2），逐次跨进程往返直接劣化 TTFT，且与「主 App 可整体退出」自相矛盾（规格 §5.3）。

- [ ] **Step 1: 写失败的测试**

`scripts/dev-secretbox-test.cjs` 必须覆盖下面 6 条（第 4、5 条是本次改动的**目的**，缺了就是自娱自乐）：

```js
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-sbox-"));
process.env.APPDATA = work;                       // config.cjs 纯 Node 退回 %APPDATA%\AgentHub
process.env.AGENT_SKILLS_HOME = path.join(work, "hub");

// 1) 无 Local State、无 safeStorage：打包态判据决定是 plain-dev 还是 none
//    打包判据是 __dirname.includes("app.asar")（见 Step 2），所以测试**自己造那个路径**：
//    把 secretbox.cjs 连它 require 的同目录兄弟一起拷进 <tmp>/app.asar/backend/ 再 require 它。
//    这样测的是生产判据本身，不给产品代码开测试后门。
function fresh() { for (const k of Object.keys(require.cache)) if (k.includes("secretbox") || k.includes("config.cjs")) delete require.cache[k]; }
function copyInto(parent, rel) {                        // rel 保持相对层级，兄弟 require 才解析得到
  const dst = path.join(parent, "app.asar", rel);
  fs.mkdirSync(path.join(dst, "backend/proxy"), { recursive: true });
  fs.copyFileSync(path.join(__dirname, "../electron/backend/proxy/secretbox.cjs"), path.join(dst, "backend/proxy/secretbox.cjs"));
  return path.join(dst, "backend/proxy/secretbox.cjs");
}
fresh();
const devCopy = copyInto(path.join(work, "devmode"), "electron");
assert.strictEqual(require(devCopy).backend(), "plain-dev", "开发态无 Local State 应降级明文（保住 tools/proxy-smoke 与既有自测）");

// 2) 有 Local State：v10 双向自解（自造合成密钥，绝不读真实凭据）
const { execFileSync } = require("node:child_process");
const key = Buffer.alloc(32, 7);
fs.writeFileSync(path.join(work, "Local State"), JSON.stringify({
  os_crypt: { encrypted_key: "DPAPI" + key.toString("latin1") },  // 见下方 mock 说明
}), "utf8");
```

> **DPAPI 在测试里怎么造**：`CryptProtectData` 的输入不能手写。测试脚本自己在 `work` 目录里用 koffi 调一次 `CryptProtectData` 包出一个真 DPAPI blob（与生产同一入口，测的就是这条链），再 base64 成 `encrypted_key`。若本机 koffi 不可用，测试**跳过并 exit 2 + 打印 `SKIP`**，不得静默通过。断言「解出来的 32 B 与我们放进去的完全一致」而不是「没抛错」。

3) `enc:v1:` 兼容性：`decrypt("enc:v1:" + base64("v10"+nonce+ct+tag))` 能解出我们自造的明文（与 `config.cjs` 的 `ENC_PREFIX` 语义一致）。
4) **闸门必抛**（测的是生产判据，不测注入的 flag）：

```js
assert.strictEqual(require(devCopy).encrypt("abc"), "abc", "plain-dev 下明文照旧");   // 既有自测的保命语义
fresh();
const pkgCopy = copyInto(path.join(work, "pkgmode"), "electron");
const sb = require(pkgCopy);
assert.ok(sb.__selfCheck.includes("app.asar"), "拷贝没进 asar 路径，这条断言会假绿");   // 判据自证
assert.strictEqual(sb.backend(), "none", "打包态 + 无 Local State + 无 safeStorage 必须是 none");
assert.throws(() => sb.encrypt("token-abc"), /凭据加密/, "打包态无能力时必须拒写，不得静默明文");
assert.throws(() => sb.assertUsable(), /凭据解密失败/);
```

`__selfCheck` 是 `secretbox` 导出的一个只读字符串（值 = `__dirname`），存在的唯一目的是让测试能自证「我确实是从 asar 路径 require 进来的」——它不参与任何生产判断。

5) **未知密文形态不静默**：`assert.throws(() => sb.decrypt("enc:v1:" + Buffer.from("junkjunkjunk").toString("base64"), /未知密文形态/)`；同时 `sb.decrypt("")` 与 `sb.decrypt("plain")` 必须原样返回（存量明文路径不破）。
6) **同文不同进程可解**：父进程用 `v10` 后端造一条密文，spawn 子进程（`process.execPath -e`，中立 cwd、同一 `work`）解回来，断言字符串相等；反向再跑一次。这才是「对存量密文 100% 兼容、无需迁移」的硬证据，光测「自己加密自己解密」不算（那条只证明 AES-GCM 没写错，不证明与 safeStorage 互解）。
7) **`vaultOk()` 在四种后端下的取值符合 §5.7 定案**（扫描裁决 T0↔T1 补的断言）：`none`→`false`，`plain-dev`/`v10`/`safeStorage`→`true`。这条是给 Task 5 用的前提 —— `proxy_status`/`proxy_vault_status` 之所以能从「留主进程」退回「可转发」，全靠 `vaultOk()` 不再依赖 electron；没有这条断言，Task 5 的归属表就是建在推测上。用 `index.gatewayStatus()` 直接断言 `vaultOk` 字段，别只测 `secretbox.backend()`。

Run: `node scripts/dev-secretbox-test.cjs` → Expected: FAIL（`Cannot find module ... secretbox.cjs` 或断言 4 不抛）。

- [ ] **Step 2: 写 `secretbox.cjs` 的 v10 分支**

```js
// 凭据加解密的唯一实现。后端优先级：safeStorage（主进程）→ v10（纯 Node，DPAPI+AES-256-GCM）→
// plain-dev（开发态明文）→ none（打包态无能力：encrypt 抛错，绝不明文落盘）。
// 为什么要有 v10 分支：二期网关跑在没有 electron 绑定的纯 Node 子进程里，而存量密文全是
// Chromium os_crypt 的 v10 形态（实测 enc:v1: 载荷头三字节 = ASCII "v10"，Local State 的
// os_crypt.encrypted_key 283 B、头五字节 "DPAPI"）。热路径每请求至少 4 次解密，不能回主进程取。
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ENC_PREFIX = "enc:v1:";
const V10 = "v10";
const NONCE_LEN = 12;
const TAG_LEN = 16;

let safeStorage = null;
try {
  const el = require("electron");
  if (el && typeof el === "object" && el.safeStorage && el.safeStorage.isEncryptionAvailable()) safeStorage = el.safeStorage;
} catch { /* 纯 Node 子进程 */ }

/** 打包态判据：不能用 app.isPackaged（子进程没有 app）。asar 路径在两种角色下都是真字符串。 */
function packaged() { return __dirname.includes("app.asar"); }

let keyCache; // null=未取过；Buffer=可用；false=不可用
function osCryptKey() {
  if (keyCache !== undefined && keyCache !== null) return keyCache === false ? null : keyCache;
  keyCache = null;
  try {
    const dir = process.env.APPDATA ? path.join(process.env.APPDATA, "AgentHub") : null;
    const ls = dir && path.join(dir, "Local State");
    if (!ls || !fs.existsSync(ls)) return null;
    const b64 = JSON.parse(fs.readFileSync(ls, "utf8")).os_crypt.encrypted_key;
    const raw = Buffer.from(String(b64 || ""), "base64");
    if (raw.length < 6 || raw.subarray(0, 5).toString("latin1") !== "DPAPI") return null;
    const koffi = require("koffi");
    const crypt32 = koffi.load("crypt32.dll");
    const DATA_BLOB_IN = koffi.struct("DATA_BLOB_IN", { cbData: "uint32_t", pbData: "void*" });
    const DATA_BLOB_OUT = koffi.struct("DATA_BLOB_OUT", { cbData: "uint32_t", pbData: "void*" });
    const unprotect = crypt32.func(
      "bool __stdcall CryptUnprotectData(_Inout_ DATA_BLOB_IN *pDataIn, void *pDescStr, void *pAuth, uint64_t dwFlags, void *pPrompt, _Out_ DATA_BLOB_OUT *pDataOut)"
    );
    const out = { cbData: 0, pbData: null };
    // 注意：CRYPTPROTECT_UNPROTECT_FLAGS=0x20 让任何机器/任何用户都能解 —— 不传，DPAPI 默认绑定
    // 当前用户，与 safeStorage 的行为一致；跨机器解不开就是既有语义，不是本次回归。
    if (!unprotect({ cbData: raw.length - 5, pbData: raw.subarray(5) }, null, null, 0, null, out)) return null;
    const key = Buffer.from(koffi.decode(out.pbData, koffi.as("uint8_t", out.cbData)));
    crypt32.func("bool __stdcall LocalFree(void *h)") ? require("node:ffi") : null; // 见 Step 2 注：释放用 Kernel32!LocalFree
    keyCache = key.length === 32 ? key : false;
    return keyCache === false ? null : keyCache;
  } catch {
    keyCache = false;
    return null;
  }
}
```

> **Step 2 落笔时必办两件事**（写在这里免得执行者踩）：① 上面那行 `LocalFree` 的三元是**占位错误写法，不许照抄**——正确做法是 `koffi.load("kernel32.dll").func("void* __stdcall LocalFree(void* hMem)")`，对 `out.pbData` 调一次，失败不致命但要记进日志。② koffi 的 `void*` 成员传参两种写法都实测可用（`Uint8Array` 直传 / `koffi.as(buf,"void*")`），选后者并在测试里断言往返一致，别混用。

- [ ] **Step 3: `backend()` / `encrypt` / `decrypt` / `assertUsable`**

```js
function backend() {
  if (safeStorage) return "safeStorage";
  if (osCryptKey()) return "v10";
  return packaged() ? "none" : "plain-dev";
}

function encrypt(plain) {
  const s = String(plain || "");
  if (!s || s.startsWith(ENC_PREFIX)) return s;
  const b = backend();
  if (b === "safeStorage") return ENC_PREFIX + safeStorage.encryptString(s).toString("base64");
  if (b === "v10") {
    const nonce = crypto.randomBytes(NONCE_LEN);
    const c = crypto.createCipheriv("aes-256-gcm", osCryptKey(), nonce);
    const ct = Buffer.concat([c.update(s, "utf8"), c.final()]);
    return ENC_PREFIX + Buffer.concat([Buffer.from(V10, "latin1"), nonce, ct, c.getAuthTag()]).toString("base64");
  }
  if (b === "plain-dev") return s;
  throw new Error("凭据加密不可用：拒绝以明文写入号池（请确认 Local State 与当前用户 DPAPI 可用）");
}

function decrypt(stored) {
  const s = String(stored || "");
  if (!s.startsWith(ENC_PREFIX)) return s;             // 存量明文（开发态降级时写的）
  const raw = Buffer.from(s.slice(ENC_PREFIX.length), "base64");
  if (safeStorage) { try { return safeStorage.decryptString(raw); } catch { /* 落回 v10 */ } }
  const head = raw.subarray(0, 3).toString("latin1");
  if (head === V10) {
    const key = osCryptKey();
    if (!key) throw new Error("凭据解密失败：本机 v10 主密钥不可得（Local State / DPAPI）");
    const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(3, 3 + NONCE_LEN));
    d.setAuthTag(raw.subarray(raw.length - TAG_LEN));
    return Buffer.concat([d.update(raw.subarray(3 + NONCE_LEN, raw.length - TAG_LEN)), d.final()]).toString("utf8");
  }
  throw new Error("凭据解密失败：未知密文形态（头 3 字节 " + JSON.stringify(head) + "）");
}

/** 启动期闸门：号池里只要有解不开的 enc:v1:，就立刻失败并说清楚，而不是空号池空转。
 *  旧行为：config.decryptSecret 吞错返回 "" → store.tokenUsable 判所有账号不可用
 *  → pool 无候选 → 503，用户看到的是「号池没号」，真实原因是换了机器/主密钥不可得。 */
function assertUsable() {
  if (backend() === "none") throw new Error("凭据解密失败：打包环境既无 safeStorage 也无本机 v10 主密钥");
}
```

`config.cjs:25-47` 的 `encryptSecret`/`decryptSecret` 改为**逐字委派** `secretbox.encrypt/decrypt`（保留导出名，12 个调用点不动），`ENC_PREFIX` 常量随之删掉。**注意方向**：`secretbox.cjs` 不得 `require("../config.cjs")`（会成环）；它只自己解析 `APPDATA`。

- [ ] **Step 4: `tokenUsable` 与死回退**

`store.cjs:276-292`：`ok = !!config.decryptSecret(r.token_enc)` 改为

```js
let ok = false;
try { ok = !!config.decryptSecret(r.token_enc); }
catch (e) { ok = false; e.credentialFailure = true; rememberDecryptFailure(e); }  // 计数上报给 Task 3 的 readiness
```

新增模块内 `decryptFailures` 计数 + 导出 `store.decryptFailureCount()`，Task 3 的 `/readyz` 用它区分「没号」与「解不开」。
`store.cjs:13-25` 的 `better-sqlite3` 回退分支删除（该包不在依赖里、`node_modules/better-sqlite3` 实测不存在），`driver()` 只回 `"node:sqlite"` 或 `"none"`。

- [ ] **Step 5: 跑到通过 + 既有自测不破**

Run: `node scripts/dev-secretbox-test.cjs` → Expected: `OK 凭据双后端互解、打包态拒写明文`
Run: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-smoke.cjs "$(mktemp -d)"` → Expected: `SMOKE OK`（开发态 `plain-dev`，明文语义与一期一致，这条是「不破坏既有自测」的证据）
Run: `npm run build` → Expected: vue-tsc 无错（`config.cjs` 导出面没动，前端不感知）

- [ ] **Step 6: 提交**

```bash
git add electron/backend/proxy/secretbox.cjs electron/backend/config.cjs electron/backend/proxy/store.cjs scripts/dev-secretbox-test.cjs
git commit -m "feat: 子进程自带 v10 凭据解密 + 打包态拒写明文闸门"
```

---

### Task 2: 写权与句柄归属

**Files:**
- Modify: `electron/backend/config.cjs:359-376`、`electron/backend/hub.cjs:39`、`electron/backend/sync-config.cjs:475`、`electron/backend/sync.cjs:185`（四处固定 `.tmp`）
- Modify: `electron/backend/proxy/store.cjs`（`checkpoint()` 新增、`close()` 语义）
- Create: `scripts/dev-write-ownership-test.cjs`

**Interfaces:**
- Consumes: Task 1 的 `store.decryptFailureCount()`
- Produces: `store.checkpoint(): boolean`（`PRAGMA wal_checkpoint(TRUNCATE)`）、`store.startCheckpointTimer(intervalMs): () => void`（返回 stop 函数）、`store.walBytes(): number`（供 Task 8 量 WAL 是否停止单调增长）；`config.saveConfig` 的临时文件名带 pid

- [ ] **Step 1: 写失败的测试**

`scripts/dev-write-ownership-test.cjs` 四条断言，每条都要能咬：

```js
// ① 临时文件名带 pid：把两个进程同时写同一份 config.json 的互踩做成可观测断言
//    做法：父进程与子进程各自 saveConfig 一个**可区分**的 theme 值，各跑 20 次，
//    断言最终文件是两者之一且 JSON 合法（不是半个文件），且 .tmp* 残留为 0。
// ② 全仓 `grep -n '\.tmp"' electron/backend/*.cjs` 命中的四处都必须拼 process.pid
// ③ store.checkpoint() 之后 wal 文件 < 4 KB（写完 500 行再 checkpoint）
// ④ store.close() 在源码里至少有 1 个调用点（grep 断言，不再靠人记）
// ⑤ 主进程不得再持有那四个数据文件的写路径：静态断言 electron/backend/ipc.cjs 与
//    electron/main.cjs 里 grep 不到 require("./proxy/poolsync.cjs")、require("./proxy/store.cjs")、
//    require("./proxy/index.cjs")。实测写点清单（规格只点了 config.json 与 stats.db，另四个是漏的）：
//      proxyDir()/catalog.json        ← index.cjs:483（proxy_models_sync）
//      rulesDir/ 默认值与补键迁移      ← rules.cjs:233 / :244（ensureFiles）
//      proxyDir()/sync-state.json     ← poolsync.cjs:77（:429 / :470 触发）
//      proxyDir()/pool-tombstones.json ← poolsync.cjs:310（index.cjs:324 触发）
//    这四个都归子进程独占。**本任务只做棘轮**：断言 `ipc.cjs`/`main.cjs` 里对 proxy 域的 require 数
//    不得比基线增加（此刻删除还没发生，硬零会一路红到 Task 5，破坏"每任务收尾都可验证"）；
//    硬零由 Task 5 的 dev-gateway-forward-parity-test 接管，那里才是删除落地的地方。
```

Expected 首跑 FAIL：`config.json.tmp` 仍是固定名、`grep -c "store.close()" → 0 命中`。

- [ ] **Step 2: 四处临时文件名加 pid**

统一写法（`config.cjs:372` 为例，另三处同样改）：

```js
// 带 pid：二期主进程与常驻网关子进程可能同刻写盘（子进程不写 config.json，但写
// sync-state.json / catalog.json 的同族写法在 hub/sync 里），固定名会互相 rename 踩掉。
const tmp = `${p}.${process.pid}.tmp`;
try { fs.writeFileSync(tmp, JSON.stringify(disk, null, 2), "utf8"); fs.renameSync(tmp, p); }
catch (e) { try { fs.unlinkSync(tmp); } catch { /* 半成品已不在 */ } throw e; }
```

`sync.cjs:185` 那处是下载落盘（`target + ".tmp"`），同样加 pid；`hub.cjs:39` 与 `sync-config.cjs:475` 一并改（规格 §九 只点名 `config.cjs`，实测同病共 4 处，其中 2 处落在 `~/.agent_skills`——两个安装共享的目录，跨进程面更大）。

- [ ] **Step 3: WAL 与 close**

`store.cjs` 新增：

```js
/** WAL 收敛：本机实测 stats.db-wal 曾长到 1.59 MB 且自 16:41 起零次 checkpoint ——
 *  全仓只有 journal_mode=WAL，没有 wal_checkpoint，close() 更是无人调用。
 *  双进程争锁时 busy_timeout=5000 会把转发卡 5 秒，所以二期必须单一写者；这条是第二道保险。 */
function checkpoint() {
  if (!db) return false;
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); return true; } catch { return false; }
}
const CHECKPOINT_MS = 5 * 60 * 1000;
let ckTimer = null;
function startCheckpointTimer(ms) {
  stopCheckpointTimer();
  ckTimer = setInterval(checkpoint, ms || CHECKPOINT_MS);
  if (ckTimer.unref) ckTimer.unref();
  return stopCheckpointTimer;
}
function stopCheckpointTimer() { if (ckTimer) clearInterval(ckTimer); ckTimer = null; }
function walBytes() { try { return fs.statSync(dbFile() + "-wal").size; } catch { return 0; } }
```

`close()` 保持幂等，但在关之前先 `checkpoint()`（这样正常退出留不下大 WAL）。三个新导出进 `module.exports`。

- [ ] **Step 4: 跑到通过**

Run: `node scripts/dev-write-ownership-test.cjs` → Expected: `OK 写权归属四条断言全通过`
反向咬合验证（必做并记进报告）：把 `config.cjs` 的 tmp 名临时改回 `p + ".tmp"`，断言 ① 或 ② 必须变红；改回来再绿。

- [ ] **Step 5: 提交**

```bash
git add electron/backend/config.cjs electron/backend/hub.cjs electron/backend/sync-config.cjs electron/backend/sync.cjs electron/backend/proxy/store.cjs scripts/dev-write-ownership-test.cjs
git commit -m "fix: 原子写临时名带 pid、WAL 周期 checkpoint 与 store.close() 落地调用点"
```

---

### Task 3: 生命周期基座（握手 / 认领 / 看门狗 / 日志 / liveness 与 readiness）

**Files:**
- Create: `electron/gateway.cjs`、`electron/backend/gateway-client.cjs`、`electron/backend/gateway-pipe.cjs`（**最小可用版**：单连接、`serve`/`connect`/`call`/`broadcast` 齐全，不含超时与队列上界）
- Modify: `electron/backend/proxy/server.cjs:653-657`（`/healthz` 拆语义）、`electron/backend/proxy/index.cjs:163-182`（`boot`/`shutdown` 的角色化改造）、`electron/main.cjs:378`
- Test: `scripts/dev-gateway-pipe-test.cjs`（本任务先建，Task 4 硬化时再补协议组）

> **事前扫描修正 P2**：本任务的 `gateway.cjs` 与 Step 7 的认领断言都要真的跑起一条管道，而完整通道是 Task 4 的交付物 —— 原计划里 Task 3 依赖 Task 4、Task 4 又依赖 Task 3，是死锁。修正为：Task 3 落**最小版** `gateway-pipe.cjs`（够 spawn/认领/事件回流通即可），Task 4 只做硬化（配对乱序、10 s 超时、有界队列、不重放、溢出断开）。

**Interfaces:**
- Consumes: Task 0 的 `util.appVersion()`、Task 1 的 `secretbox.assertUsable()`、Task 2 的 `store.startCheckpointTimer()`
- Produces：
  - `gateway.json`（落在 `store.proxyDir()`，即 `%APPDATA%\AgentHub\proxy\gateway.json`）：`{ pid, pipe, token, port, version, startedAt, secretBackend }`
  - `gateway-client.start({ persistent })` → `{ ok, claimed: boolean, pid, port, message? }`
  - `gateway-client.state()` → 上述 gateway.json 的内存镜像 + `{ alive, connected }`
  - `gateway-client.stopAndWait({ timeoutMs })` → `{ stopped, portFreed, message }`（Task 7 互锁唯一出口）
  - `gateway-client.call(cmd, args, opts)` → `Promise<data>`（Task 5 的转发体就一行）
  - `gateway-client.onEvent(cb)` → `() => void`（Task 5 用它扇出 `app:event`）

- [ ] **Step 1: 先定帧协议（Task 4 之前只要三条命令够测）**

`electron/backend/gateway-proto.cjs`：

```js
// 管道帧 = 一行一条 JSON（NDJSON）。两端共用，故单独成文件且零依赖。
// k: req 请求 / res 响应 / evt 子进程主动推的事件 / hello 握手
// 不用长度前缀二进制帧：可读性换来的调试价值在这个项目里更高（日志里能直接 grep 到命令名），
// 响应体量最大的是 proxy_pool（全量号池×4 渠道）与 proxy_stats_detail（≤100 行），JSON 足够。
const MAX_FRAME_BYTES = 8 * 1024 * 1024;      // 与 server 的 32MB 请求体上限同量级偏小，超限即断连
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_PENDING = 64;                        // 待响应上界：主 App 卡死时不让子进程堆内存
// 长任务：本就立即返回、进度靠 evt 回流，不给管道超时（超时留在任务内部）
const NO_TIMEOUT_CMDS = new Set(["proxy_poolsync_run", "proxy_checkin_run", "proxy_credits_refresh"]);
// 带写副作用的读命令：任何"重试/重放"逻辑都必须排除它们（实测 proxy_pool 会回写派生复活）
const NON_IDEMPOTENT_READS = new Set(["proxy_pool", "proxy_status"]);
function encode(obj) { return JSON.stringify(obj) + "\n"; }
function createParser(onFrame, onOverflow) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      let f = null; try { f = JSON.parse(line); } catch { continue; }
      onFrame(f);
    }
    if (buf.length > MAX_FRAME_BYTES) { buf = ""; if (onOverflow) onOverflow(); }
  };
}
module.exports = { MAX_FRAME_BYTES, DEFAULT_TIMEOUT_MS, MAX_PENDING, NO_TIMEOUT_CMDS, NON_IDEMPOTENT_READS, encode, createParser };
```

- [ ] **Step 2: 子进程入口 `electron/gateway.cjs`**

职责边界：只做装配与生命周期，**不含业务逻辑**。

```js
// 独立网关子进程入口（二期）。跑法：ELECTRON_RUN_AS_NODE=1 <AgentHub.exe> <...>/app.asar/electron/gateway.cjs
// 为什么用同一个 exe 而不是系统 node：只有 Electron 自带 Node 在这条路上装了 asar 虚拟 FS，
// 实测系统 Node（v26）连 app.asar 都看不见（fs.statSync 直接 ENOENT）。
// 该角色下 require("electron") 抛 MODULE_NOT_FOUND —— 不是性质，是"electron 没被打进生产依赖"的性质，
// 所以本文件的任何断言都必须能容忍两种打包态；测试从中立 cwd 起（探针卫生第五条）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const gatewayPipe = require("./backend/gateway-pipe.cjs");
const { encode } = require("./backend/gateway-proto.cjs");
const log = require("./backend/gateway-log.cjs");      // 本任务 Step 5 建
const store = require("./backend/proxy/store.cjs");
const secretbox = require("./backend/proxy/secretbox.cjs");
const util = require("./backend/proxy/util.cjs");
const proxy = require("./backend/proxy/index.cjs");

// token 只从 stdin 来（不放 argv：任务管理器和进程列表看得见，而它能调用返回明文 Key 的命令）
function readHandshake() {
  return new Promise((resolve, reject) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { s += d; if (s.includes("\n")) { const l = s.split("\n")[0].trim(); if (l) { cleanup(); resolve(JSON.parse(l)); } } });
    process.stdin.on("end", () => reject(new Error("stdin 提前关闭：父进程未投递握手")));
    function cleanup() { try { process.stdin.pause(); } catch { /* 已关 */ } }
  });
}

async function main() {
  const hs = await readHandshake();            // { token, parentPid, persistent }
  log.line("boot", { version: util.appVersion(), secretBackend: secretbox.backend(), persistent: !!hs.persistent });
  secretbox.assertUsable();                    // 凭据不可用 → 启动期失败，不空号池空转
  rules.init(); store.open();                  // 与一期 boot() 同一装配序（不含 server.start）
  store.startCheckpointTimer();
  const srv = await gatewayPipe.serve({
    token: hs.token, pipePath: hs.pipePath,           // pipePath 由主进程命名并经握手投递（两端必须同一个值）
    // 两条内建命令不属于那 43 条，故不进 preload 白名单；gateway_echo 供认领双检验 token，
    // gateway_shutdown 供 Task 7 互锁。其余一律交给网关自己的命令表。
    dispatch: (cmd, args) =>
      cmd === "gateway_echo" ? { v: String((args && args.v) || "") }
      : cmd === "gateway_shutdown" ? proxy.gracefulShutdown().then(() => ({ ok: true }))
      : proxy.dispatch(cmd, args),
  });
  // sink 必须在 srv 建好之后注入（否则子进程启动早期 events.emit 无处可写）——这是装配序，不是风格
  proxy.attachGatewayMode({ emit: (payload) => srv.broadcast({ k: "evt", payload }) });
  fs.writeFileSync(path.join(store.proxyDir(), "gateway.json"), JSON.stringify({
    pid: process.pid, pipe: srv.pipePath, token: hs.token, port: 0,
    version: util.appVersion(), startedAt: Date.now(), secretBackend: secretbox.backend(),
  }, null, 2), "utf8");
  startWatchdog(hs.parentPid, srv);
  await srv.ready;                             // 主进程连上后才算 ready
}

/** 版本比对与回收都在**主进程**侧（见 Step 3 的 start()）：子进程不知道自己是不是"上一版留下的"。
 *  顺序必须是「先停旧、确认端口释放、再起新」：反序会 EADDRINUSE。
 *  代价是打断在途 SSE —— 只在主 App 启动时发现 version ≠ util.appVersion() 才发生，
 *  与 Task 7 的装更互锁共用同一条 stopAndWait 实现，不开第二条口子。 */

// 看门狗：父进程没了且 persistent=off → 自行退出，避免孤儿进程占着 9527。
// 同时监视 exe 映像：卸载/升级会删掉安装目录，届时留着进程只会锁文件（实测 portable stub 也是 RMDir /r）。
function startWatchdog(parentPid, srv) {
  const t = setInterval(() => {
    let parentAlive = true;
    try { process.kill(parentPid, 0); } catch (e) { parentAlive = e.code !== "ESRCH"; }
    if (!parentAlive && !persistent) { gracefulExit("parent-exit"); return; }
    if (!fs.existsSync(process.execPath)) { gracefulExit("exe-gone"); }
  }, 5000);
  if (t.unref) t.unref();
}
function gracefulExit(reason) {
  if (persistent && server.status().running) {                 // 常驻形态：父进程没了正是设计目标，不退出
    log.line("detach-keep", { reason, port: server.status().port });
    return;                                                    // 但必须停掉对父进程的轮询，别每 5s 刷日志
  }
  log.line("exit", { reason });
  proxy.gracefulShutdown();          // 本任务定义（见 Step 4），Task 7 的 gateway_shutdown 命令体复用同一个函数
  if (srvRef) srvRef.close();        // srvRef = main() 里存下来的模块内引用；不要用 gatewayPipe.closeAll()（无此 API）
  setTimeout(() => process.exit(0), 300).unref();
}
main().catch((e) => { log.line("fatal", { message: String(e && e.message || e) }); process.exit(1); });
```

> 上面有几处**跨任务才成立**的标识符，落笔时按此序补齐，别留在空中：① `rules` 与 `server` 在文件头各自 `require("./backend/proxy/rules.cjs")` / `require("./backend/proxy/server.cjs")`（`gracefulExit` 读 `server.status()`）；② `persistent` 必须是 `main()` 里把 `hs.persistent` 存进模块内 `let persistent = false;`（看门狗与 `gracefulExit` 都读它）；③ `srvRef` 同理由 `main()` 赋值；④ `proxy.gracefulShutdown()` 在 Step 4 定义并被 `gateway_shutdown` 命令体复用（Task 7 的装更路径调的就是那条命令），不是 Task 7 才出现的函数；`versionMismatch()` 的调用点在主进程 `start()`（本任务 Step 3）。Step 7 的断言专门咬 ①②③ 这三处装配序。

- [ ] **Step 3: `gateway-client.cjs` 的 spawn 与认领双检**

```js
/** 启动或认领网关子进程。返回 { ok, claimed, pid, port, message }。 */
async function start({ persistent } = {}) {
  const cur = readGatewayFile();
  if (cur && (await probeAlive(cur))) {
    if (cur.version !== util.appVersion()) {
      // 版本不匹配（升级后 exe 路径可能已失效，尤其便携版 %TEMP% 解压目录）：先停旧再起新。
      // 反序新进程会 EADDRINUSE（规格 §5.5）。代价是打断在途 SSE，只在启动时发现一次。
      const r = await stopAndWait({ timeoutMs: 5000 });
      logLine("reclaim-restart", { from: cur.version, to: util.appVersion(), stopped: r.stopped, portFreed: r.portFreed });
    } else {
      state = { ...cur, claimed: true, alive: true, connected: true };
      return { ok: true, claimed: true, pid: cur.pid, port: cur.port };
    }
  }
  if (cur && cur.pid) await reap(cur);                  // 陈旧 pid 复用 / 被任务管理器杀：先回收
  const token = crypto.randomBytes(24).toString("hex");
  const pipePath = `\\\\.\\pipe\\agenthub-gw-${process.pid}-${Date.now().toString(36)}`;
  // Windows named pipe 名字里的 `\\?\pipe\` 前缀是允许的等价形式，这里统一用 `\\.\pipe\`。
  const child = spawn(process.execPath, [gatewayScriptPath()], {
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1", AGENT_SKILLS_HOME: process.env.AGENT_SKILLS_HOME || "" }),
    cwd: path.dirname(process.execPath), stdio: ["pipe", "pipe", "pipe"], detached: !!persistent,
  });
  child.stdin.write(encode({ token, parentPid: process.pid, persistent: !!persistent, pipePath }) + "\n");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => log.line("child-stderr", { text: String(d).slice(0, 400) }));   // 子进程崩因必须留痕，否则只剩"起不来"
  child.on("exit", (code, signal) => { state.alive = false; onChildExit({ code, signal }); });
  const c = await gatewayPipe.connect({ pipePath, token, timeoutMs: 8000 }).catch((e) => null);
  if (!c) {
    try { child.kill(); } catch { /* 已退 */ }
    return { ok: false, claimed: false, message: "子进程未在 8s 内建立管道（exe 可能被锁或权限不足）" };
  }
  state = { pid: child.pid, pipe: pipePath, token, port: 0, version: util.appVersion(), startedAt: Date.now(), claimed: false, alive: true, connected: true };
  return { ok: true, claimed: false, pid: child.pid, port: 0 };
}

/** 双检：kill(pid,0) 只证明 pid 活着，pid 复用会骗过它 → 必须再连一次管道并验 hello/token。 */
async function probeAlive(cur) {
  try { process.kill(cur.pid, 0); } catch { return false; }
  const c = await gatewayPipe.connect({ pipePath: cur.pipe, token: cur.token, timeoutMs: 1500 }).catch(() => null);
  if (!c) return false;
  const r = await c.call("gateway_echo", { v: cur.token.slice(0, 8) }, { timeoutMs: 1500 }).catch(() => null);
  c.close();
  return !!(r && r.v === cur.token.slice(0, 8));
}
```

`gatewayEcho` 是子进程侧唯一新增的内建命令（`gateway_echo` / `gateway_shutdown`），不属于那 43 条，故 `preload` 白名单不动。spawn 失败（exe 被锁 / 权限）→ 返回 `{ ok:false, message }`，Task 5 的错误态负责把它显式报给用户，**不得让网关页卡在「检测中」**（规格 §七.1）。

- [ ] **Step 4: `index.cjs` 的角色开关 + `events.cjs` 的 sink 注入**

`events.cjs`：

```js
let sink = null;                      // 主进程=广播窗口；子进程=写管道
function setSink(fn) { sink = fn; }
function emit(payload) {
  if (sink) { sink({ event: "proxy", ...payload }); return; }
  if (!electronWindows) return;
  /* 原 getAllWindows 分支保留（一期语义） */
}
module.exports = { emit, setSink };
```

`index.cjs` 新增两个导出（`attachGatewayMode` / `dispatch`），实现就是计划里说好的**鸭子类型 collector**——`register(ipcMain)` 的结构零改：

```js
/** 子进程侧：把 register() 的 ipcMain 换成收集器，43 条命令名与实现体一字不动地复用。
 *  为什么这样而不是重构出 COMMANDS 表：那是 290 行的重排，会掩盖「二期只改出口、不改命令语义」这个契约，
 *  且 Task 5 的逐字相等闸（dev-gateway-forward-parity-test）就没法拿旧注册当基线。 */
function dispatchTable() {
  const cmds = {};
  register({ handle: (name, fn) => { cmds[name] = fn; } });
  return cmds;
}
async function dispatch(cmd, args) {
  const cmds = dispatchTable();
  const fn = cmds[cmd];
  if (!fn) throw new Error("未知命令: " + cmd);
  return fn({ sender: { send() {} } }, args || {});   // _event 全仓 43 条都不使用（已逐条核）
}
function attachGatewayMode({ emit }) {
  events.setSink(emit);                          // 事件出口换成管道广播（emit 由 gateway.cjs 给）
  // 同时把 boot() 里「按 restoreOnLaunch 自动 listen」那段拿掉：监听决策归主进程（Task 6 的新语义）。
  // 另注：dispatchTable() 首次构建后缓存进模块内 `let TABLE`，每条命令重建一次是纯浪费。
}
```

> 这里**不许**出现 `delete require.cache[...]` 那类清缓存写法：它只会掩盖装配序问题（`dispatchTable` 与 `attachGatewayMode` 的先后）。真实实现只做两件事——`events.setSink(emit)`，以及把 `boot()`（`index.cjs:163-175`）里「按 `restoreOnLaunch` 自动 listen」那段**拿掉**。`dispatchTable()` 复用 `register()`：`register` 内部只是 43 次 `ipcMain.handle(name, handle(fn))`，喂它一个 `{ handle(name, fn) }` 收集器就得到同名表，290 行注册体一字不动（见 §偏差 D6）。

`main.cjs:378` 的 `proxy.boot()` 改为 `gatewayClient.start({ persistent: cfg.schedule.persistentGateway })`，并 `gatewayClient.onEvent(...)` 扇出。**本任务不动 `restoreOnLaunch` 的语义**（仍是「记住上次退出时网关开没开」）：语义重定义连同注释与文案一起在 Task 6 一次改完，避免两个任务各改一半（扫描裁决 T5↔T6）。

同一步把 `index.cjs:177-182` 的 `shutdown()` 升级为子进程侧唯一的优雅停机实现并导出（Task 7 的 `gateway_shutdown` 命令体复用它，不开第二份）：

```js
/** 与一期 shutdown() 的两处差别：① server.stop() 换成 await server.stopAsync()——
 *     stop()（server.cjs:701-710）连监听释放都不等，跨进程场景下 NSIS 要的是映像解锁 + 端口释放；
 *  ② 追加 store.close()（内含 checkpoint），一期这两个函数都是"定义了没人调"（全仓 grep store.close 零命中）。 */
async function gracefulShutdown() {
  credits.stopScheduler();
  stopCheckinAuto();
  discovery.cancelOAuth();
  await server.stopAsync();
  store.close();
  return { ok: true };
}
```

- [ ] **Step 5: 最小日志落盘**

`electron/backend/gateway-log.cjs`：`proxyDir()/logs/gateway.log`，超 2 MB 轮转保留 1 份旧档（`gateway.log.1`），追加式，写失败静默（日志不能反过来搞死网关）。`index.cjs:163` 与 `store.cjs:27` 那句「logs 在 proxyDir」的注释现在成真——同时更新注释指向该文件。

- [ ] **Step 6: liveness 与 readiness 拆分**

`server.cjs:653-657`：

```js
// /healthz = liveness：进程活着且能应答就 200（监督器据此重启的依据只能是它，
// 用它判健康会对空号池打重启循环——这是一期评审点出的现状缺陷）。
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true, version: util.appVersion(), uptime: ... }));
// /readyz = readiness：号池有可用号 且 没有凭据解密失败
app.get("/readyz", (_req, res) => {
  const credFail = store.decryptFailureCount() > 0;
  const healthy = store.CHANNELS.some((c) => pool.poolSummary(c.id).onlineCount > 0);
  res.status(healthy ? 200 : 503).json({ ok: healthy, credFail, detail: credFail ? "凭据解密失败" : "号池无可用账号" });
});
```

Run 前先 `grep -rn "healthz" src/ electron/ tools/ scripts/` 把既有引用点全部列出，改文案的那几处（网关页展示、curl 示例）跟着改到 `/readyz` 或保留 `/healthz` 但语义标注清楚；这一步的清单要进报告。

同一步顺手改 `server.cjs:695-697` 的 EADDRINUSE 文案（规格 §七.5）：`server.cjs:686` 的 `already` 只判本进程 `runtime`，跨进程无感知，所以端口被**已常驻的网关**占着时会误报「端口已被占用，请更换端口」。改为：先 `probeAlive(gateway.json)` 判定占用者是不是常驻网关，是则回 `{ ok:true, claimed:true, message:"已接管后台常驻网关" }`，否则保持原文案。Task 6 认领路径依赖这条不报错。

- [ ] **Step 7: 测试（本任务范围内）**

`scripts/dev-gateway-pipe-test.cjs` 先落这四组（Task 4 再补协议组）：

1. `start()` 之后 `gateway.json` 存在、字段齐、`pid` 真活着；**且第二次 `start()` 返回 `claimed:true` 且 pid 不变**（「重开认领不起第二个进程」的机器可核形式）。
2. 把 `gateway.json` 的 pid 改成自己的 pid（模拟 pid 复用）→ `probeAlive` 必须因为 token 不匹配返回 false（**这条是双检的真正价值，只测 kill(pid,0) 测不出来**）。
3. 父进程退出：spawn 一个中间人脚本当父进程，父退出后 5 s 内子进程自杀；`persistent=true` 分支必须**不**自杀。
4. `/healthz` 在空号池下 200、`/readyz` 同状态 503（拆语义生效），且 `credFail` 在人为写入坏密文时为 true。

Run: `node scripts/dev-gateway-pipe-test.cjs` → 全跑在临时 userData + 非 9527 端口 + `AGENT_SKILLS_HOME` 临时目录上；收尾核对 HKCU Run 未变、`%APPDATA%\AgentHub\proxy\stats.db` 的 `MAX(id)` 未增长。

- [ ] **Step 8: 提交**

```bash
git add electron/gateway.cjs electron/backend/gateway-client.cjs electron/backend/gateway-proto.cjs electron/backend/gateway-log.cjs electron/backend/proxy/events.cjs electron/backend/proxy/index.cjs electron/backend/proxy/server.cjs electron/main.cjs scripts/dev-gateway-pipe-test.cjs
git commit -m "feat: 网关子进程生命周期基座（握手/认领双检/看门狗/日志、healthz 与 readyz 拆语义）"
```

---

### Task 4: 命令通道（配对 / 事件回流 / 超时 / 有界队列 / 不重放）

**Files:**
- Create: `electron/backend/gateway-pipe.cjs`
- Modify: `scripts/dev-gateway-pipe-test.cjs`
- Test: 同上

**Interfaces:**
- Consumes: Task 3 的 proto 常量
- Produces: `serve({ token, dispatch, pipePath })` → `{ pipePath, ready, close(), broadcast(frame) }`；`connect({ pipePath, token, timeoutMs })` → `{ call(cmd, args, opts), onEvent(cb), close() }`；两端 `call` 语义一致（`{}` 或 reject）

- [ ] **Step 1: 补测试（先红）**

追加到 `dev-gateway-pipe-test.cjs`，五条：

1. **配对**：并发打 30 个 `proxy_status` + 5 个 `gateway_echo`，断言每个 `res.id` 唯一且与自身 `req.id` 一致（乱序返回时 `server.cjs` 的 `uptime` 必须单调不减，证明没串号）。
2. **事件回流**：`proxy_credits_refresh` 触发后，`onEvent` 收到 `{type:"credits"}`（`credits.cjs:128` 的调用点），且**响应帧先到、事件帧后到**也照常投递。
3. **超时**：注入一个挂 12 s 的假命令，`call` 必须在 10 s 报 `timeout`；`NO_TIMEOUT_CMDS` 里的三条不受此限（用 `proxy_checkin_run` 的桩验）。
4. **队列有界**：同时压 200 条，断言第 `MAX_PENDING+1` 条**立刻**被拒（`message` 含「队列已满」），子进程 `process.memoryUsage().rss` 增长 < 20 MB。
5. **不重放**：连接中断后 `call("proxy_pool")` 不得自动重试（`NON_IDEMPOTENT_READS` 的实测依据：`pool.poolAccounts` 会 `store.updateAccount` 回写派生复活，`pool.cjs:19-24`）。断言方式：让服务端对 `proxy_pool` 只回一次并记录调用次数，客户端断连重连后总数仍为 1。

- [ ] **Step 2: 实现 `serve` / `connect`**

要点（逐条对应断言，写进注释）：

```js
// serve：net.createServer 在 named pipe path 上，一条连接一个 socket，允许多连接（认领 + 重连）。
//   首帧必须是 { k:"hello", token }，不匹配立即 destroy（token 只从 stdin 来，不在 argv/进程列表里）。
//   溢出：单帧超 MAX_FRAME_BYTES 直接断开并记日志，绝不截断解析。
// connect：socket.on("error"/"close") 时把 pending 全部 reject（不静默悬挂），
//   reject 的错误带 .notRetried 标记，指向 NON_IDEMPOTENT_READS 的原因。
// 事件：服务端 broadcast 一条 { k:"evt", payload }，客户端 onEvent 只收 evt，req/res 靠 id 分流。
// 不实现任何自动重试：二期没有"幂等表"，重放的语义风险大于收益（见测试 5）。
```

- [ ] **Step 3: 跑到通过 + 性能回归**

Run: `node scripts/dev-gateway-pipe-test.cjs`
Run: `node scripts/dev-gateway-pipe-test.cjs --bench`（脚本内建）：Expected: `proxy_pool` 单次往返中位数 **< 30 ms**（全量号池×4 渠道经 JSON 的实际成本；超过 30 ms 就把归因写进报告，别顺手加缓存——`proxy_pool` 带写副作用）。同时记「无窗期一次真补全」的 TTFT 与一期基线（3.19 s / 3.0 s）对比，跨进程只应加个位数毫秒。

- [ ] **Step 4: 提交**

```bash
git add electron/backend/gateway-pipe.cjs scripts/dev-gateway-pipe-test.cjs
git commit -m "feat: named pipe 命令通道（id 配对、事件回流、10s 超时、有界队列、不重放）"
```

---

### Task 5: 43 条命令转发化 + 归属修正 + UI 错误态

**Files:**
- Modify: `electron/backend/gateway-client.cjs`（`register(ipcMain)`）、`electron/backend/proxy/index.cjs`（`:244-253` `rememberRunning` 撤出、`oauth_begin` 改事件驱动、`account_import_file` 拆两段）、`electron/backend/ipc.cjs:18/474/176`、`electron/backend/proxy/ccswitch.cjs:342-344`、`src/views/proxy/ProxyHomeView.vue`（错误态）
- Test: `scripts/dev-gateway-forward-parity-test.cjs`

**Interfaces:**
- Consumes: Task 4 的 `call` / `onEvent`
- Produces: 主进程侧 `proxy_*` 行为不变；`ipc.cjs` 与 `main.cjs` 都不再 `require` proxy 域（`stats.db` 独占由此达成）

**归属最终定案（比规格 §5.7 的「4 条」精确，且带实测计数）**：
- **留主进程 4 条真 UI 依赖**：`proxy_account_import_file`（`:410` 文件框）、`proxy_open_rules_dir`（`:516`）、`proxy_open_data_dir`（`:520`）、`proxy_oauth_begin`（`:381` 的 `shell.openExternal`）。
- **留主进程 3 条薄包装**：`proxy_start` / `proxy_stop` / `proxy_restart`（`:258/:264/:271`）——转发给子进程，成功后**由主进程**写 `config.json` 的 `restoreOnLaunch`（`rememberRunning` 从 `index.cjs:244-253` 移到 `gateway-client.cjs`，子进程永不写 `config.json`）。
- **规格漏判的 2 条现可转发**：`proxy_status`、`proxy_vault_status`——它们的 electron 依赖是 `vaultOk()`，Task 1 已把它换成 `secretbox.backend()`。规格 §5.7 写「4 条」，实测归类是 6 条；差异根因是 §5.3 已把 safeStorage 列为阻塞项却没同步归属表（记进 §偏差 D1）。
- **另 34 条纯转发**；`proxy_pool` 的「读带写」特性原样保留（不做缓存/重放）。
- **`oauth_begin` 的形状**：子进程创建 OAuth 会话后推 `evt { type:"oauth-open", url }`，主进程收到才 `shell.openExternal(url)`；主进程的 `proxy_oauth_begin` 命令体只做转发并回传子进程结果。旧实现是子进程内直接开浏览器——下沉后拿不到 `shell`。
- **`account_import_file` 拆两段**：主进程 `dialog.showOpenDialog` + `fs.readFileSync` → 把 zip 字节 base64 过管道交给新子命令 `proxy_account_import_blob`（子进程里 `zip.readZip` + `importAccounts`，即现 `:412-432` 的主体）。不这么拆的话，文件选择框要么留在主进程读完后无处入池，要么让子进程弹框（纯 Node 弹不了）。
- **`ipc.cjs:176` 反向跨界写**（规格未提、实测发现）：主进程的 `webdav_shared_save` 现在直接 `require("./proxy/poolsync.cjs").onSharedPasswordMaybeChanged()`，那是从主进程写子进程独占的 `sync-state.json`。改为 `gatewayClient.call("proxy_poolsync_password_changed", {})`（新增子命令，内部就是原函数），并**删掉 `ipc.cjs:18` 的 `require("./proxy/index.cjs")` 与 `:474` 的 `proxy.register(ipcMain)`**——否则 `ipc.cjs:18` 一条 require 就把整张依赖图（含 `store.cjs`）重新拉进主进程，§5.4 的第一条就白做。
- **`ccswitch.cjs:342-344`**：端口回落从 `config.loadConfig().proxy.port` 改为 `server.status().port || 9527`（子进程内可直接读 `server`），否则注册进 CC Switch 的 `base_url` 指向死端口。

- [ ] **Step 1: 写逐字相等闸（先红）**

`scripts/dev-gateway-forward-parity-test.cjs`：

```js
// 三个来源的代理命令名必须逐字相等，少一条就是渲染层拿到「未授权的 IPC 命令」或界面假死（AGENTS.md 第四节）
//   ① preload.cjs 的 ALLOWED_COMMANDS 里 proxy_* 全集
//   ② 一期基线：git show main:electron/backend/proxy/index.cjs 里的 43 个 ipcMain.handle 名
//   ③ 当前实现：主进程实际注册的命令名（gateway-client.register 的转发面 + 4 条 UI + 3 条薄包装）
//   ④ 子进程 dispatchTable() 的键集
// 断言：①==②==③ 且 ④ ⊇ ②（子进程可以有多出来的 gateway_* 内建命令，但不得少任何 proxy_*）
```

Run: `node scripts/dev-gateway-forward-parity-test.cjs` → Expected: FAIL（`ipc.cjs` 仍直连注册、④ 缺 `proxy_account_import_blob`）。

- [ ] **Step 2: `gateway-client.register(ipcMain)` 的三段实现**

```js
const UI_LOCAL = ["proxy_account_import_file", "proxy_open_rules_dir", "proxy_open_data_dir", "proxy_oauth_begin"];
const RUN_WRITE = { proxy_start: true, proxy_stop: true, proxy_restart: true };
function register(ipcMain) {
  for (const cmd of ALL_PROXY_CMDS) {
    ipcMain.handle(cmd, async (_e, args) => {
      if (!state.connected) {
        const r = await start({ persistent: persistentFlag() });
        if (!r.ok) return { ok: false, message: "后台网关未能启动：" + r.message };  // 不得假死，显式错误
      }
      const res = await call(cmd, args);
      if (RUN_WRITE[cmd] && res && res.ok) rememberRunning(cmd !== "proxy_stop");   // config.json 主进程写
      return res;
    });
  }
  // UI_LOCAL 四条各自保留真实实现（dialog/shell），其中 import_file 读字节后转 proxy_account_import_blob
}
```

- [ ] **Step 3: 渲染层错误态（规格 §七.1）**

`ProxyHomeView.vue` 的 5 s 轮询里：`ok:false` 且 message 含「后台网关未能启动」时，卡片显示错误态 + 「重试启动」按钮，**不得停在「检测中」**。

- [ ] **Step 4: 端到端转发验证 + 依赖图归零**

Run: `node scripts/dev-gateway-forward-parity-test.cjs` → `OK 代理命令名四处逐字相等`
Run: `grep -c "ipcMain.handle(\"proxy_" electron/backend/ipc.cjs electron/backend/proxy/index.cjs` → 主进程侧两条路径的注册数之和 = 43 且 `ipc.cjs` 为 0。
Run: `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron.exe tools/proxy-smoke.cjs "$(mktemp -d)"` → `SMOKE OK`。
真机：`npm run dev` + 带 `--remote-debugging-port=0` 起 Electron，CDP 走一遍网关 6 个页面（号池 / 模型目录 / Key / 用量 / 生态接入 / 设置），逐条断言 `proxy_pool` 有数据、`proxy_keys_list` 返回明文 Key、`proxy_stats_detail` 分页 ≤100 行、`proxy_ccswitch_register` 写的 `base_url` 端口 = **实际监听端口**（拿副本库 `CCSWITCH_DB_PATH` 验，不动真实 `~/.cc-switch`）。

- [ ] **Step 5: 提交**

```bash
git add electron/backend/gateway-client.cjs electron/backend/proxy/index.cjs electron/backend/ipc.cjs electron/backend/proxy/ccswitch.cjs src/views/proxy/ProxyHomeView.vue scripts/dev-gateway-forward-parity-test.cjs
git commit -m "refactor: 43 条代理命令改走管道，config 写权与端口回落归主进程/子进程各自正确侧"
```

---

### Task 6: 常驻语义（`persistentGateway` + `restoreOnLaunch` 重定义 + 启动器 + 便携版禁用）

**Files:**
- Modify: `electron/backend/config.cjs:122-131`（`schedule` 默认值）、`:396-403`（`applyAutoStart`）、`src/components/config/ConfigGeneralSection.vue:294-304`、`package.json`（`build.extraFiles`）
- Create: `build/gateway-launcher.cmd`
- Test: `scripts/dev-gateway-launcher-test.cjs`

**Interfaces:**
- Consumes: Task 3 的 `start({persistent})`、Task 5 的注册链
- Produces: `schedule.persistentGateway: false` 默认值；启动器脚本契约（安装根目录 `agenthub-gateway.cmd`，同目录 exe，`ELECTRON_RUN_AS_NODE=1`）

- [ ] **Step 1: 语义重定义（规格 §六 要求实现前同时落到文案与注释）**

`restoreOnLaunch` 新定义 = **本次启动时，是否让（新建或认领来的）子进程进入监听状态**；不再是「上次退出时网关开没改」。`persistentGateway=true` 时 detach 出去的是「监听中」这个状态，主 App 下次启动认领回来即可。代码形态：子进程启动**不 listen**，主进程 `start()` 之后按 `restoreOnLaunch` 决定发一次 `proxy_start` 还是只 `proxy_status`。注释同时改在 `config.cjs:140` 与 `index.cjs` 原 `boot()` 位置（现在那段已撤）。

- [ ] **Step 2: 写失败的测试**

`scripts/dev-gateway-launcher-test.cjs`：① 启动器内容断言（`set ELECTRON_RUN_AS_NODE=1`、指向同目录 `AgentHub.exe`、参数路径含 `app.asar/electron/gateway.cjs`、无绝对硬编码盘符）；② 便携版拒常驻：`isPortable()` 为真时 `start({persistent:true})` 返回 `{ok:true, persistent:false, message:"便携版不支持后台常驻"}` 且**不落 Run 项**；③ `applyAutoStart` 的目标随 `persistentGateway` 切换（off → 主 App exe，on → `.cmd`），用 mock 的 `setLoginItemSettings` 断言入参，**不许真改本机注册表**。Expected 首跑 FAIL。

- [ ] **Step 3: 启动器与打包接线**

`build/gateway-launcher.cmd`（`@echo off` + `%~dp0` 相对定位，不硬编码路径）：

```bat
@echo off
rem AgentHub 网关常驻启动器：开机自启时只拉网关，不拉主 App、不建窗。
setlocal
set ELECTRON_RUN_AS_NODE=1
"%~dp0AgentHub.exe" "%~dp0resources\app.asar\electron\gateway.cjs" --persistent
endlocal
```

`package.json` 的 `build` 段加 `"extraFiles": [{ "from": "build/gateway-launcher.cmd", "to": "agenthub-gateway.cmd" }]`——**不是 `extraResources`**，Task 6 的产物断言要同时证明 `extraResources`（`resources/sqlcipher`）一字未动。

**`--persistent` 的装配分支必须在本步一起改 `electron/gateway.cjs`**（扫描修正 P4：Task 3 的 `main()` 第一行就是 `await readHandshake()`，而自启路径没有父进程写 stdin，照原样会永久挂在读 stdin 上）：

```js
const argvPersistent = process.argv.includes("--persistent");
// 自启路径：没有父进程投递 stdin 握手，token 由子进程自己生成并写进 gateway.json（§偏差 D4），
// 主 App 之后从文件认领；pipePath 也自造。两条路径必须共用同一个 srv/看门狗装配，不复制一份。
const hs = argvPersistent
  ? { token: crypto.randomBytes(24).toString("hex"), parentPid: 0, persistent: true, pipePath: null, tokenSource: "file" }
  : await readHandshake();
```

`parentPid: 0` 时看门狗跳过父进程探测（否则 `kill(0,0)` 语义不定），只保留 `exe-gone` 那条；`gateway.json` 多写一个 `tokenSource` 字段，Task 8 的报告据此区分两种来历。`dev-gateway-launcher-test.cjs` 的断言 ① 同时要求：`--persistent` 且 stdin 永不关闭的情况下，`gateway.json` 在 8 s 内出现且 `pipe` 字段可连通（这就是 P4 的守门断言）。

- [ ] **Step 4: UI 与默认值**

`schedule.persistentGateway: false`；设置页在 `liteOnClose`/`launchHidden` 同组加一行，副标题明写：「主 App 退出后网关继续常驻（便携版不支持；开机自启需在上方打开）」；`isPortable` 为真时灰置（复用 `ConfigGeneralSection.vue` 里既有的 `get_is_portable` 判定链，注意 `updater.cjs:33-43` 那份在纯 Node 恒 false，主进程侧可用）。

- [ ] **Step 5: 真机验证（安装版，非便携）**

`npm run electron:pack` 后：开 `persistentGateway` → 启动网关 → 从托盘菜单「退出」→ 断言 9527（或测试端口）**仍 LISTEN 且进程树里只剩 1 个 AgentHub.exe**；再双击安装版图标 → 断言 `dev-gateway-pipe-test` 的 `claimed:true` 且 pid 未变。收尾核对 HKCU Run 值目标确为 `agenthub-gateway.cmd`。杀进程只杀自己起的那棵树。

- [ ] **Step 6: 提交**

```bash
git add build/gateway-launcher.cmd package.json electron/backend/config.cjs src/components/config/ConfigGeneralSection.vue scripts/dev-gateway-launcher-test.cjs
git commit -m "feat: persistentGateway 常驻 + restoreOnLaunch 语义下沉到监听层 + 网关开机自启启动器"
```

---

### Task 7: 更新 / 卸载互锁

**Files:**
- Modify: `electron/main.cjs:399-416`（两条退出路径）、`electron/backend/ipc.cjs:120`（`install_update` 短路）、`electron/backend/updater.cjs:270-289`
- Test: `scripts/dev-gateway-interlock-test.cjs`

**Interfaces:**
- Consumes: Task 3 的 `stopAndWait({ timeoutMs })`
- Produces: 一个退出口 `quitForInstall()`，三条入口共用；`stopAndWait` 的「映像解锁 + 端口释放」双条件

- [ ] **Step 1: 测试（先红）**

`dev-gateway-interlock-test.cjs`：① `stopAndWait` 在子进程 listen 状态下返回 `{stopped:true, portFreed:true}`，且端口释放是**实测 connect 失败**而不是 `close()` 回调；② 子进程赖着不走（桩里吞掉 `gateway_shutdown`）时 `stopAndWait` 在 `timeoutMs` 到点后**强杀**并返回 `{stopped:true, forced:true}`；③ `before-quit` 的三条入口（`:407` 装更、`:415` 普通退出、`ipc.cjs:120` 短路）都**必须**经过 `stopAndWait`——静态断言：`grep -n "proxy.shutdown()" electron/main.cjs` 零命中，且三条路径的源码里都出现 `quitForInstall`/`stopAndWait`。Expected 首跑 FAIL。

- [ ] **Step 2: 退出形状改造**

`before-quit` 保持同步，用「拦下 → 异步停 → 续跑」：

```js
app.on("before-quit", (e) => {
  const wantInstall = updater.pendingInstall() || pendingInstallRequested;
  if (installPhase !== "stopped" && (wantInstall || !quitting)) {
    e.preventDefault();
    if (installPhase === "idle") {
      installPhase = "stopping";
      scheduler.stop(); usageScheduler.stop(); watch.stop();
      gatewayClient.stopAndWait({ timeoutMs: 5000 }).then((r) => {
        installPhase = "stopped";
        if (!r.portFreed) { notifyUser("网关端口未释放，安装可能失败：" + r.message); }  // 报错而不是静默卡住（§5.6）
        if (wantInstall) updater.triggerInstall(); else app.quit();
      });
    }
    return;
  }
  // 已 stopped 的续跑路径（第二次 before-quit 才会走到这里）：只做与网关无关的收尾
  quitting = true;
  scheduler.stop(); usageScheduler.stop(); watch.stop();   // 原 main.cjs:412-414 三行保持
});
```

`proxy.shutdown()` 的残留语义（停 scheduler、取消 OAuth、`server.stopAsync()` + `store.close()`）**已在 Task 3 Step 4 定成 `proxy.gracefulShutdown()`**，本任务只做接线：子进程内建命令 `gateway_shutdown` 的命令体 = `() => proxy.gracefulShutdown()`，主进程 `stopAndWait` = 发该命令 → 等 socket 关闭 → 实测 connect 端口失败。**必须走 `stopAsync` 而不是 `stop()`**（`server.cjs:701-710` 连监听释放都不等；`updater.cjs:275` 的 `quitAndInstall(true, true)` 保持不 await，但它的**入口**现在一定排在 `stopAndWait` 之后）。

- [ ] **Step 3: 卸载面**

子进程的 `exe-gone` 看门狗（Task 3 Step 2 已实现）是唯一可用的卸载保护：NSIS 卸载器不会向子进程发消息。断言方式：把 `gateway.cjs` 跑在一个临时目录里当"exe"，`fs.rmSync` 掉那个目录 → 5 s 内进程自杀。

- [ ] **Step 4: 真机验证**

安装版 → 开网关 → 设置 · 软件更新里点「安装」（若无新版，用 `updater.cjs` 的 `pendingInstall` 桩走同一分支）→ 断言：安装前 9527 无 LISTEN、安装成功、装后版本正确、`gateway.json` 被新进程重写且 `version` 匹配。这条要真跑（用户已授权 GUI 自动化；跑之前明确告知会重启他机器上的安装版应用）。

- [ ] **Step 5: 提交**

```bash
git add electron/main.cjs electron/backend/updater.cjs electron/backend/ipc.cjs electron/backend/gateway-client.cjs scripts/dev-gateway-interlock-test.cjs
git commit -m "fix: 装更与退出先停干净网关子进程并确认端口释放，停不下来显式报错"
```

---

### Task 8: 二期验收（内存矩阵 + 一期未达项归因）

**Files:**
- Test: `tmp/gateway-probe/phase2-acceptance.md`（报告，不入库）
- Modify: `docs/superpowers/specs/2026-09-21-gateway-lite-mode-design.md`（数字回写真值）

- [ ] **Step 1: 判据先写死再量**

一期继承的靶子：无窗常驻从 **215.47 MB** 进 **150–200 MB**，靶子是 main 的 **126.84 MB**。二期验收判据写成三条，且**先声明失败也是合格产出**（不得为了过门改判据；改判据必须像 D7 那样单独提交并归因）：
1. 关窗后（`persistentGateway=off`）：main 单列 **≤60 MB**（网关 express + 两个 SQLite + rules 热路径搬走之后），总进程数 3。
2. 常驻 detach 后：只剩 1 个 `AgentHub.exe`，私有内存 **≤80 MB**，`/healthz` 200、`/readyz` 按号池真值。
3. 一轮完整逐页导航后 main 不再单调上涨：一期观测到 **121.32 → 147.10 MB** 这个单点必须变成 8 样本序列，并给出结论（会不会继续爬）。
4. WAL 停止单调增长：`store.walBytes()` 在 30 分钟额度刷新 + 50 次请求后 **< 64 KB**。

- [ ] **Step 2: 探针先升级到 `tools/` 再用于验收**

一期四个探针脚本（`phase1-browser-pass.cjs`、`cascade-verify2.cjs`、`run-human-checks4.cjs`、`tray-reopen-watch.cjs`）**四个一起**从 gitignored 的 `tmp/gateway-probe/` 提到 `tools/`（只提 `.cjs` 会留下对 `memtree.ps1` 的悬空引用），并在一处集中中和 `AGENT_SKILLS_HOME` 与 `applyAutoStart(false)` 两个副作用（规格 §八 那条要求，一期只做到了「每次手写」）。**同时**：清理脚本的 kill 参数为空必须等价于「只列不杀」（一期实测踩过：`if ($p -ne '')` 在 `$null` 时为真，`-like '*'` 杀掉了当时全部实例）。

- [ ] **Step 3: 跑矩阵并出报告**

矩阵：安装版/便携版 × `persistentGateway` on/off × 升级装更，每格记 `PrivateMemorySize64` 逐进程 + `netstat` 归属 pid + WAL 字节。便携版那一格必须真跑（`PORTABLE_EXECUTABLE_DIR` 的实际值与解压目录删除行为，一期只能从 `node_modules/app-builder-lib/templates/nsis/portable.nsi:38/77/90` 源码推，属未测）。

- [ ] **Step 4: 规格回写**

`§一` 表里那行 **33.2 MB 是探针值**，必须换成实测终态并标注；§5.7 的「4 条」改成 Task 5 的定案；§5.4 的 `config.cjs:370` → `:372` 且同病四处一起列；§5.6 的 `main.cjs:362-373` → `:399-416`；§八 探针卫生加「中立 cwd」第五条；`vaultOk()` 相关的 §5.3/§5.7 自相矛盾按 Task 5 定案闭合。

- [ ] **Step 5: 提交**

```bash
git add tools/ electron/ scripts/ docs/superpowers/specs/2026-09-21-gateway-lite-mode-design.md
git commit -m "test: 二期内存矩阵与探针升级，规格数字回写实测真值"
```

---

### Task 9: 一期遗留清扫

**Files:**
- Modify: `electron/backend/usage-scheduler.cjs:99-101`、`electron/main.cjs:328`、`src/components/sync/SkillsHelpDialog.vue`/`.disclaimer-dialog` 样式、`scripts/dev-bundle-check.cjs`
- Test: 各自既有脚本内新增断言

**四条，每条自己带证据**：
1. `usage-scheduler.cjs:99-101` 与 `watch.cjs` 同构的 `stop()` 缺陷（一期评审判为「二期处理」）：`stop()` 只清 timer，正挂着的那拍照样能落地写库。用一期 `dev-watch-test.cjs` 断言 6 的同一形状补一条。
2. `main.cjs:328` 的 `second-instance` 忽略 argv（规格 §九 点名二期认领需要时补）：现在认领不需要 argv，但 `--gateway-start` 这类从托盘/命令行拉起网关的入口需要。**决定：本期只补 argv 解析与一条日志，不加新入口**，理由写进注释。
3. `.disclaimer-dialog` 内容 1109 px > 视口 779 px 时顶对齐，「我已知晓」要滚动才点到（一期实现者发现、判为既有）。改为内容超高时 `max-height: calc(100vh - 64px)` + 内部滚动。
4. `dev-bundle-check.cjs` 加 `--check` 漂移闸：把当前 entry/CSS 字节数写进 `scripts/.bundle-baseline.json`，门槛之外若与基线漂移 >5% 则报「先核对是否有意」（一期评审点名项）。
5. 规格 §九 挂给二期的 echarts 声明：`devDependencies` 里写 `^5.4.3` 而实装 5.6.0。**本期定案：把下限改成 `^5.6.0` 并跑一次 `npm ls echarts` + `npm run build`**，理由是一期已实测「`^5.4.3` 与 5.6.0 的按需安装集完全相同」，改下限不动解析结果、只让声明与实装一致；若 `npm ls` 显示解析变了，回退并记录原因，不硬改。
6. 规格 §六 那条字段关系（`liteOnClose` 仅在 `minimizeToTray=true` 时有意义，否则关窗就是退出、销毁与否无从谈起）**一期未见落地证据**：先在 `ConfigGeneralSection.vue` 里查实——若已灰置，只把证据行号记进报告；若没有，补 `:disabled` + 一行说明文案。不要重复实现已存在的东西。

- [ ] **Step 1**: 四条各自「先改测试到红 → 改实现到绿」，分四个提交，commit 前缀 `fix:` / `test:` 按内容。
- [ ] **Step 2**: 全部跑完后 `npm run build` + 五个 `dev-*-test` + `tools/proxy-smoke.cjs` + 四个二期 `dev-gateway-*-test` 一起绿的完整输出留在报告里。

---

## 完成定义

Task 0-9 全部提交；本期新增的**六道闸**（`dev-gateway-node-load-test` / `dev-secretbox-test` / `dev-write-ownership-test` / `dev-gateway-pipe-test` / `dev-gateway-forward-parity-test` / `dev-gateway-interlock-test`，另加 Task 6 的 `dev-gateway-launcher-test` 共七道）与既有六门（`npm run build` + `dev-watch-test` + `dev-config-lite-defaults-test` + `dev-ccswitch-test` + `dev-sse-delta-test` + `tools/proxy-smoke.cjs`）全绿；Task 8 的内存矩阵给出**实测数字与归因**（未达标也是合格产出，须写清哪部分驻留回收不动、为什么）；`persistentGateway` 与 `restoreOnLaunch` 的新语义同时落在代码注释、设置页文案与规格 §六；主进程 `grep` 证明不再 require proxy 域（`stats.db` 单一写者）；装更路径在真机验证过「先停子进程 + 端口确认释放」。达成后再决定合并与是否还有三期（把 `launchHidden` 与常驻合并成单一「轻量模式」入口的 UI 收敛不在本计划范围）。

## 偏差与裁决（执行时逐条回写，不留空白）

- **D1 规格 §5.7「留主进程 4 条」实测是 6 条**：`proxy_status`(`index.cjs:257`→`vaultOk():233-235`) 与 `proxy_vault_status`(`:524`) 都读 `safeStorage`。§5.3 早已把 safeStorage 列为阻塞项，两处自相矛盾。裁决：Task 1 把 `vaultOk()` 换成 `secretbox.backend()` 后这 2 条回到可转发，Task 5 的归属表按「4 UI + 3 薄包装 + 36 纯转发 + 1 新增子命令 `proxy_account_import_blob`」定案。
- **D2 `ipc.cjs:176` 的反向跨界写规格未提**：主进程 `webdav_shared_save` 直接调 `poolsync.onSharedPasswordMaybeChanged()`，写的是二期子进程独占的 `sync-state.json`。裁决：新增子命令 `proxy_poolsync_password_changed` 走管道（Task 5）。留着双写者等于把 §5.4 的第一条从后门漏掉。
- **D3 明文闸门的适用范围收窄到打包态**：规格 §5.3 说「无加密能力则拒写并抛错」。若在开发态也硬拒，`tools/proxy-smoke.cjs` 与既有纯 Node 自测全部红（它们无 `Local State` 也无 safeStorage）。裁决：`backend()` 四级里 `plain-dev` 只在非打包态可用（打包判据用 `__dirname.includes("app.asar")`，因为子进程没有 `app.isPackaged`），闸门在 `none` 才抛。**代价**：开发态仍能把明文 token 写进临时库——这正是既有行为，未变坏；若哪天开发机误判为打包态，表现为拒写而非泄密，方向安全。
- **D4 自启路径的 token 例外**：`.cmd` 无法注入 stdin token，故自启模式下 token 由子进程生成并写进 `gateway.json`（文件读取权限即用户级边界，与 §5.2 的暴露面论证同一条）。裁决：接受，并在 `gateway-client` 认领日志里标出 `tokenSource:"file"`，与 `tokenSource:"stdin"` 区分，便于事后归因。
- **D5 探针中立 cwd 是新增强制项**：实测在仓库目录里 `require("electron")` 返回 devDependency 的 exe 路径字符串，会让「electron 不可得」类断言假绿。裁决：写进 Global Constraints 第五条，Task 0/1 的测试脚本内置 `cwd 污染` 自证断言。
- **D6 `dispatchTable()` 用鸭子 collector 而非重构命令表**：规格 §5.2 说「实现体换成 `gw.call`」，读起来像要把 `register()` 拆成表。裁决：不拆。`register({handle})` 收集器零 diff 复用 290 行注册体，且让 Task 5 的逐字相等闸能拿 `git show main:...` 当基线。若评审坚持显式表，代价是二期 diff 膨胀且失去基线对比。
