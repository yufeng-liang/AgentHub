// 自动感知：后台每 15 秒快照各工具技能目录的一层条目（名字+类型+mtime），
// 快照连续两拍稳定且变了才动作；只判断"变没变"，不看内容，开销随条目数走
// 设计：零冲突零 error 的新收纳/挂载自动执行（覆盖删除全进回收站可还原）；
// 有冲突绝不替人裁决，只托盘提醒
"use strict";
const fsp = require("node:fs/promises");
const path = require("node:path");
const config = require("./config.cjs");
const adapter = require("./adapter.cjs");
const syncer = require("./syncer.cjs");
const remotesync = require("./remotesync.cjs");

const INTERVAL_SECONDS = 15;

let timer = null;
let baseline = ""; // 已对过账的快照
let pending = "";  // 刚变化、还没确认稳定的快照
let lastScanAt = 0;
let busy = false;
let ticking = false; // 重入闸：fingerprint 异步化后跨拍可能重叠，两个 handle 并发会重复收纳
let stopped = false; // 停机标志：stop() 拦不住已经 await 出去的那一拍，得由它自己作废
let onEvent = null; // main.cjs 挂的桌面通知回调

async function fingerprint(cfg) {
  const parts = [];
  for (const t of adapter.resolveScanTargets(cfg)) {
    const list = [];
    let entries;
    try {
      entries = await fsp.readdir(t.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      let st;
      try {
        st = await fsp.lstat(path.join(t.dir, e.name));
      } catch {
        continue;
      }
      const kind = st.isSymbolicLink() ? "l" : st.isDirectory() ? "d" : st.isFile() ? "f" : "?";
      // 目录条目的 mtime 在成员文件被原地编辑时不变（NTFS 口径）：技能目录加算其
      // SKILL.md 的 mtime+size，纯内容编辑（最常见的技能变更）也能被感知
      let extra = "";
      if (kind === "d") {
        try {
          const sm = await fsp.stat(path.join(t.dir, e.name, "SKILL.md"));
          extra = `${Math.round(sm.mtimeMs)}:${sm.size}`;
        } catch { /* 无 SKILL.md 或读不到 */ }
      }
      list.push(`${e.name}\u0000${kind}\u0000${st.mtimeMs}\u0000${extra}`);
    }
    list.sort();
    parts.push(`${t.id}\u0001${list.join("\n")}`);
  }
  return parts.join("\v");
}

function status() {
  return { intervalSeconds: INTERVAL_SECONDS, lastScanAt };
}

// 变化判断：只有真正挡执行的内容冲突 / 异常才算硬冲突，不自动执行；
// L2 归一是"疑似同名"提示，不阻碍零风险收纳，照常自动跑
function handle(cfg, fp) {
  if (remotesync.isRunning()) return; // WebDAV 同步占用中央仓库，这拍先让
  const plan = syncer.planSync(cfg);
  const hard = plan.actions.some((a) => a.type === "error")
    || plan.conflicts.some((c) => c.kind === "content" || c.kind === "diff-link");
  if (hard) {
    baseline = fp;
    if (onEvent) onEvent({ kind: "conflict", count: plan.conflicts.length });
    return;
  }
  if (!plan.actions.some((a) => a.type === "import" || a.type === "mount")) {
    baseline = fp; // 只是链接形态/内容变化后的第二拍收敛，对完账就静默
    return;
  }
  busy = true;
  try {
    // executeSync 内部会按当前磁盘重新规划，计划落地后快照由下一拍自然收敛
    const r = syncer.executeSync(cfg, plan);
    baseline = fp;
    if (onEvent && r.summary && (r.summary.imported || r.summary.mounted || r.summary.merged)) {
      onEvent({ kind: "synced", summary: r.summary });
    }
  } finally {
    busy = false;
  }
}

async function tick() {
  lastScanAt = Date.now();
  if (ticking || busy) return; // await 引入后可能跨拍重叠，必须闸住
  ticking = true;
  try {
    const cfg = config.loadConfig();
    if (!(cfg.watch && cfg.watch.enabled)) {
      baseline = "";
      pending = "";
      return;
    }
    const fp = await fingerprint(cfg);
    if (stopped) return; // 停机期间 resume 的一拍直接作废，见 stop()
    if (!baseline) {
      baseline = fp; // 启动留基线，不立刻把历史存货收走
      return;
    }
    if (fp === baseline) {
      pending = "";
      return;
    }
    if (fp === pending) {
      handle(cfg, fp); // 连续两拍一致才动手，AI 写一半不算
      return;
    }
    pending = fp;
  } catch {
    /* 感知异常静默，下一拍重试 */
  } finally {
    ticking = false;
  }
}

function start() {
  if (timer) return;
  stopped = false; // 允许重启感知：不清掉的话 start 之后每一拍都自我作废
  timer = setInterval(tick, INTERVAL_SECONDS * 1000);
}

// 只清 timer 不够：stop() 那一刻可能正有一拍挂在 fingerprint 的 await 上，它会在停机之后
// resume 并走到 handle()（真搬文件）+ onEvent（桌面通知）。旧同步版一拍跑完，before-quit
// 结构上看不到在飞扫描；现在必须留标志让那拍自己作废——尤其 main.cjs 的 pendingInstall
// 分支会 preventDefault 后继续 pump 事件循环，stop() 之后循环还长着。
// 判据用 stopped 而不是"timer 为空"：后者把"没排班"和"停机"混成一件事，而 tick 是导出给
// 自测直连调用的（dev-watch-test.cjs 从不调 start()），那样每拍都会被作废。
function stop() {
  stopped = true;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { start, stop, tick, fingerprint, handle, status, setOnEvent: (fn) => { onEvent = fn; } };