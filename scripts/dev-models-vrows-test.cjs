// 模型目录表格「虚拟滚动」结构闸：钉住只挂载视口附近那几十行，且没为了性能砍功能。
//
// 起因（2026-09-29 实测）：模型目录 133 行一次性全渲染 = 6212 个 DOM 节点，
// 切进该页要付 RecalcStyle ~315ms + Layout ~65ms（单帧最长 500–620ms）；
// 更糟的是 App.vue 用 v-show 保活、访问过的页永不卸载，于是这 133 行挂载的 266 个
// el-select（冷挂载实测 +10131 个事件监听器）会让**之后任意两个页面之间**的切换
// 都付 ~150ms 长任务。视口 clientHeight 只有 476px、一屏只看得见 7 行 —— 19 倍过渲染。
//
// 判据落在真实渲染出来的 <tr> 上（照 dev-pool-rows-test.cjs 的路子）：静态检查看不见
// 「模板仍遍历 rows」这种回归，但数行数一眼就能看见。
// 窗口数学从 src/views/proxy/virtualWindow.ts 导入**同一份实现**，不在测试里抄一遍。
// 跑法：node scripts/dev-models-vrows-test.cjs
"use strict";
if (require.main !== module) return;

const fs = require("node:fs");
const path = require("node:path");
const sfc = require("@vue/compiler-sfc");
const cd = require("@vue/compiler-dom");
const esbuild = require("esbuild");
const Vue = require("vue");
const { renderToString } = require("@vue/server-renderer");

const ROOT = path.resolve(__dirname, "..");
const FILE = "src/views/proxy/ProxyModelsView.vue";
const TOTAL = 133; // 与真机 catalog 同量级（实测 proxy_models 返回 133 条）

// ---- 从 TS 源里取真实的窗口数学（与组件用的是同一份，改错了这里一起红） ----
const tsCache = new Map();
function loadTsModule(rel) {
  if (tsCache.has(rel)) return tsCache.get(rel);
  const abs = path.join(ROOT, rel);
  const js = esbuild.transformSync(fs.readFileSync(abs, "utf8"), { loader: "ts", format: "cjs" }).code;
  const mod = { exports: {} };
  // new Function 的作用域里没有 require，而 format.ts 自上游 v1.54.0 起把 fmtCtx
  // 转出到 utils/format.ts —— 多出一层相对依赖，不接 require 就是闸自身 ReferenceError
  // （红在门禁身上，与被测组件无关）。相对路径递归走同一个加载器，保持「取真实现」的口径。
  const localRequire = (spec) => {
    if (!spec.startsWith(".")) return require(spec);
    const base = path.resolve(path.dirname(abs), spec);
    for (const cand of [`${base}.ts`, `${base}.js`, path.join(base, "index.ts")]) {
      if (fs.existsSync(cand)) return loadTsModule(path.relative(ROOT, cand).replace(/\\/g, "/"));
    }
    throw new Error(`闸的 TS 加载器解析不到 ${spec}（从 ${rel}）`);
  };
  new Function("module", "exports", "require", js)(mod, mod.exports, localRequire);
  tsCache.set(rel, mod.exports);
  return mod.exports;
}
const { ROW_H, OVERSCAN, MIN_ROWS, winRange, colCountFor } = loadTsModule("src/views/proxy/virtualWindow.ts");
// fmtCtx / capabilityTags 取真的，不在这里手抄一遍缩写与标签规则（抄了就变成门禁替被测代码答题）
const fmtReal = loadTsModule("src/views/proxy/format.ts");
const { fmtCtx, capabilityTags } = fmtReal;
// 合并列的摘要/态别算法同样取**同一份实现**：闸自己拼一遍「自动路由 · N 渠道」，
// 组件写成别的文案也不会红——这与 colCountFor / fmtCtx 是一个口径。
const { chanSummary, chanTone, chanRows, staleExcluded, liveCount } = loadTsModule("src/views/proxy/channelCell.ts");

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? `：${detail}` : "")); console.log(`FAIL  ${name}${detail ? `：${detail}` : ""}`); }
}

