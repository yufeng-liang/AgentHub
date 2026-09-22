// 一期合并走查（R5 裁决：Task 2/3/4 的视觉验证合并成一次真实浏览器检查）
// 用打包版 + 临时 userData 起实例，经 CDP 逐页/逐 tab 检查三件事：
//   1) 懒加载视图是否真的挂上了（未解析的组件会退化成带连字符的未知标签）
//   2) 按需引入的组件/图标有没有对应 CSS 规则（缺样式 = unplugin 的 style/css 没进来）
//   3) 中文 locale、Task 6 两个新开关、窄容器下的卡片头回流
// 用法：npm run electron:pack 之后 node tools/phase1-browser-pass.cjs
"use strict";
// 探针卫生（规格 §八）必须先于一切产品代码 require：三件套指临时目录 + HKCU Run 快照兜底
const hy = require("./probe-hygiene.cjs")("phase1-browser-pass");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const fc = require("../scripts/dev-first-paint-check.cjs");
const sleep = fc.sleep;
const GW_PORT = 19531; // 自己的端口；9527 归用户那份实例

const out = (label, obj) => console.log(JSON.stringify({ label, ...(obj || {}) }));

function writeUserDataConfig(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify(
      {
        theme: "dark",
        schedule: { minimizeToTray: true, liteOnClose: true, launchHidden: false },
        proxy: { port: GW_PORT, bind: "127.0.0.1" },
      },
      null,
      2
    ),
    "utf8"
  );
}

// 页内一次性装好钩子：生产构建里 Vue 的解析告警被剥掉了，但动态 chunk 失败、
// 未捕获异常、console.error/warn 仍然会走这里
const HOOK = `(() => {
  if (window.__errs) return 'already';
  window.__errs = [];
  const push = (k, a) => window.__errs.push(k + ': ' + Array.from(a).map(x => {
    try { return typeof x === 'string' ? x : (x && x.stack ? x.stack.split('\\n')[0] : String(x)); } catch (e) { return '?'; }
  }).join(' | ').slice(0, 300));
  const we = console.error, ww = console.warn;
  console.error = function () { push('E', arguments); we.apply(console, arguments); };
  console.warn = function () { push('W', arguments); ww.apply(console, arguments); };
  window.addEventListener('error', e => push('WINERR', [e.message, e.filename]));
  window.addEventListener('unhandledrejection', e => push('REJ', [String(e.reason && e.reason.message || e.reason)]));
  return 'installed';
})()`;

const CSSCOLLECT = `(() => {
  // 每次重算，不缓存：懒块的 CSS 是随 chunk 晚到的，缓存会把它们一律误判成「缺样式」
  const set = new Set();
  const scan = (rules) => {
    for (const r of rules || []) {
      if (r.selectorText) for (const m of r.selectorText.matchAll(/\\.([a-zA-Z][\\w-]*)/g)) set.add(m[1]);
      if (r.cssRules) scan(r.cssRules);
    }
  };
  for (const sh of document.styleSheets) {
    try { scan(sh.cssRules); } catch (e) { window.__cssErr = String(e.message); }
  }
  window.__cssCls = set;
  return set.size;
})()`;

