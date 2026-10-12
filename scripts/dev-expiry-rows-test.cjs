// 积分日历页行过滤/排序闸：钉住「默认隐藏已用完」「-1 不限不被当 0」「过期行不被误删」。
//
// 起因（2026-09-29）：用户反馈 0/100 这类已用完的包仍占着列表，且显示「剩 176 天」是纯噪音；
// 这类缺陷 vue-tsc 与原有 node 门禁全看不见——过滤逻辑写在 computed 里，只有运行时才算得出来。
// 所以把过滤/排序抽到 src/views/proxy/expiryRows.ts（纯函数），本脚本转译后直接断言。
//
// 2026-10-12 起还钉住三件事（都是同一页的产品口径，写错不会编译失败也不会测试失败）：
//   G/H 过期满 STALE_EXPIRED_DAYS 天的行退出默认档、且只在「历史过期积分」档回来（收起≠删除）；
//   I   上游不拆包的渠道按账号出聚合行（从未刷过额度的账号不得混进来）；
//   J   total=-1 是「上游不给总额」不是「不限」——两者混同会把 1,880 积分写成「1,880 / 不限」。
// 本闸加载两份 TS 模块（expiryRows 与 format），加载器必须 bundle 且每次换临时文件名。
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

/** 转译并加载 TS 纯函数模块（类型导入被 esbuild 抹掉，不会触发运行时 require）。
 *  必须 bundle 而不是 transform：src/views/proxy/format.ts 转出 `export { fmtCtx } from
 *  "../../utils/format"`，裸 transform 会把这条相对依赖原样留在产物里，从临时目录 require 必炸。
 *  临时文件名必须每次唯一：require 按路径缓存，复用同一个路径会让第二次加载直接拿到第一个模块
 *  （本闸加载 expiryRows 与 format 两份，写死路径时 format 的导出会静默变成 expiryRows 的） */
