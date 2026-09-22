// 二期 Task 3 闸：网关子进程的生命周期基座（握手 / 认领双检 / 看门狗 / 日志 / liveness 与 readiness）。
//
// 这一闸要证明的是「子进程这个存在立起来了」，四组判据按简报 Step 7 逐条落：
//  ① start() 之后 gateway.json 存在、字段齐、pid 真活着；第二次 start() 返回 claimed:true 且 pid 不变
//     （「重开应用不起第二个进程」的机器可核形式）。再加三条简报没写但同一条链上的：
//     **另一个 OS 进程**去 start() 也必须认领同一个 pid（跨进程认领才是真机形态）、
//     call() 真能走通子进程那张命令表、事件从子进程回流到主进程 onEvent。
//  ② 把 gateway.json 的 token 改掉（模拟 pid 复用：进程活着但它不是我们认的那个网关）→ probeAlive 必须回 false。
//     这条是双检的**全部价值**所在：kill(pid,0) 那一检在同一测试里恒为真，红的一定是 token/管道那一腿。
//     所以判据成对做：改之前同一条件下必须 true，改完必须 false，改回又必须 true。
//  ③ 父进程退出：非常驻分支必须在看门狗一个周期内自杀；persistent=true 分支必须**不**自杀，
//     且只能用 stopAndWait 这一条出口停干净。
//  ④ /healthz 在空号池下 200（liveness 与号池脱钩）、/readyz 同状态 503（readiness），
//     且 credFail 在人为写入坏密文时为 true（「有号但解不开」不许再伪装成「没号」）。
//     credFail 走**两条独立的腿**，各配一条断言：号池评估（tokenUsable）与读明文（decryptForRead）；
//     两条腿的坏号删掉后都必须掉回 false（readiness 不能拿 Task 1 那条只增不减的累计计数当判据），
//     而 ok:true 与 credFail:true 必须能并存（Task 5 的网关页靠这两个字段分开渲染）。
//     另外钉停机质量：gracefulShutdown 回 drained:true、PENDING_REQ none、RESIDUE 里没有 FSEventWrap，
//     探针自身 exit 0 —— 这三条是 0xC0000409 fastfail 的机器可核形式（见夹具注释）。
//  ⑤ 日志自身：轮转到 2 MB 只留 1 份旧档。
//  ⑥ 陈旧 pid（真死了）→ 回收 + 新起，且 stopAndWait 仍是唯一出口。再加两条停机留痕：
//     父进程记下的 child-exit 退出码必须全 0（非 0 = 子进程停机时撞了 libuv 的 fastfail）、
//     子进程自己记的 shutdown-done 必须 drained:true / forced:false。
//     再加两条「回收本身有牙」（minor④：reap 过去删掉判据仍绿）：日志里必须出现点名那个死 pid 的
//     reap-stale；以及「回收绝不按 pid 杀进程」——握手文件里写一个**活着且无辜**的 pid，start() 之后它必须还在。
//  ⑥b portFreed 必须能说「不」（评审 I1）：pid 已死、端口仍被**另一个进程**占着 → portFreed:false。
//     ① 里那两条「子进程一开始监听就把端口回写进 gateway.json / proxy_stop 后回 0」是它的前提。
//  ③-b ③-c detach 与 exe-gone 各配一条**真在监听**的用例（评审 I4 + minor④，这两处过去删掉判据仍绿）：
//     ③-b 常驻 + 在监听 + 父进程没了 → 必须留下 detach-keep 痕迹、必须活过看门狗周期，再由另一个进程
//          经唯一出口停干净，且停机结论 drained:true 要看得见（评审 I2③ 选的那条投递路径）；
//     ③-c 常驻 + 在监听 + **exe 映像不在了** → 必须退出（旧代码的 detach 保护对所有 reason 一律不退，
//          恰好把 exe-gone 吞掉，而升级/卸载删安装目录正是它唯一能起作用的时候）。
//  ⑦ EADDRINUSE 的占用者判定（规格 §七.5）：占用者是已认证的常驻网关时报「接管」，不是「请更换端口」。
//     ⑦-b 再把这条判据跑成**端到端**（评审 I3）：一台真子进程在监听，第二个进程调 proxy_start 必须
//     既拿到 claimed:true、又**不**把 restoreOnLaunch 记成「本机在监听」、本进程 status().running 仍为 false。
//  ⊘ 停机预算的四个数字必须仍然复合（评审 I2②）：stopAsync 500 + drain 800 + 响应 flush 300 < 硬退 2000。
//     四个数分处三个文件，改一个忘改另一个就得当场变红。
//  ⑧ 收尾卫生：真实 %APPDATA%\AgentHub\proxy\stats.db 零写入、HKCU Run 项未变。
//
// 卫生约束（AGENTS.md 与探针三件套，硬要求）：
//  · APPDATA / AGENT_SKILLS_HOME / CCSWITCH_DB_PATH 在任何产品代码 require 之前指进临时目录；
//  · 端口一律非 9527（这里用 19531 / 19530），9527 归用户自己那台实例；
//  · 每个沙箱（= 一份 gateway.json）各跑各的场景，互不覆盖彼此的握手文件；
//  · 收尾只按「本次记下的 pid」精确处理自己起的进程，绝不按进程名宽匹配（一期踩过宽匹配杀到用户实例的坑）；
//  · 真实 %APPDATA%\AgentHub\proxy\stats.db 只做 stat 比对（size@mtime 未变 = 零写入的直接证据），
//    不去开它：给用户在跑的实例添一个数据库句柄本身就是副作用。
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BE = path.join(ROOT, "electron", "backend");

// ===== 隔离：必须早于任何产品代码的 require =====
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-gwpipe-"));
const REAL_APPDATA = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
const SANDBOX = path.join(work, "appdata-main");     // ① ② 的沙箱（本进程自己持有子进程）
const CHILD_PORT = 19531;                             // ① 里子进程真监听的端口
const PROBE_PORT = 19530;                             // ④ 里探针进程真监听的端口
// ③-b ③-c ⑥b ⑦-b 各要一个真监听，端口互不重叠（全部非 9527：那是用户自己那台实例的）
const KEEP_PORT = 19534;                              // ③-b 常驻且在监听
const EXE_PORT = 19535;                               // ③-c exe-gone
const BUSY_PORT = 19536;                              // ⑥b 「pid 已死但端口仍被占着」的那个占用者
const TAKEOVER_PORT = 19537;                          // ⑦-b 端到端接管
process.env.APPDATA = SANDBOX;
process.env.AGENT_SKILLS_HOME = path.join(work, "hub");
process.env.CCSWITCH_DB_PATH = path.join(work, "ccswitch.db");
fs.mkdirSync(process.env.APPDATA, { recursive: true });

const gw = require(path.join(BE, "gateway-client.cjs"));
const util = require(path.join(BE, "proxy", "util.cjs"));
const log = require(path.join(BE, "gateway-log.cjs"));
const gatewayPipe = require(path.join(BE, "gateway-pipe.cjs"));
// ⊘ 停机预算的四个数字分处三个文件，require 进来才比得动。gateway.cjs 有 require.main 守卫，
// 被 require 时一个副作用都不许有（装配全在 main() 里）——这条本身也是装配边界的一部分。
const gwEntry = require(path.join(ROOT, "electron", "gateway.cjs"));
const proxy = require(path.join(BE, "proxy", "index.cjs"));
const serverMod = require(path.join(BE, "proxy", "server.cjs"));

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let steps = 0;
const pass = (msg) => { steps++; console.log(`  ${String(steps).padStart(2)}. ${msg}`); };
const sandboxDir = (name) => path.join(work, "appdata-" + name);

// 整闸硬超时：宁可红也不要让跑门禁的人干等（红/挂死时保留临时目录供排查）。
// ③-b ③-c（各等一个看门狗周期 + 停机）、⑥b、⑦-b 都是真进程真端口，180 s 装不下这些新用例。
setTimeout(() => { console.log("FAIL 本闸 420 s 未跑完。临时目录保留供排查：" + work); process.exit(1); }, 420000).unref?.();

/** 本次跑起来的所有 pid（清理只按这份名单，绝不按进程名宽匹配） */
const knownPids = new Set();
const running = new Set();

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

/** 起一个夹具子进程：done 在退出时 resolve，kill 供超时路径兜底 */
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

function readSandboxGateway(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "AgentHub", "proxy", "gateway.json"), "utf8"));
  } catch { return null; }
}

async function waitForFile(f, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fs.existsSync(f)) return f;
    await sleep(100);
  }
  throw new Error("等待超时（" + ms + "ms）：" + f);
}

async function waitForPortFree(port, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!(await gw.probePortBusy(port))) return true;
    if (Date.now() >= deadline) return false;
    await sleep(100);
  }
}

/** 某个沙箱的子进程日志文件（③-b ③-c 用的是各自的沙箱，不只看 ① 那一份） */
const logFileOf = (dir) => path.join(dir, "AgentHub", "proxy", "logs", "gateway.log");

/** 等某个 kind 的日志行出现（父进程侧的 child-exit 是异步落盘的，不能假设 stopAndWait 返回时已写入） */
async function waitForLogLineIn(dir, re, ms) {
  const f = logFileOf(dir);
  const deadline = Date.now() + ms;
  for (;;) {
    let text = "";
    try { text = fs.readFileSync(f, "utf8"); } catch { /* 还没建 */ }
    const m = re.exec(text);
    if (m) return { line: m[0], text };
    if (Date.now() >= deadline) return { line: null, text };
    await sleep(100);
  }
}

const waitForLogLine = (re, ms) => waitForLogLineIn(SANDBOX, re, ms);

