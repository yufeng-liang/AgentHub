// 二期 Task 2 闸：写权与句柄归属。
//
// 二期把网关搬进独立 Node 子进程之后，**两个进程同时写同一份文件**是这期最容易出隐性数据损坏的地方。
// 本闸先把写权与句柄收干净：
//  ① 原子写的临时文件名带 pid —— 主进程与子进程同刻写盘时，固定名会互相 rename 踩掉对方的半成品；
//  ② 全仓（electron/backend 及其 proxy/ 子目录，递归）凡「写盘用的固定 .tmp 名」都必须拼 process.pid，已知写点一个不许漏；
//    判据只认 `.tmp`（或 `.tmp-` 前缀）这种原子写临时名，os.tmpdir()/mkdtemp 派生的临时目录（adapter-* 那几处）不算、不误报；
//  ③ store.checkpoint() 真能把 stats.db 的 -wal 收敛（本机实测曾长到 1.59 MB 且零次 checkpoint）；
//  ④ store.close() 不再是「定义了没人调」——proxy.shutdown() 运行期真把句柄关掉、WAL 清零；
//  ⑤ 主进程对 proxy 域的 require 数不得比基线增加（棘轮，硬零由 Task 5 接管）。
//
// 手法约束（与 Task 0/1 的闸同一套纪律）：
//  · 所有落盘（config.json / stats.db / 中央技能仓库）都在临时目录里：APPDATA 与 AGENT_SKILLS_HOME
//    在任何产品代码 require 之前指走，**绝不碰真实 %APPDATA%\AgentHub 与 ~/.agent_skills**；
//  · ① 的双进程互踩用「两个真子进程 + 临界区会合点」做：写完 .tmp 后先亮到旗、等对方到旗再 rename，
//    于是「双方的 .tmp 同时在盘上」被强制成立而不是碰调度器运气；判据（路径含 .tmp）与 pid 拼法无关，
//    不给产品代码开测试后门；
//  · ③ 用真实 node:sqlite（临时目录），不 mock 数据库；
//  · ④ 同时给静态与运行期两条：静态断言 shutdown() 体内引用 store.close()，运行期在子进程里走真实
//    装配路径看 WAL 是否被清零。判据是「真跑到停机函数」，不是「真跑过完整启动流程」（归 Task 3/7）。
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BACKEND = path.join(ROOT, "electron", "backend");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-wown-"));

// ===== 隔离：必须早于任何产品代码的 require =====
// 父进程自己那套 store/config 用 appdata；两个竞写进程用 appdata-race；停机探针用 appdata-sd。
process.env.APPDATA = path.join(work, "appdata");
process.env.AGENT_SKILLS_HOME = path.join(work, "hub");
fs.mkdirSync(process.env.APPDATA, { recursive: true });

const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// 整闸硬超时：任一子进程或起跑栅栏挂住时，宁可红也不要让跑门禁的人干等（写这版时实测挂过 4 分钟）
setTimeout(() => {
  console.log("FAIL 本闸 120 s 未跑完（子进程或栅栏挂住）。临时目录保留供排查：" + work);
  process.exit(1);
}, 120000).unref?.();
// 等 setInterval 真的跑起来时必须用这个：nap 会把主线程钉死，计时器回调一次都不会执行
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let steps = 0;
const pass = (msg) => { steps++; console.log(`  ${String(steps).padStart(2)}. ${msg}`); };

const ROUNDS = 20;        // 简报定的「各跑 20 次」
const BARRIER_MS = 1500;  // 会合点最长等待：对方进程死了也要能自己走下去，不许把闸挂死

