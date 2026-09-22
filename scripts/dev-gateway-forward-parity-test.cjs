// 二期 Task 5 闸：代理命令名四处逐字相等 + 归属修正的结构证据。
//
// 少一条命令名就是渲染层拿到「未授权的 IPC 命令」或界面卡死（AGENTS.md 第四节），
// 所以四个来源必须逐字相等，不允许可用别名词形（逐字，不是集合同构的宽容比较之外再加拼写）：
//   ① preload.cjs 的 ALLOWED_COMMANDS 里 proxy_* 全集（渲染层唯一入口）
//   ② 一期基线：git show main:electron/backend/proxy/index.cjs 里的 43 个 ipcMain.handle 名
//   ③ 当前主进程注册面：gateway-client.register(收集器) 实际登记的命令名
//     （= 36 条转发 + 4 条 UI_LOCAL + 3 条薄包装，Task 5 起主进程只从这里注册）
//   ④ 子进程 dispatchTable() 的键集（命令实现体真正的所在地）
// 断言：①==②==③ 且 ④ ⊇ ②（子进程可以有多出来的 gateway_* 内建命令与两条内部辅助命令，
//       但不得少任何 proxy_*）；另钉两条归属结构证据：
//   · ipc.cjs 不得再直连注册 proxy_*、不得再 require ./proxy/index.cjs（整张依赖图会被一条 require 拉回主进程）
//   · main.cjs 不得再 require proxy 域（stats.db 子进程独占由此达成）
//
// 手法约束（与 Task 0/1/2 的闸同一套纪律）：
//  · 只 require 产品模块、只建收集器，不起管道、不开端口、不 spawn 子进程、不碰真实 %APPDATA%
//    （APPDATA / AGENT_SKILLS_HOME / CCSWITCH_DB_PATH 在任何产品 require 之前指到临时目录）；
//  · ② 来自 git show main —— 一期基线是「用户已用过的行为」的快照，拿当前分支当基线 = 自我实现；
//  · 判据逐字比较（数组逐元素相等），不是「个数相等」：改名换字 headline 相等闸抓不住。
"use strict";
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-fwpar-"));

// ===== 隔离：必须早于任何产品代码的 require =====
process.env.APPDATA = path.join(work, "appdata");
process.env.AGENT_SKILLS_HOME = path.join(work, "hub");
process.env.CCSWITCH_DB_PATH = path.join(work, "ccswitch.db");
fs.mkdirSync(process.env.APPDATA, { recursive: true });

let failures = [];
const check = (name, cond, detail) => {
  console.log(`  ${cond ? "PASS" : "FAIL"} ${name}${cond ? "" : "\n      " + detail}`);
  if (!cond) failures.push(name);
};
const nameSet = (arr) => new Set(arr);
const diff = (a, b) => [...a].filter((x) => !b.has(x));

console.log("① preload ALLOWED_COMMANDS 的 proxy_* 全集");
const preloadSrc = fs.readFileSync(path.join(ROOT, "electron", "preload.cjs"), "utf8");
const allowBlock = /ALLOWED_COMMANDS = new Set\(\[([\s\S]*?)\]\);/.exec(preloadSrc);
const fromPreload = allowBlock
  ? [...allowBlock[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]).filter((n) => n.startsWith("proxy_"))
  : [];
check("① 能从 preload.cjs 解析出 proxy_* 白名单（非空）", fromPreload.length > 0,
  `解析到 ${fromPreload.length} 条 —— ALLOWED_COMMANDS 的字面量形状变了？`);