let loadSeq = 0;
function loadModule(rel) {
  const { outputFiles: [{ text: code }] } = esbuild.buildSync({
    entryPoints: [path.join(ROOT, rel)],
    bundle: true,
    format: "cjs",
    platform: "node",
    target: "node18",
    write: false,
  });
  const tmp = path.join(os.tmpdir(), `expiry-rows-${process.pid}-${loadSeq++}.cjs`);
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
  const {
    applyExpiryFilter, isUsedUp, statusOf, countByState, STATUS_OPTIONS, SORT_OPTIONS,
    isStaleExpired, expiredDays, STALE_EXPIRED_DAYS, aggregateRow, AGGREGATE_PKG_NAME,
  } = m;
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

  // ===== G. 过期满 2 天自动收起（2026-10-12：日历被过期好几天的包刷屏） =====
  // 独立夹具：上面 6 行的过期时刻是 1 天前，正好落在「保留」侧，所以本节的边界样本不能混进去。
  // 本节判据是**成员集合**（顺序另有 ⑮–⑱ 钉），免得把排序算进收起规则的断言里互相掩盖。
  const SET = (out) => out.map((r) => r.pkg.code).sort().join(",");
  const T = Date.now();
  const stale = (code, agoMs, over = {}) => row("trae", "Trae SOLO CN", "t1", pkg(code, 5, 10, T - agoMs, { expired: true, ...over }));
  const STALE = [
    stale("k0", DAY - 60000), // 过期 1 天差 1 分钟 → 留
    stale("k1", 2 * DAY - 60000), // 过期 1天23h59m → 留（差 1 分钟才满 2 天）
    stale("k2", 2 * DAY), // 正好满 2 天 → 收起（阈值含 2）
    stale("k3", 30 * DAY), // 过期一个月 → 收起
    row("trae", "Trae SOLO CN", "t1", pkg("k4", 5, 10, T + 5 * DAY, { expiringSoon: true })), // 未过期 → 留
    stale("k5", 10 * DAY, { remaining: 0 }), // 陈旧过期且已用完 → 收起
    row("trae", "Trae SOLO CN", "t1", pkg("k6", 5, 10, 0)), // 长期有效 → 永不算陈旧
  ];
  const sflt = (o) => applyExpiryFilter(STALE, { status: "all", channelId: "all", sort: "expiryAsc", ...o }, T);
  check("G1 默认「全部」档收起过期满 2 天的 k2/k3/k5，保留 k0/k1/k4/k6（实得 " + SET(sflt({})) + "）",
    SET(sflt({})) === "k0,k1,k4,k6", SET(sflt({})));
  check("G2 阈值含 2 天：差 1 分钟满 2 天的 k1 必须还在，正好 2 天的 k2 必须收起",
    sflt({}).some((r) => r.pkg.code === "k1") && !sflt({}).some((r) => r.pkg.code === "k2"));
  check("G3 切到「已过期」档也不召回陈旧的包（那是同一批行，收起规则先于状态档）",
    SET(sflt({ status: "expired" })) === "k0,k1", SET(sflt({ status: "expired" })));
  check("G4 长期有效（expiresAt=0）永不算陈旧过期", isStaleExpired(pkg("x", 5, 10, 0), T) === false);
  check("G5 expiredDays 按整天向下取整：满 2 天报 2、1 天零 1 小时报 1、不足 1 天报 0、未过期报 -1",
    expiredDays(pkg("a", 5, 10, T - 2 * DAY), T) === 2 &&
      expiredDays(pkg("b", 5, 10, T - DAY - 3600000), T) === 1 &&
      expiredDays(pkg("c", 5, 10, T - 60000), T) === 0 &&
      expiredDays(pkg("d", 5, 10, T + DAY), T) === -1);
  check("G6 STALE_EXPIRED_DAYS 就是 2（文案与判据共用同一个常量，改阈值必须同步改口径）", STALE_EXPIRED_DAYS === 2);

  // ===== H. 历史过期档：把收起的行全部放回来，一条都不丢 =====
  const hflt = (o) => applyExpiryFilter(STALE, { status: "all", channelId: "all", sort: "expiryAsc", history: true, ...o }, T);
  check("H1 历史档 = 全部已过期（含收起的 k2/k3/k5），且不含未过期的 k4/k6（实得 " + SET(hflt({})) + "）",
    SET(hflt({})) === "k0,k1,k2,k3,k5", SET(hflt({})));
  check("H2 反向对照：两档并集覆盖夹具全集（收起不等于删除），且默认档收起的正是 k2/k3/k5",
    new Set([...sflt({}), ...hflt({})].map((r) => r.pkg.code)).size === STALE.length &&
      SET(STALE.filter((r) => !sflt({}).includes(r))) === "k2,k3,k5",
    SET(STALE.filter((r) => !sflt({}).includes(r))));
  check("H3 历史档下 status 维度让位：切成「生效中」也照样只出已过期行",
    SET(hflt({ status: "ok" })) === "k0,k1,k2,k3,k5", SET(hflt({ status: "ok" })));
  check("H4 历史档仍认渠道筛选",
    ROWS_BY(applyExpiryFilter(STALE, { status: "all", channelId: "workbuddy", sort: "expiryAsc", history: true }, T)) === "");
  check("H5 已用完但过期满 2 天的包只在历史档可见（默认档收不起，历史档不丢）",
    !sflt({}).some((r) => r.pkg.code === "k5") && hflt({}).some((r) => r.pkg.code === "k5"));

  // ===== I. 账号级聚合行：上游不拆包的渠道也要能进日历 =====
  const acc = (over) => ({ id: "x1", name: "账号甲", credits: 1880, creditsAt: T - 1000, expiresAt: T + 40 * DAY, ...over });
  const agg = aggregateRow("catpaw", "CatPaw（美团）", acc({}));
  check("I1 聚合行落在 total=-1（上游不给总额）+ aggregate 标记，包名与逐包行区分得开",
    !!agg && agg.aggregate === true && agg.pkg.total === -1 && agg.pkg.remaining === 1880 && agg.pkg.name === AGGREGATE_PKG_NAME);
  check("I2 从未刷过额度的账号（creditsAt=0）不出聚合行——那时 credits/expiresAt 都是建号默认值",
    aggregateRow("catpaw", "CatPaw（美团）", acc({ creditsAt: 0 })) === null);
  check("I3 余额非数值不出聚合行", aggregateRow("catpaw", "CatPaw（美团）", acc({ credits: NaN })) === null);
  check("I4 无到期时间的账号仍出聚合行（落 0 → 显示「长期」），不因缺到期就被丢掉",
    (() => {
      const r = aggregateRow("lobster", "LobsterAI（有道）", acc({ expiresAt: 0 }));
      return !!r && r.pkg.expiresAt === 0 && statusOf(r.pkg) === "ok";
    })());
  check("I5 聚合行的 key 与逐包行不撞（同一账号既可能走包集也可能走聚合）", agg.key === "x1:agg");
  check("I6 未命名账号回落占位名", aggregateRow("catpaw", "CatPaw（美团）", acc({ name: "" })).accountName === "（未命名）");

  // ===== J. 「剩余 / 总额」单元格：不给总额 ≠ 不限 =====
  const fmt = loadModule("src/views/proxy/format.ts");
  const { fmtBalancePair } = fmt;
  check("J1 上游不给总额（total=-1 且剩余有数值）渲染成「—」，绝不能渲染成「1,880 / 不限」",
    fmtBalancePair(1880, -1, "lobster") === "1,880 / — 积分", fmtBalancePair(1880, -1, "lobster"));
  check("J2 两头都是 -1 才是真·不限，且不缀单位", fmtBalancePair(-1, -1, "catpaw") === "不限 / 不限", fmtBalancePair(-1, -1, "catpaw"));
  check("J3 正常逐包行口径不变（Token 渠道过 fmtToken 换算）",
    fmtBalancePair(3000000, 3000000, "zcode") === "3 百万 / 3 百万 Token", fmtBalancePair(3000000, 3000000, "zcode"));
  check("J4 剩余不限、总额有数值时照实并列", fmtBalancePair(-1, 500, "trae") === "不限 / 500 积分", fmtBalancePair(-1, 500, "trae"));

  // ===== K. 新增行为的源码接线钉（纯函数对了但视图没接上一样白搭） =====
  check("K1 视图把 historyOpen 灌进过滤器（否则按钮只是个装饰）",
    /history:\s*historyOpen\.value/.test(view));
  check("K2 视图遍历聚合行：packages 为空时才走 aggregateRow，两者互斥所以不会重复计数",
    /aggregateRow\(/.test(view) && /packs\.length/.test(view));
  check("K3 总额单元格走 fmtBalancePair（回退成两个 fmtBalance 拼接会把「—」写成「不限」）",
    /fmtBalancePair\(/.test(view) && !/fmtBalance\(r\.pkg\.total/.test(view));
  check("K4 过期行报的是「过期 N 天」而不是光秃秃的「已过期」（用户要的就是知道过期多久）",
    /过期 \$\{gone\} 天|过期 \$\{gone\}天/.test(view));
  check("K5 收起条数的提示走 staleHidden，且阈值取自常量而不是写死 2",
    /staleHidden/.test(view) && /STALE_EXPIRED_DAYS/.test(view));
  check("K6 历史档下 status 下拉被换成说明标签，不是留一个点不动的下拉",
    /v-if="historyOpen"[\s\S]{0,80}hist-chip/.test(view) && /v-else v-model="statusFilter"/.test(view));
  check("K7 按钮文案就是「历史过期积分」，不带条数（条数归「已过期」徽标与「N 条已收起」提示，别三处各摆一份）",
    /: "历史过期积分"/.test(view) && !/历史过期积分 \$\{/.test(view));

  console.log(`\n${failures.length ? "FAIL " + failures.length + " 项" : "OK 积分日历行过滤闸全过"}（共 ${pass + failures.length} 项）`);
  if (failures.length) process.exit(1);
}

try { main(); } catch (e) { console.error("闸自身异常:", e); process.exit(1); }
