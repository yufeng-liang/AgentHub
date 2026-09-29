// 页签切换体感取证探针（Phase 1 根因测量，不是门禁）。
// 量三件事并给出可归因的数字：
//   1) 每次切换后 1.6s 内的逐帧间隔（rAF）—— 卡顿的直接观测量
//   2) CDP Performance.getMetrics 的增量 —— 把时间归因到 Script / Layout / RecalcStyle / 合成分层
//   3) 三臂对照：基线 / 关掉 .page-anim / 保留动画但去掉 blur
// 隔离：probe-hygiene 把 APPDATA 指进临时目录；数据副本只带 config.json + Local State + proxy/rules
//       （即 catalog），**不带 stats.db 与号池凭据**，因此探针实例无法外呼真实账号。
// 用法：npm run electron:pack 之后  node scripts/probe-tab-switch-perf.cjs
'use strict';
if (require.main !== module) return;

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// hygiene 会改写 process.env.APPDATA，所以真实路径必须先抓下来
const REAL_APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const hy = require('../tools/probe-hygiene.cjs')('probe-tab-switch-perf');

const fc = require('./dev-first-paint-check.cjs');
const { spawn } = require('node:child_process');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
// DIST=1：跑「刚 npm run build 出来的 dist/」而不是 release/ 里的旧 asar。
// 走这条是因为 electron/main.cjs 在 !app.isPackaged 时加载 VITE_DEV_SERVER_URL，
// 于是可以用 vite preview 伺服 prod 编译产物 + 仓库内 electron 指过去——
// 既拿到压缩后的真实代码，又不用重打包（重打包要先杀掉用户正在运行的实例）。
const USE_DIST = !!process.env.DIST;
const EXE = USE_DIST ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe') : fc.EXE;
const PREVIEW_PORT = 4173;
const sleep = fc.sleep;
const DATA_DIR = path.join(process.env.APPDATA, 'AgentHub');
const GW_PORT = 19537; // 自己的端口；9527 归用户那份实例

// ---------------------------------------------------------------- 数据副本
function seedDataDir() {
  fs.mkdirSync(path.join(DATA_DIR, 'proxy'), { recursive: true });
  const src = path.join(REAL_APPDATA, 'AgentHub');
  const copyFile = (rel) => {
    const from = path.join(src, rel);
    if (!fs.existsSync(from)) { console.log('  跳过（真身没有）:', rel); return; }
    const to = path.join(DATA_DIR, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  };
  copyFile('Local State');
  // catalog 是本次测量的内容来源；config.json 提供管理态（disabledModels/modelCustom 等）
  const rulesSrc = path.join(src, 'proxy', 'rules');
  const rulesDst = path.join(DATA_DIR, 'proxy', 'rules');
  fs.mkdirSync(rulesDst, { recursive: true });
  let n = 0;
  for (const f of fs.readdirSync(rulesSrc)) {
    if (!f.endsWith('.json')) continue;
    fs.copyFileSync(path.join(rulesSrc, f), path.join(rulesDst, f));
    n++;
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(src, 'config.json'), 'utf8'));
  cfg.proxy = cfg.proxy || {};
  cfg.proxy.port = GW_PORT;
  cfg.schedule = cfg.schedule || {};
  cfg.schedule.launchHidden = false; // 探针要真窗口才有帧
  cfg.schedule.autoStart = false;    // 不碰 HKCU Run
  cfg.proxy.checkinAuto = false;
  fs.writeFileSync(path.join(DATA_DIR, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8');
  console.log(`数据副本就绪：rules ${n} 个 json、catalog 渠道 ${Object.keys(JSON.parse(fs.readFileSync(path.join(rulesDst, 'catalog.json'), 'utf8'))).length} 家`);
}

// ---------------------------------------------------------------- CDP 客户端
function cdpConnect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let seq = 0;
    const pending = new Map();
    const client = {
      events: [],
      send(method, params = {}) {
        return new Promise((res, rej) => {
          const id = ++seq;
          const to = setTimeout(() => { pending.delete(id); rej(new Error(`${method} 12s 无响应`)); }, 20000);
          pending.set(id, { res, rej, to });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close() { try { ws.close(); } catch { /* noop */ } },
    };
    const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 15000);
    ws.on('error', (e) => { clearTimeout(timer); reject(e); });
    ws.on('open', () => { clearTimeout(timer); resolve(client); });
    ws.on('message', (buf) => {
      let msg;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      if (!msg) return;
      if (msg.id === undefined) { client.events.push(msg); return; }
      const p = pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.to);
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(`${msg.error.message}`));
      else p.res(msg.result);
    });
  });
}

// ---------------------------------------------------------------- 页内装置
const INSTALL = `(() => {
  if (window.__probe) return 'already';
  window.__probe = true;
  window.__errs = [];
  const pw = console.warn, pe = console.error;
  console.warn = function () { window.__errs.push('W: ' + Array.from(arguments).map(String).join(' ').slice(0, 160)); pw.apply(console, arguments); };
  console.error = function () { window.__errs.push('E: ' + Array.from(arguments).map(String).join(' ').slice(0, 160)); pe.apply(console, arguments); };
  window.addEventListener('error', e => window.__errs.push('WINERR: ' + e.message + ' @' + (e.filename || '').slice(-40)));
  window.addEventListener('unhandledrejection', e => window.__errs.push('REJ: ' + String(e.reason && e.reason.message || e.reason).slice(0, 160)));
  window.__frames = [];
  window.__long = [];
  let last = 0;
  const tick = (t) => { if (last) window.__frames.push(t - last); last = t; requestAnimationFrame(tick); };
  requestAnimationFrame((t) => { last = t; requestAnimationFrame(tick); });
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__long.push(Math.round(e.duration));
    }).observe({ entryTypes: ['longtask'] });
  } catch (err) { window.__noLT = String(err.message); }
  return 'installed';
})()`;

function clickTabExpr(name) {
  return `(() => {
    const all = Array.from(document.querySelectorAll('.tabs .tab, .tabs-scroll .tab, nav .tab'));
    const t = all.find(b => b.textContent.trim() === ${JSON.stringify(name)});
    if (!t) return 'NOTAB|found=' + JSON.stringify(all.map(b => b.textContent.trim()).slice(0, 14));
    window.__frames.length = 0; window.__long.length = 0;
    t.click();
    return 'ok';
  })()`;
}

