// 二期 Task 0 闸：网关依赖图必须在「无 electron 绑定」的纯 Node 环境里可整体加载。
//
// 为什么必须把代码拷出仓库再 require：CJS 的模块解析从**被 require 文件自身位置**上溯找
// node_modules，与进程 cwd 无关。在仓库里 require("electron") 会命中 devDependency 的
// node_modules/electron/index.js，它导出一个 exe 路径**字符串**（不是 Electron 绑定），
// 于是顶层 const { shell } = require("electron") 连抛错都不会 → 回归能大摇大摆溜过去。
// 上一版用「中立 cwd + 该目录下不存在 node_modules/electron」自证，作用面查错了，等于没闸。
//
// 本版两条牙：
//  ① 把整张 electron/backend 依赖图拷到仓库外（os.tmpdir() 下，其上溯链没有 node_modules/electron），
//     从拷贝里 require 全部候选模块——加载不抛错才是真正的「纯 Node 可加载」证明；
//  ② 反向自咬：同目录放一份 bad.cjs（内容与 index.cjs 修复前那一行同形），require 它**必须**失败，
//     否则说明这份环境其实解析得到 electron，①的通过就是假绿。
// 外加结构性判据：proxy/ 下不允许出现顶层 require("electron")（取代旧的「引用计数」，计数无拦截力）。
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-gwnode-"));
// 清理挂在 exit 上：断言抛错（红的那条路）也要把临时目录带走，不然每次失败都漏一份网关依赖图拷贝
process.on("exit", () => { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows 偶发 EBUSY，交给系统回收 */ } });
// 拷贝保持与仓库相同的相对深度（package.json 在 electron/backend/proxy 上溯 3 级），
// 这样 util.appVersion() 在拷贝里读的仍是同一份真实 version
const GATEWAY = path.join(work, "gateway");
fs.cpSync(path.join(ROOT, "electron", "backend"), path.join(GATEWAY, "electron", "backend"), { recursive: true });
fs.copyFileSync(path.join(ROOT, "package.json"), path.join(GATEWAY, "package.json"));
// 反向自咬样本：顶层 require 一个本环境解析不到的包，必须炸。
// 必须落在 proxyDir 里面——CJS 解析看的是**被 require 文件自身位置**的上溯链，
// 放上一层等于测了另一个位置的规则，而「拷贝树里混进 node_modules/electron」正是 proxyDir 这一层的事。
const BAD = path.join(GATEWAY, "electron", "backend", "proxy", "bad.cjs");
fs.writeFileSync(
  BAD,
  '"use strict";\nconst { shell } = require("electron");\nmodule.exports = shell;\n'
);