/** 只清理我们亲手起的那批 pid（先等它们自己退，仍活着才按 pid 强杀） */
function cleanupOwnProcesses() {
  for (const h of [...running]) h.kill();
  const deadline = Date.now() + 5000;
  for (const pid of knownPids) {
    while (alive(pid) && Date.now() < deadline) nap(50);
    if (alive(pid)) { try { process.kill(pid); } catch { /* 已退 */ } }
  }
}

// ===== 夹具 A：另一个「主进程」——只走 gw.start()，用于 ① 的跨进程认领 =====
const PARENT_SRC = `"use strict";
const path = require("node:path");
const fs = require("node:fs");
const be = process.argv[2];
const reportFile = process.argv[3];
const gw = require(path.join(be, "gateway-client.cjs"));
function report(o) { fs.writeFileSync(reportFile, JSON.stringify(Object.assign({ pid: process.pid }, o)), "utf8"); }
(async () => {
  const r = await gw.start({ persistent: false });
  report({ start: r, gatewayPid: r.pid || 0, pipe: gw.state().pipe || "" });
  if (!r.ok) { console.log("PARENT-START-FAILED " + (r.message || "")); process.exit(1); }
  console.log("CLAIM pid=" + r.pid + " claimed=" + r.claimed);
  process.exit(0);
})().catch((e) => { console.log("PARENT-THREW " + String((e && e.message) || e)); process.exit(1); });
`;

// ===== 夹具 B：按握手协议**直接**起 gateway.cjs，并且一律 detached =====
// 为什么不许用 gw.start({persistent:false}) 跑 ③：实测（本机，job-probe 复现）Windows 上 libuv 会把
// 非 detached 子进程挂进父进程的 Job Object，父进程一退操作系统就直接 TerminateProcess 掉它——
// 连一行日志都来不及写。那样测的根本不是看门狗。所以这里强制 detached，把
// 「脱离了 Job 的孤儿进程靠自己收」这条分支单独测出来（Task 6 的开机自启启动器就是同一形态）。
const SPAWN_SRC = `"use strict";
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const be = process.argv[2];
const persistent = process.argv[3] === "1";
const reportFile = process.argv[4];
const { encode } = require(path.join(be, "gateway-proto.cjs"));
const token = crypto.randomBytes(24).toString("hex");
const pipePath = String.raw\`\\\\.\\pipe\\agenthub-gw-\${process.pid}-\${Date.now().toString(36)}\`;
const child = spawn(process.execPath, [path.join(path.dirname(be), "gateway.cjs")], {
  env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }),
  cwd: path.dirname(process.execPath), stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true,
});
child.stderr.on("data", () => {});                                  // 读干，别让缓冲区写满把孩子卡住
child.stdin.write(encode({ token, parentPid: process.pid, persistent, pipePath }) + "\\n");
const file = path.join(process.env.APPDATA, "AgentHub", "proxy", "gateway.json");
let waited = 0;
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
while (!fs.existsSync(file) && waited < 20000) { nap(50); waited += 50; }
let o = {};
try { o = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { o = { error: String(e.message) }; }
fs.writeFileSync(reportFile, JSON.stringify({ pid: process.pid, gatewayPid: o.pid || 0, waited, persistent }), "utf8");
console.log("SPAWNED gatewayPid=" + o.pid + " persistent=" + persistent);
process.exit(o.pid ? 0 : 1);
`;

// ===== 夹具 C：一个「新起的主进程」——认领并停掉常驻网关（③ 的常驻分支与 ⑥ 的回收都靠它） =====
const STOPPER_SRC = `"use strict";
const path = require("node:path");
const be = process.argv[2];
const gw = require(path.join(be, "gateway-client.cjs"));
(async () => {
  const cur = gw.readGatewayFile();
  const alive = await gw.probeAlive(cur);
  const r = await gw.start({ persistent: true });                 // 认领常驻网关（不新起进程）
  const s = await gw.stopAndWait({ timeoutMs: 8000 });
  console.log("PROBE alive=" + alive + " claim=" + r.claimed + " pid=" + r.pid);
  console.log("STOPPED stopped=" + s.stopped + " portFreed=" + s.portFreed + " drained=" + s.drained
    + " forced=" + s.forced + " port=" + s.port + " message=" + (s.message || ""));
  process.exit(s.stopped ? 0 : 1);
})().catch((e) => { console.log("STOPPER-THREW " + String((e && e.message) || e)); process.exit(1); });
`;

// ===== 夹具 D：按握手协议直接起 gateway.cjs 并**让它真的开始监听**（③-b ③-c 用）
// 为什么这两个场景非得带一个真监听：
//  · ③-b 要测 detach-keep 那一支，而它的条件是「常驻 + 父进程没了」；旧实现里 detach 时顺手 clear 掉
//    整个计时器，exe 监视就此失效——所以 detach 之后还必须能继续观察到 exe-gone（③-c）。
//  · ③-c 的 exePath 只能从握手投递（父进程才知道哪个映像必须被解锁；真实形态下与 process.execPath 同值），
//    所以这里不走 gw.start() 而是自己按协议起。
const LISTEN_SRC = `"use strict";
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const be = process.argv[2];
const persistent = process.argv[3] === "1";
const port = Number(process.argv[4]);
const reportFile = process.argv[5];
const exePath = process.argv[6] || process.execPath;
const { encode } = require(path.join(be, "gateway-proto.cjs"));
const gwpipe = require(path.join(be, "gateway-pipe.cjs"));
const token = crypto.randomBytes(24).toString("hex");
const pipePath = String.raw\`\\\\.\\pipe\\agenthub-gw-listen-\${process.pid}-\${Date.now().toString(36)}\`;
fs.mkdirSync(path.join(process.env.APPDATA, "AgentHub"), { recursive: true });
fs.writeFileSync(path.join(process.env.APPDATA, "AgentHub", "config.json"), JSON.stringify({ proxy: { port } }), "utf8");
const child = spawn(process.execPath, [path.join(path.dirname(be), "gateway.cjs")], {
  env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }),
  cwd: path.dirname(process.execPath), stdio: ["pipe", "pipe", "pipe"], detached: true, windowsHide: true,
});
child.stderr.on("data", () => {});
child.stdout.on("data", () => {});
child.stdin.write(encode({ token, parentPid: process.pid, persistent, pipePath, exePath }) + "\\n");
(async () => {
  const c = await gwpipe.connect({ pipePath, token, timeoutMs: 25000 });
  const r = await c.call("proxy_start", {}, { timeoutMs: 20000 });
  const f = path.join(process.env.APPDATA, "AgentHub", "proxy", "gateway.json");
  let diskPort = -1;
  for (let i = 0; i < 100; i++) {
    try { diskPort = JSON.parse(fs.readFileSync(f, "utf8")).port; } catch (e) { diskPort = -1; }
    if (Number(diskPort) === Number(port)) break;
    await new Promise((k) => setTimeout(k, 50));
  }
  fs.writeFileSync(reportFile, JSON.stringify({ pid: process.pid, gatewayPid: child.pid, started: r, diskPort }), "utf8");
  console.log("LISTEN ok=" + (r && r.ok) + " port=" + (r && r.port) + " diskPort=" + diskPort);
  c.close();
  process.exit(0);
})().catch((e) => { console.log("LISTEN-THREW " + String((e && e.message) || e)); process.exit(1); });
`;

// ===== 夹具 E：端到端接管（⑦-b，评审 I3）——一台**真子进程**在监听，第二个进程去 proxy_start =====
const TAKEOVER_SRC = `"use strict";
const path = require("node:path");
const fs = require("node:fs");
const be = process.argv[2];
const reportFile = process.argv[3];
const port = Number(process.argv[4]);
const gw = require(path.join(be, "gateway-client.cjs"));
const server = require(path.join(be, "proxy", "server.cjs"));
const proxy = require(path.join(be, "proxy", "index.cjs"));
const cfgFile = path.join(process.env.APPDATA, "AgentHub", "config.json");
fs.mkdirSync(path.dirname(cfgFile), { recursive: true });
const writeCfg = (restore) => fs.writeFileSync(cfgFile, JSON.stringify({ proxy: { port, restoreOnLaunch: restore } }), "utf8");
(async () => {
  writeCfg(false);
  const r = await gw.start({ persistent: false });                 // 一台真子进程（本夹具是它的父进程）
  const started = await gw.call("proxy_start", {});                // 它真的开始监听 port
  const diskPort = (gw.readGatewayFile() || {}).port;              // 开始监听后必须回写（评审 I1）
  // 站到「第二个主进程」的位置上按本机语义再调一次 proxy_start：走完整命令表，含 rememberRunning
  writeCfg(false);
  const take = await proxy.dispatch("proxy_start", {});
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  const out = {
    gatewayPid: r.pid, startedPort: started && started.port, diskPort,
    take, localRunning: server.status().running,
    restoreOnLaunch: cfg.proxy && cfg.proxy.restoreOnLaunch,
  };
  const stop = await gw.stopAndWait({ timeoutMs: 8000 });
  out.stop = { stopped: stop.stopped, portFreed: stop.portFreed, drained: stop.drained, forced: stop.forced, port: stop.port };
  fs.writeFileSync(reportFile, JSON.stringify(out), "utf8");
  console.log("TAKEOVER " + JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.log("TAKEOVER-THREW " + String((e && e.message) || e)); process.exit(1); });
`;

