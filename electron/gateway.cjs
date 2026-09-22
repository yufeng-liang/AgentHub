// 独立网关子进程入口（二期）。跑法：ELECTRON_RUN_AS_NODE=1 <AgentHub.exe> <...>/app.asar/electron/gateway.cjs
// 为什么用同一个 exe 而不是系统 node：只有 Electron 自带 Node 在这条路上装了 asar 虚拟 FS，
// 实测系统 Node（v26）连 app.asar 都看不见（fs.statSync 直接 ENOENT）。
// 该角色下 require("electron") 抛 MODULE_NOT_FOUND —— 不是性质，是"electron 没被打进生产依赖"的性质，
// 所以本文件的任何断言都必须能容忍两种打包态；测试从中立 cwd 起（探针卫生第五条）。
//
// 职责边界：只做装配与生命周期，**不含业务逻辑**（业务全在 proxy/index.cjs 那张命令表里）。
// 与一期 boot() 的装配序差别：这里 rules.init + store.open + 周期 checkpoint，**不 listen、也不跑
// credits/checkin 两个后台计时器**——监听决策归主进程（Task 6），而那两个计时器在 Task 5 把命令下沉之前
// 仍由主进程跑着；子进程抢先一份就会双跑（同一批号被签到两次）。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const gatewayPipe = require("./backend/gateway-pipe.cjs");
const log = require("./backend/gateway-log.cjs");      // Step 5
const store = require("./backend/proxy/store.cjs");
const secretbox = require("./backend/proxy/secretbox.cjs");
const util = require("./backend/proxy/util.cjs");
const rules = require("./backend/proxy/rules.cjs");
const server = require("./backend/proxy/server.cjs");
const proxy = require("./backend/proxy/index.cjs");

const WATCHDOG_MS = 5000;
// 停机到 process.exit 的硬上界：它必须大于 index.cjs 里 drainLibuvWork 的预算（1 s），
// 否则「必须退」会抢在「等干净」之前拿到决定权，等于把根因又盖回去。
const EXIT_CEILING_MS = 2000;

// 看门狗与优雅停机都要读的三个模块内引用：由 main() 装配时赋值（不是全局状态装饰）。
let persistent = false;
let srvRef = null;
let watchdogTimer = null;

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
  const hs = await readHandshake();            // { token, parentPid, persistent, pipePath }
  persistent = !!hs.persistent;                // 看门狗与 gracefulExit 都读它（装配序，见文件头三个 let）
  log.line("boot", { version: util.appVersion(), secretBackend: secretbox.backend(), persistent });
  secretbox.assertUsable();                    // 凭据不可用 → 启动期失败，不空号池空转
  rules.init(); store.open();                  // 与一期 boot() 同一装配序（不含 server.start）
  store.startCheckpointTimer();
  const srv = await gatewayPipe.serve({
    token: hs.token, pipePath: hs.pipePath,           // pipePath 由主进程命名并经握手投递（两端必须同一个值）
    // 两条内建命令不属于那 43 条，故不进 preload 白名单；gateway_echo 供认领双检验 token，
    // gateway_shutdown 供 Task 7 互锁（它复用 gracefulExit → proxy.gracefulShutdown，不开第二份停机实现）。
    // 其余一律交给网关自己的命令表。
    dispatch: (cmd, args) =>
      cmd === "gateway_echo" ? { v: String((args && args.v) || "") }
      : cmd === "gateway_shutdown" ? gracefulExit("gateway-shutdown")
      : proxy.dispatch(cmd, args),
  });
  srvRef = srv;
  // sink 必须在 srv 建好之后注入（否则子进程启动早期 events.emit 无处可写）——这是装配序，不是风格
  proxy.attachGatewayMode({ emit: (payload) => srv.broadcast({ k: "evt", payload }) });
  writeGatewayFile({
    pid: process.pid, pipe: srv.pipePath, token: hs.token, port: 0,
    version: util.appVersion(), startedAt: Date.now(), secretBackend: secretbox.backend(),
  });
  startWatchdog(hs.parentPid);
  await srv.ready;                             // 主进程连上后才算 ready
}

/** gateway.json 落盘：握手认领的依据，主进程可能在子进程写的中途去读，故走「写中转名 → rename」。
 *  中转名必须带 pid（Task 2 的写权闸按结构判据守这条：同一变量的 writeFileSync + renameSync 配对
 *  ⇒ 构造式必须含 process.pid）；拼法沿用 proxy/ 目录既有口径 `${file}.tmp-${process.pid}`。
 *  不抽公共 helper：一旦 write 与 rename 一起搬进 helper，那条结构判据就完全隐身（Task 2 §9.8-1）。 */
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

// 看门狗：父进程没了且 persistent=off → 自行退出，避免孤儿进程占着 9527。
// 同时监视 exe 映像：卸载/升级会删掉安装目录，届时留着进程只会锁文件（实测 portable stub 也是 RMDir /r）。
function startWatchdog(parentPid) {
  const t = setInterval(() => {
    let parentAlive = true;
    try { process.kill(parentPid, 0); } catch (e) { parentAlive = e.code !== "ESRCH"; }
    if (!parentAlive && !persistent) { gracefulExit("parent-exit"); return; }
    if (!fs.existsSync(process.execPath)) { gracefulExit("exe-gone"); return; }
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
 */
function gracefulExit(reason) {
  if (persistent && server.status().running) {                 // 常驻形态：父进程没了正是设计目标，不退出
    log.line("detach-keep", { reason, port: server.status().port });
    stopWatchdog();                                            // 但必须停掉对父进程的轮询，别每 5s 刷日志
    return Promise.resolve({ ok: true, detached: true });
  }
  log.line("exit", { reason });
  stopWatchdog();
  const done = proxy.gracefulShutdown()
    .then((r) => {
      const drained = !!(r && r.drained);
      log.line("shutdown-done", { drained });        // drained:false = 停机没排干净，Task 7 的报错文案要看得见他
      return { ok: true, drained };
    })
    .catch((e) => {
      log.line("shutdown-error", { message: String((e && e.message) || e) });
      return { ok: false, message: String((e && e.message) || e) };
    });
  if (srvRef) srvRef.close();        // 不用 gatewayPipe.closeAll()（无此 API）：管道由本文件唯一那条 srv 引用负责
  // 停机做完（或最多再等 2 s）才退。这里**不能**在 done 落定的同一刻直接 process.exit()：
  // gracefulShutdown() 内部已经等到 libuv 线程池的在途作业（chokidar 首扫的 readdir/stat）落地，
  // 那是 0xC0000409 fastfail 的根因；2 s 这条上界是「停不干净也必须给 NSIS 解锁映像」的兜底，
  // 不是用来掩盖没排空的事实——真没排空，drainLibuvWork 会把 drained:false 回给 gateway_shutdown。
  Promise.race([done, new Promise((r) => setTimeout(r, EXIT_CEILING_MS))]).then(() => process.exit(0));
  return done;
}

main().catch((e) => { log.line("fatal", { message: String((e && e.message) || e) }); process.exit(1); });
