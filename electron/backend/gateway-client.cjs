// 网关子进程的主进程侧监督器（二期 Task 3）+ 主进程注册面（二期 Task 5）。
//
// 职责：spawn / 认领 / 看门狗对端（父进程）/ 优雅停机等待 / 命令转发出口 / 事件扇出 /
//       **43 条 proxy_* 命令的 ipcMain 注册面**（36 条纯转发 + 4 条 UI_LOCAL + 3 条薄包装）。
// 业务实现体一条不在这里——43 条命令的实现体在 proxy/index.cjs，经这里的 call() 走管道下发；
// 仅有的主进程本地逻辑：UI_LOCAL 四条（dialog/shell 的真 UI 依赖）与薄包装成功后的
// restoreOnLaunch 写权（config.json 归主进程写，子进程永不写）。
// 为什么主进程侧只 require store 的 proxyDir()：gateway.json 与日志的路径真相源必须与子进程写的
// 那一份同源（两份解析 = 早晚漂移成两个文件）。这里不调 store.open()，不建库句柄；
// config.cjs 同理只读写 config.json，不触碰网关 store 的任何数据文件。
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const store = require("./proxy/store.cjs");
const util = require("./proxy/util.cjs");
const config = require("./config.cjs");
const log = require("./gateway-log.cjs");
const gatewayPipe = require("./gateway-pipe.cjs");
const { encode } = require("./gateway-proto.cjs");

/** 握手文件：子进程写、主进程读（规格 §5.2） */
function gatewayFile() {
  return path.join(store.proxyDir(), "gateway.json");
}

/** 子进程入口：与主进程同层（`electron/backend/` → `electron/gateway.cjs`）。
 *  打包态 __dirname 本身就在 `resources\app.asar\electron\backend` 里，所以这条相对路径天然留在 asar 内
 *  ——这是硬约束（计划正文 §前置约束）：入口跑出 asar 会让 secretbox.packaged() 判假 → 凭据明文落盘。 */
function gatewayScriptPath() {
  return path.join(__dirname, "..", "gateway.cjs");
}

/** 模块内存镜像：gateway.json 的字段 + 运行期才有的 child / claimed */
let mirror = null;
let conn = null;            // 与子进程保持的那条连接（事件回流与 call 的出口）
let child = null;
const eventCbs = new Set();