// ===== 夹具 F：回收一个「活着但与本任务无关」的 pid（⑥ 的 reap 牙齿：回收只挪文件，绝不按 pid 杀）=====
const REAP_SRC = `"use strict";
const path = require("node:path");
const fs = require("node:fs");
const be = process.argv[2];
const reportFile = process.argv[3];
const victim = Number(process.argv[4]);
const gw = require(path.join(be, "gateway-client.cjs"));
const isAlive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code !== "ESRCH"; } };
(async () => {
  const before = gw.readGatewayFile();
  const r = await gw.start({ persistent: false });
  const stop = await gw.stopAndWait({ timeoutMs: 8000 });
  const out = { beforePid: before && before.pid, ok: !!r.ok, claimed: !!(r && r.claimed), newPid: r.pid,
    stopped: stop.stopped, victimAlive: isAlive(victim) };
  fs.writeFileSync(reportFile, JSON.stringify(out), "utf8");
  console.log("REAP " + JSON.stringify(out));
  process.exit(0);
})().catch((e) => { console.log("REAP-THREW " + String((e && e.message) || e)); process.exit(1); });
`;

/** 夹具：④ 的探针——真实 server + 真实库（都在自己的沙箱里新建），量 liveness 与 readiness 的分工。
 *  停机那段必须走 proxy.gracefulShutdown() 这一条产品实现，不能在夹具里自己 stopAsync()+close() 凑：
 *  它内含 rules.close() 与「等 libuv 线程池在途作业落地」两步，缺了就会被工作线程往已关闭的
 *  uv_async_t 上发通知撞进 libuv 断言（src/win/async.c:94）→ 探针以 0xC0000409 fastfail 退出。
 *  这条正是 Task 3 收口时踩到并修掉的缺陷，SHUTDOWN / PENDING_REQ 两行是它的机器可核形式。 */
const READY_SRC = `"use strict";
const path = require("node:path");
const be = process.argv[2];
const port = Number(process.argv[3]);
const store = require(path.join(be, "proxy", "store.cjs"));
const server = require(path.join(be, "proxy", "server.cjs"));
const util = require(path.join(be, "proxy", "util.cjs"));
const rules = require(path.join(be, "proxy", "rules.cjs"));
const proxy = require(path.join(be, "proxy", "index.cjs"));
// 一条形态完整的 v10 信封（头三字节 v10 + 12B nonce + 载荷 + 16B tag），但本机沙箱里没有主密钥 → 必抛错。
// mk(n) 造两条明文不同的坏密文：坏号 A 只经「读明文凭据」那条腿撞开，坏号 B 只经「号池评估」那条腿撞开
// ——两条腿各自要有断言，否则一条腿的 add 掉了闸还是绿的（实测 M20 就是这样溜过去一次）。
const mk = (n) => "enc:v1:" + Buffer.concat([
  Buffer.from("v10", "latin1"), Buffer.alloc(12, n), Buffer.alloc(24, n + 1), Buffer.alloc(16, n + 2),
]).toString("base64");
const bad = mk(1), bad2 = mk(7);
const get = async (p) => {
  const r = await fetch("http://127.0.0.1:" + port + p);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const pendingReq = () => process.getActiveResourcesInfo().filter((n) => /Req/.test(String(n)));
/** 停机之前故意压一条「此刻一定还在途」的异步 fs 作业（16 MB 的 readFile 稳稳占住 libuv 线程池几十毫秒）。
 *  不压这一条，chokidar 首扫那几次 stat 往往在别的 await 期间就自己落地了，PENDING_REQ 会偶然为空——
 *  而那条 0xC0000409 的实测复现率只有 23/30。闸不能靠概率，所以把「停机时有在途作业」做成确定性的。 */
const preBait = () => {
  const f = path.join(process.env.APPDATA, "AgentHub", "proxy", "drain-bait.bin");
  require("node:fs").writeFileSync(f, Buffer.alloc(16 * 1024 * 1024, 7));
  return require("node:fs/promises").readFile(f).then(() => "ok", () => "err");
};
(async () => {
  rules.init(); store.open();                                   // 空号池（沙箱库，本次新建）
  const sr = await server.start(() => ({
    port, bind: "127.0.0.1", rateLimitPerMin: 120, concurrency: 8, routeStrategy: "smart",
    fixedChannel: "trae", modelOverrides: {}, debugStatus: false,
  }));
  if (!sr.ok) { console.log("SERVER-FAILED " + sr.message); process.exit(1); }
  const r = async (tag) => console.log(tag + " " + JSON.stringify(await get("/readyz")));
  const acct = (o) => store.addAccount(Object.assign({ channel: "trae", source: "test" }, o));
  console.log("EMPTY_HEALTHZ " + JSON.stringify(await get("/healthz")));
  await r("EMPTY_READYZ");
  // 腿一：坏 token——号池评估（poolSummary→accountView→tokenUsable）自己就该把它认出来，
  // 生产里 /readyz 只会看到这条腿（没人去 accountSecrets）。
  const poolBad = acct({ uid: "pool-bad", name: "号池里的坏凭据", token: bad2, refreshToken: "" });
  await r("POOL_BAD_READYZ");
  console.log("POOL_BAD_HEALTHZ " + JSON.stringify(await get("/healthz")));
  console.log("FAILURES_AFTER_POOL " + store.decryptFailureCount());
  store.removeAccount(poolBad);
  await r("POOL_CLEAR_READYZ");                                 // 删掉之后 credFail 必须掉回 false（与存活信封对账）
  // 腿二：池里先放一个正常号（readiness 得是 200），再放一个 token 好、refreshToken 坏的号——
  // 号池评估看不见它，只有真去读明文凭据那条腿会撞上。这正是控制器点出的那条「ok:true 却 credFail:true」。
  acct({ uid: "good", name: "可用号", token: "plain-token", refreshToken: "", source: "test" });
  await r("GOOD_READYZ");                                       // 基线：有可用号且没有任何解密失败
  const secBad = acct({ uid: "sec-bad", name: "只有 refreshToken 坏", token: "plain-token", refreshToken: bad });
  await r("SEC_PRE_READYZ");                                    // 还没读明文：credFail 必须 false（不许凭空喊疼）
  store.accountSecrets(store.getAccount(secBad));               // 读路径撞开抛错 → decryptForRead 记一次
  await r("SEC_POST_READYZ");                                   // 此刻 ok:true 与 credFail:true 并存，正是要分开的两种语义
  console.log("FAILURES_AFTER_SEC " + store.decryptFailureCount());
  store.removeAccount(secBad);
  await r("SEC_CLEAR_READYZ");
  console.log("VERSION " + util.appVersion());
  const bait = preBait();                                            // 不 await：让它就在途着，压住 libuv 线程池
  const sd = await proxy.gracefulShutdown();
  console.log("SHUTDOWN " + JSON.stringify(sd));
  const pend = pendingReq();
  console.log("PENDING_REQ " + (pend.length ? pend.join("|") : "none"));   // 紧接停机之后，不经额外循环圈
  await bait;                                              // 兜住那条在途作业（drain 本该已经等过它）
  await new Promise((k) => setTimeout(k, 30));             // 给 libuv 处理 uv_close 队列的圈数，再看来回还剩什么
  // 停机后事件循环里还剩什么：FSEventWrap = rules 的热重载 watcher 还占着（它既 ref 着循环，
  // 又会持续往 libuv 线程池丢 fs 作业）。停机必须把它交出去，否则子进程只能靠 process.exit 硬退。
  console.log("RESIDUE " + (process.getActiveResourcesInfo().slice().sort().join("|") || "none"));
  process.exit(0);
})().catch((e) => { console.log("READY-THREW " + String((e && e.message) || e)); process.exit(1); });
`;

