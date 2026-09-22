// AutoClaw 凭证解密链（协议参考 §2.7）：auth.json 是 Electron safeStorage 密文
// （enc: + base64("v10" + 12B nonce + AES-256-GCM(密文+tag 尾置))）；AES key 在 Local State 的
// os_crypt.encrypted_key（DPAPI blob，剥 5 字节 "DPAPI" 后 CryptUnprotectData，当前用户作用域）。
// DPAPI 双路径：Electron safeStorage（主进程）优先，纯 node（测试/降级）走 koffi crypt32——
// koffi 声明风格对齐 sqlcipher.cjs:44-59 既有用法（lib.func + C 原型字符串）。
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ENC_PREFIX = "enc:";
const OS_CRYPT_VERSION = "v10";

function autoclawUserDataDir() {
  return process.env.AUTOCLAW_USER_DATA_DIR
    || path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "AutoClaw");
}

/** 文件防御（协议参考 §2.7）：普通文件（拒符号链接）、(0, 256KB]、JSON 对象根 */
function readJsonGuarded(file) {
  let st;
  try { st = fs.lstatSync(file); } catch { return null; }
  if (!st.isFile() || st.nlink > 1 || !(st.size > 0 && st.size <= 256 * 1024)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
}

// ===== DPAPI（koffi）=====
let _dpapi = null;
function dpapiFns() {
  if (_dpapi) return _dpapi;
  const koffi = require("koffi");
  const crypt32 = koffi.load("crypt32.dll");
  // CRYPTOAPI_BLOB（DATA_BLOB）：cbData + pbData，koffi 默认按 C 编译器对齐，与 Win32 ABI 一致
  const BLOB = koffi.struct("AgentHubDataBlob", { cbData: "uint32", pbData: "void *" });
  // koffi 3.x 已无顶层 koffi.func(lib, ...)，须用 lib.func("C 原型")；SAL 注解仅认 _In_/_Out_
  // （_In_opt_/_Out_opt_ 不识别），可选出参一律声明成普通指针后传 null。
  // 返回值 BOOL 是 4 字节 int，用 "int"（sqlcipher.cjs 同款标量风格）。
  const protect = crypt32.func("int CryptProtectData(_In_ AgentHubDataBlob *pDataIn, void *szDataDescr, void *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32 dwFlags, _Out_ AgentHubDataBlob *pDataOut)");
  const unprotect = crypt32.func("int CryptUnprotectData(_In_ AgentHubDataBlob *pDataIn, void **ppszDataDescr, void *pOptionalEntropy, void *pvReserved, void *pPromptStruct, uint32 dwFlags, _Out_ AgentHubDataBlob *pDataOut)");
  // 两个 API 的输出 blob 均由 LocalAlloc 分配，文档要求 LocalFree 归还；
  // koffi.free 只能释放 koffi.alloc 的内存，混用会破坏堆。
  const kernel32 = koffi.load("kernel32.dll");
  const localFree = kernel32.func("void *LocalFree(void *hMem)");
  // 入参对象 → BLOB（pbData 直接收 Buffer）；出参用 _Out_ + [{}] 数组回读（sqlcipher.cjs 同款）。
  const run = (fn, data) => {
    const out = [{}];
    const okRet = fn({ cbData: data.length, pbData: data }, null, null, null, null, 0, out);
    if (!okRet || !out[0].pbData) throw new Error("DPAPI 调用失败");
    const buf = Buffer.from(koffi.decode(out[0].pbData, "uint8", out[0].cbData));
    localFree(out[0].pbData);
    return buf;
  };
  _dpapi = {
    unprotect: (data) => run(unprotect, data),
    protect: (data) => run(protect, data),
  };
  return _dpapi;
}
function dpapiUnprotect(data) { return dpapiFns().unprotect(data); }
function dpapiProtect(data) { return dpapiFns().protect(data); }

/** 取 32 字节 AES key（协议参考 §2.7 第一步）。按目录缓存。 */
const keyCache = new Map();
function osCryptKey(dir) {
  const cached = keyCache.get(dir);
  if (cached) return cached;
  const state = readJsonGuarded(path.join(dir, "Local State"));
  const enc = state && state.os_crypt && String(state.os_crypt.encrypted_key || "");
  if (!enc || !/^[A-Za-z0-9+/]+={0,2}$/.test(enc)) throw new Error("Local State 缺 os_crypt.encrypted_key");
  const blob = Buffer.from(enc, "base64");
  if (blob.subarray(0, 5).toString("ascii") !== "DPAPI") throw new Error("encrypted_key 缺 DPAPI 前缀");
  const key = dpapiUnprotect(blob.subarray(5));
  if (key.length !== 32) throw new Error(`AES key 长度异常（${key.length}，应为 32）`);
  keyCache.set(dir, key);
  return key;
}

/** 解 enc: 字段（协议参考 §2.7 第二步）：v10 + 12B nonce + AES-256-GCM（无 AAD，tag 尾置 16B）。
 *  Rust 侧「密文+tag 整段交给 GCM」与 Node 手动切 tag 语义相同；长度守卫 ≤28 字节判异常。 */
function decryptEncValue(v, aesKey) {
  const s = String(v || "");
  if (!s.startsWith(ENC_PREFIX)) return s; // 历史版本明文原样返回
  const payload = Buffer.from(s.slice(ENC_PREFIX.length), "base64");
  if (payload.subarray(0, 3).toString("ascii") !== OS_CRYPT_VERSION) throw new Error("不支持的 os_crypt 版本");
  if (payload.length <= 12 + 16) throw new Error("AES-GCM 密文长度异常");
  const nonce = payload.subarray(3, 15);
  const body = payload.subarray(15);
  const tag = body.subarray(body.length - 16);
  const dec = crypto.createDecipheriv("aes-256-gcm", aesKey, nonce);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(body.subarray(0, body.length - 16)), dec.final()]).toString("utf8");
}