function readGatewayFile() {
  try {
    const o = JSON.parse(fs.readFileSync(gatewayFile(), "utf8"));
    if (!o || typeof o !== "object" || !o.pipe || !o.token) return null;
    return o;
  } catch {
    return null;            // 不存在 / 半个文件 / 不是 JSON 都算「没有可用的网关」
  }
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

/** 建立（或复用）主进程那条长连接：call 与事件回流都走它。 */
async function holdConnection(info) {
  if (conn && conn.connected) return true;
  if (conn) { try { conn.close(); } catch { /* 已断 */ } conn = null; }
  const c = await gatewayPipe.connect({ pipePath: info.pipe, token: info.token, timeoutMs: 3000 }).catch(() => null);
  if (!c) return false;
  c.onEvent((payload) => { for (const cb of eventCbs) { try { cb(payload); } catch { /* 订阅者的错不带崩监督器 */ } } });
  conn = c;
  return true;
}

function dropConnection() {
  if (conn) { try { conn.close(); } catch { /* 已断 */ } }
  conn = null;
}

/**
 * 双检：kill(pid,0) 只证明 pid 活着，pid 复用会骗过它 → 必须再连一次管道并验 hello/token。
 * 真正的判据在**子进程侧**：token 对不上时服务端直接 destroy 连接，call 拿不到响应 → 这里回 false。
 * （gateway_echo 那一步是第二层：管道被别的实现接走时它也会露馅。握手本身没有独立 ack 帧——
 *  「hello 之后能拿回一条响应」就是 ack，所以这一腿必须在 echo 上真跑一次，不能只看 connect 成功。）
 */
async function probeAlive(cur) {
  if (!cur || !cur.pid || !pidAlive(cur.pid)) return false;
  const c = await gatewayPipe.connect({ pipePath: cur.pipe, token: cur.token, timeoutMs: 1500 }).catch(() => null);
  if (!c) return false;
  const r = await c.call("gateway_echo", { v: String(cur.token).slice(0, 8) }, { timeoutMs: 1500 }).catch(() => null);
  c.close();
  return !!(r && r.v === String(cur.token).slice(0, 8));
}

/**
 * 回收陈旧握手文件。
 * 这里**绝不按 pid 杀进程**：能走到这条路的 pid 恰恰是「活着但认证不过」的——pid 复用场景下那是
 * 别人的进程（一期踩过宽匹配杀进程的坑，见 AGENTS.md 与派发硬约束）。清理只做一件事：**把陈旧的
 * gateway.json 删掉**（fs.rmSync，force 语义：文件已被别人收走也算回收完成），让新子进程从干净状态起；
 * 不做改名留档——那份文件里的 token/pid 已经作废，留着只会被下一个 readGatewayFile 误读。
 * 真活着又连不上的网关由版本不匹配分支经 token 认证后停（start() 的 reclaim-restart 那一支）。
 */
async function reap(cur) {
  if (!cur) return;
  try {
    fs.rmSync(gatewayFile(), { force: true });
    log.line("reap-stale", { pid: cur.pid, pipe: cur.pipe, version: cur.version, pidAlive: pidAlive(cur.pid) });
  } catch (e) {
    log.line("reap-failed", { message: String((e && e.message) || e) });
  }
  mirror = null;
}

// ===== 启动互斥（评审 I1 修复轮）：所有 start() 调用点汇入同一条在飞 promise =====
// start() 本体没有互斥，双入会各自 spawn 一个子进程抢同一份 gateway.json：
//  · 双 spawn：child 模块变量被 #2 覆盖，#1 的 8s connect 超时分支 child.kill() 杀错孩子，
//    孤儿进程持有 store 句柄 —— 违背 §5.4 的 stats.db 独占不变式；
//  · 双连接：握手已落盘时第二入口走 claimed 分支，两条连接都注册过 onEvent → 事件投递翻倍
//    （oauth-open 会开两个浏览器标签）。
// 互斥必须长在 start() 本体而不是某个入口：main.cjs whenReady 的裸调（boot 启动路径）、转发侧的
// ensureStarted、未来任何新调用点才都汇入同一条路径。在飞期间第二次调用拿到的是**同一条**
// promise 的结果（同 pid / 同 claimed），不是并发的第二次 spawn。dedup 不看实参：boot 侧传
// boot.schedule.persistentGateway、转发侧传 persistentFlag()，两者同读 config.json 同一字段，先到者定形。
// 竞态窗口实测：spawn 慢时可达数秒（Windows AV 扫 exe 是现实场景），渲染层首条 proxy 命令足以撞上。
let startInflight = null;
function start(opts) {
  if (startInflight) return startInflight;
  startInflight = startOnce(opts).finally(() => { startInflight = null; });
  return startInflight;
}

/**
 * 启动或认领网关子进程（start() 的本体，单飞保证见上面那层互斥）。返回 { ok, claimed, pid, port, message }。
 */
async function startOnce({ persistent } = {}) {
  // 便携版拒常驻（Task 6）：便携版是 %TEMP% 的临时解压副本——detached 出去的子进程会锁住解压目录，
  // 卸载/清理都删不掉；Run 项指向的路径也在退出即失效的位置。这里对「请求常驻」整体拒绝、不做降级启动：
  // ok:true（对调用方不算失败，UI 不该吃到红错）+ persistent:false + 人话 message，且不 spawn。
  // 便携版不落 Run 项由 config.applyAutoStart 的便携版早退保证，两条路径合成零注册。
  // 正常形态到不了这里：设置页在便携版灰置 persistentGateway 开关（ConfigGeneralSection）。
  if (persistent && config.isPortable()) {
    log.line("portable-reject-persistent", {});
    return { ok: true, persistent: false, message: "便携版不支持后台常驻" };
  }
  const cur = readGatewayFile();
  if (cur && (await probeAlive(cur))) {
    if (cur.version !== util.appVersion()) {
      // 版本不匹配（升级后 exe 路径可能已失效，尤其便携版 %TEMP% 解压目录）：先停旧再起新。
      // 反序新进程会 EADDRINUSE（规格 §5.5）。代价是打断在途 SSE，只在启动时发现一次。
      const r = await stopAndWait({ timeoutMs: 5000 });
      log.line("reclaim-restart", { from: cur.version, to: util.appVersion(), stopped: r.stopped, portFreed: r.portFreed });
      if (!r.stopped) return { ok: false, claimed: false, pid: cur.pid, port: cur.port || 0, message: r.message };
    } else {
      if (!(await holdConnection(cur))) {
        return { ok: false, claimed: false, pid: cur.pid, message: "已认证到子进程但建不起长连接（管道被占用或已断）" };
      }
      mirror = { ...cur, claimed: true };
      return { ok: true, claimed: true, pid: cur.pid, port: cur.port || 0 };
    }
  }
  if (cur && cur.pid) await reap(cur);                // 陈旧 pid 复用 / 被任务管理器杀：先回收
  const token = crypto.randomBytes(24).toString("hex");
  // Windows named pipe 名字里的 `\\?\pipe\` 前缀是允许的等价形式，这里统一用 `\\.\pipe\`。
  // 用 String.raw 而不是转义串：转义层级写错时得到的是 `\.\pipe\x`（实测 EACCES），而不是报错。
  const pipePath = String.raw`\\.\pipe\agenthub-gw-${process.pid}-${Date.now().toString(36)}`;
  child = spawn(process.execPath, [gatewayScriptPath()], {
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1", AGENT_SKILLS_HOME: process.env.AGENT_SKILLS_HOME || "" }),
    cwd: path.dirname(process.execPath), stdio: ["pipe", "pipe", "pipe"], detached: !!persistent, windowsHide: true,
  });
  // spawn 的失败是**异步**的（exe 被别的安装器锁着 / 权限不足）：那时 stdin 已被 destroy，
  // 下面这条 write 会以 'error' 事件冒出来（ERR_STREAM_DESTROYED）。没有 handler 就是主进程一条
  // uncaughtException——规格 §七.1 要的是"起不来要能报出人话"，所以 handler 必须挂在 write **之前**，
  // 报人话那一句交给下面 connect 超时的返回值。
  if (child.stdin) child.stdin.on("error", (e) => log.line("child-stdin-error", { message: String((e && e.message) || e) }));
  try {
    // exePath：告诉子进程该盯哪个映像（装更/卸载等的是这个）。真实形态下与 process.execPath 同值。
    child.stdin.write(encode({
      token, parentPid: process.pid, persistent: !!persistent, pipePath, exePath: process.execPath,
    }) + "\n");
  } catch (e) {
    log.line("child-stdin-error", { message: String((e && e.message) || e), sync: true });
  }
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => log.line("child-stderr", { text: String(d).slice(0, 400) }));   // 子进程崩因必须留痕，否则只剩"起不来"
  if (child.stdout) {
    child.stdout.setEncoding("utf8");
    // 必须读走：没人消费的 stdout 管道缓冲区写满会把子进程**卡死在下一次 console.log 上**
    child.stdout.on("data", (d) => log.line("child-stdout", { text: String(d).slice(0, 400) }));
  }
  child.on("error", (e) => log.line("child-spawn-error", { message: String((e && e.message) || e) }));
  child.on("exit", (code, signal) => {
    log.line("child-exit", { code, signal });
    if (mirror) mirror = { ...mirror, alive: false };
    dropConnection();
  });
  const c = await gatewayPipe.connect({ pipePath, token, timeoutMs: 8000 }).catch((e) => ({ __error: e }));
  if (!c || c.__error) {
    log.line("spawn-no-pipe", { pid: child && child.pid, pipePath, exe: process.execPath, why: c && c.__error ? String((c.__error && c.__error.message) || c.__error) : "connect 回了空" });
    try { child.kill(); } catch { /* 已退 */ }
    dropConnection();
    return { ok: false, claimed: false, message: "子进程未在 8s 内建立管道（exe 可能被锁或权限不足）" };
  }
  c.onEvent((payload) => { for (const cb of eventCbs) { try { cb(payload); } catch { /* 订阅者的错不带崩监督器 */ } } });
  conn = c;
  mirror = { pid: child.pid, pipe: pipePath, token, port: 0, version: util.appVersion(), startedAt: Date.now(), claimed: false, alive: true };
  log.line("spawned", { pid: child.pid, pipe: pipePath, persistent: !!persistent });
  return { ok: true, claimed: false, pid: child.pid, port: 0 };
}

