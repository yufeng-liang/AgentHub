// 托盘双击的客观见证器：起一个一期打包版实例（临时 userData，网关端口 9528 便于与用户实例区分），
// 然后用轮询把「关窗 → 托盘双击重开」这两步变成可核对的事件序列：
//   页面 target 数 1 →（点 X）0 + 进程数 4 → 3 →（双击托盘）1 + 进程数回到 4
// 只等最多 6 分钟，超时也照实打印看到了什么。
"use strict";

// 守卫（三期收尾，2026-09-24）：被 require 时零副作用。本仓 5 个脚本曾因缺它而在被 require 时
// 真把探针跑了一次（Task 5 实现者核验导出面时误触 phase1-browser-pass）。
// 顶层 return 在 CJS 模块包装函数里合法：作为入口时 require.main === module 照常执行。
if (require.main !== module) return;
// 探针卫生（规格 §八）先于一切产品代码 require：三件套指临时目录 + HKCU Run 快照兜底
const hy = require("./probe-hygiene.cjs")("tray-reopen-watch");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const fc = require("../scripts/dev-first-paint-check.cjs");
const sleep = fc.sleep;

const UDD = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-tray-"));
fs.mkdirSync(UDD, { recursive: true });
fs.writeFileSync(
  path.join(UDD, "config.json"),
  // 本探针测「建窗 → 销毁 → 托盘重开」路径，必须真的建出窗口，故显式钉 launchHidden:false，
  // 不随产品默认值漂移（三期默认已改 true，若省掉这行被测对象会悄悄变成「开机不建窗」却仍然绿）
  JSON.stringify({ theme: "dark", schedule: { minimizeToTray: true, liteOnClose: true, launchHidden: false }, proxy: { port: 9528, bind: "127.0.0.1", restoreOnLaunch: true } }, null, 2),
  "utf8"
);
const out = (l, o) => console.log(JSON.stringify({ t: new Date().toString().slice(16, 24), label: l, ...(o || {}) }));

function pages(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/json/list", timeout: 1500 }, (res) => {
      let s = "";
      res.on("data", (d) => (s += d));
      res.on("end", () => { try { resolve(JSON.parse(s).filter((t) => t.type === "page").length); } catch (e) { resolve(-1); } });
    });
    req.on("error", () => resolve(-1));
    req.on("timeout", () => req.destroy(new Error("t")));
  });
}
function tree(rootPid) {
  const q = `$ps = Get-CimInstance Win32_Process -Filter "Name='AgentHub.exe'" | Where-Object { $_.ProcessId -eq ${rootPid} -or $_.ParentProcessId -eq ${rootPid} }; $n=0; foreach($p in $ps){$n++}; "$n"`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", q], { encoding: "utf8" });
  return Number((r.stdout || "").trim() || -1);
}

(async () => {
  const proc = spawn(fc.EXE, ["--remote-debugging-port=0", `--user-data-dir=${UDD}`], {
    cwd: fc.ROOT, stdio: "ignore", detached: true,
    // APPDATA / AGENT_SKILLS_HOME / CCSWITCH_DB_PATH 已由 probe-hygiene 集中指进临时目录，整体继承
    env: process.env,
  });
  const port = await fc.readDevToolsPort(UDD, proc);
  await sleep(4000);
  out("launched", { pid: proc.pid, cdpPort: port, userData: UDD, note: "网关端口 9528，用来和你的实例区分" });
  out("state", { pages: await pages(port), procs: tree(proc.pid) });

  let closedAt = null, reopenedAt = null;
  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline && !(closedAt && reopenedAt)) {
    const p = await pages(port);
    const n = tree(proc.pid);
    if (p === 0 && n === 3 && !closedAt) { closedAt = Date.now(); out("WINDOW-DESTROYED", { pages: p, procs: n }); }
    if (closedAt && p >= 1 && n >= 4) { reopenedAt = Date.now(); out("REOPENED", { pages: p, procs: n, 间隔秒: Math.round((reopenedAt - closedAt) / 1000) }); }
    await sleep(500);
  }
  out("VERDICT", {
    关窗捕获: !!closedAt,
    重开捕获: !!reopenedAt,
    说明: reopenedAt
      ? "托盘双击确实把窗口重建了（页面 target 从 0 回到 1、进程数回到 4）"
      : closedAt ? "已捕获关窗，但 6 分钟内没看到重开 —— 要么没点到这个实例的托盘图标，要么双击路径有问题" : "6 分钟内没捕获到关窗",
  });
  process.exit(0);
})().catch((e) => { console.error("WATCH-FAILED:", String(e && e.message ? e.message : e).slice(0, 200)); process.exit(1); });
