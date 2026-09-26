// 二期 Task 6 闸：常驻语义的机器可核面 —— 启动器契约 / 便携版拒常驻 / 自启注册目标随 persistentGateway 切换。
//
// 四组判据按简报 Step 2 逐条落：
//  ① 启动器内容：build/gateway-launcher.cmd 必须是「%~dp0 相对定位 + ELECTRON_RUN_AS_NODE=1 + --persistent」
//     的纯模板（无硬编码盘符）。electron-builder 的 extraFiles（不是 extraResources）把它落到 Windows
//     安装根目录、与 AgentHub.exe 同目录（context7 / electron-builder 官方文档：extraFiles → app content
//     目录 = Windows 安装根；extraResources → resources\ 子目录）。同一条里钉死 package.json 的接线：
//     extraFiles 恰好一条（launcher → agenthub-gateway.cmd），且 extraResources 三条**一字未动**
//     （resources/sqlcipher 那条是 koffi 的命根子，Task 6 只许新增 extraFiles）。
//  ①-P4 守门断言（扫描修正 P4 的直接对立面）：--persistent 且 stdin 永不关闭的情况下，gateway.json
//     必须在 8 s 内出现且 pipe 字段可连通（gateway_echo 双检）。Task 3 的 main() 第一行就是
//     await readHandshake()，自启路径没有父进程投递 stdin —— 没有装配分支的旧代码会把子进程
//     永久挂在读 stdin 上（gateway.json 永远不出现，本断言当场红）。子进程 token 自生成、
//     parentPid=0（看门狗跳过父进程探测）、gateway.json 写 tokenSource:"file"（Task 8 据此区分两种来历）。
//  ② 便携版拒常驻：isPortable() 为真时 start({persistent:true}) 返回
//     { ok:true, persistent:false, message:"便携版不支持后台常驻" }，且不 spawn 子进程（gateway.json
//     不出现）、不落任何 Run 项（applyAutoStart 的便携版早退 + start 本身不注册，两路合起来零注册）。
//  ③ applyAutoStart 的注册目标随 schedule.persistentGateway 切换：off → 主 App exe（不传 path，
//     Electron 默认 execPath）、on → 安装根目录 agenthub-gateway.cmd、关闭自启 → 注销。
//     【真机批次② 发现】Windows 下 Electron 35.7.5 的 setLoginItemSettings 带 path 参数注册时，
//     路径里的反斜杠被当转义序列吃掉一级（\r 还会被当回车拆出 args），落盘的 Run 项是坏路径，
//     开机根本拉不起来（最小复现：真路径 H:\a\b.cmd 注册后变 H:ab.cmd）。所以 .cmd 目标**不走**
//     Electron API，改经 reg.exe 直接写 HKCU Run（导出 addGatewayRunItem / removeGatewayRunItem，
//     内部经 regExec 间接层——闸里换成记账器，真注册表一次都不许碰）；主 exe 目标不带 path、
//     不受该 bug 影响，仍走 setLoginItemSettings。三档对称不变：注册/注销本档目标 + 显式清另一目标。
//     用注入 require.cache 的 mock electron 断言 setLoginItemSettings 入参，**绝不真改本机注册表**；
//     收尾再按既有闸（dev-gateway-pipe-test ⑧）的 regValue() 手法核对 HKCU Run 原样。
//
// 卫生（AGENTS.md 探针三件套）：APPDATA / AGENT_SKILLS_HOME 在任何产品代码 require 之前指进临时目录；
// electron 以 mock 注入（setLoginItemSettings 只记账、getPath 钉进沙箱）；P4 子进程只跑在沙箱 APPDATA 里、
// cwd 取中立的临时目录、收尾只按本次 spawn 的句柄收（红态下 finally kill 兜底）；不打印 token 等凭据；
// 全程不开任何 TCP 端口（9527 归用户实例），管道名由子进程自造（与主进程同款命名）。
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");