/**
 * 停掉子进程并等端口真的释放（Task 7 装更/卸载互锁的唯一出口）。
 * 只经已认证的管道下 gateway_shutdown：不按 pid 盲杀，因此 pid 复用场景下不会误伤别的进程。
 * 超时停不下来时**只报告不兜底强杀**——强杀是 Task 7 互锁要加的那一步（它需要先给用户报错文案）。
 *
 * 返回 { stopped, portFreed, drained, forced, port, message }：
 *  · portFreed 的端口取**盘上那份** gateway.json（子进程一开始监听就回写，见 gateway.cjs 的
 *    publishListeningPort），盘上是 0 时再退到停机响应带回的那个端口。评审 I1 之前这里只有
 *    `Number(cur.port)` 而 port 恒为 0 → portFreed 恒真，这条闸自我实现、不可能红。
 *  · drained / forced 三态（true / false / null）：null = 压根没拿到响应（子进程原本不在，或它没等到
 *    回包就退了）。投递顺序见 gateway.cjs 的 gracefulExit 注释（先写帧 → flush 窗口 → 才关管道）。
 */
async function stopAndWait({ timeoutMs = 5000 } = {}) {
  // 只信盘上的那一份：内存镜像可能是监听之前的旧值（评审 I1②）
  const cur = readGatewayFile() || mirror;
  if (!cur || !cur.pipe || !cur.token) return { stopped: true, portFreed: true, drained: null, forced: null, port: 0, message: "没有网关子进程（gateway.json 不存在或已陈旧）" };
  const diskPort = Number(cur.port) || 0;
  const aliveBefore = pidAlive(cur.pid);
  let own = null;
  let ack = Promise.resolve(null);
  if (aliveBefore) {
    own = conn && conn.connected ? conn : await gatewayPipe.connect({ pipePath: cur.pipe, token: cur.token, timeoutMs: 1500 }).catch(() => null);
    // 子进程会在回包前就退出，收不到响应是预期：忽略 reject，只看进程是否真的没了。
    // 注意这条连接**不能立刻 close**：destroy 会丢掉 socket 里还没 flush 出去的 shutdown 帧，
    // 于是「停不下来」会被误判成对端不配合。等进程没了再收。
    if (own) ack = own.call("gateway_shutdown", {}, { timeoutMs: Math.max(200, timeoutMs) })
      .then((r) => r, (e) => ({ __failed: String((e && e.message) || e) }));
  }
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(cur.pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const stopped = !pidAlive(cur.pid);
  const rep = await ack;
  if (own && own !== conn) { try { own.close(); } catch { /* 已断 */ } }
  dropConnection();
  mirror = null;
  const ackPort = rep && !rep.__failed ? Number(rep.port) || 0 : 0;
  const port = diskPort || ackPort;
  const portFreed = port ? !(await probePortBusy(port)) : true;
  // detached（常驻 + 在监听时收到 gateway_shutdown）没有"排干"这回事：那次压根没停机
  const drained = rep && !rep.__failed && !rep.detached ? !!rep.drained : null;
  const forced = rep && !rep.__failed && !rep.detached ? !!rep.forced : null;
  log.line("stopAndWait", { pid: cur.pid, stopped, portFreed, port, drained, forced, wasAlive: aliveBefore });
  let message = stopped ? (portFreed ? "已停止" : "子进程已退出但端口 " + port + " 仍被占用")
    : "子进程未在 " + timeoutMs + "ms 内退出（pid " + cur.pid + " 仍在）";
  if (stopped && drained === false) {
    // 本任务最坏的失败形态必须在返回值里看得见（评审 I2③）：Task 7 的互锁据此决定报错文案，
    // 而不是拿一个"看起来停了"的 stopped:true 放行
    message += "（停机未排干：drained=false forced=" + (forced ? "true" : "false") + "，详见子进程日志 shutdown-unclean）";
  }
  return { stopped, portFreed, drained, forced, port, message };
}

/** 端口是否还有人 accept：连上 = 占用（false = 已释放）。ECONNREFUSED / 超时都算释放。 */
function probePortBusy(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 800 });
    const done = (v) => { try { s.destroy(); } catch { /* 已断 */ } resolve(v); };
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
    s.on("timeout", () => done(false));
  });
}