function probeExpr(tag) {
  return `(() => {
    const css = (function () {
      const set = new Set();
      const scan = (rules) => {
        for (const r of rules || []) {
          if (r.selectorText) for (const m of r.selectorText.matchAll(/\\.([a-zA-Z][\\w-]*)/g)) set.add(m[1]);
          if (r.cssRules) scan(r.cssRules);
        }
      };
      for (const sh of document.styleSheets) {
        try { scan(sh.cssRules); } catch (e) { window.__cssErr = String(e.message); }
      }
      return set;
    })();
    const host = (function () {
      const all = Array.from(document.querySelectorAll('.pages > *'));
      return all.find(e => e.offsetParent !== null) || all[0];
    })();
    const nodes = host ? [host].concat(Array.from(host.querySelectorAll('*'))) : [];
    const usedEl = new Set(), usedPh = new Set();
    for (const el of nodes) {
      if (!el.classList) continue;
      for (const c of el.classList) {
        if (c.indexOf('el-') === 0) usedEl.add(c);
        else if (c.indexOf('ph-') === 0) usedPh.add(c);
      }
    }
    // 未解析组件的特征：标签名本身带连字符（正常 EP 组件渲染成 div/span + class）
    const dashed = {};
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const t = el.tagName;
      if (t.indexOf('-') > 0) dashed[t.toLowerCase()] = (dashed[t.toLowerCase()] || 0) + 1;
    }
    const iconEls = Array.from(document.querySelectorAll('[class*="ph-"]'));
    const blank = iconEls.filter(e => {
      const c = getComputedStyle(e, '::before').content;
      return !c || c === 'none' || c === 'normal' || c === '""' || c === "''";
    }).map(e => Array.from(e.classList).filter(x => x.indexOf('ph-') === 0).join('+')).slice(0, 8);
    const cs = host ? getComputedStyle(host) : null;
    return JSON.stringify({
      tag: ${JSON.stringify(tag)},
      root: host ? (host.className || host.tagName).slice(0, 60) : '(none)',
      nodes: nodes.length,
      cssRules: css.size,
      textLen: (document.querySelector('.main') || { innerText: "" }).innerText.replace(/\\s+/g, "").length,
      usedEl: usedEl.size,
      missEl: Array.from(usedEl).filter(c => !css.has(c)).sort(),
      missPh: Array.from(usedPh).filter(c => !css.has(c)).sort(),
      icons: iconEls.length, blankIcons: blank,
      dashed: dashed,
      hostDisplay: cs ? cs.display : '?',
      errs: (window.__errs || []).length
    });
  })()`;
}

async function ev(wsUrl, expr, retries) {
  for (let i = 0; i <= (retries || 0); i++) {
    try {
      const r = await fc.evaluate(wsUrl, expr);
      if (typeof r === "string" && r.trim().startsWith("{")) return JSON.parse(r);
      return r;
    } catch (e) {
      if (i === (retries || 0)) throw e;
      await sleep(500);
    }
  }
}

const CLICK = (sel, text) => `(() => {
  const els = Array.from(document.querySelectorAll(${JSON.stringify(sel)}));
  const el = ${text ? `els.find(e => (e.textContent || "").indexOf(${JSON.stringify(text)}) >= 0)` : "els[0]"};
  if (!el) return 'NOTFOUND';
  el.click();
  return 'clicked:' + (el.textContent || '').trim().slice(0, 20);
})()`;

