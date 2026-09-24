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
for (const [k, s] of Object.entries(src))
  assert.match(s, /launchHidden: true/, `${k} 的 schedule 字面量里 launchHidden 必须是 true（三处同源，一期 Task 6 就因漏改前端两处红过）`);
assert.strictEqual(cfg.schedule.minimizeToTray, false, "用户已有值（非默认 false）不能被默认值 true 盖掉");
assert.strictEqual(cfg.theme, "light", "同层其它字段（非默认 light）不受影响");
console.log("OK 配置深合并补齐新字段");
