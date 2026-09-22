// 独立网关子进程入口（二期）。跑法：ELECTRON_RUN_AS_NODE=1 <AgentHub.exe> <...>/app.asar/electron/gateway.cjs
// 为什么用同一个 exe 而不是系统 node：只有 Electron 自带 Node 在这条路上装了 asar 虚拟 FS，
// 实测系统 Node（v26）连 app.asar 都看不见（fs.statSync 直接 ENOENT）。
// 该角色下 require("electron") 抛 MODULE_NOT_FOUND —— 不是性质，是"electron 没被打进生产依赖"的性质，
// 所以本文件的任何断言都必须能容忍两种打包态；测试从中立 cwd 起（探针卫生第五条）。
//
// 职责边界：只做装配与生命周期，**不含业务逻辑**（业务全在 proxy/index.cjs 那张命令表里）。
// 与一期 boot() 的装配序差别：这里 rules.init + store.open + 周期 checkpoint + 后台作业
// （Task 5 起：credits 定时刷新与定时签到随命令实现体下沉到这里，startBackgroundJobs），
// **不 listen**——监听决策归主进程，主进程经 proxy_start/proxy_stop 转发体驱动。
// 入口有两种来历（Task 6，共用下面同一个装配，不复制一份）：
//  · 握手认领：主进程 spawn 并从 stdin 投递握手（token/pipePath 由主进程命名）；
//  · 自启（--persistent）：启动器 agenthub-gateway.cmd / Run 项直接拉起，token 与 pipePath
//    由子进程自造、gateway.json 多写 tokenSource:"file"，主 App 之后从文件认领。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const gatewayPipe = require("./backend/gateway-pipe.cjs");
const log = require("./backend/gateway-log.cjs");      // Step 5
const store = require("./backend/proxy/store.cjs");
const secretbox = require("./backend/proxy/secretbox.cjs");
const util = require("./backend/proxy/util.cjs");
const rules = require("./backend/proxy/rules.cjs");
const server = require("./backend/proxy/server.cjs");
const proxy = require("./backend/proxy/index.cjs");

const WATCHDOG_MS = 5000;
// 停机到 process.exit 的硬上界：它必须大于「等干净」的总预算
// （server.CLOSE_BUDGET_MS + index.DRAIN_BUDGET_MS + 本文件的 RESPONSE_FLUSH_MS），
// 否则「必须退」会抢在「等干净」之前拿到决定权，等于把根因又盖回去（评审 I2②）。
// 这四个数字由 scripts/dev-gateway-pipe-test.cjs 的**同一条断言**钉住：改一个忘改另一个当场变红。
const EXIT_CEILING_MS = 2000;
// 优雅停机完成后留给 gateway_shutdown 响应帧 flush 的窗口（评审 I2③：drained/forced 必须先送到
// 父进程手上，才允许关管道 / 退进程）。见 gracefulExit 里那串时序注释。
const RESPONSE_FLUSH_MS = 300;
// 「停不干净」的退出码：0 只留给真排干的那一支。父进程在 child-exit 里看得见它，
// Task 7 的报错文案据此区分「停干净」与「抢在上界前硬退」。
const UNCLEAN_EXIT_CODE = 3;

// 看门狗与优雅停机都要读的几个模块内引用：由 main() 装配时赋值（不是全局状态装饰）。
let persistent = false;
let srvRef = null;
let watchdogTimer = null;
// 看门狗盯的映像路径：由握手投递（真实形态下就是 process.execPath）。父进程才是知道"哪个映像必须被
// 解锁"的一方（装更/卸载互锁等的是它），投递顺带给 exe-gone 这条判据留了一个可构造的入口。
let watchedExe = process.execPath;
// 落盘 gateway.json 的那份记录：port 会随子进程的监听状态被回写（见 publishListeningPort）
let gatewayRecord = null;
// detach 之后不再轮询父进程（父进程本就该不在了），但**必须继续盯 exe**——见 startWatchdog 的注释
let watchParent = true;

// 会改变监听状态的命令：跑完就必须把端口回写进 gateway.json（评审 I1）。
// 只有这三条会动 server.status()，别的命令跑了不重复落盘。
const PORT_BOUND_CMDS = new Set(["proxy_start", "proxy_stop", "proxy_restart"]);

