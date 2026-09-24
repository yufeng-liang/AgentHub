// 二期 Task 7 闸：更新 / 卸载互锁 —— 退出与装更前必须先停干净网关子进程并确认端口释放。
//
// 三组判据按简报 Step 1 逐条落：
//  ⓪ stopAndWait 在「压根没有网关」（gateway.json 不存在）时必须无害早退：
//     退出路径无论网关开没开都会走，不能在这里炸或假死。
//  ① portFreed 是**实测 connect 失败**而不是 close() 回调推断：
//     · 正向腿：真网关（真 gateway.cjs 子进程）在监听态下 stopAndWait → {stopped:true, portFreed:true,
//       forced:false, drained:true}，并用**独立于被测函数**的 connect 探针复核端口真的空了；
//     · 反向腿：盘上记录指向已死 pid、端口仍被**本测试自己的 listener** 占着 → portFreed 必须是 false。
//       这条是牙口所在：把 portFreed 改回常量 true（评审 I1 之前的形状）当场变红。
//  ② 强杀兜底：桩子进程照常认证、照常应答 gateway_echo，但**吞掉 gateway_shutdown**（dispatch 永不
//     resolve、进程不退）→ stopAndWait 在 timeoutMs 到点后必须强杀，返回 {stopped:true, forced:true}，
//     且 pid 真的消失、端口真的释放。没有强杀兜底时 stopped:false，装更会在映像仍被锁时开跑。
//  ③ 三入口静态断言（简报逐字）：main.cjs 里 proxy.shutdown() 零命中；三条入口的源码都汇入
//     quitForInstall/stopAndWait —— before-quit 的装更分支与非托盘退出分支调 quitForInstall()，
//     ipc.cjs 的 install_update 不许再直连 updater.triggerInstall()（那是绕过停机的短路），updater
//     必须暴露 requestInstall（只打标记 + app.quit()，把退出交回 before-quit 的唯一停机出口）。
//     ③-b（Task 7b）stopping 窗口的托盘竞态：installPhase === "stopping" 期间托盘「退出」不得触发
//     第二次停机 —— 托盘菜单项与 quitForInstall() 的防重入闸两层判据都在场才过。
//     另加 Step 3 的静态引用：gateway.cjs 的 exe-gone 看门狗必须在场 —— 卸载时 NSIS 不发消息，
//     它是唯一的卸载保护。**动态判据见 scripts/dev-gateway-pipe-test.cjs ③-c**（常驻 + 真监听 +
//     exe 映像不在 → 收摊），本闸不复制那份真子进程用例：重复的真子进程测试是维护负债。
//
// 卫生约束（与 pipe 闸同一套，硬要求）：
//  · APPDATA / AGENT_SKILLS_HOME / CCSWITCH_DB_PATH 在任何产品代码 require 之前指进临时目录；
//  · 端口一律非 9527（19541/19542/19543），9527 归用户自己那台实例；
//  · 只杀自己 spawn 的进程（句柄记录，finally 兜底），绝不按进程名宽匹配；
//  · HKCU Run 只读快照首尾比对（本闸不该碰自启项）。
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, execSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BE = path.join(ROOT, "electron", "backend");

// ===== 隔离：必须早于任何产品代码的 require =====
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-gwlock-"));
const SANDBOX = path.join(work, "appdata-main");
const GW_PORT = 19541;      // ① 正向腿：真网关监听的端口
const HOLD_PORT = 19542;    // ① 反向腿：被本测试自己的 listener 占着的端口
const STUB_PORT = 19543;    // ② 桩子进程监听的端口
process.env.APPDATA = SANDBOX;
process.env.AGENT_SKILLS_HOME = path.join(work, "hub");
process.env.CCSWITCH_DB_PATH = path.join(work, "ccswitch.db");
fs.mkdirSync(process.env.APPDATA, { recursive: true });

// 产品代码一律在此之后 require
const gw = require(path.join(BE, "gateway-client.cjs"));
const util = require(path.join(BE, "proxy", "util.cjs"));

