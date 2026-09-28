// 积分包到期特性闸（Q10 归一 / Q7 派生 / Q2 整体替换 / Q9 poolsync 接线）
//  ① util.normalizeExpiryMs：秒/毫秒判别、纯日期补 23:59:59、远未来脏值→长期(0)
//  ② pool.deriveAccountCredits：Σ未过期剩余、最近到期取 remaining>0、不限哨兵、无包→null
//  ③ store 包集整体替换：DELETE+INSERT 原子替换、-1 保留、负值归 0、ord 排序、删号清包
//  ④ 静态接线：poolsync 导出/合并、credits 派生落库、schema 建表
// 纯 Node、临时沙箱、零副作用（不开真库、不联网、不发任何 kill）
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-credpkg-"));
process.env.APPDATA = path.join(WORK, "appdata");
process.env.AGENT_SKILLS_HOME = path.join(WORK, "hub");
fs.mkdirSync(process.env.APPDATA, { recursive: true });

const util = require(path.join(ROOT, "electron", "backend", "proxy", "util.cjs"));
const pool = require(path.join(ROOT, "electron", "backend", "proxy", "pool.cjs"));
const store = require(path.join(ROOT, "electron", "backend", "proxy", "store.cjs"));

let n = 0;
const pass = (m) => { n++; console.log(`  ${String(n).padStart(2)}. ${m}`); };
const DAY = 86400000;

// ===== ① normalizeExpiryMs 归一（Q10） =====
{
  const ms = Date.now() + 50 * DAY;
  assert.strictEqual(util.normalizeExpiryMs(ms), ms, "① 毫秒时间戳应原样返回");
  const sec = Math.floor((Date.now() + 50 * DAY) / 1000);
  assert.strictEqual(util.normalizeExpiryMs(sec), sec * 1000, "① 秒级时间戳应 ×1000");
  const ds = new Date(Date.now() + 100 * DAY).toISOString().slice(0, 10);
  assert.strictEqual(util.normalizeExpiryMs(ds), Date.parse(ds + "T23:59:59"),
    "① 纯日期串应补到当天 23:59:59（否则取到 00:00 会被误判提前一天过期）");
  const far = new Date(Date.now() + 8 * 365 * DAY).toISOString().slice(0, 10);
  assert.strictEqual(util.normalizeExpiryMs(far), 0, "① 远未来脏值（>5 年）应归 0=长期有效");
  assert.strictEqual(util.normalizeExpiryMs(""), 0, "① 空串→0");
  assert.strictEqual(util.normalizeExpiryMs(null), 0, "① null→0");
  pass("① normalizeExpiryMs：秒/毫秒判别、纯日期补 23:59:59、远未来→0、空→0");
}

// ===== ② deriveAccountCredits 派生（Q7） =====
{
  const T = Date.now();
  const pkgs = [
    { remaining: 100, total: 100, expiresAt: T + 10 * DAY },
    { remaining: 50, total: 50, expiresAt: T + 5 * DAY },
    { remaining: 200, total: 200, expiresAt: T - 1 * DAY }, // 已过期，不计
  ];
  const d = pool.deriveAccountCredits(pkgs, T);
  assert.strictEqual(d.credits, 150, "② 剩余=Σ未过期包剩余（100+50，过期的 200 不计）");
  assert.strictEqual(d.expiresAt, T + 5 * DAY, "② 最近到期=min(剩余>0 且未过期 的包到期)");

  const unl = pool.deriveAccountCredits([...pkgs, { remaining: -1, total: -1, expiresAt: 0 }], T);
  assert.strictEqual(unl.credits, -1, "② 任一包不限(-1) ⇒ credits=-1 哨兵");

  const withPerpetual = pool.deriveAccountCredits(
    [{ remaining: 30, total: 30, expiresAt: 0 }, { remaining: 50, total: 50, expiresAt: T + 5 * DAY }], T);
  assert.strictEqual(withPerpetual.credits, 80, "② 无到期(0)包剩余计入余额");
  assert.strictEqual(withPerpetual.expiresAt, T + 5 * DAY, "② 最近到期忽略无到期(0)的包");

  const noRemain = pool.deriveAccountCredits(
    [{ remaining: 0, total: 100, expiresAt: T + 2 * DAY }, { remaining: 0, total: 10, expiresAt: 0 }], T);
  assert.strictEqual(noRemain.credits, 0, "② 全无剩余 ⇒ credits=0");
  assert.strictEqual(noRemain.expiresAt, 0, "② 无 remaining>0 的包 ⇒ 最近到期=0");

  assert.strictEqual(pool.deriveAccountCredits([]), null, "② 空包集 ⇒ null（保留上游聚合值）");
  assert.strictEqual(pool.deriveAccountCredits(undefined), null, "② 非数组 ⇒ null");
  pass("② deriveAccountCredits：Σ未过期剩余 / 最近到期取 remaining>0 / 不限哨兵 / 无到期计入 / 空→null");
}