// token 只从 stdin 来（不放 argv：任务管理器和进程列表看得见，而它能调用返回明文 Key 的命令）
function readHandshake() {
  return new Promise((resolve, reject) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      s += d;
      if (!s.includes("\n")) return;
      const l = s.split("\n")[0].trim();
      if (!l) return;
      let o = null;
      try {
        o = JSON.parse(l);
      } catch (e) {
        // 半行 / 坏 JSON 不许变成 uncaughtException：那样崩因只会出现在 stderr，连一行 boot 日志都没有，
        // 主进程侧只剩"起不来"（规格 §七.1 要的是报得人话）。留痕后按握手失败收。
        log.line("handshake-bad-json", { message: String((e && e.message) || e), bytes: l.length });
        cleanup();
        reject(new Error("握手不是合法 JSON（父进程投递被截断？）"));
        return;
      }
      cleanup();
      resolve(o);
    });
    process.stdin.on("end", () => reject(new Error("stdin 提前关闭：父进程未投递握手")));
    function cleanup() { try { process.stdin.pause(); } catch { /* 已关 */ } }
  });
}

async function main() {
  // 自启路径（--persistent，Task 6）：启动器/Run 项直接拉起本进程，没有父进程投递 stdin 握手——
  // 照原样 await readHandshake() 会永久挂在读 stdin 上（扫描修正 P4）。这条路径 token 由子进程
  // 自己生成并写进 gateway.json（§偏差 D4），主 App 之后从文件认领；pipePath 也自造（与
  // gateway-client.cjs 的命名同款，主进程认领时以盘上那份为准）。两条路径共用下面同一个
  // srv/看门狗装配，不复制一份。token 走随机生成而不是 argv/env：进程列表看得见，而它能调
  // 返回明文 Key 的命令（readHandshake 同一条纪律）。
  const argvPersistent = process.argv.includes("--persistent");
  const hs = argvPersistent
    ? { token: crypto.randomBytes(24).toString("hex"), parentPid: 0, persistent: true, pipePath: null, tokenSource: "file" }
    : await readHandshake();                     // { token, parentPid, persistent, pipePath, exePath? }
  if (argvPersistent) {
    hs.pipePath = String.raw`\\.\pipe\agenthub-gw-${process.pid}-${Date.now().toString(36)}`;
  }
  persistent = !!hs.persistent;                // 看门狗与 gracefulExit 都读它（装配序，见文件头那几个 let）
  watchedExe = String(hs.exePath || process.execPath);
  log.line("boot", { version: util.appVersion(), secretBackend: secretbox.backend(), persistent });
  secretbox.assertUsable();                    // 凭据不可用 → 启动期失败，不空号池空转
  rules.init(); store.open();
  store.startCheckpointTimer();
  // 握手文件必须在**开始 accept 之前**落盘：主进程的 connect 一成功就返回 ok（它只等 socket 建成，
  // 不等这份文件），文件写在 listen 之后就是让父进程读一个还不存在的真相源——实测会随机红
  // （dev-gateway-pipe-test ①「gateway.json 不存在」，磁盘慢的那几次必中）。
  // 不变式因此变成「管道连得上 ⇒ 握手文件已在盘上」，认领方与 stopAndWait 的 portFreed 都靠它。
  gatewayRecord = {
    pid: process.pid, pipe: hs.pipePath, token: hs.token, port: 0,
    version: util.appVersion(), startedAt: Date.now(), secretBackend: secretbox.backend(),
    // 自启路径多写一个来历标记：握手认领的（stdin 路径）没有这个字段，自启的是 "file"。
    // Task 8 的验收报告据此区分两种来历，不靠猜。
    ...(argvPersistent ? { tokenSource: "file" } : {}),
  };
  writeGatewayFile(gatewayRecord);
  const srv = await gatewayPipe.serve({
    token: hs.token, pipePath: hs.pipePath,           // pipePath 由主进程命名并经握手投递（两端必须同一个值）
    // 两条内建命令不属于那 43 条，故不进 preload 白名单；gateway_echo 供认领双检验 token，
    // gateway_shutdown 供 Task 7 互锁（它复用 gracefulExit → proxy.gracefulShutdown，不开第二份停机实现）。
    // 其余一律交给网关自己的命令表。
    // 监听状态一变就得回写 gateway.json 的 port（评审 I1）：那一份盘上文件是父进程侧
    // stopAndWait 的 portFreed 与 probeResidentGateway 的端口归属**唯一**的真相来源，
    // 写死 0 时那两条判据一个恒真、一个恒不成立。
    dispatch: async (cmd, args) => {
      if (cmd === "gateway_echo") return { v: String((args && args.v) || "") };
      if (cmd === "gateway_shutdown") return gracefulExit("gateway-shutdown");
      const r = await proxy.dispatch(cmd, args);
      if (PORT_BOUND_CMDS.has(cmd)) publishListeningPort();
      return r;
    },
  });
  srvRef = srv;
  // sink 必须在 srv 建好之后注入（否则子进程启动早期 events.emit 无处可写）——这是装配序，不是风格
  proxy.attachGatewayMode({ emit: (payload) => srv.broadcast({ k: "evt", payload }) });
  // 后台作业随命令实现体一起下沉（Task 5）：credits 定时刷新 + 定时自动签到过去在主进程
  // boot() 里跑；43 条命令转发化之后主进程不再 require proxy 域，这两个计时器留在主进程
  // 就会消失、跑在子进程就会双跑 —— 现在归子进程一份，且只有这一份。
  proxy.startBackgroundJobs();
  startWatchdog(hs.parentPid);
  await srv.ready;                             // 主进程连上后才算 ready
}

