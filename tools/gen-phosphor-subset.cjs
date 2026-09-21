// 扫 src/ 实际用到的 Phosphor 类名，连同后端 toolIcon() 下发的图标，生成只含这些字形
// 规则的 CSS（全量 1530 条 / 82 KB，实际用 88 条）。用法：
//   node tools/gen-phosphor-subset.cjs        # 生成 phosphor-used.css
// 图标集合变化后重跑即可；扫到字体表里不存在的类名会直接失败退出，不静默丢。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const FULL = path.join(SRC, "assets", "phosphor", "style.full.css");
const OUT = path.join(SRC, "assets", "phosphor", "phosphor-used.css");

// 后端数据下发的图标（stores/app.ts:241 toolIcon 的返回来自 electron/backend 的适配器），
// 静态扫 src/ 扫不到，手工列全，新增工具适配器时要同步这里
const BACKEND_ICONS = [
  "ph-brain", "ph-code", "ph-command", "ph-folder-open",
  "ph-package", "ph-robot", "ph-sparkle", "ph-terminal-window",
];

function walk(dir, files = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, files);
    else if (/\.(vue|ts|js|cjs)$/.test(e.name)) files.push(p);
  }
  return files;
}

const used = new Set(BACKEND_ICONS);
for (const f of walk(SRC)) {
  // 只认 "ph-xxx" 形式的类名片段；CSS 自定义属性 --ph- 会被这个正则自然排除
  for (const m of fs.readFileSync(f, "utf8").matchAll(/\bph-[a-z0-9]+(?:-[a-z0-9]+)*/g)) used.add(m[0]);
}

const full = fs.readFileSync(FULL, "utf8");
const firstIcon = full.search(/\.ph\.ph-[a-z0-9-]+:before\s*\{/);
// 原样搬运 @font-face + .ph 基础块（font-display 与 ligature/smoothing 都在里面，别重排）。
// 唯一改动：src 只保留 woff2——目录里只有 Phosphor.woff2，.woff/.ttf/.svg 三个 url 是死的，
// 全量 CSS 带着它们会被 Vite 打进 dist（各报一次 404），子集里去掉更省也更干净。
let header = full.slice(0, firstIcon).replace(
  /src:\s*url\(["']\.\/Phosphor\.woff2["']\)\s*format\(["']woff2["']\)\s*,[\s\S]*?;/,
  'src: url("./Phosphor.woff2") format("woff2");'
);
const rules = new Map();
for (const m of full.matchAll(/\.ph\.ph-([a-z0-9-]+):before\s*\{[^}]*\}/g)) rules.set("ph-" + m[1], m[0]);

const missing = [...used].filter((c) => !rules.has(c)).sort();
if (missing.length) {
  console.error("字体表里不存在这些类名（图标现在就是空白，改名或补字形）:", missing.join(" "));
  process.exit(1);
}

const kept = [...used].filter((c) => rules.has(c)).sort();
fs.writeFileSync(OUT, header + kept.map((c) => rules.get(c)).join("\n") + "\n", "utf8");
console.log(`phosphor 子集: ${kept.length} / ${rules.size} 条规则 → ${path.relative(process.cwd(), OUT)}`);