// 整闸硬超时：宁可红也不要让跑门禁的人干等（红/挂死时保留临时目录供排查）。
setTimeout(() => { console.log("FAIL 本闸 240 s 未跑完。临时目录保留供排查：" + work); process.exit(1); }, 240000).unref?.();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let steps = 0;
const pass = (msg) => { steps++; console.log(`  ${String(steps).padStart(2)}. ${msg}`); };

/** 本次跑起来的所有 pid（清理只按这份名单） */
const knownPids = new Set();
function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
}

function readSandboxGateway() {
  try {
    return JSON.parse(fs.readFileSync(path.join(SANDBOX, "AgentHub", "proxy", "gateway.json"), "utf8"));
  } catch { return null; }
}

/** 独立的端口占用探针：**不复用**被测函数（gw.probePortBusy），否则 ① 是在自我实现 */
function probeBusyIndependent(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port, timeout: 800 });
    const done = (v) => { try { s.destroy(); } catch { /* 已断 */ } resolve(v); };
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
    s.on("timeout", () => done(false));
  });
}

/** HKCU Run 只读快照（本闸不该碰自启项，首尾比对兜底） */
function runKeySnapshot() {
  try {
    return execSync("reg query \"HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\"", { encoding: "utf8" });
  } catch { return ""; }
}

async function waitForStubRecord(stubPid, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const rec = readSandboxGateway();
    if (rec && rec.pid === stubPid) return rec;
    await sleep(50);
  }
  return null;
}

// ===== ② 夹具：一个「赖着不走」的网关桩 =====
// 管道照常认证、gateway_echo 照常应答（证明它活着、不是没起来），但 gateway_shutdown 被吞：
// dispatch 对它永不 resolve、进程也不退 —— stopAndWait 的强杀兜底是对它唯一的办法。
const STUB_SRC = `"use strict";
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const be = process.argv[2];
const sandbox = process.argv[3];
const port = Number(process.argv[4]);
const gatewayPipe = require(path.join(be, "gateway-pipe.cjs"));
const token = "interlock-stub-token-0123456789abcdef0123456789abcdef";
const pipePath = String.raw\`\\\\.\\pipe\\agenthub-interlock-stub-\${process.pid}\`;
const proxyDir = path.join(sandbox, "AgentHub", "proxy");
fs.mkdirSync(proxyDir, { recursive: true });
// 先落盘再 listen：与产品（gateway.cjs）同一条装配序不变式
fs.writeFileSync(path.join(proxyDir, "gateway.json"), JSON.stringify({
  pid: process.pid, pipe: pipePath, token, port, version: "0.0.0-interlock-stub",
  startedAt: Date.now(), secretBackend: "plain-dev",
}, null, 2), "utf8");
const tcp = net.createServer(() => {});            // 只占端口，不服务：portFreed 的探测对象
tcp.listen(port, "127.0.0.1");
gatewayPipe.serve({ token, pipePath, dispatch: async (cmd, args) => {
  if (cmd === "gateway_echo") return { v: String((args && args.v) || "") };  // 必须真回显：probeAlive 靠它验 token
  return new Promise(() => {});                    // gateway_shutdown 在这里被吞：永不 resolve
} }).then(() => console.log("STUB-READY pid=" + process.pid));
setInterval(() => {}, 1 << 30);                    // 保活：被强杀是它唯一的死法
`;

const failures = [];
function section(name, fn) {
  return Promise.resolve()
    .then(fn)
    .catch((e) => { failures.push(name + "： " + String((e && e.message) || e)); });
}

