// 号池同步的改名缺陷闸（三期 fork 侧修复，2026-09-24）
//  ① LWW 时钟不对称 + 改名不推进时间戳 ⇒ 改名被下一轮同步还原
//  ② uid 缺失时改名改身份键 ⇒ 同一 token 变两条号（裁决：拒绝改名）
// 纯 Node、临时沙箱、零副作用（不开真库、不联网、不发任何 kill）
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-poolsync-"));
process.env.APPDATA = path.join(WORK, "appdata");
process.env.AGENT_SKILLS_HOME = path.join(WORK, "hub");
fs.mkdirSync(process.env.APPDATA, { recursive: true });

const store = require(path.join(ROOT, "electron", "backend", "proxy", "store.cjs"));
const poolsync = require(path.join(ROOT, "electron", "backend", "proxy", "poolsync.cjs"));

let n = 0;
const pass = (m) => { n++; console.log(`  ${String(n).padStart(2)}. ${m}`); };
const fail = (m) => { n++; console.log(`  ${String(n).padStart(2)}. ✗ ${m}`); };

// ===== ① 两侧必须用同一把尺（accountStamp）=====
// 旧实现的缺陷形态：导入侧用 `creditsAt || lastUsed || createdAt`（短路），导出侧用 Math.max(...)。
// 只要 creditsAt 非 0，两侧就不同值。这里直接对两种「一把尺」的取值做判别。
{
  const acc = { creditsAt: 9000, lastUsed: 1000, createdAt: 5000, renamedAt: 0 };
  const exportSide = Math.max(acc.creditsAt || 0, acc.lastUsed || 0, acc.createdAt || 0);          // 旧导出侧
  const importSideOld = Number(acc.creditsAt || acc.lastUsed || acc.createdAt || 0);               // 旧导入侧（短路）
  assert.strictEqual(exportSide, 9000, "导出侧旧算法应取 max = 9000");
  assert.strictEqual(importSideOld, 9000, "本例两值相同（creditsAt 最大时退化为同值）");
  // 换一组能暴露不对称的输入：creditsAt 存在但**小于** lastUsed
  const acc2 = { creditsAt: 7000, lastUsed: 9500, createdAt: 6000, renamedAt: 0 };
  const ex2 = Math.max(acc2.creditsAt || 0, acc2.lastUsed || 0, acc2.createdAt || 0);
  const im2Old = Number(acc2.creditsAt || acc2.lastUsed || acc2.createdAt || 0);
  assert.notStrictEqual(ex2, im2Old,
    "构造不出不对称的输入 —— 本判据的前提失效（旧导入侧短路取值应给出与 max 不同的值）");
  assert.strictEqual(ex2, 9500);
  assert.strictEqual(im2Old, 7000);
  // 新实现：两侧都调 accountStamp，必然同值
  assert.strictEqual(poolsync.accountStamp(acc2), 9500,
    "① accountStamp 必须取四来源的 max（含 lastUsed=9500）");
  assert.strictEqual(poolsync.accountStamp(acc2), ex2,
    "① 新实现必须与导出侧旧口径一致（同一把尺）");
  pass(`① 两侧同尺：accountStamp({creditsAt:7000,lastUsed:9500}) = ${poolsync.accountStamp(acc2)}（旧导入侧会错取 7000）`);
}

// ===== ①b 改名必须推进一个参与比较的时间戳 =====
{
  const before = { creditsAt: 1000, lastUsed: 2000, createdAt: 3000, renamedAt: 0 };
  const s0 = poolsync.accountStamp(before);
  assert.strictEqual(s0, 3000, "①b 改名前时间戳应为 3000");
  // 模拟改名后（store.updateAccount 会落 meta.renamedAt = now）
  const after = { creditsAt: 1000, lastUsed: 2000, createdAt: 3000, renamedAt: 9999 };
  assert.ok(poolsync.accountStamp(after) > s0,
    `①b 改名后时间戳必须**严格变大**（否则改名在 LWW 里永远不是最新写，会被对端还原）：`
    + `改前 ${s0} / 改后 ${poolsync.accountStamp(after)}`);
  pass(`①b 改名推进时间戳：${s0} → ${poolsync.accountStamp(after)}（renamedAt 参与 max）`);
}