// ===== 隔离：必须早于任何产品代码的 require =====
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-launcher-"));
process.env.APPDATA = path.join(work, "appdata");
process.env.AGENT_SKILLS_HOME = path.join(work, "hub");
delete process.env.PORTABLE_EXECUTABLE_DIR;
delete process.env.VITE_DEV_SERVER_URL;

// ===== mock Electron：setLoginItemSettings 只记账（绝不真改 HKCU），getPath 钉进沙箱 =====
// config.cjs 在模块加载时 require("electron") 并按「对象且有 .app」取 app —— 把假模块塞进 require.cache，
// 它拿到的就是 mock。真实注册表路径一次都不会被碰（收尾 ④ 用 regValue 原样比对再验一遍）。
const loginCalls = [];
const mockApp = {
  isPackaged: true,
  getPath: () => path.join(process.env.APPDATA, "AgentHub"),   // dataDir() 钉进沙箱，与子进程的回退口径同值
  setLoginItemSettings(opts) { loginCalls.push(Object.assign({}, opts)); },
};
const electronId = require.resolve("electron");
require.cache[electronId] = { id: "electron", filename: electronId, loaded: true, exports: { app: mockApp } };

const config = require(path.join(ROOT, "electron", "backend", "config.cjs"));
const gatewayClient = require(path.join(ROOT, "electron", "backend", "gateway-client.cjs"));
const gatewayPipe = require(path.join(ROOT, "electron", "backend", "gateway-pipe.cjs"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return true;
    await sleep(100);
  }
  return await fn();
}

