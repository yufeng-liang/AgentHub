// 探针卫生集中点（规格 §八「探针卫生」；二期 Task 8 把一期「每个脚本手写一遍」收敛到这一处）。
//
// 凡搬运进 tools/ 的验收探针，必须在 require 任何产品代码（electron/backend/**）之前第一行调用：
//   const hy = require("./probe-hygiene.cjs")("<脚本名>");
// 之后通过 hy.root 取临时根目录。本模块只 require node 内置模块，自身无副作用入口。
//
// 中和的三件事：
//  1) APPDATA → 临时目录。spawn 出来的打包实例整体继承本进程环境，userData（config.json、
//     Local State、stats.db 的默认落点族）全部被挡进临时目录，绝不碰真实 %APPDATA%\AgentHub。
//  2) AGENT_SKILLS_HOME → 临时目录。hubDir() 按 os.homedir() 解析共享中央仓库 ~/.agent_skills，
//     --user-data-dir 挡不住它（一期 Task 7 实测教训）。
//  3) CCSWITCH_DB_PATH → 临时目录。ccswitch 模块读该变量覆盖库位置（AGENTS.md 第六节），
//     不指副本就会开到真实的 ~/.cc-switch/cc-switch.db。这里只给隔离路径占位；
//     需要真库结构的探针自己把副本复制到 hy.root 后再覆盖此变量。
//
// 关于 applyAutoStart 副作用（§八 第二件）：打包版非便携实例每次启动都调
// applyAutoStart(loadConfig())（electron/main.cjs whenReady 一带），临时 config 不带
// schedule.autoStart 时 openAtLogin=false，setLoginItemSettings 会把**用户自己的**开机自启
// Run 项删掉。探针进程在应用外，无法替实例「显式调 applyAutoStart(false)」豁免——
// 集中形式因此是：起跑前快照 HKCU Run 全表，探针退出时重查比对，发现被删/改/增就**原样恢复**
// 并打 WARN（比 §八 要求的「收尾核对未变」更进一步：核对失败时自动兜底回写）。
// 安全侧规则：启动快照或退出复查**不可信**时（reg 读失败，或「空表」与「读不到」分不清），
// 退出钩子只打 WARN、跳过全部恢复动作——绝不在不可信基线上做「比对删除」：空 Map 会被
// 误判成「用户全部 Run 项都是本次新增」，退出比对会把真实自启项删光。
// 注意：exit 钩子只在正常退出（含 process.exit）时跑，探针被强杀时不兜底，需人工按快照比对。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

// 解析 `reg query` 输出的一行值：值名 + 类型 + 数据（数据里可能含空格，类型只有有限的几种）
function parseRunValues(text) {
  const out = new Map();
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^    (.+?)\s{2,}(REG_[A-Z_]+)\s{2,}(.*)$/.exec(line);
    if (m) out.set(m[1], { type: m[2], data: m[3] });
  }
  return out;
}

function queryRun() {
  const r = spawnSync("reg.exe", ["query", RUN_KEY], { encoding: "utf8" });
  // ok=false 表示这次读不可信：spawn 出错（本机实录：PATH 缺 System32 → reg.exe ENOENT）
  // 或 reg 返回非零（键不存在/权限问题）。「空注册表」和「读不到」靠 status 也分不全，
  // 所以上层还叠加「stdout 全空则同样按不可信」的兜底判定。
  return { ok: !r.error && r.status === 0, stdout: r.stdout || "" };
}

function hygiene(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-probe-" + name + "-"));

  // 三件套必须在任何产品代码 require 之前生效（子进程 spawn 整体继承本进程环境）
  process.env.APPDATA = path.join(root, "appdata");
  process.env.AGENT_SKILLS_HOME = path.join(root, "hub");
  process.env.CCSWITCH_DB_PATH = path.join(root, "cc-switch.db");
  fs.mkdirSync(process.env.APPDATA, { recursive: true });
  fs.mkdirSync(process.env.AGENT_SKILLS_HOME, { recursive: true });

  // HKCU Run 快照 + 退出恢复（applyAutoStart 副作用的集中中和，见文件头说明）
  const first = queryRun();
  const parsed = parseRunValues(first.stdout);
  // 基线可信性判定：读失败（error / status≠0）直接不可信；「解析为空且 stdout 全空」
  // 同样按不可信——空注册表和读不到分不清，宁可放弃恢复能力（安全侧误报），也不能
  // 拿着空基线进退出比对，把用户真实的 Run 项全当「本次新增」删光。
  const baselineUnreliable = !first.ok || (parsed.size === 0 && !String(first.stdout).trim());
  const baseline = baselineUnreliable ? new Map() : parsed;
  let done = false;
  process.on("exit", () => {
    if (done) return;
    done = true;
    // 这个模块的存在意义是保护用户注册表：快照读不到时「什么都不做」才是安全侧，
    // 写/删动作只能发生在基线（和退出复查）都可信的前提下。
    if (baselineUnreliable) {
      console.log("[probe-hygiene] WARN: 启动时 HKCU Run 快照不可信（reg query 失败或空表无法区分），退出钩子跳过全部恢复动作（不比对、不写、不删），请人工核对注册表");
      return;
    }
    const second = queryRun();
    const after = parseRunValues(second.stdout);
    // 退出复查同样按可信性把关：复查读不到就跳过，避免把快照值盲目回写覆盖用户现状
    if (!second.ok || (after.size === 0 && !String(second.stdout).trim())) {
      console.log("[probe-hygiene] WARN: 退出时 HKCU Run 复查不可信，无法可信比对，跳过全部恢复动作（不比对、不写、不删），请人工核对注册表");
      return;
    }
    let touched = 0;
    for (const [k, v] of baseline) {
      const cur = after.get(k);
      if (!cur || cur.data !== v.data || cur.type !== v.type) {
        spawnSync("reg.exe", ["add", RUN_KEY, "/v", k, "/t", v.type, "/d", v.data, "/f"], { encoding: "utf8" });
        console.log("[probe-hygiene] WARN: HKCU Run 值被本次探针改动，已原样恢复 -> " + k);
        touched++;
      }
    }
    for (const k of after.keys()) {
      if (!baseline.has(k)) {
        spawnSync("reg.exe", ["delete", RUN_KEY, "/v", k, "/f"], { encoding: "utf8" });
        console.log("[probe-hygiene] WARN: HKCU Run 出现本次探针新增的值，已删除 -> " + k);
        touched++;
      }
    }
    if (!touched) console.log("[probe-hygiene] HKCU Run 项未变（快照比对通过，共 " + baseline.size + " 个值）");
  });

  return { root };
}

module.exports = hygiene;
