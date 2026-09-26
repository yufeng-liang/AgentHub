// 一期首屏产物门槛：entry 体积、CSS 总量、echarts 是否还在首屏、视图是否真的切开、覆盖层有没有被懒注入 CSS 反超。
// 改动前基线：单 chunk 2445 KB JS + 584 KB CSS。
// 用法：npm run build && node scripts/dev-bundle-check.cjs
//       加 --check 跑漂移闸：与 scripts/.bundle-baseline.json 比对 entry/CSS 字节，漂移 >5% 红
//       （首跑无基线时把当前值写进去，随提交入库；有意改体积后删掉基线文件重跑 --check 重录）。
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
//
// 判据是「特异性 + 注入顺序」，不是文件名启发式也不是选择器字面相等：
//   1) 只认**同一主体**的选择器：懒块选择器的复合单元序列以我们的选择器结尾（可带额外祖先上下文）。
//      字面「包含」但不等主体的（如 .el-dialog__header .el-icon 之于 .el-icon）作用在不同元素上，不比。
//      单元键不区分后代 / 子代组合符（.a .b 与 .a > .b 视作同主体），这种成对的判定交给下面的特异性闸门。
//   2) 违规要求懒块特异性 **<= 我们**：等特异性才是「后到者赢」的危险区；更低说明我们已经赢，
//      报出来只会逼人去加重选择器（假阳性）；更高那是特异性问题，得靠 element.css 自己压过，不是顺序问题。
//   3) 特异性按 CSS 计算规则算：#id / .class / [属性]（含 Vue 的 [data-v-*]）/ :伪类 记 b，类型与 ::伪元素
//      记 c，:where() 整段记 0，:is() / :not() / :has() 取参数列表最大值，* 记 0。
// 于是 .el-select-dropdown__item.is-selected 不会被 :where(.foo) .el-select-dropdown__item.is-selected
// （0,3,0 > 0,2,0）或 [data-v-fake] .el-select-dropdown__item.is-selected（0,3,0）误判为被反超。
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 选择器文本归一化：折叠空白、去掉逗号两侧空格，便于逐字比较 */
function normSel(s) {
  return s.replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").trim();
}

/** 选择器 → 复合单元序列：按顶层空白与 > + ~ 切开，括号/方括号/引号内的不切 */
function unitsOf(sel) {
  const units = [];
  let cur = "";
  let depth = 0;
  let quote = "";
  const flush = () => {
    const t = cur.trim();
    if (t) units.push(t);
    cur = "";
  };
  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
    if (quote) {
      cur += ch;
      if (ch === "\\") cur += sel[++i] || "";
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && (ch === " " || ch === ">" || ch === "+" || ch === "~")) {
      flush();
      continue;
    }
    cur += ch;
  }
  flush();
  return units;
}

/** 单元序列的规范键：单元文本各自折叠空白后按空格拼回 */
function unitKey(units) {
  return units.map((u) => u.replace(/\s+/g, "")).join(" ");
}

/** 特异性三元组 [id, 类/属性/伪类, 类型/伪元素] */
function specificity(sel) {
  const total = [0, 0, 0];
  for (const u of unitsOf(normSel(sel))) {
    const p = unitSpec(u);
    total[0] += p[0];
    total[1] += p[1];
    total[2] += p[2];
  }
  return total;
}

function cmpSpec(a, b) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const fmtSpec = (s) => `(${s.join(",")})`;

