// 特征测试：fingerprint 异步化后输出必须与旧同步实现逐字节一致 —— 快照差集决定自动
// 收纳，语义变一个字符就会误收纳或漏收纳。其余 require 全打桩，不碰真实配置目录。
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const { types } = require("node:util");

const BACKEND = path.join(__dirname, "..", "electron", "backend");

// 夹具：普通文件 / 带 SKILL.md 的目录 / 无 SKILL.md 的目录 / 不存在的目标目录
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-watch-"));
const trae = path.join(tmp, "trae");
const qoder = path.join(tmp, "qoder");
fs.mkdirSync(path.join(trae, "skill-a"), { recursive: true });
fs.writeFileSync(path.join(trae, "skill-a", "SKILL.md"), "# a");
fs.mkdirSync(path.join(trae, "skill-b"), { recursive: true });
fs.writeFileSync(path.join(trae, "plain.md"), "x");
fs.mkdirSync(qoder, { recursive: true });
fs.writeFileSync(path.join(qoder, "only.md"), "y");
const TARGETS = [
  { id: "trae", dir: trae },
  { id: "qoder", dir: qoder },
  { id: "gone", dir: path.join(tmp, "does-not-exist") },
];

function stub(name, exports) {
  const file = path.join(BACKEND, name);
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  require.cache[file] = m;
}
stub("adapter.cjs", { resolveScanTargets: () => TARGETS });
stub("config.cjs", { loadConfig: () => ({ watch: { enabled: true } }) });
stub("syncer.cjs", { planSync: () => ({ actions: [], conflicts: [] }), executeSync: () => ({}) });
stub("remotesync.cjs", { isRunning: () => false });
const watch = require(path.join(BACKEND, "watch.cjs"));

// 对照基准：改动前 electron/backend/watch.cjs:22-55 的函数体整段复制，
// 只把 adapter.resolveScanTargets(cfg) 换成固定夹具 TARGETS，分隔符转义字符照抄原样。
function legacyFingerprint() {
  const parts = [];
  for (const t of TARGETS) {
    const list = [];
    let entries;
    try {
      entries = fs.readdirSync(t.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      let st;
      try {
        st = fs.lstatSync(path.join(t.dir, e.name));
      } catch {
        continue;
      }
      const kind = st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : st.isFile() ? "f" : "?";
      // 目录条目的 mtime 在成员文件被原地编辑时不变（NTFS 口径）：技能目录加算其
      // SKILL.md 的 mtime+size，纯内容编辑（最常见的技能变更）也能被感知
      let extra = "";
      if (kind === "d") {
        try {
          const sm = fs.statSync(path.join(t.dir, e.name, "SKILL.md"));
          extra = `${Math.round(sm.mtimeMs)}:${sm.size}`;
        } catch { /* 无 SKILL.md 或读不到 */ }
      }
      list.push(`${e.name}\u0000${kind}\u0000${st.mtimeMs}\u0000${extra}`);
    }
    list.sort();
    parts.push(`${t.id}\u0001${list.join("\n")}`);
  }
  return parts.join("\v");
}

(async () => {
  try {
    // 1) 形态：改造后必须返回 Promise（改造前这一条就该红）
    assert.ok(types.isPromise(watch.fingerprint({})), "fingerprint 应已改为返回 Promise");
    // 2) 逐字节等价于旧同步实现
    const fp = await watch.fingerprint({});
    assert.strictEqual(fp, legacyFingerprint());
    // 3) 读不到的目标目录整块跳过
    assert.ok(!fp.includes("gone"), "不存在的目标目录不应进入快照");
    // 4) 纯内容编辑可感知：SKILL.md 变长后快照必须变
    fs.writeFileSync(path.join(trae, "skill-a", "SKILL.md"), "# a longer");
    assert.notStrictEqual(await watch.fingerprint({}), fp, "SKILL.md 内容变化必须反映到快照");
    console.log("OK watch fingerprint 异步化断言全通过");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true }); // 与 dev-ccswitch-test.cjs 同口径，别在 %TEMP% 堆夹具
  }
})().catch((e) => { console.error(e); process.exit(1); });
