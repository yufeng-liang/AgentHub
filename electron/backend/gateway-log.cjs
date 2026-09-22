// 网关最小日志落盘（二期 Task 3）：proxyDir()/logs/gateway.log，超 2 MB 轮转保留 1 份旧档。
//
// 为什么要有它：全仓 `electron/backend` 此前**没有任何文件日志**（规格 §5.5 指出的现状缺口）。
// 网关一旦下沉到子进程，「主 App 看不到它」就成了排障的第一道墙——崩因、认领失败、看门狗自杀
// 都必须留在盘上，否则用户侧只剩一句「起不来」。
//
// 与 store.cjs:23 / index.cjs 那句「logs 在 proxyDir」的注释同源：目录真相源只有一个（store.proxyDir()），
// 这里只负责在它下面挂 logs/ 并写文件——不留第二份路径解析。
//
// 写失败一律静默：日志不能反过来搞死网关（appendFileSync 抛错会打断停机路径 / 握手路径）。
//
// 关于轮转的跨进程安全：主进程与子进程都会写同一份日志。追加式写入（O_APPEND）在 Windows 上
// 交错只可能让两行顺序颠倒，不产生半个文件；轮转的 rename 若被两边同刻撞上，最坏结果是旧档
// gateway.log.1 被覆盖一次（丢的是**另一进程**那一档的日志），不是用户数据。
// 因此这里**不引入公共原子写 helper**：Task 2 的写权闸用「同一变量的 writeFileSync + renameSync 配对
// ⇒ 构造式必须含 pid」这条结构判据守原子写，一旦 write/rename 一起搬进 helper 判据就完全隐身。
// 日志这一族用 append 语义已经够，不为它开那道口子。
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const store = require("./proxy/store.cjs");   // 只取 proxyDir()（路径真相源），不调 open()

const MAX_BYTES = 2 * 1024 * 1024;            // 超此值轮转（规格 §5.5：2 MB / 保留 1 份旧档）

function logsDir() {
  const d = path.join(store.proxyDir(), "logs");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function logFile() {
  return path.join(logsDir(), "gateway.log");
}

/** 一行一条：`<ISO 时间> <kind> <字段 JSON>`。kind 是可 grep 的事件名（boot / pipe-reject / exit…） */
function line(kind, fields) {
  try {
    const f = logFile();
    try {
      if (fs.statSync(f).size > MAX_BYTES) fs.renameSync(f, f + ".1");
    } catch { /* 文件还不存在 = 无需轮转 */ }
    const tail = fields && typeof fields === "object" ? " " + JSON.stringify(fields) : "";
    fs.appendFileSync(f, new Date().toISOString() + " " + String(kind) + tail + "\n", "utf8");
  } catch { /* 日志写不进去绝不影响网关本身 */ }
}

module.exports = { line, logFile, logsDir, MAX_BYTES };