(async () => {
  const runSnapA = runKeySnapshot();

  await section("⓪ 无网关时无害早退", async () => {
    // 此时 SANDBOX 里还没有 gateway.json：退出路径无论网关开没开都会走，不能炸
    const r = await gw.stopAndWait({ timeoutMs: 1000 });
    assert.strictEqual(r.stopped, true, "⓪ 无网关时 stopped 应为 true，实得：" + JSON.stringify(r));
    assert.strictEqual(r.portFreed, true, "⓪ 无网关时 portFreed 应为 true，实得：" + JSON.stringify(r));
    pass("⓪ gateway.json 不存在 → stopAndWait 无害早退 {stopped:true, portFreed:true}（退出路径不依赖网关开没开）");
  });

  await section("① portFreed 实测 connect（正向 + 反向两腿）", async () => {
    // ===== ① 正向腿：真网关在监听态 =====
    // 先把测试端口写进沙箱配置再 start：子进程 boot 期间任何 loadConfig→saveConfig 的惰性回写
    // 都会带上这个端口（首跑实测过「config 写晚一步 → proxy_start 拿到默认 9527」的竞态）
    fs.mkdirSync(path.join(SANDBOX, "AgentHub"), { recursive: true });
    fs.writeFileSync(path.join(SANDBOX, "AgentHub", "config.json"), JSON.stringify({ proxy: { port: GW_PORT } }), "utf8");
    const r0 = await gw.start({ persistent: false });
    assert.strictEqual(r0.ok, true, "① 真网关 start() 失败：" + (r0.message || ""));
    knownPids.add(r0.pid);
    const s0 = await gw.call("proxy_start", {});
    assert.strictEqual(s0.ok, true, "① proxy_start 失败：" + (s0.message || ""));
    assert.strictEqual(s0.port, GW_PORT, "① 子进程监听的端口不是测试端口（不许碰 9527）：" + s0.port);
    assert.strictEqual(Number((gw.readGatewayFile() || {}).port), GW_PORT,
      "① 前提不成立：监听端口没回写进 gateway.json，portFreed 的盘上真相源缺失");
    assert.ok(await probeBusyIndependent(GW_PORT), "① 前提不成立：子进程根本没在监听 " + GW_PORT);
    const r1 = await gw.stopAndWait({ timeoutMs: 8000 });
    assert.strictEqual(r1.stopped, true, "① 监听态停机失败：" + r1.message);
    assert.strictEqual(r1.portFreed, true, "① 监听态停机后 portFreed 应为 true：" + JSON.stringify(r1));
    assert.strictEqual(r1.forced, false, "① 正常优雅停机不该走到强杀（forced 应为 false）：" + JSON.stringify(r1));
    assert.strictEqual(r1.drained, true, "① 正常停机应排干（drained:true）：" + JSON.stringify(r1));
    assert.ok(!alive(r0.pid), "① stopped:true 但 pid " + r0.pid + " 还在（谎报）");
    assert.strictEqual(await probeBusyIndependent(GW_PORT), false,
      "① portFreed:true 是假的 —— 独立 connect 探针在 " + GW_PORT + " 上仍能连上");
    pass(`① 正向腿：真网关监听 ${GW_PORT} → stopAndWait {stopped:true, portFreed:true, forced:false, drained:true}，独立 connect 探针复核端口已空`);

    // ===== ① 反向腿：pid 已死、端口仍被占 → portFreed 必须能说「不」 =====
    const holder = net.createServer(() => {});
    await new Promise((resolve, reject) => { holder.once("error", reject); holder.listen(HOLD_PORT, "127.0.0.1", resolve); });
    try {
      assert.ok(await probeBusyIndependent(HOLD_PORT), "① 前提不成立：holder 没占住 " + HOLD_PORT);
      // 盘上记录指向①里已停掉的 pid（确死）+ 一个不存在的管道名 + 被 holder 占着的端口
      fs.writeFileSync(gw.gatewayFile(), JSON.stringify({
        pid: r0.pid, pipe: String.raw`\\.\pipe\agenthub-interlock-nonexistent-${r0.pid}`,
        token: "t".repeat(48), port: HOLD_PORT, version: util.appVersion(), startedAt: Date.now(),
      }, null, 2), "utf8");
      const r2 = await gw.stopAndWait({ timeoutMs: 1500 });
      assert.strictEqual(r2.stopped, true, "① 反向腿 pid 本就死了，stopped 应为 true：" + JSON.stringify(r2));
      assert.strictEqual(r2.portFreed, false,
        "① 端口 " + HOLD_PORT + " 明明还被占着，portFreed 却报 true —— portFreed 退化成了常量/推断，"
        + "不再是实测 connect 失败（评审 I1 之前的形状）：" + JSON.stringify(r2));
      pass(`① 反向腿：pid 已死 + 端口 ${HOLD_PORT} 被别人占着 → portFreed 如实报 false（实测 connect，不是 close 回调推断）`);
    } finally {
      holder.close();
    }
  });

  await section("② 强杀兜底（吞 gateway_shutdown 的桩）", async () => {
    const stubFile = path.join(work, "gw-stub.cjs");
    fs.writeFileSync(stubFile, STUB_SRC, "utf8");
    try {
      // 先清掉 ①-b 留下的假记录：waitForFile 只看「文件存在」会被它骗过（实测首跑就栽在这）
      fs.rmSync(gw.gatewayFile(), { force: true });
      const stub = spawn(process.execPath, [stubFile, BE, SANDBOX, String(STUB_PORT)], {
        cwd: work, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
        env: Object.assign({}, process.env),
      });
      knownPids.add(stub.pid);
      let out = "";
      stub.stdout.on("data", (d) => { out += d; });
      stub.stderr.on("data", (d) => { out += d; });
      stub.on("exit", (code, signal) => { out += `\n[stub exit ${code} ${signal}]`; });
      // 等的一定是**桩写的那份**（pid 对得上），不是盘上任何一份旧记录
      const rec = await waitForStubRecord(stub.pid, 10000);
      assert.ok(rec, "② 桩没在 10 s 内写下自己的 gateway.json：" + out);
      knownPids.add(rec.pid);
      // 前提证明：桩活着、管道认证可通过（gateway_echo 有响应）、端口真被它占着
      const echo = await gw.probeAlive(rec);
      assert.ok(echo, "② 前提不成立：桩的管道认证不过（probeAlive false）：" + out);
      assert.ok(await probeBusyIndependent(STUB_PORT), "② 前提不成立：桩没在监听 " + STUB_PORT);
      const t0 = Date.now();
      const r = await gw.stopAndWait({ timeoutMs: 2500 });
      const elapsed = Date.now() - t0;
      assert.strictEqual(r.stopped, true,
        "② 子进程吞掉 gateway_shutdown 赖着不走，stopAndWait 没能强杀兜底（stopped=false）——"
        + "装更会在映像仍被锁时开跑：" + JSON.stringify(r));
      assert.strictEqual(r.forced, true, "② 强杀路径必须以 forced:true 回报：" + JSON.stringify(r));
      assert.strictEqual(r.portFreed, true, "② 强杀后端口应释放：" + JSON.stringify(r));
      assert.ok(!alive(rec.pid), "② forced:true 但桩 pid " + rec.pid + " 还在（谎报）");
      assert.ok(elapsed >= 2200, "② 强杀没等 timeoutMs 到点就动手（elapsed=" + elapsed + "ms）——"
        + "那不是兜底，是把优雅停机的窗口整个跳掉了");
      assert.ok(elapsed <= 9000, "② 强杀拖了 " + elapsed + "ms 才完成 —— 互锁的停机预算失控");
      pass(`② 强杀兜底有牙：吞 shutdown 的桩在 timeoutMs(2500) 到点后被强杀（耗时 ${elapsed}ms），`
        + `{stopped:true, forced:true, portFreed:true}，pid ${rec.pid} 真消失、端口真释放`);
    } finally {
      try { stub.kill(); } catch { /* 已退 */ }
    }
  });

  await section("③ 三入口静态断言 + exe-gone 静态引用", async () => {
    const mainSrc = fs.readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");
    const ipcSrc = fs.readFileSync(path.join(ROOT, "electron", "backend", "ipc.cjs"), "utf8");
    const updSrc = fs.readFileSync(path.join(ROOT, "electron", "backend", "updater.cjs"), "utf8");
    const gwSrc = fs.readFileSync(path.join(ROOT, "electron", "gateway.cjs"), "utf8");

    // 简报逐字：proxy.shutdown() 在 main.cjs 零命中（残留语义已定成子进程的 gracefulShutdown）
    assert.ok(!/proxy\.shutdown\(/.test(mainSrc),
      "③ main.cjs 仍有 proxy.shutdown() 残留 —— 主进程不许再持有网关停机实现");

    // 入口一 + 入口二（before-quit 的装更分支与非托盘退出分支）都必须调 quitForInstall()
    const hIdx = mainSrc.indexOf('app.on("before-quit"');
    assert.ok(hIdx >= 0, "③ main.cjs 找不到 before-quit 注册");
    const hEnd = mainSrc.indexOf("\n  });", hIdx);
    const handler = hEnd > hIdx ? mainSrc.slice(hIdx, hEnd) : mainSrc.slice(hIdx, hIdx + 4000);
    assert.ok(/updater\.pendingInstall\(\)/.test(handler) && /updater\.pendingInstallRequested\(\)/.test(handler),
      "③ before-quit 的装更意愿必须同时看 pendingInstall() 与 pendingInstallRequested() —— "
      + "后者堵 triggerInstall 的洞（先置 installTriggered 再 quitAndInstall，第二次 before-quit 时前者已 false）");
    assert.ok(/quitForInstall\(/.test(handler),
      "③ before-quit 的互锁分支必须汇入 quitForInstall()（装更入口与非托盘退出入口共用同一个停机出口）");
    assert.ok(/e\.preventDefault\(\)/.test(handler), "③ before-quit 必须先拦下本次退出再异步停机");

    // quitForInstall 本体必须走 gatewayClient.stopAndWait，且是 main.cjs 里唯一的 triggerInstall 调用点
    const qIdx = mainSrc.indexOf("function quitForInstall");
    assert.ok(qIdx >= 0, "③ main.cjs 缺 quitForInstall() 定义（三条入口共用的唯一退出口）");
    const qEnd = mainSrc.indexOf("\n}", qIdx);
    const qBody = qEnd > qIdx ? mainSrc.slice(qIdx, qEnd) : mainSrc.slice(qIdx, qIdx + 3000);
    assert.ok(/gatewayClient\.stopAndWait\(/.test(qBody),
      "③ quitForInstall() 必须经 gatewayClient.stopAndWait 停机（gateway_shutdown → 等进程退 → 实测端口释放）");
    assert.ok(/updater\.triggerInstall\(\)/.test(qBody),
      "③ 装更续跑必须排在 stopAndWait 之后（quitForInstall 内 triggerInstall）");
    const trigCount = (mainSrc.match(/updater\.triggerInstall\(/g) || []).length;
    assert.strictEqual(trigCount, 1,
      "③ main.cjs 里 updater.triggerInstall() 必须只在 quitForInstall 内出现一次（实得 " + trigCount
      + " 次）——before-quit 里直连它就是绕过停机互锁");

    // ③-b（Task 7b）stopping 窗口的托盘竞态：installPhase 处于 stopping（stopAndWait 在飞）期间，
    // 托盘「退出」不得再触发一次停机。两层都要在场，缺一层这条闸就只是「碰巧成立」：
    //  · 托盘菜单项自己先看 installPhase（stopping 期间点退出 = 什么都不做，在飞的停机收尾后自然会退出）；
    //  · quitForInstall 的防重入闸（installPhase !== "idle" 就 return），堵住其它 before-quit 入口。
    const trayExitIdx = mainSrc.indexOf('label: "退出"');
    assert.ok(trayExitIdx >= 0, "③-b main.cjs 找不到托盘「退出」菜单项（Tray 模板）");
    // 取该菜单项那一段（多行对象：label 到下一个 type: "separator" / 右括号为止）
    const trayExitBlock = mainSrc.slice(trayExitIdx, trayExitIdx + 400);
    assert.ok(/installPhase/.test(trayExitBlock),
      "③-b 托盘「退出」的 click 必须先看 installPhase：stopping 期间（stopAndWait 在飞）点它就会与在飞的停机"
      + "并发走第二遍退出路径（第二次停机）：" + trayExitBlock.split("\n").slice(0, 8).join(" / "));
    assert.ok(/installPhase\s*!==\s*"idle"/.test(trayExitBlock) && /return/.test(trayExitBlock),
      "③-b 托盘「退出」的 installPhase 判据必须是「非 idle 就 return」这个形状（别用别的比较写法绕过）："
      + trayExitBlock.split("\n").slice(0, 8).join(" / "));
    assert.ok(/if \(installPhase !== "idle"\) return;/.test(qBody),
      "③-b quitForInstall() 的防重入闸必须是 installPhase !== \"idle\" 就 return（stopping 期间任何"
      + " before-quit 入口都不许再起一次停机）：" + qBody);

    // 入口三（ipc.cjs install_update 短路）：不许直连 triggerInstall，必须经 requestInstall 打标记
    const installLine = ipcSrc.split("\n").find((l) => l.includes('"install_update"'));
    assert.ok(installLine, "③ ipc.cjs 找不到 install_update 注册");
    assert.ok(!installLine.includes("triggerInstall"),
      "③ install_update 直连 updater.triggerInstall() = 渲染层「立即安装」绕过 before-quit 的网关停机互锁："
      + installLine.trim());
    assert.ok(installLine.includes("requestInstall"),
      "③ install_update 必须经 updater.requestInstall()（打标记 + app.quit()，退出汇入唯一停机出口）："
      + installLine.trim());

    // updater 侧：requestInstall 只打标记 + app.quit()；pendingInstallRequested 可被 before-quit 读到
    const rqIdx = updSrc.indexOf("function requestInstall");
    assert.ok(rqIdx >= 0, "③ updater.cjs 缺 requestInstall()（install_update 的互锁入口）");
    const rqEnd = updSrc.indexOf("\nfunction ", rqIdx);
    const rqBody = rqEnd > rqIdx ? updSrc.slice(rqIdx, rqEnd) : updSrc.slice(rqIdx, rqIdx + 2000);
    assert.ok(/installRequested = true/.test(rqBody), "③ requestInstall 必须打装更标记：" + rqBody);
    assert.ok(/app\.quit\(\)/.test(rqBody),
      "③ requestInstall 必须用 app.quit() 把退出交回 before-quit，而不是自己 quitAndInstall");
    assert.ok(/function pendingInstallRequested\(\)/.test(updSrc), "③ updater.cjs 缺 pendingInstallRequested()");
    const expLine = updSrc.split("\n").find((l) => l.startsWith("module.exports"));
    assert.ok(expLine && expLine.includes("requestInstall") && expLine.includes("pendingInstallRequested"),
      "③ updater 的 exports 必须带 requestInstall 与 pendingInstallRequested：" + (expLine || "").trim());

    // Step 3 卸载面（静态引用）：exe-gone 看门狗必须在场。动态判据见 dev-gateway-pipe-test.cjs ③-c
    // （常驻 + 真监听 + exe 映像不在 → ~看门狗周期内自己收摊），本闸不复制那份真子进程用例。
    assert.ok(/gracefulExit\("exe-gone"\)/.test(gwSrc),
      "③ gateway.cjs 的 exe-gone 看门狗不在场 —— NSIS 卸载器不会向子进程发消息，它是唯一的卸载保护");
    pass("③ 静态断言全过：main.cjs 零 proxy.shutdown()；before-quit 两分支汇入 quitForInstall()"
      + "（内含唯一的 stopAndWait 与 triggerInstall）；install_update 经 requestInstall 不再短路绕过；"
      + "exe-gone 看门狗在场（动态判据见 pipe 闸 ③-c）");
    pass("③-b stopping 窗口的托盘竞态：托盘「退出」与 quitForInstall() 两处都有 installPhase 判据 —— "
      + "stopAndWait 在飞期间点托盘退出不会并发走第二遍停机");
  });

  const runSnapB = runKeySnapshot();
  assert.strictEqual(runSnapA, runSnapB, "HKCU Run 自启项在测试前后发生了变化（本闸不该碰它）");
  pass("⑧ 卫生收尾：HKCU Run 自启项首尾快照原样");

  if (failures.length) {
    console.log("\nFAIL " + failures.length + " 组判据未过：");
    for (const f of failures) console.log("  × " + f);
    console.log("临时目录保留供排查：" + work);
    process.exit(1);
  }
  console.log("\nOK 互锁闸全绿（" + steps + " 项）");
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 留痕也无妨 */ }
})().finally(() => {
  // 兜底清理：只按本次记下的 pid 收，绝不按进程名宽匹配
  for (const pid of knownPids) {
    if (alive(pid)) { try { process.kill(pid); } catch { /* 已退 */ } }
  }
});