/**
 * 「端口被占着的那个是不是常驻网关」（规格 §七.5）：EADDRINUSE 时用它把文案从
 * 「请更换端口」改成「已接管后台常驻网关」。只在 gateway.json 记的端口与目标端口一致、
 * 且双检通过时才认，否则保持原文案。
 */
async function probeResidentGateway(port) {
  const cur = readGatewayFile();
  if (!cur || !port || Number(cur.port) !== Number(port)) return false;
  return probeAlive(cur);
}

/**
 * 转发一条命令（Task 5 的转发体就一行）。管道断了回 reject，由上层错误态负责报给用户。
 * 早退这一支也走 gatewayPipe.noRetryError()：错误形状（notRetried + command）必须与管道层四类失败
 * 一致，否则 Task 5 按标记决定「能不能重发」时会把「压根没投出去」这一支漏成「可以重发」——
 * 那是重放语义的另一个入口（闸 ⑨h 钉的就是这个形状）。
 */
function call(cmd, args, opts) {
  if (!conn || !conn.connected) {
    return Promise.reject(gatewayPipe.noRetryError("网关子进程未连接（命令未投递：" + cmd + "）", cmd));
  }
  return conn.call(cmd, args, opts);
}

/** 订阅子进程回流的事件（payload 形如 { event:"proxy", type:"status", … }）。返回退订函数。 */
function onEvent(cb) {
  eventCbs.add(cb);
  return () => eventCbs.delete(cb);
}

