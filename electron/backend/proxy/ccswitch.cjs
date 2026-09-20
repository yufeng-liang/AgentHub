// 生态接入 · CC Switch：把 AgentHub 反代网关注册（upsert）为 CC Switch 的 provider 条目
// 只读写 ~/.cc-switch/cc-switch.db 的 providers 表（固定 id），绝不动其它 provider；
// 上游格式 = OpenAI Chat Completions（Claude 条目 meta.apiFormat = "openai_chat"，协议翻译由 CC Switch 承担）
// 测试可用 CCSWITCH_DB_PATH 环境变量把库位置指到临时目录（备份目录跟随其父目录）
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const config = require("../config.cjs");

// 驱动与 store.cjs 一致：Node 22 内置 node:sqlite 优先，better-sqlite3 回退
let Database = null;
let driver = "none";
try {
  Database = require("node:sqlite").DatabaseSync;
  driver = "node:sqlite";
} catch {
  try {
    Database = require("better-sqlite3");
    driver = "better-sqlite3";
  } catch {
    Database = null;
  }
}

/** 固定 id：靠它做幂等 upsert，也保证不触碰用户其它 provider */
const FIXED = {
  claude: "agenthub-gateway-claude",
  codex: "agenthub-gateway-codex",
};
const APP_NAMES = {
  claude: "AgentHub 网关（Claude Code）",
  codex: "AgentHub 网关（Codex）",
};
const ICONS = {
  claude: { icon: "anthropic", iconColor: "#D4915D" },
  codex: { icon: "openai", iconColor: "#10A37F" },
};

function ccDir() {
  return process.env.CCSWITCH_DB_PATH ? path.dirname(process.env.CCSWITCH_DB_PATH) : path.join(os.homedir(), ".cc-switch");
}

function dbPath() {
  return process.env.CCSWITCH_DB_PATH || path.join(os.homedir(), ".cc-switch", "cc-switch.db");
}

/** 打开 CC Switch 库；不写库的调用（status/备份）也只是纯 SELECT/VACUUM，不必单独开只读 */
function openDb() {
  if (!Database) throw new Error("SQLite 驱动不可用（node:sqlite / better-sqlite3 均加载失败）");
  const db = driver === "better-sqlite3" ? new Database(dbPath(), { timeout: 3000 }) : new Database(dbPath());
  db.exec("PRAGMA busy_timeout = 3000"); // CC Switch 可能正开着（WAL），等待而非直接失败
  return db;
}

function formatTimestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds())}`;
}

/** 写前备份：VACUUM INTO 产出单一一致性快照（含 WAL 未合并帧），避免复制 .db/-wal 三件套的撕裂风险；
 *  目标已存在时按 .1/.2 后缀递增，保证每次注册的备份独立落盘；返回实际写入的路径 */
function backupTo(backupPath) {
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  let target = backupPath;
  let n = 0;
  while (fs.existsSync(target)) {
    n += 1;
    target = `${backupPath}.${n}`;
  }
  const src = openDb();
  try {
    const esc = String(target).replace(/\\/g, "\\\\").replace(/'/g, "''");
    src.exec(`VACUUM INTO '${esc}'`);
  } catch {
    // 老 SQLite 不支持 VACUUM INTO 时退化为文件拷贝（仅兜底；CC Switch 官方同款做法）
    for (const suffix of ["", "-wal", "-shm"]) {
      const f = dbPath() + suffix;
      if (fs.existsSync(f)) fs.copyFileSync(f, target + suffix);
    }
  } finally {
    src.close();
  }
  if (!fs.existsSync(target)) throw new Error("备份失败：未生成备份文件");
  return target;
}

/** 组装条目的 settings_config / meta（字符串化后入库） */
function buildEntry(appType, { base, apiKey, model }) {
  if (appType === "claude") {
    return {
      settings_config: {
        env: {
          ANTHROPIC_BASE_URL: base,
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_API_KEY: apiKey,
          ANTHROPIC_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL: model,
          ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL: model,
          ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
          ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: model,
          CLAUDE_CODE_SUBAGENT_MODEL: model,
        },
      },
      meta: { apiFormat: "openai_chat", commonConfigEnabled: false },
    };
  }
  // codex：CC Switch 依此写 ~/.codex/config.toml + auth.json；上游 chat 格式由 CC Switch 翻译
  const esc = String(model).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const toml = [
    'model_provider = "custom"',
    `model = "${esc}"`,
    'model_reasoning_effort = "high"',
    "disable_response_storage = true",
    "",
    "[model_providers.custom]",
    'name = "AgentHub"',
    `base_url = "${base}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = true",
    "",
  ].join("\n");
  return {
    settings_config: { auth: { OPENAI_API_KEY: apiKey }, config: toml },
    meta: { commonConfigEnabled: false },
  };
}

