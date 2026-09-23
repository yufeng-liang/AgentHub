// 三期 Task 3 闸：WAL 收敛的可证伪化（留痕 + 一条**预期先红**的收敛判据）。
//
// 背景（二期结尾留下的未解缺陷）：常驻网关子进程的 stats.db-wal 长到 **1,388,472 B 后冻结不收敛**，
// 两条早期假设都已被否证，成因不明。三期的既定顺序是**先让这件事可观测、再取证、再修**，顺序不可反。
// 本闸就是那个「可观测」的落地 + 一条把缺陷变成可证伪命题的判据。
//
// ⚠ 本闸的 ② 在原计划里是「**预期先红**」（简报 Step 4 据此备了 detach 第二腿）。
//   实测（2026-09-23，本机）**与预期相反**：对照腿 Leg B（非常驻真子进程）、**判定腿 Leg B′**（detached +
//   --persistent + Electron 运行时）、Leg A（进程内）**三条腿全绿**，二期那种 1,388,472 B 冻结**没有复现**。
//   真正的冻结由 **Leg C 的负对照**造出：子进程**外部**持一条读事务不放时，
//   `wal_checkpoint(TRUNCATE)` 变成 **ok:true 但 after===before**（跑了但没截动），
//   与二期「t+3→t+30min 恒定不动」的观测**同形**。Leg C 的判据因此写成「**必须红**」：
//   它不参与 ② 的绿红，只证明 ② 有牙（一条从不曾红过的判据无法区分「缺陷不存在」与「判据没牙」）。
//   这条差异（绿的是闸、红的是负对照）是 Task 3 交给 Task 4 的核心证据，详见 task-3-report.md。
//
// ===== 判定腿的选择（简报补充 S1，全局最关键的一条）=====
// S1 的整个论点：**判定腿必须选在「出缺陷的那个装配」里**。简报正文的断言片段写成
// 「闸进程内 require store.cjs 直调 checkpoint()/walBytes()」。**这个形态会骗人**：
// 二期那条 30 秒微探针**正是**纯 Node 进程内跑 `open() → insertUsage() → checkpoint() → walBytes()`，
// 结果是**收敛成功**（1,388,472 B → 0）；而同一个代码路径在**真常驻子进程**里却冻结不收敛。
// ⇒ 进程内腿在出缺陷的那个装配里没测，今天极可能直接绿，**绿得毫无意义**。
// 二期冻结的现场是「**常驻**（脱离父进程、`--persistent` 自启路径、Electron 运行时）+ 装配后父进程消失」。
// 按 S1 的原意，判定腿就应当**逐项对齐到这个形态**，即 Leg B′。所以本闸的绿红由 Leg B′ 决定：
//   · **Leg B′（判定腿，有决定权）**：按生产启动器形态拉起常驻网关（同一 Electron exe +
//     `ELECTRON_RUN_AS_NODE=1` + `--persistent` + `detached`，cwd = exe 所在目录），对它自己监听的
//     端口打真 HTTP，再从**子进程外部**观测收敛。它才是「出缺陷的那个装配」，`②` 的绿红只由它给。
//   · **Leg B（对照腿，无决定权）**：`gw.start({persistent:false})` 的真子进程——**非** detached、
//     走 stdin 握手路径，与二期缺陷形态**不同装配**。它的结论仍如实输出（若 B 红而 B′ 绿或反之，
//     那个差异本身是证据），只是不再决定 `②` 的绿红。
//     （上一轮把它当判定腿是写歪了：S1 要的是「装配最贴近缺陷现场的那条腿」判定，不是「先写好的那条」。）
//   · **Leg A（附加信息，无决定权）**：另起一个**独立沙箱**的纯 Node 进程做进程内直调对照。
//     为什么另起进程而不是在闸进程内直接 require：本闸与子进程共用一份 APPDATA，闸进程再开一个 store
//     连接就是对**同一个 stats.db 的第二条连接**——它会成为 WAL 的读者/写者，把子进程那条 TRUNCATE
//     挡出 SQLITE_BUSY，于是 ② 会因为「闸自己污染了被测对象」而红，红得没有归因价值。
//     独立沙箱 + 独立进程 = 进程内形态（与二期微探针同形）且零干扰。
//     若 Leg A 绿而判定腿红，**那本身就是本任务要找的第一手证据**：把 Task 4 的搜索面从
//     「checkpoint 机制」收窄到「常驻装配下的差异」。
// 外部观测三面并用（S1 允许三选一，这里三条都留证据、互为佐证）：
//   (i)   stat 子进程沙箱 APPDATA 下的 `AgentHub/proxy/stats.db-wal`（本闸知道这个路径）
//   (ii)  读子进程 `logs/gateway.log` 的 `wal-checkpoint` 行（Task 3 的留痕产物）
//   (iii) 经管道调 `proxy_status` 读 Task 3 新增的 `walBytes` / `lastCheckpoint`
//
// ===== 诚实代价（评审对 §七-1 的补充，写在这里免得后来人误读本闸）=====
// 本闸实测四条腿全绿、二期那种冻结**今天不可复现**（详见 task-3-report.md）。所以要说清：
// **这条 ② 对原缺陷的防护力 ≈ 0** —— 它守不住那个 1,388,472 B 冻结（那个状态复现不出来，闸自然拦不住它
// 回来）。它当前的价值只有两条：**可观测面**（留痕出口 + 首尾采样，以后出问题能看见）与
// **交给 Task 4 的最小冻结构造**（Leg C：外部持读事务 ⇒ `ok:true` 且 `after===before`）。
// 不要把它读成「二期那个冻结已经有闸守着了」。
//
// ===== ② 的触发时机（简报补充 S2：二选一，本闸选 (乙)）=====
// 真子进程里**没有**「手动触发一次 checkpoint」的命令面（`store.checkpoint()` 只有 `close()` 与周期
// 计时器两个调用方，已核实），而 `CHECKPOINT_MS = 5 * 60 * 1000` 会让本闸跑 5.5 分钟以上。
// 选 **(乙)**：`store.cjs` 加一个**默认值不变的**间隔覆盖缝 `AGENTHUB_CHECKPOINT_MS`（文件注释里标明
// 它是测试缝、生产默认值一字未动），本闸用 `AGENTHUB_CHECKPOINT_MS=30000` 起子进程。
// 代价：这是一处**新增生产代码**，已按 D-P3 在提交说明与本文件留归因。
// 明确**没有**做的事：没有改小 `CHECKPOINT_MS` 的生产默认值（那是改被测对象的参数 = 改判据）。
// 为什么是 30 s 而不是 5 s：间隔必须**长于整段写入耗时**，否则 tick 会在写入中途落下，
// 「checkpoint 前的 WAL」就不再是确定量（本闸要的是「全部写入完成后落下的那一次 tick」）。
//
// ===== 夹具为什么要加码（简报 50 条的实况修正）=====
// 简报 Step 1 的 ② 是「打 50 条失败请求 → 一次 checkpoint 后必须 ≤64KB」。它的判据方向是对的，但
// 「50 条就够」这个量**没被核过**：若 WAL 压根没被撑过 64 KB，那条断言就是恒真的空断言（夹具失效）。
// 所以本闸把 50 条当**第一段**（如实记录 w50），随后按需加码直到 WAL **确实超过 64 KB** 才做判定，
// 并把加码过程与实测字节数原样留进证据（判据非空 = 有判别力）。加码段数有上界，超界即报夹具失效。
//
// 卫生约束（AGENTS.md 与探针三件套，硬要求）：
//  · APPDATA / AGENT_SKILLS_HOME / CCSWITCH_DB_PATH 在任何产品代码 require 之前指进临时目录；
//  · 端口 **19532**（本闸专属归属，钉死在此）：19530/31 归 pipe 闸、19534-19538 归 pipe 闸各用例、
//    19541/42/43 归 interlock 闸，9527 归用户自己那台实例，一律不碰；
//  · 只杀自己 spawn 的进程（句柄记录 + finally 兜底），绝不按进程名宽匹配；
//  · 收尾对真实库只**只读记录**（`fs.statSync` 的 size@mtime，`-wal` 与主库都不断言 —— 主库由用户实例
//    每 300 s 写回，见 `realStatsSnapshot()` 注释），另有 HKCU Run 快照一条**有牙断言**（我们自己的副作用面）；
//    并有一条结构性判据断言本闸源码里没有对真实库的开库调用。
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BE = path.join(ROOT, "electron", "backend");

