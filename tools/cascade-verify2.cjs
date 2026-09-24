// 独立复核（不依赖 dev-bundle-check 自己的实现）：懒注入 CSS 是否仍在覆盖 element.css
// 纯静态比对（只读 dist/ 与 src/，不 spawn 实例），但卫生三件套照走——统一口径，防将来改出副作用
"use strict";

// 守卫（三期收尾，2026-09-24）：被 require 时零副作用。本仓 5 个脚本曾因缺它而在被 require 时
// 真把探针跑了一次（Task 5 实现者核验导出面时误触 phase1-browser-pass）。
// 顶层 return 在 CJS 模块包装函数里合法：作为入口时 require.main === module 照常执行。
if (require.main !== module) return;
const hy = require("./probe-hygiene.cjs")("cascade-verify2");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const A = path.join(ROOT, "dist", "assets");
const html = fs.readFileSync(path.join(ROOT, "dist", "index.html"), "utf8");
const m = /assets\/(index-[0-9a-f]+\.css)/.exec(html);
if (!m) throw new Error("index.html 里找不到 entry CSS");
const ENTRY = m[1];
console.log("entry CSS =", ENTRY);

const src = fs
  .readFileSync(path.join(ROOT, "src", "styles", "element.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");
const ours = new Map();
for (const mm of src.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const sel = mm[1].replace(/\s+/g, " ").trim();
  if (!sel || sel.startsWith("@")) continue;
  for (const one of sel.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (!ours.has(one)) ours.set(one, new Set());
    for (const d of mm[2].split(";")) {
      const p = d.split(":")[0].trim();
      if (p) ours.get(one).add(p);
    }
  }
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
let hits = 0;
for (const f of fs.readdirSync(A).filter((x) => x.endsWith(".css") && x !== ENTRY)) {
  const s = fs.readFileSync(path.join(A, f), "utf8");
  for (const [sel, props] of ours) {
    if (/^(from|to|[0-9]+%)$/.test(sel)) continue;
    const re = new RegExp("(^|[,{}])" + esc(sel) + "(?=[{,])");
    const at = s.search(re);
    if (at < 0) continue;
    const j = s.indexOf("{", at);
    const decls = ";" + s.slice(j + 1, s.indexOf("}", j)).replace(/\s+/g, " ");
    const lost = [...props].filter((p) => decls.includes(";" + p + ":"));
    if (lost.length) {
      hits++;
      console.log("  CONFLICT", sel, "<-", f, "被抢:", lost.join(","));
    }
  }
}
console.log("总冲突:", hits, "（element.css 选择器", ours.size, "条）");
