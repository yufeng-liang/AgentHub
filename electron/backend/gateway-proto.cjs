// 管道帧 = 一行一条 JSON（NDJSON）。两端共用，故单独成文件且零依赖。
// k: req 请求 / res 响应 / evt 子进程主动推的事件 / hello 握手
// 不用长度前缀二进制帧：可读性换来的调试价值在这个项目里更高（日志里能直接 grep 到命令名），
// 响应体量最大的是 proxy_pool（全量号池×4 渠道）与 proxy_stats_detail（≤100 行），JSON 足够。
"use strict";
const MAX_FRAME_BYTES = 8 * 1024 * 1024;      // 与 server 的 32MB 请求体上限同量级偏小，超限即断连
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_PENDING = 64;                        // 待响应上界：主 App 卡死时不让子进程堆内存
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
module.exports = { MAX_FRAME_BYTES, DEFAULT_TIMEOUT_MS, MAX_PENDING, NO_TIMEOUT_CMDS, NON_IDEMPOTENT_READS, encode, createParser };