// 子进程里跑断言集（路径一律用正斜杠，Windows 的 fs 同样接受）
const fwd = (p) => p.split(path.win32.sep).join("/");
const child = `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const gw = ${JSON.stringify(fwd(path.join(GATEWAY, "electron", "backend")))};
const work = ${JSON.stringify(fwd(work))};
const proxyDir = path.join(gw, "proxy");
// ① 真·无 electron 绑定环境下的整体加载（任何一处顶层 require("electron") 都会在这里炸）。
//    清单从目录派生而不是硬编码：proxy/ 下新增模块自动进闸，改名也不会漏。
const names = fs.readdirSync(proxyDir).filter((f) => f.endsWith(".cjs") && f !== "bad.cjs").sort();
if (names.length < 15) throw new Error("proxy 模块清单异常（只看到 " + names.length + " 个 .cjs，拷贝没成功？）");
for (const n of names) require(path.join(proxyDir, n));
require(path.join(gw, "config.cjs"));
// 自证：加载的确实是仓库外那份拷贝，而不是绕路又摸回了仓库
const secretbox = require(path.join(proxyDir, "secretbox.cjs"));
if (path.resolve(String(secretbox.__selfCheck)) !== path.resolve(proxyDir)) {
  throw new Error("__selfCheck 不是拷贝目录，require 命中了仓库原件：" + secretbox.__selfCheck);
}
// ② 反向自咬：proxyDir 里那份顶层 require("electron") 的样本必须解析失败
let bit = false;
try { require(${JSON.stringify(fwd(BAD))}); }
catch (e) { bit = e.code === "MODULE_NOT_FOUND" && /Cannot find module 'electron'/.test(String(e.message)); }
if (!bit) throw new Error("隔离判定失败：bad.cjs 竟然 require 到了 electron，上面的加载断言全是假绿");
// 这份环境里拿不到 safeStorage，后端必须降级（不是 safeStorage）
if (secretbox.backend() === "safeStorage") throw new Error("拷贝目录里不该拿到 safeStorage");
// I2 结构性判据：加密能力必须**每次调用时**判，不许在模块加载期取值缓存。
// 用可翻转的假 safeStorage 经 Module._load 钩子注入（这份拷贝目录解析不到真 electron，钩子先截获）
const M = require("node:module");
const origLoad = M._load;
let encAvailable = false;
M._load = function (request, ...rest) {
  if (request === "electron") return { safeStorage: { isEncryptionAvailable: () => encAvailable } };
  return origLoad.call(this, request, ...rest);
};
const sbKey = require.resolve(path.join(proxyDir, "secretbox.cjs"));
delete require.cache[sbKey];
encAvailable = false;                 // 加载期 = app ready 之前，能力「尚未就绪」
const sb2 = require(sbKey);
if (sb2.backend() !== "plain-dev") throw new Error("加载期未就绪时后端应为 plain-dev，实得 " + sb2.backend());
encAvailable = true;                  // 就绪之后同一个实例必须改口，否则就是缓存了快照
if (sb2.backend() !== "safeStorage") throw new Error("backend() 把加载期取值缓存住了（I2 回归），实得 " + sb2.backend());
M._load = origLoad;
const util = require(path.join(proxyDir, "util.cjs"));
const v = util.appVersion();
if (!/^\\d+\\.\\d+\\.\\d+/.test(String(v))) throw new Error("appVersion 不是版本号: " + JSON.stringify(v));
console.log("CHILD-OK " + v);
`;

const r = spawnSync(process.execPath, ["-e", child], {
  cwd: work, encoding: "utf8",
  env: Object.assign({}, process.env, {
    ELECTRON_RUN_AS_NODE: "1",
    AGENT_SKILLS_HOME: path.join(work, "hub"),
    // 兜底隔离：万一将来某个模块加载期就去算数据目录，也不许碰真实的 %APPDATA%\AgentHub
    APPDATA: path.join(work, "appdata"),
  }),
});
const out = (r.stdout || "") + (r.stderr || "");
assert.strictEqual(r.status, 0, "纯 Node 加载网关依赖图失败：\n" + out.slice(0, 1600));
assert.match(out, /CHILD-OK \d+\.\d+\.\d+/, "子进程没打出 CHILD-OK：\n" + out.slice(0, 400));

// ===== 结构性判据：proxy/ 下不许有「顶层」require("electron") =====
// 顶层 = 模块加载期就求值（行首无缩进、不在 try 里），纯 Node 子进程必炸；
// 函数体内或 try 守卫内的惰性取用是设计允许的（events.cjs 广播、index.cjs 的 getShell 与 dialog）。
// 注释行不算（旧「引用计数」把注释文本算进分子，因而没有判定力）。
function collectCjs(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectCjs(p, acc);
    else if (e.name.endsWith(".cjs")) acc.push(p);
  }
  return acc;
}
const offenders = [];
for (const f of collectCjs(path.join(ROOT, "electron", "backend", "proxy"))) {
  const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const t = line.trim();
    if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return;
    if (!/require\(\s*["']electron["']\s*\)/.test(line)) return;
    if (/^\s/.test(line) || /\btry\b/.test(line)) return;
    offenders.push(`${path.relative(ROOT, f).replace(/\\/g, "/")}:${i + 1}`);
  });
}
assert.deepStrictEqual(
  offenders, [],
  "electron/backend/proxy 下出现顶层 require(\"electron\")，纯 Node 子进程会加载失败：" + offenders.join(", ")
);

// 临时目录由开头的 process.on("exit") 钩子回收（绿的路和红的路都覆盖）
console.log("OK 网关依赖图在纯 Node（无 electron 绑定）下可整体加载，且 proxy/ 无顶层 require(\"electron\")");
