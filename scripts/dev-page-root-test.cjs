// 页面根节点闸：钉住「App.vue 上挂 v-show 的页面组件必须是单根」。
//
// 为什么需要它（2026-09-29 实测）：ProxyModelsView.vue 的模板被写成了两个根
// （<section class="page"> + <ModelMetaEditor>，后者是 fork 提交 6ce94bb 追加在 </section> 之后的）。
// 组件多根 = fragment 根，App.vue 上挂的 v-show / :class 会被 Vue **静默忽略**（只 console.warn
// 「Runtime directive used on component with non-element root node」）。后果不是报错而是行为错：
// 该页一旦挂载就再也藏不起来，切到同模块别的页时目标页被追加到它后面、落在屏幕外，
// 用户看到的就是「点了 tab 没反应」。vue-tsc 零报错、29 项 dev-* 全绿、构建也照过。
//
// 判据面：
//   ① App.vue 模板里每个带 v-show 的组件都必须能解析到本地文件（防改名后闸静默变空）
//   ② 这些组件的模板根节点数必须为 1
//   ③ 计数函数自带变异对照（多根样本必须报 2、单根样本必须报 1），防「恒返回 1」的空闸
// 跑法：node scripts/dev-page-root-test.cjs
"use strict";
if (require.main !== module) return;

const fs = require("node:fs");
const path = require("node:path");
const sfc = require("@vue/compiler-sfc");

const ROOT = path.resolve(__dirname, "..");
const APP = "src/App.vue";

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? `：${detail}` : "")); console.log(`FAIL  ${name}${detail ? `：${detail}` : ""}`); }
}

/** 模板根节点数：元素 + 非空文本算根，注释不算（注释不占 v-show 的落点判定） */
function rootCount(source, filename) {
  const { errors, ast } = compileTemplateAst(source, filename);
  if (errors) throw new Error(`${filename} 模板编译失败：${errors}`);
  return (ast.children || []).filter((n) => n.type === 1 || (n.type === 2 && n.content.trim())).length;
}
function compileTemplateAst(source, filename) {
  const { descriptor, errors } = sfc.parse(source, { filename });
  if (errors.length) throw new Error(`${filename} SFC 解析失败：${errors[0].message}`);
  if (!descriptor.template) return { errors: "无 <template>", ast: { children: [] } };
  const r = sfc.compileTemplate({ source: descriptor.template.content, filename, id: "root-check" });
  return { errors: r.errors.length ? r.errors[0].message || String(r.errors[0]) : null, ast: r.ast };
}

/** App.vue 的 import 映射：默认导入 + defineAsyncComponent(() => import(...)) 两种写法 */
function importMap(script) {
  const map = new Map();
  for (const m of script.matchAll(/import\s+([A-Za-z_$][\w$]*)\s+from\s+["']([^"']+)["']/g)) map.set(m[1], m[2]);
  for (const m of script.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*defineAsyncComponent\(\s*\(\)\s*=>\s*import\(\s*["']([^"']+)["']\s*\)/g)) map.set(m[1], m[2]);
  return map;
}

/** 收集模板里带 v-show 的组件标签名（只看组件：解析得到文件的标签）。
 *  v-if 会生成 IF 节点、v-for 生成 FOR 节点，子节点分别挂在 branches[].children / children 上，
 *  两种都得下钻 —— 页面标签本身几乎都带 v-if（懒挂载），漏掉就一条都收不到 */
function vShowTags(ast) {
  const tags = new Set();
  (function walk(nodes) {
    for (const n of nodes || []) {
      if (n.type === 1) {
        const hasShow = (n.props || []).some((p) => p.type === 7 && p.name === "show");
        if (hasShow) tags.add(n.tag);
        walk(n.children);
      } else if (n.type === 9) {
        for (const b of n.branches || []) walk(b.children);
      } else if (n.type === 5 || n.type === 11 || n.type === 12) {
        walk(n.children);
      }
    }
  })(ast.children);
  return tags;
}

function main() {
  const appSrc = fs.readFileSync(path.join(ROOT, APP), "utf8");
  const imports = importMap(appSrc);
  const { errors, ast } = compileTemplateAst(appSrc, APP);
  check("① App.vue 模板可编译", !errors, errors || undefined);

  // 原生标签（div 之类，配置页外壳用它承接 v-show）不是组件，多根无从谈起
  const tags = [...vShowTags(ast)].filter((t) => !/^[a-z][a-z0-9]*$/.test(t)).sort();
  const unresolved = tags.filter((t) => !imports.has(t));
  check(`② 带 v-show 的组件共 ${tags.length} 个，全部能解析到本地文件（防改名后闸变空）`,
    tags.length >= 20 && unresolved.length === 0, `未解析：${unresolved.join(", ") || "无"}`);

  const bad = [];
  let checked = 0;
  for (const tag of tags) {
    const rel = imports.get(tag);
    if (!rel) continue;
    const file = path.resolve(ROOT, "src", rel.replace(/^\.\//, ""));
    if (!fs.existsSync(file)) { bad.push(`${tag} → ${rel}（文件不存在）`); continue; }
    checked++;
    const n = rootCount(fs.readFileSync(file, "utf8"), path.basename(file));
    if (n !== 1) bad.push(`${path.relative(ROOT, file).replace(/\\/g, "/")} 有 ${n} 个根（v-show 会失效）`);
  }
  check(`③ 上述 ${checked} 个页面组件模板根节点数均为 1`, bad.length === 0, bad.join("；"));

  // ④ 变异对照：证明计数函数不是恒返回 1 的空闸
  const one = rootCount(`<template><section class="page"><div>x</div></section></template>`, "one.vue");
  const two = rootCount(`<template><section class="page"></section><ModelMetaEditor /></template>`, "two.vue");
  const tele = rootCount(`<template><section><Teleport to="body"><i /></Teleport></section></template>`, "tele.vue");
  check("④ 变异对照：单根样本=1、多根样本=2、含 Teleport 的样本=1", one === 1 && two === 2 && tele === 1, `one=${one} two=${two} tele=${tele}`);

  console.log(`\n${failures.length ? "FAIL " + failures.length + " 项" : "OK 页面根节点闸全过"}（共 ${pass + failures.length} 项）`);
  if (failures.length) process.exit(1);
}

try {
  main();
} catch (e) {
  console.error("闸自身异常:", e.message);
  process.exit(1);
}