/** 单个复合单元的特异性 */
function unitSpec(u) {
  const out = [0, 0, 0];
  const n = u.length;
  let i = 0;
  const isNameCh = (c) => /[\w\-\\]|[\u00a0-\uffff]/.test(c);
  const readIdent = () => {
    const s = i;
    while (i < n && isNameCh(u[i])) i++;
    return u.slice(s, i);
  };
  // u[i] 处是 '(' ：返回括号内文本（嵌套与引号感知），i 停在右括号上交给主循环前移
  const readArgs = () => {
    let depth = 0;
    let q = "";
    const start = i + 1;
    for (; i < n; i++) {
      const c = u[i];
      if (q) {
        if (c === "\\") i++;
        else if (c === q) q = "";
        continue;
      }
      if (c === '"' || c === "'") q = c;
      else if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (!depth) return u.slice(start, i);
      }
    }
    return u.slice(start);
  };
  const skipBracket = () => {
    let q = "";
    for (; i < n; i++) {
      const c = u[i];
      if (q) {
        if (c === "\\") i++;
        else if (c === q) q = "";
        continue;
      }
      if (c === '"' || c === "'") q = c;
      else if (c === "]") return;
    }
  };
  while (i < n) {
    const ch = u[i];
    if (ch === "#") {
      i++;
      readIdent();
      out[0]++;
    } else if (ch === ".") {
      i++;
      readIdent();
      out[1]++;
    } else if (ch === "[") {
      i++;
      skipBracket();
      i++; // 跳过 ']'
      out[1]++; // 属性选择器（含 Vue 的 [data-v-*]）记 1 个 b
    } else if (ch === ":") {
      if (u[i + 1] === ":") {
        i += 2;
        readIdent();
        out[2]++; // 伪元素与类型选择器同档
        continue;
      }
      i++;
      const name = readIdent().toLowerCase();
      if (u[i] === "(") {
        const arg = readArgs();
        if (name === "where") continue; // :where() 特异性 0
        if (name === "is" || name === "not" || name === "has") {
          let best = [0, 0, 0];
          for (const inner of splitSelectors(arg)) {
            const t = specificity(inner);
            if (cmpSpec(t, best) > 0) best = t;
          }
          out[0] += best[0];
          out[1] += best[1];
          out[2] += best[2];
        } else {
          out[1]++; // :nth-child(2n) / :lang() 等按一个伪类计
        }
      } else if (name !== "where") {
        out[1]++;
      }
    } else if (ch === "*") {
      i++; // 通用选择器不贡献特异性
    } else if (/[A-Za-z_]|[\u00a0-\uffff]/.test(ch)) {
      readIdent();
      out[2]++; // 类型选择器
    } else {
      i++; // ',' '|' 等
    }
  }
  return out;
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
// bySuffix 按「复合单元序列键」索引，懒块写法可能给我们的选择器加祖先上下文
const overrides = new Map();
const bySuffix = new Map();

/** 累积某选择器在我们覆盖层里声明的属性，并登记它的特异性与单元键 */
function addOverride(sel, props) {
  let e = overrides.get(sel);
  if (!e) {
    e = { sel, props: new Set(), spec: specificity(sel), key: unitKey(unitsOf(sel)) };
    overrides.set(sel, e);
    if (!bySuffix.has(e.key)) bySuffix.set(e.key, []);
    bySuffix.get(e.key).push(e);
  }
  for (const p of props) e.props.add(p);
}

for (const r of leafRules(stripComments(fs.readFileSync(path.join(ROOT, "src", "styles", "element.css"), "utf8")))) {
  if (r.sel.startsWith("@") || r.atContext.includes("@")) continue;
  const props = declProps(r.body);
  for (const sel of splitSelectors(r.sel)) addOverride(sel, props);
}