console.log("② 一期基线（git show main:electron/backend/proxy/index.cjs）");
const git = spawnSync("git", ["show", "main:electron/backend/proxy/index.cjs"], { cwd: ROOT, encoding: "utf8" });
const baselineSrc = git.status === 0 ? git.stdout : "";
const fromBaseline = [...baselineSrc.matchAll(/ipcMain\.handle\("([a-z0-9_]+)"/g)].map((m) => m[1]);
check("② git show main 可用", git.status === 0, `exit=${git.status} ${String(git.stderr).slice(0, 200)}`);
check("② 基线里 proxy_* 注册恰为 43 条", fromBaseline.filter((n) => n.startsWith("proxy_")).length === 43,
  `数到 ${fromBaseline.filter((n) => n.startsWith("proxy_")).length} 条（43 = 用户已用过的一期行为面，条数变了先核基线再改判据）`);
check("② 基线没有 proxy_ 之外的注册混进 index.cjs", fromBaseline.every((n) => n.startsWith("proxy_")),
  "混入了：" + fromBaseline.filter((n) => !n.startsWith("proxy_")).join(", "));

console.log("③ 主进程注册面：gateway-client.register(收集器)");
let fromMain = [];
let mainRegistered = false;
try {
  const gatewayClient = require(path.join(ROOT, "electron", "backend", "gateway-client.cjs"));
  if (typeof gatewayClient.register !== "function") {
    check("③ gateway-client.cjs 导出 register(ipcMain)", false,
      "主进程注册面不在 gateway-client（43 条命令仍由 ipc.cjs 经 proxy.register 直连注册）——Task 5 未落地");
  } else {
    const seen = new Map();
    gatewayClient.register({ handle: (name, fn) => { seen.set(name, typeof fn === "function"); } });
    fromMain = [...seen.keys()];
    mainRegistered = true;
    check("③ register 收集到的每条都是函数体", [...seen.values()].every(Boolean), "有非函数登记项");
    check("③ 无重复注册", fromMain.length === seen.size, `登记 ${seen.size} 条、去重后 ${fromMain.length} 条`);
  }
} catch (e) {
  check("③ gateway-client.register 可独立收集（纯 Node）", false, String((e && e.message) || e));
}

console.log("④ 子进程 dispatchTable() 键集");
let subKeys = [];
try {
  const proxy = require(path.join(ROOT, "electron", "backend", "proxy", "index.cjs"));
  if (typeof proxy.dispatchTable !== "function") {
    check("④ index.cjs 导出 dispatchTable()", false, "子进程命令表入口没了（Task 3 的接口）");
  } else {
    subKeys = Object.keys(proxy.dispatchTable());
  }
} catch (e) {
  check("④ dispatchTable() 可在纯 Node 收集", false, String((e && e.message) || e));
}
const newSubCmds = ["proxy_account_import_blob", "proxy_poolsync_password_changed"];
check("④ 子进程表含 proxy_account_import_blob（import_file 拆两段的子进程半段）",
  subKeys.includes("proxy_account_import_blob"),
  "主进程读完文件字节后没有可投的子命令 —— 文件导入仍是主进程直连实现或整段留在主进程");
check("④ 子进程表含 proxy_poolsync_password_changed（webdav_shared_save 反向跨界的子进程半段）",
  subKeys.includes("proxy_poolsync_password_changed"),
  "主进程仍在直接 require poolsync 写子进程独占的 sync-state.json");
const subExtra = diff(nameSet(subKeys), nameSet(fromBaseline));
const EXTRA_WHITELIST = new Set(["gateway_echo", "gateway_shutdown", ...newSubCmds]);
check("④ 子进程多出来的键都在白名单内（gateway_* 内建 + 两条内部辅助命令）",
  subExtra.every((n) => EXTRA_WHITELIST.has(n)),
  "多出白名单外的键：" + subExtra.filter((n) => !EXTRA_WHITELIST.has(n)).join(", "));

console.log("断言：①==②==③ 且 ④ ⊇ ②");
check("① == ②（preload 白名单与一期基线逐字相等）",
  fromPreload.length === fromBaseline.length && diff(nameSet(fromPreload), nameSet(fromBaseline)).length === 0
  && diff(nameSet(fromBaseline), nameSet(fromPreload)).length === 0,
  "preload 有基线没有：" + diff(nameSet(fromPreload), nameSet(fromBaseline)).join(", ")
  + "；基线有 preload 没有：" + diff(nameSet(fromBaseline), nameSet(fromPreload)).join(", "));
check("① == ③（主进程注册面与渲染层白名单逐字相等）", mainRegistered
  && fromPreload.length === fromMain.length
  && diff(nameSet(fromPreload), nameSet(fromMain)).length === 0
  && diff(nameSet(fromMain), nameSet(fromPreload)).length === 0,
  !mainRegistered ? "③ 未取得（见上）"
    : "主进程缺：" + diff(nameSet(fromPreload), nameSet(fromMain)).join(", ")
    + "；主进程多：" + diff(nameSet(fromMain), nameSet(fromPreload)).join(", "));
check("④ ⊇ ②（子进程表覆盖全部 43 条，一条不得少）",
  diff(nameSet(fromBaseline), nameSet(subKeys)).length === 0,
  "子进程表缺：" + diff(nameSet(fromBaseline), nameSet(subKeys)).join(", "));

console.log("归属结构证据：主进程两条直连路径收口");
const COMMENT_LINE = /^\s*(\/\/|\*|\/\*)/;   // 注释里的字样不算（与 dev-write-ownership-test 同一口径）
const ipcSrc = fs.readFileSync(path.join(ROOT, "electron", "backend", "ipc.cjs"), "utf8");
const ipcDirect = ipcSrc.split(/\r?\n/)
  .filter((l) => !COMMENT_LINE.test(l))
  .join("\n")
  .match(/ipcMain\.handle\("proxy_[a-z0-9_]+"/g);
check("ipc.cjs 零直连注册 proxy_*", !ipcDirect, `ipc.cjs 仍直连注册 ${ipcDirect ? ipcDirect.length : 0} 条 proxy_* 命令`);
const ipcProxyReq = ipcSrc.split(/\r?\n/)
  .filter((l) => !COMMENT_LINE.test(l))
  .join("\n")
  .match(/require\(\s*["'][^"']*proxy\/index\.cjs["']\s*\)/g);
check("ipc.cjs 不再 require ./proxy/index.cjs（一条 require 会把整张依赖图含 store 拉回主进程）",
  !ipcProxyReq, "ipc.cjs 仍持有 proxy/index.cjs 的 require");
const mainSrc = fs.readFileSync(path.join(ROOT, "electron", "main.cjs"), "utf8");
const mainProxyReq = mainSrc.split(/\r?\n/)
  .filter((l) => !COMMENT_LINE.test(l))
  .join("\n")
  .match(/require\(\s*["'][^"']*proxy\/[^"']+["']\s*\)/g);
check("main.cjs 零 proxy 域 require", !mainProxyReq,
  "main.cjs 仍持有：" + (mainProxyReq || []).join(", "));

try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows 偶发 EBUSY，交给系统回收 */ }
if (failures.length) {
  console.log(`FAIL 代理命令名逐字相等闸未过（${failures.length} 条红）：\n  - ` + failures.join("\n  - "));
  process.exit(1);
}
console.log("OK 代理命令名四处逐字相等（①preload == ②main基线 == ③主进程注册面，④子进程表 ⊇ ②）+ 归属结构证据齐");