/** 按标签深度切出顶层 <tr>（占位行里的 td 也算顶层，单独识别） */
function topLevelRows(html) {
  const re = /<(\/?)(tr|table|td)\b/g;
  const out = [];
  let depth = 0, tdDepth = 0, cur = null, start = 0, openTag = "";
  for (let m; (m = re.exec(html));) {
    const [, close, tag] = m;
    if (tag === "tr") {
      if (!close) {
        if (depth === 0) { cur = []; start = re.lastIndex; openTag = html.slice(m.index, html.indexOf(">", m.index) + 1); }
        depth++;
      } else {
        depth--;
        if (depth === 0 && cur) { out.push({ inner: html.slice(start, m.index), tds: cur.length, open: openTag }); cur = null; }
      }
    } else if (tag === "table") {
      if (!close) tdDepth++; else tdDepth--;
    } else if (tag === "td" && tdDepth === 0 && cur) {
      if (!close) cur.push(1);
    }
  }
  return out;
}

/** 片段里只有 4 处 TS 专用语法（2 个 as 断言 + 2 个 (v: string) => 形参标注）。 *  这个版本的 compiler-core 没把 expressionPlugins:['typescript'] 透传到嵌套表达式，
 *  编译产物里仍留着 `as`，new Function 直接炸。所以先剥掉这两类标注。
 *  真出现别的 TS 语法时编译会抛错、闸整体红——是响亮的失败，不会假绿。 */
function stripTs(s) {
  return s
    .replace(/\s+as\s+[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/g, "")
    .replace(/\(\s*([A-Za-z_$][\w$]*)\s*:\s*[A-Za-z_$][\w$.<>\[\]| ]*\s*\)\s*=>/g, "($1) =>");
}

/** 编译模型目录那张 <tbody>（认 updateModelCustom 这个只有它才有的绑定） */
function catalogTbodyRender() {
  const { descriptor, errors } = sfc.parse(fs.readFileSync(path.join(ROOT, FILE), "utf8"), { filename: FILE });
  if (errors.length) throw new Error("SFC 解析失败: " + errors[0].message);
  const tbs = [];
  const ths = [];
  (function walk(n) {
    if (n.type === 1 && n.tag === "tbody") tbs.push(n);
    if (n.type === 1 && n.tag === "thead") ths.push(n);
    (n.children || []).forEach(walk);
  })(cd.parse(descriptor.template.content));
  const tb = tbs.find((t) => t.loc.source.includes("updateModelCustom"));
  if (!tb) throw new Error("找不到模型目录的 <tbody>（认 updateModelCustom 这个绑定）：表格被改名或拆走了");
  const th = ths.find((t) => /<th[\s>]/.test(t.loc.source) && t.loc.source.includes("思考强度"));
  if (!th) throw new Error("找不到模型目录的 <thead>（认「思考强度」这一列）");
  const res = cd.compile(stripTs(tb.loc.source), { mode: "function", hoistStatic: false });
  if (res.errors && res.errors.length) throw new Error("tbody 片段编译失败: " + res.errors[0].message);
  // 表头列数要单独数：thead 不在 tbody 片段里，早先拿 tbody 源码数 <th 恒为 0（判据自空）
  const thSource = th.loc.source;
  return { render: new Function("Vue", res.code + "\nreturn render")(Vue), source: tb.loc.source, thSource };
}

/** 表头实际列数：「来源渠道」那一列带 v-if="!activeTab"，单渠道视图下它不渲染。
 *  必须用 <th[\s>] 匹配：<th 单独匹配会把 </thead> 之前那个 <thead> 开标签也算进来（实测多 1）。 */
function headColCount(thSource, activeTab) {
  const all = (thSource.match(/<th[\s>]/g) || []).length;
  const conditional = (thSource.match(/<th[^>]*v-if="!activeTab"/g) || []).length;
  return all - (activeTab ? conditional : 0);
}

function mkModels(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `model-${String(i + 1).padStart(3, "0")}`, object: "model", created: 0, owned_by: "trae",
    sources: i % 3 === 0 ? ["trae", "workbuddy"] : ["trae"],
    name: `Model ${i + 1}`, rate: null,
    // 能力五枚齐备（图/视/思/工 + 输出上限），这样「全显」的判据数得到 5 而不是一
    capabilities: { images: true, video: true, reasoning: true, tools: true },
    maxOutputTokens: 131072,
    contextLength: 131072,
    reasoning: {}, enabled: true, fallback: "",
    // 三态各留一格：0=双源且排除了一个、3=钉定、其余=纯自动单源
    override: i === 3 ? "trae" : "",
    excluded: i % 3 === 0 ? ["workbuddy"] : [],
    pinnedKeys: i % 3 === 0 ? [{ id: "k1", name: "CLI 用 Key", route: "trae" }] : [],
  }));
}