/** 竞写夹具：一个「进程」，把同一份 config.json 原子写 ROUNDS 次（argv 驱动，写在临时目录里不入库） */
const WRITER_SRC = `"use strict";
const fs = require("node:fs");
const cfgModPath = process.argv[2];
const readyFile = process.argv[3], goFile = process.argv[4];
const marker = process.argv[5], theme = process.argv[6];
const ROUNDS = Number(process.argv[7]);
const flagDir = process.argv[8], peer = process.argv[9], BARRIER = Number(process.argv[10]);
const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// 会合点（rendezvous）：写完临时文件后先亮自己这一轮的到旗、等对方同一轮的到旗，再去 rename。
// 到旗按轮编号命名、不删不改，所以两个进程哪怕一快一慢也只会各自等齐，不会串轮 ——
// 「我的 .tmp 还在盘上、对方的 .tmp 也已经落下了」这个状态于是被强制成立，而不是靠调度器心情。
// 两条可观测面：① 固定名时后 rename 的那个撞 ENOENT；② rename 前复查自己那份 .tmp 的内容，
// 被对方的同名写入覆盖过就是互踩的直接证据（这条与谁先 rename 无关，所以不会漏）。
// 判据全是通用的「路径含 .tmp」，与临时名怎么拼无关，产品代码里不留任何测试后门。
let round = "idle", armed = false, timeouts = 0, clobbers = 0, pending = null;
const origWrite = fs.writeFileSync, origRename = fs.renameSync;
fs.writeFileSync = function (p, data, ...rest) {
  const r = origWrite.call(this, p, data, ...rest);
  if (!armed || !String(p).includes(".tmp")) return r;         // 到旗文件自身的写入不触发会合（免递归）
  pending = { tmp: String(p), data: typeof data === "string" ? data : null };
  origWrite.call(this, flagDir + "." + marker + "." + round, String(process.pid));
  let waited = 0;
  while (!fs.existsSync(flagDir + "." + peer + "." + round) && waited < BARRIER) { nap(1); waited += 1; }
  if (waited >= BARRIER) timeouts++;
  return r;
};
fs.renameSync = function (from, to) {
  if (pending && String(from) === pending.tmp) {
    if (pending.data != null) {
      let now = "";
      try { now = fs.readFileSync(pending.tmp, "utf8"); } catch { now = "<已不在盘上>"; }
      if (now !== pending.data) clobbers++;
    }
    pending = null;
  }
  return origRename.call(this, from, to);
};

const config = require(cfgModPath);
const base = config.loadConfig();
// 每轮写一个「可区分」的载荷：theme 与 update.notifiedVersion 配成对，收尾才能认出最终文件属于谁
const put = (tag) => {
  round = tag;
  return config.saveConfig(Object.assign({}, base, {
    theme: theme,
    update: Object.assign({}, base.update, { notifiedVersion: marker + "-" + tag }),
  }));
};

// 热身（此时还没开会合点）：把两个进程都拉过初始化——建目录 / 读 Local State / 第一次写盘，
// 免得一个还在热身另一个已经把 20 轮跑完。容许重试：固定临时名时连热身都会互踩，
// 重试让「压根没就绪」和「互踩」不混成同一种症状。
let warmRetries = -1, lastErr = "";
for (let i = 0; i < 60; i++) {
  try { put("warmup"); warmRetries = i; break; }
  catch (e) { lastErr = (e && e.code ? e.code : e.constructor.name) + " " + String(e.message).split("\\n")[0].slice(0, 90); nap(5); }
}
if (warmRetries < 0) { console.error("WARMUP-FAILED " + lastErr); process.exit(3); }
fs.writeFileSync(readyFile, String(process.pid));
for (let i = 0; i < 8000 && !fs.existsSync(goFile); i++) nap(1);   // 最多等 8 s，父进程挂了也不留孤儿
if (!fs.existsSync(goFile)) { console.error("NO-GO-FLAG"); process.exit(4); }
armed = true;                                                     // 从这里开始每轮都过会合点

let ok = 0;
const errs = [];
// EPERM / EBUSY / EACCES：Windows 对「rename 的目标文件正被另一个进程持有」的瞬时拒绝，
// 与临时文件名怎么拼无关（固定名与带 pid 名都会遇到），本任务改不了也不该改它 → 按瞬时错重试并计数报出。
// ENOENT 才是本闸要抓的那一条：对方把我这份同名 .tmp 先 rename 走了。
const BUSY = { EPERM: 1, EBUSY: 1, EACCES: 1 };
let busy = 0;
for (let i = 0; i < ROUNDS; i++) {
  for (let attempt = 0; ; attempt++) {
    try { put(i); ok++; break; }
    catch (e) {
      if (BUSY[e && e.code] && attempt < 6) { busy++; nap(3); continue; }
      errs.push(i + ":" + (e && e.code ? e.code : e.constructor.name) + " " + String(e.message).split("\\n")[0].slice(0, 160));
      break;
    }
  }
}
console.log("RESULT marker=" + marker + " pid=" + process.pid + " ok=" + ok + " fail=" + (ROUNDS - ok)
  + " clobbers=" + clobbers + " warm_retries=" + warmRetries + " barrier_timeouts=" + timeouts
  + " busy_retries=" + busy + (errs.length ? " first_err=" + errs[0] : ""));
`;