// ===== 隔离：必须早于任何产品代码的 require =====
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-walconv-"));
const SANDBOX = path.join(work, "appdata-child");     // Leg B 子进程的沙箱（本闸与它共用）
const LEGA_APPDATA = path.join(work, "appdata-lega"); // Leg A 独立沙箱（绝不让两条腿碰同一份库）
const DETACH_APPDATA = path.join(work, "appdata-detach"); // Leg B′ 独立沙箱（常驻形态，另一份 gateway.json）
const LOCK_APPDATA = path.join(work, "appdata-lock");     // Leg C 独立沙箱（负对照：外部持读事务）
const PORT = 19532;                                   // Leg B（非常驻真子进程）专属（见文件头端口归属）
const DETACH_PORT = 19539;                            // Leg B′（常驻/脱离父进程）专属，同样 1953x
const LOCK_PORT = 19540;                              // Leg C（负对照）专属，同样 1953x
/** 判据的绝对值门槛（规格 §5.4 的 64 KB）：两条腿共用，改一处两腿同步 */
const TARGET = 64 * 1024;
const REAL_APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
process.env.APPDATA = SANDBOX;
process.env.AGENT_SKILLS_HOME = path.join(work, "hub");
process.env.CCSWITCH_DB_PATH = path.join(work, "ccswitch.db");
// 测试缝（S2 选 (乙)）：把周期 checkpoint 的间隔压到 30 s。默认值生产不变，本行只作用于本闸起的子进程。
process.env.AGENTHUB_CHECKPOINT_MS = "30000";
fs.mkdirSync(SANDBOX, { recursive: true });
fs.mkdirSync(LEGA_APPDATA, { recursive: true });

// 产品代码一律在此之后 require
const gw = require(path.join(BE, "gateway-client.cjs"));

// 整闸硬超时：宁可红也不要让跑门禁的人干等（红/挂死时保留临时目录供排查）。30 s 间隔 + 写入 + 收尾，
// 正常 ~60 s 内结束；给足余量但仍远比 420 s 的邻居闸紧。
setTimeout(() => { console.log("FAIL 本闸 180 s 未跑完。临时目录保留供排查：" + work); process.exit(1); }, 180000).unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let steps = 0;
const pass = (msg) => { steps++; console.log(`  ${String(steps).padStart(2)}. ${msg}`); };
const note = (msg) => console.log(`     · ${msg}`);

/** 本次跑起来的所有子进程句柄（清理只按这份名单，绝不按进程名宽匹配） */
const running = new Set();
const knownPids = new Set();
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}
function cleanupOwnProcesses() {
  for (const h of running) { try { h.kill(); } catch { /* 已退 */ } }
  const deadline = Date.now() + 5000;
  for (const pid of knownPids) {
    while (alive(pid) && Date.now() < deadline) sleep(50);
    if (alive(pid)) { try { process.kill(pid); } catch { /* 已退 */ } }
  }
}

// ===== 三条外部观测面（Leg B 的证据来源）=====
const proxyDirOf = (appdata) => path.join(appdata, "AgentHub", "proxy");
const walFileOf = (appdata) => path.join(proxyDirOf(appdata), "stats.db-wal");
const logFileOf = (appdata) => path.join(proxyDirOf(appdata), "logs", "gateway.log");

/** 外部观测 (i)：stat 子进程沙箱里的 -wal（闸知道这个路径，不需要进子进程问） */
function statWal(appdata) {
  try { const st = fs.statSync(walFileOf(appdata)); return { bytes: st.size, mtimeMs: st.mtimeMs }; }
  catch { return { bytes: 0, mtimeMs: 0 }; }
}

/** 外部观测 (ii)：子进程日志里全部 wal-checkpoint 行的**原文**（Task 3 的留痕产物）。
 *  Task 4 分支 (c) 的判别证据就在这里：**有行=计时器真跑了；无行=压根没跑/两份 store**。 */
function readCheckpointLines(appdata) {
  let text = "";
  try { text = fs.readFileSync(logFileOf(appdata), "utf8"); } catch { return []; }
  // 排除 `wal-checkpoint-override`（它字面上含 ` wal-checkpoint` 前缀）：两类行必须分开计数，
  // 否则「tick 行数」会被自证告警行污染，证据块里也会同一条行出现两次。
  return text.split(/\r?\n/).filter((l) => l.includes(" wal-checkpoint") && !l.includes(" wal-checkpoint-override"));
}

/** 把一条 `wal-checkpoint {json}` 日志行解析成 {ok,before,after,err,ms}（解析失败回 null，不假装） */
function parseCheckpointLine(line) {
  const i = line.indexOf("wal-checkpoint");
  if (i < 0) return null;
  const j = line.indexOf("{", i);
  if (j < 0) return null;
  try {
    const o = JSON.parse(line.slice(j));
    return { raw: line, ok: o.ok, before: o.before, after: o.after, err: o.err, ms: o.ms };
  } catch { return null; }
}

/** 读取 `wal-checkpoint-override` 告警留痕行（F3 自证：覆盖生效时才该出现）。
 *  用 indexOf 而不是正则：行里含 `wal-checkpoint` 前缀，必须是**精确的 override 行**，
 *  不能把普通 tick 行误算进来（否则这条判据恒真 = 空断言）。 */
function readOverrideLines(appdata) {
  let text = "";
  try { text = fs.readFileSync(logFileOf(appdata), "utf8"); } catch { return []; }
  return text.split(/\r?\n/).filter((l) => l.includes(" wal-checkpoint-override"));
}

/** 外部观测 (iii)：经管道读子进程的 proxy_status（Task 3 新增的 walBytes / lastCheckpoint 两个出口） */
async function readProxyStatus() {
  const st = await gw.call("proxy_status", {});
  return st && typeof st === "object" ? st : null;
}

const HAS = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const shapec = (lc) => (lc && typeof lc.ok === "boolean" && typeof lc.before === "number"
  && typeof lc.after === "number" && typeof lc.err === "string");

// ===== Leg A 夹具：进程内直调（与二期那条「收敛成功」的微探针同形），**独立沙箱、独立进程** =====
// 它只能作附加信息：二期已实证这个形态会报「收敛成功」，而缺陷只出现在真常驻装配里。
const LEGA_SRC = `"use strict";
const path = require("node:path");
const be = process.argv[2];
const rows = Number(process.argv[3]);
const store = require(path.join(be, "proxy", "store.cjs"));
store.open();
for (let i = 0; i < rows; i++) {
  store.insertUsage({
    reqId: "lega-" + i, keyName: "k", channel: "trae", accountName: "a", model: "claude-x",
    promptTokens: 12, completionTokens: 34, latencyMs: 5, status: 401,
  });
}
const before = store.walBytes();
store.checkpoint();
const after = store.walBytes();
const lc = store.lastCheckpoint();
console.log("LEGA driver=" + store.driver() + " rows=" + rows + " before=" + before + " after=" + after
  + " ok=" + (lc && lc.ok) + " lcBefore=" + (lc && lc.before) + " lcAfter=" + (lc && lc.after)
  + " err=" + JSON.stringify(lc && lc.err));
`;

/** 起一个跑临时夹具的子进程（cwd=work 中立目录；stdout/stderr 全量收集，进度不截断） */
function spawnFixture(scriptFile, args, env) {
  let child = null;
  const done = new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(work, scriptFile), ...args], {
      cwd: work, env: Object.assign({}, process.env, env), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    knownPids.add(child.pid);
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("exit", (code, signal) => { running.delete(h); resolve({ code, signal, out, err }); });
  });
  const h = { done, kill: () => { try { child && child.kill("SIGKILL"); } catch { /* 已经退了 */ } } };
  running.add(h);
  return h;
}

// ===== Leg B · 真 HTTP 夹具 =====
// 为什么用**无效 Key**（401）而不是「空号池 + 有效 Key」：两者都写一条非 200 流水行，但前者不需要
// 先在库里造出一把 Key（少一步写库、少一处夹具自身扰动 WAL 的机会），判据等价而夹具更瘦。
// 401 分支在 server.cjs:234 就走 record()，即「真写了库」，这点由 wPre>0 直接坐实。
let httpN = 0;
async function postChat(i) {
  const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer sk-invalid-fixture-key" },
    body: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "wal-" + i }] }),
  });
  httpN++;
  return r.status;
}

/** HKCU Run 只读快照（本闸不该碰自启项，首尾比对兜底） */
function runKeySnapshot() {
  try {
    return execSync("reg query \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\"", { encoding: "utf8" });
  } catch { return ""; }
}

