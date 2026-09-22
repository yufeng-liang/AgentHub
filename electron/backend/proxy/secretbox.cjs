// 凭据后端的判据入口（Task 0 只落这一层）。后端优先级：safeStorage（主进程）→
// plain-dev（开发态明文，保住 tools/proxy-smoke 等纯 Node 自测）→ none（打包态无能力：拒写明文）。
// Task 1 在这里补 v10 分支（纯 Node 子进程用 DPAPI+koffi 解 Chromium os_crypt 密文），
// 并把 encrypt/decrypt/assertUsable 与 config.cjs 的委派改动**同批**落地——
// 加解密实现此刻仍只有 config.cjs:31-47 一份真相源，不在这里复制第二份（复制必然漂移）。
// 注意方向：本模块不得 require("../config.cjs")（config 反过来委派这里，会成环）。
"use strict";

// 只保存 safeStorage 对象本身，**不在模块加载时**问 isEncryptionAvailable()。
// 理由：加载时机被 index.cjs 的顶层 require + main.cjs:17 的顶层 require 钉死在 app.whenReady() 之前，
// 而 safeStorage 的可用性要到 ready 之后才确定；在加载期取值并缓存会把「ready 前 = false」
// 这一瞬时状态锁成整进程快照 → 打包版主进程 backend() 恒为 "none"，网关页长期误报「凭证加密不可用」，
// Task 3 的启动闸门也会据同一快照误杀正常子进程。与 config.cjs:34/41 的既有写法对齐：能力每次调用时判。
let safeStorage = null;
try {
  const el = require("electron");
  if (el && typeof el === "object" && el.safeStorage) safeStorage = el.safeStorage;
} catch { /* 纯 Node 子进程 / 系统 Node：无 electron 绑定，走下面的降级链 */ }

/** 打包态判据：不能用 app.isPackaged（子进程没有 app），asar 路径在两种角色下都是真字符串。 */
function packaged() { return __dirname.includes("app.asar"); }

/** 当前凭据后端："safeStorage" | "plain-dev" | "none"（Task 1 起追加 "v10"）。每次调用现判，不缓存。 */
function backend() {
  if (safeStorage && safeStorage.isEncryptionAvailable()) return "safeStorage";
  // D3 裁决：明文降级只限非打包态；打包态无加密能力即 none，写入侧（config.cjs）会拒写明文。
  return packaged() ? "none" : "plain-dev";
}

// 仅供测试自证「确实是从预期路径（不含 node_modules/electron 的那份拷贝）require 进来的」；
// 不参与任何生产判断。
module.exports = { backend, packaged, __selfCheck: __dirname };
