// 生态接入 · CC Switch 假库自测：造临时库（对齐真实 schema：BOOLEAN 标志列 + 复合主键 (id, app_type)），
// 用 CCSWITCH_DB_PATH 把模块指到它上面，验证 status / register 幂等 / 备份与轮换 / 条目内容 / 校验报错 / 版本不兼容。
// 用法：node scripts/dev-ccswitch-test.cjs
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ccswitch-test-"));
const dbFile = path.join(tmp, "cc-switch.db");
process.env.CCSWITCH_DB_PATH = dbFile;

let Database = null;
try {
  Database = require("node:sqlite").DatabaseSync;
} catch {
  Database = require("better-sqlite3");
}

// 真实 providers 表结构（CC Switch database/schema.rs：BOOLEAN 标志列默认 '0'，复合主键）
const PROVIDERS_SQL = `
CREATE TABLE providers (
  id TEXT NOT NULL,
  app_type TEXT NOT NULL,
  name TEXT NOT NULL,
  settings_config TEXT NOT NULL,
  website_url TEXT,
  category TEXT NOT NULL DEFAULT 'default',
  created_at INTEGER NOT NULL DEFAULT 0,
  sort_index INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  icon TEXT,
  icon_color TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  is_current BOOLEAN NOT NULL DEFAULT '0',
  in_failover_queue BOOLEAN NOT NULL DEFAULT '0',
  PRIMARY KEY (id, app_type)
);
`;

/** 重建指定库文件（可自定义建表 SQL；不传则建空库） */
function makeDb(file, tableSql) {
  fs.rmSync(file, { force: true });
  const db = new Database(file);
  if (tableSql) db.exec(tableSql);
  db.close();
  return file;
}

makeDb(dbFile, PROVIDERS_SQL);
const db = new Database(dbFile);
// 塞一条用户自己的 provider，验证绝不被改动
db.prepare(`INSERT INTO providers (id, app_type, name, settings_config, website_url, category, created_at, sort_index, is_current, in_failover_queue)
  VALUES ('user-claude-main', 'claude', '我的主力', '{"env":{"X":"1"}}', null, 'custom', 1, 5, '1', '0')`).run();
db.close();

const ccswitch = require("../electron/backend/proxy/ccswitch.cjs");

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
  assert.strictEqual(r.clone, undefined); // 防呆：register 不返回无关字段
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

  // 6) 校验报错分支：未知 appType / 空 key / 空 model（不落库）
  assert.strictEqual(ccswitch.register({ appType: "foo", apiKey: "k", model: "m" }).ok, false, "未知 appType 应失败");
  assert.ok(/未知应用类型/.test(ccswitch.register({ appType: "foo", apiKey: "k", model: "m" }).message), "未知 appType 报错文案");
  assert.ok(/API Key/.test(ccswitch.register({ appType: "claude", apiKey: "  ", model: "m" }).message), "空 key 报错文案");
  assert.ok(/默认模型/.test(ccswitch.register({ appType: "claude", apiKey: "k", model: "" }).message), "空 model 报错文案");
  console.log("✓ 参数校验报错分支");

  // 7) 备份：至少 3 份（两次 claude + 一次 codex）
  let backups = fs.readdirSync(path.join(tmp, "backups"));
  assert.ok(backups.length >= 3, "备份数量应 >=3，实际 " + backups.length + " -> " + backups.join(","));
  console.log("✓ 备份目录文件 =", backups.join(", "));

  // 8) 备份轮换：连续注册足够多次后，本应用前缀备份不超过保留上限（BACKUP_KEEP=10），
  //    且不误删非本应用文件（预先放一个别的备份文件当哨兵）
  fs.writeFileSync(path.join(tmp, "backups", "cc-switch.db.bak_user_manual"), "user sentinel");
  for (let i = 0; i < 12; i++) {
    ccswitch.register({ appType: "claude", apiKey: "sk-rotate", model: "m", port: 9527 });
  }
  backups = fs.readdirSync(path.join(tmp, "backups"));
  const mine = backups.filter((n) => n.startsWith("cc-switch.db.bak_agenthub_"));
  assert.ok(mine.length <= 10, "轮换后本应用备份应 <=10，实际 " + mine.length + " -> " + mine.join(","));
  assert.ok(backups.includes("cc-switch.db.bak_user_manual"), "哨兵备份不得被删");
  console.log("✓ 备份轮换保留 <=10 且不动其它备份");

  // 9) status 终态：都 registered
  s = ccswitch.status();
  assert.deepStrictEqual(s.entries.map((e) => [e.appType, e.registered]), [["claude", true], ["codex", true]]);
  console.log("✓ status 终态全部已注册");

  // 10) 版本不兼容：providers 缺列 → status.incompatible + register 报版本不兼容
  const badCols = path.join(tmp, "bad-cols.db");
  makeDb(badCols, `CREATE TABLE providers (id TEXT, app_type TEXT, name TEXT)`);
  process.env.CCSWITCH_DB_PATH = badCols;
  assert.strictEqual(ccswitch.status().incompatible, true, "缺列库 incompatible 应为 true");
  const rBad = ccswitch.register({ appType: "claude", apiKey: "k", model: "m" });
  assert.strictEqual(rBad.ok, false, "缺列库 register 应失败");
  assert.ok(/版本不兼容/.test(rBad.message), "应报版本不兼容: " + rBad.message);
  console.log("✓ 缺列库：incompatible + 「版本不兼容」报错");

  // 11) 无 providers 表 → status.incompatible + register 报表不存在
  const empty = path.join(tmp, "empty.db");
  makeDb(empty, null);
  process.env.CCSWITCH_DB_PATH = empty;
  assert.strictEqual(ccswitch.status().incompatible, true, "空库 incompatible 应为 true");
  const rEmpty = ccswitch.register({ appType: "claude", apiKey: "k", model: "m" });
  assert.strictEqual(rEmpty.ok, false, "空库 register 应失败");
  assert.ok(/providers 表不存在/.test(rEmpty.message), "应报表不存在: " + rEmpty.message);
  console.log("✓ 无 providers 表：incompatible + 表不存在报错");

  // 12) 缺库：整库不存在 → installed=false + register 失败
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