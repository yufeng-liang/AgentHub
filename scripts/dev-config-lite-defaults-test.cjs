// 存量 config.json 没有新字段时，深合并必须补出默认值 —— 老用户升级后的关窗行为
// 不能靠运气。读写全程落在临时目录，不碰真实配置与中央技能仓库。
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-cfg-"));
process.env.APPDATA = tmp;
process.env.AGENT_SKILLS_HOME = path.join(tmp, "hub");
const config = require(path.join(__dirname, "..", "electron", "backend", "config.cjs"));

const dir = path.join(tmp, "AgentHub"); // dataDir() 的纯 Node 回退：APPDATA/AgentHub
fs.mkdirSync(dir, { recursive: true });
// 夹具里被要求「保留」的用户值必须故意不等于 config.cjs 的默认值，否则下面两条断言是空转的：
// 默认值恰好就是它时，「落盘值被保留」与「被默认值覆盖」的合并结果一模一样，mergeConfig 把方向写反也测不出来。
// 故 theme 取 "light"（默认 dark）、minimizeToTray 取 false（默认 true）。改值时请同步下面的断言。
fs.writeFileSync(
  path.join(dir, "config.json"),
  JSON.stringify({
    theme: "light",
    schedule: { minimizeToTray: false, autoStart: false, hourly: false, daily: false, dailyTime: "09:00", notifyOnSuccess: false },
  }),
  "utf8"
);

const cfg = config.loadConfig();
assert.strictEqual(cfg.schedule.liteOnClose, true, "老配置应补出 liteOnClose 默认 true");
assert.strictEqual(cfg.schedule.launchHidden, true, "三期起 launchHidden 默认 true：轻量态自洽要求两字段同真（规格 §五）");
// 四处字面量一致性（前端两处 + 后端一处 + 本闸夹具），漏一处就是「UI 显示关、后端生效开」
const src = {
  store: fs.readFileSync(path.join(ROOT, "src/stores/app.ts"), "utf8"),
  mock: fs.readFileSync(path.join(ROOT, "src/api/mock.ts"), "utf8"),
  backend: fs.readFileSync(path.join(ROOT, "electron/backend/config.cjs"), "utf8"),
};
// 剥注释（顺序不能反：先块注释再行注释，行注释里可能出现 `/*`）。与 dev-wal-convergence-test.cjs 同款。
// 必须剥：不剥的话「字面量改回 false、只在行尾注释里留 launchHidden: true」会命中全文正则，
// 闸绿而实际是 UI 显示关、后端生效开（评审实测过的假阴性）。
function stripComments(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
// 针由片段拼出：本文件里不出现完整的针字面量，避免「自己读自己时自我命中」的恒假红
// （同仓 dev-wal-convergence-test.cjs 的纪律）。锚定到 `launchHidden: true,` 这一整个字面量，
// 不再接受「true 出现在别处」的松散命中。
const PIN = "launch" + "Hidden:\\s*true,";
const PIN_RE = new RegExp(PIN);
for (const [k, s] of Object.entries(src))
  assert.match(stripComments(s), PIN_RE, `${k} 的 schedule 字面量里 launchHidden 必须是 true（三处同源，一期 Task 6 就因漏改前端两处红过）`);
// 闸自身反向自检（防「收紧被后人改回松的」而四面全绿）：字面量 false + 注释里留 true，剥注释后必须判红。
// 两条内联断言串里**刻意不含 `schedule: {` 字样**，免得将来「扫全仓 schedule 夹具」类检查
// 把它们误认成一处探针面（本闸第 25 行那个夹具本身就是要验默认值的缺字段态，属乙类、不钉）。
assert.ok(!PIN_RE.test(stripComments("const x = { " + "launch" + "Hidden: false }; // 说明：默认 " + "launch" + "Hidden: true, 见规格")),
  "闸对「字面量 false + 注释里留 true」必须判红（剥注释后不得命中）");
assert.ok(PIN_RE.test(stripComments("const x = { " + "launch" + "Hidden: true, autoStart: false };")),
  "闸对真字面量必须判绿（收紧不能收到把真值也漏掉）");
assert.strictEqual(cfg.schedule.minimizeToTray, false, "用户已有值（非默认 false）不能被默认值 true 盖掉");
assert.strictEqual(cfg.theme, "light", "同层其它字段（非默认 light）不受影响");
console.log("OK 配置深合并补齐新字段");