/** gateway.json 的内存镜像 + { alive, connected }。
 *  端口/管道这些**会被子进程改**的字段一律以盘上那份为准（评审 I1②）：镜像是 spawn 当时抄的快照，
 *  子进程开始监听后回写的 port 它永远看不到。镜像只在盘上文件还没落下时兜个底。 */
function state() {
  const base = readGatewayFile() || mirror || {};
  return { ...base, alive: pidAlive(base.pid), connected: !!(conn && conn.connected) };
}

// ===== 主进程注册面（二期 Task 5）：43 条 proxy_* 命令的 ipcMain 注册 =====

// 逐字相等闸的三个真相源之一（scripts/dev-gateway-forward-parity-test.cjs）：
// ① preload.cjs ALLOWED_COMMANDS 的 proxy_* 全集 == ② git show main 一期基线 == ③ 这张名单。
// 名单在此处字面写死而不是从 index.cjs 的 dispatchTable 反推：反推要把整张 proxy 依赖图拉进
// 主进程（§5.4 白做）。新增命令的工序是 preload + index.cjs 注册体 + 这张名单三处同改，闸会盯住漏改。
const ALL_PROXY_CMDS = [
  "proxy_status", "proxy_start", "proxy_stop", "proxy_restart",
  "proxy_keys_list", "proxy_key_create", "proxy_key_update", "proxy_key_delete",
  "proxy_pool", "proxy_pool_strategy",
  "proxy_account_add", "proxy_account_remove", "proxy_account_toggle", "proxy_account_cool_off",
  "proxy_account_refresh", "proxy_credits_refresh", "proxy_credits_refresh_channel",
  "proxy_checkin_status", "proxy_checkin_run",
  "proxy_scan", "proxy_scan_import",
  "proxy_oauth_begin", "proxy_oauth_cancel", "proxy_oauth_submit_callback",
  "proxy_account_import_json", "proxy_account_import_file",
  "proxy_models", "proxy_models_sync",
  "proxy_ide_switch", "proxy_ide_status",
  "proxy_stats_overview", "proxy_stats_top", "proxy_stats_detail", "proxy_recent",
  "proxy_rules_list", "proxy_open_rules_dir", "proxy_open_data_dir", "proxy_vault_status",
  "proxy_poolsync_status", "proxy_poolsync_run", "proxy_poolsync_cancel",
  "proxy_ccswitch_status", "proxy_ccswitch_register",
];

