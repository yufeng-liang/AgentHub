// 首屏耗时基线/回归测量：起打包版 Electron（userData 重定向，不碰真实实例），
// 经 CDP 读 Paint / Navigation Timing。用法：node scripts/dev-first-paint-check.cjs
// 想看"这次量的是哪个进程/哪个调试口"就加 FPC_DEBUG=1（诊断走 stderr，不污染 stdout 的基线行）。
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const ROOT = path.join(__dirname, "..");
const EXE = path.join(ROOT, "release", "win-unpacked", "AgentHub.exe");
// taskkill 一定要走绝对路径：本机 PATH 可能缺 C:\Windows\System32（AGENTS.md §二.3），
// 那时按名字调用抛 ENOENT，会被 catch 吞成"探针已自行退出"，留下一个僵尸探针占着调试口。
const TASKKILL = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
const TASKLIST = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tasklist.exe");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-paint-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// 夹具必须显式钉 launchHidden:false。三期起产品默认值是 launchHidden:true（开机不建窗），
// 而本探针的 userData 是全新 mkdtemp（无 config.json）⇒ mergeConfig 会把缺字段补成新默认
// ⇒ main.cjs 的门 `!(launchHidden && minimizeToTray)` 为假 ⇒ 不建窗 ⇒ pageTarget() 等 30s 拿不到
// CDP page，首屏基线/回归测量失效。这里显式写进本次 userData（--user-data-dir 就是它），
// 不随产品默认值漂移（与 tools/phase1-browser-pass.cjs / tools/tray-reopen-watch.cjs 同款处置）。
// ---------------------------------------------------------------------------
function writeUserDataConfig(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ schedule: { minimizeToTray: true, liteOnClose: true, launchHidden: false } }, null, 2),
    "utf8"
  );
}

// ---------------------------------------------------------------------------
// 只连"自己拉起的那个实例"：--remote-debugging-port=0 让 Chromium 自己挑口，
// 再把真实端口写进本次 userData 的 DevToolsActivePort。固定端口（旧版写死 9333）下，
// 上一轮没杀干净的探针会继续占着 9333，本轮实例绑不上，pageTarget() 就返回那个旧 target，
// hasShell 为真、FCP 早已记录，于是打印出一串看似合理的数还 exit 0 —— 静默把污染传给下一任务。
// ---------------------------------------------------------------------------
async function readDevToolsPort(userDataDir, proc, timeoutMs = 20000) {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (proc.spawnError) throw new Error(`探针 Electron 启动失败：${proc.spawnError.message}`);
    if (fs.existsSync(file)) {
      const port = Number(fs.readFileSync(file, "utf8").split(/\r?\n/)[0]);
      if (Number.isInteger(port) && port > 0) return port;
    }
    if (proc.exitCode !== null || proc.signalCode !== null) {
      throw new Error(`探针 Electron 还没开出调试口就退出了（code=${proc.exitCode} signal=${proc.signalCode}）`);
    }
    if (Date.now() > deadline) throw new Error(`等不到 ${file}——检查 ${EXE} 是否真的起来了（先跑 npm run electron:pack）`);
    await sleep(200);
  }
}

async function pageTarget(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /dist\/index\.html|localhost/.test(t.url));
      if (page) return page;
    } catch { /* 调试口还没开始监听 */ }
    if (Date.now() > deadline) {
      throw new Error(`port ${port} 上等不到 CDP page target，检查 electron:pack 是否成功、exe 路径是否正确`);
    }
    await sleep(500);
  }
}

// 端口来自本次 userData 已经足以保证不串台；这层 url 校验是冗余防线：万一哪天
// port 0 不生效或被复用，也会在这里明确报错而不是量到别人的窗口。
function assertOwnPage(page) {
  const url = decodeURIComponent(page.url || "").replace(/\\/g, "/").toLowerCase();
  if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url)) return; // 允许指向 dev server 复跑
  const expect = path.join(ROOT, "release", "win-unpacked").replace(/\\/g, "/").toLowerCase();
  if (!url.includes(expect)) {
    throw new Error(`CDP page target 不是本次拉起的 win-unpacked 探针页面：${page.url}（期望路径包含 ${expect}）`);
  }
}

