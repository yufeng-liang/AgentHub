// 一期首屏产物门槛：entry 体积、CSS 总量、echarts 是否还在首屏、视图是否真的切开。
// 改动前基线：单 chunk 2445 KB JS + 584 KB CSS。
// 用法：npm run build && node scripts/dev-bundle-check.cjs
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DIST = path.join(__dirname, "..", "dist");
const KB = (n) => n / 1024;
const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
const m = /<script type="module"[^>]*src="\.\/([^"]+\.js)"/.exec(html);
if (!m) throw new Error("index.html 里找不到 entry module script，先跑 npm run build");

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

for (const f of fails) console.error("FAIL " + f);
if (fails.length) process.exit(1);
console.log(`OK entry ${KB(entry.length).toFixed(0)} KB · CSS ${cssKB.toFixed(0)} KB · ${js.length} 个 JS chunk`);