// 4 条真 UI 依赖（规格 §5.7 归属定案）：实现体在本文件，不经管道（dialog/shell 子进程拿不到）。
// proxy_status / proxy_vault_status 规格漏判、实测可转发：它们的 electron 依赖 vaultOk() 已在
// Task 1 换成 secretbox.backend()（§偏差 D1）。
const UI_LOCAL = new Set(["proxy_account_import_file", "proxy_open_rules_dir", "proxy_open_data_dir", "proxy_oauth_begin"]);
// 3 条薄包装：转发给子进程，成功后由**主进程**写 config.json 的 restoreOnLaunch（写权归主进程）。
const RUN_WRITE = new Set(["proxy_start", "proxy_stop", "proxy_restart"]);
// import_file 拆两段的字节上限：管道单帧 8MB（超限即断连，gateway-proto），base64 再膨胀 1/3。
// 主进程先把门回显式错误，绝不把连接炸掉。账号 JSON/ZIP 常态远小于此。
const IMPORT_BLOB_MAX = 5 * 1024 * 1024;

/** 记住网关的开关状态（从 index.cjs 上移，Task 5）：每次启停成功都写回 proxy.restoreOnLaunch，
 *  下次打开应用按它决定是否自动启动（默认 false，即首次打开是关闭的）。落盘失败不影响本次启停。 */
function rememberRunning(running) {
  try {
    const cfg = config.loadConfig();
    if (cfg.proxy.restoreOnLaunch === running) return;
    cfg.proxy.restoreOnLaunch = running;
    config.saveConfig(cfg);
  } catch {
    /* 读不到/写不进配置：跳过本次记账 */
  }
}

/** 子进程是否常驻（活过主 App）。与一期 main.cjs 的 opt-in 同一真相源：schedule.persistentGateway。 */
function persistentFlag() {
  try {
    const c = config.loadConfig();
    return !!(c.schedule && c.schedule.persistentGateway);
  } catch {
    return false;
  }
}

/** 转发侧的启动入口：已连接就直接用，否则并入 start() 的在飞 promise。
 *  互斥长在 start() 本体（见其上方注释），这里不再自持一份 startInflight——
 *  那样只护得住转发侧，护不住 main.cjs boot 的裸调（评审 I1 修复轮的教训）。 */
async function ensureStarted() {
  if (state().connected) return { ok: true };
  return start({ persistent: persistentFlag() });
}

/** 纯转发体（36 条命令共用，含 proxy_status / proxy_vault_status 两条规格漏判的）。
 *  失败一律收成 {ok:false, message}（与一期 handle() 的形状一致，渲染层不拿 rejected promise）；
 *  错文保留 notRetried 的「不会自动重放…」后缀供排障，但这里**绝不重发**——非幂等读
 *  （proxy_pool / proxy_status 派生复活要回写库）与写操作的重放风险见 gateway-pipe.cjs 文件头。 */
