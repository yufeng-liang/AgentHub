// 号池账号表结构闸：钉住「一个账号只渲染一行」以及「四样功能必须落在同一套行里」。
//
// 起因（2026-09-29 合并上游 v1.33–v1.37 时查明）：上一次合并（1ec061f）在同一个 <tbody> 里
// 留下了两套账号行 —— fork 侧 42b465c/a8af69f 那套带积分包展开，上游 0607225 那套带过码与
// 领取模式。两套一个无条件、一个挂在 v-else 里，账号非空时同时成立 ⇒ 每个号渲染两行。
// 文本零冲突、vue-tsc 零报错、原有 26 项 node 门禁全看不见它，因为缺陷只存在于运行时 DOM。
//
// 判据落在「真实渲染出来的行」上：把号池那张 <tbody> 单独编译并 SSR 渲染。
// 只数**顶层** <tr>/<td> —— 积分包展开行里内嵌着第二张表，混进来会把计数带偏（首版就栽在这）。
// 跑法：node scripts/dev-pool-rows-test.cjs
"use strict";
if (require.main !== module) return;

const fs = require("node:fs");
const path = require("node:path");
const sfc = require("@vue/compiler-sfc");
const cd = require("@vue/compiler-dom");
const Vue = require("vue");
const { renderToString } = require("@vue/server-renderer");

const ROOT = path.resolve(__dirname, "..");
const FILE = "src/views/proxy/ProxyAgentsView.vue";

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? `：${detail}` : "")); console.log(`FAIL  ${name}${detail ? `：${detail}` : ""}`); }
}

/** 按标签深度切出顶层 <tr>（内嵌 pkg 表的 tr 不进结果）；顺带给出每行的顶层 <td> 数。 */
function topLevelRows(html) {
  const re = /<(\/?)(tr|table|td)\b/g;
  const out = [];
  let depth = 0, tdDepth = 0, cur = null, start = 0;
  for (let m; (m = re.exec(html));) {
    const [, close, tag] = m;
    if (tag === "tr") {
      if (!close) { if (depth === 0) { cur = []; start = re.lastIndex; } depth++; }
      else { depth--; if (depth === 0 && cur) { out.push({ inner: html.slice(start, m.index), tds: cur.length }); cur = null; } }
    } else if (tag === "table") {
      if (!close) tdDepth++; else tdDepth--;
    } else if (tag === "td" && tdDepth === 0 && cur) {
      if (!close) cur.push(1);
    }
  }
  return out;
}

/** 切出号池那张 <tbody>（含 ch.accounts 的那个）并编译成 render 函数。
 *  作用域只喂表格自己用到的变量，工具栏等表外内容不进判据。 */
function poolTbodyRender() {
  const { descriptor, errors } = sfc.parse(fs.readFileSync(path.join(ROOT, FILE), "utf8"), { filename: FILE });
  if (errors.length) throw new Error("SFC 解析失败: " + errors[0].message);
  const tbs = [];
  (function walk(n) {
    if (n.type === 1 && n.tag === "tbody") tbs.push(n);
    (n.children || []).forEach(walk);
  })(cd.parse(descriptor.template.content));
  const tb = tbs.find((t) => t.loc.source.includes("ch.accounts"));
  if (!tb) throw new Error("找不到遍历 ch.accounts 的 <tbody>：号池表格被改名或拆走了");
  const res = cd.compile(descriptor.template.content.slice(tb.loc.start.offset, tb.loc.end.offset), { mode: "function", hoistStatic: false });
  if (res.errors && res.errors.length) throw new Error("tbody 片段编译失败: " + res.errors[0].message);
  return new Function("Vue", res.code + "\nreturn render")(Vue);
}

function buildCtx({ n, channel, builtin, expanded = [], withPackages = true }) {
  const noop = () => {};
  const acc = (i) => ({
    id: "a" + i, name: "账号" + i, uid: "uid" + i, channel, source: "oauth",
    status: "online", credits: 100, creditsToday: 5, todayReq: 3, todayTokens: 900,
    hasToken: true, liveHere: i === 1, lastError: "", expiresAt: Date.now() + 86400000,
    // 不展开时给包：验证「有积分包但没点开展开」不会凭空多出行
    packages: withPackages ? [{ id: "p1", code: "c1", name: "包" + i, used: 1, total: 10, remaining: 9, expiresAt: Date.now() + 86400000 * 3 }] : [],
  });
  return {
    ch: { id: channel, display: "X", kind: builtin ? "builtin" : "openai_compat", accounts: Array.from({ length: n }, (_, i) => acc(i + 1)) },
    isBuiltin: () => builtin,
    // 与组件里的 CHECKIN_CAPABLE 同口径：这四家有每日签到，qoder / cline / autoclaw 没有
    checkinCapable: (id) => ["workbuddy", "workbuddy_ai", "raccoon", "trae"].includes(id),
    ideSupported: () => true, ideTitle: () => "", channelName: () => "X",
    // 余额浮层（el-tooltip 用）：真值只在 zcode 家非空，行/列计数与它无关，给个同名桩让绑定不炸
    creditTip: () => "",
    expandedIds: new Set(expanded), SOURCE_NAMES: { oauth: "OAuth" },
    ACCOUNT_STATUS: { online: { text: "在线", cls: "tag-ok" } },
    fmtInt: String, fmtK: String, fmtBalance: String, fmtDate: () => "2026-09-29", uidBrief: (u) => u,
    // 计费单位三件套（2026-09-30 逐渠道适配进模板）：桩只求绑定不炸，结构判据与文案无关
    balanceUnit: () => "积分", isTokenChannel: () => false, pkgFallbackName: () => "积分包",
    coolLeft: () => 0, modelCoolLeft: () => 0, modelCoolTitle: () => "", isNeedCaptcha: () => false,
    pkgUsedPct: () => 10, pkgDaysText: () => "3天", pkgStatusCls: () => "tag-ok", pkgStatusText: () => "正常",
    renamingId: "", renameText: "", checkinBusy: false, refreshingId: "", ideSwitching: "", coolOffId: "",
    solvingCaptchaId: "", delOpen: false, delRow: null, uidRow: null, errRow: null,
    togglePkg: noop, startRename: noop, commitRename: noop, refreshOne: noop, runCheckinAccount: noop,
    ideSwitch: noop, releaseCool: noop, toggleAccount: noop, runSolveCaptcha: noop, enterClaimMode: noop,
  };
}

