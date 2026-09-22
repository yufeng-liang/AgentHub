// 二期 Task 0 闸：网关依赖图必须在「纯 Node 角色」下可加载。
// 关键：必须从中立 cwd 跑。在仓库目录里 require("electron") 会命中 devDependency 的
// node_modules/electron/index.js，它返回一个 exe 路径**字符串**（不是 Electron 绑定），
// 于是 typeof electron === "object" 为假、看似"降级成功"实则是假绿。探针卫生第五条。
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-gwnode-"));
fs.copyFileSync(path.join(ROOT, "electron/backend/proxy/index.cjs"), path.join(work, "sentinel.cjs"));

// 子进程里跑的最小断言集：能 require 全部候选 + util.appVersion 不依赖 electron
const child = `"use strict";
const path = require("node:path");
const names = ["server","store","rules","pool","poolsync","adapters","credits","discovery","events","ideswitch","ccswitch","util","raccoonAuth","index"];
for (const n of names) { require(path.join(${JSON.stringify(path.join(ROOT, "electron/backend/proxy").replace(/\\/g, "/"))}, n + ".cjs")); }
require(path.join(${JSON.stringify(path.join(ROOT, "electron/backend").replace(/\\/g, "/"))}, "config.cjs"));
const util = require(path.join(${JSON.stringify(path.join(ROOT, "electron/backend/proxy").replace(/\\/g, "/"))}, "util.cjs"));
const v = util.appVersion();
if (!/^\\d+\\.\\d+\\.\\d+/.test(String(v))) throw new Error("appVersion 不是版本号: " + JSON.stringify(v));
const el = require("node:fs").existsSync(path.join(process.cwd(), "node_modules/electron"));
if (el) throw new Error("cwd 污染：中立 cwd 里不该有 node_modules/electron");
console.log("CHILD-OK " + v);
`;

const r = spawnSync(process.execPath, ["-e", child], {
  cwd: work, encoding: "utf8",
  env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1", AGENT_SKILLS_HOME: path.join(work, "hub") }),
});
const out = (r.stdout || "") + (r.stderr || "");
assert.strictEqual(r.status, 0, "纯 Node 加载网关依赖图失败：\n" + out.slice(0, 1200));
assert.match(out, /CHILD-OK \d+\.\d+\.\d+/, "子进程没打出 CHILD-OK：\n" + out.slice(0, 400));
try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows 偶发 EBUSY，交给系统回收 */ }
console.log("OK 网关依赖图在纯 Node（无 electron 绑定）下可整体加载");