async function forward(cmd, args) {
  const s = await ensureStarted();
  if (!s.ok) return { ok: false, message: "后台网关未能启动：" + s.message };  // 不得假死，显式错误
  try {
    const res = await call(cmd, args);
    if (RUN_WRITE.has(cmd) && res && res.ok) {
      // 评审 I3（从 index.cjs proxy_start 迁来）：claimed 分支本进程没有监听（端口归那台常驻网关），
      // 不许把「本机在监听」写进配置，否则下次开机按假状态自启。restart 不排除 claimed——
      // restart 的语义是「用户要它开着」，端口被接管时该意愿仍成立（原 index.cjs 两处的语义差）。
      if (cmd === "proxy_start" && res.claimed) return res;
      rememberRunning(cmd !== "proxy_stop");
    }
    return res;
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

/** UI_LOCAL · 从 JSON/ZIP 文件添加：主进程弹框 + 读字节，base64 过管道交给子进程半段
 *  proxy_account_import_blob（zip 解包与入池的实现体在 index.cjs，号池写权归子进程独占）。 */
async function importFileCmd({ channel } = {}) {
  const s = await ensureStarted();
  if (!s.ok) return { ok: false, message: "后台网关未能启动：" + s.message };
  const { dialog, BrowserWindow } = require("electron");
  const parent = BrowserWindow.getAllWindows()[0];
  const opts = {
    title: "选择账号 JSON / ZIP 文件",
    properties: ["openFile"],
    filters: [
      { name: "账号文件（JSON / ZIP）", extensions: ["json", "zip"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  };
  const r = await (parent ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts));
  if (r.canceled || !r.filePaths.length) return { ok: true, canceled: true };
  const file = r.filePaths[0];
  const buf = fs.readFileSync(file);
  if (buf.length > IMPORT_BLOB_MAX) {
    return { ok: false, message: "文件过大（超过 " + Math.floor(IMPORT_BLOB_MAX / 1024 / 1024) + " MB），请拆分后导入" };
  }
  const res = await call("proxy_account_import_blob", { channel, blob: buf.toString("base64"), name: path.basename(file) });
  if (res && res.ok) res.file = path.basename(file);   // 结果文案的文件名：子进程只见字节，原始名由主进程补
  return res;
}

/** UI_LOCAL · 打开规则 / 数据目录：路径真值仍以 store.proxyDir() 为源（本文件既有依赖），
 *  目录内容归子进程 —— 先 ensureStarted 让 rules.init() 真的建过目录，再开，别开出一个空壳路径。 */
async function openDirCmd(sub) {
  const s = await ensureStarted();
  if (!s.ok) return { ok: false, message: "后台网关未能启动：" + s.message };
  const shell = require("electron").shell;
  if (!shell) return { ok: false, message: "该操作需要主进程界面，不能由后台常驻网关执行" };
  const dir = sub === "rules" ? path.join(store.proxyDir(), "rules") : store.proxyDir();
  fs.mkdirSync(dir, { recursive: true });   // 与 rules.rulesDir() 的「访问即建」口径一致
  await shell.openPath(dir);
  return { ok: true };
}

/** UI_LOCAL · OAuth 登录：命令体只做转发并回传子进程结果（会话建好后的 {type:"oauth-open", url}
 *  事件由 main.cjs 收到才 shell.openExternal —— 浏览器打开在主进程，会话状态在子进程）。 */
async function oauthBeginCmd(args) {
  const s = await ensureStarted();
  if (!s.ok) return { ok: false, message: "后台网关未能启动：" + s.message };
  try {
    return await call("proxy_oauth_begin", args);
  } catch (e) {
    return { ok: false, message: String((e && e.message) || e) };
  }
}

const UI_LOCAL_IMPL = {
  proxy_account_import_file: importFileCmd,
  proxy_open_rules_dir: () => openDirCmd("rules"),
  proxy_open_data_dir: () => openDirCmd("data"),
  proxy_oauth_begin: oauthBeginCmd,
};

/** 注册主进程侧全部 43 条命令（ipc.cjs 唯一的网关注册入口；preload 白名单一字不动的对应面）。 */
function register(ipcMain) {
  for (const cmd of ALL_PROXY_CMDS) {
    const local = UI_LOCAL_IMPL[cmd];
    ipcMain.handle(cmd, local
      ? async (_e, args) => {
          try { return await local(args || {}); }
          catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
        }
      : async (_e, args) => forward(cmd, args || {}));
  }
}

module.exports = {
  start, stopAndWait, state, call, onEvent, register, ensureStarted,
  gatewayFile, gatewayScriptPath, readGatewayFile, probeAlive, probeResidentGateway, probePortBusy,
};
