// 一期首屏产物门槛：entry 体积、CSS 总量、echarts 是否还在首屏、视图是否真的切开、覆盖层有没有被懒注入 CSS 反超。
// 改动前基线：单 chunk 2445 KB JS + 584 KB CSS。
// 用法：npm run build && node scripts/dev-bundle-check.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist");
const ROOT = path.join(__dirname, "..");
const KB = (n) => n / 1024;
const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
const m = /<script type="module"[^>]*src="\.\/([^"]+\.js)"/.exec(html);
if (!m) throw new Error("index.html 里找不到 entry module script，先跑 npm run build");
// 入口样式表：只有它随 HTML 同步加载，其余 CSS 都是各自 chunk 到位时运行时注入 <head>
const link = /rel="stylesheet"[^>]*href="\.\/([^"]+\.css)"/.exec(html);
if (!link) throw new Error("index.html 里找不到入口 stylesheet，先跑 npm run build");
const entrySheet = link[1];

const entry = fs.readFileSync(path.join(DIST, m[1]));
const assets = path.join(DIST, "assets");
const js = fs.readdirSync(assets).filter((f) => f.endsWith(".js"));
const css = fs.readdirSync(assets).filter((f) => f.endsWith(".css"));
const cssKB = css.reduce((s, f) => s + KB(fs.statSync(path.join(assets, f)).size), 0);

const entryText = entry.toString("utf8");
const fails = [];
if (KB(entry.length) > 800) fails.push(`entry JS ${KB(entry.length).toFixed(0)} KB > 800 KB`);
if (cssKB > 325) fails.push(`CSS 合计 ${cssKB.toFixed(0)} KB > 325 KB`);
if (js.length < 15) fails.push(`JS chunk 只有 ${js.length} 个，视图没切开`);
// echarts 的折线渲染实现只应出现在异步 chunk；这两个标识是全量与 core 共有的内部字段名
if (/seriesType:\s*"line"/.test(entryText)) fails.push("echarts 疑似仍在 entry chunk");

// ===== 覆盖层级联顺序 =====
// element.css 打进入口样式表，EP 组件样式一旦被挪进懒加载 chunk，就是运行时才注入 <head>：
// 同特异性下后到者赢，覆盖层被静默反超（Task 3+4 之后真实发生过，字节位置检查看不见）。
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 选择器文本归一化：折叠空白、去掉逗号两侧空格，便于逐字比较 */
function normSel(s) {
  return s.replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").trim();
}

/** 逗号拆分选择器组：括号内的逗号（:is(a,b)）不拆 */
function splitSelectors(prelude) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (const ch of prelude) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(normSel).filter(Boolean);
}

/** 声明块 → 属性名集合（简写与长写按字面区分，background 不等于 background-color） */
function declProps(body) {
  const out = new Set();
  for (const d of body.split(";")) {
    const i = d.indexOf(":");
    if (i > 0) out.add(d.slice(0, i).trim().toLowerCase());
  }
  return out;
}

/**
 * 扫出全部叶子规则块（内含 `{` 的容器块不算，其子块会各自入列）。
 * atContext 是该块所有祖先 prelude，用来区分 @media（条件规则，仍是真选择器）
 * 与 @keyframes（from/to/百分比不是选择器）。字符串与 url() 内的花括号跳过。
 */
function leafRules(css) {
  const out = [];
  const stack = [];
  let from = 0;
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") {
      for (i++; i < css.length && css[i] !== c; i++) if (css[i] === "\\") i++;
      continue;
    }
    if (c === "u" && css.startsWith("url(", i)) {
      const close = css.indexOf(")", i);
      if (close > i) {
        i = close;
        continue;
      }
    }
    if (c === "{") {
      stack.push({ prelude: normSel(css.slice(from, i)), start: i + 1 });
      from = i + 1;
    } else if (c === "}") {
      const b = stack.pop();
      const body = css.slice(b.start, i);
      if (body.indexOf("{") === -1) {
        out.push({ sel: b.prelude, body, atContext: stack.map((s) => s.prelude).join(" ") });
      }
      from = i + 1;
    } else if (c === ";" && stack.length === 0) {
      from = i + 1; // @import / @charset 这类无块语句
    }
  }
  return out;
}

// 我方覆盖层：src/styles/element.css 顶层规则（@ 块内语境外不同，不参与）
const overrides = new Map();
for (const r of leafRules(stripComments(fs.readFileSync(path.join(ROOT, "src", "styles", "element.css"), "utf8")))) {
  if (r.sel.startsWith("@") || r.atContext.includes("@")) continue;
  const props = declProps(r.body);
  for (const sel of splitSelectors(r.sel)) {
    if (!overrides.has(sel)) overrides.set(sel, new Set());
    for (const p of props) overrides.get(sel).add(p);
  }
}

const collisions = [];
for (const f of css) {
  if (f === entrySheet || "assets/" + f === entrySheet) continue; // 入口表在 element.css 之前，本来就该赢
  for (const r of leafRules(stripComments(fs.readFileSync(path.join(assets, f), "utf8")))) {
    if (r.sel.startsWith("@") || /keyframes/i.test(r.atContext)) continue;
    for (const sel of splitSelectors(r.sel)) {
      const mine = overrides.get(sel);
      if (!mine) continue;
      const stolen = [...declProps(r.body)].filter((p) => mine.has(p)).sort();
      if (stolen.length) collisions.push(`覆盖层 ${sel} 被 ${f} 重申，抢回 ${stolen.join(", ")}`);
    }
  }
}
for (const c of collisions) fails.push(`覆盖层级联：${c}`);
if (!collisions.length) console.log(`OK 覆盖层顺序：element.css ${overrides.size} 条选择器无被懒注入 CSS 反超`);

for (const f of fails) console.error("FAIL " + f);
if (fails.length) process.exit(1);
console.log(`OK entry ${KB(entry.length).toFixed(0)} KB · CSS ${cssKB.toFixed(0)} KB · ${js.length} 个 JS chunk`);