const DUMP = `(() => {
  const q = (s) => document.querySelectorAll(s).length;
  const host = Array.from(document.querySelectorAll('.pages > *')).find(e => e.offsetParent !== null);
  return JSON.stringify({
    title: document.title,
    url: location.href.slice(0, 90),
    app: q('.app'), main: q('.main'), nav: q('nav'), tabs: q('.tabs'), tabBtn: q('.tab'),
    moduleCards: q('.module-card'), pagesKids: q('.pages > *'),
    mcTexts: Array.from(document.querySelectorAll('.module-card')).map(e => JSON.stringify((e.innerText || '').replace(/\\s+/g, '|').slice(0, 40))),
    navTexts: Array.from(document.querySelectorAll('nav')).map(n => n.className + ' :: ' + Array.from(n.children).map(c => JSON.stringify((c.innerText||'').replace(/\\s+/g,'|').slice(0,20))).join(' ')),
    visibleRoot: host ? (host.className || host.tagName).slice(0, 70) : '(none)',
    visibleText: host ? (host.innerText || '').replace(/\\s+/g, ' ').slice(0, 160) : '',
    bodyText: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 260),
    errs: window.__errs || '(no hook)',
  }, null, 1);
})()`;

const STATE = `(() => {
  const host = Array.from(document.querySelectorAll('.pages > *')).find(e => e.offsetParent !== null);
  const cnt = (el) => el ? el.querySelectorAll('*').length + 1 : 0;
  const tip = document.querySelectorAll('.el-popper').length;
  return {
    root: host ? (host.className || host.tagName).split(/\\s+/)[0] : '(none)',
    dom: cnt(host),
    total: document.querySelectorAll('*').length,
    poppers: tip,
    selects: host ? host.querySelectorAll('.el-select').length : 0,
    rows: host ? host.querySelectorAll('tbody tr').length : 0,
    text: host ? (host.innerText || '').slice(0, 0) : ''
  };
})()`;

const med = (arr) => { const v = arr.slice().sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };

function stats(frames) {  const a = [...frames].sort((x, y) => x - y);
  const q = (p) => (a.length ? +a[Math.min(a.length - 1, Math.floor(a.length * p))].toFixed(1) : 0);
  return {
    n: a.length,
    max: a.length ? +a[a.length - 1].toFixed(1) : 0,
    p95: q(0.95),
    over33: frames.filter((f) => f > 33).length,
    over50: frames.filter((f) => f > 50).length,
    sum: +frames.reduce((s, f) => s + f, 0).toFixed(0),
  };
}

async function getMetrics(c) {
  const r = await c.send('Performance.getMetrics');
  const m = {};
  for (const e of r.metrics) m[e.name] = e.value;
  return m;
}
const MS = ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration', 'StyleApplyDuration'];
const CT = ['LayoutCount', 'RecalcStyleCount', 'HitTestCount', 'NodeCount', 'JSEventListeners'];
function diffMetrics(a, b) {
  const o = {};
  for (const k of MS) if (b[k] !== undefined && a[k] !== undefined) o[k] = +((b[k] - a[k]) * 1000).toFixed(1);
  for (const k of CT) if (b[k] !== undefined && a[k] !== undefined) o[k] = +(b[k] - a[k]).toFixed(0);
  return o;
}

async function measure(c, name, settleMs = 1700) {
  // 幂等补装：DIST 模式下页面在首次注入后还会再导航一次，钩子会随旧 window 一起丢掉
  await c.send('Runtime.evaluate', { expression: INSTALL, returnByValue: true });
  const m0 = await getMetrics(c);
  const r = await c.send('Runtime.evaluate', { expression: clickTabExpr(name), returnByValue: true });
  if (typeof r.result.value === 'string' && r.result.value.startsWith('NOTAB')) {
    return { tab: name, notab: r.result.value.slice(0, 220) };
  }
  await sleep(settleMs);
  // 先只读帧（这次 evaluate 必须足够便宜：它自己就落在被测窗口里）。
  // DOM 普查（querySelectorAll('*') 遍历数千节点）挪到帧读取之后单独做，
  // 否则普查本身就是个上百毫秒的长任务，会被算成「切换卡顿」——上一版就栽在这里。
  const s = await c.send('Runtime.evaluate', {
    expression: `(() => { const f = window.__frames.slice(), l = window.__long.slice(); window.__frames.length = 0; window.__long.length = 0; return JSON.stringify({f, l}); })()`,
    returnByValue: true,
  });
  const m1 = await getMetrics(c);
  if (!s.result || s.result.value === undefined) {
    throw new Error(`帧读数取不到（钩子没装上或页面已换）：${JSON.stringify((s.result && (s.result.description || s.result.subtype)) || s)}`);
  }
  const j = JSON.parse(s.result.value);
  const st = await c.send('Runtime.evaluate', { expression: STATE, returnByValue: true });
  let state = {};
  try { state = JSON.parse(st.result.value); } catch { /* 忽略普查失败 */ }
  return { tab: name, ...stats(j.f), long: j.l, metrics: diffMetrics(m0, m1), ...state };
}

async function waitFor(c, label, truthyExpr, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = await c.send('Runtime.evaluate', { expression: `(${truthyExpr}) ? 1 : 0`, returnByValue: true });
    if (r.result.value === 1) { console.log('就绪:', label); return true; }
    if (Date.now() > deadline) { console.log('超时:', label); return false; }
    await sleep(400);
  }
}

// 空转基线：不点任何东西，量同样长的窗口。用来把「背景常驻成本」从「切换成本」里减掉。
async function idle(c, ms = 1700) {
  await c.send('Runtime.evaluate', { expression: `(() => { window.__frames.length = 0; window.__long.length = 0; return 1 })()`, returnByValue: true });
  const m0 = await getMetrics(c);
  await sleep(ms);
  const m1 = await getMetrics(c);
  const s = await c.send('Runtime.evaluate', {
    expression: `JSON.stringify({frames: window.__frames, long: window.__long})`, returnByValue: true,
  });
  const j = JSON.parse(s.result.value);
  return { ...stats(j.frames), long: j.long, metrics: diffMetrics(m0, m1) };
}

async function applyCss(c, css) {
  await c.send('Runtime.evaluate', {
    expression: `(() => {
      document.querySelectorAll('style[id^="arm"]').forEach(e => e.remove());
      const css = ${JSON.stringify(css || '')};
      if (css) {
        const st = document.createElement('style');
        st.id = 'armLive';
        st.textContent = css;
        document.head.appendChild(st);
      }
      return 1;
    })()`,
    returnByValue: true,
  });
}

// 用页面自己的搜索框改行数 —— 行数是自变量，切换成本应当随之线性变化
async function setFilter(c, kw) {
  const r = await c.send('Runtime.evaluate', {
    expression: `((kw) => {
      const i = document.querySelector('.search-input');
      if (!i) return 'NOINPUT';
      const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      d.set.call(i, kw);
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return 'ok';
    })(${JSON.stringify(kw)})`,
    returnByValue: true,
  });
  return r.result.value;
}

