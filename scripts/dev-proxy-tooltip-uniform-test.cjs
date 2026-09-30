// 反代网关提示浮层统一闸（2026-09-29 整页移植上游 v1.38.0 的 el-tooltip 之后补的）。
//
// 为什么需要它：上游自己那几页仍是原生 :title，下次合并会把原生 title 重新带进同一页 ⇒
// 同一张表里飘两种浮层。这类「合得干净但观感已破」判据不在构建里，也不在按行数的那道闸里，
// 所以钉在这里。骨架屏同理：fork 把实时流抽成了 RequestLogTable.vue，上游的骨架长在它自己的
// 内联表上，不钉住就没人知道它搬过家。
//
// 判据面：① 原生 title 归零 ② 代表性提示确实以 content= 形式存在（防「删掉浮层留个光按钮」）
// ③ el-tooltip 的首个子节点不得带 v-if/v-else（那会让触发器变成空 slot）
// ④ 可空 content 必须配 :disabled（原生 title 给空串是不显示，el-tooltip 给空串会飘出空玻璃泡）
// ⑤ 骨架屏与空态互斥、格数等于列数
// 跑法：node scripts/dev-proxy-tooltip-uniform-test.cjs
"use strict";
if (require.main !== module) return;

const fs = require("node:fs");
const path = require("node:path");
const sfc = require("@vue/compiler-sfc");
const cd = require("@vue/compiler-dom");
const Vue = require("vue");
const { renderToString } = require("@vue/server-renderer");

const ROOT = path.resolve(__dirname, "..");
const DIR = "src/views/proxy";

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? `：${detail}` : "")); console.log(`FAIL  ${name}${detail ? `：${detail}` : ""}`); }
}

const files = fs.readdirSync(path.join(ROOT, DIR)).filter((f) => f.endsWith(".vue")).sort();
const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(ROOT, DIR, f), "utf8")]));

/** 取模板正文：script 里的字符串常量不该算进浮层判据（例如 steps 的 title 字段） */
function templateOf(name) {
  const { descriptor, errors } = sfc.parse(src[name], { filename: name });
  if (errors.length) throw new Error(`${name} SFC 解析失败: ${errors[0].message}`);
  return descriptor.template.content;
}

// ===== 共用取数：逐个 <el-tooltip 开标签 =====
/** 扫出所有 el-tooltip 的【开标签文本】与【标签结束后的位置】。
 *  必须认引号：`v-if="r.attempts > 1"` 这种属性值里的 `>` 不是标签结束（第一版就栽在这，
 *  判据把带比较号的浮层整条截断，看起来像「提示不见了」）。 */
function tooltips(tpl) {
  const out = [];
  let i = 0;
  while ((i = tpl.indexOf("<el-tooltip", i)) !== -1) {
    let j = i + "<el-tooltip".length;
    let q = null;
    for (; j < tpl.length; j++) {
      const ch = tpl[j];
      if (q) { if (ch === q) q = null; continue; }
      if (ch === '"' || ch === "'") { q = ch; continue; }
      if (ch === ">") break;
    }
    out.push({ attrs: tpl.slice(i + "<el-tooltip".length, j), after: j + 1 });
    i = j + 1;
  }
  return out;
}
/** 开标签里的 :content / content 表达式 */
function contentOf(attrs) {
  const m = /[\s]:?content\s*=\s*"([\s\S]*?)"/.exec(attrs);
  return m ? m[1] : null;
}
/** 紧跟在 <el-tooltip ...> 之后的触发元素候选：第一个真实子标签；
 *  若它是个**没有任何属性的裸 span/div**（只为承接 hover 而存在的那层），再往下看一层——
 *  条件写在那层里面的按钮上时，裸壳会空掉、浮层同样不可达（变异对照 M3 逼出来的形状）。
 *  再深就不追了：<button><i v-if="ok"/></button> 里的 v-if 是装饰，不是缺陷。 */
function triggerCandidates(tpl, after) {
  const out = [];
  const rest = tpl.slice(after);
  const TAG = /^[\s]*(?:<!--[\s\S]*?-->[\s]*)?<([a-zA-Z][\w-]*)\b([^>]*)>/;
  const c = TAG.exec(rest);
  if (!c) return out;
  out.push({ tag: c[1], attrs: c[2] });
  const bare = /^[\s]*$/.test(c[2]) && (c[1] === "span" || c[1] === "div");
  if (bare) {
    const inner = TAG.exec(rest.slice(c[0].length));
    if (inner) out.push({ tag: inner[1], attrs: inner[2] });
  }
  return out;
}