/** HKCU Run 快照（与 dev-gateway-pipe-test ⑧ 同一手势）：只读不改，收尾比对证明本次运行零注册写入 */
function regValue() {
  const r = spawnSync("C:\\Windows\\System32\\reg.exe",
    ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run"], { encoding: "utf8" });
  return (r.stdout || "") + "|status=" + r.status;
}
const regBefore = regValue();

// ===== 用例收集器：四个用例互不依赖，逐个跑、失败收集、最后统一退出码（红态一次看全所有红点） =====
const failures = [];
const pass = (name) => console.log("PASS " + name);
async function runCase(name, fn) {
  try { await fn(); pass(name); }
  catch (e) { failures.push(name); console.error("FAIL " + name + "\n  " + String((e && e.message) || e)); }
}

// ===== ① 启动器内容 + package.json 接线（extraFiles 新增、extraResources 一字未动） =====
async function case1() {
  const cmdText = fs.readFileSync(path.join(ROOT, "build", "gateway-launcher.cmd"), "utf8");
  assert.ok(cmdText.includes("@echo off"), "缺 @echo off");
  assert.ok(cmdText.includes("setlocal") && cmdText.includes("endlocal"), "缺 setlocal/endlocal");
  assert.ok(/set ELECTRON_RUN_AS_NODE=1\s*$/m.test(cmdText), "缺 ELECTRON_RUN_AS_NODE=1（子进程角色必须由它钉住）");
  assert.ok(cmdText.includes('"%~dp0AgentHub.exe"'), "exe 必须用 %~dp0 相对定位（安装根目录同目录）");
  assert.ok(cmdText.includes("%~dp0resources\\app.asar\\electron\\gateway.cjs"),
    "入口必须指向 resources\\app.asar 内的 gateway.cjs（跑出 asar 会被 secretbox 判成开发态）");
  assert.ok(cmdText.includes("--persistent"), "缺 --persistent（自启装配分支的开关）");
  assert.ok(!/[A-Za-z]:[\\/]/.test(cmdText), "启动器不得硬编码盘符（%~dp0 相对定位是硬约束）");

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.deepStrictEqual(pkg.build.extraFiles,
    [{ from: "build/gateway-launcher.cmd", to: "agenthub-gateway.cmd" }],
    "extraFiles 必须恰好一条：launcher → 安装根目录 agenthub-gateway.cmd（不是 extraResources）");
  assert.deepStrictEqual(pkg.build.extraResources, [
    { from: "build/icon.png", to: "build/icon.png" },
    { from: "build/tray.png", to: "build/tray.png" },
    { from: "resources/sqlcipher", to: "sqlcipher" },
  ], "extraResources 被改动了：Task 6 只许新增 extraFiles，resources/sqlcipher 一字不许动");
}

// ===== ①-P4 守门断言：--persistent + stdin 永不关闭 → gateway.json 8s 内出现且 pipe 可连通 =====
async function case1p4() {
  const gwFile = gatewayClient.gatewayFile();
  try { fs.rmSync(gwFile, { force: true }); } catch { /* 没有就算了 */ }
  const child = spawn(process.execPath, [path.join(ROOT, "electron", "gateway.cjs"), "--persistent"], {
    cwd: work,                                              // 中立 cwd（探针卫生第五条）
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1" }),
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let childExit = null;
  child.on("exit", (code, signal) => { childExit = { code, signal }; });
  child.stdout.resume(); child.stderr.resume();             // 读干，缓冲区写满会把孩子卡死
  try {
    // stdin 永不写入、永不关闭 —— 这正是自启路径的形态：没有父进程投递握手。
    let record = null;
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      if (childExit) break;                                 // 崩了别等满 8s
      try { record = JSON.parse(fs.readFileSync(gwFile, "utf8")); break; } catch { /* 还没落盘 */ }
      await sleep(100);
    }
    assert.ok(record, "8s 内 gateway.json 未出现（--persistent 装配分支缺失 → 子进程永久挂在 readHandshake）"
      + (childExit ? `；子进程提前退出 code=${childExit.code} signal=${childExit.signal}` : ""));
    assert.strictEqual(record.pid, child.pid, "gateway.json 的 pid 不是本次子进程");
    assert.strictEqual(record.tokenSource, "file", "自启路径必须在 gateway.json 写 tokenSource:\"file\"（Task 8 据此区分两种来历）");
    assert.ok(record.pipe && record.token, "gateway.json 缺 pipe/token（认领方拿什么连？）");
    // pipe 可连通：connect + gateway_echo 双检（连上 ≠ 认证过，echo 对得上才算真通）
    const conn = await gatewayPipe.connect({ pipePath: record.pipe, token: record.token, timeoutMs: 3000 });
    const echo = await conn.call("gateway_echo", { v: "p4-probe" }, { timeoutMs: 3000 });
    assert.strictEqual(echo.v, "p4-probe", "pipe 连上了但 gateway_echo 回话不对（token/派发层坏了）");
    // 唯一出口收摊：gateway_shutdown 必须拿到响应（评审 I2③ 的 flush 投递序），且以 0 干净退出
    const shut = await conn.call("gateway_shutdown", {}, { timeoutMs: 4000 });
    assert.ok(shut && shut.ok === true, "gateway_shutdown 未拿到 ok 响应");
    conn.close();
    const gone = await waitFor(() => childExit !== null, 5000);
    assert.ok(gone, "gateway_shutdown 后 5s 内子进程未退出");
    assert.strictEqual(childExit.code, 0, "常驻子进程停机应以 0 收场（drained）");
  } finally {
    try { child.kill(); } catch { /* 已退 */ }              // 红态兜底：只收自己起的孩子
    try { fs.rmSync(gwFile, { force: true }); } catch { /* 已不在 */ }  // 握手文件不外溢，别污染后续用例的「无网关」前提
  }
}

// ===== ①-B second-instance argv 解析契约（Task 9 项 2）=====
// 规格二期认领：二次拉起实例的命令行此前被忽略——「--gateway-start 这类从托盘/命令行拉起
// 网关的入口」需要它。本期只定解析契约（纯函数）+ 一条留痕日志，不加入口（入口编排归产品决策）。
// main.cjs 顶部 require("electron")，纯 Node 测试进不去，解析函数必须住在可 require 的
// gateway-client 里，main.cjs 与本闸共用同一份实现，防两处漂移。
async function case1b() {
  const parse = gatewayClient.parseGatewayArgv;
  assert.strictEqual(typeof parse, "function",
    "gateway-client 必须导出纯函数 parseGatewayArgv（second-instance 与本闸共用一份解析）");
  assert.deepStrictEqual(parse(["AgentHub.exe", "--gateway-start", "--hidden"]),
    { flags: ["--gateway-start"], hasStart: true }, "--gateway-start 必须被认出且 hasStart 置位");
  assert.deepStrictEqual(parse(["AgentHub.exe", "--other"]),
    { flags: [], hasStart: false }, "无关参数不得误报");
  assert.deepStrictEqual(parse(["--GATEWAY-START"]),
    { flags: ["--GATEWAY-START"], hasStart: true }, "大小写不敏感（Windows 命令行习惯）");
  assert.deepStrictEqual(parse(undefined), { flags: [], hasStart: false },
    "argv 缺省（老事件签名/畸形调用）必须安全返回空");
}

// ===== ② 便携版拒常驻：ok:true + persistent:false + 人话 message，不 spawn、不落 Run 项 =====
async function case2() {
  process.env.PORTABLE_EXECUTABLE_DIR = work;               // isPortable() 判真（config.cjs 主进程侧那份）
  // 「无网关」前提由本用例自建：P4 子进程的握手文件虽已在它的 finally 里清掉，这里再清一次，
  // 让「gateway.json 不存在 = 没起子进程」这条判据只反映 start() 自己的行为。
  try { fs.rmSync(gatewayClient.gatewayFile(), { force: true }); } catch { /* 已不在 */ }
  try {
    // ②-a 便携版 applyAutoStart 早退：注册调用一次都不许发生（不落 Run 项，Electron 与 reg.exe 两路都算）
    const regCalls2 = [];
    const realRegExec = config.regExec;
    config.regExec = (args) => { regCalls2.push(args.slice()); return { status: 0 }; };
    config.applyAutoStart({ schedule: { autoStart: true, persistentGateway: true } });
    config.regExec = realRegExec;
    assert.strictEqual(loginCalls.length, 0, "便携版 applyAutoStart 不得调用 setLoginItemSettings（不落 Run 项）");
    assert.strictEqual(regCalls2.length, 0, "便携版 applyAutoStart 不得调 reg.exe 写 Run 项");
    // ②-b start({persistent:true}) 拒常驻：返回契约逐字段钉死
    const r = await gatewayClient.start({ persistent: true });
    assert.strictEqual(r.ok, true, "拒常驻对调用方不算失败（ok 必须为 true）");
    assert.strictEqual(r.persistent, false, "返回值必须带 persistent:false");
    assert.strictEqual(r.message, "便携版不支持后台常驻", "message 必须原样报「便携版不支持后台常驻」");
    assert.strictEqual(gatewayClient.readGatewayFile(), null, "拒常驻不得 spawn 子进程（gateway.json 不存在）");
    assert.strictEqual(loginCalls.length, 0, "start 全程不得落任何 Run 项");
  } finally {
    delete process.env.PORTABLE_EXECUTABLE_DIR;
    // 红态兜底：旧代码没有拒常驻分支、真的 spawn 了 —— 用唯一出口 stopAndWait 收掉自己起的那棵树
    await gatewayClient.stopAndWait({ timeoutMs: 5000 }).catch(() => {});
  }
}

// ===== ③ applyAutoStart 注册目标随 persistentGateway 切换（记账断言，绝不真改注册表） =====
// 【真机批次② 发现】.cmd 目标改走 reg.exe 直写（Electron 35 setLoginItemSettings 带 path 会把
// 反斜杠当转义吃掉，落盘坏路径）——本用例把 regExec 换成记账器，逐档钉死「Electron 调用 + reg 调用」
// 的对称序列；主 exe 目标不带 path 仍走 setLoginItemSettings（标准路径，无 bug）。
async function case3() {
  loginCalls.length = 0;
  const expectedCmd = path.join(path.dirname(process.execPath), "agenthub-gateway.cmd");
  const realRegExec = config.regExec;
  const regCalls = [];
  config.regExec = (args) => { regCalls.push(args.slice()); return { status: 0 }; };
  try {
    // off 档（自启开、常驻关）→ 注册主 App exe + 清 .cmd 残留
    config.applyAutoStart({ schedule: { autoStart: true, persistentGateway: false } });
    assert.deepStrictEqual(loginCalls[0], { openAtLogin: true }, "off 档 Electron 调：注册主 App exe（不得带 path，path 一旦传入会被 35.7.5 的转义 bug 吃掉）");
    assert.deepStrictEqual(regCalls[0], ["delete", config.RUN_KEY, "/v", config.RUN_VALUE, "/f"], "off 档 reg 调：删 .cmd 的 Run 项（上次常驻档残留不 supervise 会永久留着）");
    // on 档（自启开、常驻开）→ reg.exe 写 .cmd + 清主 exe 残留
    config.applyAutoStart({ schedule: { autoStart: true, persistentGateway: true } });
    assert.deepStrictEqual(regCalls[1], ["add", config.RUN_KEY, "/v", config.RUN_VALUE, "/t", "REG_SZ", "/d", '"' + expectedCmd + '"', "/f"],
      "on 档 reg 调：把安装根目录 agenthub-gateway.cmd 写进 HKCU Run（/d 带内嵌引号，安装路径含空格也成立）");
    assert.deepStrictEqual(loginCalls[1], { openAtLogin: false }, "on 档 Electron 调：显式清主 exe（off 档留下的 Run 项必须一并注销）");
    // 关闭自启 → 两个目标都注销（不管上次停在哪一档）
    config.applyAutoStart({ schedule: { autoStart: false, persistentGateway: true } });
    assert.deepStrictEqual(loginCalls[2], { openAtLogin: false }, "关自启 Electron 调：注销主 exe 目标");
    assert.deepStrictEqual(regCalls[2], ["delete", config.RUN_KEY, "/v", config.RUN_VALUE, "/f"], "关自启 reg 调：删 .cmd 的 Run 项（只清一边 = 另一边开机仍拉起）");
    assert.strictEqual(loginCalls.length, 3, "三档恰好三次 Electron 调用（每档 1 次，只管主 exe 目标）");
    assert.strictEqual(regCalls.length, 3, "三档恰好三次 reg 调用（.cmd 目标的注册/注销全走 reg.exe）");
  } finally {
    config.regExec = realRegExec;
  }
  // regExePath 默认实现必须是真 reg.exe 绝对路径（不能指望 PATH——本机环境曾缺 System32）
  assert.ok(/[Ss]ystem32[\\/]reg\.exe$/.test(config.regExePath()), "regExePath 必须返回 System32\reg.exe 绝对路径");
}

// ===== ④ 收尾卫生：HKCU Run 项原样（沿用既有闸的 regValue() 手法） =====
async function case4() {
  assert.strictEqual(regValue(), regBefore,
    "HKCU Run 项被本次运行改动了（探针卫生第五条）：mock 注入下这里变红只可能是有人绕过 mock 真注册了");
}

(async () => {
  await runCase("① 启动器内容 + package.json extraFiles 接线（extraResources 一字未动）", case1);
  await runCase("①-P4 守门：--persistent 且 stdin 永不关闭 → gateway.json 8s 内出现且 pipe 可连通", case1p4);
  await runCase("①-B second-instance argv 解析契约（--gateway-start 识别，本期只解析留痕不动作）", case1b);
  await runCase("② 便携版拒常驻：契约返回 + 不 spawn + 不落 Run 项", case2);
  await runCase("③ applyAutoStart 目标切换：off → 主 App exe，on → agenthub-gateway.cmd", case3);
  await runCase("④ 收尾：HKCU Run 项原样", case4);
  if (failures.length) {
    console.error(`\nFAILED ${failures.length} 项：\n  - ` + failures.join("\n  - "));
    process.exit(1);
  }
  console.log("\nOK 启动器契约 / 便携拒常驻 / 自启目标切换 全绿");
})().catch((e) => { console.error("闸自身异常：" + String((e && e.stack) || e)); process.exit(1); });
