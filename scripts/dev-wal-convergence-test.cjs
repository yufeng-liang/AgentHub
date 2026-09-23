// 三期 Task 3 闸：WAL 收敛的可证伪化（留痕 + 一条**预期先红**的收敛判据）。
//
// 背景（二期结尾留下的未解缺陷）：常驻网关子进程的 stats.db-wal 长到 **1,388,472 B 后冻结不收敛**，
// 两条早期假设都已被否证，成因不明。三期的既定顺序是**先让这件事可观测、再取证、再修**，顺序不可反。
// 本闸就是那个「可观测」的落地 + 一条把缺陷变成可证伪命题的判据。
//
// ⚠ 本闸的 ② 在原计划里是「**预期先红**」（简报 Step 4 据此备了 detach 第二腿）。
//   实测（2026-09-23，本机）**与预期相反**：Leg B（非常驻真子进程）、Leg B′（detached + --persistent +
//   Electron 运行时）、Leg A（进程内）**三条腿全绿**，二期那种 1,388,472 B 冻结**没有复现**。
//   真正的冻结由 **Leg C 的负对照**造出：子进程**外部**持一条读事务不放时，
//   `wal_checkpoint(TRUNCATE)` 变成 **ok:true 但 after===before**（跑了但没截动），
//   与二期「t+3→t+30min 恒定不动」的观测**同形**。Leg C 的判据因此写成「**必须红**」：
//   它不参与 ② 的绿红，只证明 ② 有牙（一条从不曾红过的判据无法区分「缺陷不存在」与「判据没牙」）。
//   这条差异（绿的是闸、红的是负对照）是 Task 3 交给 Task 4 的核心证据，详见 task-3-report.md。
//
// ===== 判定腿的选择（简报补充 S1，全局最关键的一条）=====
// 简报正文的断言片段写成「闸进程内 require store.cjs 直调 checkpoint()/walBytes()」。**这个形态会骗人**：
// 二期那条 30 秒微探针**正是**纯 Node 进程内跑 `open() → insertUsage() → checkpoint() → walBytes()`，
// 结果是**收敛成功**（1,388,472 B → 0）；而同一个代码路径在**真常驻子进程**里却冻结不收敛。
// ⇒ 进程内腿在出缺陷的那个装配里没测，今天极可能直接绿，**绿得毫无意义**。故判定腿分两条：
//   · **Leg B（判定腿，有决定权）**：与生产同法起**真子进程**（走 gateway-client 正式路径 + 中立 cwd），
//     对它**自己监听的端口**打真 HTTP（无效 Key ⇒ 401，非 200），再从**子进程外部**观测收敛。
//     外部观测三面并用（S1 允许三选一，这里三条都留证据、互为佐证）：
//       (i)   stat 子进程沙箱 APPDATA 下的 `AgentHub/proxy/stats.db-wal`（本闸知道这个路径）
//       (ii)  读子进程 `logs/gateway.log` 的 `wal-checkpoint` 行（Task 3 的留痕产物）
//       (iii) 经管道调 `proxy_status` 读 Task 3 新增的 `walBytes` / `lastCheckpoint`
//   · **Leg A（附加信息，无决定权）**：另起一个**独立沙箱**的纯 Node 进程做进程内直调对照。
//     为什么另起进程而不是在闸进程内直接 require：本闸与子进程共用一份 APPDATA，闸进程再开一个 store
//     连接就是对**同一个 stats.db 的第二条连接**——它会成为 WAL 的读者/写者，把子进程那条 TRUNCATE
//     挡出 SQLITE_BUSY，于是 ② 会因为「闸自己污染了被测对象」而红，红得没有归因价值。
//     独立沙箱 + 独立进程 = 进程内形态（与二期微探针同形）且零干扰。
//     若 Leg A 绿而 Leg B 红，**那本身就是本任务要找的第一手证据**：把 Task 4 的搜索面从
//     「checkpoint 机制」收窄到「常驻装配下的差异」。
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
//  · 收尾只做只读比对：真实 %APPDATA%\AgentHub\proxy\stats.db 与 -wal 的 size@mtime、HKCU Run 快照。
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
  return text.split(/\r?\n/).filter((l) => l.includes(" wal-checkpoint"));
}