/** 把当前监听端口回写进 gateway.json（值真变了才写，不是每条命令落一次盘）。
 *  写失败必须留痕：port 不落盘 = 父进程侧两条判据失去真相源，静默等于把缺陷藏回日志之外。 */
function publishListeningPort() {
  if (!gatewayRecord) return;
  const st = server.status();
  const port = st.running ? st.port : 0;
  if (Number(gatewayRecord.port) === Number(port)) return;
  gatewayRecord = { ...gatewayRecord, port };
  try {
    writeGatewayFile(gatewayRecord);
    log.line("gateway-port", { port, written: true });
  } catch (e) {
    log.line("gateway-port", { port, written: false, message: String((e && e.message) || e) });
  }
}

/** gateway.json 落盘：握手认领的依据，主进程可能在子进程写的中途去读，故走「写中转名 → rename」。
 *  中转名必须带 pid（Task 2 的写权闸按结构判据守这条：同一变量的 writeFileSync + renameSync 配对
 *  ⇒ 构造式必须含 process.pid）；拼法沿用 proxy/ 目录既有口径 `${file}.tmp-${process.pid}`。
 *  不抽公共 helper：一旦 write 与 rename 一起搬进 helper，那条结构判据就完全隐身（Task 2 §9.8-1）。
 *  监听端口的回写（publishListeningPort）也走这**同一个**写法，不另起第二处中转。 */
function writeGatewayFile(obj) {
  const target = path.join(store.proxyDir(), "gateway.json");
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 半成品已不在 */ }
    throw e;
  }
}

/** 版本比对与回收都在**主进程**侧（见 gateway-client 的 start()）：子进程不知道自己是不是"上一版留下的"。
 *  顺序必须是「先停旧、确认端口释放、再起新」：反序会 EADDRINUSE。
 *  代价是打断在途 SSE —— 只在主 App 启动时发现 version ≠ util.appVersion() 才发生，
 *  与 Task 7 的装更互锁共用同一条 stopAndWait 实现，不开第二条口子。 */