async function main() {
  fs.writeFileSync(path.join(work, "gw-parent.cjs"), PARENT_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-spawn.cjs"), SPAWN_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-stopper.cjs"), STOPPER_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-ready.cjs"), READY_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-listen.cjs"), LISTEN_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-takeover.cjs"), TAKEOVER_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-reap.cjs"), REAP_SRC, "utf8");
  // 真实用户库的「零写入」基线：只 stat，不开库
  const realDbDir = path.join(REAL_APPDATA, "AgentHub", "proxy");
  const statOrZero = (p) => { try { const s = fs.statSync(p); return s.size + "@" + Math.round(s.mtimeMs); } catch { return "absent"; } };
  const realBaseline = () => [statOrZero(path.join(realDbDir, "stats.db")), statOrZero(path.join(realDbDir, "stats.db-wal"))].join("|");
  const regValue = () => {
    const r = spawnSync("C:\\Windows\\System32\\reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"], { encoding: "utf8" });
    return (r.stdout || "") + "|status=" + r.status;
  };
  const realBefore = realBaseline();
  const regBefore = regValue();

  // ===== ⊘ 停机预算的四个数字必须仍然复合（评审 I2②）=====
  // 三段「等干净」（等监听释放 / 等在途 libuv 作业 / 等响应帧 flush）之和必须真的小于「必须退」的硬上界。
  // 旧实现是 1000 + 1000 ≥ 2000，注释却声称它小于——实测「必须退」总抢在「等干净」前面拿到决定权。
  // 四个数分处三个文件，所以把它们写进**同一条断言**：改一个忘改另一个当场变红。
  assert.strictEqual(serverMod.CLOSE_BUDGET_MS, 500, "⊘ server.stopAsync 等监听释放的预算被改动（实得 " + serverMod.CLOSE_BUDGET_MS + "）：动了它就得心头算 gateway.cjs 的 EXIT_CEILING_MS");
  assert.strictEqual(proxy.DRAIN_BUDGET_MS, 800, "⊘ drainLibuvWork 的预算被改动（实得 " + proxy.DRAIN_BUDGET_MS + "）：同上");
  assert.strictEqual(gwEntry.RESPONSE_FLUSH_MS, 300, "⊘ 响应帧 flush 窗口被改动（实得 " + gwEntry.RESPONSE_FLUSH_MS + "）：同上");
  assert.strictEqual(gwEntry.EXIT_CEILING_MS, 2000, "⊘ 硬退上界被改动（实得 " + gwEntry.EXIT_CEILING_MS + "）：同上");
  const budgetSum = serverMod.CLOSE_BUDGET_MS + proxy.DRAIN_BUDGET_MS + gwEntry.RESPONSE_FLUSH_MS;
  assert.ok(budgetSum < gwEntry.EXIT_CEILING_MS,
    "⊘ 停机预算不复合：stopAsync " + serverMod.CLOSE_BUDGET_MS + " + drain " + proxy.DRAIN_BUDGET_MS
    + " + flush " + gwEntry.RESPONSE_FLUSH_MS + " = " + budgetSum + " ≥ 硬退上界 " + gwEntry.EXIT_CEILING_MS
    + "。「必须退」会抢在「等干净」之前拿到决定权，drained/forced 这些停机结论形同虚设");
  assert.ok(gwEntry.UNCLEAN_EXIT_CODE !== 0 && gwEntry.UNCLEAN_EXIT_CODE !== null,
    "⊘ 「停不干净」的退出码不许是 0（那等于把最坏的失败形态当成通过）：实得 " + gwEntry.UNCLEAN_EXIT_CODE);
  pass(`⊘ 停机预算复合：stopAsync ${serverMod.CLOSE_BUDGET_MS} + drain ${proxy.DRAIN_BUDGET_MS} + flush ${gwEntry.RESPONSE_FLUSH_MS} = ${budgetSum} < 硬退上界 ${gwEntry.EXIT_CEILING_MS}，停不干净的退出码=${gwEntry.UNCLEAN_EXIT_CODE}`);

  // ===== ① spawn / 握手 / 认领 =====
  const r1 = await gw.start({ persistent: false });
  assert.strictEqual(r1.ok, true, "① start() 失败：" + (r1.message || ""));
  assert.strictEqual(r1.claimed, false, "① 第一次 start() 不该是认领（沙箱是空的）");
  assert.ok(alive(r1.pid), "① 子进程 pid 不活着：" + r1.pid);
  knownPids.add(r1.pid);
  const file = gw.readGatewayFile();
  assert.ok(file, "① gateway.json 不存在或不是合法 JSON（握手没落盘）");
  for (const k of ["pid", "pipe", "token", "port", "version", "startedAt", "secretBackend"]) {
    assert.ok(k in file, "① gateway.json 缺字段 " + k + "：" + JSON.stringify(Object.keys(file)));
  }
  assert.strictEqual(file.pid, r1.pid, "① gateway.json 的 pid 不是刚起的那个");
  assert.strictEqual(file.version, util.appVersion(), "① version 必须与 util.appVersion() 同源（版本比对与回收都靠它）");
  assert.strictEqual(file.port, 0, "① 子进程启动时不该自己 listen（监听决策归主进程）→ port 应为 0，实得 " + file.port);
  assert.ok(typeof file.token === "string" && file.token.length >= 32, "① token 短到可被枚举：" + file.token);
  assert.ok(["safeStorage", "v10", "plain-dev"].includes(file.secretBackend), "① secretBackend 取值异常：" + file.secretBackend);
  const residue = fs.readdirSync(path.join(SANDBOX, "AgentHub", "proxy")).filter((n) => n.includes(".tmp"));
  assert.deepStrictEqual(residue, [], "① gateway.json 的原子写留下了中转半成品：" + residue.join(", "));
  pass(`① start() 起了 pid=${r1.pid}；gateway.json 七字段齐、version=${file.version} 与 appVersion 同源、port=0（不自动 listen）、中转残留 0`);

  // 第二次 start() 必须认领同一个 pid（同进程内）
  const r2 = await gw.start({ persistent: false });
  assert.strictEqual(r2.ok, true, "① 第二次 start() 失败：" + (r2.message || ""));
  assert.strictEqual(r2.claimed, true, "① 第二次 start() 没走认领分支");
  assert.strictEqual(r2.pid, r1.pid, "① 认领到的 pid 变了 = 起了第二个网关进程");
  assert.strictEqual(readSandboxGateway(SANDBOX).pid, r1.pid, "① gateway.json 被第二个进程改写过");
  pass(`① 同进程第二次 start() → claimed:true 且 pid 不变（${r2.pid}）`);

  // 跨进程认领：另起一个 OS 进程当「重开的主 App」
  const claimReport = path.join(work, "claim.json");
  const claimer = spawnFixture("gw-parent.cjs", [BE, claimReport], { APPDATA: SANDBOX });
  await waitForFile(claimReport, 30000);
  const cr = JSON.parse(fs.readFileSync(claimReport, "utf8"));
  const claimOut = await claimer.done;
  knownPids.add(cr.pid);
  assert.strictEqual(cr.start && cr.start.ok, true, "① 跨进程认领的 start() 失败：" + claimOut.out + claimOut.err);
  assert.strictEqual(cr.start.claimed, true, "① 另一个进程没认领上，而是新起了一个：" + JSON.stringify(cr.start));
  assert.strictEqual(cr.start.pid, r1.pid, "① 跨进程认领到的 pid 与在跑的那个不同（进程数增加了）");
  assert.ok(/CLAIM pid=\d+ claimed=true/.test(claimOut.out), "① 认领探针没打印 CLAIM 行：" + claimOut.out + claimOut.err);
  pass(`① 跨进程认领：另一个主进程（pid ${cr.pid}）start() → claimed:true、pid 仍是 ${r1.pid}，进程数没增加`);

  // call() 走通子进程那张命令表（dispatch 用鸭子收集器复用 register 的 43 条，名字与实现体都不动）
  const vault = await gw.call("proxy_vault_status", {});
  assert.strictEqual(vault.driver, "node:sqlite", "① 子进程里的 SQLite 驱动不是 node:sqlite");
  assert.strictEqual(vault.encrypted, true, "① vaultOk 应为 true（plain-dev 也算有凭据后端，见 §5.7）");
  assert.ok(path.resolve(String(vault.dataDir)).startsWith(path.resolve(SANDBOX)),
    "① 子进程的数据目录不在本次沙箱内 = 它在写真实 %APPDATA%\\AgentHub：" + vault.dataDir);
  const unknown = await gw.call("proxy_not_a_real_command", {}).then(() => null, (e) => e);
  assert.ok(unknown && /未知命令/.test(unknown.message), "① 未注册的命令必须被拒，实得：" + (unknown && unknown.message));
  pass(`① call() 走通子进程命令表：proxy_vault_status → driver=${vault.driver}、dataDir 在沙箱内；未注册的命令被拒（${unknown.message}）`);

  // 事件回流：子进程 events.emit → sink（管道广播）→ 主进程 onEvent
  const got = [];
  const off = gw.onEvent((p) => got.push(p));
  fs.writeFileSync(path.join(SANDBOX, "AgentHub", "config.json"), JSON.stringify({ proxy: { port: CHILD_PORT } }), "utf8");
  const started = await gw.call("proxy_start", {});
  assert.strictEqual(started.ok, true, "① 子进程里 proxy_start 失败：" + (started.message || ""));
  assert.strictEqual(started.port, CHILD_PORT, "① 子进程监听的端口不是测试端口（必须是 19531，不许碰用户的 9527）：" + started.port);
  // 评审 I1：开始监听后必须把端口**原子回写**进 gateway.json —— 那一份盘上文件是父进程侧
  // stopAndWait 的 portFreed 与 probeResidentGateway 的端口归属唯一的真相来源。
  assert.strictEqual(Number((gw.readGatewayFile() || {}).port), CHILD_PORT,
    "① 子进程开始监听后没把端口回写进 gateway.json（实得 " + JSON.stringify((gw.readGatewayFile() || {}).port)
    + "）：port 恒为 0 时 :180 的 `portFreed = port ? … : true` 短路成常量 true，闸 ③ 的自我实现就在此处");
  for (let i = 0; i < 80 && !got.some((p) => p && p.type === "status"); i++) await sleep(50);
  assert.ok(got.some((p) => p && p.event === "proxy" && p.type === "status"),
    "① 子进程的 events.emit 没回流到主进程 onEvent（收到：" + JSON.stringify(got) + "）");
  const childHealthz = await fetch(`http://127.0.0.1:${CHILD_PORT}/healthz`).then((r) => r.json());
  assert.strictEqual(childHealthz.ok, true, "① 子进程监听后 /healthz 应答不对：" + JSON.stringify(childHealthz));
  await gw.call("proxy_stop", {});
  assert.ok(await waitForPortFree(CHILD_PORT, 5000), "① proxy_stop 之后端口 " + CHILD_PORT + " 仍有人 accept");
  let diskPortAfterStop = -1;
  for (let i = 0; i < 40; i++) {
    diskPortAfterStop = Number((gw.readGatewayFile() || {}).port);
    if (diskPortAfterStop === 0) break;
    await sleep(50);
  }
  assert.strictEqual(diskPortAfterStop, 0,
    "① proxy_stop 之后 gateway.json 的 port 必须回 0（停在监听状态也得如实落盘）：不然认领方会去接管一个空端口，实得 " + diskPortAfterStop);
  off();
  assert.strictEqual(gw.state().connected, true, "① 停掉监听之后长连接必须还在（管道 ≠ 监听，Task 5 全靠这条）");
  assert.strictEqual(gw.state().pid, r1.pid, "① state() 的内存镜像 pid 不对：" + JSON.stringify(gw.state()));
  pass(`① 事件回流打通：子进程 proxy_start → onEvent 收到 {event:'proxy',type:'status'}（${got.length} 帧）；proxy_stop 后端口释放而管道还在`);

  // ===== ② 认领双检：token 不匹配必须判 false =====
  const cur = gw.readGatewayFile();
  assert.ok(alive(cur.pid), "② 前提不成立：pid 这一检必须为真，否则 ② 退化成「进程死了」");
  assert.ok(await gw.probeAlive(cur), "② 前提不成立：原 token 下 probeAlive 就该为 true");
  const tampered = { ...cur, token: "0".repeat(String(cur.token).length) };
  fs.writeFileSync(gw.gatewayFile(), JSON.stringify(tampered, null, 2), "utf8");
  assert.ok(alive(tampered.pid), "② pid 必须仍活着（红点要落在 token 那一腿上，不是进程死了）");
  assert.strictEqual(await gw.probeAlive(tampered), false,
    "② token 不匹配却被认领成功 —— 双检退化成了 kill(pid,0) 单检，pid 复用会骗过它");
  fs.writeFileSync(gw.gatewayFile(), JSON.stringify(cur, null, 2), "utf8");
  assert.ok(await gw.probeAlive(cur), "② 改回原 token 后仍判 false —— 那这条断言根本没在验 token");
  // 管道那一腿单独也必须有牙：pid 活着（就用本测试进程自己的 pid）、token 也对，但管道名不存在
  const bogusPipe = String.raw`\\.\pipe\agenthub-gw-this-name-does-not-exist`;
  assert.strictEqual(await gw.probeAlive({ ...cur, pid: process.pid, pipe: bogusPipe }), false,
    "② pid 是活着的、管道却不存在，仍被判成在世（管道连通那一检是空的）");
  pass("② 双检有牙：同一活 pid 下 token 被改 → probeAlive false；改回 → true；管道名不存在 → false");

  // ===== ④ liveness / readiness 拆语义（独立沙箱 + 独立探针进程）=====
  const readySandbox = sandboxDir("ready");
  fs.mkdirSync(readySandbox, { recursive: true });
  const ready = await spawnFixture("gw-ready.cjs", [BE, String(PROBE_PORT)], {
    APPDATA: readySandbox, AGENT_SKILLS_HOME: path.join(work, "hub-ready"),
  }).done;
  assert.strictEqual(ready.code, 0, "④ 探针子进程非零退出（" + ready.code + "）。"
    + "退出码 3221226505 = 0xC0000409 fastfail，配 stderr 那行「Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)」"
    + "就是停机没排干 libuv 线程池上的在途作业（Task 3 收口时修掉的那条），下面 SHUTDOWN/PENDING_REQ 两行会指出是谁没落地："
    + ready.out + ready.err);
  const lineOf = (tag) => {
    const m = new RegExp("^" + tag + " (\\{.*\\})$", "m").exec(ready.out);
    assert.ok(m, "④ 探针没打印 " + tag + " 行：" + ready.out + ready.err);
    return JSON.parse(m[1]);
  };
  const eh = lineOf("EMPTY_HEALTHZ");
  const er = lineOf("EMPTY_READYZ");
  const pb = lineOf("POOL_BAD_READYZ"), pbc = lineOf("POOL_BAD_HEALTHZ"), pc = lineOf("POOL_CLEAR_READYZ");
  const sp = lineOf("SEC_PRE_READYZ"), spo = lineOf("SEC_POST_READYZ"), sc = lineOf("SEC_CLEAR_READYZ");
  const sd = lineOf("SHUTDOWN");
  const numOf = (tag) => Number(new RegExp("^" + tag + " (\\d+)$", "m").exec(ready.out)[1]);
  assert.strictEqual(eh.status, 200, "④ 空号池下 /healthz 必须 200（liveness 与号池脱钩，否则监督器会对空号池打重启循环）：" + JSON.stringify(eh));
  assert.strictEqual(eh.body.ok, true, "④ /healthz 应答体不对：" + JSON.stringify(eh.body));
  assert.strictEqual(typeof eh.body.uptime, "number", "④ /healthz 必须带 uptime（监督器要看得懂「活着多久」）：" + JSON.stringify(eh.body));
  assert.strictEqual(eh.body.version, util.appVersion(), "④ /healthz 的 version 必须与 appVersion 同源：" + JSON.stringify(eh.body));
  assert.strictEqual(er.status, 503, "④ 空号池下 /readyz 必须 503：" + JSON.stringify(er));
  assert.strictEqual(er.body.ok, false, "④ /readyz 的 ok 必须跟号池走：" + JSON.stringify(er.body));
  assert.strictEqual(er.body.credFail, false, "④ 还没有坏密文时 credFail 必须 false：" + JSON.stringify(er.body));
  // 腿一：坏 token 只经号池评估（生产里 /readyz 只看得到这条腿，没人去 accountSecrets）
  assert.strictEqual(pb.body.credFail, true,
    "④ 池里只放一个解不开 token 的号、且**只**查 /readyz，credFail 必须为 true（否则「解不开」又会被伪装成「没号」，"
    + "Task 5 的网关页就分不出该提示哪个）：" + JSON.stringify(pb.body));
  assert.strictEqual(pb.body.detail, "凭据解密失败", "④ readyz 要把原因说清楚：" + JSON.stringify(pb.body));
  assert.strictEqual(pb.status, 503, "④ 池里只有坏号时 readyz 仍应 503：" + JSON.stringify(pb));
  assert.strictEqual(pbc.status, 200, "④ 坏密文不该影响 liveness：" + JSON.stringify(pbc));
  assert.ok(numOf("FAILURES_AFTER_POOL") >= 1, "④ 号池评估这条腿没把解密失败计入累计计数：" + ready.out);
  assert.strictEqual(pc.body.credFail, false,
    "④ 坏号已从池里删掉却仍报 credFail:true —— readiness 用成了 Task 1 那条只增不减的累计计数，"
    + "用户删号/换凭据之后错误态洗不掉：" + JSON.stringify(pc.body));
  // 腿二：token 好、refreshToken 坏 —— 只有真去读明文凭据那条腿看得见它
  const gd = lineOf("GOOD_READYZ");
  assert.strictEqual(gd.status, 200, "④ 池里只有解得开的号时 /readyz 必须 200（这是腿二的基线）：" + JSON.stringify(gd));
  assert.strictEqual(gd.body.credFail, false, "④ 基线不许带 credFail：" + JSON.stringify(gd.body));
  assert.strictEqual(sp.body.credFail, false, "④ 还没人读过明文凭据，credFail 不许凭空为真：" + JSON.stringify(sp.body));
  assert.strictEqual(sp.status, 200, "④ token 解得开的号就该算可用号：" + JSON.stringify(sp));
  assert.strictEqual(spo.body.credFail, true, "④ accountSecrets 撞上坏 refreshToken 后必须计入 credFail：" + JSON.stringify(spo.body));
  assert.strictEqual(spo.body.ok, true,
    "④ ok:true 与 credFail:true 必须能并存（有可用号 + 另有解不开的凭据），Task 5 的网关页靠这两个字段分开渲染：" + JSON.stringify(spo.body));
  assert.strictEqual(spo.status, 200, "④ 有可用号时 readyz 是 200，credFail 只做旁注：" + JSON.stringify(spo));
  assert.ok(numOf("FAILURES_AFTER_SEC") > numOf("FAILURES_AFTER_POOL"),
    "④ 读明文那条腿也要累加计数（Task 1 的契约：只增不减）：" + ready.out);
  assert.strictEqual(sc.body.credFail, false, "④ 两条腿的失败都要随删号一起掉回去：" + JSON.stringify(sc.body));
  assert.strictEqual(sc.body.ok, true, "④ 删掉坏号后 /readyz 的 ok 不对：" + JSON.stringify(sc.body));
  // 停机排干：这一条红 = 探针会（概率性地）以 0xC0000409 fastfail 退出，也就是上面那条非零退出断言的成因
  assert.strictEqual(sd.ok, true, "④ gracefulShutdown 没回 ok:true：" + JSON.stringify(sd));
  assert.strictEqual(sd.drained, true, "④ 停机没排干 libuv 线程池上的在途作业（drained:" + JSON.stringify(sd.drained)
    + "）：带着在途 FSReqCallback 退进程会撞 uv_async_send 的 UV_HANDLE_CLOSING 断言 → 0xC0000409：" + JSON.stringify(sd));
  // 停机质量两个新字段（评审 I2①）：stopAsync 的「等没等到」与「刚释放的是哪个端口」必须一路可见
  assert.strictEqual(sd.forced, false, "④ 监听没在 CLOSE_BUDGET_MS 内释放（forced:" + JSON.stringify(sd.forced)
    + "）却仍被算成停机成功 —— 旧实现的 stopAsync 没这个字段，两条分支回同一个 {ok:true}：" + JSON.stringify(sd));
  assert.strictEqual(sd.port, PROBE_PORT, "④ gracefulShutdown 必须把刚释放的端口并回返回值（父进程侧 stopAndWait 的 portFreed 靠它）：" + JSON.stringify(sd));
  // detail 与状态码必须自相洽（评审 minor①：这是给 Task 5 错误态渲染用的字段）
  assert.strictEqual(er.body.detail, "号池无可用账号", "④ 503 时 detail 该说没号：" + JSON.stringify(er.body));
  assert.strictEqual(gd.body.detail, "就绪",
    "④ /readyz 已经 200 了 detail 还写着「号池无可用账号」= 与状态码自相矛盾，Task 5 的错误态渲染会拿到冲突字段：" + JSON.stringify(gd.body));
  const pend = /^PENDING_REQ (.+)$/m.exec(ready.out);
  assert.ok(pend, "④ 探针没打印 PENDING_REQ 行：" + ready.out + ready.err);
  assert.strictEqual(pend[1], "none", "④ 停机之后进程里还压在异步作业：" + pend[1]);
  const res = /^RESIDUE (.+)$/m.exec(ready.out);
  assert.ok(res, "④ 探针没打印 RESIDUE 行：" + ready.out + ready.err);
  assert.ok(!/FSEventWrap/.test(res[1]),
    "④ 停机后 rules 的热重载 watcher（FSEventWrap）还在进程里：" + res[1]
    + "。它既 ref 着事件循环（子进程只能靠 process.exit 硬退），又会持续往 libuv 线程池丢 fs 作业，"
    + "而那些作业正是在 exit 之后被回报到已关闭的 uv_async_t 上的东西");
  assert.ok(!/Req/.test(res[1]), "④ 停机后仍有在途 libuv 请求：" + res[1]);
  pass(`④ 拆语义生效：空号池 /healthz=200(ok/uptime/version) 而 /readyz=503；坏 token 只经号池评估就点亮 credFail，`
    + `坏 refreshToken 只经读明文那条腿点亮（此时 ok:true 与 credFail:true 并存）；两条腿的号删掉后 credFail 都掉回 false `
    + `而累计计数仍递增（${numOf("FAILURES_AFTER_POOL")} → ${numOf("FAILURES_AFTER_SEC")}）；`
    + `停机 drained:true / PENDING_REQ none / RESIDUE 无 FSEventWrap，探针 exit 0`);

  // ===== ③ 看门狗（两个分支，各自独立沙箱；一律 detached 起，见夹具 B 的注释）=====
  const npSandbox = sandboxDir("np");
  fs.mkdirSync(npSandbox, { recursive: true });
  const npReport = path.join(work, "np.json");
  const np = spawnFixture("gw-spawn.cjs", [BE, "0", npReport], {
    APPDATA: npSandbox, AGENT_SKILLS_HOME: path.join(work, "hub-np"),
  });
  const npOut = await np.done;
  assert.strictEqual(npOut.code, 0, "③ 中间父进程没能把子进程带起来：" + npOut.out + npOut.err);
  await waitForFile(npReport, 30000);
  const npGw = readSandboxGateway(npSandbox);
  assert.ok(npGw && npGw.pid, "③ 非常驻场景没拿到子进程 pid（gateway.json 没落盘）");
  knownPids.add(Number(npGw.pid));
  const t0 = Date.now();
  assert.ok(alive(Number(npGw.pid)), "③ 父进程一退子进程就没了 —— 那不是「父进程没了才自杀」，是随时会死");
  await sleep(800);
  assert.ok(alive(Number(npGw.pid)), "③ 父进程退出后 0.8 s 内子进程就自杀了（看门狗周期是 5 s，不该见父即退）");
  let died = -1;
  for (let i = 0; i < 130; i++) {
    if (!alive(Number(npGw.pid))) { died = Date.now() - t0; break; }
    await sleep(100);
  }
  assert.ok(died >= 0, "③ persistent=off 时子进程成了孤儿（脱离父进程后 13 s 仍活着，看门狗没生效）");
  assert.ok(died < 12000, "③ 子进程自杀太慢（" + died + "ms）：看门狗 5 s 一个周期就该收掉");
  const npLog = fs.readFileSync(path.join(npSandbox, "AgentHub", "proxy", "logs", "gateway.log"), "utf8");
  assert.match(npLog, /"reason":"parent-exit"/, "③ 日志里没有 parent-exit 这条退出的痕迹：" + npLog.slice(0, 400));
  assert.match(npLog, / boot .*"version":"[\d.]+.*"secretBackend":"/, "③ boot 留痕不对（必须带 version 与 secretBackend）：" + npLog.slice(0, 400));
  pass(`③ persistent=off：中间父进程（pid ${JSON.parse(fs.readFileSync(npReport, "utf8")).pid}）退出后 ${died} ms 子进程自己收掉，日志留痕 reason=parent-exit`);

  // 常驻：同一个父退出后必须**不**自杀；停它只由「另一个进程」经 probeAlive + stopAndWait 这条唯一出口做
  const pSandbox = sandboxDir("p");
  fs.mkdirSync(pSandbox, { recursive: true });
  const pReport = path.join(work, "p.json");
  const pRun = spawnFixture("gw-spawn.cjs", [BE, "1", pReport], {
    APPDATA: pSandbox, AGENT_SKILLS_HOME: path.join(work, "hub-p"),
  });
  const pOut = await pRun.done;
  assert.strictEqual(pOut.code, 0, "③ 常驻场景的中间父进程失败：" + pOut.out + pOut.err);
  await waitForFile(pReport, 30000);
  const pGw = readSandboxGateway(pSandbox);
  assert.ok(pGw && pGw.pid, "③ 常驻场景没拿到子进程 pid");
  knownPids.add(Number(pGw.pid));
  await sleep(8000);                     // 明显大于看门狗周期（5 s）：常驻分支必须活过至少一个 tick
  assert.ok(alive(Number(pGw.pid)),
    "③ persistent=true 分支子进程自杀了 —— detach 正是本期设计目标，这条红说明常驻被当成了非常驻");
  const stopper = await spawnFixture("gw-stopper.cjs", [BE], {
    APPDATA: pSandbox, AGENT_SKILLS_HOME: path.join(work, "hub-p2"),
  }).done;
  assert.ok(/PROBE alive=true claim=true pid=\d+/.test(stopper.out),
    "③ 新进程没认领上这个常驻网关（probeAlive / claim 必须都为真）：" + stopper.out + stopper.err);
  assert.ok(new RegExp("pid=" + pGw.pid).test(stopper.out), "③ 认领到的 pid 与在跑的那个不同：" + stopper.out);
  assert.strictEqual(stopper.code, 0, "③ stopAndWait 没能停掉常驻子进程：" + stopper.out + stopper.err);
  assert.ok(/STOPPED stopped=true portFreed=true/.test(stopper.out), "③ stopAndWait 回报不对：" + stopper.out);
  assert.ok(!alive(Number(pGw.pid)), "③ stopAndWait 返回 stopped:true 但进程还在（谎报）");
  pass(`③ persistent=on：脱离父进程后活过 8 s（> 看门狗周期），再由另一个进程 probeAlive→claim→stopAndWait 停干净（stopped/portFreed 均 true）`);

  // ===== ③-b detach-keep 有牙（minor④）：常驻 + **真在监听** + 父进程没了 → 不退出、留痕、端口在盘上看得见 =====
  // 旧用例（上面那条 persistent=on）的子进程不监听，把 detach-keep 整支删掉判据仍绿；这一条让它真在监听。
  const keepSandbox = sandboxDir("keep");
  fs.mkdirSync(keepSandbox, { recursive: true });
  const keepReport = path.join(work, "keep.json");
  const keepRun = await spawnFixture("gw-listen.cjs", [BE, "1", String(KEEP_PORT), keepReport], {
    APPDATA: keepSandbox, AGENT_SKILLS_HOME: path.join(work, "hub-keep"),
  }).done;
  assert.strictEqual(keepRun.code, 0, "③-b 夹具没把常驻子进程带到监听：" + keepRun.out + keepRun.err);
  const kr = JSON.parse(fs.readFileSync(keepReport, "utf8"));
  knownPids.add(Number(kr.gatewayPid));
  assert.ok(alive(Number(kr.gatewayPid)), "③-b 前提不成立：常驻子进程不在");
  assert.strictEqual(Number(kr.diskPort), KEEP_PORT,
    "③-b 子进程开始监听后没把端口回写进 gateway.json（跨进程看到的第二份证据，评审 I1）：实得 " + kr.diskPort);
  await sleep(8000);
  assert.ok(alive(Number(kr.gatewayPid)),
    "③-b persistent=on 且正在监听时父进程没了，子进程却退了 —— detach（本期设计目标）失效");
  const keepLog = await waitForLogLineIn(keepSandbox, /detach-keep \{"reason":"parent-exit"/, 12000);
  assert.ok(keepLog.line, "③-b 日志里没有 detach-keep 那一行 = detach 分支压根没执行过（补这条就是不给「看起来有测」留错觉）："
    + keepLog.text.slice(-400));
  const keepStop = await spawnFixture("gw-stopper.cjs", [BE], {
    APPDATA: keepSandbox, AGENT_SKILLS_HOME: path.join(work, "hub-keep2"),
  }).done;
  assert.strictEqual(keepStop.code, 0, "③-b 唯一出口 stopAndWait 停不掉「常驻 + 在监听」的网关（Task 7 的互锁会被它卡死）：" + keepStop.out + keepStop.err);
  assert.ok(/STOPPED stopped=true portFreed=true drained=true forced=false/.test(keepStop.out),
    "③-b 停机结论没回给父进程（评审 I2③：drained/forced 必须随 gateway_shutdown 的响应进 stopAndWait 的返回值）。"
    + "旧代码在 dispatch 还没 resolve 时就同步 srvRef.close()，destroy 掉 socket 把响应帧一起带走了：" + keepStop.out);
  assert.ok(!(await gw.probePortBusy(KEEP_PORT)), "③-b 报了 portFreed:true 但端口 " + KEEP_PORT + " 还有人 accept（谎报）");
  pass(`③-b detach 有牙：常驻 + 真监听下父进程没了 → 活过 8 s 且留 detach-keep（diskPort=${kr.diskPort}）；另一个进程经唯一出口停干净并看见 ${keepStop.out.trim().split("\n")[1]}`);

  // ===== ③-c exe-gone 在常驻形态下必须还能收摊（评审 I4）=====
  // 旧代码 gracefulExit 第一句对**任何** reason 都 detach-return，于是 startWatchdog 里的 exe-gone
  // 恰好被同一条保护吞掉；而升级/卸载删安装目录、NSIS 最需要映像解锁的时刻正是它唯一能起作用的时候。
  const exeSandbox = sandboxDir("exegone");
  fs.mkdirSync(exeSandbox, { recursive: true });
  const exeReport = path.join(work, "exegone.json");
  const GONE_EXE = path.join(work, "no-such-exe-dir", "AgentHub.exe");
  const exeRun = await spawnFixture("gw-listen.cjs", [BE, "1", String(EXE_PORT), exeReport, GONE_EXE], {
    APPDATA: exeSandbox, AGENT_SKILLS_HOME: path.join(work, "hub-exe"),
  }).done;
  assert.strictEqual(exeRun.code, 0, "③-c 夹具没把子进程带到监听：" + exeRun.out + exeRun.err);
  const xr = JSON.parse(fs.readFileSync(exeReport, "utf8"));
  knownPids.add(Number(xr.gatewayPid));
  assert.ok(alive(Number(xr.gatewayPid)), "③-c 前提不成立：进程不在");
  let exeDied = -1;
  const exeT0 = Date.now();
  for (let i = 0; i < 200; i++) {
    if (!alive(Number(xr.gatewayPid))) { exeDied = Date.now() - exeT0; break; }
    await sleep(100);
  }
  const exeLog = await waitForLogLineIn(exeSandbox, /exit \{"reason":"exe-gone"/, 4000);
  assert.ok(exeDied >= 0,
    "③-c exe-gone 在常驻形态下永久失效：exe 路径已不存在、进程正在监听且 persistent=on，20 s 了还活着（detach 保护把它吞了）。"
    + "两规则冲突时应当 reason 优先：" + JSON.stringify(xr));
  assert.ok(exeLog.line, "③-c 进程退了，但日志里没有 reason=exe-gone（那退的不是评审 I4 那条路）：" + exeLog.text.slice(-400));
  assert.ok(!/shutdown-unclean/.test(exeLog.text),
    "③-c exe-gone 那次停机没排干净（有 shutdown-unclean）——这一支的退出码必须是 UNCLEAN_EXIT_CODE 而不是 0，父进程在 child-exit 看得见：" + exeLog.text.slice(-400));
  assert.ok(!(await gw.probePortBusy(EXE_PORT)), "③-c exe-gone 之后端口 " + EXE_PORT + " 仍被占着");
  pass(`③-c exe-gone 有牙：常驻 + 真监听 + exe 映像不在 → ${exeDied} ms 内自己收摊（reason=exe-gone、端口释放、排干净）`);

  // ===== ⑤ 日志落盘与轮转（gateway-log 自身的判据） =====
  const lgDir = sandboxDir("log");
  fs.mkdirSync(lgDir, { recursive: true });
  const lg = spawnSync(process.execPath, ["-e", `"use strict";
const path=require("node:path"),fs=require("node:fs");
const log=require(${JSON.stringify(path.join(BE, "gateway-log.cjs").split(path.win32.sep).join("/"))});
for(let i=0;i<400;i++) log.line("kind-"+i,{a:"x".repeat(8192)});
const d=${JSON.stringify(lgDir.split(path.win32.sep).join("/"))};
fs.writeFileSync(path.join(d,"names.txt"), fs.readdirSync(path.join(d,"AgentHub","proxy","logs")).sort().join(","),"utf8");
`], { env: Object.assign({}, process.env, { APPDATA: lgDir, AGENT_SKILLS_HOME: path.join(work, "hub-log") }), encoding: "utf8" });
  assert.strictEqual(lg.status, 0, "⑤ 日志自测子进程失败：" + lg.stdout + lg.stderr);
  const names = fs.readFileSync(path.join(lgDir, "names.txt"), "utf8").split(",");
  assert.ok(names.includes("gateway.log"), "⑤ 没写出 gateway.log：" + names.join(","));
  assert.ok(names.includes("gateway.log.1"), "⑤ 超 2 MB 没轮转出 gateway.log.1：" + names.join(","));
  assert.deepStrictEqual(names.filter((n) => /^gateway\.log\.\d+$/.test(n)), ["gateway.log.1"],
    "⑤ 轮转只许保留 1 份旧档：" + names.join(","));
  const logSize = fs.statSync(path.join(lgDir, "AgentHub", "proxy", "logs", "gateway.log")).size;
  assert.ok(logSize <= log.MAX_BYTES + 64 * 1024, "⑤ 轮转后当前档仍远超上限：" + logSize);
  pass(`⑤ 日志：400 行 × 8 KB 触发轮转，目录里只有 gateway.log 与 gateway.log.1（当前档 ${logSize} B ≤ 上限 ${log.MAX_BYTES} B + 一档余量）`);

  // ===== ⑥ 陈旧 pid 回收重启 + 停机留痕 + 收尾卫生核对 =====
  const stop1 = await gw.stopAndWait({ timeoutMs: 8000 });
  assert.strictEqual(stop1.stopped, true, "⑥ 收尾 stopAndWait 失败：" + stop1.message);
  assert.ok(!alive(r1.pid), "⑥ stopAndWait 返回 stopped:true 但 pid " + r1.pid + " 还在");
  assert.ok(readSandboxGateway(SANDBOX), "⑥ 子进程退出后握手文件应当还在（由下一个 start() 负责回收）");
  const firstExit = await waitForLogLine(/child-exit \{"code":\d+/, 4000);
  assert.ok(firstExit.line, "⑥ 父进程没记下子进程的退出码（日志里没有 child-exit 那条）：" + firstExit.text.slice(-400));
  const r4 = await gw.start({ persistent: false });
  assert.strictEqual(r4.ok, true, "⑥ 死 pid 场景下 start() 失败：" + (r4.message || ""));
  assert.strictEqual(r4.claimed, false, "⑥ 握手文件的 pid 已死，必须回收后新起而不是认领");
  assert.notStrictEqual(r4.pid, r1.pid, "⑥ 回收后 pid 没变 → 认领到了已死的进程");
  knownPids.add(r4.pid);
  const stop2 = await gw.stopAndWait({ timeoutMs: 8000 });
  assert.strictEqual(stop2.stopped, true, "⑥ 回收重启后的收尾 stopAndWait 失败：" + stop2.message);
  // 子进程**真停机**的两条留痕：盯的是生产那条停机路径（④ 是夹具，Task 7 的装更互锁复用同一个
  // gracefulShutdown），退出码非 0 就是「退出时 libuv 线程池上还压在途作业」→ 0xC0000409 fastfail。
  const allLog = await waitForLogLine(/child-exit \{"code":\d+[\s\S]*child-exit \{"code":\d+/, 4000);
  const codes = [...allLog.text.matchAll(/child-exit \{"code":(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(codes.length >= 2, "⑥ 两次停机只记下 " + codes.length + " 个退出码：" + allLog.text.slice(-400));
  assert.deepStrictEqual(codes.filter((c) => c !== 0), [],
    "⑥ 子进程退出码非 0：" + JSON.stringify(codes)
    + "。3221226505 = 0xC0000409 fastfail，成因见 ④ 的 SHUTDOWN/PENDING_REQ 两条（停机没排干在途异步作业）");
  const drained = [...allLog.text.matchAll(/shutdown-done \{"drained":(true|false),"forced":(true|false)/g)];
  assert.ok(drained.length >= 2, "⑥ 子进程没记下优雅停机留痕（shutdown-done 带 drained/forced）：" + allLog.text.slice(-400));
  assert.deepStrictEqual(drained.filter((d) => d[1] !== "true").map((d) => d[0]), [], "⑥ 子进程停机没排干在途作业：" + JSON.stringify(drained.map((d) => d[0])));
  assert.deepStrictEqual(drained.filter((d) => d[2] !== "false").map((d) => d[0]), [],
    "⑥ 有一次停机没在预算内等到监听释放（forced:true），却被当成正常收摊：" + JSON.stringify(drained.map((d) => d[0])));
  // —— reap 的两条牙齿（minor④：这一处过去「删掉判据仍绿」）——
  const reapLine = await waitForLogLine(new RegExp("reap-stale \\{\"pid\":" + r1.pid), 3000);
  assert.ok(reapLine.line, "⑥ 日志里没有点名 pid=" + r1.pid + " 的 reap-stale —— 回收陈旧握手文件那一步压根没执行（把 reap() 整段删掉本闸今天照样绿）："
    + reapLine.text.slice(-400));
  // 「回收绝不按 pid 杀进程」：握手文件里写一个**活着但与本任务无关**的 pid，start() 之后它必须还在
  const victim = spawn(process.execPath, ["-e", "setTimeout(function () { }, 120000)"], { cwd: work, stdio: "ignore", windowsHide: true });
  knownPids.add(victim.pid);
  await sleep(400);
  assert.ok(alive(victim.pid), "⑥ 无辜进程夹具没起来（本条前提不成立）");
  const reapSandbox = sandboxDir("reap2");
  fs.mkdirSync(path.join(reapSandbox, "AgentHub", "proxy"), { recursive: true });
  fs.writeFileSync(path.join(reapSandbox, "AgentHub", "proxy", "gateway.json"), JSON.stringify({
    pid: victim.pid, pipe: String.raw`\\.\pipe\agenthub-gw-foreign-${process.pid}`, token: "e".repeat(48),
    port: 0, version: util.appVersion(), startedAt: Date.now(), secretBackend: "plain-dev",
  }), "utf8");
  const reapReport = path.join(work, "reap.json");
  const reapRun = await spawnFixture("gw-reap.cjs", [BE, reapReport, String(victim.pid)], {
    APPDATA: reapSandbox, AGENT_SKILLS_HOME: path.join(work, "hub-reap"),
  }).done;
  assert.strictEqual(reapRun.code, 0, "⑥ 回收夹具跑挂了：" + reapRun.out + reapRun.err);
  const rp = JSON.parse(fs.readFileSync(reapReport, "utf8"));
  assert.strictEqual(rp.ok, true, "⑥ 握手文件的 pid 活着但双检不过（那是别人的进程）时必须回收后新起：" + JSON.stringify(rp));
  assert.strictEqual(rp.claimed, false, "⑥ 双检没过却被认领上了：" + JSON.stringify(rp));
  assert.ok(alive(victim.pid),
    "⑥ 回收陈旧握手文件时把那个 pid 的进程杀了 —— 能走到这条路的进程恰恰是「活着但认证不过」的，pid 复用场景下那是**别人的**进程"
    + "（一期踩过宽匹配杀进程的坑）。回收只许把 gateway.json 挪走：" + JSON.stringify(rp));
  pass(`⑥ 陈旧 pid → 回收 + 新起（${r1.pid} → ${r4.pid}），再次 stopAndWait 停干净：${stop2.message}；`
    + `两次停机子进程退出码全 0、shutdown-done drained:true/forced:false（共 ${codes.length} 次）；`
    + `reap-stale 点名 ${rp.beforePid} 且那个无辜进程仍活着（${victim.pid}）`);

  // ===== ⑥b portFreed 必须能说「不」（评审 I1：它是 Task 7 互锁唯一出口的那一半判据）=====
  // 场景按评审点名的那条造：pid 已死（⑥ 刚停掉的 r4），端口却被**另一个进程**占着。
  // 修法前这里恒为 true（port 恒 0 → 三元短路），也就是说这条闸自我实现、不可能红。
  const busy = net.createServer();
  await new Promise((r) => busy.listen(BUSY_PORT, "127.0.0.1", r));
  fs.writeFileSync(gw.gatewayFile(), JSON.stringify({
    pid: r4.pid, pipe: String.raw`\\.\pipe\agenthub-gw-already-dead-${process.pid}`, token: "f".repeat(48),
    port: BUSY_PORT, version: util.appVersion(), startedAt: Date.now(), secretBackend: "plain-dev",
  }), "utf8");
  assert.ok(!alive(r4.pid), "⑥b 前提不成立：那个 pid 必须已经死了（否则测的不是「进程没了但端口还在」）");
  const stopBusy = await gw.stopAndWait({ timeoutMs: 2000 });
  busy.close();
  assert.strictEqual(stopBusy.stopped, true, "⑥b 前提不成立：pid 已死却报 stopped:false：" + JSON.stringify(stopBusy));
  assert.strictEqual(stopBusy.portFreed, false,
    "⑥b pid 已死、端口 " + BUSY_PORT + " 明显还被本次测试自己起的那个 listener 占着，stopAndWait 却报 portFreed:true —— "
    + "这条判据自我实现（Number(cur.port) 恒 0），Task 7 的装更互锁拿它当唯一出口就是拿一个真没有的判据放行：" + JSON.stringify(stopBusy));
  assert.match(String(stopBusy.message), /仍被占用/, "⑥b 端口没释放时 message 必须说清楚：" + stopBusy.message);
  pass(`⑥b portFreed 有牙：pid ${r4.pid} 已死 + 端口 ${BUSY_PORT} 被别的进程占着 → portFreed=false（「${stopBusy.message}」）`);

  // ===== ⑦ EADDRINUSE 的占用者判定（规格 §七.5：占用者是常驻网关时不许再报「请更换端口」）=====
  // 用一个真的监听把端口占住，再从本进程调 server.start()：
  //   gateway.json 指向同一个端口且双检通过 → {ok:true, claimed:true}（Task 6 的认领路径靠这条不报错）
  //   gateway.json 端口对不上 → 保持原文案「已被占用，请更换端口」
  const server = require(path.join(BE, "proxy", "server.cjs"));
  const holder = net.createServer();
  const HOLD_PORT = PROBE_PORT + 3;
  await new Promise((r) => holder.listen(HOLD_PORT, "127.0.0.1", r));
  const takeoverPipe = String.raw`\\.\pipe\agenthub-gw-takeover-${process.pid}`;
  const takeoverToken = "takeover-token-for-assertion";
  const tSrv = await gatewayPipe.serve({
    token: takeoverToken, pipePath: takeoverPipe,
    dispatch: (cmd, args) => (cmd === "gateway_echo" ? { v: String((args && args.v) || "") } : { ok: false }),
  });
  const gwFile = gw.gatewayFile();
  const settingsStub = () => ({
    port: HOLD_PORT, bind: "127.0.0.1", rateLimitPerMin: 60, concurrency: 2, routeStrategy: "smart",
    fixedChannel: "trae", modelOverrides: {}, debugStatus: false,
  });
  fs.writeFileSync(gwFile, JSON.stringify({ pid: process.pid, pipe: takeoverPipe, token: takeoverToken, port: HOLD_PORT, version: util.appVersion(), startedAt: Date.now(), secretBackend: "plain-dev" }), "utf8");
  const take = await server.start(settingsStub);
  assert.strictEqual(take.ok, true, "⑦ 占用者是已认证的常驻网关时不该报错：" + JSON.stringify(take));
  assert.strictEqual(take.claimed, true, "⑦ 必须回 claimed:true（否则 Task 6 的认领路径会把它当成自己起了监听）：" + JSON.stringify(take));
  assert.strictEqual(take.port, HOLD_PORT, "⑦ 接管回来的端口不对：" + JSON.stringify(take));
  fs.writeFileSync(gwFile, JSON.stringify({ pid: process.pid, pipe: takeoverPipe, token: takeoverToken, port: HOLD_PORT + 1, version: util.appVersion(), startedAt: Date.now(), secretBackend: "plain-dev" }), "utf8");
  const other = await server.start(settingsStub);
  assert.strictEqual(other.ok, false, "⑦ 占用者不是同一台常驻网关时必须报错：" + JSON.stringify(other));
  assert.match(String(other.message), /已被占用，请更换端口/, "⑦ 端口归属判错时文案必须保持原样：" + other.message);
  holder.close();
  tSrv.close();
  pass(`⑦ EADDRINUSE 分得开：gateway.json 端口一致且双检通过 → {ok:true,claimed:true}；端口对不上 → 「${other.message}」`);

  // ===== ⑦-b 端到端接管（评审 I3）：一台**真子进程**在监听，第二个进程调 proxy_start =====
  // 上面 ⑦ 测的是**判定函数**（手写 port + 一个 net.createServer()）；简报 Step 6 针对的场景是
  // 「真常驻网关占着端口时 proxy_start 不报错」，那条链在 I1 落地前根本走不到（port 恒 0 → 第一道门恒假）。
  const toSandbox = sandboxDir("takeover");
  fs.mkdirSync(toSandbox, { recursive: true });
  const toReport = path.join(work, "takeover.json");
  const toRun = await spawnFixture("gw-takeover.cjs", [BE, toReport, String(TAKEOVER_PORT)], {
    APPDATA: toSandbox, AGENT_SKILLS_HOME: path.join(work, "hub-takeover"),
  }).done;
  assert.strictEqual(toRun.code, 0, "⑦-b 端到端接管夹具跑挂了：" + toRun.out + toRun.err);
  const to = JSON.parse(fs.readFileSync(toReport, "utf8"));
  assert.strictEqual(Number(to.startedPort), TAKEOVER_PORT, "⑦-b 前提不成立：那台真子进程没在监听：" + JSON.stringify(to));
  assert.strictEqual(Number(to.diskPort), TAKEOVER_PORT,
    "⑦-b 真子进程没把监听端口回写进 gateway.json（评审 I1）→ probeResidentGateway 的第一道门 Number(cur.port)===port 恒不成立，"
    + "整条接管分支在生产形态不可能走到：" + JSON.stringify(to));
  assert.strictEqual(to.take && to.take.ok, true,
    "⑦-b 端口被**真常驻网关**占着时 proxy_start 不许报错（简报 Step 6 的端到端场景）：" + JSON.stringify(to.take));
  assert.strictEqual(to.take.claimed, true, "⑦-b 必须回 claimed:true，否则调用方会以为是自己起了监听：" + JSON.stringify(to.take));
  assert.strictEqual(to.localRunning, false,
    "⑦-b claimed 之后本进程其实什么都没监听（server.status().running 必须 false，这就是「接管 ≠ 本机监听」的形式）：" + JSON.stringify(to));
  assert.strictEqual(to.restoreOnLaunch, false,
    "⑦-b claimed 分支把 rememberRunning(true) 算成了本机监听（评审 I3）：配置里记下「网关开着」而本进程什么都没监听，"
    + "下次开机或别的进程据此判断就是谎报的恢复语义：" + JSON.stringify(to));
  assert.strictEqual(to.stop.stopped, true, "⑦-b 收尾没停掉那台真子进程：" + JSON.stringify(to.stop));
  assert.strictEqual(to.stop.drained, true, "⑦-b 真监听状态下的停机结论没排干净、或压根没回给父进程：" + JSON.stringify(to.stop));
  pass(`⑦-b 端到端接管成立：真子进程监听 ${to.startedPort} 且 port 已回写盘 → 第二个进程 proxy_start 得 {ok:true,claimed:true}、`
    + `本机 running=false、restoreOnLaunch 仍 ${to.restoreOnLaunch}；停机 drained=${to.stop.drained} forced=${to.stop.forced}`);

  // ===== ⑧ 收尾卫生核对（探针三件套 + 第五条）=====
  assert.strictEqual(realBaseline(), realBefore,
    "⑧ 真实 %APPDATA%\\AgentHub\\proxy\\stats.db 被本次运行写动了（size@mtime 变了）：\n  before " + realBefore + "\n  after  " + realBaseline());
  assert.strictEqual(regValue(), regBefore, "⑧ HKCU Run 项被本次运行改动了（探针卫生第五条）");
  pass("⑧ 收尾：真实 stats.db / -wal 的 size@mtime 未变（零写入直接证据）、HKCU Run 项未变");
}

main().then(() => {
  cleanupOwnProcesses();
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows 偶发 EBUSY，交给系统回收 */ }
  console.log(`OK 生命周期基座四组判据全通过（共 ${steps} 项）`);
}).catch((e) => {
  cleanupOwnProcesses();
  console.log("临时目录保留供排查：" + work);
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
