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
//  ⑨ 命令通道硬化（Task 4，简报五条逐条落）：
//     ⑨a 配对——真子进程上并发 30 条 proxy_status + 5 条 gateway_echo，每条只认自己的响应（echo 的 v 逐条
//        不同 = 串号必红），proxy_status 的 uptime 按请求序号排必须单调不减且不恒为 0；桩服务上再补一条
//        「完成顺序确实被人为打乱了」的反证，否则这条配对是在顺序返回上自我实现的。
//     ⑨b 事件回流——真调用点 credits.cjs:128 的 {type:"credits"} 必须回到 onEvent；再用桩构造
//        「响应帧先到、事件帧后到」那一半（真代码只有「事件先」这一半），两种顺序都要投递成功。
//     ⑨c 超时——挂 12 s 的**普通**命令必须在 proto.DEFAULT_TIMEOUT_MS(10 s) 报 timeout（Task 3 的
//        「默认永不超时 + writeFrame 静默丢帧」组合起来就是永久悬挂，这条是它的对立面）；
//        NO_TIMEOUT_CMDS 三条不被误拒（用 proxy_checkin_run 的桩，不打真上游）；超时后连接仍可用、
//        迟到的响应帧被丢弃而不是把已判死的 id 复活。writeFrame 四态逐态钉死（Task 5 刀 1）：
//        "written"/"queued"（背压，帧已进队列）/"unwritable"/"unencodable"——编帧失败（一字节没入队）
//        必须与背压分开，两端都要立即改判：req 侧立即 reject(notRetried)、res 侧补一条必可编码的错误
//        响应，客户端拿确定性失败而不是干等 10 s，服务端留 pipe-frame-encode-error。
//     ⑨d 队列有界——夹具进程里一次压 200 条：恰好 200-MAX_PENDING 条被**立即**拒（含「队列已满」+
//        当前 pending 数 + 上界），服务端同时在飞绝不超过 MAX_PENDING，该进程 rss 增长 < 20 MB。
//     ⑨e 不重放——断连时 in-flight 的 proxy_pool 必须 reject 且带 notRetried；重连后再发**别的**命令，
//        服务端 proxy_pool 的调用计数必须还是 1；随后显式再调一次必须变 2（证明那个计数是活的，
//        不是恒成立的表达式）。实测依据见 gateway-pipe.cjs 的注释（pool.cjs 的 poolAccounts 会回写派生复活）。
//     ⑨f 溢出断连（评审 I1：简报 Step 2 点名的硬化项，此前**全仓没有一条测试**触这条路径）——
//        ⑨f-1 服务端：raw 对端灌一条超过 MAX_FRAME_BYTES 且永不结束的巨帧 → 那一条连接必须被判死、
//             日志留 pipe-overflow、尾巴上偷偷接的那个合法帧不许被「截断解析后继续用」而回话，
//             同一服务上另一条已建立的连接必须照常应答（判死不许判过头）——证人是**溢出之前**就在的
//             那条连接（Task 5 刀 1：过去用溢出之后新建的连接验，「把 clients 全 destroy」的判过头
//             变异两腿都绿）；溢出之后新建的连接也要通（服务本身没被拖坏，两个属性分开钉）；
//        ⑨f-2 客户端：对端推来一条**永不结束**的超限巨帧（raw 服务端，理由见该处注释：合法的一整条
//             8 MB 帧会被一次 read 全拿到并正常解析，broadcast 造不出确定性的溢出）→ 那条**免超时**的
//             在途命令必须被 reject(notRetried)，它没有 per-call 上界，溢出断连是唯一的结论来源；
//             日志留 pipe-client-overflow、连接状态跟着变 false（自带 6 s 看门狗区分 hung / resolved）。
//     ⑨g 事件帧也有界（评审 I2，规格 §5.2「队列不得无界……避免主 App 卡死时子进程堆内存」）——夹具 I：
//        一条认证后**一个字节都不读**的连接（= 主 App 卡死而连接还挂着）+ 200 × 256 KB 的事件帧广播：
//        被送进子进程发送队列的字节必须是有界的个位数帧（不是 50 MB）、rss/external 增长有上界、
//        日志逐条 event-frame-dropped{reason:"backpressure"}（计数判据 JSON 解析，不钉字段书写顺序）；
//        且这条连接没被判死（同一条连接上随后投的命令帧照样拿回响应）、另一条会读的连接事后仍收到
//        普通事件帧（丢 ≠ 一律不投递）。关键事件不在此列（Task 5 刀 1）：oauth-done 这类 CRITICAL_EVENTS
//        是 UI 等待态的唯一出口，背压时也必须送达——风暴中广播一条 oauth-done，对端复活后必须收到它；
//        把关键帧也按普通帧丢的变异当场红。dropped 计数不许含关键事件。夹具上报的 dispatches 必须被消费。
//     ⑨h 客户端早退的形状（评审 minor）：gateway-client.call() 在压根没连接时回的那一条也必须带
//        notRetried + command，与管道层四类失败同形——Task 5 的转发体按标记分流才不会再漏一支。
//     ⑨i 跨连接在飞总账（Task 5 刀 1，规格 §5.2 的目的状语在多连接下要成立）：MAX_PENDING 只是
//        每连接的账，k 条认证连接各 64 = k×64。连接 1 顶满 proto.MAX_TOTAL_PENDING 条在飞后，
//        连接 2 的下一条必须**当场**被拒（业务失败形状：命令从未被派发，重试语义留给调用方）、
//        服务端在飞峰值不许超总账、既有连接上的在飞命令不受连坐、总账清零后连接 2 立刻可用。
//  ⑧ 收尾卫生：真实 %APPDATA%\AgentHub\proxy\stats.db 零写入、HKCU Run 项未变。
//
// `--bench` 只跑性能回归（简报 Step 3）：proxy_pool 单次往返的中位数 / p90 / p95 / min / max 必须 < 30 ms，
// 并给出跨进程那部分开销的归因（同一条命令在子进程内本地执行的耗时、以及空载 gateway_echo 的往返）。
// 单独跑是因为它跟断言组无关，且要往沙箱库里播 40 个号。
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
const PAIR_PORT = 19538;                              // ⑨ 配对：要让 uptime 真在走，子进程必须处在监听态
process.env.APPDATA = SANDBOX;
process.env.AGENT_SKILLS_HOME = path.join(work, "hub");
process.env.CCSWITCH_DB_PATH = path.join(work, "ccswitch.db");
fs.mkdirSync(process.env.APPDATA, { recursive: true });

const gw = require(path.join(BE, "gateway-client.cjs"));
const util = require(path.join(BE, "proxy", "util.cjs"));
const log = require(path.join(BE, "gateway-log.cjs"));
const gatewayPipe = require(path.join(BE, "gateway-pipe.cjs"));
const proto = require(path.join(BE, "gateway-proto.cjs"));
// ⊘ 停机预算的四个数字分处三个文件，require 进来才比得动。gateway.cjs 有 require.main 守卫，
// 被 require 时除一行 entry-not-main 留痕外一个副作用都不许有（装配全在 main() 里）——这条本身也是装配
// 边界的一部分，那一行留痕由 ⑨ 断言（它同时是「入口没被当 main 跑」唯一的可观测形式）。
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

// ===== 夹具 G：⑨d 队列有界——**在自己的进程里**量 rss =====
// 为什么不在本测试进程里量：前九组断言已经建过 sqlite 句柄、起过 server、读过 16 MB 的 bait，
// rss 的基线噪声本身就能吃掉 20 MB 阈值。夹具进程从空基线起，量到的才是「压 200 条」这一件事的成本。
const QUEUE_SRC = `"use strict";
const path = require("node:path");
const fs = require("node:fs");
const be = process.argv[2];
const reportFile = process.argv[3];
const total = Number(process.argv[4] || 200);
const holdMs = Number(process.argv[5] || 150);
const proto = require(path.join(be, "gateway-proto.cjs"));
const gwpipe = require(path.join(be, "gateway-pipe.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const rss0 = process.memoryUsage().rss;
  let inFlight = 0, peak = 0, dispatches = 0;
  const pipePath = String.raw\`\\\\.\\pipe\\agenthub-gw-t4queue-\${process.pid}-\${Date.now().toString(36)}\`;
  const token = "t4-queue-token-0123456789abcdef";
  const srv = await gwpipe.serve({
    pipePath, token,
    dispatch: async (cmd) => {
      dispatches++; inFlight++; if (inFlight > peak) peak = inFlight;
      await sleep(holdMs);
      inFlight--;
      return { cmd: String(cmd) };
    },
  });
  const conn = await gwpipe.connect({ pipePath, token, timeoutMs: 5000 });
  const t0 = Date.now();
  const results = await Promise.all(Array.from({ length: total }, (_, i) =>
    conn.call("proxy_status", { i }).then(
      () => ({ i, ok: true, at: Date.now() - t0 }),
      (e) => ({ i, ok: false, at: Date.now() - t0, message: String((e && e.message) || e), notRetried: !!(e && e.notRetried) })
    )));
  const rejected = results.filter((r) => !r.ok);
  const badRejects = rejected.filter((r) => !/队列已满/.test(r.message));
  fs.writeFileSync(reportFile, JSON.stringify({
    total, accepted: results.length - rejected.length, rejected: rejected.length,
    queueMax: proto.MAX_PENDING, dispatches, peak,
    maxRejectMs: rejected.length ? Math.max(...rejected.map((r) => r.at)) : -1,
    sampleReject: rejected.length ? rejected[0].message : "",
    otherRejects: badRejects.slice(0, 2).map((r) => r.message),
    notRetriedAll: rejected.every((r) => r.notRetried),
    rssGrowthMb: (process.memoryUsage().rss - rss0) / 1048576,
  }), "utf8");
  conn.close();
  srv.close();
  process.exit(0);
})().catch((e) => { console.log("QUEUE-THREW " + String((e && e.message) || e)); process.exit(1); });
`;