// 从 CSSOM 里真的删掉匹配到的规则（注入覆盖式 CSS 做不到「删除」，只能加权重）
async function deleteRulesMatching(c, needle, label) {
  const r = await c.send('Runtime.evaluate', {
    expression: `(() => {
      let removed = 0; const samples = [];
      const walk = (list) => {
        for (let i = list.length - 1; i >= 0; i--) {
          const ru = list[i];
          if (ru.cssRules) { walk(ru.cssRules); continue; }
          const sel = ru && ru.selectorText;
          if (sel && sel.indexOf(${JSON.stringify(needle)}) >= 0 && sel.indexOf('*') >= 0) {
            if (samples.length < 4) samples.push(sel.slice(0, 70));
            try { list.deleteRule(i); removed++; } catch (e) {}
          }
        }
      };
      for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch (e) {} }
      return JSON.stringify({ removed, samples });
    })()`,
    returnByValue: true,
  });
  console.log(`删规则[${label}] needle=${needle} →`, r.result.value);
  return JSON.parse(r.result.value).removed;
}

// 小页 ↔ 小页：模型目录大页挂载但隐藏，量的是「无关页面之间」的切换成本
async function smallPagePairCost(c, reps = 3) {
  const away = [];
  for (let i = 0; i < reps; i++) {
    await measure(c, '总览', 700);
    away.push(await measure(c, 'API Keys'));
  }
  const g = away.filter((x) => !x.notab);
  return {
    maxFrame_ms: med(g.map((x) => x.max)),
    longTask_ms: med(g.map((x) => (x.long.length ? Math.max(...x.long) : 0))),
    RecalcStyle_ms: med(g.map((x) => x.metrics.RecalcStyleDuration)),
    Layout_ms: med(g.map((x) => x.metrics.LayoutDuration)),
    Script_ms: med(g.map((x) => x.metrics.ScriptDuration)),
    Task_ms: med(g.map((x) => x.metrics.TaskDuration)),
    totalDom: g.length ? g[0].total : null,
  };
}

// tracing 自时长归因：X 事件按线程建栈，父事件减去子事件之和 = self time
function selfBy(events) {
  const byThread = new Map();
  for (const e of events) {
    if (e.ph !== 'X' || typeof e.dur !== 'number' || e.dur <= 0) continue;
    const k = e.pid + ':' + e.tid;
    if (!byThread.has(k)) byThread.set(k, []);
    byThread.get(k).push(e);
  }
  let best = null;
  for (const [k, evs] of byThread) {
    if (!evs.some((e) => e.name === 'RunTask')) continue;
    if (!best || evs.length > best.length) best = evs;
  }
  if (!best) return { thread: '(无 RunTask)', threads: byThread.size, top: [] };
  best.sort((a, b) => a.ts - b.ts || (b.ts + b.dur) - (a.ts + a.dur));
  const self = new Map();
  const stack = [];
  const close = (f) => {
    const s = Math.max(0, f.dur - f.__child);
    self.set(f.name, (self.get(f.name) || 0) + s);
  };
  for (const e of best) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur <= e.ts) close(stack.pop());
    if (stack.length) stack[stack.length - 1].__child += e.dur;
    e.__child = 0;
    stack.push(e);
  }
  while (stack.length) close(stack.pop());
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([name, us]) => ({ name, ms: +(us / 1000).toFixed(1) }));
  return { thread: best.length, top };
}

async function traceOnce(c, label) {
  c.events.length = 0;
  await c.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: { includedCategories: ['devtools.timeline', 'blink', 'v8', 'disabled-by-default-devtools.timeline'] },
    bufferUsageReporting: false,
  });
  await sleep(250);
  await measure(c, '总览', 700);
  const r = await measure(c, 'API Keys');
  await c.send('Tracing.end');
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && !c.events.some((e) => e.method === 'Tracing.tracingComplete')) await sleep(250);
  const evs = [];
  for (const e of c.events) if (e.method === 'Tracing.dataCollected' && Array.isArray(e.params.value)) evs.push(...e.params.value);
  console.log(`\n[trace ${label}] 事件 ${evs.length} 个 · 本次切换 maxFrame=${r.max} longTask=${JSON.stringify(r.long)}`);
  return selfBy(evs);
}

// CPU 采样归因：把 timeDeltas 摊到 samples 对应的节点上，按函数名聚合自时长
function profileTop(profile, topN = 16) {
  const byId = new Map((profile.nodes || []).map((n) => [n.id, n]));
  const self = new Map();
  let total = 0;
  for (let i = 0; i < (profile.samples || []).length; i++) {
    const n = byId.get(profile.samples[i]);
    if (!n) continue;
    const dt = Math.abs((profile.timeDeltas && profile.timeDeltas[i]) || 0) / 1000;
    total += dt;
    const cf = n.callFrame || {};
    const key = (cf.functionName || '(anonymous)') + ' @' + String(cf.url || '').split('/').pop() + ':' + ((cf.lineNumber || 0) + 1);
    self.set(key, (self.get(key) || 0) + dt);
  }
  return { totalMs: +total.toFixed(0), top: [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, topN).map(([fn, ms]) => ({ fn, ms: +ms.toFixed(1) })) };
}

// 沿包含时间最大的分支自顶向下走，打印出「这 180ms 到底挂在谁下面」的路径
function profilePaths(profile, branches = 3, depth = 9) {
  const byId = new Map((profile.nodes || []).map((n) => [n.id, n]));
  const self = new Map();
  for (let i = 0; i < (profile.samples || []).length; i++) {
    const id = profile.samples[i];
    const dt = Math.abs((profile.timeDeltas && profile.timeDeltas[i]) || 0) / 1000;
    self.set(id, (self.get(id) || 0) + dt);
  }
  const incl = new Map();
  const calc = (id, seen) => {
    if (seen.has(id)) return 0;
    seen.add(id);
    const n = byId.get(id);
    if (!n) return 0;
    let v = self.get(id) || 0;
    for (const ch of n.children || []) v += calc(ch, seen);
    incl.set(id, v);
    return v;
  };
  const roots = (profile.nodes || []).filter((n) => !n.parent);
  for (const r of roots) calc(r.id, new Set());
  const label = (n) => {
    const cf = n.callFrame || {};
    return (cf.functionName || '(anon)') + '@' + String(cf.url || '').split('/').pop() + ':' + ((cf.lineNumber || 0) + 1);
  };
  const out = [];
  const walk = (id, path) => {
    const n = byId.get(id);
    if (!n) return;
    path.push(label(n) + ' incl=' + (incl.get(id) || 0).toFixed(0) + 'ms self=' + (self.get(id) || 0).toFixed(1) + 'ms');
    if (path.length >= depth) return;
    const kids = (n.children || []).map((c) => byId.get(c)).filter(Boolean)
      .sort((a, b) => (incl.get(b.id) || 0) - (incl.get(a.id) || 0));
    if (!kids.length || (incl.get(kids[0].id) || 0) < 8) return;
    walk(kids[0].id, path);
  };
  for (const r of roots.sort((a, b) => (incl.get(b.id) || 0) - (incl.get(a.id) || 0)).slice(0, branches)) {
    const p = [];
    walk(r.id, p);
    out.push(p.join('\n      '));
  }
  return out;
}

