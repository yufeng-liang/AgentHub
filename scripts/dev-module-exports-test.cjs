// electron/ 全域「调用了但没导出」闸（2026-09-30 补；同日从 proxy 域放宽到全域）。
//
// 为什么需要它：zcodeLocal.cjs 里 zcodeProviderOf() 从 v1.28 合入起就一直存在，却始终没写进
// module.exports —— 纯 CJS 的成员调用，类型检查（vue-tsc）看不见，任何静态样式闸也看不见。
// 后果是 adapters.chat 每次请求都抛 `zcodeLocal.zcodeProviderOf is not a function`，被
// server.cjs 的 classifyUpstream 归成 kind:"server"（可降级类别），连撞两次就把 ZCode 渠道
// 熔断成「降级中」——渠道看着像上游故障，实际是本机少导出一个函数。切号路径
// （zcodeSwitch.syncBackLiveToPool）撞的是同一个洞，界面上直接弹这句 TypeError。
//
// 判据：electron/ 下每个 .cjs 里 `别名.成员(` 的调用面，成员必须真的在该模块的导出表里；
// 以及 `require("./x.cjs").成员(` 这种直连写法同理。
// 解析只读源码文本（不 require 目标模块），零副作用：不联网、不落盘、不起进程。
// 跑法：node scripts/dev-module-exports-test.cjs
"use strict";
if (require.main !== module) return;

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
// 扫描面＝整个 electron/：缺导出的坑不止 proxy 域（sync-ipc.cjs 里 config.getUpdateNotified 的
// 兜底分支就是同一类，2026-09-30 已一并修掉）。全域铺开后 proxy 域那两处、以及 sync-ipc 那处
// 都在判据内，不必再靠"某个域另有历史遗留"来缩小面。
const SCAN_DIR = path.join(ROOT, "electron");

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name + (detail ? `：${detail}` : ""));
    console.log(`FAIL  ${name}${detail ? `：${detail}` : ""}`);
  }
}

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".cjs")) out.push(p);
  }
  return out;
}

/** 去掉注释、保留字符串字面量（require 的路径就写在字符串里，不能一起抹掉）。
 *  逐字符扫描而不是正则替换：`"https://x"` 里的 `//` 不是注释。 */
function strip(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && d === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      out += " ";
      continue;
    }
    if (c === "/" && d === "/") {
      const end = src.indexOf("\n", i + 2);
      i = end < 0 ? n : end;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) {
          j++;
          break;
        }
        j++;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 从 module.exports = { ... } 里取导出的标识符（支持 a、a: b、a: () => x，忽略 ...spread） */
function exportNames(file) {
  const src = strip(fs.readFileSync(file, "utf8"));
  const names = new Set();
  const re = /module\.exports\s*=\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length - 1;
    let depth = 0;
    let j = i;
    for (; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    const body = src.slice(i + 1, j);
    // 按顶层逗号切条目（括号里的逗号不算）
    let cur = "";
    let par = 0;
    const entries = [];
    for (const ch of body) {
      if (ch === "(" || ch === "[" || ch === "{") par++;
      else if (ch === ")" || ch === "]" || ch === "}") par--;
      if (ch === "," && par === 0) {
        entries.push(cur);
        cur = "";
      } else cur += ch;
    }
    entries.push(cur);
    for (const e of entries) {
      // 条目前面可能还挂着没被 strip 掉的注释（正则字面量里带引号会让逐字扫描误判成字符串），
      // 所以这里允许「空白 + 注释」任意混合出现在标识符之前
      const id = /^(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*([A-Za-z_$][\w$]*)/.exec(e);
      if (id) names.add(id[1]);
    }
    re.lastIndex = j;
  }
  return names;
}

const files = walk(SCAN_DIR);
const exportsCache = new Map();
function namesOf(file) {
  if (!exportsCache.has(file)) exportsCache.set(file, exportNames(file));
  return exportsCache.get(file);
}

/** 解析相对 require 的字面量目标；不是相对路径或文件不存在则返回 null */
function resolveTarget(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  const p = path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(p) && p.endsWith(".cjs")) return p;
  if (fs.existsSync(p + ".cjs")) return p + ".cjs";
  return null;
}

