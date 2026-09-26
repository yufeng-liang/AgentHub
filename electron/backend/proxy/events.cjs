// 反代网关 · 事件广播：请求完成 / OAuth 结果等推送到渲染层（app:event，与更新推送同通道）
//
// 二期两条出口（Task 3）：
//  · 主进程 = 原样遍历 BrowserWindow（一期语义，一个字没改）
//  · 子进程 = setSink(管道广播)，由 gateway.cjs 在 serve() 建成之后注入
// sink 注入点必须在管道建好之后（装配序）：否则子进程启动早期的 emit 无处可写。
"use strict";

let electronWindows = null;
try {
  electronWindows = require("electron").BrowserWindow;
} catch { /* 纯 Node 自测环境 */ }

let sink = null;                      // 主进程=广播窗口；子进程=写管道
function setSink(fn) { sink = fn; }

function emit(payload) {
  if (sink) { sink({ event: "proxy", ...payload }); return; }
  if (!electronWindows) return;
  try {
    for (const win of electronWindows.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send("app:event", { event: "proxy", ...payload });
    }
  } catch { /* 无窗口时静默 */ }
}

module.exports = { emit, setSink };
