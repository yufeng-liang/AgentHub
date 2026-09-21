// 特征测试一：fingerprint 异步化后输出必须与旧同步实现逐字节一致 —— 快照差集决定自动
// 收纳，语义变一个字符就会误收纳或漏收纳。
// 特征测试二：tick 的重入闸确实拦住跨拍重叠（异步化新引入的风险，见断言 5）。
// 特征测试三：stop() 作废"已经 await 出去、正挂着的那一拍"，start() 再放开（断言 6/7）。
// 其余 require 全打桩，不碰真实配置目录。
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
// 调用计数：断言 5 靠"扫描/规划/执行各被进入几次"观测重入闸的行为，断言 6/7 靠 execs
// 观测 stop() 之后挂起那一拍有没有真的走进 handle。
// 这是本文件唯一一处耦合内部实现的地方，专为钉住闸门与停机作废而写。
let scans = 0;
let plans = 0;
let execs = 0;
stub("adapter.cjs", { resolveScanTargets: () => { scans++; return TARGETS; } });
stub("config.cjs", { loadConfig: () => ({ watch: { enabled: true } }) });
// planSync 给一个 import 动作：让 handle 真的走到 executeSync，断言 5 才测得到"重复收纳"
stub("syncer.cjs", {
  planSync: () => {
    plans++;
    return { actions: [{ type: "import", name: "skill-a" }], conflicts: [] };
  },
  executeSync: () => { execs++; return { summary: { imported: 1 } }; },
});
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
    // 5) tick 重入闸：fingerprint 里一旦有 await，上一拍没跑完下一拍就能插进来，
    //    两个 handle 并发会重复收纳。旧同步版结构上不可能重叠，所以这条断言钉的是
    //    本次改动新引入的风险——把 watch.cjs 闸门从 `if (ticking || busy)` 退回
    //    `if (busy)` 后，本文件必红（实到 2 次扫描）。
    //    闸门判断在 tick 的同步前段、await 之前，两拍必然一前一后进入，不靠时序运气。
    await watch.tick(); // 第 1 拍：只落基线
    assert.strictEqual(plans, 0, "首拍不应动作");
    fs.mkdirSync(path.join(trae, "skill-c"), { recursive: true });
    fs.writeFileSync(path.join(trae, "skill-c", "SKILL.md"), "# c");
    await watch.tick(); // 第 2 拍：快照变了但只一拍，记 pending 不动作
    assert.strictEqual(plans, 0, "只变一拍不应动作（连续两拍一致才算）");

    const scansBeforeOverlap = scans;
    await Promise.all([watch.tick(), watch.tick()]); // 连发两拍，不等第一拍
    assert.strictEqual(
      scans - scansBeforeOverlap,
      1,
      "并发两拍只应扫描一次，实到 " + (scans - scansBeforeOverlap)
    );
    assert.strictEqual(plans, 1, "planSync 只应跑一次");
    assert.strictEqual(execs, 1, "executeSync 只应跑一次（闸门要防的就是重复收纳）");

    const scansAfterGate = scans;
    await watch.tick(); // 闸门必须在上一拍结束后放开
    assert.strictEqual(scans, scansAfterGate + 1, "下一拍应照常扫描，否则感知被永久锁死");
    assert.strictEqual(execs, 1, "收敛拍不应再执行收纳");

    // 6) stop() 必须作废"已经 await 出去、正挂着的那一拍"。异步化前一拍必然跑完，
    //    before-quit 结构上碰不到在飞的扫描；现在 stop() 只清 timer，而 main.cjs:364-372
    //    的 pendingInstall 分支 preventDefault 之后还会继续 pump 事件循环，resume 的这拍
    //    照样能走到 handle() → executeSync 真搬文件 + onEvent 发桌面通知。
    //    拦的是 stop() 置的标志，不是"timer 为空"——本文件断言 6/7 会真的 start()/stop()，
    //    若以 `!timer` 作判据，stop 之后每一拍都作废，恢复拍（断言 6）当场红。
    fs.mkdirSync(path.join(trae, "skill-d"), { recursive: true });
    fs.writeFileSync(path.join(trae, "skill-d", "SKILL.md"), "# d");
    await watch.tick(); // 前置拍：只记 pending（baseline 还是 skill-c 那一版）
    assert.strictEqual(plans, 1, "前置拍只应记 pending，不应规划");
    const execsBeforeStop = execs;
    const suspended = watch.tick(); // 同步跑进 fingerprint，在第一个 await 处挂住
    watch.stop();                   // 就在它挂着的时候停机
    await suspended;
    assert.strictEqual(
      execs - execsBeforeStop,
      0,
      "stop() 后挂起中的那一拍必须作废，实到 " + (execs - execsBeforeStop) + " 次收纳"
    );

    // 7) start() 要清掉停机标志，否则重启感知后永远不干活；同时反证断言 6 的提前 return
    //    没把 ticking 焊死（焊死了这拍进不去 fingerprint，增量会是 0 而不是 1）。
    //    两拍之间磁盘不再变化，pending 仍等于当前快照，所以这一拍本来就该动作。
    const execsBeforeStart = execs;
    watch.start();
    await watch.tick();
    assert.strictEqual(
      execs - execsBeforeStart,
      1,
      "start() 后应恢复动作，实到 " + (execs - execsBeforeStart) + " 次收纳"
    );
    watch.stop(); // 别把 15 秒的 timer 留在事件循环里

    console.log("OK watch fingerprint 异步化断言全通过");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true }); // 与 dev-ccswitch-test.cjs 同口径，别在 %TEMP% 堆夹具
  }
})().catch((e) => { console.error(e); process.exit(1); });