/** 真实 stats.db / -wal 的 size@mtime（只 stat，**绝不开库**：给用户在跑的实例添句柄本身就是副作用）。
 *
 *  ⚠ 主库与 `-wal` **都只如实记录、都不断言**（round 3 更正）——两者理由同源：真实 `%APPDATA%\AgentHub`
 *  下的库由**用户自己那台实例**写，本闸不该、也无权把那件事判成失败。
 *   · `-wal`：本机实测 60 s 内自 576832 → 580952 B 单调变化（round 2 已按此降为只记录）。
 *   · **主库**：round 2 曾对主库做「首尾一致」断言，那是**间歇假红**。控制器独立取证（只读采样真实
 *     `stats.db` 的 size@mtime，跨一个整拍）：
 *       `23:50:02.017644200  946176 B`
 *       `23:55:02.017793100  958464 B`   ← 差值恰 **300.000 s**，size 也变了
 *     即用户实例每 **300 s 整拍**做一次 checkpoint，把 WAL 帧写回主库。本闸整段跑 ~2.5 min，
 *     跨过整拍的概率约一半 ⇒ 那条断言必然间歇红，且红的是「用户在用应用」这件正常事，不是隔离失败。
 *
 *  「我们不写真实库」这件事的保证**不在**上面这条会随用户使用而红的断言里，而在**构造**里：
 *  本闸对真实库**只做 `fs.statSync`、从不开库**（见文件头卫生约束与下一句声明），
 *  所以「零写入」是由代码形状决定的，不是抽样抽出来的。round 3 另加一条**结构性判据**
 *  （③ 段的 `assertNoRealDbOpenInSource`）把这条构造从注释升级为可证伪的断言。 */
function realStatsSnapshot() {
  const f = path.join(REAL_APPDATA, "AgentHub", "proxy", "stats.db");
  const snap = (p) => { try { const s = fs.statSync(p); return s.size + "@" + Math.round(s.mtimeMs); } catch { return "missing"; } };
  return snap(f);
}

/** 真实 -wal 的当前值（只记录，不断言——见 realStatsSnapshot 的注释） */
function realWalBytes() {
  try { return fs.statSync(path.join(REAL_APPDATA, "AgentHub", "proxy", "stats.db-wal")).size; } catch { return -1; }
}

/** ===== 结构性判据（round 3 新增）：本闸源码里**不存在**对真实库的开库调用 =====
 *  为什么要有它（brief H1 第 5 点）：主库断言降级为「只记录」之后，「我们不写真实库」这件事就只剩
 *  **构造**在保证（本闸对真实库只 `fs.statSync`）。构造是解释，不是证据；把主库那条运行时抽样断言删掉
 *  会让这条保证在闸里**无面可查**。所以这里把构造本身写成断言：读自己的源码，断言没有任何
 *  `new DatabaseSync(` / `open(` 落在 `REAL_APPDATA` 的表达面上——同仓 `dev-gateway-forward-parity-test.cjs`
 *  读 preload 源码断言白名单是同一手法（把「我们没做」从抽样升级为结构）。
 *
 *  实现要点（免得后来人改坏）：
 *   · **先剥注释**（行注释 + 块注释）：本文件的注释里大量出现 `open()`、`DatabaseSync` 这些字样，
 *     把它们算进来会把判据变成恒假红（brief 明确提醒过滤注释行）。
 *   · 每个**调用点**取「向前 160 字符 + 向后 300 字符」的窗口判 REAL_APPDATA，覆盖跨行写法
 *     （`path.join(\n  REAL_APPDATA, …`）——只按单行判会漏。
 *   · **负对照**（有牙的证明）：剥完注释后必须仍**找得到**调用点。若某天 API 改名或文件被整体重写，
 *     匹配面清零，这条判据就会变成恒真的空断言 —— 那时必须报红要求改闸，而不是静悄悄通过。
 *     所以这里下一条 `sites.length > 0` 的下界断言（当前实测命中 2 处：Leg A 夹具字符串里的
 *     `store.open()` 与 Leg C 的 `new DatabaseSync(LOCK_APPDATA…`，两处都在沙箱内）。
 *     该下界断言**跑得过不算证据**：round 3 实测把它反向后判据变红（见提交说明），确认它有牙。 */
