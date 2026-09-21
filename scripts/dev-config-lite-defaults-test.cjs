// 存量 config.json 没有新字段时，深合并必须补出默认值 —— 老用户升级后的关窗行为
// 不能靠运气。读写全程落在临时目录，不碰真实配置与中央技能仓库。
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-cfg-"));
process.env.APPDATA = tmp;
process.env.AGENT_SKILLS_HOME = path.join(tmp, "hub");
const config = require(path.join(__dirname, "..", "electron", "backend", "config.cjs"));

const dir = path.join(tmp, "AgentHub"); // dataDir() 的纯 Node 回退：APPDATA/AgentHub
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(
  path.join(dir, "config.json"),
  JSON.stringify({
    theme: "dark",
    schedule: { minimizeToTray: true, autoStart: false, hourly: false, daily: false, dailyTime: "09:00", notifyOnSuccess: false },
  }),
  "utf8"
);

const cfg = config.loadConfig();
assert.strictEqual(cfg.schedule.liteOnClose, true, "老配置应补出 liteOnClose 默认 true");
assert.strictEqual(cfg.schedule.launchHidden, false, "launchHidden 默认应为 false");
assert.strictEqual(cfg.schedule.minimizeToTray, true, "用户已有值不能被默认值盖掉");
assert.strictEqual(cfg.theme, "dark", "同层其它字段不受影响");
console.log("OK 配置深合并补齐新字段");
