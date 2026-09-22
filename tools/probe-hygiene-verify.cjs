// probe-hygiene 修复轮 1 的验证脚本（§修复 2：快照不可信时退出钩子必须零写零删）。
//
// 三种模式：
//   node tools/probe-hygiene-verify.cjs neg-enoent  首次 reg query 强制 ENOENT（复刻本机实录：PATH 缺 System32 → reg.exe ENOENT）
//   node tools/probe-hygiene-verify.cjs neg-empty   首次 reg query 返回 status 0 + 空 stdout（空注册表和读失败分不清的场景）
//   node tools/probe-hygiene-verify.cjs pos         全部真实执行，零差异应零动作（正向路径）
//
// 判定（由 runner 断言，本脚本只负责复现 + 留痕）：
//   neg-*：stdout 必须出现「跳过全部恢复动作」WARN；PROBE_REG_LOG 里只允许 query，出现 add/delete 即 FAIL
//   pos  ：stdout 必须出现「HKCU Run 项未变」；PROBE_REG_LOG 同样只允许两次 query
//
// 安全性：拦截器只在 neg-* 模式下篡改**首次** query 的返回；其余所有 reg 调用真实透传，
// 而透传分支只有 query 会发生（新代码在不可信基线时不该有任何写删），脚本自身绝不写删注册表。
"use strict";
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const mode = process.argv[2] || "";
const logfile = process.env.PROBE_REG_LOG;
if (!["neg-enoent", "neg-empty", "pos"].includes(mode) || !logfile) {
  console.error("usage: PROBE_REG_LOG=<path> node tools/probe-hygiene-verify.cjs <neg-enoent|neg-empty|pos>");
  process.exit(2);
}

// reg 调用留痕（含写删类调用——一旦出现就是 FAIL 证据）
const regLog = [];

// 必须在 require probe-hygiene 之前打补丁：它在加载期解构了 spawnSync 引用，晚了拦不到。
// 注意：不能用 PATH 缺 System32 的方式造 ENOENT——那种场景下坏代码即便执行了 reg delete 也只会
// 静默 ENOENT，断言不出「没有尝试删」；拦截式复刻才能观察到「尝试了什么命令」。
const origSpawnSync = cp.spawnSync;
cp.spawnSync = function (cmd, args, opts) {
  if (cmd === "reg.exe") regLog.push([cmd, ...(args || [])].join(" "));
  if (cmd === "reg.exe" && args && args[0] === "query") {
    if (mode === "neg-enoent" && regLog.length === 1) {
      // 指向必然不存在的命令，让 spawnSync 真实产生 error（ENOENT），不走假对象
      return origSpawnSync("probe-hygiene-verify-missing-cmd.exe", args, opts);
    }
    if (mode === "neg-empty" && regLog.length === 1) {
      // status 0 + 空 stdout：解析出来是空 Map，新代码应按「不可信」处理
      return { pid: -1, status: 0, stdout: "", stderr: "", error: undefined };
    }
  }
  return origSpawnSync(cmd, args, opts);
};

const hygiene = require(path.resolve(__dirname, "probe-hygiene.cjs"));
const hy = hygiene("verify-" + mode);
console.log("ROOT=" + hy.root);

// 留痕钩子注册在 hygiene 的 exit 钩子之后，保证把退出路径里的 reg 调用也记全
process.on("exit", () => {
  try { fs.writeFileSync(logfile, JSON.stringify(regLog, null, 2)); } catch { /* 留痕失败不影响退出 */ }
});