// 看门狗两条规则（评审 I4 后各自独立）：
//  · 父进程没了 → 交 gracefulExit("parent-exit") 定夺：常驻则 detach 继续服务，非常驻则自行退出，
//    避免孤儿进程占着 9527；
//  · exe 映像不在了（升级/卸载删掉安装目录）→ 一律收摊，NSIS 最需要解锁映像的就是这一刻。
// detach（常驻）只允许关掉**第一条**的轮询：常驻形态下父进程本来立刻就没了，若把整个计时器 clear 掉，
// 第二条的 exe 监视就此永久失效——而 detach 恰恰是唯一需要它的情形（旧代码正是这么错的）。
// 两条规则的取舍按 reason 走，不按"当前是否在监听"走：见 gracefulExit 的注释。
function startWatchdog(parentPid) {
  // parentPid 为 0（--persistent 自启路径）时跳过父进程探测：kill(0,0) 的语义是「当前进程组」，
  // 拿它当「父进程还活着」的判据结果不定——这条路径没有父进程可盯，只保留 exe-gone 那条线；
  // detach（父进程退出后的常驻形态）同样只关掉第一条轮询，两条规则的取舍见 gracefulExit 的注释。
  watchParent = !!parentPid;
  const t = setInterval(() => {
    if (watchParent) {
      let parentAlive = true;
      try { process.kill(parentPid, 0); } catch (e) { parentAlive = e.code !== "ESRCH"; }
      if (!parentAlive) { gracefulExit("parent-exit"); return; }
    }
    if (!fs.existsSync(watchedExe)) { gracefulExit("exe-gone"); return; }
  }, WATCHDOG_MS);
  watchdogTimer = t;
  if (t.unref) t.unref();
}

function stopWatchdog() {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = null;
}

/**
 * 优雅停机 + 退出。两条入口共用这一个函数（不开第二份实现）：
 *  · 看门狗：parent-exit / exe-gone
 *  · 主进程的 gateway_shutdown 命令（Task 7 的装更与卸载互锁走的就是这条命令）
 * 所以它的返回值就是那条命令的响应体。返回值之后进程一定会退出：主进程侧 stopAndWait 等的是
 * 「socket 关闭 + pid 消失」（规格 §5.6），因此这里必须连进程一起收，只停子系统不算停。
 *
 * detach 保护只对 parent-exit 生效（评审 I4）：简报伪码把这条保护写在了 reason 之前，于是
 * exe-gone 在常驻形态下被同一个 return 吞掉——两规则冲突时 reason 优先。
 *
 * 停机结论（drained / forced / port）一定要送到父进程手上（评审 I2③）。投递路径选了「先发响应、
 * 再关管道、最后退进程」这一条，理由：
 *  · 备选①「只走子进程日志」：父进程得去解析自己不该拥有格式的日志文件，且 stopAndWait 的返回契约
 *    里至今没有这两个字段，Task 7 的报错文案就没法据此判"这次停干净了没有"；
 *  · 备选②「另开一条投递通道」（管道之外再起一条 socket/文件）：为两个布尔新增一条 IPC，
 *    与「不新增端口、不新增第二条停机实现」的既定边界冲突；
 *  · 现有那条 gateway_shutdown 响应本来就是这次停机的天然回执，只差没被丢掉。而它过去确实被丢掉：
 *    老代码在 dispatch 还没 resolve 时就同步 srvRef.close()，destroy 掉 socket 把响应帧一起带走了。
 *    所以顺序改成：done 出结论 → 微任务里 pipe 写帧 → 等 RESPONSE_FLUSH_MS 让 uv_write 落到内核缓冲
 *    → 才关管道（关早了就又丢帧）→ 干净则退 0；不干净**不**退 0，那条 ref 着的 EXIT_CEILING_MS 上界
 *    计时器一定会在 2000 ms 后以 UNCLEAN_EXIT_CODE 硬退（它是唯一的硬退点，也是不干净那一支的唯一出口）。
 */