/** 只读视图：CC Switch 是否已安装 + 两个固定条目是否已注册 */
function status() {
  const p = dbPath();
  if (!fs.existsSync(p)) {
    return { installed: false, dbPath: p, entries: [
      { appType: "claude", registered: false },
      { appType: "codex", registered: false },
    ] };
  }
  const db = openDb();
  try {
    let rows = [];
    let incompatible = false;
    try {
      rows = db.prepare(`SELECT id, name FROM providers WHERE id IN (?, ?)`).all(FIXED.claude, FIXED.codex);
    } catch {
      incompatible = true; // 库在但 providers 表缺失等，按未注册展示
    }
    return {
      installed: true,
      incompatible,
      dbPath: p,
      entries: ["claude", "codex"].map((t) => {
        const row = rows.find((r) => r.id === FIXED[t]);
        return { appType: t, registered: !!row, name: row ? row.name : undefined };
      }),
    };
  } finally {
    db.close();
  }
}

/** 注册（upsert）固定 id 条目：备份 → 表自检 → UPDATE 优先，0 行则 INSERT */
function register({ appType, apiKey, model, port } = {}) {
  const t = String(appType || "");
  if (t !== "claude" && t !== "codex") return { ok: false, message: `未知应用类型 "${t}"` };
  const key = String(apiKey || "").trim();
  const mdl = String(model || "").trim();
  if (!key) return { ok: false, message: "请先选择网关 API Key" };
  if (!mdl) return { ok: false, message: "请填写默认模型" };
  if (!Number.isFinite(port) || port <= 0) {
    const cfg = config.loadConfig();
    port = (cfg && cfg.proxy && cfg.proxy.port) || 9527;
  }
  const p = dbPath();
  if (!fs.existsSync(p)) {
    return { ok: false, message: "未检测到 CC Switch（缺少 ~/.cc-switch/cc-switch.db），请先安装并启动一次 CC Switch" };
  }

  // 1) 写前整库备份（失败则中止，不碰原库）
  let backupPath = "";
  try {
    backupPath = backupTo(path.join(ccDir(), "backups", `cc-switch.db.bak_agenthub_${formatTimestamp()}`));
  } catch (e) {
    return { ok: false, message: `备份失败，已中止：${(e && e.message) || e}` };
  }

  // 2) 表结构自检：providers 表与其必需列
  const db = openDb();
  try {
    const hasTable = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='providers'`).get();
    if (!hasTable) return { ok: false, message: "CC Switch 数据库版本不兼容（providers 表不存在）" };
    const cols = new Set(db.prepare(`PRAGMA table_info(providers)`).all().map((c) => c.name));
    for (const need of ["id", "app_type", "name", "settings_config", "meta"]) {
      if (!cols.has(need)) return { ok: false, message: `CC Switch 数据库版本不兼容（providers 缺列 ${need}）` };
    }

    // 3) 组装并 upsert
    const base = `http://127.0.0.1:${port}`;
    const entry = buildEntry(t, { base, apiKey: key, model: mdl });
    const now = Date.now();
    const name = APP_NAMES[t];
    const settings = JSON.stringify(entry.settings_config);
    const meta = JSON.stringify(entry.meta);
    const notes = `由 AgentHub 生态接入页生成（${new Date(now).toLocaleString("zh-CN")}）`;
    const upd = db.prepare(`UPDATE providers SET name = ?, settings_config = ?, notes = ?, meta = ? WHERE id = ?`)
      .run(name, settings, notes, meta, FIXED[t]);
    let action = "updated";
    if (!upd.changes) {
      // 排在同 app 分组其它条目末尾；固定 id 本身不参与计 max（避免覆盖已有条目顺序）
      const maxRow = db.prepare(
        `SELECT COALESCE(MAX(sort_index), 0) AS m FROM providers WHERE app_type = ? AND id NOT IN (?, ?)`
      ).get(t, FIXED.claude, FIXED.codex);
      const sortIndex = Number((maxRow && maxRow.m) || 0) + 1;
      db.prepare(
        `INSERT INTO providers
           (id, app_type, name, settings_config, website_url, category, created_at, sort_index, notes, icon, icon_color, meta, is_current, in_failover_queue)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        FIXED[t], t, name, settings, "https://github.com/HUIdada1/AgentHub", "custom",
        now, sortIndex, notes, ICONS[t].icon, ICONS[t].iconColor, meta, "0", "0"
      );
      action = "inserted";
    }
    return { ok: true, action, backupPath, dbPath: p, appType: t };
  } finally {
    db.close();
  }
}

module.exports = { status, register };