/** el-popover 这类组件在闸里没注册。未解析组件的**默认槽**会被渲染（探针实测旧模板一行里
 *  <el-option 开标签 = 2），但**具名槽**（`#reference`）整个丢掉——于是触发器那颗 chip
 *  在 HTML 里根本不存在，㉓/㉓b/㉓c/㉕ 就看不见被测内容。
 *  这个桩只负责「把所有槽都吐出来给判据看」：它不产出任何被测语义
 *  （文案、类名、行序仍来自组件与 channelCell 的真实现），所以不构成门禁替被测代码答题。 */
const AllSlotsStub = {
  name: "el-popover",
  setup(_props, { slots }) {
    return () => Vue.h("el-popover", null, [slots.reference ? slots.reference() : null, slots.default ? slots.default() : null]);
  },
};

async function render({ rows, firstVisible, viewRows, activeTab = "" }) {
  const { render, source, thSource } = catalogTbodyRender();
  const r = winRange(rows.length, firstVisible, viewRows);
  const win = rows.slice(r.start, r.end);
  const noop = () => {};
  const app = Vue.createSSRApp({ render });
  app.component("el-popover", AllSlotsStub);
  Object.assign(app.config.globalProperties, {
    rows, win, activeTab,
    vPadTop: r.padTop, vPadBottom: r.padBottom,
    // 绑**真的** colCountFor，不注入算好的数字：注入等于门禁替被测代码答题，
    // 变异测试（组件里写死 9）因此漏检过一轮
    colCountFor,
    app: { config: { proxy: { modelCustom: { "model-001": { contextLength: 999 } } } } },
    REASONING_EFFORT_ALL: [{ value: "", label: "默认" }, { value: "low", label: "低 (low)" }],
    // 能力标签取**真实现**：桩（此前是 () => ["工具"]）会让「五枚全显」这条判据只能测到桩自己。
    capabilityTags, channelName: () => "Trae", fmtRate: () => "—",
    // 合并列的两个可见函数也取真的（同上：注入假的等于门禁替被测代码答题）
    chanSummary, chanTone,
    // 探针实测：未解析组件（el-popover / el-select）的**插槽内容在 SSR 里会被渲染**
    // （旧模板一行里 <el-option 开标签数 = 2）。所以 popover 里的行数与开关数能当判据，
    // 不必退化成「只能真机核验」。chanRowsOf 用真的 chanRows 现算，order 由闸给定；
    // 顺序策略本身另用 ㉓e 直接判纯函数，不依赖这里给的 order。
    chanRowsOf: (m) => chanRows(m, ["trae", "workbuddy"]),
    staleExcluded: (m) => staleExcluded(m), liveCount: (m) => liveCount(m),
    toggleExclude: noop, togglePin: noop, clearStale: noop, gotoKey: noop,
    // 上下文列「非编辑态 K/M 缩写 + 聚焦草稿」引入的绑定点。
    // 这段只保证模板渲染得出来，本闸的判据是行结构（⑬ 已单独钉输入框还在），
    // 所以 ctxValue 只取目录值、不复制组件里「自定义优先」那条链路。
     ctxDraft: {}, ctxValue: (m) => Number(m.contextLength) || 0,
     ctxDisplay: (m) => fmtCtx(Number(m.contextLength) || 0), ctxTip: () => "自定义上下文长度",
     commitCtx: noop,
    REASONING_EFFORT_ALL: [{ value: "", label: "默认" }, { value: "low", label: "低 (low)" }], effortOptions: (m) => [], effortTip: () => "自定义思考强度",
    updateModelCustom: noop, setOverride: noop, toggleEnabled: noop, openMetaEditor: noop,
  });
  app.config.warnHandler = () => {};
  const html = await renderToString(app);
  return { html, rowsOut: topLevelRows(html), range: r, win, source, thSource };
}

const isSpacer = (t) => /v-spacer/.test(t.open);
const dataRows = (rs) => rs.filter((t) => !isSpacer(t));

