// 积分日历页行过滤/排序闸：钉住「默认隐藏已用完」「-1 不限不被当 0」「过期行不被误删」。
//
// 起因（2026-09-29）：用户反馈 0/100 这类已用完的包仍占着列表，且显示「剩 176 天」是纯噪音；
// 这类缺陷 vue-tsc 与原有 node 门禁全看不见——过滤逻辑写在 computed 里，只有运行时才算得出来。
// 所以把过滤/排序抽到 src/views/proxy/expiryRows.ts（纯函数），本脚本转译后直接断言。
//
// 跑法：node scripts/dev-expiry-rows-test.cjs
"use strict";
if (require.main !== module) return;

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const ROOT = path.resolve(__dirname, "..");
const TS = "src/views/proxy/expiryRows.ts";
const VIEW = "src/views/proxy/ProxyExpiryView.vue";

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? `：${detail}` : "")); console.log(`FAIL  ${name}${detail ? `：${detail}` : ""}`); }
}

/** 转译 TS 纯函数模块后 require（类型导入被 esbuild 抹掉，不会触发运行时 require） */
function loadModule(rel) {
  const { code } = esbuild.transformSync(fs.readFileSync(path.join(ROOT, rel), "utf8"), { loader: "ts", format: "cjs" });
  const tmp = path.join(os.tmpdir(), `expiry-rows-${process.pid}.cjs`);
  fs.writeFileSync(tmp, code);
  try {
    return require(tmp);
  } finally {
    fs.unlinkSync(tmp);
  }
}

const DAY = 86400000;
const NOW = Date.now();
const FUTURE = NOW + 30 * DAY;
const PAST = NOW - DAY;

/** 造行：pkg 字段全部显式给，避免「漏字段」把断言喂成假绿 */
function row(channelId, display, account, pkg) {
  return { key: `${channelId}:${account}:${pkg.code}`, channelId, channelDisplay: display, accountName: account, pkg };
}
function pkg(code, remaining, total, expiresAt, extra = {}) {
  return { code, name: code, total, used: total - remaining, remaining, expiresAt, ...extra };
}

const ROWS = [
  // 生效中且有余额
  row("workbuddy_ai", "WorkBuddy AI", "peakjjbb", pkg("a", 100, 100, FUTURE)),
  // 已用完（剩余 0）——默认档必须滤掉
  row("workbuddy_ai", "WorkBuddy AI", "peakjjbb", pkg("b", 0, 100, FUTURE)),
  // 生效中、有余额（截图里的 99/500）
  row("workbuddy_ai", "WorkBuddy AI", "codejjbb", pkg("c", 99, 500, FUTURE)),
  // 已过期且剩余 0 —— 也滤掉（与「剩余 0 隐藏」一致）
  row("trae", "Trae SOLO CN", "t1", pkg("d", 0, 5, PAST, { expired: true })),
  // 不限额度（-1 哨兵）+ 长期有效 —— 绝不能当 0 滤掉
  row("trae", "Trae SOLO CN", "t1", pkg("e", -1, -1, 0)),
  // 已过期但仍有余额 —— 用户要保留过期行，这条必须在默认档里活下来
  row("workbuddy", "WorkBuddy CN", "w1", pkg("f", 2, 5, PAST, { expired: true })),
];
const ROWS_BY = (out) => out.map((r) => r.pkg.code).join(",");