async function main() {
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-bpass-"));
  writeUserDataConfig(udd);
  let proc = null;
  const report = { pages: [], notes: [] };
  try {
    // 探针卫生（规格 §八）：APPDATA / AGENT_SKILLS_HOME / CCSWITCH_DB_PATH 已由 probe-hygiene
    // 在本文件第一行集中指进临时目录，spawn 整体继承即可，不再每个脚本手写一遍
    proc = require("node:child_process").spawn(
      fc.EXE,
      ["--remote-debugging-port=0", `--user-data-dir=${udd}`],
      {
        cwd: fc.ROOT,
        stdio: "ignore",
        detached: true,
        env: process.env,
      }
    );
    const port = await fc.readDevToolsPort(udd, proc);
    const page = await fc.pageTarget(port);
    fc.assertOwnPage(page);
    const ws = page.webSocketDebuggerUrl;
    out("launched", { pid: proc.pid, port, url: page.url.slice(0, 60) });
    await fc.probeUntilUsable(ws);
    out("hook", { r: await ev(ws, HOOK) });
    await sleep(2500);
    out("cssRulesClasses", { n: await ev(ws, CSSCOLLECT) });

    const mods = await ev(ws, `JSON.stringify(Array.from(document.querySelectorAll('.module-card')).map(e => (e.textContent || '').trim().slice(0, 14)))`);
    report.notes.push({ modules: mods });

    for (const m of JSON.parse(mods)) {
      const name = (m || "").trim();
      await ev(ws, CLICK(".module-card", name));
      await sleep(900);
      const tabs = await ev(ws, `JSON.stringify(Array.from(document.querySelectorAll('.tabs .tab')).map(e => (e.textContent || '').trim().slice(0, 12)))`);
      const tabList = JSON.parse(tabs);
      if (!tabList.length) {
        report.pages.push(await ev(ws, probeExpr(name + " (无 tab)")));
        continue;
      }
      for (const t of tabList) {
        await ev(ws, CLICK(".tabs .tab", (t || "").trim()));
        await sleep(900);
        report.pages.push(await ev(ws, probeExpr(name + " · " + t)));
      }
    }

    // 全局设置对话框（Task 6 的两个新开关在这里；`.tab-config` 是模块配置，不是它）
    await ev(ws, CLICK(".settings-btn"));
    await sleep(1500);
    const SWITCHES = `(() => {
      const rows = Array.from(document.querySelectorAll('.settings-dialog .set-row'));
      const want = ['关闭最小化到托盘', '关窗后释放界面内存', '启动不打开主界面'];
      const hit = {};
      for (const w of want) {
        const row = rows.find(r => (r.textContent || '').indexOf(w) >= 0);
        if (!row) { hit[w] = 'NOROW'; continue; }
        const sw = row.querySelector('.el-switch');
        hit[w] = {
          sw: !!sw,
          checked: sw ? sw.className.indexOf('is-checked') >= 0 : null,
          disabled: sw ? sw.className.indexOf('is-disabled') >= 0 : null,
          desc: ((row.querySelector('.set-desc') || {}).textContent || '').trim().slice(0, 60)
        };
      }
      return JSON.stringify({
        dialogOpen: !!document.querySelector('.settings-dialog'),
        rows: rows.length, hit,
        errs: (window.__errs || []).length
      });
    })()`;
    report.pages.push(await ev(ws, probeExpr("设置 · 通用")));
    const sw0 = await ev(ws, SWITCHES);
    report.notes.push({ settings: sw0 });
    // 耦合断言：关掉「关闭最小化到托盘」→ 两个新开关必须变灰；再打开恢复
    await ev(ws, `(() => { const r = Array.from(document.querySelectorAll('.settings-dialog .set-row')).find(x => (x.textContent||'').indexOf('关闭最小化到托盘') >= 0); if (!r) return 'NOROW'; r.querySelector('.el-switch').click(); return 'toggled-off'; })()`);
    await sleep(1200);
    report.notes.push({ couplingOff: await ev(ws, SWITCHES) });
    await ev(ws, `(() => { const r = Array.from(document.querySelectorAll('.settings-dialog .set-row')).find(x => (x.textContent||'').indexOf('关闭最小化到托盘') >= 0); if (!r) return 'NOROW'; r.querySelector('.el-switch').click(); return 'toggled-on'; })()`);
    await sleep(1200);
    report.notes.push({ couplingOn: await ev(ws, SWITCHES) });
    await ev(ws, `(() => { const b = document.querySelector('.settings-dialog .el-dialog__headerbtn'); if (b) b.click(); return b ? 'closed' : 'NOCLOSE'; })()`);
    await sleep(800);

    // 中文 locale：日期面板（懒块里的 el-date-picker）
    await ev(ws, CLICK(".module-card", "用量统计"));
    await sleep(800);
    await ev(ws, CLICK(".tabs .tab", "总览"));
    await sleep(1500);
    const dp = await ev(ws, `(() => {
      const inp = document.querySelector('.el-date-editor input');
      if (!inp) return JSON.stringify({ panel: 'NOINPUT' });
      inp.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      inp.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      inp.click(); inp.focus();
      return JSON.stringify({ opened: 'dispatched' });
    })()`);
    await sleep(1200);
    const panel = await ev(ws, `(() => {
      const p = document.querySelector('.el-picker-panel') || document.querySelector('.el-date-table');
      const txt = p ? (p.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90) : '';
      return JSON.stringify({ present: !!p, txt, weekday: (document.querySelector('.el-date-table th') || {}).textContent || '' });
    })()`);
    report.notes.push({ datePanel: dp, panel });
    await ev(ws, `document.activeElement && document.activeElement.blur()`);

    // 图表与占位：canvas 是否挂上、懒块是否进来、slot 高度是否守住
    report.notes.push({
      chart: await ev(ws, `JSON.stringify({
        canvas: document.querySelectorAll('.trend-chart canvas').length,
        slotH: (document.querySelector('.trend-slot') || { offsetHeight: -1 }).offsetHeight,
        headH: (document.querySelector('.card-head') || { offsetHeight: -1 }).offsetHeight,
        headOverflowX: (() => { const h = document.querySelector('.card-head'); return h ? h.scrollWidth - h.clientWidth : -1; })(),
        iconsBlank: Array.from(document.querySelectorAll('[class*=" ph-"], .ph')).filter(e => {
          const c = getComputedStyle(e, '::before').content; return !c || c === 'none' || c === 'normal' || c === '""';
        }).length,
        iconTotal: document.querySelectorAll('[class*="ph-"]').length
      })`),
    });

    // 暗色级联：EP 变量应被 html.dark 覆盖住
    report.notes.push({
      theme: await ev(ws, `JSON.stringify({
        htmlDark: document.documentElement.className,
        bodyBg: getComputedStyle(document.body).backgroundColor,
        elBg: getComputedStyle(document.documentElement).getPropertyValue('--el-bg-color').trim(),
        cardBg: (document.querySelector('.card') ? getComputedStyle(document.querySelector('.card')).backgroundColor : '?')
      })`),
    });

    // 窄容器回流（Task 4 minor 6）：把 .pages 压到 760px 再看卡头/图表槽
    await ev(ws, `(() => { const p = document.querySelector('.pages'); p.style.width = '760px'; p.style.maxWidth = '760px'; return 'narrow'; })()`);
    await sleep(600);
    report.notes.push({
      narrow: await ev(ws, `JSON.stringify({
        vw: document.querySelector('.pages').clientWidth,
        slotH: (document.querySelector('.trend-slot') || { offsetHeight: -1 }).offsetHeight,
        headH: (document.querySelector('.card-head') || { offsetHeight: -1 }).offsetHeight,
        headOverflowX: (() => { const h = document.querySelector('.card-head'); return h ? h.scrollWidth - h.clientWidth : -1; })(),
        kpiWrap: (() => { const k = document.querySelector('.kpi-row'); return k ? k.scrollHeight - k.clientHeight : -1; })()
      })`),
    });
    await ev(ws, `(() => { const p = document.querySelector('.pages'); p.style.width = ''; p.style.maxWidth = ''; return 'reset'; })()`);

    report.notes.push({ errs: await ev(ws, `JSON.stringify((window.__errs || []).slice(0, 40))`) });
    report.notes.push({ cssErr: await ev(ws, `JSON.stringify(window.__cssErr || null)`) });

    const bad = report.pages.filter(p => p.missEl.length || p.missPh.length || Object.keys(p.dashed).length);
    out("SUMMARY", {
      pagesVisited: report.pages.length,
      withMissingStyle: bad.length,
      withDashedTag: report.pages.filter(p => Object.keys(p.dashed).length).length,
      totalErrs: (JSON.parse(report.notes[report.notes.length - 2].errs) || []).length,
    });
    // 报告落临时目录（tools/ 已入库，不能让探针输出污染仓库；路径打印出来供人查阅）
    const outFile = path.join(hy.root, "phase1-browser-pass." + (proc && proc.pid) + ".json");
    fs.writeFileSync(outFile, JSON.stringify(report, null, 2), "utf8");
    out("reportWritten", { file: outFile });
    for (const p of report.pages) {
      out("page", { t: p.tag, root: p.root, n: p.nodes, txt: p.textLen, missEl: p.missEl, missPh: p.missPh, dashed: p.dashed });
    }
    for (const n of report.notes) out("note", n);
  } finally {
    if (proc && proc.pid) {
      try { await fc.killProcessTree(proc.pid); } catch (e) { out("kill-fail", { msg: e.message }); }
    }
    try { fc.removeProbeUserData(udd); } catch (e) { out("cleanup-fail", { msg: e.message }); }
  }
}

main().then(() => process.exit(0)).catch((e) => {
  console.error("BROWSER-PASS-FAILED:", e && e.message ? e.message : e);
  process.exit(1);
});