function gracefulExit(reason) {
  const st = server.status();
  // 常驻 + 「父进程没了」这一条 reason：不退出，只与父进程脱钩（这正是本期设计目标）。
  // 判据是 persistent 而不是 persistent && running：常驻的定义是"活过主 App"，与此刻有没有在监听无关
  // （闸 ③ 的常驻用例子进程本来就不监听）。旧代码把这条保护写在 reason 之前，于是 exe-gone 也被吞掉。
  if (reason === "parent-exit" && persistent) {
    log.line("detach-keep", { reason, port: st.port });
    watchParent = false;                       // 只对父进程"脱钩"，exe 那一检继续（见 startWatchdog）
    return Promise.resolve({ ok: true, detached: true, port: st.port });
  }
  log.line("exit", { reason });
  stopWatchdog();
  // 唯一的硬退点：上界计时器。它 ref 着事件循环，所以"没排干净"这一支一定会在 EXIT_CEILING_MS 后
  // 以 UNCLEAN_EXIT_CODE 收场（不是静默 0），父进程在 child-exit 那行看得见。
  let exited = false;
  const finish = (code) => { if (exited) return; exited = true; process.exit(code); };
  setTimeout(() => finish(UNCLEAN_EXIT_CODE), EXIT_CEILING_MS);
  const done = proxy.gracefulShutdown()
    .then((r) => {
      const rep = {
        ok: true,
        drained: !!(r && r.drained),
        forced: !!(r && r.forced),              // 监听没在 CLOSE_BUDGET_MS 内释放（server.stopAsync 认的输）
        port: (r && Number(r.port)) || 0,       // 刚释放的那个端口，父进程据此探"是不是真空了"
      };
      log.line("shutdown-done", { drained: rep.drained, forced: rep.forced, port: rep.port });
      return rep;
    })
    .catch((e) => {
      const rep = { ok: false, drained: false, forced: false, port: 0, message: String((e && e.message) || e) };
      log.line("shutdown-error", { message: rep.message });
      return rep;
    });
  // 响应帧的投递窗口：dispatch 的 Promise 一旦 resolve，gateway-pipe 在**同一个微任务**里 writeFrame；
  // setImmediate 是宏任务（必然后于微任务）→ 此刻帧已进 socket 写队列。再等 RESPONSE_FLUSH_MS 让
  // uv_write 真落到内核缓冲，之后才关管道（srvRef.close() 会 destroy 所有 socket，关早了帧就没了），
  // 最后把结论 resolve 出去（= 响应里带的就是这份）。
  const acked = done.then((rep) => new Promise((resolve) => {
    setImmediate(() => setTimeout(() => {
      if (srvRef) { try { srvRef.close(); } catch { /* 已关 */ } }
      resolve(rep);
    }, RESPONSE_FLUSH_MS).unref());            // unref：帧没写完时 socket 自身还 ref 着循环，不需要这条计时器续命
  }));
  acked.then((rep) => {
    if (rep.ok && rep.drained && !rep.forced) { finish(0); return; }   // 排干了：管道已关、响应已出，退 0
    // 没排干（或 gracefulShutdown 自己抛了错）：**不**走 process.exit(0)，也不指望事件循环自然收摊——
    // 上面那条 EXIT_CEILING_MS 的计时器是 ref 着的，所以这一支**必然**在 2000 ms 后由 finish(UNCLEAN_EXIT_CODE)
    // 收场（父进程在 child-exit 那行看到 3）。换句话说：留痕之后这里没有第三条路，别把「事件循环空了就自己退」
    // 当成本分支的行为——那条分支在有上界计时器之后已经不可达。
    log.line("shutdown-unclean", {
      reason, drained: rep.drained, forced: rep.forced, ok: rep.ok, message: rep.message || "",
    });
  });
  return done;
}

// 只在**作为入口**被跑时才装配（被 require 时一个副作用都不许有）。dev-gateway-pipe-test 要把停机预算的
// 四个数字拿在手里断言（评审 I2②：改一个忘改另一个必须当场变红），而那几个数字的真相源就是本文件；
// 没有这道守卫，require 会直接把 main() 跑起来等握手。
// 实测 require.main === module 在 ELECTRON_RUN_AS_NODE=1 那条路上同样成立（真子进程闸 ①③ 全绿即证据）。
if (require.main === module) {
  main().catch((e) => { log.line("fatal", { message: String((e && e.message) || e) }); process.exit(1); });
} else {
  // 入口被当成模块 require 了（打包路径 / asar 前缀写错 / 有人顺手 import 它）：装配一行都没跑，
  // 子进程会静默地什么都不做。留一痕，否则排查时连「入口没被当 main 跑」这条都看不到。
  log.line("entry-not-main", { filename: __filename, parent: require.main && require.main.filename });
}

module.exports = { EXIT_CEILING_MS, RESPONSE_FLUSH_MS, UNCLEAN_EXIT_CODE, WATCHDOG_MS };