function main() {
  const m = loadModule(TS);
  const { applyExpiryFilter, isUsedUp, statusOf, countByState, STATUS_OPTIONS, SORT_OPTIONS } = m;
  const filter = (o) => applyExpiryFilter(ROWS, { status: "usable", channelId: "all", sort: "expiryAsc", ...o });

  // ===== A. 哨兵与状态归类 =====
  check("① 剩余 0 = 已用完；剩余 -1（不限）不算已用完", isUsedUp(ROWS[1].pkg) && !isUsedUp(ROWS[4].pkg) && !isUsedUp(ROWS[5].pkg));
  check("② 状态归类：0/100 → 已用完", statusOf(ROWS[1].pkg) === "used");
  check("③ 过期优先于用完：过期且 0 余额 → 已过期（不是已用完）", statusOf(ROWS[3].pkg) === "expired");
  check("④ 不限 + 长期有效 → 生效中", statusOf(ROWS[4].pkg) === "ok");
  check("⑤ 四态计数与总数对得上", (() => {
    const c = countByState(ROWS);
    return c.expired === 2 && c.used === 1 && c.ok === 3 && c.soon === 0 && c.total === 6;
  })(), JSON.stringify(countByState(ROWS)));

  // ===== B. 默认档「有余额」：这正是用户要的「隐藏已用完」 =====
  const usable = filter({});
  check("⑥ 默认档滤掉 0/100 与过期 0/5（实得 " + ROWS_BY(usable) + "）", ROWS_BY(usable) === "f,a,c,e", ROWS_BY(usable));
  check("⑦ 默认档保留 -1 不限与 99/500", usable.some((r) => r.pkg.code === "e") && usable.some((r) => r.pkg.code === "c"));
  check("⑧ 默认档保留「已过期但仍有余额」的行（过期行不是用完行）", usable.some((r) => r.pkg.code === "f"));
  // 反向对照：不是恒等过滤 —— 切「全部」必须比默认档多，否则本闸自己就是空转
  const all = filter({ status: "all" });
  check(`⑨ 反向对照：全部 ${all.length} 行 > 默认档 ${usable.length} 行（证明过滤真的生效）`, all.length === 6 && usable.length === 4);

  // ===== C. 其余筛选档 =====
  check("⑩ 已用完档只留 0/100", ROWS_BY(filter({ status: "used" })) === "b");
  check("⑪ 已过期档留两条过期行（含仍有余额的 f）", ROWS_BY(filter({ status: "expired" })) === "f,d");
  check("⑫ 渠道过滤：trae 只剩 d/e", ROWS_BY(filter({ status: "all", channelId: "trae" })) === "d,e");
  check("⑬ 组合：已过期 + trae 只剩 d", ROWS_BY(filter({ status: "expired", channelId: "trae" })) === "d");
  check("⑭ 无匹配返回空数组（不是 null）", Array.isArray(filter({ status: "soon" })) && filter({ status: "soon" }).length === 0);

  // ===== D. 排序（用全量 6 行：f/d 同过期、a/c/b 同到期、e 长期，能同时验两个关键字） =====
  // 同关键字一律按剩余降序，所以 f(2) 在 d(0) 前、a(100) 在 c(99) 在 b(0) 前
  check("⑮ 到期升序：过期行最前，长期（0）排最后（实得 " + ROWS_BY(filter({ status: "all" })) + "）",
    ROWS_BY(filter({ status: "all" })) === "f,d,a,c,b,e");
  check("⑯ 到期降序：长期排最前，同到期仍按剩余降序（实得 " + ROWS_BY(filter({ status: "all", sort: "expiryDesc" })) + "）",
    ROWS_BY(filter({ status: "all", sort: "expiryDesc" })) === "e,a,c,b,f,d");
  check("⑰ 剩余降序：-1（不限）视为最大排最前，同剩余按到期升序（实得 " + ROWS_BY(filter({ status: "all", sort: "remainDesc" })) + "）",
    ROWS_BY(filter({ status: "all", sort: "remainDesc" })) === "e,a,c,f,d,b");
  check("⑱ 剩余升序：-1 排最后（实得 " + ROWS_BY(filter({ status: "all", sort: "remainAsc" })) + "）",
    ROWS_BY(filter({ status: "all", sort: "remainAsc" })) === "d,b,f,c,a,e");

  // ===== E. 源码接线钉：纯函数对了但模板没接上也白搭 =====
  const view = fs.readFileSync(path.join(ROOT, VIEW), "utf8");
  check("⑲ 默认档钉在 usable", /const statusFilter = ref<ExpiryStatusFilter>\("usable"\)/.test(view));
  check("⑳ 模板遍历的是过滤后的 rows，不是全量 allRows", /v-for="r in rows"/.test(view) && !/v-for="r in allRows"/.test(view));
  check("㉑ 下拉选项来自纯函数模块（不是视图里另抄一份）",
    /STATUS_OPTIONS/.test(view) && /SORT_OPTIONS/.test(view) && STATUS_OPTIONS.length === 6 && SORT_OPTIONS.length === 4);

  // ===== F. 侧栏「渠道额度」卡片的死渠道隐藏（判据同样在运行时才算得出来） =====
  const sidebar = fs.readFileSync(path.join(ROOT, "src/components/Sidebar.vue"), "utf8");
  check("㉒ 侧栏隐藏判据是「已过期 且 余额为 0」——不能只按 expired 标签（那是 some 语义，会连带藏掉仍有可用号的渠道）",
    /!\(c\.summary\.expired && c\.summary\.totalCredits === 0\)/.test(sidebar));
  check("㉓ 侧栏列表遍历 visibleChannels，且空态也认可见集合",
    /v-for="c in visibleChannels"/.test(sidebar) && !/v-for="c in channels"/.test(sidebar) && /v-if="!visibleChannels\.length"/.test(sidebar));

  console.log(`\n${failures.length ? "FAIL " + failures.length + " 项" : "OK 积分日历行过滤闸全过"}（共 ${pass + failures.length} 项）`);
  if (failures.length) process.exit(1);
}

try { main(); } catch (e) { console.error("闸自身异常:", e); process.exit(1); }
