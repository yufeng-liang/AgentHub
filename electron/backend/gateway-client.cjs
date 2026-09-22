// 网关子进程的主进程侧监督器（二期 Task 3）。
//
// 职责：spawn / 认领 / 看门狗对端（父进程）/ 优雅停机等待 / 命令转发出口 / 事件扇出。
// 业务逻辑一条都不在这里——43 条命令的实现体仍在 proxy/index.cjs（Task 5 才把出口换成这里的 call()）。
//
// 为什么主进程侧只 require store 的 proxyDir()：gateway.json 与日志的路径真相源必须与子进程写的
// 那一份同源（两份解析 = 早晚漂移成两个文件）。这里不调 store.open()，不建库句柄；
// §5.4 的「主进程不再 require 网关 store」由 Task 5 的硬零闸收口（本文件的 require 也在它面内）。
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const store = require("./proxy/store.cjs");
const util = require("./proxy/util.cjs");
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
 * （gateway_echo 那一步是第二层：管道被别的实现接走时它也会露馅。本期没有 ack 帧，Task 4 补。）
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
 * 别人的进程（一期踩过宽匹配杀进程的坑，见 AGENTS.md 与派发硬约束）。清理只做一件事：把陈旧
 * gateway.json 挪走，让新子进程从干净状态起；真活着又连不上的网关由版本不匹配分支经 token 认证后停。
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

/**
 * 启动或认领网关子进程。返回 { ok, claimed, pid, port, message }。
 */
async function start({ persistent } = {}) {
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
  child.stdin.write(encode({ token, parentPid: process.pid, persistent: !!persistent, pipePath }) + "\n");
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
 */
async function stopAndWait({ timeoutMs = 5000 } = {}) {
  // 优先读盘上的那份：端口由子进程在开始监听时写进去（内存镜像可能是监听之前的旧值）
  const cur = readGatewayFile() || mirror;
  if (!cur || !cur.pipe || !cur.token) return { stopped: true, portFreed: true, message: "没有网关子进程（gateway.json 不存在或已陈旧）" };
  const port = Number(cur.port) || 0;
  const aliveBefore = pidAlive(cur.pid);
  let own = null;
  if (aliveBefore) {
    own = conn && conn.connected ? conn : await gatewayPipe.connect({ pipePath: cur.pipe, token: cur.token, timeoutMs: 1500 }).catch(() => null);
    // 子进程会在回包前就退出，收不到响应是预期：忽略 reject，只看进程是否真的没了。
    // 注意这条连接**不能立刻 close**：destroy 会丢掉 socket 里还没 flush 出去的 shutdown 帧，
    // 于是「停不下来」会被误判成对端不配合。等进程没了再收。
    if (own) own.call("gateway_shutdown", {}, { timeoutMs: Math.max(200, timeoutMs) }).catch(() => {});
  }
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(cur.pid) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const stopped = !pidAlive(cur.pid);
  if (own && own !== conn) { try { own.close(); } catch { /* 已断 */ } }
  dropConnection();
  mirror = null;
  const portFreed = port ? !(await probePortBusy(port)) : true;
  log.line("stopAndWait", { pid: cur.pid, stopped, portFreed, wasAlive: aliveBefore });
  return {
    stopped,
    portFreed,
    message: stopped ? (portFreed ? "已停止" : "子进程已退出但端口 " + port + " 仍被占用")
      : "子进程未在 " + timeoutMs + "ms 内退出（pid " + cur.pid + " 仍在）",
  };
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

/** 转发一条命令（Task 5 的转发体就一行）。管道断了回 reject，由上层错误态负责报给用户。 */
function call(cmd, args, opts) {
  if (!conn || !conn.connected) return Promise.reject(new Error("网关子进程未连接（命令：" + cmd + "）"));
  return conn.call(cmd, args, opts);
}

/** 订阅子进程回流的事件（payload 形如 { event:"proxy", type:"status", … }）。返回退订函数。 */
function onEvent(cb) {
  eventCbs.add(cb);
  return () => eventCbs.delete(cb);
}

/** gateway.json 的内存镜像 + { alive, connected } */
function state() {
  const base = mirror || readGatewayFile() || {};
  return { ...base, alive: pidAlive(base.pid), connected: !!(conn && conn.connected) };
}

module.exports = {
  start, stopAndWait, state, call, onEvent,
  gatewayFile, gatewayScriptPath, readGatewayFile, probeAlive, probeResidentGateway, probePortBusy,
};