const collisions = [];
const reported = new Set();
for (const f of css) {
  if (f === entrySheet || "assets/" + f === entrySheet) continue; // 入口表在 element.css 之前，本来就该赢
  for (const r of leafRules(stripComments(fs.readFileSync(path.join(assets, f), "utf8")))) {
    if (r.sel.startsWith("@") || /keyframes/i.test(r.atContext)) continue;
    const props = declProps(r.body);
    for (const sel of splitSelectors(r.sel)) {
      const units = unitsOf(sel);
      const lateSpec = specificity(sel);
      // 只比同一主体：懒块选择器的单元序列以我们的选择器结尾（前缀是额外的祖先上下文）
      for (let cut = 0; cut < units.length; cut++) {
        const list = bySuffix.get(unitKey(units.slice(cut)));
        if (!list) continue;
        for (const ours of list) {
          if (cmpSpec(lateSpec, ours.spec) > 0) continue; // 更高特异性是特异性问题，不是注入顺序被反超
          const stolen = [...props].filter((p) => ours.props.has(p)).sort();
          if (!stolen.length) continue;
          const dedupe = ours.sel + "|" + f + "|" + sel + "|" + stolen.join(",");
          if (reported.has(dedupe)) continue;
          reported.add(dedupe);
          const note = sel === ours.sel ? "" : `（懒块写法 ${sel} ${fmtSpec(lateSpec)}，我们 ${fmtSpec(ours.spec)}）`;
          collisions.push(`覆盖层 ${ours.sel} 被 ${f} 重申${note}，抢回 ${stolen.join(", ")}`);
        }
      }
    }
  }
}
for (const c of collisions) fails.push(`覆盖层级联：${c}`);
if (!collisions.length) console.log(`OK 覆盖层顺序：element.css ${overrides.size} 条选择器无被懒注入 CSS 反超`);

// ===== --check 漂移闸（Task 9 项 4，一期评审点名）=====
// 硬门槛是「超线才红」，门槛之内的缓慢漂移没人看：entry 454→490 KB 连续几轮各 +8% 也全绿。
// --check 把当前 entry/CSS 字节与 scripts/.bundle-baseline.json 比对，漂移 >5% 报「先核对是否有意」。
// 有意改动后删掉基线文件重跑 --check 重录（闸门绝不自动重写基线，否则等于没闸）。
// jsChunks 只记账不设闸：视图增删会合理地改 chunk 数，拿它红人全是噪声。
const DRIFT_LIMIT = 0.05;
const BASELINE = path.join(__dirname, ".bundle-baseline.json");
if (process.argv.includes("--check")) {
  if (fails.length) {
    console.error("--check 跳过：先解决上面的硬门槛，漂移基线只对全绿的产物有意义");
  } else {
    const cur = {
      entryBytes: entry.length,
      cssBytes: Math.round(cssKB * 1024),
      jsChunks: js.length,
      checkedAt: new Date().toISOString(),
    };
    if (!fs.existsSync(BASELINE)) {
      fs.writeFileSync(BASELINE, JSON.stringify(cur, null, 2) + "\n");
      console.log(`OK 漂移闸首跑：基线已写入 ${path.relative(ROOT, BASELINE)}`
        + `（entry ${cur.entryBytes} B · CSS ${cur.cssBytes} B · ${cur.jsChunks} chunk）——记得随提交入库`);
    } else {
      const base = JSON.parse(fs.readFileSync(BASELINE, "utf8"));
      const drift = (k) => (base[k] > 0 ? Math.abs(cur[k] - base[k]) / base[k] : 0);
      const over = ["entryBytes", "cssBytes"].filter((k) => drift(k) > DRIFT_LIMIT);
      if (over.length) {
        for (const k of over) {
          const label = k === "entryBytes" ? "entry JS" : "CSS 合计";
          fails.push(`漂移闸：${label} ${cur[k]} B 与基线 ${base[k]} B 漂移 ${(drift(k) * 100).toFixed(1)}% > 5%`
            + "——先核对是否有意；有意则删掉基线文件重跑 --check 重录");
        }
      } else {
        console.log(`OK 漂移闸：entry/CSS 与基线偏差均 ≤5%`
          + `（entry ${(drift("entryBytes") * 100).toFixed(1)}% · CSS ${(drift("cssBytes") * 100).toFixed(1)}%）`);
      }
    }
  }
}

for (const f of fails) console.error("FAIL " + f);
if (fails.length) process.exit(1);
console.log(`OK entry ${KB(entry.length).toFixed(0)} KB · CSS ${cssKB.toFixed(0)} KB · ${js.length} 个 JS chunk`);
