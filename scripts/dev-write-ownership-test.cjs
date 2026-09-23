// 二期 Task 2 闸：写权与句柄归属。
//
// 二期把网关搬进独立 Node 子进程之后，**两个进程同时写同一份文件**是这期最容易出隐性数据损坏的地方。
// 本闸先把写权与句柄收干净：
//  ① 原子写的临时文件名带 pid —— 主进程与子进程同刻写盘时，固定名会互相 rename 踩掉对方的半成品；
//  ② 全仓（electron/**/*.cjs 递归，含 backend/ 与 backend/proxy/）凡「写进中转名再 rename 覆盖目标」的原子写点，
//    该中转名的构造式里都必须拼 process.pid —— **结构判据，不锚 `.tmp` 这个词元**：
//      锚词元时 proxy/raccoonAuth.cjs 的 `${file}.agenthub-tmp`（不含 `.tmp`、写的却是用户真实登录文件）静默漏网，
//      「同类漏项」于是绕过了扫描面本身。改判据后临时名叫什么一律同等对待（`.tmp` / `.tmp-` / `agenthub-tmp`）；
//      「把已存在的文件改名挪走」（.bak 留档轮转、技能搬移、下载落位）不算中转，实测逐条核过不误报；
//    旧的词元判据（凡出现 `.tmp` 写盘名就必须带 pid）作为副闸保留：它窄但零误报，两条一起守。
//  ③ store.checkpoint() 真能把 stats.db 的 -wal 收敛（本机实测曾长到 1.59 MB 且零次 checkpoint）；
//    close() 的「先 checkpoint 再关句柄」除静态体外，另加**运行期兜底**：spy node:sqlite 的 exec/close，
//    断言 db.close() 之前真的发出过 PRAGMA wal_checkpoint（文件系统层区分不出 close 前有没有显式收敛，驱动调用层能）；
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

  // ===== ② 全仓原子写点（写进中转名 → rename 覆盖目标）的中转名必须拼 pid —— 结构判据 =====
  // 前两轮把判据锚在「.tmp」这个词元上：扫描面 widened 到 proxy/ 之后，它守住了 ideswitch:272，
  // 却因同一个词元锚点漏掉了同目录的 proxy/raccoonAuth.cjs:79 `${file}.agenthub-tmp`（不含 `.tmp`，
  // rename 覆盖的是用户真实小浣熊登录文件）。锚词元 = 只覆盖「按这个习惯起名」的写点，本任务要的
  // 是「任何经临时文件中转的原子写」，所以判据换成结构形状，与临时名怎么起名无关。
  //   主判据（结构）：同一文件内 `const|let|var X = <名>` → 同一个 X 被 writeFileSync 写过 → 再 renameSync(X, 目标)
  //                 = 中转覆盖，该 X 的构造式里必须有 process.pid。
  //   不进清单的非中转 rename（实测逐条核过，判据靠「声明与 rename 之间是否真的写过这个变量」区分）：
  //     config.cjs:308 / sync-config.cjs:465  .bak 留档轮转（rename 源 p 从未被 writeFileSync 写过）
  //     hub.cjs:117 / :153                    技能搬移与回收站落位
  //     sync.cjs:214 / :265                   还原回滚挪回、下载文件落位
  //   副闸（词元，保留前两轮那条）：凡出现 `.tmp`（后不接字母）的写盘名都必须带 pid。它窄但零误报，
  //   两条并存 = 覆盖面只增不减：结构判据是它的严格超集（实测 7 处 ⊇ 6 处）。
  // 关于两种 pid 拼法并存（backend 顶层 `${p}.${pid}.tmp`；proxy/ 用户登录文件 `${file}.tmp-${pid}`
  // 与 `${file}.agenthub-tmp-${pid}`）：换成结构判据后拼法不再影响判定力，统一它纯属外观，而代价是要动
  // ideswitch:91 那条本仓没有任何运行期覆盖的用户真实登录文件写路径——为外观做无运行期证据的改动不做
  // （理由见 task-2-report §九）。新增写点就近沿用同目录口径，别再造第三种拼法。
  const ELECTRON = path.join(ROOT, "electron");
  const IDENT = "([A-Za-z_$][\\w$]*)";                       // 只认「裸变量名」：`b.dst` 这类成员表达式天然不匹配
  const WRITE_RE = new RegExp("\\bwriteFileSync\\(\\s*" + IDENT + "\\s*,", "g");
  const RENAME_RE = new RegExp("\\brenameSync\\(\\s*" + IDENT + "\\s*,", "g");
  const TMP_LITERAL = /\.tmp(?![A-Za-z])/;    // .tmp 后不接字母 = 写盘临时名；os.tmpdir() 的 `.tmpdir` 不命中
  const COMMENT = /^\s*(\/\/|\*|\/\*)/;
  const DECL_OF = (name) => new RegExp(`^\\s*(?:const|let|var)\\s+${name}\\s*=`);
  // 已知原子写点（相对 electron/ 的 posix 路径）：新增写点就登记在这里，漏登记会被「少了一个」那条咬
  const KNOWN_SITES = [
    "backend/config.cjs", "backend/hub.cjs", "backend/sync-config.cjs", "backend/sync.cjs",
    "backend/proxy/ideswitch.cjs", "backend/proxy/raccoonAuth.cjs",
    "gateway.cjs",   // Task 3 新增：gateway.json 握手文件的中转名（子进程写、主进程读，跨进程同刻写是常态）
  ];
  const sites = [];      // 结构判据清单（中转覆盖型原子写）
  const litHits = [];    // 词元副闸命中
  const walkCjs = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walkCjs(abs, r); continue; }
      if (!e.name.endsWith(".cjs")) continue;
      const lines = fs.readFileSync(abs, "utf8").split(/\r?\n/);
      const writes = [], renames = [];
      lines.forEach((line, i) => {
        if (COMMENT.test(line)) return;                     // 注释里的写法不算
        if (TMP_LITERAL.test(line)) litHits.push({ file: r, line: i + 1, text: line.trim() });
        for (const m of line.matchAll(WRITE_RE)) writes.push({ name: m[1], line: i + 1 });
        for (const m of line.matchAll(RENAME_RE)) renames.push({ name: m[1], line: i + 1 });
      });
      for (const rn of renames) {
        // rename 的源必须是本文件里声明的局部变量（挪走参数/外部传入的路径 = 不是中转名）
        let decl = -1;
        const isDecl = DECL_OF(rn.name);
        for (let i = rn.line - 2; i >= 0; i--) if (isDecl.test(lines[i])) { decl = i; break; }
        if (decl < 0) continue;
        // 声明与 rename 之间必须真的写过这个变量 —— 这一条就是「中转覆盖」与「改名挪走」的分界
        const wr = writes.find((w) => w.name === rn.name && w.line > decl && w.line < rn.line);
        if (!wr) continue;
        // 声明语句全文（多行声明往下取到分号，最多 3 行，够装下模板字符串）
        let stmt = lines[decl];
        for (let i = decl + 1; i <= Math.min(decl + 3, rn.line - 1) && !stmt.includes(";"); i++) stmt += " " + lines[i];
        sites.push({ file: r, name: rn.name, declLine: decl + 1, writeLine: wr.line, renameLine: rn.line, stmt: stmt.trim() });
      }
    }
  };
  walkCjs(ELECTRON, "");
  assert.ok(sites.length >= KNOWN_SITES.length,
    `结构判据只扫到 ${sites.length} 处原子写中转点，少于已知的 ${KNOWN_SITES.length} 个写点 —— 配对形状或扫描面退化了，这条闸会变成空闸`);
  for (const s of sites) {
    assert.ok(/process\.pid/.test(s.stmt),
      `原子写的中转名没拼 pid（同刻两个写入者会互踩半成品）：electron/${s.file}:${s.declLine}  ${s.stmt}`
      + `\n  配对形状：writeFileSync @${s.writeLine} → renameSync @${s.renameLine} 的源是同一个变量 ${s.name}`);
  }
  for (const f of KNOWN_SITES) {
    assert.ok(sites.some((s) => s.file === f),
      `已知原子写点少了一个（被删、被改成不走中转文件，或扫描面没覆盖到它）：electron/${f}`);
  }
  for (const h of litHits) {
    assert.ok(h.text.includes("process.pid"),
      `固定临时文件名（跨进程会互踩，词元副闸）：electron/${h.file}:${h.line}  ${h.text}`);
  }
  const siteFiles = [...new Set(sites.map((s) => s.file))];
  assert.ok(sites.length >= litHits.length,
    `结构判据（${sites.length} 处）比词元副闸（${litHits.length} 处）还窄 —— 判据换窄了，会漏掉原来守得住的写点`);
  pass(`② electron/** 递归（backend + proxy，结构判据）扫到 ${sites.length} 处中转覆盖型原子写`
    + `（${siteFiles.length} 个文件、${KNOWN_SITES.length} 个已知写点齐），中转名全部拼 process.pid`
    + `；词元副闸 ${litHits.length} 处同样齐`);

  // ===== ③ WAL 真的收敛：checkpoint() / 周期计时器 / walBytes() =====
  const store = require(path.join(BACKEND, "proxy", "store.cjs"));
  assert.strictEqual(store.driver(), "node:sqlite", "③ 的前提是真实 SQLite，不是 mock");
  assert.strictEqual(typeof store.checkpoint, "function", "store.checkpoint() 未导出（Task 3 的子进程要用）");
  assert.strictEqual(typeof store.startCheckpointTimer, "function", "store.startCheckpointTimer() 未导出");
  assert.strictEqual(typeof store.walBytes, "function", "store.walBytes() 未导出（Task 8 量 WAL 增长要用）");
  // 三期 Task 3 把 checkpoint() 的返回值从布尔改成观测结构 {ok,before,after,err} —— 判据的**判别力不变**
  // （库没开必须不假装成功 / 库开了必须真做成），但消费点从裸返回值改成 `.ok`。这里三处：
  //   :337 库未开 → ok 必须 false；:350 库已开 → ok 必须 true；:430 close 后 → ok 必须 false。
  // 为什么不直接 `store.checkpoint()` 比布尔：那条断言在形状变更后会拿对象恒 != false，变成**恒真空断言**
  // （绿而无意义），比红更危险。故显式取 `.ok`，并顺带把 before/after 写进 ③ 的通过行（Task 3 留痕的旁证）。
  assert.strictEqual(store.checkpoint().ok, false, "库还没开就 checkpoint 必须 ok:false，不能假装做了");
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
  const ck1 = store.checkpoint();
  assert.strictEqual(ck1.ok, true, "checkpoint() 在库已开时必须 ok:true");
  const afterCk = store.walBytes();
  assert.ok(afterCk < 4096, `checkpoint() 之后 -wal 仍有 ${afterCk} B（TRUNCATE 没生效）`);
  pass(`③ 500 行流水把 -wal 撑到 ${grown} B，PRAGMA wal_checkpoint(TRUNCATE) 后 ${afterCk} B`
    + `（checkpoint() 自报 before=${ck1.before} after=${ck1.after}）`);

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

  // close() 必须自己成对停表（Task 2 把这条交给 Task 3 的优雅停机，落地方式是 close() 内 stopCheckpointTimer()）。
  // 为什么不让停机路径自己记得停：startCheckpointTimer 返回的 stop 函数一旦在多层调用里丢手，
  // 就留下一条打在已关闭句柄上的 interval；close() 是句柄归属的收口点，成对关系只有它能保证。
  const ckStop = store.startCheckpointTimer(30);
  assert.strictEqual(typeof ckStop, "function", "③ close 成对判据的前提：startCheckpointTimer 要返回 stop 函数");
  store.close();                                            // 关句柄，同时应当把刚挂上的计时器一起收
  rows(500, 2000);                                          // 重新开库写一轮（open() 幂等）
  assert.ok(store.walBytes() > 4096, "③ close 成对判据的前提不成立：这一轮没把 -wal 撑起来");
  await sleep(200);                                         // 计时器若还活着（6.7 个周期），WAL 会被压回去
  const afterClose = store.walBytes();
  assert.ok(afterClose > 4096,
    `store.close() 之后 -wal 又被压回 ${afterClose} B —— close() 没成对 stopCheckpointTimer()，留着一条无人认领的 interval`);
  pass(`③ close() 成对收表：close() 之后再写一轮，200 ms 内 -wal 仍保持 ${afterClose} B（计时器确实随 close 停了）`);

  // close() 的语义：先 checkpoint 再关句柄（正常退出留不下大 WAL）。
  // 静态判据只是**第一道**：那条正则靠「列 0 的 }」收口函数体，日后有人把嵌套块写成列 0、或把
  // checkpoint 抽进 helper，被捕获的范围会静默变化而判据仍绿。故下面补一条运行期兜底，两闸并存。
  const storeSrc = fs.readFileSync(path.join(BACKEND, "proxy", "store.cjs"), "utf8");
  const closeBody = /function close\(\)\s*\{([\s\S]*?)\n\}/.exec(storeSrc);
  assert.ok(closeBody, "store.cjs 里找不到 function close() 的函数体");
  assert.match(closeBody[1], /checkpoint\(\)/,
    "close() 关句柄前没有先 checkpoint()：退出路径留下的 WAL 只能靠 SQLite 自己收，运行期无人收敛");
  pass("③ close() 体内先 checkpoint() 再 db.close()（静态：退出路径不留大 WAL）");

  // 运行期兜底：直接盯 node:sqlite 的调用序列，断言 db.close() 之前真的发出过 PRAGMA wal_checkpoint。
  // 为什么非要这条：SQLite 关掉最后一个连接时自己也会收敛并删掉 -wal，所以「close 前有没有显式 checkpoint」
  // 在文件系统层不可区分（两边都是 0 B）；驱动调用层可区分，spy 原型方法即可覆盖 store 已持有的那个连接实例。
  const { DatabaseSync } = require("node:sqlite");
  const origExec = DatabaseSync.prototype.exec;
  const origDbClose = DatabaseSync.prototype.close;
  const seq = [];                                   // 按发生顺序记 {ck} / {close} / {sql}
  DatabaseSync.prototype.exec = function (sql, ...rest) {
    const flat = String(sql).replace(/\s+/g, " ").trim();
    seq.push(/wal_checkpoint/i.test(flat) ? { ck: true } : { sql: flat.slice(0, 20) });
    return origExec.call(this, sql, ...rest);
  };
  DatabaseSync.prototype.close = function (...rest) {
    seq.push({ close: true });
    return origDbClose.apply(this, rest);
  };
  rows(500, 1500);
  const grownBeforeClose = store.walBytes();
  assert.ok(grownBeforeClose > 4096, `close 兜底的前提不成立：-wal 只有 ${grownBeforeClose} B，没长起来就看不出它被收敛过`);
  // 父进程自己也照这条要求交出句柄，否则最后删临时目录会被 Windows 咬住（EBUSY）
  store.close();
  DatabaseSync.prototype.exec = origExec;
  DatabaseSync.prototype.close = origDbClose;
  const seqText = seq.map((x) => (x.close ? "db.close()" : x.ck ? "wal_checkpoint" : "exec:" + x.sql)).join(" → ") || "（一次调用都没发出）";
  const ckAt = seq.findIndex((x) => x.ck);
  const closeAt = seq.findIndex((x) => x.close);
  assert.ok(ckAt >= 0,
    `store.close() 期间没向 SQLite 发出过 PRAGMA wal_checkpoint（调用序列：${seqText}）—— 静态那条绿了也不作数，退出路径的 WAL 只能靠 SQLite 自己收`);
  assert.ok(closeAt >= 0, `store.close() 没有真的关掉数据库句柄（调用序列：${seqText}）`);
  assert.ok(ckAt < closeAt,
    `PRAGMA wal_checkpoint 落在 db.close() 之后或同级（调用序列：${seqText}）—— 「关之前先收敛」这个时机不对`);
  pass(`③ close() 运行期兜底：spy 到 wal_checkpoint 在 db.close() 之前发出（序列 ${seqText}，close 前 -wal ${grownBeforeClose} B）`);

  assert.strictEqual(store.walBytes(), 0, "close() 之后 -wal 没被收干净：句柄可能还挂在父进程手里");
  assert.strictEqual(store.checkpoint().ok, false, "close() 之后再 checkpoint 必须 ok:false（句柄确实没了，不是假关）");

  // ===== ④ store.close() 有真实调用点：静态引用 + 运行期真跑到 proxy.shutdown() =====
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