// ---------------------------------------------------------------------------
// CDP 客户端：单次连接必须有 settle 保证。旧版只处理 open/message/error——
// socket 干净关闭而无响应（target 被销毁、窗口中途关掉）时 promise 永不落定，
// 轮询到点不了、finally 跑不到、Electron 树被留成孤儿；而 JSON.parse 直接写在事件回调里，
// 一个畸形帧就是未捕获异常，Node 当场退出、同样不走 finally。
// ---------------------------------------------------------------------------
function evaluate(wsUrl, expression, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(v);
    };
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* 已经关了 */ }
      settle(reject, new Error(`CDP Runtime.evaluate ${timeoutMs}ms 无响应：${wsUrl}`));
    }, timeoutMs);
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => {
      ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
    });
    ws.on("message", (buf) => {
      let msg;
      try {
        msg = JSON.parse(buf.toString());
      } catch {
        return; // 畸形帧：丢掉这一帧继续等，绝不让它把进程掀了
      }
      if (!msg || msg.id !== 1) return;
      try { ws.close(); } catch { /* 已经关了 */ }
      if (msg.error) return settle(reject, new Error(msg.error.message));
      const r = msg.result && msg.result.result;
      if (r && r.wasThrown) return settle(reject, new Error(r.description));
      settle(resolve, r && r.value);
    });
    ws.on("error", (e) => settle(reject, new Error(`CDP 连接错误：${e.message}（${wsUrl}）`)));
    ws.on("close", () => settle(reject, new Error(`CDP 连接已关闭但没拿到响应（页面/target 可能已被销毁）：${wsUrl}`)));
  });
}

// ---------------------------------------------------------------------------
// FCP + DCL + load：重建窗口就是一次全新导航，这三个数直接代表"重开要等多久"。
// JS 份数有两个互不等价的轴，分开印并标清口径（见 I4）：
//   产物轴 = dist/assets/*.js 文件数（分包验收看这一列）
//   DOM 轴 = 初始文档里的 script[src]/modulepreload 数——懒加载 chunk 不在此列，
//            且 Vite 会在运行时补 modulepreload，所以这个数取决于哪一拍采的样。
// 打包版走 file://（asar），Chromium 不给 file 子资源记 Resource Timing（实测恒为 0），
// 所以不使用 performance.getEntriesByType('resource')。
// ---------------------------------------------------------------------------
const PROBE = `(() => {
  const navs = performance.getEntriesByType('navigation');
  const nav = navs[0] || {};
  const fcp = (performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint') || {}).startTime;
  const r = (v) => (v === undefined ? null : Math.round(v));
  return {
    navOk: navs.length > 0,
    fcp: r(fcp),
    dcl: r(nav.domContentLoadedEventEnd),
    load: r(nav.loadEventEnd),
    domJs: document.querySelectorAll('script[src], link[rel="modulepreload"]').length,
    hasShell: !!document.querySelector('.app .main'),
  };
})()`;

// 旧版 `Math.round(nav.loadEventEnd || 0)` 在导航条目缺失时会自信地打印 "load 0 ms" 并 exit 0，
// 和 FCP 那一路已经消灭的静默垃圾是同一类问题。这里统一由 unusableReason 判不合格。
function unusableReason(m) {
  if (!m || typeof m !== "object") return "页面探针返回空值";
  if (!m.navOk) return "该页面无 Navigation Timing 条目（getEntriesByType('navigation') 为空）";
  if (m.fcp === null || m.fcp === undefined) return "first-contentful-paint 尚未记录";
  if (m.dcl === null || m.dcl === undefined) return "domContentLoadedEventEnd 缺失";
  if (!m.load) return "loadEventEnd 为 0/缺失（load 事件还没结束，这一拍采的数无效）";
  return null;
}

// load 事件后首帧仍要再等一会儿（实测窗口在 ready-to-show 前隐藏，FCP 落在 1.6~2.5s 且抖动大），
// 固定 sleep 会读到 null——所以轮询到样本合格为止。事后读取不改变已记录的时间戳，语义不变。
async function probeUntilUsable(wsUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = await evaluate(wsUrl, PROBE);
    const reason = unusableReason(m);
    if (!reason) return m;
    if (Date.now() > deadline) throw new Error(`${timeoutMs}ms 内没采到有效首屏样本：${reason}`);
    await sleep(250);
  }
}