// ===== ①c 真库：改名确实落 meta.renamedAt，且同名重写不推进（防写循环）=====
{
  const id = store.addAccount({ channel: "trae", uid: "u-aaa", name: "旧名", token: "tk-1", refreshToken: "", source: "paste" });
  const a0 = store.listAccounts().find((a) => a.id === id);
  assert.ok(a0, "①c 账号应已入池");
  assert.strictEqual(a0.renamedAt || 0, 0, "①c 新建账号的 renamedAt 应为 0");
  const s0 = poolsync.accountStamp(a0);

  store.updateAccount(id, { name: "新名" });
  const a1 = store.listAccounts().find((a) => a.id === id);
  assert.strictEqual(a1.name, "新名", "①c 名字应已改");
  assert.ok(Number(a1.renamedAt) > 0, "①c 改名必须落 meta.renamedAt（否则 LWW 里永远输）");
  const s1 = poolsync.accountStamp(a1);
  assert.ok(s1 > s0, `①c 改名后 accountStamp 必须变大：${s0} → ${s1}`);

  // 同名重写（同步应用远端同名）：名字没变 ⇒ 不得推进时间戳（否则两侧时间戳互相追赶、每轮白写）
  const before = Number(a1.renamedAt);
  store.updateAccount(id, { name: "新名" });
  const a2 = store.listAccounts().find((a) => a.id === id);
  assert.strictEqual(Number(a2.renamedAt), before,
    "①c 名字未变化时不得推进 renamedAt（防跨设备写循环）");
  pass(`①c 真库：改名落 renamedAt 且时间戳前移（${s0} → ${s1}）；同名重写不推进（防写循环）`);
}

// ===== ② uid 缺失 ⇒ 改名会改身份键 ⇒ 必须拒绝 =====
{
  const withUid = { channel: "trae", uid: "u-bbb", name: "甲" };
  const noUid = { channel: "trae", uid: "", name: "乙" };
  assert.strictEqual(poolsync.renameWouldChangeIdentity(withUid), false,
    "② 有 uid 的账号：身份键是 channel:uid，改名安全 ⇒ 不得拒绝");
  assert.strictEqual(poolsync.renameWouldChangeIdentity(noUid), true,
    "② uid 缺失的账号：身份键退回 channel:name，改名=改身份 ⇒ 必须拒绝");
  assert.strictEqual(poolsync.renameWouldChangeIdentity({ channel: "trae", uid: "   ", name: "丙" }), true,
    "② 纯空格 uid 等同缺失 ⇒ 必须拒绝");

  // 反证「为什么必须拒绝」：改名确实会改身份键
  const before = poolsync.accountKeyOf({ channel: "trae", uid: "", name: "旧名" });
  const after = poolsync.accountKeyOf({ channel: "trae", uid: "", name: "新名" });
  assert.notStrictEqual(before, after,
    `② 前提核查：uid 缺失时改名确实改变身份键（${before} → ${after}）—— 这正是「同一 token 变两条」的机制`);
  // 有 uid 时改名不动身份键
  assert.strictEqual(
    poolsync.accountKeyOf({ channel: "trae", uid: "u-bbb", name: "甲" }),
    poolsync.accountKeyOf({ channel: "trae", uid: "u-bbb", name: "甲改名后" }),
    "② 有 uid 时身份键不随 name 变化 ⇒ 改名安全");
  pass(`② uid 缺失 ⇒ 拒绝改名（身份键 ${before} → ${after} 会变）；有 uid 则放行（键不变）`);
}

// ===== ②b 真库：uid 缺失的账号经 IPC 注册体必须被拒（静态核注册体接线）=====
{
  const idx = fs.readFileSync(path.join(ROOT, "electron", "backend", "proxy", "index.cjs"), "utf8");
  const m = idx.match(/ipcMain\.handle\("proxy_account_rename"[\s\S]*?\n  \}\)\);/);
  assert.ok(m, "②b 找不到 proxy_account_rename 注册体");
  assert.ok(/renameWouldChangeIdentity/.test(m[0]),
    "②b 注册体必须调用 poolsync.renameWouldChangeIdentity 做拒绝判定（否则判据只是库函数、没接线）");
  assert.ok(/return fail\(/.test(m[0]), "②b 拒绝路径必须是 return fail(...)，让前端能 toast 出原因");
  pass("②b 注册体已接线：renameWouldChangeIdentity → return fail(…)（前端会 toast 出原因）");
}

store.close();
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* */ }
console.log(`\nOK 号池改名缺陷闸全过（${n} 项）：① LWW 同尺 + 改名推进时间戳（含防写循环）、② uid 缺失拒绝改名`);