async function render(opts) {
  const app = Vue.createSSRApp({ render: poolTbodyRender() });
  Object.assign(app.config.globalProperties, buildCtx(opts));
  app.config.warnHandler = () => {};            // 表格用到的其它变量走 undefined 即可，噪声不入库
  const html = await renderToString(app);
  return { html, rows: topLevelRows(html) };
}

const isAccountRow = (r) => /账号\d/.test(r.inner);

async function main() {
  const n = 3;
  // ===== A. 行数与列数：不展开积分包时，顶层行必须恰是 1 表头 + N 账号行 =====
  const { html, rows } = await render({ n, channel: "workbuddy", builtin: true });
  const acct = rows.filter(isAccountRow);
  check(`① ${n} 个账号只渲染 ${n} 个账号行（实得 ${acct.length}）`, acct.length === n,
    acct.length === 2 * n ? `每个账号两行 ⇒ 同一个 <tbody> 里留了两套账号行（合并上游时两侧各被当成新增保留）` : `期望 ${n} 实得 ${acct.length}`);
  check(`② 顶层行总数 = 表头 + 账号行 = ${1 + n}（实得 ${rows.length}）`, rows.length === 1 + n);

  // 逐账号数「有几个顶层行提到它」——① 只看总数，这条防「少渲染 A 多渲染 B」这种总数对但分布错。
  // 不能拿全文出现次数判：账号名同时出现在显示文本和 title 里，一行就两次。
  const dup = [];
  for (let i = 1; i <= n; i++) {
    const hits = acct.filter((r) => r.inner.includes("账号" + i)).length;
    if (hits !== 1) dup.push("账号" + i + "×" + hits);
  }
  check(`③ 每个账号恰好占一个账号行（异常：${dup.join(",") || "无"}）`, dup.length === 0);

  const headCols = rows[0].tds === 0 ? (rows[0].inner.match(/<th/g) || []).length : 0;
  const bodyCols = [...new Set(acct.map((r) => r.tds))];
  check(`④ 内置渠道表头 ${headCols} 列 ⇒ 每个账号行也 ${headCols} 列（实得 ${bodyCols.join("/")}）`,
    headCols > 0 && bodyCols.length === 1 && bodyCols[0] === headCols, "行与表头列数不一致会整表错位");

  // ===== B. 四样功能必须在「同一套行」里全都在 —— 专防「删一套留另一套」砍掉一半 =====
  // 过码 / 领取模式是 zcode 渠道专属，所以这一组必须用 zcode 渲染来找
  const z = await render({ n: 1, channel: "zcode", builtin: true, expanded: ["a1"] });
  const zrow = z.rows.find(isAccountRow);
  check("⑤ 积分包展开在（fork 42b465c + a8af69f 的到期明细）", /pkg-caret/.test(z.html) && /pkg-cell/.test(z.html));
  check("⑥ 过码入口在（fork ZCode 阿里云人机校验）", /人机校验/.test(zrow ? zrow.inner : ""));
  check("⑦ 领取模式在（上游 v1.36 指纹借出人工链路）", /临时借出为该账号专属指纹/.test(zrow ? zrow.inner : ""));
  check("⑧ 本机登录标记在（上游 v1.31 的 acc.liveHere）", /本机登录/.test(zrow ? zrow.inner : ""));
  check("⑨ 展开一个账号只多一行明细（顶层行 = 表头 + 1 账号 + 1 明细）", z.rows.length === 3, `实得 ${z.rows.length}`);

  // ===== C. 门禁类：不该出现的按钮不能出现 =====
  const p = await render({ n: 2, channel: "my-proxy", builtin: false });
  const pHead = (p.rows[0].inner.match(/<th/g) || []).length;
  const pBody = [...new Set(p.rows.filter(isAccountRow).map((r) => r.tds))];
  check(`⑩ 提供商表头 ${pHead} 列 ⇒ 每个 Key 行也 ${pHead} 列（实得 ${pBody.join("/")}）`,
    pBody.length === 1 && pBody[0] === pHead, "自建提供商没有余额/到期概念，多出的列会让整表错位");
  check("⑪ 提供商行不摆「签到」（fork 的 checkinCapable 门禁）", !/签到/.test(p.html));
  const q = await render({ n: 1, channel: "qoder", builtin: true });
  check("⑫ 无签到能力的内置渠道（qoder）也不摆「签到」", !/签到/.test(q.html));

  console.log(`\n${failures.length ? "FAIL " + failures.length + " 项" : "OK 号池表格结构闸全过"}（共 ${pass + failures.length} 项）`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error("闸自身异常:", e.message); process.exit(1); });
