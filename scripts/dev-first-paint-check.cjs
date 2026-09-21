// 首屏耗时基线/回归测量：起打包版 Electron（userData 重定向，不碰真实实例），
// 经 CDP 读 Paint / Navigation Timing。用法：node scripts/dev-first-paint-check.cjs
"use strict";
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const WebSocket = require("ws");

const ROOT = path.join(__dirname, "..");
const EXE = path.join(ROOT, "release", "win-unpacked", "AgentHub.exe");
const PORT = 9333; // 避开 9222（AGENTS.md 记的常用口）与 9527（网关）
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-paint-"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && /index\.html|localhost/.test(t.url));
      if (page) return page;
    } catch { /* 端口还没起来 */ }
    await sleep(500);
  }
  throw new Error("等不到 CDP page target，检查 electron:pack 是否成功、exe 路径是否正确");
}

function evaluate(wsUrl, expression) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.on("open", () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } })));
    ws.on("message", (buf) => {
      const msg = JSON.parse(buf.toString());
      if (msg.id !== 1) return;
      ws.close();
      if (msg.error) return reject(new Error(msg.error.message));
      const r = msg.result && msg.result.result;
      if (r && r.wasThrown) return reject(new Error(r.description));
      resolve(r && r.value);
    });
    ws.on("error", reject);
  });
}

// FCP + DCL + load：重建窗口就是一次全新导航，这三个数直接代表"重开要等多久"
// chunk 数：打包版走 file://（asar），Chromium 不给 file 子资源记 Resource Timing
// （实测 resourceCount 恒为 0），故回落数为初始文档图里的 <script src> / modulepreload 个数。
const PROBE = `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const fcp = (performance.getEntriesByType('paint').find(e => e.name === 'first-contentful-paint') || {}).startTime;
  const chunks = performance.getEntriesByType('resource').filter(r => /\\.js(\\?|$)/.test(r.name)).length;
  const domChunks = document.querySelectorAll('script[src], link[rel="modulepreload"]').length;
  return {
    fcp: fcp === undefined ? null : Math.round(fcp),
    dcl: Math.round(nav.domContentLoadedEventEnd || 0),
    load: Math.round(nav.loadEventEnd || 0),
    jsChunks: chunks,
    domChunks: domChunks,
    hasShell: !!document.querySelector('.app .main'),
  };
})()`;

// load 事件后首帧仍要再等一会儿（实测窗口在 ready-to-show 前隐藏，FCP 落在 1.6~2.5s 且抖动大），
// 固定 sleep 会读到 null——所以轮询到 FCP 出现为止。事后读取不改变已记录的时间戳，语义不变。
async function probeUntilPainted(wsUrl, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let m;
  for (;;) {
    m = await evaluate(wsUrl, PROBE);
    if (m && m.fcp !== null) return m;
    if (Date.now() > deadline) throw new Error(`${timeoutMs}ms 内没等到 first-contentful-paint，这一版没测出有效首屏`);
    await sleep(250);
  }
}

(async () => {
  const proc = spawn(EXE, [`--remote-debugging-port=${PORT}`, `--user-data-dir=${tmp}`], { cwd: ROOT, stdio: "ignore", detached: true });
  try {
    const page = await targets();
    await sleep(2500); // 等首屏与页面自身 onMounted 的 IPC 拉取都落定
    const m = await probeUntilPainted(page.webSocketDebuggerUrl);
    if (!m.hasShell) throw new Error("界面壳没渲染出来，测出的时间点无意义");
    const n = m.jsChunks || m.domChunks;
    console.log(`FCP ${m.fcp} ms · DOMContentLoaded ${m.dcl} ms · load ${m.load} ms · JS chunk ${n} 个`);
    if (!m.jsChunks) console.log(`  (chunk 数取自初始文档 script/modulepreload：file:// 打包版无 Resource Timing)`);
    const dist = path.join(ROOT, "dist", "assets");
    const big = fs.readdirSync(dist).filter((f) => /\.(js|css)$/.test(f))
      .map((f) => [f, Math.round(fs.statSync(path.join(dist, f)).size / 1024)])
      .sort((a, b) => b[1] - a[1]).slice(0, 3);
    for (const [f, k] of big) console.log(`  ${k} KB  ${f}`);
  } finally {
    // 整棵进程树收掉：electron.exe 会再派生 GPU / renderer 子进程，proc.kill 只打得到壳
    try {
      execSync(`taskkill /T /F /PID ${proc.pid}`, { stdio: "ignore" });
    } catch { /* 已自行退出 */ }
  }
})().catch((e) => { console.error(e); process.exit(1); });