function stripComments(src) {
  // 顺序不能反：先块注释再行注释（行注释里可能出现 `/*` 字样，反之亦然）
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
/** 调用点识别（**针必须拼开**）：本函数自己的源码里一旦出现完整的针字面量，判据会**自我命中**
 *  （实测踩到：它读自己、又在自己身上匹配到 `…DatabaseSync(` 与 `REAL_APPDATA` ⇒ 恒假红）。
 *  所以针由片段拼出，本文件里任何地方都不出现完整针。 */
const DB_CTOR = "Database" + "Sync";
const OPEN_FN = "o" + "pen";
const SITES_RE = new RegExp(
  "new\\s+" + DB_CTOR + "\\s*\\(|\\.\\s*" + OPEN_FN + "\\s*\\(|\\b" + OPEN_FN + "Sync\\s*\\(", "g");
const REAL_TOKEN = "REAL" + "_APPDATA";
/** 返回剥注释后所有「开库调用点」的 {line, window, text}；真实库面由调用方判 */
function dbOpenCallSites(src) {
  const code = stripComments(src);
  const out = [];
  SITES_RE.lastIndex = 0;
  let m;
  while ((m = SITES_RE.exec(code)) !== null) {
    const start = Math.max(0, m.index - 160);
    out.push({
      line: code.slice(0, m.index).split("\n").length,
      window: code.slice(start, m.index + 300),
      text: m[0].trim(),
    });
  }
  return out;
}
/** 结构性判据本体：无调用点落在真实库上（且匹配面非空 = 判据有牙） */
function assertNoRealDbOpenInSource() {
  const self = path.join(__dirname, path.basename(__filename));
  const sites = dbOpenCallSites(fs.readFileSync(self, "utf8"));
  assert.ok(sites.length > 0,
    "③ 结构判据失效（匹配面为空 = 空断言）：本闸源码剥掉注释后一个开库调用点都找不到 —— "
    + "要么 API 改名了，要么文件被重写，请改这条判据本身，不要让它静悄悄恒真");
  // 下界必须**钉在构造器这根针上**，不能只钉总数：Leg A 夹具字符串里还有一处 `.open(`，
  // 单看总数的话，即使构造器那根针整个改名消失，总数仍 >0 ⇒ 下界恒真（弱化）。所以这里再要求
  // 「至少命中一处构造器形态」，让「针本身改名/消失」也当场报红（改判据，不许静悄悄恒真）。
  const ctorRe = new RegExp("new\\s+" + DB_CTOR + "\\s*\\(");
  assert.ok(sites.some((s) => ctorRe.test(s.text)),
    "③ 结构判据失效（构造器这根针没命中 = 空断言）：剥注释后找不到任何 `new " + DB_CTOR + "(` 形态，"
    + "说明被测对象换了开库 API（或本文件被重写）—— 请同步改本条判据的针，不要让它恒真通过");
  const onReal = sites.filter((s) => s.window.includes(REAL_TOKEN));
  assert.strictEqual(onReal.length, 0,
    "③ 结构判据失败：本闸源码里有开库调用落在真实 %APPDATA% 的表达面上（本闸对真实库只许 fs.statSync）：\n"
    + onReal.map((s) => "  :" + s.line + "  " + s.text).join("\n"));
  return sites;
}

/** Leg B′ 夹具：按**生产启动器**的形态拉起网关常驻子进程，并让它开始监听。
 *  与 gateway-launcher.cmd 逐项对齐：同一 exe（Electron）、ELECTRON_RUN_AS_NODE=1、--persistent、
 *  detached（脱离本闸的 Job Object，等价开机自启那条孤儿路径）、cwd = exe 所在目录（中立目录）。
 *  为什么不用 gw.start()：gw.start() 是**非** detached 的（见 gateway-client.cjs:161 的 detached:!!persistent），
 *  而本腿要的正是「脱离父进程」那一支；且自启路径没有父进程投递 stdin 握手，走不到 gw.start()。 */
const DETACH_SRC = `"use strict";
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const exe = process.argv[2];              // Electron 二进制（生产就是 AgentHub.exe）
const gatewayScript = process.argv[3];    // gateway.cjs 的绝对路径
const reportFile = process.argv[4];
const port = Number(process.argv[5]);
// 端口写进**本腿自己的**沙箱 config.json（子进程接 proxy_start 时读它）
const appdata = process.env.APPDATA;
fs.mkdirSync(path.join(appdata, "AgentHub"), { recursive: true });
fs.writeFileSync(path.join(appdata, "AgentHub", "config.json"), JSON.stringify({ proxy: { port } }), "utf8");
const child = spawn(exe, [gatewayScript, "--persistent"], {
  env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }),
  cwd: path.dirname(exe),
  // stdio 全 ignore：拉起器立刻退出，若还挂着管道，子进程后续 console 输出会撞 EPIPE/写满阻塞。
  // 本形态（--persistent 自启路径）不读 stdin，网关自己的日志走 gateway-log 落盘，不依赖这三个口。
  stdio: ["ignore", "ignore", "ignore"], detached: true, windowsHide: true,
});
child.unref();                            // 与父脱钩：本腿要的就是「父没了它还活着」这条生产形态
fs.writeFileSync(reportFile, JSON.stringify({ pid: child.pid }), "utf8");
console.log("DETACHED gatewayPid=" + child.pid);
process.exit(0);
`;

/** 经认证管道让网关开始监听（不依赖 gw 模块的内存连接：本腿用的是 detached 子进程） */
async function callViaPipe(cmd, args) {
  const rec = JSON.parse(fs.readFileSync(path.join(proxyDirOf(DETACH_APPDATA), "gateway.json"), "utf8"));
  const gatewayPipe = require(path.join(BE, "gateway-pipe.cjs"));
  const c = await gatewayPipe.connect({ pipePath: rec.pipe, token: rec.token, timeoutMs: 10000 });
  try { return await c.call(cmd, args || {}, { timeoutMs: 15000 }); }
  finally { try { c.close(); } catch { /* 已断 */ } }
}

/** Leg B′：生产常驻形态下重放同一段写入，再从子进程外部看它收不收敛。
 *  返回 {wBeforeCk, wAfterTick, ckLines, ckLine, converged, gatewayPid}。 */
async function runDetachLeg() {
  fs.mkdirSync(path.join(DETACH_APPDATA, "AgentHub"), { recursive: true });
  const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
  assert.ok(fs.existsSync(exe), "Leg B′ 前置失败：找不到 Electron 二进制 " + exe + "（生产形态就是它跑的）");

  const h = spawnFixture("detach-launch.cjs", [exe, path.join(ROOT, "electron", "gateway.cjs"),
    path.join(work, "detach-report.json"), String(DETACH_PORT)], {
    APPDATA: DETACH_APPDATA, AGENT_SKILLS_HOME: path.join(work, "hub-detach"),
    CCSWITCH_DB_PATH: path.join(work, "ccswitch-detach.db"),
  });
  const led = await h.done;
  assert.strictEqual(led.code, 0, "Leg B′ 拉起器非零退出：\n" + led.out + led.err);
  const md = /DETACHED gatewayPid=(\d+)/.exec(led.out);
  assert.ok(md, "Leg B′ 没拿到 DETACHED 行：\n" + led.out + led.err);
  const gatewayPid = Number(md[1]);
  knownPids.add(gatewayPid);
  assert.ok(alive(gatewayPid), "Leg B′ 前置失败：常驻子进程 " + gatewayPid + " 没活着");

  // 等它把 gateway.json 落盘（listen 之前不变式：管道连得上 ⇒ 握手文件已在盘上）
  const recFile = path.join(proxyDirOf(DETACH_APPDATA), "gateway.json");
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(recFile) && Date.now() < deadline) await sleep(100);
  assert.ok(fs.existsSync(recFile), "Leg B′ 30 s 内没落 gateway.json（常驻子进程没起来）：" + recFile);
  const rec = JSON.parse(fs.readFileSync(recFile, "utf8"));
  assert.strictEqual(gatewayPid, Number(rec.pid), "Leg B′ gateway.json 的 pid 与拉起的不一致（认领到别人的进程？）");

  const s = await callViaPipe("proxy_start", {});
  assert.ok(s && s.ok, "Leg B′ proxy_start 失败：" + JSON.stringify(s));
  assert.strictEqual(Number(s.port), DETACH_PORT, "Leg B′ 监听端口不是 " + DETACH_PORT + "：" + JSON.stringify(s));

  // 同一段夹具：**先打满 50 条**（与 Leg B 同口径，验证「失败请求真写库」），再按需加码到 >64 KB。
  // 为什么不写成一个 while：Leg B′ 的周期 tick（30 s）可能在写入途中落下并把 WAL 压回 0，
  // 那时 `statWal() <= TARGET` 恒真 → while 会一直转到 1000 上界却永远超不过 64 KB，
  // 表现成「HTTP 0 条」这种自相矛盾的证据（run 3 实测踩到）。拆分后「打满 50 条」是确定的，
  // 加码只在上界内尽力，最终以**实测 wBeforeCk** 为准如实报告（不达标就报夹具失效，不假绿）。
  let n = 0;
  const post = async () => {
    const r = await fetch(`http://127.0.0.1:${DETACH_PORT}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk-invalid-fixture-key" },
      body: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "detach-" + n }] }),
    });
    n++;
    if (r.status === 200) throw new Error("Leg B′ 夹具失效：第 " + n + " 条请求竟然 200（无效 Key 应当 401）");
  };
  for (let i = 0; i < 50; i++) await post();                  // 与 Leg B 同口径的第一段
  const w50d = statWal(DETACH_APPDATA).bytes;
  assert.ok(w50d > 0, `Leg B′ 夹具失效：50 条失败请求后 -wal 为 0，说明本轮没写库`);
  while (statWal(DETACH_APPDATA).bytes <= TARGET && n < 1000) await post();
  const wBeforeCk = statWal(DETACH_APPDATA).bytes;
  note(`Leg B′ 写入：50 条后 -wal=${w50d} B，共 ${n} 条后 checkpoint 前 -wal=${wBeforeCk} B`);

  // 等一次覆盖本轮写入的周期 tick（日志里**新增**的、before>0 的那一行）
  const linesBefore = readCheckpointLines(DETACH_APPDATA).length;
  const waitUntil = Date.now() + 75000;
  let ckLine = null;
  while (Date.now() < waitUntil && !ckLine) {
    const all = readCheckpointLines(DETACH_APPDATA);
    for (let i = linesBefore; i < all.length; i++) {
      const p = parseCheckpointLine(all[i]);
      if (p && p.before > 0) { ckLine = p; break; }
    }
    if (!ckLine) await sleep(500);
  }
  const wAfterTick = statWal(DETACH_APPDATA).bytes;
  const ckLines = readCheckpointLines(DETACH_APPDATA);
  const overrideLines = readOverrideLines(DETACH_APPDATA);

  console.log("\n===== Leg B′ 第一手证据（生产常驻形态：detached + --persistent + Electron 运行时）=====");
  console.log(`拉起：Electron ${exe}`);
  console.log(`gatewayPid=${gatewayPid}（detached，与本闸的 Job 无关）  端口=${DETACH_PORT}  HTTP ${n} 条（全非 200）`);
  console.log("wal-checkpoint 日志行原文：");
  if (ckLines.length) for (const l of ckLines) console.log("    " + l);
  else console.log("    <无 wal-checkpoint 行>");
  console.log("自证留痕（覆盖生效时的告警行，F3）：");
  if (overrideLines.length) for (const l of overrideLines) console.log("    " + l);
  else console.log("    <无 wal-checkpoint-override 行>");
  console.log("外部观测 stat -wal：checkpoint 前 " + wBeforeCk + " B → 后 " + wAfterTick + " B");
  console.log("===========================================================\n");

  // 收尾：经**认证管道**下 gateway_shutdown（唯一出口，绝不按 pid 盲杀）。detached 子进程不在
  // gw 模块的账上，所以这里直连管道——它仍是「经认证、不盲杀」的那条正道。
  const sd = await callViaPipe("gateway_shutdown", {}).catch((e) => ({ __err: String((e && e.message) || e) }));
  const killDeadline = Date.now() + 8000;
  while (alive(gatewayPid) && Date.now() < killDeadline) await sleep(100);
  if (alive(gatewayPid)) { try { process.kill(gatewayPid); } catch { /* 已退 */ } }
  assert.ok(!alive(gatewayPid), "Leg B′ 收尾失败：常驻子进程 " + gatewayPid + " 仍在（会留孤儿）");
  note(`Leg B′ 收尾：gateway_shutdown 应答 ${JSON.stringify(sd)}，pid ${gatewayPid} 已消失`);

  return { wBeforeCk, wAfterTick, ckLines, ckLine, converged: wAfterTick <= TARGET, gatewayPid, httpN: n, overrideLines };
}

/** Leg C（负对照，证「本闸的 ② 有牙」）：在子进程**外部**持一条读事务不放，再等 tick。
 *
 *  为什么非要有这条（本闸的诚实性所系）：Leg B / Leg B′ 都**绿**了，而二期那台真常驻网关是**冻结**的。
 *  一条从不曾红过的判据无法区分「缺陷不存在」与「判据没牙」——正是三期规格 §一 那句「外部不可观测
 *  正是当前缺陷本身」的另一面。所以本腿用一个**能确定造出冻结**的装配当负对照：实验证得
 *  `BEGIN` 持读快照的第二个连接会让 `wal_checkpoint(TRUNCATE)` 变成 **ok:true 但不截断**
 *  （`after === before`）——与二期「恒定不动」的观测**同形**。它同时是 Task 4 决策表
 *  「`ok:true` 但 `after === before` ⇒ 分支 (b)」的**可复现构造**。
 *  实验边界（本机逐条跑过，写进报告）：只有**持读事务**能挡住它；空闲的第二连接、读一次就关、
 *  读密集流量（14250 次 SELECT）、两台网关共库、detached+--persistent+Electron 运行时 —— 全部照常收敛。
 *  这条负对照的红是**预期红**，所以判据写成「必须红」：它不参与 ② 的绿红，只证明 ② 有牙。
 *
 *  ⚠ 写入循环的形状与 Leg B′ 一致（**先固定 50 条、再按需加码**，评审 Concern 2）：本腿同样跑在
 *  `AGENTHUB_CHECKPOINT_MS=30000` 的常驻子进程对面，单个 `while (statWal() <= TARGET && n < 1000)`
 *  有一个**潜在**缺陷：若某次 tick 恰在写入途中落下、把 WAL 压回 0，且此后每轮写入都被后续 tick 截掉，
 *  条件就恒真 ⇒ 转到 1000 上界也超不过 TARGET，于是这条负对照会报「负对照没有冻结」
 *  （假的「本闸造不出冻结」），把「判据没牙」误报成「造不出」。
 *  **就 Leg C 而言，这条推理描述的是一个未被观测到的潜在假红，不是对已发生假红的纠正**（上一轮的真实
 *  数据见下；对照 Leg B′ 则真的踩到过一次这个症状——run 3 的 `HTTP 0 条`，见 runDetachLeg 的注释，
 *  但那与 Leg C 无关，Leg C 从未出现过它）：
 *  上一轮的单 while 得到的 152,472 B 是**真冻结**——`ok:true` 且 `after === before`，判据当时**确实红了**、
 *  也确实有牙。而且它比「撑过了 TARGET」还硬：`TARGET = 65,536` 而 152,472 **大于** TARGET，旧写法
 *  `while (statWal() <= TARGET && …)` 只在 WAL **已超过** TARGET 时才退出 ⇒ 循环能退出这件事本身就是
 *  「WAL 已撑过 TARGET」的证据。上一轮日志把这一点写得更直白——Leg C 打出的是
 *  `写入 0 条后 -wal=152472 B`，即那个 while **一次都没跑就退出**了（进入时 WAL 已 152,472 B >
 *  TARGET），根本不存在「被 tick 压回 0 而超不过」这种事。（同一份日志里 Leg B 自己的沙箱在打请求前
 *  也报 `walBytes=152472`——那是两条腿各自沙箱里的同一个初值，不是同一份 WAL。）
 *  拆分 + `wBeforeCk > TARGET` 守卫因此是**针对上述潜在风险的预防性加固**（避免将来写入慢到跨过 tick
 *  时假报夹具失效），价值在**稳健性**本身，**不是**「修掉了一个假红」——上一轮那个红是真的、有牙的。
 *  加固后冻结点从 152,472 B 变成 1,388,472 B，机制并不神秘：拆分后的**第一段强制打满 50 条**
 *  （不再让 while 去决定要不要写），这一步把 WAL 从 152,472 B 推到 1,388,472 B，冻结于是落在
 *  **与二期实测同量级、同形**的点上——本轮改动的价值在此，不在于「纠正」。
 *  拆分后「打满 50 条」是确定的，加码只负责把 WAL 稳定推到 TARGET 之上；**持读事务在写入全部结束
 *  之后才开**（顺序不能反：先持读就没法把 WAL 撑大）。若加码到上界仍不达标 ⇒ 明确报**夹具失效**
 *  （不是「没冻结」），因为那时连被测形态都没造出来，谈不上判据有没有牙。
 *
 *  未申明的耦合面（一并声明，评审同点提出）：持读的那条连接是闸进程的 `node:sqlite`（系统 node），
 *  被测的是 Electron 内嵌 Node 的 SQLite —— **两个 SQLite 版本共享同一份 WAL 文件**。这是本负对照
 *  成立的前提（跨版本读快照确实挡住了另一版本的 TRUNCATE，本机实测如此），不是本闸引入的独立性；
 *  若将来该闸在别的 node 版本下变绿，要先怀疑这个耦合面而不是直接宣布判据失效。 */
async function runLockedLeg() {
  fs.mkdirSync(path.join(LOCK_APPDATA, "AgentHub"), { recursive: true });
  fs.writeFileSync(path.join(LOCK_APPDATA, "AgentHub", "config.json"),
    JSON.stringify({ proxy: { port: LOCK_PORT } }), "utf8");
  const exe = path.join(ROOT, "node_modules", "electron", "dist", "electron.exe");
  const h = spawnFixture("detach-launch.cjs", [exe, path.join(ROOT, "electron", "gateway.cjs"),
    path.join(work, "lock-report.json"), String(LOCK_PORT)], {
    APPDATA: LOCK_APPDATA, AGENT_SKILLS_HOME: path.join(work, "hub-lock"),
    CCSWITCH_DB_PATH: path.join(work, "ccswitch-lock.db"),
  });
  const led = await h.done;
  assert.strictEqual(led.code, 0, "Leg C 拉起器非零退出：\n" + led.out + led.err);
  const gatewayPid = Number(/DETACHED gatewayPid=(\d+)/.exec(led.out)[1]);
  knownPids.add(gatewayPid);
  const recFile = path.join(proxyDirOf(LOCK_APPDATA), "gateway.json");
  for (let i = 0; i < 300 && !fs.existsSync(recFile); i++) await sleep(100);
  assert.ok(fs.existsSync(recFile), "Leg C 子进程没落 gateway.json");
  const rec = JSON.parse(fs.readFileSync(recFile, "utf8"));
  assert.ok((await callViaPipeOn(LOCK_APPDATA, "proxy_start", {})).ok, "Leg C proxy_start 失败");

  let n = 0;
  const postLock = async () => {
    const r = await fetch(`http://127.0.0.1:${LOCK_PORT}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-bad" },
      body: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "lock" }] }),
    });
    n++;
    if (r.status === 200) throw new Error("Leg C 夹具失效：第 " + n + " 条请求竟然 200（无效 Key 应当 401）");
  };
  // 与 Leg B′ 同款拆分：先固定 50 条（确定把库写起来），再加码到 >TARGET。
  // 为什么不写成一个 while：见 runLockedLeg 的文件头注释（tick 会在写入途中把 WAL 压回 0）。
  for (let i = 0; i < 50; i++) await postLock();
  const w50l = statWal(LOCK_APPDATA).bytes;
  // G3（修复轮 round 2）：**不再对 w50l 下硬断言** —— 它是单次 stat 采样，若那一瞬正好落在周期 tick
  // 把 WAL 截成 0 之后（30 s 间隔、写入段跨过 tick 时就会发生），「-wal 为 0」其实是夹具**正常**工作的
  // 表现，硬断言会假报「夹具失效」。这里改用与 tick 无关的判据：50 条都真打出去了（postLock 对任何 200
  // 直接抛，故循环跑满即 50 条全部非 200）。这条判据**近乎结构性恒真**（能走到这里就必然 n===50），
  // 所以它只是一句廉价前置检查，**真正**的「本轮确实写了库」由下面**更强**的 `wBeforeCk > TARGET`
  // 守卫兜住——WAL 撑过 64 KB 只可能来自真实写入，且那条守卫靠写入循环自己驱动，不受单次采样影响。
  // 未选「短等重采」的理由：重采救不了被 tick 截断的场景（此后没有新写入，再等也回不到 >0），
  // 它只能缩小 torn-read 的窗口，把主要失效模式原样留下；而加大改动的收益又已被上面那条守卫覆盖。
  assert.strictEqual(n, 50, `Leg C 夹具失效：只打出去 ${n} 条（不是 50 条），判据的前提不成立`);
  note(`Leg C 第一段：50 条失败请求已全部打出（全非 200），此刻 -wal=${w50l} B`);
  while (statWal(LOCK_APPDATA).bytes <= TARGET && n < 1000) await postLock();
  const wBeforeCk = statWal(LOCK_APPDATA).bytes;
  // 与 ② 同一道守卫：没造出 >TARGET 的形态 ⇒ 报**夹具失效**，不是「没冻结」。两件事必须分开报，
  // 否则前者的失败会被读成后者，把「判据没牙」误报成「本闸造不出冻结」。
  assert.ok(wBeforeCk > TARGET,
    `Leg C 夹具失效：加码到 ${n} 条后 -wal 仍只有 ${wBeforeCk} B（未超 ${TARGET} B）—— `
    + `负对照的**前提形态**都没造出来，此处的「红」不构成对 ② 有牙的证明，请改夹具。`
    + ` 50 条那一点是 ${w50l} B`);
  note(`Leg C 写入：50 条后 -wal=${w50l} B，共 ${n} 条后 checkpoint 前 -wal=${wBeforeCk} B（> ${TARGET} B）`);
  // 负对照的核心：**外面**开一条连接，BEGIN 后不提交（持读快照）。这是唯一实测能造出冻结的形态。
  // 必须在写入**之后**才持读：先持读的话 TRUNCATE 从第一刻就被挡住，WAL 压根撑不到 TARGET。
  const { DatabaseSync } = require("node:sqlite");
  const db2 = new DatabaseSync(path.join(proxyDirOf(LOCK_APPDATA), "stats.db"), { readOnly: true });
  db2.exec("BEGIN;");
  db2.prepare("SELECT COUNT(*) AS c FROM usage_requests").get();   // 建立读快照
  console.log("\n===== Leg C 负对照（外部持读事务 ⇒ 应当冻结）=====");
  console.log(`写入 ${n} 条后 -wal=${wBeforeCk} B；外部连接已 BEGIN 读事务且不提交`);

  const linesBefore = readCheckpointLines(LOCK_APPDATA).length;
  const waitUntil = Date.now() + 75000;
  let ckLine = null;
  while (Date.now() < waitUntil && !ckLine) {
    const all = readCheckpointLines(LOCK_APPDATA);
    for (let i = linesBefore; i < all.length; i++) {
      const p = parseCheckpointLine(all[i]);
      if (p && p.before > 0) { ckLine = p; break; }
    }
    if (!ckLine) await sleep(500);
  }
  const wAfterTick = statWal(LOCK_APPDATA).bytes;
  for (const l of readCheckpointLines(LOCK_APPDATA)) console.log("    " + l);
  console.log(`外部观测 stat -wal：checkpoint 前 ${wBeforeCk} B → 后 ${wAfterTick} B`);
  console.log("==================================================\n");

  try { db2.exec("COMMIT;"); db2.close(); } catch { /* */ }
  try { await callViaPipeOn(LOCK_APPDATA, "gateway_shutdown", {}); } catch { /* */ }
  const kd = Date.now() + 8000;
  while (alive(gatewayPid) && Date.now() < kd) await sleep(100);
  if (alive(gatewayPid)) { try { process.kill(gatewayPid); } catch { /* */ } }
  assert.ok(!alive(gatewayPid), "Leg C 收尾失败：pid " + gatewayPid + " 仍在");

  // 负对照的判据：**必须**红（冻结）。若这条变绿，说明本闸的 ② 已经没牙，或 SQLite 语义变了。
  assert.ok(wAfterTick > TARGET,
    `Leg C 负对照**没有**冻结：持读事务时 -wal 从 ${wBeforeCk} B 收敛到 ${wAfterTick} B —— `
    + `这说明本闸可能造不出二期那种冻结（判据无牙），或 SQLite 的 TRUNCATE 语义已变。`
    + ` 日志行：${JSON.stringify(ckLine)}`);
  assert.ok(ckLine && ckLine.ok === true && ckLine.after === ckLine.before,
    `Leg C 负对照的**签名**与二期观测不符：期望 ok:true 且 after===before（「跑了但没截动」），`
    + ` 实得 ${JSON.stringify(ckLine)} —— 这正是 Task 4 分支 (b) 的判别面，签名变了要重新归因`);
  return { wBeforeCk, wAfterTick, ckLine, frozen: true };
}