/** 停机探针：走真实装配路径（require index.cjs），证明 proxy.shutdown() 运行期关掉了 store 的句柄 */
const PROBE_SRC = `"use strict";
const path = require("node:path");
const be = process.argv[2];
const ROUNDS = Number(process.argv[3]);
const store = require(path.join(be, "proxy", "store.cjs"));
const proxy = require(path.join(be, "proxy", "index.cjs"));
store.open();
for (let i = 0; i < ROUNDS; i++) {
  store.insertUsage({
    reqId: "sd-" + i, keyName: "k", channel: "trae", accountName: "a", model: "claude-x",
    promptTokens: 12, completionTokens: 34, latencyMs: 5, status: 200,
  });
}
const before = store.walBytes();
proxy.shutdown();
console.log("PROBE driver=" + store.driver() + " before=" + before + " after=" + store.walBytes());
`;

/** 起一个跑临时夹具的子进程：done 在进程退出时 resolve，kill 用于超时路径兜底（不留孤儿、不卡死栅栏） */
function spawnChild(scriptFile, args, env) {
  let child = null;
  const done = new Promise((resolve, reject) => {
    child = spawn(process.execPath, [path.join(work, scriptFile), ...args], {
      cwd: work, env: Object.assign({}, process.env, env), stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({ code, signal, out, err }));
  });
  return { done, kill: () => { try { child && child.kill("SIGKILL"); } catch { /* 已经退了 */ } } };
}

/** 竞写子进程：同一份 config.json、各自可区分的载荷、按轮编号配对的到旗构成会合点 */
const spawnWriter = (marker, theme, peer) => spawnChild("race-writer.cjs", [
  path.join(BACKEND, "config.cjs"),
  path.join(work, marker + ".ready"),
  path.join(work, "go"),
  marker, theme, String(ROUNDS),
  path.join(work, "arrive"), String(peer), String(BARRIER_MS),
], {
  APPDATA: path.join(work, "appdata-race"),
  AGENT_SKILLS_HOME: path.join(work, "hub-race"),
});

const RESULT_RE = /RESULT marker=(\S+) pid=(\d+) ok=(\d+) fail=(\d+) clobbers=(\d+) warm_retries=(\d+) barrier_timeouts=(\d+) busy_retries=(\d+)(?: first_err=(.*))?/;

async function main() {
  fs.writeFileSync(path.join(work, "race-writer.cjs"), WRITER_SRC, "utf8");
  fs.writeFileSync(path.join(work, "shutdown-probe.cjs"), PROBE_SRC, "utf8");
  const dataDir = path.join(work, "appdata-race", "AgentHub");
  const cfgFile = path.join(dataDir, "config.json");

  // ===== ① 两个进程竞写同一份 config.json：不许互踩、不许半个文件、不许留 .tmp =====
  const wA = spawnWriter("A", "dark", "B");
  const wB = spawnWriter("B", "light", "A");
  const goFile = path.join(work, "go");
  let ready = false;
  for (let i = 0; i < 800 && !ready; i++) {   // 最多等 8 s 让两个进程热身完毕
    if (fs.existsSync(path.join(work, "A.ready")) && fs.existsSync(path.join(work, "B.ready"))) ready = true;
    else nap(10);
  }
  if (!ready) {
    wA.kill(); wB.kill();                     // 先放行卡在栅栏上的那个，否则 await 会永久挂住
    const [ra, rb] = await Promise.all([wA.done, wB.done]);
    assert.ok(false, "两个写入进程没有按时就绪：\nA=" + ra.code + " " + ra.out + ra.err
      + "\nB=" + rb.code + " " + rb.out + rb.err);
  }
  fs.writeFileSync(goFile, "go", "utf8");     // 起跑栅栏：两边同一刻进入临界区
  const [ra, rb] = await Promise.all([wA.done, wB.done]);
  for (const r of [ra, rb]) {
    assert.strictEqual(r.code, 0, `写入进程非零退出（${r.code}）：\n${r.out}${r.err}`);
  }
  const mA = RESULT_RE.exec(ra.out), mB = RESULT_RE.exec(rb.out);
  assert.ok(mA && mB, "没拿到 RESULT 行：\nA=" + ra.out + ra.err + "\nB=" + rb.out + rb.err);
  assert.notStrictEqual(mA[2], mB[2], "两个写入进程的 pid 相同 —— 这条断言退化成单进程，互踩场景根本没测到");
  for (const m of [mA, mB]) {
    // 会合点必须真的会合过：超时 = 有一方压根没在对方的临界区里，① 就退化成「各写各的」的空断言
    assert.strictEqual(m[7], "0", `marker=${m[1]} 的会合点超时 ${m[7]} 次 —— 两个进程的临界区没逐轮重叠，这条断言是空的`);
    // 互踩的直接证据：我写进 .tmp 的内容，在 rename 之前已经被对方的同名写入换掉了
    assert.strictEqual(m[5], "0",
      `marker=${m[1]}（pid ${m[2]}）的 .tmp 半成品被另一个进程覆盖了 ${m[5]} 次（固定临时文件名的互踩）`);
    assert.strictEqual(m[4], "0",
      `marker=${m[1]}（pid ${m[2]}）有 ${m[4]} 次写盘失败：${m[9] || ""}`
      + `\n（固定临时名时典型症状是 renameSync ENOENT —— 对方已经把我那份同名 .tmp  rename 走了）`);
  }
  pass(`① 两个进程（pid ${mA[2]} / ${mB[2]}）临界区逐轮会合 ${ROUNDS} 次，${ROUNDS * 2} 次竞写同一份 config.json：`
    + `互踩 0、失败 0、会合超时 0（Windows 目标占用导致的瞬时重试共 ${Number(mA[8]) + Number(mB[8])} 次，与临时名拼法无关）`);

  const disk = JSON.parse(fs.readFileSync(cfgFile, "utf8"));   // 半个文件在这里就会炸
  assert.match(String(disk.update.notifiedVersion), /^(A|B)-\d+$/,
    "最终文件不是两个写入者之一的完整载荷：" + JSON.stringify(disk.update));
  const markerWon = String(disk.update.notifiedVersion).split("-")[0];
  assert.strictEqual(disk.theme, markerWon === "A" ? "dark" : "light",
    "payload 里混进了另一个进程的值（theme 与 notifiedVersion 不配对）：" + disk.theme + " / " + disk.update.notifiedVersion);
  const residue = fs.readdirSync(dataDir).filter((n) => n.includes(".tmp"));
  assert.deepStrictEqual(residue, [], "原子写残留了 .tmp 半成品：" + residue.join(", "));
  pass("① 收尾：文件是两者之一的完整载荷（marker=" + markerWon + " theme=" + disk.theme + "），.tmp 残留 0");

  // ===== ② 全仓（含 proxy/ 子目录，递归）写盘用的固定 .tmp 名必须拼 pid =====
  // Task 2 首轮把扫描面写死在 electron/backend 顶层，proxy/ideswitch.cjs:272 的固定名因此漏网——
  // 这条补口把扫描面递归提到 proxy/**，让它成为同类漏项的守门。
  // 判据：字符串里出现「.tmp」且后面不接字母 = 原子写的临时文件名，两种口径都覆盖：
  //   · 命中 config/hub/sync-config/sync 的 `${p}.${pid}.tmp`（`.tmp` 收尾），以及 proxy/ideswitch 的 `${file}.tmp-${pid}`（`.tmp-` 前缀，含 :91 与 :272 两处）；
  //   · 不误报 os.tmpdir() 派生的临时目录/文件（adapter-* 那几处本就带 pid 或走 mkdtemp）——它们的 `.tmp` 后紧跟 `dir`，被「后不接字母」挡掉；注释行再单独剔除。
  const TMP_LITERAL = /\.tmp(?![A-Za-z])/;    // .tmp 后不接字母 = 写盘临时名；os.tmpdir() 的 `.tmpdir` 不命中
  const COMMENT = /^\s*(\/\/|\*|\/\*)/;
  const KNOWN_SITES = ["config.cjs", "hub.cjs", "sync-config.cjs", "sync.cjs", "proxy/ideswitch.cjs"];
  const hits = [];
  // 递归走 electron/backend（含 proxy/），文件名统一记成相对 BACKEND 的 posix 路径（config.cjs / proxy/ideswitch.cjs）
  const walkCjs = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walkCjs(abs, r); continue; }
      if (!e.name.endsWith(".cjs")) continue;
      fs.readFileSync(abs, "utf8").split(/\r?\n/).forEach((line, i) => {
        if (COMMENT.test(line) || !TMP_LITERAL.test(line)) return;
        hits.push({ file: r, line: i + 1, text: line.trim() });
      });
    }
  };
  walkCjs(BACKEND, "");
  assert.ok(hits.length >= KNOWN_SITES.length,
    `.tmp 写点扫描到 ${hits.length} 处，少于已知的 ${KNOWN_SITES.length} 处 —— 扫描面缩了，这条闸会变成空闸`);
  for (const h of hits) {
    assert.ok(h.text.includes("process.pid"),
      `固定临时文件名（跨进程会互踩）：electron/backend/${h.file}:${h.line}  ${h.text}`);
  }
  for (const f of KNOWN_SITES) {
    assert.ok(hits.some((h) => h.file === f), `已知原子写点少了一个（被删、被改成不走 .tmp，或扫描面没覆盖到它）：${f}`);
  }
  const hitFiles = [...new Set(hits.map((h) => h.file))];
  pass(`② electron/backend 递归（含 proxy/）扫到 ${hits.length} 处 .tmp 写盘（${hitFiles.length} 个文件、${KNOWN_SITES.length} 个已知写点齐），全部拼 process.pid`);

  // ===== ③ WAL 真的收敛：checkpoint() / 周期计时器 / walBytes() =====
  const store = require(path.join(BACKEND, "proxy", "store.cjs"));
  assert.strictEqual(store.driver(), "node:sqlite", "③ 的前提是真实 SQLite，不是 mock");
  assert.strictEqual(typeof store.checkpoint, "function", "store.checkpoint() 未导出（Task 3 的子进程要用）");
  assert.strictEqual(typeof store.startCheckpointTimer, "function", "store.startCheckpointTimer() 未导出");
  assert.strictEqual(typeof store.walBytes, "function", "store.walBytes() 未导出（Task 8 量 WAL 增长要用）");
  assert.strictEqual(store.checkpoint(), false, "库还没开就 checkpoint 必须回 false，不能假装做了");
  store.open();
  const rows = (n, from) => {
    for (let i = 0; i < n; i++) {
      store.insertUsage({
        reqId: "t-" + (from + i), keyName: "k", channel: "trae", accountName: "a", model: "claude-x",
        promptTokens: 12, completionTokens: 34, latencyMs: 5, status: 200,
      });
    }
  };
  rows(500, 0);
  const grown = store.walBytes();
  assert.ok(grown > 4096, `-wal 只有 ${grown} B —— WAL 没长起来，下面那条「收敛后 < 4 KB」是空断言`);
  assert.strictEqual(store.checkpoint(), true, "checkpoint() 在库已开时必须回 true");
  const afterCk = store.walBytes();
  assert.ok(afterCk < 4096, `checkpoint() 之后 -wal 仍有 ${afterCk} B（TRUNCATE 没生效）`);
  pass(`③ 500 行流水把 -wal 撑到 ${grown} B，PRAGMA wal_checkpoint(TRUNCATE) 后 ${afterCk} B`);

  // 周期计时器：Task 3 的子进程只调这一个，所以它必须自己真能把 WAL 压下去。
  // 这里必须用 await sleep 而不是 nap —— Atomics.wait 会把主线程钉住，setInterval 的回调根本没机会跑。
  const stop = store.startCheckpointTimer(30);
  assert.strictEqual(typeof stop, "function", "startCheckpointTimer() 必须返回 stop 函数");
  rows(500, 500);
  assert.ok(store.walBytes() > 4096, "计时器测试的前提：写完第二轮 WAL 又长起来了");
  for (let i = 0; i < 100 && store.walBytes() > 4096; i++) await sleep(20);
  const timerCk = store.walBytes();
  assert.ok(timerCk < 4096, `startCheckpointTimer(30) 之后 2 s 内 -wal 仍是 ${timerCk} B —— 计时器没真的跑 checkpoint`);
  stop();                                                   // 先停表，下面的「涨回去才没人压」才是 stop 的证据
  assert.doesNotThrow(() => stop(), "stop 函数必须幂等（重复调用安全）");
  rows(500, 1000);
  await sleep(150);
  const afterStop = store.walBytes();
  assert.ok(afterStop > 4096, `stop() 之后 -wal 还是被压回 ${afterStop} B —— 计时器没停，会留一个无人认领的 interval`);
  pass(`③ 周期 checkpoint：计时器把 WAL 压到 ${timerCk} B，stop() 后又涨回 ${afterStop} B`);

  // close() 的语义：先 checkpoint 再关句柄（正常退出留不下大 WAL）
  const storeSrc = fs.readFileSync(path.join(BACKEND, "proxy", "store.cjs"), "utf8");
  const closeBody = /function close\(\)\s*\{([\s\S]*?)\n\}/.exec(storeSrc);
  assert.ok(closeBody, "store.cjs 里找不到 function close() 的函数体");
  assert.match(closeBody[1], /checkpoint\(\)/,
    "close() 关句柄前没有先 checkpoint()：退出路径留下的 WAL 只能靠 SQLite 自己收，运行期无人收敛");
  pass("③ close() 体内先 checkpoint() 再 db.close()（退出路径不留大 WAL）");

  // 父进程自己也照这条要求做：交出句柄，否则最后删临时目录会被 Windows 咬住（EBUSY）
  store.close();
  assert.strictEqual(store.walBytes(), 0, "close() 之后 -wal 没被收干净：句柄可能还挂在父进程手里");
  assert.strictEqual(store.checkpoint(), false, "close() 之后再 checkpoint 必须回 false（句柄确实没了，不是假关）");

  // ===== ④ store.close() 有真实调用点：静态引用 + 运行期真跑到 =====
  const idxSrc = fs.readFileSync(path.join(BACKEND, "proxy", "index.cjs"), "utf8");
  const shutdownBody = /function shutdown\(\)\s*\{([\s\S]*?)\n\}/.exec(idxSrc);
  assert.ok(shutdownBody, "proxy/index.cjs 里找不到停机函数 function shutdown()");
  assert.match(shutdownBody[1], /store\.close\(\)/,
    "proxy/index.cjs 的 shutdown() 没有引用 store.close() —— 句柄归属仍是一句空话（Task 3 会把 shutdown 升级成 gracefulShutdown）");
  pass("④ 静态：proxy/index.cjs 的 shutdown() 体内引用了 store.close()");

  const sd = await spawnChild("shutdown-probe.cjs",
    [BACKEND, "500"],
    {
      APPDATA: path.join(work, "appdata-sd"),
      AGENT_SKILLS_HOME: path.join(work, "hub-sd"),
      // CCSWITCH_DB_PATH 指到临时目录：探针 require 整张网关图时不许碰真实 ~/.cc-switch
      CCSWITCH_DB_PATH: path.join(work, "ccswitch-sd.db"),
    }).done;
  assert.strictEqual(sd.code, 0, `停机探针子进程非零退出（${sd.code}）：\n${sd.out}${sd.err}`);
  const mp = /PROBE driver=(\S+) before=(\d+) after=(\d+)/.exec(sd.out);
  assert.ok(mp, "没拿到 PROBE 行：\n" + sd.out + sd.err);
  assert.strictEqual(mp[1], "node:sqlite", "探针里的 store 驱动不是 node:sqlite");
  assert.ok(Number(mp[2]) > 4096, `探针写入 500 行后 -wal 只有 ${mp[2]} B —— 这条运行期断言的前提不成立`);
  assert.ok(Number(mp[3]) < 4096,
    `proxy.shutdown() 之后 -wal 仍有 ${mp[3]} B —— 停机路径没真跑到 store.close()（静态引用在，调用链断了）`);
  pass(`④ 运行期：proxy.shutdown() 把 -wal 从 ${mp[2]} B 清零到 ${mp[3]} B（真实子进程、真实装配路径）`);

  // ===== ⑤ 棘轮：主进程对 proxy 域的 require 数不得比基线增加 =====
  // 基线 = 此刻真实存在的三处：ipc.cjs:18 顶层 index.cjs、ipc.cjs:176 惰性 poolsync.cjs、main.cjs:17 顶层 index.cjs。
  // 真正把这三处删净的是 Task 5（dev-gateway-forward-parity-test 断言硬零），这里只挡「再加一条」。
  const PROXY_REQUIRE_BASELINE = 3;
  const REQUIRE_RE = /require\(\s*["'][^"']*proxy\/[^"']+["']\s*\)/g;
  const held = [];
  for (const f of ["electron/backend/ipc.cjs", "electron/main.cjs"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    src.split(/\r?\n/).forEach((line, i) => {
      if (COMMENT.test(line)) return;
      for (const m of line.matchAll(REQUIRE_RE)) held.push(`${f}:${i + 1} ${m[0]}`);
    });
  }
  assert.ok(held.length <= PROXY_REQUIRE_BASELINE,
    `主进程持有的 proxy 域 require 从基线 ${PROXY_REQUIRE_BASELINE} 涨到 ${held.length}：\n  `
    + held.join("\n  ") + "\n（网关的数据文件写权要归子进程独占，主进程多一条 require 就多一条写路径；硬零由 Task 5 接管）");
  pass(`⑤ 棘轮：主进程对 proxy 域的 require = ${held.length}（基线 ${PROXY_REQUIRE_BASELINE}，只减不增）`);
}

main().then(() => {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows 偶发 EBUSY，交给系统回收 */ }
  console.log(`OK 写权归属四条断言全通过（① -④ 四条 + ⑤ 棘轮，共 ${steps} 项小断言）`);
}).catch((e) => {
  console.log("临时目录保留供排查：" + work);
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