// 探针实例的网关子进程是 detached 起的，taskkill /T 沿父链收不到它，会把 GW_PORT 一直占着
// （实测占住 19537 后 scripts/dev-gateway-pipe-test.cjs 的 ⑦-b 稳定红）。
// 只按「监听在我们自己端口上 且 命令行含 gateway.cjs」双条件收，绝不按镜像名扫。
function reapOwnGateway(port) {
  const out = require('node:child_process').execSync('netstat -ano', { encoding: 'utf8' });
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (line.includes(`127.0.0.1:${port}`) && /LISTENING/i.test(line)) {
      const p = line.trim().split(/\s+/).pop();
      if (/^\d+$/.test(p || '') && p !== '0') pids.add(p);
    }
  }
  for (const pid of pids) {
    let cmd = '';
    try {
      cmd = require('node:child_process').execSync(
        `powershell.exe -NoProfile -Command "(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine"`,
        { encoding: 'utf8' }
      );
    } catch { /* 查不到就不动 */ }
    if (/gateway\.cjs/.test(cmd)) {
      try { require('node:child_process').execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); console.log(`收掉残留网关子进程 pid=${pid}（占 ${port}）`); }
      catch (e) { console.log(`残留网关子进程 pid=${pid} 没杀掉：${e.message}`); }
    } else if (cmd.trim()) {
      console.log(`端口 ${port} 上的 pid=${pid} 不是探针的网关（命令行不含 gateway.cjs），不动`);
    }
  }
}