let callSites = 0;
const missing = [];

for (const file of files) {
  const src = strip(fs.readFileSync(file, "utf8"));
  const rel = path.relative(ROOT, file);

  // ① const 别名 = require("./x.cjs") / 别名 = require("./x.cjs")
  const alias = new Map();
  // `require("./x.cjs").fn()` 这种链式取值不是别名：RHS 后面紧跟 `.` 的要排除，
  // 否则 `const sections = require("./store.cjs").parseDailySections(body)` 会把 sections
  // 当成 store.cjs 的别名，后面 sections.find() 就被误判成"store.cjs 没导出 find"。
  for (const m of src.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*require\(\s*"([^"]+)"\s*\)(?!\s*\.)/g)) {
    const t = resolveTarget(file, m[2]);
    if (t) alias.set(m[1], t);
  }
  for (const [name, target] of alias) {
    const re = new RegExp(`\\b${name}\\s*\\.\\s*([A-Za-z_$][\\w$]*)\\s*\\(`, "g");
    for (const m of src.matchAll(re)) {
      callSites++;
      if (!namesOf(target).has(m[1])) {
        missing.push(`${rel}: ${name}.${m[1]}() ← ${path.relative(ROOT, target)} 未导出`);
      }
    }
  }

  // ② require("./x.cjs").成员( 直连写法
  for (const m of src.matchAll(/require\(\s*"([^"]+)"\s*\)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
    const t = resolveTarget(file, m[1]);
    if (!t) continue;
    callSites++;
    if (!namesOf(t).has(m[2])) {
      missing.push(`${rel}: require("${m[1]}").${m[2]}() ← ${path.relative(ROOT, t)} 未导出`);
    }
  }
}

check(`扫描面：${files.length} 个 .cjs / ${callSites} 处跨模块调用`, callSites > 0, "一处都没扫到说明解析失效了");
check("跨模块调用面全部命中导出表", missing.length === 0, missing.join(" | "));

// 自检：闸本身必须能抓到「调用了但没导出」——用临时文件构造一个已知缺陷，
// 抓不到就说明这个闸是空转的（宁可报红，也不要一个永远绿的门禁）
{
  const dir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "agenthub-exports-"));
  const lib = path.join(dir, "lib.cjs");
  const use = path.join(dir, "use.cjs");
  fs.writeFileSync(lib, 'function here() { return 1; }\nmodule.exports = { here };\n');
  fs.writeFileSync(use, 'const lib = require("./lib.cjs");\nmodule.exports = { run: () => lib.gone() };\n');
  const before = { files: files.length, calls: callSites, miss: missing.length };
  const libNames = namesOf(lib);
  const hit = /lib\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(strip(fs.readFileSync(use, "utf8")));
  const caught = !!hit && !libNames.has(hit[1]);
  check("自检：未导出的成员调用会被抓到", caught, caught ? "" : "构造的缺陷样例没被识别");
  // 自检②：链式取值（const x = require("./lib.cjs").fn()）不能被当成别名，
  // 否则真实代码里 x.someLocalMethod() 会被误报成「lib.cjs 未导出 someLocalMethod」
  const chained = 'const sections = require("./lib.cjs").parse();\nsections.find();\n';
  const aliasHits = [...chained.matchAll(/([A-Za-z_$][\w$]*)\s*=\s*require\(\s*"([^"]+)"\s*\)(?!\s*\.)/g)];
  check(
    "自检：链式 require(\"./x.cjs\").fn() 不会被当成别名（防误报）",
    aliasHits.length === 0,
    JSON.stringify(aliasHits.map((m) => m[1]))
  );
  check("自检：临时目录不污染扫描面", files.length === before.files && callSites === before.calls && missing.length === before.miss);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failures.length ? `\n${pass} 通过 / ${failures.length} 失败` : `\n${pass} 通过 / 0 失败`);
process.exit(failures.length ? 1 : 0);