// ---------------------------------------------------------------------------
// 清理：只收本次拉起的进程树（按 proc.pid，绝不按名字扫进程——真实安装的 AgentHub 在同一台机器上跑着）。
// 杀不掉就是错误，不能注释成"已自行退出"：残留实例会占住资源并误导下一次测量。
// ---------------------------------------------------------------------------
function pidAlive(pid) {
  const r = spawnSync(TASKLIST, ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return false;
  return (r.stdout || "").split(/\r?\n/).some((line) => {
    const cols = line.split('","');
    return cols.length > 1 && cols[1].trim() === String(pid); // CSV 第 2 列就是 PID，避免误配到内存列
  });
}

async function killProcessTree(pid, taskkill = TASKKILL) {
  const r = spawnSync(taskkill, ["/T", "/F", "/PID", String(pid)], { encoding: "utf8", windowsHide: true });
  if (r.error) {
    throw new Error(`清理探针进程树失败：调用 ${taskkill} 直接报错（${r.error.code}），PID ${pid} 可能还在占着调试口`);
  }
  if (r.status === 128) return; // taskkill: 该 PID 已不存在 = 探针自己退了，正常
  if (r.status !== 0) {
    throw new Error(`清理探针进程树失败（taskkill exit ${r.status}）：PID ${pid} ${(r.stderr || r.stdout || "").trim()}`);
  }
  for (let i = 0; i < 10 && pidAlive(pid); i++) await sleep(200);
  if (pidAlive(pid)) throw new Error(`taskkill 返回 0 但 PID ${pid} 仍在进程表里，探针没清干净，请手动确认后再复测`);
}

// 探针自己的临时 userData 是本脚本 mkdtemp 出来的，删它零风险（真实 %APPDATA%\AgentHub 不在其列）；
// 只在进程树确实收干净之后才动，删失败也只是留个目录，不影响测量结论，故不升级为错误。
function removeProbeUserData(dir) {
  const base = path.join(os.tmpdir(), "agenthub-paint-");
  if (!dir.startsWith(base)) {
    process.stderr.write(`跳过清理非常规临时目录：${dir}\n`);
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    process.stderr.write(`临时 userData 没删掉（不影响结论，下次复测用的是新目录）：${e.message}\n`);
  }
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`找不到 ${EXE}——先跑 npm run electron:pack`);
  writeUserDataConfig(tmp); // 本探针要窗，显式钉 launchHidden:false，不随产品默认漂移（见函数注释）
  const proc = spawn(EXE, ["--remote-debugging-port=0", `--user-data-dir=${tmp}`], {
    cwd: ROOT, stdio: "ignore", detached: true,
  });
  proc.on("error", (e) => { proc.spawnError = e; }); // 交给 readDevToolsPort 明确报错，而不是抛成未处理事件
  let measuredErr = null;
  try {
    const port = await readDevToolsPort(tmp, proc);
    const page = await pageTarget(port);
    assertOwnPage(page);
    if (process.env.FPC_DEBUG) {
      process.stderr.write(`# 本次探针：pid=${proc.pid} cdpPort=${port} userData=${tmp} url=${page.url}\n`);
    }
    await sleep(2500); // 等首屏与页面自身 onMounted 的 IPC 拉取都落定
    const m = await probeUntilUsable(page.webSocketDebuggerUrl);
    if (!m.hasShell) throw new Error("界面壳没渲染出来，测出的时间点无意义");
    const dist = path.join(ROOT, "dist", "assets");
    const files = fs.readdirSync(dist);
    const jsCount = files.filter((f) => f.endsWith(".js")).length;
    console.log(`FCP ${m.fcp} ms · DOMContentLoaded ${m.dcl} ms · load ${m.load} ms · dist JS 文件 ${jsCount} 个 · 首屏 DOM JS ${m.domJs} 个`);
    console.log("  口径：dist JS 文件=产物轴（dist/assets 里 .js 份数，分包是否生效认这一列）；首屏 DOM JS=DOM 轴（初始文档同步图，不含懒加载 chunk）");
    const big = files.filter((f) => /\.(js|css)$/.test(f))
      .map((f) => [f, Math.round(fs.statSync(path.join(dist, f)).size / 1024)])
      .sort((a, b) => b[1] - a[1]).slice(0, 3);
    for (const [f, k] of big) console.log(`  ${k} KB  ${f}`);
  } catch (e) {
    measuredErr = e;
  }
  let cleanupErr = null;
  try {
    await killProcessTree(proc.pid);
  } catch (e) {
    cleanupErr = e;
  }
  if (measuredErr) throw measuredErr;
  if (cleanupErr) throw new Error(`清理失败：${cleanupErr.message}`);
  removeProbeUserData(tmp);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = {
  ROOT, EXE, TASKKILL, tmp, sleep, evaluate, readDevToolsPort, pageTarget, assertOwnPage,
  killProcessTree, pidAlive, removeProbeUserData, unusableReason, probeUntilUsable, PROBE, main,
  writeUserDataConfig,
};