async function main() {
  if (!fs.existsSync(EXE)) throw new Error(`找不到 ${EXE}——DIST 模式要先 npm run build；打包模式要先 npm run electron:pack`);
  seedDataDir();
  let preview = null;
  const env = { ...process.env };
  if (USE_DIST) {
    env.VITE_DEV_SERVER_URL = `http://localhost:${PREVIEW_PORT}`;
    preview = spawn(process.execPath, [
      path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
      'preview', '--port', String(PREVIEW_PORT), '--strictPort',
    ], { cwd: ROOT, stdio: 'ignore', detached: true, env });
    preview.on('error', (e) => { preview.spawnError = e; });
    // 等静态服务器真的能应答，否则 Electron 会白屏
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://localhost:${PREVIEW_PORT}/index.html`);
        if (r.ok) break;
      } catch { /* 还没起来 */ }
      await sleep(300);
    }
  }
  const proc = spawn(EXE, [
    ...(USE_DIST ? ['.'] : []),
    `--remote-debugging-port=0`,
    `--user-data-dir=${DATA_DIR}`,
    // 窗口被别的窗口盖住时 Chromium 会节流 rAF，帧数据就废了
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
  ], { cwd: ROOT, stdio: 'ignore', detached: true, env });
  proc.on('error', (e) => { proc.spawnError = e; });

  let err = null;
  let c = null;
  try {
    const port = await fc.readDevToolsPort(DATA_DIR, proc);
    const page = await fc.pageTarget(port);
    fc.assertOwnPage(page);
    c = await cdpConnect(page.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Performance.enable');
    console.log('探针实例 pid=' + proc.pid + ' cdp=' + port);

    await c.send('Runtime.evaluate', { expression: INSTALL, returnByValue: true });
    // 侧栏在 app.load() 落定前是空的，必须等卡片出现再点（上一轮 NOMOD 就是这么来的）
    await waitFor(c, '侧栏模块卡', `document.querySelectorAll('.module-card').length >= 4`);
    const modClick = await c.send('Runtime.evaluate', {
      expression: `(() => { const m = Array.from(document.querySelectorAll('.module-card')).find(e => e.textContent.includes('反代网关')); if (m) m.click(); return m ? 'ok' : 'NOMOD'; })()`,
      returnByValue: true,
    });
    console.log('模块点击:', modClick.result.value);
    await waitFor(c, '反代网关页签条', `Array.from(document.querySelectorAll('.tab')).some(b => b.textContent.trim() === '模型目录')`);
    // 等常驻网关子进程能答 proxy_models（不靠导航到页面来判定，免得把「首次挂载」那次消耗掉）
    let modelCount = -1;
    for (let i = 0; i < 50; i++) {
      try {
        const r = await c.send('Runtime.evaluate', {
          expression: `window.agenthub.invoke('proxy_models').then(a => Array.isArray(a) ? a.length : -1).catch(() => -2)`,
          awaitPromise: true, returnByValue: true,
        });
        modelCount = r.result.value;
        if (modelCount > 20) break;
      } catch { /* 子进程还没就绪 */ }
      await sleep(500);
    }
    console.log('proxy_models 返回条数:', modelCount);
    const dump = await c.send('Runtime.evaluate', { expression: DUMP, returnByValue: true });
    console.log('DOM 现状:', dump.result.value);
    if (process.env.DIAG) { await c.send('Runtime.evaluate', { expression: `document.title = 'diag-done'`, returnByValue: true }); return; }

    if (process.env.EXP15) {
      // 定「切进一个页要多久」的地板在哪：如果模型目录的 67ms 和其它页同量级，
      // 那就不是这一页的问题，继续砍它的节点没有意义。
      console.log('\n===== 实验十五：逐页切换成本地板（7 次采样取 min/med）=====');
      const REPS = Number(process.env.REPS || 7);
      const tabs = ['总览', 'API Keys', '自定义提供商', '号池', '积分到期', '模型目录', '用量统计', '号池同步', '生态接入'];
      for (const t of tabs) await measure(c, t, 900); // 先全部挂载，排除冷挂载
      for (const t of tabs) {
        const runs = [];
        for (let i = 0; i < REPS; i++) {
          await measure(c, '总览', 600);
          if (t !== '总览') runs.push(await measure(c, t));
          else runs.push(await measure(c, t));
        }
        const g = runs.filter((x) => !x.notab);
        const mdf = (f) => { const v = g.map(f).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
        console.log(JSON.stringify({
          tab: t,
          maxFrame_min: Math.min(...g.map((x) => x.max)),
          maxFrame_med: mdf((x) => x.max),
          recalc_min: Math.min(...g.map((x) => x.metrics.RecalcStyleDuration)),
          layout_min: Math.min(...g.map((x) => x.metrics.LayoutDuration)),
          task_min: Math.min(...g.map((x) => x.metrics.TaskDuration)),
        }));
      }
      return;
    }

    if (process.env.EXP14) {
      // 多次采样 + 取最小值：本机同时跑着用户那份实例，单样本的最长帧噪声实测 ±67ms
      // （同一份产物两次测出 99.9 与 166.7），只有 min 能当纯计算成本用。
      console.log('\n===== 实验十四：切进模型目录（多次采样）=====');
      const REPS = Number(process.env.REPS || 7);
      await setFilter(c, '');
      await measure(c, '模型目录', 1500);
      const runs = [];
      for (let i = 0; i < REPS; i++) {
        await measure(c, '总览', 700);
        runs.push(await measure(c, '模型目录'));
      }
      const g = runs.filter((x) => !x.notab);
      const mn = (f) => Math.min(...g.map(f));
      // 不叫 med：main() 里后面还有一句 const med = ...，同名会在 TDZ 里炸
      const md = (f) => { const v = g.map(f).sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
      console.log(JSON.stringify({
        reps: g.length,
        rows: g[0].rows,
        dom: g[0].dom,
        maxFrame_min: mn((x) => x.max),
        maxFrame_med: md((x) => x.max),
        recalc_min: mn((x) => x.metrics.RecalcStyleDuration),
        recalc_med: md((x) => x.metrics.RecalcStyleDuration),
        layout_min: mn((x) => x.metrics.LayoutDuration),
        task_min: mn((x) => x.metrics.TaskDuration),
        framesOver33_med: md((x) => x.over33),
      }));
      return;
    }

    if (process.env.EXP13) {
      console.log('\n===== 实验十三：单行 DOM 构成拆解 =====');
      await measure(c, '模型目录', 1500);
      const r = await c.send('Runtime.evaluate', {
        expression: `(() => {
          const tr = document.querySelector('.models-card tbody tr:not(.v-spacer)');
          if (!tr) return 'NOROW';
          const all = [tr, ...tr.querySelectorAll('*')];
          const byTag = {};
          for (const e of all) { const k = e.tagName.toLowerCase(); byTag[k] = (byTag[k]||0)+1; }
          const byCls = {};
          for (const e of all) for (const c of e.classList) if (/^el-/.test(c)) byCls[c] = (byCls[c]||0)+1;
          const perCell = Array.from(tr.children).map((td, i) => ({ i, n: td.querySelectorAll('*').length + 1 }));
          return JSON.stringify({
            rowNodes: all.length,
            byTag, elClasses: byCls,
            dropdownItemsInDom: document.querySelectorAll('.el-select-dropdown__item').length,
            tooltipPoppers: document.querySelectorAll('.el-popper').length,
            perCell,
            totalDoc: document.querySelectorAll('*').length,
            mountedRows: document.querySelectorAll('.models-card tbody tr:not(.v-spacer)').length,
          });
        })()`,
        returnByValue: true,
      });
      console.log(r.result.value);
      return;
    }

    if (process.env.EXP12) {
      console.log('\n===== 实验十二：真机滚动行为（SSR 闸证不了这一段）=====');
      await measure(c, '模型目录', 1500);
      const probe = async () => c.send('Runtime.evaluate', {
        expression: `(() => {
          const sc = document.querySelector('.models-card .table-scroll');
          if (!sc) return { err: 'NOSCROLLER' };
          const trs = Array.from(sc.querySelectorAll('tbody tr'));
          const data = trs.filter(t => !/v-spacer/.test(t.className));
          const pad = trs.filter(t => /v-spacer/.test(t.className)).map(t => Math.round(t.getBoundingClientRect().height));
          const first = data[0] ? (data[0].querySelector('.mono') || {}).textContent : null;
          const last = data[data.length - 1] ? (data[data.length - 1].querySelector('.mono') || {}).textContent : null;
          return { scrollTop: Math.round(sc.scrollTop), scrollH: sc.scrollHeight, clientH: sc.clientHeight,
                   dataRows: data.length, pads: pad, first, last };
        })()`,
        returnByValue: true,
      });
      const scrollTo = async (px) => {
        await c.send('Runtime.evaluate', {
          expression: `(() => { const sc=document.querySelector('.models-card .table-scroll'); sc.scrollTop=${px}; sc.dispatchEvent(new Event('scroll')); return sc.scrollTop; })()`,
          returnByValue: true,
        });
        await sleep(250);
        return (await probe()).result.value;
      };
      console.log('顶部:', JSON.stringify((await probe()).result.value));
      for (const px of [1200, 3600, 6000, 8100]) console.log(`scrollTop=${px}:`, JSON.stringify(await scrollTo(px)));
      // 搜索后必须回到顶部，否则窗口指向越界处会一片空白
      await scrollTo(4000);
      await setFilter(c, 'seed');
      await sleep(300);
      console.log('搜索后（应回顶、行数≤窗口）:', JSON.stringify((await probe()).result.value));
      await setFilter(c, '');
      await sleep(300);
      console.log('清空搜索后:', JSON.stringify((await probe()).result.value));
      // 眼见为实：占位 <tr colspan> 在 table-layout:fixed 的表里会不会把列宽带偏
      await c.send('Page.enable');
      const shot = async (tag) => {
        const p = await c.send('Page.captureScreenshot', { format: 'png' });
        const f = path.join(hy.root, `models-${tag}.png`);
        fs.writeFileSync(f, Buffer.from(p.data, 'base64'));
        console.log('截图:', f);
      };
      const colWidths = await c.send('Runtime.evaluate', {
        expression: `(() => {
          const t = document.querySelector('.models-card table');
          const th = Array.from(t.querySelectorAll('thead th')).map(e => +e.getBoundingClientRect().width.toFixed(1));
          const td = Array.from(t.querySelectorAll('tbody tr:not(.v-spacer)')[0].querySelectorAll('td')).map(e => +e.getBoundingClientRect().width.toFixed(1));
          return JSON.stringify({ th, td, same: th.length === td.length && th.every((v, i) => Math.abs(v - td[i]) < 1.5) });
        })()`,
        returnByValue: true,
      });
      console.log('列宽（表头 vs 首个数据行）:', colWidths.result.value);
      await scrollTo(0);
      await shot('top');
      await scrollTo(3600);
      await shot('mid');
      // 子 Tab 往返：滚动容器在 v-if 里会被销毁重建，函数式 ref 必须重新挂上 ResizeObserver，
      // 否则回到目录页后窗口不再跟手（表现是「滚下去是空的」）
      const clickMainTab = async (name) => {
        await c.send('Runtime.evaluate', {
          expression: `(() => { const b = Array.from(document.querySelectorAll('.main-tab-btn')).find(x => x.textContent.trim() === ${JSON.stringify(name)}); if (b) b.click(); return b ? 'ok' : 'NOBTN'; })()`,
          returnByValue: true,
        });
        await sleep(500);
      };
      await clickMainTab('自定义模型映射');
      await clickMainTab('合并模型目录');
      console.log('子 Tab 往返后:', JSON.stringify((await probe()).result.value));
      console.log('往返后滚到 3600:', JSON.stringify(await scrollTo(3600)));
      return;
    }

    if (process.env.EXP11) {
      console.log('\n===== 实验十一：行高普查（虚拟滚动的前提）=====');
      await measure(c, '模型目录', 1500);
      const r = await c.send('Runtime.evaluate', {
        expression: `(() => {
          const sc = document.querySelector('.models-card .table-scroll');
          if (!sc) return 'NOSCROLLER';
          const trs = Array.from(sc.querySelectorAll('tbody tr'));
          const h = new Map();
          for (const t of trs) { const k = Math.round(t.getBoundingClientRect().height); h.set(k, (h.get(k) || 0) + 1); }
          const cs = getComputedStyle(trs[0] ? trs[0].querySelector('td') : sc);
          return JSON.stringify({
            rows: trs.length,
            heights: Array.from(h.entries()).sort((a, b) => b[1] - a[1]),
            scrollH: sc.scrollHeight, clientH: sc.clientHeight,
            theadH: Math.round(sc.querySelector('thead tr').getBoundingClientRect().height),
            tdPadTop: cs.paddingTop, tdPadBottom: cs.paddingBottom, tdLineHeight: cs.lineHeight, tdFontSize: cs.fontSize,
          });
        })()`,
        returnByValue: true,
      });
      console.log('行高:', r.result.value);
      return;
    }

    const tabs = ['总览', 'API Keys', '自定义提供商', '号池', '积分到期', '模型目录', '用量统计', '号池同步', '生态接入'];
    const out = [];
    const warm = [];
    if (!process.env.SKIPSCAN) {
    console.log('\n===== 冷启动（首次挂载：懒 chunk + onMounted IPC + 动画）=====');
    for (const t of tabs) {
      const one = await measure(c, t);
      out.push({ phase: 'cold', ...one });
      console.log(JSON.stringify({ phase: 'cold', ...one }));
      await measure(c, '总览', 400); // 切走，让下一页重新算「首次进入」
    }

    console.log('\n===== 暖切换（已挂载，只剩 v-show + 动画）=====');
    const warm = [];
    for (const t of tabs) {
      const one = await measure(c, t);
      warm.push({ phase: 'warm', ...one });
      console.log(JSON.stringify({ phase: 'warm', ...one }));
    }
    }

    console.log('\n===== 实验一：空转基线（什么都不点，同样 1.7s 窗口）=====');
    await applyCss(c, '');
    await measure(c, '总览', 600);
    for (let i = 0; i < 3; i++) {
      const one = await idle(c);
      console.log(JSON.stringify({ exp: 'idle', ...one, ms: { s: one.metrics.ScriptDuration, l: one.metrics.LayoutDuration, r: one.metrics.RecalcStyleDuration, t: one.metrics.TaskDuration } }));
    }

    console.log('\n===== 实验二：行数剂量反应（模型目录，切走再切回）=====');
    // SKIPSCAN 时模型目录还没挂载过，先挂一次（这一次是冷挂载，丢弃不计）
    await measure(c, '模型目录');
    await measure(c, '总览', 600);
    const med = (arr) => { const v = arr.slice().sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : null; };
    for (const kw of ['', 'seed', 'code', 'pro', 'x', 'zz']) {
      const r = await setFilter(c, kw);
      if (r !== 'ok') { console.log(JSON.stringify({ kw, error: r })); continue; }
      await sleep(400);
      const runs = [];
      for (let i = 0; i < 3; i++) {
        await measure(c, '总览', 600);
        runs.push(await measure(c, '模型目录'));
      }
      const g = runs.filter((x) => !x.notab);
      if (!g.length) { console.log(JSON.stringify({ kw, error: 'NOTAB' })); continue; }
      console.log(JSON.stringify({
        kw: kw || '(空)',
        rows: g[0].rows,
        dom: g[0].dom,
        selects: g[0].selects,
        maxFrame_ms: med(g.map((x) => x.max)),
        RecalcStyle_ms: med(g.map((x) => x.metrics.RecalcStyleDuration)),
        Layout_ms: med(g.map((x) => x.metrics.LayoutDuration)),
        Script_ms: med(g.map((x) => x.metrics.ScriptDuration)),
        Task_ms: med(g.map((x) => x.metrics.TaskDuration)),
      }));
    }
    await setFilter(c, '');

    console.log('\n===== 实验三：通配 !important 规则的贡献（html.fx-off * 那类）=====');
    const arms = {
      A_基线: '',
      D_关backdrop: '*, *::before, *::after { backdrop-filter: none !important; }',
      E_隐藏玻璃伪元素: '.glass::before, .glass::after, .card::before, .card::after, .kpi::before, .kpi::after { display: none !important; opacity: 0 !important; }',
    };
    for (const [arm, css] of Object.entries(arms)) {
      await applyCss(c, css);
      await measure(c, '总览', 600);
      const runs = [];
      for (let i = 0; i < 3; i++) {
        await measure(c, '总览', 600);
        runs.push(await measure(c, '模型目录'));
      }
      const g = runs.filter((x) => !x.notab);
      if (!g.length) { console.log(JSON.stringify({ arm, error: 'NOTAB' })); continue; }
      console.log(JSON.stringify({
        arm,
        maxFrame_ms: med(g.map((x) => x.max)),
        RecalcStyle_ms: med(g.map((x) => x.metrics.RecalcStyleDuration)),
        Layout_ms: med(g.map((x) => x.metrics.LayoutDuration)),
        Task_ms: med(g.map((x) => x.metrics.TaskDuration)),
        dom: g[0].dom,
      }));
    }
    await applyCss(c, '');

    console.log('\n===== 实验四：隐藏的大页会不会拖慢别的页（跨页污染）=====');
    // 模型目录已挂载。先让它满 133 行，量「切到小页」的成本；再把它的行清空后重量同样两下。
    // 若清空后小页切换变快，说明 6212 节点的子树即使 display:none 也在拖累全局。
    for (const [tag, kw] of [['大页满 133 行', ''], ['大页清成 1 行', 'zz']]) {
      await setFilter(c, kw);
      await sleep(500);
      await measure(c, '模型目录', 700); // 落点在模型目录，下一次切换才是「从大页切走」
      const runs = [];
      const away = [];
      for (let i = 0; i < 3; i++) {
        away.push(await measure(c, '总览', 700));   // 从大页切走
        runs.push(await measure(c, 'API Keys'));     // 小页 → 小页
      }
      const g = runs.filter((x) => !x.notab);
      const a = away.filter((x) => !x.notab);
      console.log(JSON.stringify({
        tag,
        切走_总览: {
          maxFrame_ms: med(a.map((x) => x.max)),
          longTask_ms: med(a.map((x) => (x.long.length ? Math.max(...x.long) : 0))),
          RecalcStyle_ms: med(a.map((x) => x.metrics.RecalcStyleDuration)),
          Layout_ms: med(a.map((x) => x.metrics.LayoutDuration)),
          Task_ms: med(a.map((x) => x.metrics.TaskDuration)),
        },
        小页间_APIKeys: {
          maxFrame_ms: med(g.map((x) => x.max)),
          longTask_ms: med(g.map((x) => (x.long.length ? Math.max(...x.long) : 0))),
          RecalcStyle_ms: med(g.map((x) => x.metrics.RecalcStyleDuration)),
          Layout_ms: med(g.map((x) => x.metrics.LayoutDuration)),
          Script_ms: med(g.map((x) => x.metrics.ScriptDuration)),
          Task_ms: med(g.map((x) => x.metrics.TaskDuration)),
          totalDom: g.length ? g[0].total : null,
        },
      }));
    }
    await setFilter(c, '');

    if (process.env.EXP5 && !process.env.EXP6) {
      console.log('\n===== 实验五：机制分离（节点在场 vs 通配规则 vs 别的）=====');
      await setFilter(c, '');
      await measure(c, '模型目录', 900);
      console.log('baseline（大页 133 行、隐藏在场）:', JSON.stringify(await smallPagePairCost(c)));

      const removed = await deleteRulesMatching(c, 'fx-off', 'html.fx-off 通配');
      console.log('F 删掉 fx-off 通配规则后:', JSON.stringify(await smallPagePairCost(c)));

      const det = await c.send('Runtime.evaluate', {
        expression: `(() => {
          const pages = document.querySelector('.pages');
          const el = Array.from(pages.children).find(e => e.querySelector('.models-card'));
          if (!el) return 'NOROOT kids=' + pages.children.length;
          window.__detached = pages.removeChild(el);
          return 'detached';
        })()`,
        returnByValue: true,
      });
      console.log('把大页整棵移出文档:', det.result.value, '→', JSON.stringify(await smallPagePairCost(c)));

      await c.send('Runtime.evaluate', {
        expression: `(() => { if (window.__detached) document.querySelector('.pages').appendChild(window.__detached); return 1 })()`,
        returnByValue: true,
      });
      console.log('放回后复测:', JSON.stringify(await smallPagePairCost(c)));
      console.log('(删掉的规则数:', removed, '—— 该臂不可逆，故放在 baseline 之后)');
    }

    if (process.env.EXP6) {
      console.log('\n===== 实验六：tracing 自时长归因（大页在场 vs 移出）=====');
      await setFilter(c, '');
      await measure(c, '模型目录', 1200);
      await measure(c, '总览', 700);
      const withBig = await traceOnce(c, '大页 133 行在场');
      console.log('在场:', JSON.stringify(withBig));
      const det = await c.send('Runtime.evaluate', {
        expression: `(() => {
          const pages = document.querySelector('.pages');
          const el = Array.from(pages.children).find(e => e.querySelector('.models-card'));
          if (!el) return 'NOROOT';
          window.__detached = pages.removeChild(el);
          return 'detached';
        })()`,
        returnByValue: true,
      });
      console.log('移出:', det.result.value);
      const noBig = await traceOnce(c, '大页已移出文档');
      console.log('移出后:', JSON.stringify(noBig));
      const a = new Map(withBig.top.map((x) => [x.name, x.ms]));
      const b = new Map(noBig.top.map((x) => [x.name, x.ms]));
      const names = new Set([...a.keys(), ...b.keys()]);
      console.log('差值（在场 − 移出，ms）:', JSON.stringify(
        [...names].map((n) => [n, +(((a.get(n) || 0) - (b.get(n) || 0)).toFixed(1))])
          .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 12)
      ));
      await c.send('Runtime.evaluate', {
        expression: `(() => { if (window.__detached) document.querySelector('.pages').appendChild(window.__detached); return 1 })()`,
        returnByValue: true,
      });
    }

    if (process.env.EXP7) {
      console.log('\n===== 实验七：候选修法（注入 CSS 就能测的，先测掉）=====');
      await setFilter(c, '');
      // 每次「切走 → 切回模型目录」，量的是切进大页的成本
      const intoModels = async (reps = 3) => {
        const runs = [];
        for (let i = 0; i < reps; i++) {
          await measure(c, '总览', 700);
          runs.push(await measure(c, '模型目录'));
        }
        const g = runs.filter((x) => !x.notab);
        return {
          rows: g.length ? g[0].rows : null,
          dom: g.length ? g[0].dom : null,
          maxFrame_ms: med(g.map((x) => x.max)),
          RecalcStyle_ms: med(g.map((x) => x.metrics.RecalcStyleDuration)),
          Layout_ms: med(g.map((x) => x.metrics.LayoutDuration)),
          Script_ms: med(g.map((x) => x.metrics.ScriptDuration)),
          Task_ms: med(g.map((x) => x.metrics.TaskDuration)),
        };
      };
      console.log('0 基线:', JSON.stringify(await intoModels()));

      const fixes = {
        '1_tr_content_visibility': '.models-card tbody tr{content-visibility:auto;contain-intrinsic-size:auto 44px}',
        '3_滚动容器_content_visibility': '.models-card .table-scroll{content-visibility:auto;contain-intrinsic-size:auto 600px}',
        '4_行_contain_layout_style': '.models-card tbody tr{contain:layout style}',
      };
      for (const [name, css] of Object.entries(fixes)) {
        await applyCss(c, css);
        await sleep(400);
        console.log(name + ':', JSON.stringify(await intoModels()));
      }
      await applyCss(c, '');
    }

    if (process.env.EXP8) {
      console.log('\n===== 实验八：是不是 GC =====');
      await setFilter(c, '');
      await measure(c, '模型目录', 1200);
      await measure(c, '总览', 700);
      const heap = async () => {
        const r = await c.send('Runtime.evaluate', {
          expression: `JSON.stringify(performance.memory ? {used: Math.round(performance.memory.usedJSHeapSize/1048576), tot: Math.round(performance.memory.totalJSHeapSize/1048576)} : null)`,
          returnByValue: true,
        });
        return JSON.parse(r.result.value);
      };
      await c.send('HeapProfiler.enable');
      console.log('堆占用（大页 133 行挂载中）:', JSON.stringify(await heap()));
      console.log('不干预:', JSON.stringify(await smallPagePairCost(c)));
      // 每次点击前先强制整堆 GC，把增量标记的活儿挪到测量窗口之外
      const origMeasure = measure;
      const g = [];
      for (let i = 0; i < 3; i++) {
        await c.send('HeapProfiler.collectGarbage');
        await origMeasure(c, '总览', 700);
        await c.send('HeapProfiler.collectGarbage');
        g.push(await origMeasure(c, 'API Keys'));
      }
      const gg = g.filter((x) => !x.notab);
      console.log('点击前先 collectGarbage:', JSON.stringify({
        maxFrame_ms: med(gg.map((x) => x.max)),
        longTask_ms: med(gg.map((x) => (x.long.length ? Math.max(...x.long) : 0))),
        Script_ms: med(gg.map((x) => x.metrics.ScriptDuration)),
        Task_ms: med(gg.map((x) => x.metrics.TaskDuration)),
      }));
      // 对照：把大页真的卸载（过滤成 1 行）后再看堆占用
      await setFilter(c, 'zz');
      await sleep(600);
      console.log('堆占用（清成 1 行后）:', JSON.stringify(await heap()));
      await setFilter(c, '');
    }

    if (process.env.EXP9) {
      console.log('\n===== 实验九：窗口内零 evaluate 的干净归因（真实鼠标事件驱动）=====');
      await setFilter(c, '');
      await measure(c, '模型目录', 1200);
      await measure(c, '总览', 700);
      // 先（在窗口外）取好两个页签的视口坐标
      const pts = await c.send('Runtime.evaluate', {
        expression: `(() => {
          const g = (n) => { const b = Array.from(document.querySelectorAll('.tab')).find(x => x.textContent.trim() === n); const r = b.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; };
          return JSON.stringify({ home: g('总览'), keys: g('API Keys') });
        })()`,
        returnByValue: true,
      });
      const P = JSON.parse(pts.result.value);
      const clickAt = async (p) => {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
        }
      };
      const cleanPass = async (tag) => {
        await c.send('Runtime.evaluate', { expression: `(() => { window.__frames.length = 0; window.__long.length = 0; return 1 })()`, returnByValue: true });
        await c.send('Tracing.start', {
          transferMode: 'ReportEvents',
          traceConfig: { includedCategories: ['devtools.timeline', 'blink', 'v8', 'disabled-by-default-devtools.timeline'] },
        });
        await sleep(200);
        await clickAt(P.home);
        await sleep(700);
        await clickAt(P.keys);
        await sleep(1500);
        await c.send('Tracing.end');
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline && !c.events.some((e) => e.method === 'Tracing.tracingComplete')) await sleep(250);
        const evs = [];
        for (const e of c.events) if (e.method === 'Tracing.dataCollected' && Array.isArray(e.params.value)) evs.push(...e.params.value);
        // 窗口结束后才读帧与普查 —— 这样探针自己的开销不落在被测区间里
        const after = await c.send('Runtime.evaluate', {
          expression: `JSON.stringify({frames: window.__frames.slice(), long: window.__long.slice(), total: document.querySelectorAll('*').length})`,
          returnByValue: true,
        });
        const A = JSON.parse(after.result.value);
        console.log(`干净窗口[${tag}]:`, JSON.stringify({ ...stats(A.frames), long: A.long, totalDom: A.total, traceEvents: evs.length }));
        console.log(`自时长 top[${tag}]:`, JSON.stringify(selfBy(evs).top.slice(0, 10)));
        c.events.length = 0;
      };
      await cleanPass('大页 133 行挂载');
      await setFilter(c, 'zz');
      await sleep(600);
      await cleanPass('大页清成 1 行');
      await setFilter(c, '');
    }

    if (process.env.EXP10) {
      console.log('\n===== 实验十：CPU 采样，问出是哪个函数 =====');
      await setFilter(c, '');
      await measure(c, '模型目录', 1200);
      await measure(c, '总览', 700);
      const pts = await c.send('Runtime.evaluate', {
        expression: `(() => {
          const g = (n) => { const b = Array.from(document.querySelectorAll('.tab')).find(x => x.textContent.trim() === n); const r = b.getBoundingClientRect(); return {x: r.x + r.width/2, y: r.y + r.height/2}; };
          return JSON.stringify({ home: g('总览'), keys: g('API Keys') });
        })()`,
        returnByValue: true,
      });
      const P = JSON.parse(pts.result.value);
      const clickAt = async (p) => {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await c.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: type === 'mousePressed' ? 1 : 0 });
        }
      };
      await c.send('Profiler.enable');
      await c.send('Profiler.setSamplingInterval', { interval: 120 });
      const prof = async (tag) => {
        await c.send('Profiler.start');
        await clickAt(P.home);
        await sleep(800);
        await clickAt(P.keys);
        await sleep(1400);
        const { profile } = await c.send('Profiler.stop');
        const r = profileTop(profile);
        console.log(`[${tag}] 采样总时长 ${r.totalMs}ms · 非 idle 热点：`);
        for (const x of r.top.slice(0, 8)) console.log(`   ${String(x.ms).padStart(6)}ms  ${x.fn}`);
        const paths = profilePaths(profile);
        console.log(`[${tag}] 包含时间路径：`);
        for (const p of paths) console.log('    ' + p + '\n');
      };
      await prof('大页 133 行挂载');
      await setFilter(c, 'zz');
      await sleep(600);
      await prof('大页清成 1 行');
      await setFilter(c, '');
    }

    fs.writeFileSync(path.join(hy.root, 'tab-switch-perf.json'), JSON.stringify({ out, warm, arms: 'see stdout' }, null, 2), 'utf8');
    console.log('\n明细已落盘:', path.join(hy.root, 'tab-switch-perf.json'));
  } catch (e) {
    err = e;
  } finally {
    if (c) c.close();
    try { await fc.killProcessTree(proc.pid); } catch (e) { console.log('清理告警:', e.message); }
    if (preview && preview.pid) {
      try { await fc.killProcessTree(preview.pid); } catch (e) { console.log('vite preview 清理告警:', e.message); }
    }
    try { reapOwnGateway(GW_PORT); } catch (e) { console.log('网关子进程清理告警:', e.message); }
  }
  if (err) { console.error(err); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