/** 经认证管道对**指定沙箱**的子进程发命令（callViaPipe 的通用版，供 Leg C 用） */
async function callViaPipeOn(appdata, cmd, args) {
  const rec = JSON.parse(fs.readFileSync(path.join(proxyDirOf(appdata), "gateway.json"), "utf8"));
  const gatewayPipe = require(path.join(BE, "gateway-pipe.cjs"));
  const c = await gatewayPipe.connect({ pipePath: rec.pipe, token: rec.token, timeoutMs: 10000 });
  try { return await c.call(cmd, args || {}, { timeoutMs: 15000 }); }
  finally { try { c.close(); } catch { /* 已断 */ } }
}

async function main() {
  const realStatsBefore = realStatsSnapshot();
  const runBefore = runKeySnapshot();
  fs.writeFileSync(path.join(work, "lega.cjs"), LEGA_SRC, "utf8");
  fs.writeFileSync(path.join(work, "detach-launch.cjs"), DETACH_SRC, "utf8");

  // 端口必须先写进沙箱 config.json：子进程接 proxy_start 时读的就是它（写晚一步会拿到默认 9527）
  fs.mkdirSync(path.join(SANDBOX, "AgentHub"), { recursive: true });
  fs.writeFileSync(path.join(SANDBOX, "AgentHub", "config.json"),
    JSON.stringify({ proxy: { port: PORT, restoreOnLaunch: false } }), "utf8");

  // ===== 起真子进程（生产形态：gateway-client.start() 的正式路径，不是手搓 spawn）=====
  const started = await gw.start({ persistent: false });
  assert.ok(started && started.ok, "Leg B 前置失败：网关子进程没起来：" + JSON.stringify(started));
  assert.ok(!started.claimed, "Leg B 前置失败：竟然认领了别人的网关（沙箱里不该有常驻进程）：" + JSON.stringify(started));
  const childPid = started.pid;
  assert.ok(alive(childPid), "Leg B 前置失败：start() 报 ok 但 pid " + childPid + " 不活着");
  pass(`Leg B 真子进程起来了：pid=${childPid} claimed=${!!started.claimed}（走 gateway-client 正式路径，cwd 中立）`);

  // 让它真的开始监听（监听的决策归主进程，子进程自己不听——见 gateway.cjs 文件头）
  const s0 = await gw.call("proxy_start", {});
  assert.ok(s0 && s0.ok, "Leg B 前置失败：proxy_start 没成功：" + JSON.stringify(s0));
  assert.strictEqual(Number(s0.port), PORT, `子进程监听的端口不是本闸专属的 ${PORT}（不许碰 9527）：` + JSON.stringify(s0));
  pass(`子进程已在 127.0.0.1:${PORT} 监听（proxy_start 回报 port=${s0.port}）`);

  // ===== ① 留痕出口存在且可读（三期判据的前置；缺它任何修法都无法验收）=====
  const st0 = await readProxyStatus();
  assert.ok(st0 && st0.ok !== false, "① proxy_status 读不回来：" + JSON.stringify(st0));
  assert.ok(HAS(st0, "walBytes") && typeof st0.walBytes === "number",
    "① proxy_status 没有 walBytes 这个出口（留痕没做）：" + JSON.stringify(Object.keys(st0 || {})));
  assert.ok(HAS(st0, "lastCheckpoint"),
    "① proxy_status 没有 lastCheckpoint 这个出口（留痕没做）：" + JSON.stringify(Object.keys(st0 || {})));
  const lc0 = st0.lastCheckpoint;
  // 刚起来、周期还没 tick 过时 lastCheckpoint 允许为 null（诚实：还没跑过不许假装跑过），
  // 但一旦非 null 就必须是完整四元组形状。
  assert.ok(lc0 === null || shapec(lc0),
    "① lastCheckpoint 非 null 但形状不对（必须是 {ok,before,after,err}）：" + JSON.stringify(lc0));
  pass(`① 留痕出口可读（经管道 proxy_status）：walBytes=${st0.walBytes} lastCheckpoint=${JSON.stringify(lc0)}`);

  // ===== ①b 缝的自证（F3 选 (甲)）：两极都下断言，而不是只信注释 =====
  // 「默认值一字未动」这句话必须**可证伪**：把 env 清成空串（等价于不设）时来源必须是 "default"，
  // 设成有限正数时必须是 "env"。两条一起才是真断言——只测一极等于没测。
  // 只调纯函数 checkpointMsSource()（只读 env，不开库、不碰 WAL），因此对本沙箱零扰动。
  const storeMod = require(path.join(BE, "proxy", "store.cjs"));
  assert.strictEqual(typeof storeMod.checkpointMsSource, "function",
    "①b store.checkpointMsSource 未导出：F3 的自证面没接出来");
  const savedEnvMs = process.env.AGENTHUB_CHECKPOINT_MS;
  process.env.AGENTHUB_CHECKPOINT_MS = "";
  const srcDefault = storeMod.checkpointMsSource();
  process.env.AGENTHUB_CHECKPOINT_MS = savedEnvMs;
  const srcEnv = storeMod.checkpointMsSource();
  assert.strictEqual(srcDefault, "default",
    `①b 未设 env 时来源必须是 default（生产默认 5 min 一字未动），实得 ${srcDefault}`);
  assert.strictEqual(srcEnv, "env", `①b 设了 env=${savedEnvMs} 时来源必须是 env，实得 ${srcEnv}`);
  pass(`①b 缝自证两极：env 未设 ⇒ "${srcDefault}"（默认 5 min 未被改），env=${savedEnvMs} ⇒ "${srcEnv}"（如实标记被覆盖）`);

  // ===== ② 真 HTTP 打 50 条注定失败的请求（无效 Key ⇒ 非 200），随后观测收敛 =====
  // 观测必须来自子进程外部（S1）：这里 (i) stat -wal 与 (iii) proxy_status 两条腿**同时**取，
  // 二者一致才认；不一致本身就是证据，写进报告。
  const wPre = statWal(SANDBOX).bytes;
  const stPre = await readProxyStatus();
  const statuses = [];
  for (let i = 0; i < 50; i++) statuses.push(await postChat(i));
  const nonOk = statuses.filter((s) => s !== 200).length;
  assert.strictEqual(nonOk, 50, "② 夹具失效：50 条请求里只有 " + nonOk + " 条是失败的，判据的前提（空号池/无效 Key）不成立");
  const w50 = statWal(SANDBOX).bytes;
  assert.ok(w50 > wPre, `② 50 条失败请求后 WAL 竟没长（${wPre} → ${w50}），说明本轮没写库（夹具失效，判据无意义）`);
  note(`② 夹具有效性：50 条 HTTP 全部非 200（实得 ${nonOk}/50）；-wal ${wPre} → ${w50} B（+${w50 - wPre}）`);
  const st50 = await readProxyStatus();
  note(`   （外部观测 (iii) 对照：proxy_status.walBytes=${st50 && st50.walBytes}，与 stat 的 ${w50} B 互证）`);

  // 夹具加码：一条 401 流水行约 150 B，50 行连 8 KB 都不到 ⇒ 不先撑过 64 KB，「≤64KB」就是恒真空断言。
  // 按需继续打，直到 -wal 真的 > 64 KB（S5 第 3 项：checkpoint 前的 walBytes 必须 > 0 且**有意义**）。
  // TARGET 是模块级常量（两条腿共用同一门槛）。
  let extra = 0;
  while (statWal(SANDBOX).bytes <= TARGET && extra < 1000) {
    await postChat(50 + extra);
    extra++;
  }
  const wBeforeCk = statWal(SANDBOX).bytes;
  assert.ok(wBeforeCk > TARGET,
    `② 夹具失效：加码 ${extra} 条后 -wal 仍只有 ${wBeforeCk} B（未超 ${TARGET} B）—— 判据会退化成恒真的空断言，请改夹具`);
  if (extra) note(`② 夹具加码：再打 ${extra} 条（HTTP 共 ${httpN} 条），-wal 达到 ${wBeforeCk} B（> ${TARGET} B，判据非空）`);
  pass(`② checkpoint 前 -wal = ${wBeforeCk} B（stat 子进程沙箱；50 条那一点是 ${w50} B）`);

  // 等一次**周期** checkpoint 落下（S2 选 (乙)：AGENTHUB_CHECKPOINT_MS=30000 覆盖来的间隔，生产默认值未动）。
  // 判据是「日志里出现了覆盖本轮写入的那一行」而不是「睡够 30 s」——后者会把调度延迟误判成缺陷。
  const waitDeadline = Date.now() + 75000;
  let ckLine = null, linesBefore = readCheckpointLines(SANDBOX).length;
  // 先把「事件前的行数」记下来，只有**新增**的行才算覆盖了本轮写入（旧行是空载 tick 的）
  while (Date.now() < waitDeadline) {
    const all = readCheckpointLines(SANDBOX);
    for (let i = linesBefore; i < all.length; i++) {
      const p = parseCheckpointLine(all[i]);
      if (p && p.before > 0) { ckLine = p; break; }
    }
    if (ckLine) break;
    await sleep(500);
  }
  const ckLines = readCheckpointLines(SANDBOX);

  // ② 的判定：由**外部观测**给出的 after 与 before 对比。三条外部面并存，判定取 stat（最硬）。
  const wAfterTick = statWal(SANDBOX).bytes;
  const stAfter = await readProxyStatus();

  // —— 证据块（原样写进报告；Task 4 决策表直接吃它）——
  console.log("\n===== ② 对照腿 Leg B 的证据（非 detached 真子进程 + 真 HTTP + 子进程外部观测）=====");
  console.log("四元组来源 (ii) 日志 wal-checkpoint 行原文：");
  if (ckLines.length) for (const l of ckLines) console.log("    " + l);
  else console.log("    <无 wal-checkpoint 行>");
  console.log("四元组（从日志行解析）：" + JSON.stringify(ckLine));
  console.log("四元组来源 (iii) proxy_status.lastCheckpoint：" + JSON.stringify(stAfter && stAfter.lastCheckpoint));
  console.log("外部观测 (i) stat -wal：checkpoint 前 " + wBeforeCk + " B → 后 " + wAfterTick + " B");
  console.log("HTTP 实数：" + httpN + " 条（全部非 200）");
  console.log("=======================================================\n");

  // 对照腿（Leg B）：**非** detached + stdin 握手路径，与二期缺陷形态不是同一装配 ⇒ 它**不决定**
  // `②` 的绿红（判定权在 Leg B′，见文件头「判定腿的选择」）。这一条的结果仍如实输出并与 B′ 对照。
  // ⚠ 断言**放到收尾之后**再判：若在此处直接 assert，Leg A 对照与 stopAndWait 收尾都会被异常跳过
  // ——而 S5 要的正是两条腿的对比结论，且子进程必须经唯一出口停干净（否则留下孤儿常驻进程）。
  // 所以这里只**记录**，不判定。
  const legB = {
    ckLine, ckLines, wBeforeCk, wAfterTick, httpN, target: TARGET,
    hasLine: ckLine !== null,
    lastCheckpoint: stAfter && stAfter.lastCheckpoint,
    converged: wAfterTick <= TARGET,
  };

  // ===== Leg B′（**判定腿**）：生产常驻形态——detached + --persistent + Electron 运行时 =====
  // 为什么由它判定（评审 Concern 1 / 简报 S1 原意）：二期冻结的现场就是「常驻（脱离父进程、
  // 自启路径、Electron 运行时）+ 装配后父进程消失」，而 Leg B 是非 detached、跟着闸的 Job Object、
  // 走 stdin 握手的**另一种**装配。判定腿必须选在出缺陷的那个装配里，所以是 B′ 而不是 B。
  // 本腿与生产启动器的三处对齐（逐项）：
  //   (1) detached：二期那台是启动器/Run 项拉起的孤儿（脱离了主进程的 Job Object）。
  //   (2) --persistent：走 gateway.cjs 的自启路径（token 自造 + tokenSource:"file"），不经 stdin 握手。
  //   (3) Electron 运行时：生产启动器是 `ELECTRON_RUN_AS_NODE=1 AgentHub.exe gateway.cjs --persistent`
  //       —— Node **22.16.0**（Electron 35.7.5 内嵌），而 Leg B 用的是系统 node v26.4.0。
  // 观测同样必须在子进程**外部**：本腿不经 gateway-client（那是闸的直连对象），只 stat 沙箱 -wal +
  // 读日志 + 经认证管道读 proxy_status；跑完用 gateway_shutdown 停干净（唯一出口，不许按 pid 盲杀）。
  const detachLeg = await runDetachLeg();
  pass(`Leg B′ 生产常驻形态（**判定腿**：detached + --persistent + Electron 运行时）：`
    + `checkpoint 前 ${detachLeg.wBeforeCk} B → 后 ${detachLeg.wAfterTick} B，日志行 ${detachLeg.ckLines.length} 条`
    + `（${detachLeg.converged ? "收敛" : "*** 冻结复现 ***"}）`);

  // ===== Leg C（负对照）：证 ② 有牙 —— 外部持读事务时**必须**冻结（预期红，不参与 ② 的绿红）=====
  const lockLeg = await runLockedLeg();
  pass(`Leg C 负对照（外部持读事务）：-wal ${lockLeg.wBeforeCk} B 冻结在 ${lockLeg.wAfterTick} B，`
    + `日志签名 ${JSON.stringify(lockLeg.ckLine)} —— 与二期观测同形，证明 ② 能红（有牙）`);

  // ===== Leg A（附加信息，无决定权）：进程内直调对照，独立沙箱、独立进程 =====
  const lega = await spawnFixture("lega.cjs", [BE, String(extra + 50)], {
    APPDATA: LEGA_APPDATA, AGENT_SKILLS_HOME: path.join(work, "hub-lega"),
    CCSWITCH_DB_PATH: path.join(work, "ccswitch-lega.db"), AGENTHUB_CHECKPOINT_MS: "",
  }).done;
  const ml = /LEGA driver=(\S+) rows=(\d+) before=(\d+) after=(\d+) ok=(\S+) lcBefore=(\d+) lcAfter=(\d+) err=(.*)/.exec(lega.out);
  assert.ok(ml, "Leg A 探针没给出 LEGA 行：\n" + lega.out + lega.err);
  const legaGreen = Number(ml[4]) < Number(ml[3]) && Number(ml[4]) <= TARGET;
  note(`Leg A（进程内直调，独立进程+独立沙箱）driver=${ml[1]} rows=${ml[2]} ${ml[3]} B → ${ml[4]} B`
    + `（自报 ok=${ml[5]} before=${ml[6]} after=${ml[7]} err=${ml[8]}）⇒ 进程内形态 ${legaGreen ? "收敛成功" : "未收敛"}`);
  // 对照的是**判定腿**（B′）：进程内绿而常驻装配红才是「缺陷只出现在真常驻装配里」这个结论。
  if (legaGreen && !detachLeg.converged) {
    note("★ Leg A 绿而**判定腿 B′**红：与二期实证同形 —— 缺陷**只**出现在真常驻装配里，"
      + "不在此形态内。这本身是第一手证据，把 Task 4 的搜索面从「checkpoint 机制」收窄到「常驻装配差异」。");
  }
  // 两条子进程腿若结论相左，那个差异本身就是证据（装配差异 = 搜索面），原样报出来。
  if (legB.converged !== detachLeg.converged) {
    note(`★ 对照腿 B（非 detached）与判定腿 B′（生产常驻）结论**不一致**：`
      + `B ${legB.converged ? "收敛" : "冻结"} / B′ ${detachLeg.converged ? "收敛" : "冻结"}`
      + ` —— 差异应当只来自装配（detached / --persistent / 运行时），这是分派给 Task 4 的第一手线索。`);
  }

  pass(`Leg A 对照（附加信息，无决定权）：进程内 ${ml[3]} B → ${ml[4]} B`);

  // ===== ③ 收尾：唯一出口停干净 + 只读记录（round 3：不再断言真实库未变）=====
  const stop = await gw.stopAndWait({ timeoutMs: 8000 });
  assert.strictEqual(stop.stopped, true, "③ 收尾 stopAndWait 没停掉子进程：" + JSON.stringify(stop));
  assert.ok(!alive(childPid), "③ stopAndWait 报 stopped:true 但 pid " + childPid + " 还在（谎报）");
  pass(`③ 收尾：stopAndWait 停干净（stopped=${stop.stopped} portFreed=${stop.portFreed} drained=${stop.drained}）`);

  // 有牙的断言只剩这一条：**我们自己的副作用面**（本闸不该碰自启项），首尾必须一致。
  // 它断言的是本闸的行为，不随用户使用而变，所以留着；不许因为「隔离判据松了」顺手删它。
  assert.strictEqual(runKeySnapshot(), runBefore, "③ HKCU Run 自启项被改动了（本闸不该碰自启）");
  // 真实库 size@mtime：**只记录**。主库那条「首尾一致」断言已在 round 3 删掉——用户实例每 300 s 整拍
  // checkpoint 回写主库（实测差值恰 300.000 s），本闸跑 ~2.5 min 约一半概率跨过整拍 ⇒ 必然间歇假红，
  // 红的是「用户在用应用」这件正常事。理由与实测数字见 realStatsSnapshot() 的注释。
  const realStatsAfter = realStatsSnapshot();
  const realWalAfter = realWalBytes();
  const sites = assertNoRealDbOpenInSource();   // 结构判据：本闸源码里没有对真实库的开库调用
  pass(`③ 隔离（零副作用）：HKCU Run 快照首尾一致（有牙断言）；真实 stats.db ${realStatsBefore} → ${realStatsAfter}`
    + `（用户实例每 300 s 写回，只记录不断言）；真实 -wal 当前 ${realWalAfter} B（同上）。`
    + `结构性判据：本闸源码剥注释后 ${sites.length} 处开库调用点，**0 处**落在真实 %APPDATA% 表达面上`
    + `（对真实库只有 fs.statSync ⇒「不写」由构造保证）`);

  // ===== ② 的最终判定（放在收尾之后：收尾若失败要先报收尾，且上面所有证据都已落盘/落屏）=====
  // 判定腿是 **Leg B′**（生产常驻形态：detached + --persistent + Electron 运行时）——理由是二期
  // 冻结的现场就是那个装配（评审 Concern 1，回复 S1 原意）。**Leg B（非 detached 真子进程）只是对照**，
  // 它的结果不决定这里的绿红（它的断言仍在上文如实报告，两条腿结论不一致也会单独提示）。
  // ⚠ 实测结论与简报预期**相反**：判定腿 B′ 与对照腿 B 都**绿**（收敛），二期那种冻结在今天的任何
  //   生产装配里都**没有复现**。真正的冻结由 Leg C 的负对照造出（外部持读事务 ⇒ ok:true 但不截断），
  //   那与二期「1,388,472 B 恒定不动」同形 —— 这条差异是 Task 3 交给 Task 4 的核心证据，详见报告。
  assert.ok(detachLeg.ckLine || detachLeg.ckLines.length,
    "② 判定腿 B′ 没落任何 wal-checkpoint 日志行 —— 常驻装配里的计时器压根没跑"
    + "（Task 4 分支 (c) 的判别面）；本次日志行数=" + detachLeg.ckLines.length);
  // F3（甲）：日志必须**自证**本次生效的间隔。判定腿的日志行缺 ms 就说明自证面没生效，
  // 那时「复盘无法判断当时是 5 min 还是被覆盖过的值」这个 Concern 会原样复现——所以要断言。
  const msSeen = detachLeg.ckLine && detachLeg.ckLine.ms;
  assert.ok(Number.isFinite(msSeen) && msSeen > 0,
    "② 判定腿 B′ 的 wal-checkpoint 行没带生效间隔 ms（F3 自证缺失，事后无法复盘）："
    + `\n   行原文：${detachLeg.ckLine ? detachLeg.ckLine.raw : "<无>"}`);
  assert.ok(detachLeg.overrideLines && detachLeg.overrideLines.length === 1,
    "② 判定腿 B′ 的 env 覆盖没有留下恰好一条 wal-checkpoint-override 告警留痕（F3 自证缺失）："
    + ` 实得 ${detachLeg.overrideLines ? detachLeg.overrideLines.length : 0} 条`
    + `\n   全部日志行：${JSON.stringify(detachLeg.ckLines)}`);
  assert.ok(detachLeg.converged,
    `② 判定腿 B′ 冻结复现：周期 checkpoint 后 -wal 仍 ${detachLeg.wAfterTick} B（> ${TARGET} B）—— 三期判据 4 的本体。`
    + `\n   子进程外部观测 (i)：checkpoint 前 ${detachLeg.wBeforeCk} B → 后 ${detachLeg.wAfterTick} B`
    + `\n   子进程外部观测 (ii) 日志行：${detachLeg.ckLine ? detachLeg.ckLine.raw : "<无>"}`
    + `\n   子进程外部观测 (iii) 日志行共 ${detachLeg.ckLines.length} 条  HTTP ${detachLeg.httpN} 条（全部非 200）`
    + `\n   对照腿 B（非 detached）：前 ${legB.wBeforeCk} B → 后 ${legB.wAfterTick} B（${legB.converged ? "收敛" : "冻结"}）`
    + `\n   红即缺陷复现，归 Task 4 决策表处置`);
}

main().then(() => {
  cleanupOwnProcesses();
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows 偶发 EBUSY，交给系统回收 */ }
  console.log(`OK WAL 收敛闸：留痕出口可读（① 绿）+ 周期 checkpoint 把 WAL 压回 ≤64KB（② 绿），共 ${steps} 项小断言`);
}).catch((e) => {
  cleanupOwnProcesses();
  console.log("临时目录保留供排查：" + work);
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
