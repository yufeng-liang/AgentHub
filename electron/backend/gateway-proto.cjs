// 管道帧 = 一行一条 JSON（NDJSON）。两端共用，故单独成文件且零依赖。
// k: req 请求 / res 响应 / evt 子进程主动推的事件 / hello 握手
// 不用长度前缀二进制帧：可读性换来的调试价值在这个项目里更高（日志里能直接 grep 到命令名），
// 响应体量最大的是 proxy_pool（全量号池×4 渠道）与 proxy_stats_detail（≤100 行），JSON 足够。
"use strict";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;      // 与 server 的 32MB 请求体上限同量级偏小，超限即断连
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_PENDING = 64;                        // 待响应上界：主 App 卡死时不让子进程堆内存
// 服务端**跨连接**的在飞总账（Task 5 刀 1）：MAX_PENDING 只是每连接的账，k 条认证连接各 64 = k×64，
// 规格 §5.2「避免主 App 卡死时子进程堆内存」在多连接下就不成立了。总账取与单连接上界同值：
// 一条连接本来就最多 64 在飞，多连接不因 k 放大子进程的在飞堆量（生产 ≥3 条已认证连接，报告 §十四）。
const MAX_TOTAL_PENDING = 64;
// 背压时不可丢的事件（Task 5 刀 1）：这些事件是 UI 某个等待态的**唯一**出口，丢一帧界面就永久卡住
// （oauth-done 是 ProxyAgentsView 里 oauthWaiting 的唯一清除点）。普通周期事件（poolsync 进度等）
// 丢了不构成用户可见回归，维持「背压即丢」。命名集合承载，刀 2 的 oauth-open 直接加名字即可。
const CRITICAL_EVENTS = new Set(["oauth-done", "oauth-open"]);
// 长任务：本就立即返回、进度靠 evt 回流，不给管道超时（超时留在任务内部）
const NO_TIMEOUT_CMDS = new Set(["proxy_poolsync_run", "proxy_checkin_run", "proxy_credits_refresh"]);
// 带写副作用的读命令：任何"重试/重放"逻辑都必须排除它们（实测 proxy_pool 会回写派生复活）
const NON_IDEMPOTENT_READS = new Set(["proxy_pool", "proxy_status"]);
function encode(obj) { return JSON.stringify(obj) + "\n"; }
function createParser(onFrame, onOverflow) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line) continue;
      let f = null; try { f = JSON.parse(line); } catch { continue; }
      onFrame(f);
    }
    if (buf.length > MAX_FRAME_BYTES) { buf = ""; if (onOverflow) onOverflow(); }
  };
}
module.exports = { MAX_FRAME_BYTES, DEFAULT_TIMEOUT_MS, MAX_PENDING, MAX_TOTAL_PENDING, CRITICAL_EVENTS, NO_TIMEOUT_CMDS, NON_IDEMPOTENT_READS, encode, createParser };