async function main() {
  console.log(`常量：ROW_H=${ROW_H} OVERSCAN=${OVERSCAN} MIN_ROWS=${MIN_ROWS}`);

  // ===== A. 核心判据：133 个模型不得全量挂载 =====
  const models = mkModels(TOTAL);
  const a = await render({ rows: models, firstVisible: 0, viewRows: 7 });
  const top = dataRows(a.rowsOut);
  check(`① ${TOTAL} 个模型只渲染出 ${top.length} 个数据行（≤25）`, top.length > 0 && top.length <= 25,
    top.length === TOTAL ? `仍全量渲染 ${top.length} 行 ⇒ 模板遍历的是 rows 而不是 win` : `实得 ${top.length}`);
  check(`② 渲染的就是窗口那几行（首 ${top[0] ? top[0].inner.includes(a.win[0].id) : false} / 末 ${top.length ? top[top.length - 1].inner.includes(a.win[a.win.length - 1].id) : false}）`,
    top.length === a.win.length && top[0].inner.includes(a.win[0].id) && top[top.length - 1].inner.includes(a.win[a.win.length - 1].id));

  // ===== B. 总高守恒：占位行必须补齐未渲染的行，否则滚动条会缩短、滚到中途内容跳 =====
  const spacers = a.rowsOut.filter(isSpacer);
  // 贴顶时上占位应为 0 行、贴底时下占位应为 0 行，所以「必须两个」是错的判据（会把正确实现判红）。
  // 真判据是：占位行的有无与高度，必须和窗口数学算出来的一致。
  const wantPads = [a.range.padTop, a.range.padBottom].filter((v) => v > 0);
  check(`③ 占位行数量与窗口一致（应为 ${wantPads.length} 个，实得 ${spacers.length}）`,
    spacers.length === wantPads.length, "缺占位 ⇒ 滚动总高会塌，用户滚到一半内容跳变");
  const padSum = a.range.padTop + a.range.padBottom;
  check(`④ 占位高度 = 未渲染行数 × 行高（${padSum} vs ${(TOTAL - top.length) * ROW_H}）`,
    padSum === (TOTAL - top.length) * ROW_H);
  const heights = spacers.map((t) => { const m = /height:\s*(\d+(?:\.\d+)?)px/.exec(t.open); return m ? +m[1] : -1; });
  check(`⑤ 占位行把高度写在自己身上（实得 ${JSON.stringify(heights)}，应为 ${JSON.stringify(wantPads)}）`,
    JSON.stringify(heights) === JSON.stringify(wantPads),
    "只算不写 = 占位行高度 0，等于没垫");

  // ===== C. 滚到中段与滚到底：窗口要跟着走，且底部不越界 =====
  const mid = await render({ rows: models, firstVisible: 60, viewRows: 7 });
  check(`⑥ 滚到第 60 行时窗口前移（首行 ${dataRows(mid.rowsOut)[0].inner.includes("model-057") ? "model-057" : "?"}）`,
    dataRows(mid.rowsOut)[0].inner.includes(models[60 - OVERSCAN].id));
  const end = await render({ rows: models, firstVisible: TOTAL - 1, viewRows: 7 });
  const endRows = dataRows(end.rowsOut);
  check(`⑦ 滚到底不越界（${endRows.length} 行、末行是最后一个模型、下占位 0）`,
    endRows.length <= 25 && endRows[endRows.length - 1].inner.includes(models[TOTAL - 1].id) && end.range.padBottom === 0,
    `行数=${endRows.length} padBottom=${end.range.padBottom}`);

  // ===== D. 空态与列数 =====
  const empty = await render({ rows: [], firstVisible: 0, viewRows: 7 });
  check(`⑧ 0 个模型仍渲染「无匹配模型」行，且不产生占位行`,
    /无匹配模型/.test(empty.html) && empty.rowsOut.filter(isSpacer).length === 0);
  const headCols = headColCount(a.thSource, "");
  const bodyCols = [...new Set(dataRows(a.rowsOut).map((t) => t.tds))];
  check(`⑨ 表头 ${headCols} 列 ⇒ 每个数据行也 ${headCols} 列（实得 ${bodyCols.join("/")}）`,
    headCols > 0 && bodyCols.length === 1 && bodyCols[0] === headCols, "列数不一致整表错位");
  const ch = await render({ rows: models, firstVisible: 0, viewRows: 7, activeTab: "trae" });
  const chHead = headColCount(ch.thSource, "trae");
  const chCols = [...new Set(dataRows(ch.rowsOut).map((t) => t.tds))];
  // ⑩ 合并列改造后「渠道」列常驻：两个视图的列数必须**相同**。
  //    此前是 headCols - 1（少一列「来源渠道」），改成相等就是把「合并」这件事钉进判据：
  //    实现若还给渠道列挂 v-if，activeTab 下表头少一列而 colspan 仍是老数 ⇒ 整表错位，这里必红。
  check(`⑩ 单渠道视图与合并视图列数相同（实得 ${chHead}/${headCols}）`,
    chHead === headCols && chCols.length === 1 && chCols[0] === chHead, "合并列若还挂 v-if，activeTab 下会少一列而 colspan 仍是老数 ⇒ 整表错位");

  // ===== E. 防「为了性能砍功能」：每行该有的控件还得在 =====
  const one = dataRows(a.rowsOut)[0].inner;
  // ⑪ 合并列改造后每行的 el-select 只剩「思考强度」一个（渠道覆盖那张并进 popover）。
  //    必须钉成恰好 1 而不是 >=1：下界判据对「多挂一份 select」全盲，而白挂一份就是
  //    本页最初测出来的那个代价（133 行 × 2 个 select = 冷挂载 +10131 个事件监听器）。
  //    计数按开标签 `<el-select` 而不是子串 `el-select`：后者在一行里出现 8 次（class 名也含它），
  //    拿子串当「下拉个数」是判据自身写错（实测旧模板 2 个下拉 → 子串 8 次）。
  const selN = (one.match(/<el-select/g) || []).length;
  check(`⑪ 每行 el-select 恰好 1 个（思考强度；渠道覆盖已并入 popover）（实得 ${selN}）`, selN === 1,
    selN === 2 ? "渠道覆盖那张 select 还在 ⇒ 合并没落地" : `实得 ${selN}`);
  // 2026-09-30 重组：编辑入口从独立按钮并入能力格（.cap-cell 整格可点开编辑器），
  // 闸跟着钉新形状：能力格可点击（role=button）+ 状态开关仍在。
  // ⑫ 能力格的编辑入口落在「能力名那一组」而不是整格（2026-10-09）：整格可点时右侧那截
  //    死宽也是热区，点空白会莫名弹开编辑器。
  //    判据必须自己取 cap 那一格：`/role="button"/.test(one)` 早就被渠道格的触发器满足，
  //    拿它当「能力格还是按钮」是空转（变异对照：把 role 从能力格整条删掉，旧判据仍绿）。
  const capTd = (/<td class="cell-chips cap-cell[\s\S]*?<\/td>/.exec(one) || [""])[0];
  check("⑫ 能力格编辑入口在 .cap-chips 上（role=button + tabindex），td 自身不再是按钮",
    /<span class="cap-chips"[^>]*role="button"[^>]*tabindex="0"/.test(capTd) &&
      !/<td class="cell-chips cap-cell"[^>]*role="button"/.test(capTd),
    `片段 ${JSON.stringify(capTd.slice(0, 130))}`);
  check("⑫b 数据行仍有状态开关", /role="switch"/.test(one));
  check("⑬ 数据行仍渲染上下文输入框", /custom-input/.test(one));

  // ===== E+. 合并列与能力列的新形状（2026-10-08，先于实现写下，让它红在旧实现上）=====
  // ㉓ 渠道格摘要文本必须等于**真函数**对该行算出的值：模板里手拼「自动路由」也能让
  //    「看起来对」的截图通过，但两处口径迟早分叉（定案 Q10 的文案规则就没人守了）。
  const want0 = chanSummary(models[0]);
  // 只比**触发器自己的可见文本**，不用 one.includes(want0)：整格可点开的 aria-label 里也含同一串，
  // 用 includes 时把模板改成手拼字面量仍会绿（变异对照 C 实测到过这个空转）。
  const chanText = (/<span class="chan-sum[^"]*"[^>]*>([^<]*)</.exec(one) || [])[1];
  check(`㉓ 首行渠道格摘要文本 == chanSummary 算出的「${want0}」（实得「${chanText}」）`, chanText === want0,
    `片段 ${JSON.stringify(chanText)}`);
  check("㉓b 渠道格触发器带 role=button（可点开的键盘可达入口）", /class="chan-sum[^"]*"[^>]*role="button"/.test(one), "合并列必须是按钮，不是一个只读 chip");
  check(`㉓c 首行渠道格的 tone 类名 == chanTone 算出的「${chanTone(models[0])}」`, new RegExp(`class="chan-sum[^"]*${chanTone(models[0])}`).test(one),
    `实得 ${JSON.stringify((/class="(chan-sum[^"]*)"/.exec(one) || [])[1])}`);

  // ㉓h 「已排除 N」角标：摘要只报还剩几个（Q10a），被排除的数量得另有可见处，
  //     否则用户点了两颗渠道，格子上看不出这是刚改的还是本来就剩一个。
  check(`㉓h 有排除时格子里显出「已排除 ${models[0].excluded.length}」角标`, new RegExp(`已排除\\s*${models[0].excluded.length}`).test(one),
    `片段 ${JSON.stringify((/class="tag tag-warn chan-badge">([^<]*)</.exec(one) || [])[1])}`);

  // ㉓d 格子里每颗来源渠道都得有一个开关：状态列 1 颗 + 本行 sources.length 颗。
  //    少一颗就是「某条渠道在 popover 里根本没有可点的行」——静态检查与截图都看不见（要点开才知道）。
  const swN = (one.match(/role="switch"/g) || []).length;
  const wantSw = 1 + models[0].sources.length;
  check(`㉓d 一行内 role=switch 共 ${wantSw} 颗（状态 1 + 来源渠道 ${models[0].sources.length}）（实得 ${swN}）`, swN === wantSw,
    swN === 1 ? "popover 里的渠道开关不存在 ⇒ 排除态没有可点的控件" : `实得 ${swN}`);

  // ㉓e 行序策略直接判纯函数（SSR 只数得出行数，顺序对不对只能这样判）
  const ordRows = chanRows({ id: "x", sources: ["workbuddy", "trae"], override: "", excluded: ["workbuddy"] }, ["trae", "workbuddy"]);
  check("㉓e 行序=可用的在前、被排除的沉底", ordRows.map((r) => r.id).join(",") === "trae,workbuddy" && ordRows[1].on === false,
    ordRows.map((r) => `${r.id}:${r.on ? "on" : "off"}`).join(","));
  const mapRows = chanRows({ id: "y", sources: ["lobster", "trae"], override: "", excluded: [] }, ["trae", "lobster"], ["lobster"]);
  check("㉓e2 反向映射命中的渠道置顶并标「映射」", mapRows[0].id === "lobster" && mapRows[0].mapped === true,
    mapRows.map((r) => `${r.id}${r.mapped ? "(映射)" : ""}`).join(","));
  // ㉓e3 弹层打开期间冻结行序（2026-10-09）：不传 frozenIds 时 ㉓e 会沉底，
  //      传了就必须原地不动——否则用户鼠标底下换成本来就开的另一行，「点了没反应」的观感回来了。
  //      这条对「模板/渲染层根本没把 frozenIds 传下去」同样敏感：那样拿到的就是 ㉓e 的沉底序。
  const frozenRows = chanRows({ id: "x", sources: ["workbuddy", "trae"], override: "", excluded: ["workbuddy"] }, ["trae", "workbuddy"], [], ["workbuddy", "trae"]);
  check("㉓e3 冻结序在位：被排除的行不沉底，开关态照实翻转",
    frozenRows.map((r) => r.id).join(",") === "workbuddy,trae" && frozenRows[0].on === false && frozenRows[1].on === true,
    frozenRows.map((r) => `${r.id}:${r.on ? "on" : "off"}`).join(","));
  // ㉓e4 冻结名单外的行（这期间才出现的陈旧排除）只能落到末尾，不许插进冻结序中间把下面的行顶上去
  const frozenStale = chanRows({ id: "w", sources: ["trae", "workbuddy"], override: "", excluded: ["gone_chan"] }, ["trae", "workbuddy"], [], ["workbuddy", "trae"]);
  check("㉓e4 冻结名单外的行排在冻结序之后", frozenStale.map((r) => r.id).join(",") === "workbuddy,trae,gone_chan",
    JSON.stringify(frozenStale.map((r) => [r.id, r.stale])));
  // ㉓f 陈旧排除（渠道已不在 sources 里）要作为灰行出现在末尾，而不是被静默丢掉——
  //     丢掉就没有「一键清除」的入口，配置里那个幽灵 id 永远留着还没人知道。
  const staleRows = chanRows({ id: "z", sources: ["trae"], override: "", excluded: ["gone_chan"] }, ["trae", "workbuddy"]);
  check("㉓f 陈旧排除出现在行尾且标 stale", staleRows.length === 2 && staleRows[1].id === "gone_chan" && staleRows[1].stale === true,
    JSON.stringify(staleRows.map((r) => [r.id, r.stale])));

  // ㉔ 能力列全显：渲染出的 tag 数 == capabilityTags 的长度（旧实现是「首枚 + 计数角标」恒 2）
  const wantTags = capabilityTags(models[0]);
  const capCell = (/<td class="cell-chips cap-cell[\s\S]*?<\/td>/.exec(one) || [""])[0];
  const capTagN = (capCell.match(/class="tag /g) || []).length;
  check(`㉔ 能力格渲染 ${wantTags.length} 枚标签（图/视/思/工/↑）（实得 ${capTagN}）`, capTagN === wantTags.length,
    capTagN === 2 ? "仍是「首枚 + 计数角标」的旧实现" : `期望 ${wantTags.join("/")}，实得单元格 ${capCell.slice(0, 160)}`);
  check(`㉔b 能力格逐枚文案与真函数一致：${wantTags.join(" ")}`, wantTags.every((t) => capCell.includes(`>${t}<`)), capCell.slice(0, 200));

  // ㉕ 两态并存要能从可见类名区分（定案 Q2=B 的全部内容就是「用户看得出这是排除还是钉定」）
  const row3 = dataRows(a.rowsOut)[3] ? dataRows(a.rowsOut)[3].inner : "";
  check("㉕ 排除行有 chan-excluded、钉定行有 chan-pinned（两种态不同类名）",
    /chan-excluded/.test(one) && /chan-pinned/.test(row3),
    `首行 ${JSON.stringify((/class="(chan-sum[^"]*)"/.exec(one) || [])[1])} / 第4行 ${JSON.stringify((/class="(chan-sum[^"]*)"/.exec(row3) || [])[1])}`);

  // ㉕b/㉕c 钉定态的措辞是路由事实的一部分（2026-10-09）：modelOverrides 在 server.cjs:113
  //      只决定主渠道，备选队列照旧取「其余未排除的拥有者」（:713），主渠道降级时请求照转。
  //      写成「只走/固定走」等于对产品行为做假陈述，用户会在主渠道熔断后想不通请求为什么换了一家。
  const pinSum = chanSummary({ id: "p", sources: ["trae", "workbuddy"], override: "trae", excluded: [] });
  check(`㉕b 钉定摘要说「首选」而不说独占：「${pinSum}」`, /首选/.test(pinSum) && !/只走|固定走|仅走|独占/.test(pinSum));
  const viewSrc = fs.readFileSync(path.join(ROOT, FILE), "utf8");
  check("㉕c 视图里不再出现「只走这个渠道」/「固定走」两处独占式文案",
    !/只走这个渠道/.test(viewSrc) && !/固定走/.test(viewSrc),
    JSON.stringify((viewSrc.match(/.{0,20}(?:只走这个渠道|固定走).{0,20}/g) || []).slice(0, 3)));

  // ===== E++. 能力列全显的两条补充判据 =====
  // ㉗ 未知输出上限要显式给 ↑—：静默不显会让人以为这模型没有上限，而不是「不知道」
  const noOut = { ...models[0], maxOutputTokens: 0 };
  check("㉗ maxOutputTokens 未知时能力列含 ↑—", capabilityTags(noOut).includes("↑—"), JSON.stringify(capabilityTags(noOut)));
  // ㉘ 能力标签只接一个入参 —— 钉住「没有窄宽度降档」这个实测结论：
  //     表挂 min-width:860 + table-layout:fixed ⇒ 19.5% 的能力格最窄也有 ~157px 可视宽，
  //     而真表 176 行逐行扫下来内容最宽 112px，加上「覆盖」徽标按 146px 计（2026-10-09 回校后）
  //     ⇒ 仍放得下。谁要重新引入 compact 档，得先证明格子会窄过 146，
  //     而不是像最初那版一样在默认窗口就把「视」白白砍掉。
  check("㉘ capabilityTags 只接一个入参（降档机制已按实测删除）", capabilityTags.length === 1, `形参数 ${capabilityTags.length}`);

  // ===== F. 只虚拟化了目录这一张表 =====
  // 数 class="v-spacer" 而不是 v-spacer：后者在 CSS 选择器里也出现（tr.v-spacer），
  // 早先按 v-spacer 计数得到 4 就是这个原因（判据自身写错，不是实现错）。
  const src = fs.readFileSync(path.join(ROOT, FILE), "utf8");
  const inFile = (src.match(/class="v-spacer"/g) || []).length;
  const inCatalogTbody = (a.source.match(/class="v-spacer"/g) || []).length;
  check(`⑭ 占位行共 2 个且都在目录那张 tbody 里（文件内 ${inFile} / 目录表内 ${inCatalogTbody}）`,
    inFile === 2 && inCatalogTbody === 2, "别名/反向映射两张表被误挂占位行会多出不存在的行");

  // ===== G. 纯函数边界 =====
  check("⑮ winRange(0,…) 返回全零", JSON.stringify(winRange(0, 0, 0)) === JSON.stringify({ start: 0, end: 0, padTop: 0, padBottom: 0 }));
  check("⑯ winRange 越界钳位（firstVisible=99999）", (() => { const r = winRange(133, 99999, 7); return r.end === 133 && r.padBottom === 0; })());
  check(`⑰ viewRows 未量到（0）时按 MIN_ROWS 兜底，不渲染空窗`, (() => { const r = winRange(133, 0, 0); return r.end === Math.min(133, MIN_ROWS + OVERSCAN * 2); })());

  // ===== H. 补：变异测试暴露出来的三个漏检面 =====
  // ⑱ 渲染出的 colspan 必须等于表头实际列数（组件里写死 9 会在这条红）
  const colspanOf = (t) => { const m = /colspan="(\d+)"/.exec(t.inner); return m ? +m[1] : -1; };
  const aSpans = a.rowsOut.filter(isSpacer).map(colspanOf);
  const chSpans = ch.rowsOut.filter(isSpacer).map(colspanOf);
  check(`⑱ 占位行 colspan 与表头列数一致（全渠道 ${JSON.stringify(aSpans)} vs ${headCols}；单渠道 ${JSON.stringify(chSpans)} vs ${chHead}）`,
    aSpans.length > 0 && aSpans.every((v) => v === headCols) && chSpans.every((v) => v === chHead),
    "colspan 与表头列数脱钩 ⇒ 占位行撑出错误的列网格，整表错位");
  check(`⑲ 空态行 colspan 也等于表头列数（实得 ${colspanOf(empty.rowsOut[0] || {})} vs ${headCols}）`,
    colspanOf(empty.rowsOut[0] || {}) === headCols);
  // ⑳ 下界：overscan 太小会在滚动时先看到空白；MIN_ROWS 低于真实视口行数会首屏留白
  //    （真实视口实测 clientHeight 476 / ROW_H 60 ≈ 8 行）
  check(`⑳ OVERSCAN>=2 且 MIN_ROWS>=7（实得 ${OVERSCAN}/${MIN_ROWS}）`, OVERSCAN >= 2 && MIN_ROWS >= 7,
    "上界判据（≤25 行）抓不到「窗口缩到刚好等于视口」这种退化，必须单独钉下界");
  // ㉑ 窗口要真的把视口连同上下缓冲都盖住
  const w60 = winRange(133, 60, 7);
  check(`㉑ 视口 60..66 行被完整覆盖且两侧各有缓冲（实得 ${w60.start}..${w60.end - 1}）`,
    w60.start <= 60 - 2 && w60.end >= 60 + 7 + 2, "窗口没盖住视口 ⇒ 滚动时出现空洞");

  // ㉒ 滚动归零的 watch 必须同时覆盖 filter / activeTab / mainTab。
  //    这是绊线不是证明：SSR 片段渲染看不见「容器被 v-if 重建后 firstVisible 仍是旧行号」，
  //    那个缺陷是真机跑出来的（往返后表头下垫 3360px 空白）。这里只防以后有人把 mainTab 摘掉。
  const resetWatch = /watch\(\s*\[([^\]]*)\]\s*,\s*\(\)\s*=>\s*\{[\s\S]{0,200}?firstVisible\.value\s*=\s*0/.exec(src);
  const resetDeps = resetWatch ? resetWatch[1].split(",").map((s) => s.trim()) : [];
  check(`㉒ 归零 watch 覆盖 filter/activeTab/mainTab（实得 ${JSON.stringify(resetDeps)}）`,
    !!resetWatch && ["filter", "activeTab", "mainTab"].every((d) => resetDeps.includes(d)),
    "少一个依赖就会在对应场景下留旧窗口：mainTab 少了 ⇒ 切子 Tab 回来顶部一片空白");

  console.log(`\n${failures.length ? "FAIL " + failures.length + " 项" : "OK 模型目录虚拟滚动结构闸全过"}（共 ${pass + failures.length} 项）`);
  if (failures.length) process.exit(1);
}

main().catch((e) => { console.error("闸自身异常:", e.message); process.exit(1); });