// ===== ③ store 包集整体替换（Q2） =====
{
  const T = Date.now();
  const id = store.addAccount({ channel: "trae", uid: "u-pkg", name: "包测账号", token: "tk", refreshToken: "", source: "paste" });
  assert.deepStrictEqual(store.listCreditPackages(id), [], "③ 新账号包集应为空");

  store.setCreditPackages(id, "trae", [
    { code: "b", name: "包B", total: 200, used: 50, remaining: 150, expiresAt: T + 5 * DAY, ord: 1 },
    { code: "a", name: "包A", total: 100, used: 10, remaining: 90, expiresAt: T + 2 * DAY, ord: 0 },
    { code: "u", name: "不限包", total: -1, used: 0, remaining: -1, expiresAt: 0, ord: 2 },
    { code: "neg", name: "脏值包", total: -5, used: -3, remaining: -9, expiresAt: 0, ord: 3 },
  ]);
  const list = store.listCreditPackages(id);
  assert.strictEqual(list.length, 4, "③ 应落 4 个包");
  assert.deepStrictEqual(list.map((p) => p.code), ["a", "b", "u", "neg"], "③ 应按 ord 升序");
  assert.strictEqual(list[2].remaining, -1, "③ -1 不限哨兵应保留");
  assert.strictEqual(list[2].total, -1, "③ -1 总额哨兵应保留");
  assert.strictEqual(list[3].remaining, 0, "③ 小于 -1 的负值应归 0");
  assert.strictEqual(list[3].total, 0, "③ 负总额应归 0");

  // 整体替换：换一个更小的集合，旧包必须全部消失（不是 upsert 叠加）
  store.setCreditPackages(id, "trae", [{ code: "only", name: "唯一包", total: 10, used: 1, remaining: 9, expiresAt: T + DAY }]);
  const list2 = store.listCreditPackages(id);
  assert.strictEqual(list2.length, 1, "③ 整体替换后只剩新集合（不残留旧包）");
  assert.strictEqual(list2[0].code, "only", "③ 新集合内容正确");

  // 传空数组 = 清空
  store.setCreditPackages(id, "trae", []);
  assert.deepStrictEqual(store.listCreditPackages(id), [], "③ 传空数组应清空包集");

  // 删号必须连带清包（防孤儿行）
  store.setCreditPackages(id, "trae", [{ code: "x", name: "x", total: 1, used: 0, remaining: 1, expiresAt: 0 }]);
  store.removeAccount(id);
  assert.deepStrictEqual(store.listCreditPackages(id), [], "③ 删号后包集应被清除");
  pass("③ store 整体替换：ord 排序 / -1 保留 / 负值归 0 / 换集不残留 / 空清空 / 删号清包");
}

// ===== ④ 静态接线核查（不联网、不开真库网关） =====
{
  const read = (f) => fs.readFileSync(path.join(ROOT, "electron", "backend", "proxy", f), "utf8");
  const schema = read("store.cjs");
  assert.ok(/CREATE TABLE IF NOT EXISTS credit_packages/.test(schema), "④ store.cjs 必须建 credit_packages 表");

  const cred = read("credits.cjs");
  assert.ok(/setCreditPackages/.test(cred) && /deriveAccountCredits/.test(cred),
    "④ credits.cjs 刷新链路必须落包集并用 deriveAccountCredits 派生（否则包集不写/聚合不同源）");

  const psync = read("poolsync.cjs");
  assert.ok(/listCreditPackages/.test(psync), "④ poolsync 导出必须带包集");
  const setCount = (psync.match(/setCreditPackages/g) || []).length;
  assert.ok(setCount >= 2, `④ poolsync 合并必须在「新增」和「LWW 更新」两条分支都整体替换包集（实测 ${setCount} 处）`);

  const idx = read("index.cjs");
  assert.ok(/listCreditPackages/.test(idx) && /setExpiringSoonDays/.test(idx),
    "④ index.cjs poolView 必须附包集，且按 expiringSoonDays 灌阈值");
  pass(`④ 静态接线：schema 建表 / credits 派生落库 / poolsync 双分支替换（${setCount} 处）/ index 附包集+阈值`);
}

store.close();
try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* */ }
console.log(`\nOK 积分包到期特性闸全过（${n} 项）：① 到期归一、② 包集派生、③ 整体替换、④ 接线`);