/** 明文自带 Bearer 前缀必须剥掉，否则拼出 Bearer Bearer eyJ...（协议参考 §2.7） */
function stripBearer(s) { return String(s || "").replace(/^Bearer\s+/i, "").trim(); }

/** auth.json 对象 → 凭证（纯函数：测试传假对象+假 key；生产走 readAutoClawAuth） */
function parseAuthFile(obj, aesKey) {
  const token = stripBearer(decryptEncValue(obj.token, aesKey));
  if (!token) throw new Error("auth.json 无可用 token");
  const rawRefresh = String(obj.refreshToken || "");
  const refreshPlain = rawRefresh.startsWith(ENC_PREFIX) ? stripBearer(decryptEncValue(rawRefresh, aesKey)) : stripBearer(rawRefresh);
  return { token, refreshToken: refreshPlain, deviceId: String(obj.deviceId || ""), uid: "", name: "", expiresAt: 0 };
}

/** 主入口：读 auth.json。失败抛 auth.json 的错误（比 openclaw.json 的更接近用户动作，协议参考 §2.7 优先级） */
function readAutoClawAuth() {
  const dir = autoclawUserDataDir();
  const obj = readJsonGuarded(path.join(dir, "auth.json"));
  if (!obj) return null;
  try {
    const cred = parseAuthFile(obj, osCryptKey(dir));
    cred.uid = "";
    cred.name = "AutoClaw 账号";
    return cred;
  } catch (e) {
    throw new Error(`AutoClaw 登录态解密失败：${e.message}`);
  }
}

/** 备来源 ~/.openclaw-autoclaw/openclaw.json：models.providers.*.models[].headers 的 X-Authorization
 *  （明文 JWT，无 refreshToken → 天然不可刷新，导入时必须标注；协议参考 §2.7） */
function readOpenclawFallback() {
  const obj = readJsonGuarded(path.join(os.homedir(), ".openclaw-autoclaw", "openclaw.json"));
  if (!obj) return null;
  const providers = (obj.models && obj.models.providers) || {};
  for (const p of Object.values(providers)) {
    for (const m of (p && p.models) || []) {
      const h = (m && m.headers) || {};
      const tok = String(h["X-Authorization"] || h["x-authorization"] || "").trim();
      if (tok) return { token: stripBearer(tok) };
    }
  }
  return null;
}

module.exports = { ENC_PREFIX, autoclawUserDataDir, readJsonGuarded, dpapiProtect, dpapiUnprotect, osCryptKey, decryptEncValue, stripBearer, parseAuthFile, readAutoClawAuth, readOpenclawFallback };