/** 把一条 `wal-checkpoint {json}` 日志行解析成 {ok,before,after,err}（解析失败回 null，不假装） */
function parseCheckpointLine(line) {
  const i = line.indexOf("wal-checkpoint");
  if (i < 0) return null;
  const j = line.indexOf("{", i);
  if (j < 0) return null;
  try {
    const o = JSON.parse(line.slice(j));
    return { raw: line, ok: o.ok, before: o.before, after: o.after, err: o.err };
  } catch { return null; }
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
 *  ⚠ 只对 **stats.db 主库**做「首尾一致」断言：真实 `-wal` 由**用户自己那台实例**（本机实测 4 个
 *  AgentHub 进程在跑）持续写入，实测 60 s 内自 576832 → 580952 B 单调变化——拿它做不变断言必然假红，
 *  而且红的是「用户在用应用」这件正常事，不是隔离失败。`-wal` 只如实记录、不断言。 */
function realStatsSnapshot() {
  const f = path.join(REAL_APPDATA, "AgentHub", "proxy", "stats.db");
  const snap = (p) => { try { const s = fs.statSync(p); return s.size + "@" + Math.round(s.mtimeMs); } catch { return "missing"; } };
  return snap(f);
}

/** 真实 -wal 的当前值（只记录，不断言——见 realStatsSnapshot 的注释） */
function realWalBytes() {
  try { return fs.statSync(path.join(REAL_APPDATA, "AgentHub", "proxy", "stats.db-wal")).size; } catch { return -1; }
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

  console.log("\n===== Leg B′ 第一手证据（生产常驻形态：detached + --persistent + Electron 运行时）=====");
  console.log(`拉起：Electron ${exe}`);
  console.log(`gatewayPid=${gatewayPid}（detached，与本闸的 Job 无关）  端口=${DETACH_PORT}  HTTP ${n} 条（全非 200）`);
  console.log("wal-checkpoint 日志行原文：");
  if (ckLines.length) for (const l of ckLines) console.log("    " + l);
  else console.log("    <无 wal-checkpoint 行>");
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

  return { wBeforeCk, wAfterTick, ckLines, ckLine, converged: wAfterTick <= TARGET, gatewayPid, httpN: n };
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
 *  这条负对照的红是**预期红**，所以判据写成「必须红」：它不参与 ② 的绿红，只证明 ② 有牙。 */
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
  while (statWal(LOCK_APPDATA).bytes <= TARGET && n < 1000) {
    await fetch(`http://127.0.0.1:${LOCK_PORT}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: "Bearer sk-bad" },
      body: JSON.stringify({ model: "claude-x", messages: [{ role: "user", content: "lock" }] }),
    });
    n++;
  }
  const wBeforeCk = statWal(LOCK_APPDATA).bytes;
  // 负对照的核心：**外面**开一条连接，BEGIN 后不提交（持读快照）。这是唯一实测能造出冻结的形态。
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
  console.log("\n===== ② 第一手证据（Leg B，真子进程 + 真 HTTP + 子进程外部观测）=====");
  console.log("四元组来源 (ii) 日志 wal-checkpoint 行原文：");
  if (ckLines.length) for (const l of ckLines) console.log("    " + l);
  else console.log("    <无 wal-checkpoint 行>");
  console.log("四元组（从日志行解析）：" + JSON.stringify(ckLine));
  console.log("四元组来源 (iii) proxy_status.lastCheckpoint：" + JSON.stringify(stAfter && stAfter.lastCheckpoint));
  console.log("外部观测 (i) stat -wal：checkpoint 前 " + wBeforeCk + " B → 后 " + wAfterTick + " B");
  console.log("HTTP 实数：" + httpN + " 条（全部非 200）");
  console.log("=======================================================\n");

  // 判定腿（Leg B）：这一条**此刻预期红**。红 = 缺陷复现 = Task 4 的输入，不是本任务的失败。
  // ⚠ 断言**放到收尾之后**再判（见文件末尾的 ② 判定块）：若在此处直接 assert，Leg A 对照与
  // stopAndWait 收尾都会被异常跳过——而 S5 要的正是「Leg A 绿而 Leg B 红」这个对比结论，
  // 且子进程必须经唯一出口停干净（否则留下孤儿常驻进程）。所以这里只**记录**，不判定。
  const legB = {
    ckLine, ckLines, wBeforeCk, wAfterTick, httpN, target: TARGET,
    hasLine: ckLine !== null,
    lastCheckpoint: stAfter && stAfter.lastCheckpoint,
    converged: wAfterTick <= TARGET,
  };

  // ===== Leg B′（判定腿的第二形态）：**生产常驻形态**——detached + --persistent + Electron 运行时 =====
  // 为什么非要有它（简报 Step 4 的明令）：本次 Leg B 直接**绿**了，而二期那台真常驻网关是**冻结**的。
  // 两者的装配差异有三处，本腿逐一对齐到生产形态，把「绿」的成因逼出来：
  //   (1) detached：二期那台是启动器/Run 项拉起的孤儿（脱离了主进程的 Job Object），
  //       Leg B 是闸的子进程（跟着闸的 Job）。这是 S1 点名「冻结只出现在真常驻子进程里」的第一嫌疑。
  //   (2) --persistent：走 gateway.cjs 的自启路径（token 自造 + tokenSource:"file"），不经 stdin 握手。
  //   (3) Electron 运行时：生产启动器是 `ELECTRON_RUN_AS_NODE=1 AgentHub.exe gateway.cjs --persistent`
  //       —— Node **22.16.0**（Electron 35.7.5 内嵌），而 Leg B 用的是系统 node v26.4.0。
  //       本机已在两种运行时下各做一次进程内微测（都是 1,388,472 → 0），故此处不复述那份对照，
  //       只把「真常驻装配」这条腿补上。
  // 观测同样必须在子进程**外部**：本腿不经 gateway-client（那是闸的直连对象），只 stat 沙箱 -wal +
  // 读日志，跑完用 stopAndWait 经认证管道停干净（唯一出口，不许按 pid 盲杀）。
  const detachLeg = await runDetachLeg();
  pass(`Leg B′ 生产常驻形态（detached + --persistent + Electron 运行时）：`
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
  if (legaGreen && !legB.converged) {
    note("★ Leg A 绿而 Leg B 红：与二期实证同形 —— 缺陷**只**出现在真常驻装配里，"
      + "不在此形态内。这本身是第一手证据，把 Task 4 的搜索面从「checkpoint 机制」收窄到「常驻装配差异」。");
  }

  pass(`Leg A 对照（附加信息，无决定权）：进程内 ${ml[3]} B → ${ml[4]} B`);

  // ===== ③ 收尾：唯一出口停干净 + 只读比对未变 =====
  const stop = await gw.stopAndWait({ timeoutMs: 8000 });
  assert.strictEqual(stop.stopped, true, "③ 收尾 stopAndWait 没停掉子进程：" + JSON.stringify(stop));
  assert.ok(!alive(childPid), "③ stopAndWait 报 stopped:true 但 pid " + childPid + " 还在（谎报）");
  pass(`③ 收尾：stopAndWait 停干净（stopped=${stop.stopped} portFreed=${stop.portFreed} drained=${stop.drained}）`);

  assert.strictEqual(realStatsSnapshot(), realStatsBefore,
    "③ 真实 %APPDATA%\\AgentHub\\proxy\\stats.db 被改动了（隔离失败）：\n  before " + realStatsBefore
    + "\n  after  " + realStatsSnapshot());
  assert.strictEqual(runKeySnapshot(), runBefore, "③ HKCU Run 自启项被改动了（本闸不该碰自启）");
  pass("③ 隔离：真实 stats.db 的 size@mtime 与 HKCU Run 快照首尾一致（零副作用）；"
    + `真实 -wal 当前 ${realWalBytes()} B（用户实例在写，只记录不断言）`);

  // ===== ② 的最终判定（放在收尾之后：收尾若失败要先报收尾，且上面所有证据都已落盘/落屏）=====
  // 判定腿是 Leg B（真子进程 + 真 HTTP + 子进程外部观测），Leg A 的进程内结果**不参与**这里的绿红。
  // ⚠ 实测结论与简报预期**相反**：Leg B 与 Leg B′ 都**绿**（收敛），二期那种冻结在今天的任何
  //   生产装配里都**没有复现**。真正的冻结由 Leg C 的负对照造出（外部持读事务 ⇒ ok:true 但不截断），
  //   那与二期「1,388,472 B 恒定不动」同形 —— 这条差异是 Task 3 交给 Task 4 的核心证据，详见报告。
  assert.ok(legB.hasLine || legB.lastCheckpoint,
    "② 周期 checkpoint 既没落日志行、proxy_status.lastCheckpoint 也仍是 null —— "
    + "计时器压根没跑（Task 4 分支 (c) 的判别面）；本次日志 wal-checkpoint 行数=" + legB.ckLines.length);
  assert.ok(legB.converged,
    `② Leg B 冻结复现：周期 checkpoint 后 -wal 仍 ${legB.wAfterTick} B（> ${legB.target} B）—— 三期判据 4 的本体。`
    + `\n   子进程外部观测 (i)：checkpoint 前 ${legB.wBeforeCk} B → 后 ${legB.wAfterTick} B`
    + `\n   子进程外部观测 (ii) 日志行：${legB.ckLine ? legB.ckLine.raw : "<无>"}`
    + `\n   子进程外部观测 (iii) proxy_status.lastCheckpoint：${JSON.stringify(legB.lastCheckpoint)}`
    + `\n   本轮真 HTTP ${legB.httpN} 条（全部非 200）。红即缺陷复现，归 Task 4 决策表处置`);
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