// ===== 夹具 I：⑨g 事件帧的背压丢弃——**在自己的进程里**量「主 App 卡死但连接还挂着」时的堆增长 =====
// 为什么非得独立进程 + 一个「真不收」的对端：背压是内核管道缓冲被填满才出现的结果，而本测试进程既挂着
// 前九组的 rss 噪声、又没有一条「真的不读」的客户端。这里的对端认证完就把读侧停住（不挂 data 监听），
// 于是服务端每一条事件帧都只能往**自己**的发送队列里堆——正是规格 §5.2「队列不得无界……避免主 App 卡死时
// 子进程堆内存」点名的失败场景（事件源是周期性的：credits 30 分钟调度、poolsync 进度、请求完成）。
// 观测口径刻意取「对端复活后一共收到多少帧」：那等于「卡死期间堆在孩子发送队列里的字节数」，
// 有界时是个位数帧，无界时是 frames × frameBytes 的常量——两者差一个数量级，不是恒真表达式。
const BACKPRESSURE_SRC = `"use strict";
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const be = process.argv[2];
const reportFile = process.argv[3];
const frames = Number(process.argv[4] || 200);
const frameBytes = Number(process.argv[5] || 262144);
const proto = require(path.join(be, "gateway-proto.cjs"));
const gwpipe = require(path.join(be, "gateway-pipe.cjs"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mem = () => { const m = process.memoryUsage(); return { rss: m.rss, ext: m.external }; };
(async () => {
  const pipePath = String.raw\`\\\\.\\pipe\\agenthub-gw-t4bp-\${process.pid}-\${Date.now().toString(36)}\`;
  const token = "t4-bp-token-0123456789abcdef";
  let dispatches = 0;
  const srv = await gwpipe.serve({
    pipePath, token,
    dispatch: async (cmd, args) => { dispatches++; return { v: String((args && args.v) || "") }; },
  });
  // 对端一：认证之后**一个字节都不读**（不挂 data 监听 = 读侧停在 paused），等价于主 App 卡死
  const stalled = net.connect(pipePath);
  let stalledClosed = false, stalledErr = "";
  stalled.on("close", () => { stalledClosed = true; });
  stalled.on("error", (e) => { stalledErr = String((e && e.message) || e); });
  await new Promise((r, j) => { stalled.once("connect", r); stalled.once("error", j); });
  stalled.write(proto.encode({ k: "hello", token }));
  await sleep(250);                        // 让服务端把这条记进「已认证连接」表
  // 风暴期间**只有这一条**已认证连接：编帧成本与「被留下的字节数」同量级，多一条连接只是把两个数一起翻倍，
  // 什么也分不清。事后另建的那条连接用来证明服务本身没被拖坏（见阶段三）。
  const m0 = mem();
  for (let i = 0; i < frames; i++) {
    srv.broadcast({ k: "evt", payload: { type: "poolsync-progress", seq: i, blob: "x".repeat(frameBytes) } });
  }
  // 关键事件在风暴正中广播（此刻队列早已越过 highWaterMark）：CRITICAL_EVENTS 不许被背压丢弃——
  // oauth-done 是 ProxyAgentsView 里 oauthWaiting 的唯一出口，丢一帧 UI 永久卡「等待授权」。
  srv.broadcast({ k: "evt", payload: { type: "oauth-done", channel: "stub", seq: "critical-during-storm" } });
  await sleep(200);
  const m1 = mem();
  const closedDuringStorm = stalledClosed;   // 丢弃若把连接判死，close 会在这里之前就到
  // 阶段二：让这条被灌过洪流的连接「复活」成会读的对端。它收到的字节数 = 卡死期间**留在孩子发送队列里**
  // 的字节数（对端一直没读，一个字节都没少），这才是「队列有界」的直接读数，不受 GC 时机干扰。
  let resp = null, receivedPoolsync = 0, receivedBytes = 0, gotAfterDrain = false, oauthReceived = false;
  const feed = proto.createParser((f) => {
    if (!f || typeof f !== "object") return;
    if (f.k === "evt") {
      const t = f.payload && f.payload.type;
      if (t === "after-drain") gotAfterDrain = true;
      else if (t === "oauth-done") oauthReceived = true;
      else if (t === "poolsync-progress") receivedPoolsync++;
    }
    if (f.k === "res" && !resp) resp = f;
  }, () => {});
  stalled.setEncoding("utf8");
  stalled.on("data", (d) => { receivedBytes += d.length; feed(d); });   // 挂上 data 才开始读
  stalled.write(proto.encode({ k: "req", id: "bp-cmd-1", cmd: "gateway_echo", args: { v: "events-dropped-commands-alive" } }));
  for (let i = 0; i < 100 && !resp; i++) await sleep(50);
  const aliveCmdOk = !!(resp && resp.ok && resp.data && resp.data.v === "events-dropped-commands-alive");
  // 阶段三：「丢」不许变成「一律不投递」。队列排空之后再广播一条小事件帧，同一条连接必须收到它。
  srv.broadcast({ k: "evt", payload: { type: "after-drain", seq: -1 } });
  for (let i = 0; i < 60 && !gotAfterDrain; i++) await sleep(50);
  const late = await gwpipe.connect({ pipePath, token, timeoutMs: 5000 });
  const lateEcho = await late.call("gateway_echo", { v: "server-still-fine" }, { timeoutMs: 4000 }).then(() => true, () => false);
  fs.writeFileSync(reportFile, JSON.stringify({
    frames, frameBytes,
    attemptedMb: frames * frameBytes / 1048576,
    receivedMb: receivedBytes / 1048576, receivedPoolsync, oauthReceived,
    rssGrowthMb: (m1.rss - m0.rss) / 1048576,
    extGrowthMb: (m1.ext - m0.ext) / 1048576,
    closedDuringStorm, stalledErr, aliveCmdOk, gotAfterDrain, lateEcho, dispatches,
  }), "utf8");
  late.close();
  try { stalled.destroy(); } catch (e) { /* 已断 */ }
  srv.close();
  process.exit(0);
})().catch((e) => { console.log("BP-THREW " + String((e && e.message) || e)); process.exit(1); });
`;