// ===== A. 原生 title 归零（绑定式与静态式都查）=====
const ATTR_TITLE = /[\s]:?title\s*=\s*("|')/g;
const hits = [];
for (const f of files) {
  const t = templateOf(f);
  for (const m of t.matchAll(ATTR_TITLE)) {
    hits.push(`${f}:${t.slice(0, m.index).split("\n").length}`);
  }
}
check(`① 反代网关 ${files.length} 个视图零原生 title（残留 ${hits.length}）`, hits.length === 0, hits.join(" "));

// ===== B. 代表性提示仍在文件里（浮层没被删）=====
// 与 A 配对才成立：A 保证「没有原生 title」，B 保证「这些提示文字还在」⇒ 提示要么在
// content= 上，要么在配套脚本里返回（statusTip/errTip 这类），总之没被整条删掉。
// 逐条都对应一处移植前的原生 title。
const REQUIRED_TIPS = [
  // 消耗提示的后缀单位已逐渠道化（2026-09-30：积分/Token/额度），钉稳定前缀——
  // 单位由 balanceUnit(r.channel) 动态拼，字面量只剩前缀
  ["RequestLogTable.vue", ["点击查看详细报错", "点击查看上游响应体", "换号/限流重试后成功", "上游实报消耗", "上游未上报消耗"]],
  ["ProxyAgentsView.vue", ["点击查看完整 UID", "（点击重命名）", "一键还原到最近一次切换前的状态", "写回本机锚定指纹并重启客户端", "客户端在本机当前登录的就是这个账号"]],
  ["ProxyProvidersView.vue", ["max_tokens=16"]],
  ["ProxyStatsView.vue", ["读缓存 tokens"]],
  ["ProxyCcSwitchView.vue", ["CC Switch 当前接管中"]],
  ["ProxyModelsView.vue", ["含用户覆盖"]],
];
for (const [f, tips] of REQUIRED_TIPS) {
  const missing = tips.filter((s) => !src[f].includes(s));
  check(`② ${f} 的 ${tips.length} 条提示仍在`, missing.length === 0, missing.join(" | "));
}

// ===== C/D. 可空 content 必须禁用 + 触发器不得空 slot =====
// 判「content 会不会为空」不靠人肉记：去掉非空字符串字面量后还剩空串字面量 ⇒ 该表达式会返回空；
// 另一类是「按设计返回空串的提示函数/字段」，逐名列出（每个都对应一处 :disabled）
const TIP_HELPERS = [
  "modelTip", "statusTip", "creditTip", "tokensTip", "rowOkTip", "rowFailTip", "testTip",
  "liveTitle", "ideTitle", "modelCoolTitle", "pkg.name", "p.baseUrl",
];
let nNoDis = 0;
let nEmptyTrigger = 0;
let nNoContent = 0;
let nNoTrigger = 0;
let nSeen = 0;
for (const f of files) {
  const t = templateOf(f);
  for (const tp of tooltips(t)) {
    const expr = contentOf(tp.attrs);
    if (expr === null) {
      nNoContent++;
      console.log(`      ↳ ${f} 有个 el-tooltip 没挂 content：${tp.attrs.trim().slice(0, 60)}`);
      continue;
    }
    const emptiable = /''|""/.test(expr.replace(/'[^']+'|"[^"]+"/g, "S")) || TIP_HELPERS.some((k) => expr.includes(k));
    if (emptiable && !/[\s]:disabled\s*=/.test(tp.attrs)) {
      nNoDis++;
      console.log(`      ↳ ${f} 可空未禁用: ${expr.slice(0, 70)}`);
    }
    const cands = triggerCandidates(t, tp.after);
    if (!cands.length) {
      nNoTrigger++;
      console.log(`      ↳ ${f} 有个 el-tooltip 后面没有子节点（空触发器）`);
    }
    const cond = cands.filter((c) => /\bv-(if|else-if|else)\b/.test(c.attrs));
    if (cond.length) {
      nEmptyTrigger++;
      console.log(`      ↳ ${f} <el-tooltip> 的触发链上有 v-if/v-else（<${cond[0].tag}>）⇒ 条件不成立时浮层不可达`);
    }
    nSeen++;
  }
}
check("⓪ 每个 el-tooltip 都挂了 content", nNoContent === 0, `${nNoContent} 处缺`);
check("③ 可空 content 全部配了 :disabled（否则会飘出空玻璃泡）", nNoDis === 0, `${nNoDis} 处未配`);
check("④ 没有 el-tooltip 的首个子节点带 v-if/v-else", nEmptyTrigger === 0, `${nEmptyTrigger} 处`);
check(`④b 判据不是空转：本轮扫到 ${nSeen} 个 el-tooltip（反代网关浮层总数下限 30）`, nSeen >= 30 && nNoTrigger === 0, `实扫 ${nSeen}，无子节点 ${nNoTrigger}`);

// ===== E. 骨架屏 / 空态：真实渲染那张 <tbody> 数行 =====
function logTbodyRender() {
  const name = "RequestLogTable.vue";
  const { descriptor } = sfc.parse(src[name], { filename: name });
  const tbs = [];
  (function walk(n) {
    if (n.type === 1 && n.tag === "tbody") tbs.push(n);
    (n.children || []).forEach(walk);
  })(cd.parse(descriptor.template.content));
  if (tbs.length !== 1) throw new Error(`RequestLogTable 应有恰好一张 <tbody>，实得 ${tbs.length}`);
  const tb = tbs[0];
  const res = cd.compile(descriptor.template.content.slice(tb.loc.start.offset, tb.loc.end.offset), { mode: "function", hoistStatic: false });
  if (res.errors && res.errors.length) throw new Error("tbody 编译失败: " + res.errors[0].message);
  return new Function("Vue", res.code + "\nreturn render")(Vue);
}

const COLS = [{ id: "time", label: "时间" }, { id: "model", label: "模型" }, { id: "status", label: "状态" }];
const row = (id) => ({
  id, ts: 1770000000000, model: "glm-4.5", modelUpstream: "", channel: "zcode", keyName: "k1", accountName: "a1",
  status: 200, error: "", promptTokens: 10, completionTokens: 5, cachedTokens: -1, creditsUsed: -1,
  ttftMs: 100, latencyMs: 200, attempts: 1, hasErrorBody: false,
});

async function render({ rows, loading, scope }) {
  const app = Vue.createSSRApp({ render: logTbodyRender() });
  Object.assign(app.config.globalProperties, {
    rows, cols: COLS, loading, scope,
    colCount: COLS.length + 1,
    emptyText: scope === "home" ? "暂无请求记录 —— 用上方地址发起第一个请求即出现在这里" : "暂无请求记录",
    fmtDate: () => "2026-09-29", fmtTime: () => "10:00:00", fmtInt: (n) => String(n), fmtMs: () => "0.2s",
    channelName: () => "ZCode", statusCls: () => "tag-ok", skelW: () => "70px",
    balanceUnit: () => "积分",
    modelTip: () => "", statusTip: () => "", errTip: () => "", cacheRate: () => "-", failed: () => false,
    emit: () => {},
  });
  app.config.warnHandler = () => {};
  const html = await renderToString(app);
  // 这张表的表头行也写在 <tbody> 里（.tbl 的既有条款），所以顶层行要扣掉表头再比
  const trs = (html.match(/<tr\b/g) || []).length;
  const heads = (html.match(/<th\b/g) || []).length;
  const skels = (html.match(/class="skeleton"/g) || []).length;
  return { html, bodyTrs: trs - 1, heads, skels };
}

async function main() {
  const SKEL_ROWS = 5;
  const CELLS = COLS.length + 1; // 可见列 + 尾部固定的「详情」列
  const a = await render({ rows: [], loading: true, scope: "home" });
  check(`⑤ 加载中且无行 ⇒ ${SKEL_ROWS} 行骨架（实得 ${a.bodyTrs} 行 / ${a.skels} 格）`,
    a.bodyTrs === SKEL_ROWS && a.skels === SKEL_ROWS * CELLS, `bodyTrs=${a.bodyTrs} skels=${a.skels}`);
  check("⑥ 骨架行不与空态同屏", !/暂无请求记录/.test(a.html));
  check("⑦ 骨架格数与列设置一致（每行 = 可见列 + 详情列）",
    a.bodyTrs > 0 && a.skels / a.bodyTrs === CELLS, `每行 ${a.skels / a.bodyTrs} 格，期望 ${CELLS}`);
  check("⑦b 骨架期表头照常渲染", a.heads === CELLS, `实得 ${a.heads}`);

  const b = await render({ rows: [], loading: false, scope: "home" });
  check("⑧ 加载结束仍无行 ⇒ 只有一行空态、零骨架", b.bodyTrs === 1 && b.skels === 0 && /暂无请求记录/.test(b.html),
    `bodyTrs=${b.bodyTrs} skels=${b.skels}`);
  check("⑨ 空态文案按 scope 分流（源码面：总览带引导，统计页只留一句）",
    /scope === "home" \? "暂无请求记录 —— 用上方地址发起第一个请求即出现在这里" : "暂无请求记录"/.test(src["RequestLogTable.vue"]));
  const c = await render({ rows: [row("r1")], loading: false, scope: "stats" });
  check("⑩ 有数据 ⇒ 一行数据行、无骨架无空态", c.bodyTrs === 1 && c.skels === 0 && !/暂无请求记录/.test(c.html),
    `bodyTrs=${c.bodyTrs} skels=${c.skels}`);
  const d = await render({ rows: [row("r1")], loading: true, scope: "stats" });
  check("⑪ 翻页时已有行不闪骨架", d.bodyTrs === 1 && d.skels === 0, `bodyTrs=${d.bodyTrs} skels=${d.skels}`);

  console.log(`\n${failures.length ? "FAIL " + failures.length + " 项" : "OK 浮层统一闸全过"}（共 ${pass + failures.length} 项）`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error("闸自身异常:", e.message); process.exit(1); });
