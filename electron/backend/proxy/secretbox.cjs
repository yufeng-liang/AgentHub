// 凭据加解密的唯一实现（Task 0 先落骨架）。后端优先级：safeStorage（主进程）→
// plain-dev（开发态明文，保住 tools/proxy-smoke 等纯 Node 自测）→ none（打包态无能力：拒写明文）。
// Task 1 在 safeStorage 与 plain-dev 之间补 v10 分支（纯 Node 子进程用 DPAPI+AES-256-GCM 解 Chromium os_crypt 密文）。
// 注意方向：本模块不得 require("../config.cjs")（config 反过来委派这里，会成环）。
"use strict";

const ENC_PREFIX = "enc:v1:"; // 与 config.cjs 既有密文前缀一致

let safeStorage = null;
try {
  const el = require("electron");
  if (el && typeof el === "object" && el.safeStorage && el.safeStorage.isEncryptionAvailable()) safeStorage = el.safeStorage;
} catch { /* 纯 Node 子进程 / 系统 Node：无 electron 绑定，走下面的降级链 */ }

/** 打包态判据：不能用 app.isPackaged（子进程没有 app），asar 路径在两种角色下都是真字符串。 */
function packaged() { return __dirname.includes("app.asar"); }

/** 当前凭据后端："safeStorage" | "plain-dev" | "none"（Task 1 起追加 "v10"）。 */
function backend() {
  if (safeStorage) return "safeStorage";
  // D3 裁决：明文降级只限非打包态；打包态无加密能力即 none，encrypt 会拒写。
  return packaged() ? "none" : "plain-dev";
}

// encrypt/decrypt 此刻逐字保持 config.cjs 原有 safeStorage 语义（不引入新逻辑）；
// 打包态 none 的拒写闸门按 §5.3 定案一并生效，v10 分支留给 Task 1。
function encrypt(plain) {
  const s = String(plain || "");
  if (!s || s.startsWith(ENC_PREFIX)) return s; // 空值或已是密文不重复加密
  const b = backend();
  if (b === "safeStorage") return ENC_PREFIX + safeStorage.encryptString(s).toString("base64");
  if (b === "plain-dev") return s; // 开发态降级明文（既有语义）
  throw new Error("凭据加密不可用：拒绝以明文写入号池");
}

function decrypt(stored) {
  const s = String(stored || "");
  if (!s.startsWith(ENC_PREFIX)) return s; // 明文（降级环境存的）直接用
  if (!safeStorage) return ""; // 无加密能力：既有语义是解不开返回空串让用户重填
  try {
    return safeStorage.decryptString(Buffer.from(s.slice(ENC_PREFIX.length), "base64"));
  } catch {
    return ""; // 密文来自其他机器解不开，让用户重填
  }
}

/** 启动期闸门占位（Task 3 子进程入口调用）：打包态拿不到任何解密能力即失败，不空号池空转。 */
function assertUsable() {
  if (backend() === "none") throw new Error("凭据解密失败：打包环境无 safeStorage（v10 分支由 Task 1 补）");
}

// 仅供测试自证「确实是从预期路径 require 进来的」（如 asar）；不参与任何生产判断。
module.exports = { backend, encrypt, decrypt, assertUsable, __selfCheck: __dirname };
