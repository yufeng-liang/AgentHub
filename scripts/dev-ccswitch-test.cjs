// 生态接入 · CC Switch 假库自测：造一个临时 cc-switch.db（官方 14 列 schema），
// 用 CCSWITCH_DB_PATH 把模块指到它上面，验证 status / register 幂等 / 备份 / 条目内容。
// 用法：node scripts/dev-ccswitch-test.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccswitch-test-"));
const dbFile = path.join(tmp, "cc-switch.db");
process.env.CCSWITCH_DB_PATH = dbFile;

// 建库（对齐 CC Switch database/schema.rs 的 providers 表）
let Database = null;
try {
  Database = require("node:sqlite").DatabaseSync;
} catch {
  Database = require("better-sqlite3");
}
const db = new Database(dbFile);
db.exec(`
CREATE TABLE providers (
  id TEXT NOT NULL PRIMARY KEY,
  app_type TEXT NOT NULL,
  name TEXT NOT NULL,
  settings_config TEXT,
  website_url TEXT,
  category TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL,
  sort_index INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  icon TEXT,
  icon_color TEXT,
  meta TEXT,
  is_current TEXT NOT NULL DEFAULT '0',
  in_failover_queue TEXT NOT NULL DEFAULT '0'
);
`);
// 塞一条用户自己的 provider，验证绝不被改动
db.prepare(`INSERT INTO providers (id, app_type, name, settings_config, category, created_at, sort_index, is_current, in_failover_queue)
  VALUES ('user-claude-main', 'claude', '我的主力', '{"env":{"X":"1"}}', 'custom', 1, 5, '1', '0')`).run();
db.close();

const ccswitch = require("../electron/backend/proxy/ccswitch.cjs");

function fail(msg) {
  console.error("✗ " + msg);
  process.exit(1);
}

(async () => {
  // 1) 初始 status：未注册
  let s = ccswitch.status();
  assert.strictEqual(s.installed, true, "installed 应为 true");
  assert.strictEqual(s.incompatible, false, "schema 正常不应 incompatible");
  assert.deepStrictEqual(s.entries.map((e) => e.registered), [false, false], "初始应都未注册");
  console.log("✓ status 初始未注册");

  // 2) 注册 claude
  let r = ccswitch.register({ appType: "claude", apiKey: "sk-test-123", model: "deepseek-v4-flash", port: 9527 });
  assert.strictEqual(r.ok, true, "register claude 应 ok: " + JSON.stringify(r));
  assert.strictEqual(r.action, "inserted", "首次应为 inserted");
  assert.ok(r.backupPath && fs.existsSync(r.backupPath), "应生成备份文件: " + r.backupPath);
  console.log("✓ register claude inserted，备份 =", r.backupPath);

  // 3) 重复注册 claude：updated 幂等，不新增行
  r = ccswitch.register({ appType: "claude", apiKey: "sk-test-456", model: "deepseek-v4-flash", port: 9527 });
  assert.strictEqual(r.action, "updated", "重复注册应为 updated");

  // 4) 注册 codex
  r = ccswitch.register({ appType: "codex", apiKey: "sk-test-123", model: "deepseek-v4-flash", port: 9527 });
  assert.strictEqual(r.clone, undefined); // 防呆：无 clone 字段由 schema 保证
  assert.strictEqual(r.ok, true, "register codex 应 ok");
  assert.strictEqual(r.action, "inserted", "codex 首次应为 inserted");
  console.log("✓ register codex inserted");

  // 5) 校验最终库内容
  const db2 = new Database(dbFile);
  const rows = db2.prepare("SELECT * FROM providers ORDER BY sort_index").all();
  db2.close();
  const claudeRow = rows.find((x) => x.id === "agenthub-gateway-claude");
  const codexRow = rows.find((x) => x.id === "agenthub-gateway-codex");
  assert.ok(claudeRow, "应有 claude 固定条目");
  assert.ok(codexRow, "应有 codex 固定条目");
  // 用户 provider 未被动过
  const userRow = rows.find((x) => x.id === "user-claude-main");
  assert.strictEqual(userRow.settings_config, '{"env":{"X":"1"}}', "用户 provider 不得被改动");
  assert.strictEqual(userRow.sort_index, 5, "用户 provider 的 sort_index 不得被改动");
  console.log("✓ 用户 provider 未被触碰");

  // 条目内容
  const cs = JSON.parse(claudeRow.settings_config);
  assert.strictEqual(cs.env.ANTHROPIC_BASE_URL, "http://127.0.0.1:9527", "claude base url");
  assert.strictEqual(cs.env.ANTHROPIC_AUTH_TOKEN, "sk-test-456", "重复注册后 key 应更新为最新");
  assert.strictEqual(cs.env.CLAUDE_CODE_SUBAGENT_MODEL, "deepseek-v4-flash", "子代理模型");
  const metaC = JSON.parse(claudeRow.meta);
  assert.strictEqual(metaC.apiFormat, "openai_chat", "claude 上游格式须为 openai_chat");
  const cdx = JSON.parse(codexRow.settings_config);
  assert.strictEqual(cdx.auth.OPENAI_API_KEY, "sk-test-123", "codex auth");
  assert.ok(cdx.config.includes('model_provider = "custom"'), "codex toml: model_provider");
  assert.ok(cdx.config.includes('model = "deepseek-v4-flash"'), "codex toml: model");
  assert.ok(cdx.config.includes('[model_providers.custom]'), "codex toml: custom 段");
  assert.ok(cdx.config.includes('base_url = "http://127.0.0.1:9527/v1"'), "codex toml: base_url");
  assert.ok(cdx.config.includes('wire_api = "responses"'), "codex toml: wire_api");
  assert.ok(cdx.config.includes("requires_openai_auth = true"), "codex toml: requires_openai_auth");
  assert.strictEqual(cdx.app_name, undefined, "无多余字段");
  console.log("✓ claude 条目 env 嵌套 + apiFormat=openai_chat");
  console.log("✓ codex 条目 auth + 指定 toml");

  // 6) 备份：应存在备份目录与至少 3 份备份文件（两次 claude + 一次 codex）
  const backups = fs.readdirSync(path.join(tmp, "backups"));
  assert.ok(backups.length >= 3, "备份数量应 >=3，实际 " + backups.length + " -> " + backups.join(","));
  console.log("✓ 备份目录文件 =", backups.join(", "));

  // 7) status 终态：都 registered
  s = ccswitch.status();
  assert.deepStrictEqual(s.entries.map((e) => [e.appType, e.registered]), [["claude", true], ["codex", true]]);
  console.log("✓ status 终态全部已注册");

  // 8) 异常分支：缺库
  delete process.env.CCSWITCH_DB_PATH;
  assert.strictEqual(ccswitch.status().installed, false, "无库时 installed=false");
  const rNoDb = ccswitch.register({ appType: "claude", apiKey: "k", model: "m" });
  assert.strictEqual(rNoDb.ok, false, "无库时 register 应失败");
  console.log("✓ 缺库状态与报错");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log("\n全部通过 ✓");
})().catch((e) => {
  console.error("✗ 异常：", e);
  process.exit(1);
});