// ===== 夹具 H：--bench 的服务端——把**真** proxy_pool 接上管道 =====
// 号池是本地库派生的（poolView → 4 渠道 × poolAccounts/poolSummary/accountModelCool），不走上游，
// 所以基准可以在沙箱库里播假号；管道两端的 JSON 编解码与生产完全同源，这才是「跨进程到底加了多少毫秒」的答数。
const BENCH_SRC = `"use strict";
const path = require("node:path");
const be = process.argv[2];
const seed = Number(process.argv[3] || 40);
const store = require(path.join(be, "proxy", "store.cjs"));
const proxy = require(path.join(be, "proxy", "index.cjs"));
const gwpipe = require(path.join(be, "gateway-pipe.cjs"));
for (let i = 0; i < seed; i++) {
  store.addAccount({
    channel: store.CHANNELS[i % store.CHANNELS.length].id, uid: "bench-" + i,
    name: "基准账号 " + i, token: "tok-" + i, refreshToken: "", source: "bench",
    expiresAt: Date.now() + 86400000,
  });
}
(async () => {
  const pipePath = String.raw\`\\\\.\\pipe\\agenthub-gw-t4bench-\${process.pid}-\${Date.now().toString(36)}\`;
  const token = "t4-bench-token-0123456789abcdef";
  const srv = await gwpipe.serve({
    pipePath, token,
    dispatch: async (cmd, args) => {
      // gateway_echo：空载往返 = 管道本身的税（不碰库、不派生号池）
      if (cmd === "gateway_echo") return { v: String((args && args.v) || "") };
      // bench_local：同一条 proxy_pool 在**本进程内**跑一次的耗时与响应体量（不编帧、不过 socket）——
      // 父进程拿「管道往返 − 这一条」给跨进程开销归因，而不是靠猜。
      if (cmd === "bench_local") {
        const t = process.hrtime.bigint();
        const data = await proxy.dispatch("proxy_pool", {});
        const ms = Number(process.hrtime.bigint() - t) / 1e6;
        return { ms, bytes: JSON.stringify(data).length, accounts: seed };
      }
      return proxy.dispatch(cmd, args);
    },
  });
  console.log("BENCH-LISTEN " + JSON.stringify({ pipePath, token }));
  void srv;
})().catch((e) => { console.log("BENCH-THREW " + String((e && e.message) || e)); process.exit(1); });
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

/** 夹具脚本落到临时目录：断言路径与 --bench 路径都要（bench 只需要后两个，但一次写全省得分叉） */
function writeFixtures() {
  fs.writeFileSync(path.join(work, "gw-parent.cjs"), PARENT_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-spawn.cjs"), SPAWN_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-stopper.cjs"), STOPPER_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-ready.cjs"), READY_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-listen.cjs"), LISTEN_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-takeover.cjs"), TAKEOVER_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-reap.cjs"), REAP_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-queue.cjs"), QUEUE_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-backpressure.cjs"), BACKPRESSURE_SRC, "utf8");
  fs.writeFileSync(path.join(work, "gw-bench.cjs"), BENCH_SRC, "utf8");
}

async function main() {
  writeFixtures();
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
  // 这条**故意不加轮询等待**：它钉的是子进程侧的装配序不变式「管道连得上 ⇒ 握手文件已在盘上」
  // （见 gateway.cjs：writeGatewayFile 在 serve() 之前）。改成 waitForFile 就是把这条判据删掉。
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
    + "（一期踩过宽匹配杀进程的坑）。回收只许删掉 gateway.json（见 gateway-client 的 reap 注释）：" + JSON.stringify(rp));
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

  // ===== ⑨ 命令通道硬化（Task 4：配对 / 事件回流 / 默认超时 / 有界队列 / 不重放）=====
  // 结构前提：Task 3 把四个 proto 常量定义出来了却没有消费方（报告里登记成「常量在，判据不在」）。
  // 本任务的定义性动作就是把它们变成真判据，所以第一条钉「消费方存在」——谁把消费方删掉就当场红。
  const pipeSrcText = fs.readFileSync(path.join(BE, "gateway-pipe.cjs"), "utf8");
  for (const name of ["MAX_PENDING", "DEFAULT_TIMEOUT_MS", "NO_TIMEOUT_CMDS", "NON_IDEMPOTENT_READS"]) {
    assert.ok(new RegExp("proto\\." + name + "\\b").test(pipeSrcText),
      "⑨ gateway-pipe.cjs 里找不到 proto." + name + " 的消费方 —— 这个常量又退化成「写了但没 enforce」");
  }
  assert.strictEqual(proto.DEFAULT_TIMEOUT_MS, 10000, "⑨ 默认超时上界必须是简报钉的 10 s，实得 " + proto.DEFAULT_TIMEOUT_MS);
  assert.strictEqual(proto.MAX_PENDING, 64, "⑨ 待响应上界必须是简报钉的 64，实得 " + proto.MAX_PENDING);
  assert.strictEqual(proto.NO_TIMEOUT_CMDS.size, 3, "⑨ 免超时清单必须只有简报那三条，实得：" + [...proto.NO_TIMEOUT_CMDS].join(","));
  // 只比 size 的话「换成另外三条名字」照样绿（评审 minor）：名字才是判据。规格 §5.2 逐条点名这三条
  // 是「本就立即返回、进度靠 evt 回流」的长任务——免超时对**它们**才成立，给一条真会挂管道的命令免了
  // 上界就是回到「主进程发出去的命令永远不回来」。
  assert.deepStrictEqual([...proto.NO_TIMEOUT_CMDS].slice().sort(),
    ["proxy_checkin_run", "proxy_credits_refresh", "proxy_poolsync_run"],
    "⑨ 免超时清单的三个**名字**必须与简报/规格 §5.2 一致（实得：" + [...proto.NO_TIMEOUT_CMDS].join(",")
      + "）：清单被换成别的三条时 size 不变、闸却绿，那正是要防的那种改法");
  assert.deepStrictEqual([...proto.NON_IDEMPOTENT_READS].sort(), ["proxy_pool", "proxy_status"],
    "⑨ 带写副作用的读命令清单被改动：" + [...proto.NON_IDEMPOTENT_READS].join(","));
  pass(`⑨ 四个 proto 常量都有消费方，数值与**名字**都与简报一致（DEFAULT_TIMEOUT_MS=${proto.DEFAULT_TIMEOUT_MS}、MAX_PENDING=${proto.MAX_PENDING}、`
    + `免超时 ${[...proto.NO_TIMEOUT_CMDS].sort().join("/")}、不重放清单 ${[...proto.NON_IDEMPOTENT_READS].join("/")}`);

  // 入口被当模块 require 的那一行留痕（本闸就是那个 require）。没有它时「gateway.cjs 没被当入口跑」是
  // 零副作用的静默退出，排查时连一行 boot 日志都没有——这条同时钉住上面那句「除一行留痕外不许有副作用」。
  const notMain = await waitForLogLine(/entry-not-main \{"filename":/, 3000);
  assert.ok(notMain.line, "⑨ 入口被 require 时没留 entry-not-main 痕（SANDBOX 的 gateway.log 里找不到）："
    + notMain.text.slice(0, 300));
  pass("⑨ 入口被 require（非 main）时留下一行 entry-not-main 留痕，其余零副作用");

  // ---- ⑨a 配对（真子进程 + 真命令表）：并发 30 条 proxy_status + 5 条 gateway_echo ----
  const r9 = await gw.start({ persistent: false });
  assert.strictEqual(r9.ok, true, "⑨a 前提不成立：子进程起不来，后面五组都测不到：" + (r9.message || ""));
  knownPids.add(r9.pid);
  fs.writeFileSync(path.join(SANDBOX, "AgentHub", "config.json"), JSON.stringify({ proxy: { port: PAIR_PORT } }), "utf8");
  const start9 = await gw.call("proxy_start", {});
  assert.strictEqual(start9.ok, true, "⑨a 前提不成立：子进程没进监听态（uptime 会恒为 0，「单调不减」就自我实现了）：" + JSON.stringify(start9));
  await sleep(50);                       // 让 uptime 真的走过几毫秒，30 条之间要能分出先后
  const reqs9 = [];
  for (let i = 0; i < 30; i++) reqs9.push({ cmd: "proxy_status", tag: "s" + i });
  for (let i = 0; i < 5; i++) reqs9.push({ cmd: "gateway_echo", tag: "e" + i });
  const out9 = await Promise.all(reqs9.map((rq, i) => gw.call(rq.cmd, rq.cmd === "gateway_echo" ? { v: rq.tag } : {})
    .then((d) => ({ i, rq, d }), (e) => ({ i, rq, err: String((e && e.message) || e) }))));
  const errs9 = out9.filter((r) => r.err);
  assert.deepStrictEqual(errs9.map((r) => r.err), [],
    "⑨a 并发 35 条里有命令没拿到响应（配对错乱 / 悬挂就会在这里现形）：" + JSON.stringify(errs9.slice(0, 3)));
  const echoes9 = out9.filter((r) => r.rq.cmd === "gateway_echo");
  assert.strictEqual(echoes9.length, 5, "⑨a 前提不成立：gateway_echo 不是 5 条");
  for (const r of echoes9) {
    assert.strictEqual(r.d && r.d.v, r.rq.tag,
      "⑨a gateway_echo 拿回了**别的请求**的载荷 = id 串号：" + JSON.stringify({ i: r.i, want: r.rq.tag, got: r.d && r.d.v }));
  }
  const ups9 = out9.filter((r) => r.rq.cmd === "proxy_status").sort((a, b) => a.i - b.i).map((r) => Number(r.d.uptime));
  assert.ok(ups9.every((u) => Number.isFinite(u)), "⑨a proxy_status 没带回 uptime 字段：" + JSON.stringify(ups9.slice(0, 3)));
  for (let i = 1; i < ups9.length; i++) {
    assert.ok(ups9[i] >= ups9[i - 1], "⑨a 按请求序号排的 uptime 出现倒退（第 " + i + " 条 " + ups9[i - 1] + " → " + ups9[i] + "）：响应与请求配错了");
  }
  assert.ok(new Set(ups9).size >= 2,
    "⑨a 30 条 proxy_status 的 uptime 全等于 " + ups9[0] + " —— 「单调不减」是被常量实现的，这条闸自我实现");
  pass(`⑨a 真子进程并发 35 条全部各归各（echo 5/5 载荷对得上、proxy_status 的 uptime 按请求序单调不减且非恒定）`);

  // 上面那一条**没有**构造出乱序：真命令表的派发是同步跑完的，完成顺序天然等于请求顺序。
  // 「乱序返回不串号」必须再拿桩补一半——故意让先发的挂久一点，完成顺序与请求顺序相反。
  const TOK9 = "task4-stub-token-0123456789abcdef0123456789abcdef";
  const pipe9 = (tag) => String.raw`\\.\pipe\agenthub-gw-t4-${tag}-${process.pid}-${Date.now().toString(36)}`;
  let seqStub = 0;
  const PP_A = pipe9("pair-stub");
  const srvA = await gatewayPipe.serve({
    token: TOK9, pipePath: PP_A,
    dispatch: async (cmd, args) => {
      // 序号在**派进入口**时领（对应真代码里「帧到达顺序 = 派发顺序」这一事实），hold 之后才回，
      // 于是完成顺序与请求顺序相反——这正是本条要造出来的乱序。
      const mine = ++seqStub;
      const hold = Number((args && args.hold) || 0);
      if (hold) await sleep(hold);
      return { v: String((args && args.v) || ""), seq: mine, uptime: mine * 1000 };
    },
  });
  const connA = await gatewayPipe.connect({ pipePath: PP_A, token: TOK9, timeoutMs: 5000 });
  const planA = [{ tag: "a", hold: 120 }, { tag: "b", hold: 90 }, { tag: "c", hold: 60 }, { tag: "d", hold: 0 }, { tag: "e", hold: 30 }, { tag: "f", hold: 10 }];
  const arrivedA = [];
  const resA = await Promise.all(planA.map((p, i) => connA.call("proxy_status", { v: p.tag, hold: p.hold })
    .then((d) => { arrivedA.push(d.v); return { i, p, d }; }, (e) => ({ i, p, err: String((e && e.message) || e) }))));
  assert.deepStrictEqual(resA.filter((r) => r.err).map((r) => r.err), [], "⑨a-2 乱序场景里有命令没回来：" + JSON.stringify(resA.filter((r) => r.err)));
  assert.ok(resA.every((r) => r.d.v === r.p.tag), "⑨a-2 乱序返回时串号了：" + JSON.stringify(resA.map((r) => ({ want: r.p.tag, got: r.d && r.d.v }))));
  assert.notDeepStrictEqual(arrivedA, planA.map((p) => p.tag),
    "⑨a-2 完成顺序与请求顺序相同 → hold 梯度没生效，这条压根没测到乱序（自我实现）：" + arrivedA.join(","));
  const upsA = resA.slice().sort((x, y) => x.i - y.i).map((r) => Number(r.d.uptime));
  for (let i = 1; i < upsA.length; i++) {
    assert.ok(upsA[i] >= upsA[i - 1], "⑨a-2 乱序下按请求序号排仍须单调不减，第 " + i + " 条破了：" + JSON.stringify(upsA));
  }
  connA.close();
  srvA.close();
  pass(`⑨a-2 完成顺序被人为打乱（实际到达序 ${arrivedA.join(">")}）后 6 条仍各归各，串号必红`);

  // ---- ⑨b 事件回流：真调用点（credits.cjs 的 events.emit）+ 反过来的帧序 ----
  const got9 = [];
  const off9 = gw.onEvent((p) => got9.push(p));
  const creditsRep = await gw.call("proxy_credits_refresh", {});
  assert.strictEqual(creditsRep.ok, true, "⑨b 子进程里 proxy_credits_refresh 失败：" + JSON.stringify(creditsRep));
  for (let i = 0; i < 60 && !got9.some((p) => p && p.type === "credits"); i++) await sleep(25);
  assert.ok(got9.some((p) => p && p.event === "proxy" && p.type === "credits"),
    "⑨b 真调用点（proxy_credits_refresh → credits 的 events.emit）的事件没回流到 onEvent：" + JSON.stringify(got9));
  pass(`⑨b 真调用点回流：proxy_credits_refresh → onEvent 收到 {event:'proxy',type:'credits'}（本连接共 ${got9.length} 帧）`);

  // 真代码只有「事件先、响应后」这一半，另外一半（响应先到、事件后到）用桩构造：
  let srvB = null;
  const PP_B = pipe9("evt-order");
  srvB = await gatewayPipe.serve({
    token: TOK9, pipePath: PP_B,
    dispatch: async (cmd, args) => {
      if (cmd === "proxy_credits_refresh") {
        setTimeout(() => srvB.broadcast({ k: "evt", payload: { event: "proxy", type: "credits", late: true } }), 40);
        return { ok: true, total: 0, failed: 0 };
      }
      return { v: String((args && args.v) || "") };
    },
  });
  const connB = await gatewayPipe.connect({ pipePath: PP_B, token: TOK9, timeoutMs: 5000 });
  const orderB = [];
  connB.onEvent((p) => orderB.push("evt:" + (p && p.type) + ":" + (p && p.late)));
  // 必须是 push：两条投递各按自己**收到的时刻**入列。写 splice(0,0,"res") 会把响应钉在第一位，
  // 那条「响应先到、事件后到」的判据就自我实现了（变异「广播改同步先发」实测照样绿）。
  await connB.call("proxy_credits_refresh", {}).then(() => orderB.push("res"), () => orderB.push("res-fail"));
  await sleep(250);
  assert.deepStrictEqual(orderB, ["res", "evt:credits:true"],
    "⑨b 「响应帧先到、事件帧后到」必须照常投递（真代码只覆盖了事件先那一半），实得：" + JSON.stringify(orderB));
  const aliveB = await connB.call("gateway_echo", { v: "evt-not-mistaken-for-res" });
  assert.strictEqual(aliveB.v, "evt-not-mistaken-for-res", "⑨b 事件帧被当成响应帧走了 id 分流的话，这里就拿不到自己的响应了");
  connB.close();
  srvB.close();
  pass("⑨b 帧序两半都过：事件先（真子进程）与响应先（桩）都能投递，evt 帧不占 id 分流");

  // ---- ⑨c 默认超时上界 + NO_TIMEOUT_CMDS 免误拒 + 丢帧不静默 ----
  const HANG_MS = 12000;                 // 必须 > DEFAULT_TIMEOUT_MS：只有真挂死才测得出「有上界」
  const PP_C = pipe9("timeout");
  const srvC = await gatewayPipe.serve({
    token: TOK9, pipePath: PP_C,
    dispatch: async (cmd, args) => {
      const hold = Number((args && args.hold) || 0);
      if (hold) await sleep(hold);
      if (cmd === "proxy_checkin_run") return { stubbed: "checkin", held: hold };
      if (cmd === "proxy_will_hang") return { never: true };
      if (cmd === "proxy_bad_payload") { const c = {}; c.self = c; return c; }   // ⑨c 件 1：响应体编不出帧
      return { v: String((args && args.v) || "") };
    },
  });
  const connC = await gatewayPipe.connect({ pipePath: PP_C, token: TOK9, timeoutMs: 5000 });
  const tHang = Date.now();
  const hungP = connC.call("proxy_will_hang", { hold: HANG_MS });          // 不传 opts：走**默认**上界
  const tFree = Date.now();
  const freeP = connC.call("proxy_checkin_run", { hold: HANG_MS });        // 同在 NO_TIMEOUT_CMDS 里的另一条同理
  // 这条 await 必须自带看门狗：没有默认超时时 hungP 永远不 settle，本闸只能靠 420 s 的整体硬超时收，
  // 红是红了但指不到「缺默认上界」这一条。给它一个上界的 1.5 倍，超了就如实造一个错。
  const hungR = await Promise.race([
    hungP.then(() => null, (e) => ({ e, ms: Date.now() - tHang })),
    sleep(proto.DEFAULT_TIMEOUT_MS * 2).then(() => ({
      ms: -1, e: new Error("命令在 " + proto.DEFAULT_TIMEOUT_MS * 2 + " ms 内既没返回也没被判超时（默认上界不存在）"),
    })),
  ]);
  assert.ok(hungR, "⑨c 挂 12 s 的普通命令竟然正常返回了 —— 默认超时没生效，Task 3 那条「默认永不超时」回来了");
  assert.match(String(hungR.e.message), /未在 10000ms 内应答/, "⑨c 超时要报得人话，实得：" + String(hungR.e.message));
  assert.ok(hungR.ms >= proto.DEFAULT_TIMEOUT_MS - 500 && hungR.ms <= proto.DEFAULT_TIMEOUT_MS + 2000,
    "⑨c 超时落在 " + hungR.ms + " ms，不在 proto.DEFAULT_TIMEOUT_MS(" + proto.DEFAULT_TIMEOUT_MS + ") 附近 → 上界不是这个常量给的");
  assert.strictEqual(hungR.e.notRetried, true, "⑨c 超时的 reject 必须带 notRetried 标记（简报 Step 2）：" + String(hungR.e.message));
  const freeR = await freeP.then((d) => ({ d, ms: Date.now() - tFree }), (e) => ({ e, ms: Date.now() - tFree }));
  assert.ok(freeR.d, "⑨c NO_TIMEOUT_CMDS 里的 proxy_checkin_run 被误拒了：" + String(freeR.e && freeR.e.message)
    + " —— 免超时清单没生效，长任务会被管道层砍掉");
  assert.ok(freeR.ms >= HANG_MS - 300, "⑨c 桩挂 " + HANG_MS + " ms 却在 " + freeR.ms + " ms 就返回了？免超时那条不是靠真等出来的");
  assert.strictEqual(freeR.d.stubbed, "checkin", "⑨c 免超时命令的响应内容不对：" + JSON.stringify(freeR.d));
  await sleep(250);                        // 让那条 12 s 才落地的迟到响应穿过客户端
  const aliveC = await connC.call("gateway_echo", { v: "after-timeout-and-late-frame" });
  assert.strictEqual(aliveC.v, "after-timeout-and-late-frame",
    "⑨c 超时 + 迟到响应帧之后连接必须仍可用（迟到的 id 只能被丢弃，不许把连接搞坏）");
  const tightC = await connC.call("proxy_will_hang", { hold: 500 }, { timeoutMs: 120 }).then(() => null, (e) => e);
  assert.ok(tightC && /未在 120ms 内应答/.test(String(tightC.message)),
    "⑨c 显式 opts.timeoutMs 必须仍然说了算（收紧与放宽都由调用方定），实得：" + String(tightC && tightC.message));
  const looseC = await connC.call("proxy_will_hang", { hold: 300 }, { timeoutMs: 3000 });
  assert.strictEqual(looseC.never, true, "⑨c 显式放宽到 3 s 后，300 ms 的命令不该被判超时");
  // 丢帧不静默：writeFrame 必须把「写不出去」如实回给调用方。Task 3 的注释写着「命令帧由 pending 超时兜」，
  // 那之前得先知道帧没了——用假 socket 钉这条判据本身，不依赖 OS 的断连时序窗口。
  // Task 5 刀 1 起是**四态**：编帧失败（一字节都没入队）必须与背压（帧已进队列）分开——两态的善后完全不同。
  const hooks = gatewayPipe.__hooks;
  assert.ok(hooks && typeof hooks.writeFrame === "function",
    "⑨c 必须导出 __hooks.writeFrame 供这条判据钉死（与 secretbox.__selfCheck 同类的测试可见性，不进产品路径）");
  let wroteCalls = 0;
  assert.strictEqual(hooks.writeFrame({ writable: false, write() { wroteCalls += 1; } }, { k: "req", id: "1" }), "unwritable",
    "⑨c 不可写的 socket 上 writeFrame 必须回 unwritable（回 written/queued = 静默丢帧，命令就永远不回来）");
  assert.strictEqual(wroteCalls, 0, "⑨c 既然判定不可写，就不该再去碰 write()");
  assert.strictEqual(hooks.writeFrame({ writable: true, write() { wroteCalls += 1; return true; } }, { k: "req", id: "2" }), "written",
    "⑨c 可写且没越过 highWaterMark 时 writeFrame 必须回 written");
  assert.strictEqual(wroteCalls, 1, "⑨c 可写时 write 应被调用恰好一次，实得 " + wroteCalls);
  // 「背压」态：sock.write() 自己回 false（帧进了发送队列但越过了 highWaterMark）时，writeFrame 必须
  // 回 queued 而不是压成 false——调用方拿它当「没写出去」会误报未投递，而命令可能已经在子进程里落了库。
  assert.strictEqual(hooks.writeFrame({ writable: true, write() { wroteCalls += 1; return false; } }, { k: "evt" }), "queued",
    "⑨c sock.write() 回 false（背压）时 writeFrame 必须回 queued（帧已进队列，没丢）");
  assert.strictEqual(wroteCalls, 2, "⑨c 背压那一支帧是**进了队列**的，write() 必须被调到（实得 " + wroteCalls + "）");
  assert.strictEqual(hooks.writeFrame({ writable: true, write() { wroteCalls += 1; throw new Error("EPIPE"); } }, { k: "evt" }), "unwritable",
    "⑨c write() 抛错（对端刚断）时 writeFrame 回 unwritable，且不许把异常漏给调用方");
  // 「编帧失败」态（Task 5 刀 1 件 1）：载荷连 JSON 都编不了（循环引用/BigInt）时必须独立成态——
  // 它一字节都没入队，与背压（帧已入队）的善后完全不同：call 侧立即按未投递改判，reply 侧补错误响应。
  const circular = {}; circular.self = circular;
  assert.strictEqual(hooks.writeFrame({ writable: true, write() { wroteCalls += 1; return true; } }, circular), "unencodable",
    "⑨c 载荷不可 JSON 序列化时 writeFrame 必须回 unencodable（压成 false 会和「写不出去」混态，调用方无法正确善后）");
  assert.strictEqual(wroteCalls, 3, "⑨c 编帧失败根本走不到 write()，实得 " + wroteCalls);
  // 编帧失败的**端到端**判定力（Task 5 刀 1 件 1，不只是函数级四态）：
  //  ① dispatch 返回循环引用 → 服务端补发一条必可编码的错误响应，客户端立刻拿到确定性失败
  //     （落在「业务失败」一类：命令已真跑完，不许重试，也绝不允许干等默认超时），并留痕。
  const tEnc = Date.now();
  const encR = await Promise.race([
    connC.call("proxy_bad_payload", {}).then(() => "resolved", (e) => ({ e, ms: Date.now() - tEnc })),
    sleep(5000).then(() => "hung"),
  ]);
  assert.ok(encR && encR !== "hung" && encR !== "resolved",
    "⑨c 响应帧编不出来时客户端" + (encR === "hung"
      ? "干等 5 s 没有结论（响应帧静默消失、连 pipe-frame-dropped 都不记，正是文件头钉死的「最坏失败形态」）"
      : "竟然拿到了 resolved（编帧失败被当成了成功）"));
  assert.match(String(encR.e.message), /编码失败/, "⑨c 编帧失败的错要报得人话：" + String(encR.e.message));
  assert.strictEqual(encR.e.notRetried, undefined,
    "⑨c 命令已真跑完（副作用已发生），错误必须落在「业务失败」一类（不带 notRetried），实得：" + JSON.stringify(encR.e.notRetried));
  assert.ok(encR.ms < 5000, "⑨c 编帧失败的结论必须立刻到，实得 " + encR.ms + " ms");
  const encLog = await waitForLogLine(/pipe-frame-encode-error/, 3000);
  assert.ok(encLog.line, "⑨c 服务端没留 pipe-frame-encode-error（SANDBOX gateway.log）：" + encLog.text.slice(-300));
  //  ② req 参数含循环引用 → 客户端**立即**按未投递 reject：此刻命令绝无可能在子进程里跑过，
  //     不存在「已落库却报未投递」的误判面，旧代码这里要挂满 10 s 默认超时才有结论。
  const circularArgs = { v: "ok", trap: circular };
  const tReq = Date.now();
  const reqEnc = await connC.call("gateway_echo", circularArgs).then(() => null, (e) => ({ e, ms: Date.now() - tReq }));
  assert.ok(reqEnc, "⑨c req 参数不可序列化时必须立即 reject（挂着等超时 = 静默丢帧的另一个入口）");
  assert.match(String(reqEnc.e.message), /命令帧编码失败/, "⑨c req 编帧失败的错要报得人话：" + String(reqEnc.e.message));
  assert.match(String(reqEnc.e.message), /未投递/, "⑨c req 编帧失败必须说清「未投递」：" + String(reqEnc.e.message));
  assert.strictEqual(reqEnc.e.notRetried, true, "⑨c req 编帧失败 = 命令没投出去，必须带 notRetried：" + String(reqEnc.e.message));
  assert.ok(reqEnc.ms < 1000, "⑨c req 编帧失败必须当场改判，实得 " + reqEnc.ms + " ms");
  const aliveEnc = await connC.call("gateway_echo", { v: "after-encode-errors" });
  assert.strictEqual(aliveEnc.v, "after-encode-errors", "⑨c 两类编帧失败之后连接必须仍可用");
  const connDead = await gatewayPipe.connect({ pipePath: PP_C, token: TOK9, timeoutMs: 5000 });
  connDead.close();
  const tDead = Date.now();
  const deadR = await connDead.call("proxy_pool", {}).then(() => null, (e) => ({ e, ms: Date.now() - tDead }));
  assert.ok(deadR, "⑨c 已断开的连接上 call 必须 reject，不许静默悬挂");
  assert.match(String(deadR.e.message), /未投递/, "⑨c 断连后的失败必须说清「命令没投出去」：" + String(deadR.e.message));
  assert.ok(deadR.ms < 1000, "⑨c 断连后的命令必须立即失败而不是等默认超时：" + deadR.ms + " ms");
  assert.strictEqual(deadR.e.notRetried, true, "⑨c 未投递的错也要带 notRetried：" + String(deadR.e.message));
  connC.close();
  srvC.close();
  pass(`⑨c 默认上界生效：挂 12 s 的普通命令在 ${hungR.ms} ms 报 timeout（常量 ${proto.DEFAULT_TIMEOUT_MS}），`
    + `免超时的 proxy_checkin_run 撑满 ${freeR.ms} ms 正常返回；显式 timeoutMs 仍说了算；`
    + `writeFrame 不可写时回 false、断连后 ${deadR.ms} ms 立即「未投递」`);

  // ---- ⑨d 有界队列（夹具进程里量 rss，见夹具 G 的注释）----
  const qReport = path.join(work, "queue.json");
  const qRun = await spawnFixture("gw-queue.cjs", [BE, qReport, "200", "150"], {
    APPDATA: sandboxDir("queue"), AGENT_SKILLS_HOME: path.join(work, "hub-queue"),
  }).done;
  assert.strictEqual(qRun.code, 0, "⑨d 队列夹具跑挂了：" + qRun.out + qRun.err);
  await waitForFile(qReport, 15000);
  const q = JSON.parse(fs.readFileSync(qReport, "utf8"));
  assert.strictEqual(q.rejected, q.total - q.queueMax,
    "⑨d 压 " + q.total + " 条应当只拒 " + (q.total - q.queueMax) + " 条，实得 " + q.rejected + "（上界没生效 / 拒过头了）");
  assert.strictEqual(q.accepted, q.queueMax, "⑨d 前 " + q.queueMax + " 条必须被受理，实得 " + q.accepted);
  assert.deepStrictEqual(q.otherRejects, [], "⑨d 拒的理由必须全是「队列已满」，其它原因：" + JSON.stringify(q.otherRejects));
  assert.match(q.sampleReject, /队列已满/, "⑨d 拒绝信息必须含「队列已满」，实得：" + q.sampleReject);
  assert.match(q.sampleReject, /待响应\s*64/, "⑨d 拒绝信息必须带上**当前** pending 数（可诊断），实得：" + q.sampleReject);
  assert.match(q.sampleReject, /上界\s*64/, "⑨d 拒绝信息必须带上界，实得：" + q.sampleReject);
  assert.strictEqual(q.notRetriedAll, true, "⑨d 被拒的命令也必须带 notRetried（它们从未投递，重放语义同样不成立）");
  assert.ok(q.maxRejectMs < 1000,
    "⑨d 第 65 条必须**立刻**被拒（实测最晚一条在 " + q.maxRejectMs + " ms 才拒）：等满超时就是渲染层假死");
  assert.strictEqual(q.dispatches, q.queueMax,
    "⑨d 服务端只该收到 " + q.queueMax + " 条，实收 " + q.dispatches + " 条：客户端的上界没真的挡住投递");
  assert.ok(q.peak <= q.queueMax, "⑨d 服务端同时在飞 " + q.peak + " 条 > 上界 " + q.queueMax + "（子进程堆内存就是这么压爆的）");
  assert.ok(q.rssGrowthMb < 20, "⑨d 夹具进程 rss 增长 " + q.rssGrowthMb.toFixed(1) + " MB ≥ 20 MB");
  pass(`⑨d 有界队列：200 条并发 → 受理 ${q.accepted} / 立即拒 ${q.rejected} 条（${q.maxRejectMs} ms 内），服务端峰值在飞 ${q.peak}，rss +${q.rssGrowthMb.toFixed(2)} MB`);

  // ---- ⑨e 不重放：断连的 in-flight 命令不许在重连后自动重发 ----
  // 实测依据（不是推测）：pool.cjs 的 poolAccounts() 会把「派生复活」经 store.updateAccount() 回写，
  // effectiveStatus() 在 cooling/exhausted 到期时真落库 —— proxy_pool 这条「读」带写副作用，
  // 任何重放都是重复执行写操作。二期没有幂等表，所以**不做**自动重试，本条守的就是「真的没有」。
  const callsE = {};
  const PP_E = pipe9("no-retry");
  const srvE = await gatewayPipe.serve({
    token: TOK9, pipePath: PP_E,
    dispatch: async (cmd, args) => {
      callsE[cmd] = (callsE[cmd] || 0) + 1;
      if (cmd === "proxy_pool") { await sleep(400); return [{ channel: "trae", accounts: [] }]; }
      return { v: String((args && args.v) || "") };
    },
  });
  assert.ok(proto.NON_IDEMPOTENT_READS.has("proxy_pool"), "⑨e 前提：proxy_pool 必须在 NON_IDEMPOTENT_READS 清单里，否则这条判据没对象");
  const connE = await gatewayPipe.connect({ pipePath: PP_E, token: TOK9, timeoutMs: 5000 });
  const inFlightE = connE.call("proxy_pool", {});
  await sleep(120);                        // 400 ms 才回，此刻确定在途
  connE.close();                           // 模拟断连（token 被拒 / 管道被强拆都走同一条 drop）
  const errE = await inFlightE.then(() => null, (e) => e);
  assert.ok(errE, "⑨e 断连时 in-flight 的 proxy_pool 必须 reject，不许静默悬挂");
  assert.strictEqual(errE.notRetried, true, "⑨e reject 的错误必须带 notRetried 标记（简报 Step 2）：" + String(errE.message));
  assert.match(String(errE.message), /proxy_pool/, "⑨e 错误要点名那条命令：" + String(errE.message));
  assert.match(String(errE.message), /重放/, "⑨e 错误要说明「不会自动重放」：" + String(errE.message));
  await sleep(600);                        // 服务端那条 400 ms 的回包此刻落地：往已断开的 socket 写帧必须不炸也不重投
  assert.strictEqual(callsE.proxy_pool || 0, 1,
    "⑨e 断连之前服务端只该收到 1 次 proxy_pool，实得 " + (callsE.proxy_pool || 0) + " 次");
  const connE2 = await gatewayPipe.connect({ pipePath: PP_E, token: TOK9, timeoutMs: 5000 });
  const otherE = await connE2.call("gateway_echo", { v: "reconnected" });
  assert.strictEqual(otherE.v, "reconnected", "⑨e 重连后的新连接不可用");
  assert.strictEqual(callsE.proxy_pool || 0, 1,
    "⑨e 重连后服务端 proxy_pool 的调用次数变成 " + (callsE.proxy_pool || 0) + " —— 有人在断连/重连路径上做了自动重放。"
    + "proxy_pool 的读会回写派生复活（pool.cjs 的 poolAccounts → store.updateAccount），重放 = 重复执行写操作");
  const explicitE = await connE2.call("proxy_pool", {});
  assert.ok(Array.isArray(explicitE), "⑨e 显式再调一次 proxy_pool 必须正常返回，实得：" + JSON.stringify(explicitE));
  assert.strictEqual(callsE.proxy_pool, 2,
    "⑨e 那个计数必须是活的：显式再调一次后应为 2，实得 " + callsE.proxy_pool
    + "（若恒为 1，上面那条 ===1 就是自我实现的假绿）");
  connE2.close();
  srvE.close();

  // ---- ⑨f 溢出断连（评审 I1：简报 Step 2 点名的硬化项，此前**全仓没有一条测试**触这条路径）----
  // 判据形态照 srvB/srvE 的桩夹具。巨帧只越界 4 KB 就够：这一条要钉的是「溢出即判死、绝不截断解析」，
  // 不是压内存（压内存那一半归 ⑨g）。
  const BIG = proto.MAX_FRAME_BYTES + 4096;
  // ⑨f-1 服务端那一腿：raw 对端（能写任意字节）灌一条**永不结束**的巨帧，尾巴上偷偷接一个完整合法帧。
  // 若服务端把超出的部分截断、拿剩下的半截继续解析，它就会对那个尾巴回话——规格明令禁止的正是这个。
  const PP_F = pipe9("overflow-server");
  const srvF = await gatewayPipe.serve({
    token: TOK9, pipePath: PP_F,
    dispatch: async (cmd, args) => ({ v: String((args && args.v) || "") }),
  });
  // 证人连接必须在**溢出之前**就在场（Task 5 刀 1 件 3）：过去用溢出之后新建的连接验「只断这一条」，
  // 「把 clients 全 destroy」的判过头变异照样绿——只有溢出前就在场的无辜连接幸存才证得住这句话。
  const witnessF = await gatewayPipe.connect({ pipePath: PP_F, token: TOK9, timeoutMs: 5000 });
  const victimF = net.connect(PP_F);
  victimF.setEncoding("utf8");
  let victimDataF = "", victimClosedF = false;
  victimF.on("data", (d) => { victimDataF += d; });
  victimF.on("close", () => { victimClosedF = true; });
  victimF.on("error", () => { /* 断开时序里的 ECONNRESET 一类：判据看 close，不看这个 */ });
  await new Promise((r, j) => { victimF.once("connect", r); victimF.once("error", j); });
  victimF.write(proto.encode({ k: "hello", token: TOK9 }));
  await sleep(150);                                 // 先让 hello 落地（authed），否则红点会落在「未认证」那一支
  victimF.write(Buffer.alloc(BIG, 0x41));           // 8 MB + 4 KB 个 'A'，一个换行都没有
  victimF.write(proto.encode({ k: "req", id: "trunc-99", cmd: "gateway_echo", args: { v: "must-never-be-answered" } }));
  for (let i = 0; i < 100 && !victimClosedF; i++) await sleep(50);
  assert.ok(victimClosedF, "⑨f-1 对端灌进超过 MAX_FRAME_BYTES(" + proto.MAX_FRAME_BYTES + ") 的巨帧之后，服务端没断开那一条连接。"
    + "简报 Step 2：「溢出：单帧超 MAX_FRAME_BYTES 直接断开并记日志，绝不截断解析」——把 sock.destroy() 删掉只留一行日志，"
    + "就退化成规格禁止的那一版，而这条断言必须当场红");
  const overflowLog = await waitForLogLine(/pipe-overflow \{"maxBytes":\d+\}/, 3000);
  assert.ok(overflowLog.line, "⑨f-1 溢出没留痕（SANDBOX 的 gateway.log 里找不到 pipe-overflow）：" + overflowLog.text.slice(-300));
  assert.ok(!/trunc-99|must-never-be-answered/.test(victimDataF),
    "⑨f-1 溢出之后服务端仍在这条连接上回话（" + JSON.stringify(victimDataF.slice(0, 200)) + "）：那说明巨帧被截断后，"
    + "剩下的半截被当成合法帧解析并派发了");
  const connHealthyF = await gatewayPipe.connect({ pipePath: PP_F, token: TOK9, timeoutMs: 5000 });
  const okHealthyF = await connHealthyF.call("gateway_echo", { v: "only-that-connection-died" });
  assert.strictEqual(okHealthyF.v, "only-that-connection-died",
    "⑨f-1 一条连接溢出之后，同一服务上**新建**的连接不可用了（服务本身被拖坏）");
  const okWitnessF = await witnessF.call("gateway_echo", { v: "witness-was-here-all-along" });
  assert.strictEqual(okWitnessF.v, "witness-was-here-all-along",
    "⑨f-1 溢出**前**就在场的无辜连接被连坐了（判死判过头：「溢出即断开所有 clients」这类变异在这里必须红）——溢出只许判死灌巨帧的那一条");
  try { victimF.destroy(); } catch { /* 已断 */ }
  connHealthyF.close();
  witnessF.close();
  srvF.close();
  pass(`⑨f-1 服务端溢出断连有牙：> ${proto.MAX_FRAME_BYTES} B 的巨帧灌进的那条连接被判死（且收不到任何截断响应）、`
    + `日志留 pipe-overflow，溢出前在场的证人连接与溢出后新建的连接都照常应答`);

  // ⑨f-2 客户端那一腿：对端推来一条**永不结束**的巨帧（没有换行的数据堆过上限才是溢出的真实形态）。
  // 为什么这里换成一台 raw 服务端而不是 srvB 那种桩 + broadcast：实测（本机，第一次跑就是它红给我看的）
  // 一条 8 MB 的**合法** NDJSON 巨帧会被一次 read 整个拿到，解析器先按换行把它吃掉、buf 归零，
  // 溢出判定压根不亮——broadcast 造不出确定性的溢出。硬要按那个形态测只会测到「JSON.parse 一个 8 MB 的帧」，
  // 而客户端这条判据真正要防的是「对端把上限当摆设、连着写不停手」，那就照那个形态造。
  const PP_F2 = pipe9("overflow-client");
  let baitSentF2 = false;
  // 诱饵只砸给**发了 proxy_checkin_run 那一帧**的连接（Task 5 刀 1 件 3）：witness 在溢出前就在场，
  // 溢出之后它必须还活着——「只断这一条」在客户端这一腿也要验到既有连接上，而不是只用新建连接验。
  const rawSrvF2 = net.createServer((s) => {
    s.on("data", (d) => {
      if (baitSentF2 || !String(d).includes("proxy_checkin_run")) return;
      baitSentF2 = true;
      try { s.write(Buffer.alloc(BIG, 0x42)); } catch { /* 已断 */ }      // 8 MB + 4 KB，一个换行都没有
    });
  });
  await new Promise((r) => rawSrvF2.listen(PP_F2, r));
  const witnessF2 = await gatewayPipe.connect({ pipePath: PP_F2, token: TOK9, timeoutMs: 5000 });
  const connF2 = await gatewayPipe.connect({ pipePath: PP_F2, token: TOK9, timeoutMs: 5000 });
  // 载体用免超时清单里的那条命令：它**没有** per-call 上界，溢出断连是这条 promise 唯一的结论来源——
  // 把 drop() 删掉的话这里不是「红得晚一点」，是永远不 settle，所以这条 await 自带看门狗。
  let errF2 = null;
  const t0F2 = Date.now();
  const pF2 = connF2.call("proxy_checkin_run", {}).then(() => "resolved", (e) => { errF2 = e; return "rejected"; });
  const outcomeF2 = await Promise.race([pF2, sleep(6000).then(() => "hung")]);
  const msF2 = Date.now() - t0F2;
  assert.strictEqual(baitSentF2, true, "⑨f-2 前提不成立：raw 服务端没把巨帧写出去（客户端没发帧？）");
  assert.strictEqual(outcomeF2, "rejected",
    "⑨f-2 客户端收到超过 MAX_FRAME_BYTES(" + proto.MAX_FRAME_BYTES + ") 且永不结束的帧之后，那条免超时的在途命令"
    + outcomeF2 + "（rejected 才是对的）。resolved = 巨帧被当成普通帧继续用；hung = 溢出只记日志不断连（把 drop() 删掉），"
    + "而这条命令没有别的上界兜底");
  assert.match(String(errF2.message), /帧超过上限/, "⑨f-2 溢出的错要报得人话，实得：" + String(errF2.message));
  assert.strictEqual(errF2.notRetried, true, "⑨f-2 溢出断连的 reject 必须带 notRetried：" + String(errF2.message));
  assert.strictEqual(errF2.command, "proxy_checkin_run", "⑨f-2 溢出断连也要点名命令：" + JSON.stringify(errF2.command));
  assert.ok(msF2 < 2500, "⑨f-2 判死太慢（" + msF2 + " ms）：看门狗 6000 ms、桩那边压根不会回，结论只能是溢出给的");
  assert.strictEqual(connF2.connected, false, "⑨f-2 溢出断连后 connected 仍为 true（连接状态没跟着判死）");
  assert.strictEqual(witnessF2.connected, true,
    "⑨f-2 溢出**前**就在场的证人连接被连坐了（判过头）：溢出只许影响收到巨帧的那一条连接");
  const clientOverflowLog = await waitForLogLine(/pipe-client-overflow \{"maxBytes":\d+\}/, 3000);
  assert.ok(clientOverflowLog.line, "⑨f-2 客户端溢出没留痕（找不到 pipe-client-overflow）：" + clientOverflowLog.text.slice(-300));
  const connF2b = await gatewayPipe.connect({ pipePath: PP_F2, token: TOK9, timeoutMs: 3000 });
  assert.strictEqual(connF2b.connected, true, "⑨f-2 一条连接溢出之后，新建的连接都不通了");
  connF2.close();
  witnessF2.close();
  connF2b.close();
  try { rawSrvF2.close(); } catch { /* 已关 */ }
  pass(`⑨f-2 客户端溢出断连有牙：永不结束的超限巨帧让那条免超时的在途命令在 ${msF2} ms 被 reject(notRetried,「帧超过上限」)，`
    + `日志留 pipe-client-overflow、连接状态跟着变 false，溢出前在场的证人连接与新建连接都活着`);

  // ---- ⑨g 事件帧也有界（评审 I2 / 规格 §5.2「队列不得无界……避免主 App 卡死时子进程堆内存」）----
  // 夹具 I：一条认证后**一个字节都不读**的连接（= 主 App 卡死而连接还挂着）+ frames × frameBytes 的事件帧广播。
  // 承重的读数是「这条连接事后一共收到了多少字节」：对端全程没读，所以那**就是**卡死期间留在子进程发送队列里的
  // 字节数。有界时它是个位数帧的常量，无界时它等于 frames × frameBytes（随帧数线性）——不是恒真表达式。
  const FRAMES = 200, FRAME_BYTES = 256 * 1024;      // 50 MB：正是「credits 30 分钟调度 + poolsync 进度」这种
  const bpReport = path.join(work, "backpressure.json");   // 周期性事件源压上来的量级（一帧一帧攒出来的）
  const bpRun = await spawnFixture("gw-backpressure.cjs", [BE, bpReport, String(FRAMES), String(FRAME_BYTES)], {
    APPDATA: sandboxDir("bp"), AGENT_SKILLS_HOME: path.join(work, "hub-bp"),
  }).done;
  assert.strictEqual(bpRun.code, 0, "⑨g 背压夹具跑挂了：" + bpRun.out + bpRun.err);
  await waitForFile(bpReport, 30000);
  const bp = JSON.parse(fs.readFileSync(bpReport, "utf8"));
  const bpLogFile = logFileOf(sandboxDir("bp"));
  let bpLog = "";
  for (let i = 0; i < 40; i++) {
    try { bpLog = fs.readFileSync(bpLogFile, "utf8"); } catch { bpLog = ""; }
    if (/event-frame-dropped/.test(bpLog)) break;
    await sleep(100);
  }
  // dropped 计数改逐行 JSON 解析（Task 5 刀 1 件 4）：旧判据用 matchAll 正则把日志里 JSON 字段的
  // **书写顺序**钉死了（"reason" 必须在 "type" 前面），字段一换序就红、红因失真——判据管的是丢弃
  // 发生没发生，不是字段怎么排。关键事件不许出现在丢弃名单里（件 2）。
  const dropObjs = bpLog.split("\n")
    .filter((l) => l.includes("event-frame-dropped"))
    .map((l) => { const m = l.match(/event-frame-dropped (\{.*\})\s*$/); let o = null; try { o = JSON.parse(m[1]); } catch { /* 截断行不计 */ } return o; })
    .filter((o) => o && o.reason === "backpressure");
  const drops = dropObjs.filter((o) => o.type === "poolsync-progress");
  const criticalDrops = dropObjs.filter((o) => proto.CRITICAL_EVENTS.has(String(o.type)));
  assert.ok(bp.receivedPoolsync <= 4,
    "⑨g 卡死不读的对端最终收到 " + bp.receivedPoolsync + " 个 poolsync 帧（试图投递 " + bp.frames + " 帧）：子进程的发送队列是**无界**的。"
    + "规格 §5.2「队列不得无界……避免主 App 卡死时子进程堆内存」——broadcast 拿不到背压结论、照单全收就是这个形态");
  assert.strictEqual(bp.oauthReceived, true,
    "⑨g 风暴正中广播的 oauth-done 没送达（" + JSON.stringify(bp) + "）：关键事件（CRITICAL_EVENTS，oauthWaiting 的唯一出口）"
    + "不许被背压当普通帧丢掉——丢一帧 UI 永久卡「等待授权」");
  assert.deepStrictEqual(criticalDrops, [],
    "⑨g 关键事件出现在 event-frame-dropped 名单里：" + JSON.stringify(criticalDrops) + "——CRITICAL_EVENTS 不许被背压丢弃");
  assert.ok(bp.receivedMb < bp.attemptedMb / 10,
    "⑨g 留在子进程发送队列里的字节 " + bp.receivedMb.toFixed(1) + " MB 不少于试图投递量 " + bp.attemptedMb.toFixed(1)
    + " MB 的十分之一：队列随事件帧数线性增长，即「无界」");
  assert.ok(drops.length >= bp.frames - 6,
    "⑨g 只记了 " + drops.length + " 行 event-frame-dropped（试图投递 " + bp.frames + " 帧、实际入队 " + bp.receivedPoolsync
    + " 帧）：丢弃没留痕 = 排障时只剩「主 App 没收到进度事件」，与规格要求的可见性不符");
  assert.ok(bp.dispatches >= 1,
    "⑨g 夹具上报的 dispatches 无人消费（Task 4 评审 minor ④）：服务端派发计数 " + bp.dispatches
    + " ——命令通道在风暴夹具里真跑过至少一次，aliveCmdOk 才有旁证");
  assert.ok(Math.max(bp.rssGrowthMb, bp.extGrowthMb) < 30,
    "⑨g 夹具进程在风暴中 rss +" + bp.rssGrowthMb.toFixed(1) + " MB / external +" + bp.extGrowthMb.toFixed(1)
      + " MB ≥ 30 MB（试图投递 " + bp.attemptedMb.toFixed(1) + " MB）：这就是规格点名的「主 App 卡死时子进程堆内存」");
  assert.strictEqual(bp.closedDuringStorm, false,
    "⑨g 事件帧被丢之后那条连接也被判死了（close 在风暴期间就到）：事件帧是尽力投递，掉一帧不值得牺牲整条连接——"
    + "同一连接上的命令帧还在等回执，判死会把它们一起打成「未投递」");
  assert.strictEqual(bp.aliveCmdOk, true,
    "⑨g 丢弃之后在**同一条连接**上投的命令帧拿不到响应（命令通道被误判死）：" + JSON.stringify(bp));
  assert.strictEqual(bp.gotAfterDrain, true,
    "⑨g 队列排空之后再广播一条小事件帧也没投递到（" + JSON.stringify(bp) + "）：「背压时丢」被做成了「一律不投递」");
  assert.strictEqual(bp.lateEcho, true, "⑨g 风暴之后新建的连接不可用（服务本身被拖坏）：" + JSON.stringify(bp));
  pass(`⑨g 事件帧有界：${bp.frames} × ${(bp.frameBytes / 1024)} KB = ${bp.attemptedMb.toFixed(1)} MB 灌向一条不收的连接，`
    + `实际入队 ${bp.receivedPoolsync} 帧 / ${bp.receivedMb.toFixed(2)} MB（其余 ${drops.length} 帧记 event-frame-dropped{reason:backpressure}），`
    + `rss +${bp.rssGrowthMb.toFixed(1)} MB / external +${bp.extGrowthMb.toFixed(1)} MB；连接没被判死、同连接命令帧照常回执、`
    + `风暴正中的 oauth-done 照常送达（CRITICAL_EVENTS 绕过丢弃）`);

  off9();
  const stop9 = await gw.stopAndWait({ timeoutMs: 8000 });
  assert.strictEqual(stop9.stopped, true, "⑨e 收尾没停掉 ⑨a 起的子进程：" + stop9.message);
  assert.ok(await waitForPortFree(PAIR_PORT, 5000), "⑨e 收尾后端口 " + PAIR_PORT + " 还有人 accept");
  pass("⑨e 不重放有牙：断连的 proxy_pool 立即 reject(notRetried) 且服务端计数停在 1，显式重调才变 2（计数本身有牙）");

  // ---- ⑨h 客户端早退的形状要和管道层四类失败一致（评审 minor）----
  // 上面几组已经把「断连 / 超时 / 未投递 / 队列满」四类都钉成带 notRetried 的 Error，唯独
  // gateway-client.call() 在压根没连接时早退的那一条是裸 Error —— 而 Task 5 的转发体最常撞上的恰恰是它。
  // 按标记分流的调用方一旦漏了这一支，就会把「压根没投出去」当成「可以安全重发」，那是重放语义的另一个入口。
  assert.strictEqual(gw.state().connected, false, "⑨h 前提不成立：stopAndWait 之后主进程那条连接应当已断");
  const earlyH = await gw.call("proxy_pool", {}).then(() => null, (e) => e);
  assert.ok(earlyH && /未连接/.test(String(earlyH.message)),
    "⑨h 未连接时 call 必须 reject 并说清「没连接」，实得：" + JSON.stringify(earlyH));
  assert.strictEqual(earlyH.notRetried, true,
    "⑨h 「未连接」的早退必须带 notRetried（与管道层四类失败同形状），实得：" + String(earlyH.message));
  assert.strictEqual(earlyH.command, "proxy_pool", "⑨h 早退也要点名命令：" + JSON.stringify(Object.keys(earlyH)));
  pass(`⑨h 客户端早退与管道层同形状：notRetried:true、command:"proxy_pool"，错文「${String(earlyH.message).slice(0, 46)}…」`);

  // ---- ⑨i 服务端跨连接在飞总账（Task 5 刀 1 件 5：k 条认证连接各 64 = k×64 的堆内存形态不许回来）----
  // 两条连接同台：连接 1 顶满全局账，连接 2 的下一条必须当场被拒；被拒的命令**从未被派发**（重试语义
  // 安全，所以回普通业务失败、不带 notRetried），既有连接上的在飞命令不受连坐，总账清零后立刻可用。
  const PP_I = pipe9("global-inflight");
  let releaseI = null;
  const gateI = new Promise((r) => { releaseI = r; });
  let inflightI = 0, peakI = 0;
  const srvI = await gatewayPipe.serve({
    token: TOK9, pipePath: PP_I,
    dispatch: async (cmd) => {
      inflightI++; if (inflightI > peakI) peakI = inflightI;
      await gateI;                       // 全部 hold 到测试放行：让「在飞」变成确定性状态而不是时序运气
      inflightI--;
      return { cmd: String(cmd) };
    },
  });
  const connI1 = await gatewayPipe.connect({ pipePath: PP_I, token: TOK9, timeoutMs: 5000 });
  const connI2 = await gatewayPipe.connect({ pipePath: PP_I, token: TOK9, timeoutMs: 5000 });
  const callsI1 = [];
  for (let i = 0; i < proto.MAX_TOTAL_PENDING; i++) callsI1.push(connI1.call("proxy_pool", { i }));
  for (let i = 0; i < 150 && inflightI < proto.MAX_TOTAL_PENDING; i++) await sleep(20);
  assert.strictEqual(inflightI, proto.MAX_TOTAL_PENDING,
    "⑨i 前提不成立：连接 1 的 " + proto.MAX_TOTAL_PENDING + " 条命令没全部进入在飞（实到 " + inflightI + "）");
  const tI = Date.now();
  const extraI = await connI2.call("gateway_echo", { v: "over-cap" }).then(() => null, (e) => e);
  assert.ok(extraI, "⑨i 超过全局在飞账的命令竟然被受理了（k×64 的堆内存形态回来了）");
  assert.match(String(extraI.message), /在飞.*上界|上界.*在飞/,
    "⑨i 拒绝信息要点名「服务端在飞/全局上界」（排障时与「子进程不回话」分得开），实得：" + String(extraI.message));
  assert.ok(Date.now() - tI < 1000, "⑨i 超账命令必须当场被拒而不是等超时：" + (Date.now() - tI) + " ms");
  assert.ok(peakI <= proto.MAX_TOTAL_PENDING,
    "⑨i 服务端在飞峰值 " + peakI + " > 全局上界 " + proto.MAX_TOTAL_PENDING + "（总账没真正生效）");
  releaseI();
  const doneI1 = await Promise.all(callsI1.map((p) => p.then((d) => d.cmd, () => null)));
  const failedI1 = doneI1.filter((c) => c !== "proxy_pool");
  assert.strictEqual(failedI1.length, 0,
    "⑨i 第 " + (proto.MAX_TOTAL_PENDING + 1) + " 条被拒后，既有连接上的在飞命令被连坐了 " + failedI1.length + " 条：" + JSON.stringify(failedI1));
  const afterI = await connI2.call("gateway_echo", { v: "cap-freed" });
  assert.strictEqual(afterI.cmd, "gateway_echo", "⑨i 总账清零后连接 2 仍不可用：" + JSON.stringify(afterI));
  connI1.close();
  connI2.close();
  srvI.close();
  pass(`⑨i 跨连接总账：连接 1 顶满 ${proto.MAX_TOTAL_PENDING} 条在飞后，连接 2 的下一条 ${Date.now() - tI} ms 内被拒（在飞/上界报得清），`
    + `服务端峰值 ${peakI} ≤ 上界；放行后 ${doneI1.length} 条全部完成、连接 2 立刻恢复可用`);

  // ===== ⑧ 收尾卫生核对（探针三件套 + 第五条）=====
  assert.strictEqual(realBaseline(), realBefore,
    "⑧ 真实 %APPDATA%\\AgentHub\\proxy\\stats.db 被本次运行写动了（size@mtime 变了）：\n  before " + realBefore + "\n  after  " + realBaseline());
  assert.strictEqual(regValue(), regBefore, "⑧ HKCU Run 项被本次运行改动了（探针卫生第五条）");
  pass("⑧ 收尾：真实 stats.db / -wal 的 size@mtime 未变（零写入直接证据）、HKCU Run 项未变");
}

// ===== --bench：性能回归（简报 Step 3），与断言组互不牵扯，单独一条命令跑 =====
// 量的是**真** proxy_pool（4 渠道 × 全量号池派生 + JSON 编帧 + named pipe 往返），号池是本地库数据，
// 不走上游，所以能在沙箱里播假号。「无窗期一次真补全的 TTFT」这里量不了：那要真凭据真上游，
// 而本闸的硬约束是不碰真实登录文件与真实 %APPDATA%——已在报告里登记为 NOT-VERIFIED，
// 用「空载往返 + 子进程内同一条命令的耗时」两项把跨进程那部分开销拆开给归因。
const POOL_RTT_BUDGET_MS = 30;           // 简报 Step 3 钉的硬指标：全量号池×4 渠道经 JSON 的单次往返
const pct = (sorted, p) => sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(p / 100 * sorted.length) - 1))];
const fmt = (x) => Number(x).toFixed(2);

function stats(name, arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const o = { name, n: s.length, min: s[0], p50: pct(s, 50), p90: pct(s, 90), p95: pct(s, 95), max: s[s.length - 1] };
  console.log(`  ${name}: n=${o.n} min=${fmt(o.min)} p50=${fmt(o.p50)} p90=${fmt(o.p90)} p95=${fmt(o.p95)} max=${fmt(o.max)} ms`);
  return o;
}

async function bench() {
  writeFixtures();
  const dir = sandboxDir("bench");
  fs.mkdirSync(dir, { recursive: true });
  const SEED = 40, N = 25;
  console.log(`BENCH 基准：沙箱库播 ${SEED} 个号（4 渠道轮播），每条采样 ${N} 次`);
  const child = spawn(process.execPath, [path.join(work, "gw-bench.cjs"), BE, String(SEED)], {
    cwd: work, env: Object.assign({}, process.env, { APPDATA: dir, AGENT_SKILLS_HOME: path.join(work, "hub-bench") }),
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  knownPids.add(child.pid);
  child.stderr.setEncoding("utf8");
  let childErr = "";
  child.stderr.on("data", (d) => { childErr += d; });
  child.stdout.setEncoding("utf8");
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  const deadline = Date.now() + 30000;
  let ep = null;
  while (!ep && Date.now() < deadline) {
    const m = /^BENCH-LISTEN (\{.*\})$/m.exec(out);
    if (m) ep = JSON.parse(m[1]);
    else await sleep(100);
  }
  assert.ok(ep, "BENCH 夹具子进程没报出管道名（30 s）：" + out + childErr);
  const conn = await gatewayPipe.connect({ pipePath: ep.pipePath, token: ep.token, timeoutMs: 20000 });
  const once = async (fn) => { const t = process.hrtime.bigint(); const r = await fn(); return { r, ms: Number(process.hrtime.bigint() - t) / 1e6 }; };
  const pool = [], tiny = [];
  for (let i = 0; i < N; i++) pool.push((await once(() => conn.call("proxy_pool", {}))).ms);
  for (let i = 0; i < N; i++) tiny.push((await once(() => conn.call("gateway_echo", { v: "x" }))).ms);
  const local = await once(() => conn.call("bench_local", {}));
  const size = await once(() => conn.call("proxy_pool", {}));
  const bytes = JSON.stringify(size.r).length;
  conn.close();
  try { process.kill(child.pid); } catch { /* 已退 */ }   // 只按本次记下的 pid 精确杀（绝不宽匹配进程名）
  const sp = stats("proxy_pool 往返（管道全量：4 渠道 × " + SEED + " 号，响应 " + bytes + " B）", pool);
  const st = stats("gateway_echo 往返（空载，纯管道税）", tiny);
  console.log(`  proxy_pool 在子进程内本地执行（不含编帧/socket）：${fmt(local.r.ms)} ms，响应体 ${local.r.bytes} B`);
  console.log(`  归因：往返 p50 ${fmt(sp.p50)} − 本地 ${fmt(local.r.ms)} ≈ ${fmt(sp.p50 - local.r.ms)} ms 是跨进程那一层（编帧 + 排队 + socket）；空载往返 p50 ${fmt(st.p50)} ms`);
  assert.ok(sp.p50 < POOL_RTT_BUDGET_MS,
    "BENCH proxy_pool 往返中位数 " + fmt(sp.p50) + " ms ≥ " + POOL_RTT_BUDGET_MS + " ms 硬指标。归因：本地执行 " + fmt(local.r.ms)
    + " ms、跨进程层 " + fmt(sp.p50 - local.r.ms) + " ms、空载往返 " + fmt(st.p50) + " ms、响应 " + bytes
    + " B。不许靠加缓存压这个数（proxy_pool 带写副作用，见 gateway-pipe.cjs 的 NON_IDEMPOTENT_READS 注释）");
  console.log("BENCH 通过：proxy_pool 往返中位数 " + fmt(sp.p50) + " ms < " + POOL_RTT_BUDGET_MS + " ms");
}

if (process.argv.includes("--bench")) {
  bench().then(() => {
    cleanupOwnProcesses();
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows 偶发 EBUSY，交给系统回收 */ }
  }).catch((e) => {
    cleanupOwnProcesses();
    console.log("临时目录保留供排查：" + work);
    console.error(e && e.message ? e.message : e);
    process.exit(1);
  });
} else {
main().then(() => {
  cleanupOwnProcesses();
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows 偶发 EBUSY，交给系统回收 */ }
  console.log(`OK 生命周期基座 + 命令通道判据全通过（共 ${steps} 项）`);
}).catch((e) => {
  cleanupOwnProcesses();
  console.log("临时目录保留供排查：" + work);
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
}
