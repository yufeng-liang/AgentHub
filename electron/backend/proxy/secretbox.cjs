// 凭据加解密的唯一实现。后端优先级：safeStorage（主进程）→ v10（纯 Node，DPAPI+AES-256-GCM）→
// plain-dev（开发态明文）→ none（打包态无能力：encrypt 抛错，绝不明文落盘）。
//
// 为什么要有 v10 分支：二期网关跑在没有 electron 绑定的纯 Node 子进程里，而存量密文全是
// Chromium os_crypt 的 v10 形态（实测 enc:v1: 载荷头三字节 = ASCII "v10"，Local State 的
// os_crypt.encrypted_key 283 B、头五字节 "DPAPI"）。热路径每请求至少 4 次解密
// （server.cjs 的 settings()→loadConfig()→decryptSecret×2 + store.accountSecrets×2），
// 逐次回主进程取会直接劣化 TTFT，也和「主 App 可以整体退出」自相矛盾（规格 §5.3）。
//
// 本模块曾是 config.cjs 的第二真相源而被 Task 0 复审删掉，现在两边同批切换：
// encrypt/decrypt 在这里落地，config.cjs 的 encryptSecret/decryptSecret 逐字委派过来，实现只此一份。
// 注意方向：本模块不得 require("../config.cjs")（config 反过来委派这里，会成环），数据目录自己解析。
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ENC_PREFIX = "enc:v1:";
const V10 = "v10";
const NONCE_LEN = 12;
const TAG_LEN = 16;

// 只保存 safeStorage 对象本身，**不在模块加载时**问 isEncryptionAvailable()。
// 理由（Task 0 复审 I2）：加载时机被 index.cjs 的顶层 require + main.cjs:17 的顶层 require 钉死在
// app.whenReady() 之前，加载期取值会把「ready 前 = false」这一瞬时状态锁成整进程快照 →
// 打包版主进程 backend() 恒为 "none"。能力一律每次调用现判。
let safeStorage = null;
try {
  const el = require("electron");
  if (el && typeof el === "object" && el.safeStorage) safeStorage = el.safeStorage;
} catch { /* 纯 Node 子进程 / 系统 Node：无 electron 绑定，走下面的降级链 */ }

function safeStorageReady() { return !!(safeStorage && safeStorage.isEncryptionAvailable()); }

/** 打包态判据：不能用 app.isPackaged（子进程没有 app）。asar 路径在两种角色下都是真字符串。
 *  硬约束：网关子进程入口必须留在 app.asar 内，跑出 asar 会被判成开发态 → plain-dev → 明文落盘。 */
function packaged() { return __dirname.includes("app.asar"); }

// ===== v10：Chromium os_crypt =====
// 链路：Local State 的 os_crypt.encrypted_key（base64）→ 剥 5 字节 ASCII "DPAPI" 前缀 →
//       CryptUnprotectData（无附加熵，绑定当前 Windows 用户，与 safeStorage 同语义）→ 32 B AES-256 主密钥 →
//       node:crypto AES-256-GCM 解 nonce(12B) + 密文 + tag(16B)。
// 不是「直接 CryptUnprotectData 解业务值」：Electron 35 在 Windows 上用的是 Chromium os_crypt，
// 业务密文从未过 DPAPI，一步 DPAPI 解出来是错的东西（规格 §5.3 已更正）。
// 主密钥取一次就缓存：它是一次文件读 + 一次 DPAPI 调用，没有「进程启动早期还没就绪」这种时间依赖，
// 与上面 safeStorage 不许缓存的理由不同。取不到时缓存 false，热路径不重复打 DPAPI。
let keyCache; // undefined = 未取过；Buffer = 可用；false = 取过且不可用

/** 数据目录里的 Local State：与 config.cjs 的 dataDir() 在非 Electron 环境下同一解析口径（%APPDATA%\AgentHub） */
function localStatePath() {
  return path.join(process.env.APPDATA || os.homedir(), "AgentHub", "Local State");
}

// 降级原因只记一次（keyCache/loadFfi 都缓存了失败态），供日志排查「为什么是 none」。
// 绝不打密钥、明文、完整密文。
function note(msg) {
  try { console.error("[secretbox] " + msg); } catch { /* 无 stdout 的场景忽略 */ }
}

let ffi; // undefined = 未试；null = 不可用；对象 = koffi 句柄集
function loadFfi() {
  if (ffi !== undefined) return ffi;
  ffi = null;
  try {
    const koffi = require("koffi");
    const crypt32 = koffi.load("crypt32.dll");
    // 类型名在同一 koffi 实例（= 同一进程）里是全局的，重复 struct() 会抛 Duplicate type name，
    // 故先探一次：一个进程里同时装了主进程那份和别的拷贝时（自测场景）也不会互相撞掉初始化。
    try { koffi.type("AgentHub_DATA_BLOB"); } catch { koffi.struct("AgentHub_DATA_BLOB", { cbData: "uint32_t", pbData: "void*" }); }
    ffi = {
      koffi,
      // 单串声明 + 参数内联注解（探针实测唯一可用写法；分参数数组式与两参 koffi.encode 都会踩坑）
      unprotect: crypt32.func(
        "bool __stdcall CryptUnprotectData(_Inout_ AgentHub_DATA_BLOB *pDataIn, void *pDescStr, void *pEntropy, void *pReserved, void *pPrompt, uint32_t dwFlags, _Out_ AgentHub_DATA_BLOB *pDataOut)"
      ),
      localFree: koffi.load("kernel32.dll").func("void* __stdcall LocalFree(void* hMem)"),
    };
  } catch (e) {
    note("koffi / crypt32 不可用，v10 分支关闭：" + firstLine(e));
  }
  return ffi;
}

function firstLine(e) { return String((e && e.message) || e).split("\n")[0].slice(0, 160); }

/** DPAPI 解密一段字节，失败返回 null。跨语言 Buffer 一律 koffi.decode 拷出（koffi.view 在 Electron 被禁） */
function dpapi(bytes) {
  const f = loadFfi();
  if (!f) return null;
  const out = { cbData: 0, pbData: null };
  try {
    if (!f.unprotect({ cbData: bytes.length, pbData: f.koffi.as(Buffer.from(bytes), "void*") }, null, null, null, null, 0, out)) {
      note("CryptUnprotectData 返回 false（errno " + f.koffi.errno() + "）：本机 DPAPI 不可用");
      return null;
    }
    return Buffer.from(f.koffi.decode(out.pbData, f.koffi.array("uint8_t", out.cbData)));
  } catch (e) {
    note("CryptUnprotectData 抛错：" + firstLine(e));
    return null;
  } finally {
    // 释放失败不致命（最多漏一个主密钥大小的块），但要在日志里留痕
    if (out.pbData) {
      try { f.localFree(out.pbData); } catch (e) { note("LocalFree 失败（不致命）：" + firstLine(e)); }
    }
  }
}

/** 本机 v10 主密钥（32 B），拿不到返回 null */
function osCryptKey() {
  if (keyCache !== undefined) return keyCache === false ? null : keyCache;
  keyCache = false;
  try {
    const p = localStatePath();
    if (!fs.existsSync(p)) return null;
    const b64 = JSON.parse(fs.readFileSync(p, "utf8")).os_crypt.encrypted_key;
    const raw = Buffer.from(String(b64 || ""), "base64");
    if (raw.length < 6 || raw.subarray(0, 5).toString("latin1") !== "DPAPI") return null;
    const key = dpapi(raw.subarray(5));
    if (!key || key.length !== 32) {   // AES-256 主密钥必须 32 B，长度不对一律不认
      note("Local State 的 os_crypt.encrypted_key 解不出 32 B 主密钥");
      return null;
    }
    keyCache = key;
    return key;
  } catch (e) {
    note("Local State 读取失败：" + firstLine(e));
    return null;
  }
}

/** 当前凭据后端："safeStorage" | "v10" | "plain-dev" | "none"。每次调用现判，不缓存判定结果。 */
function backend() {
  if (safeStorageReady()) return "safeStorage";
  if (osCryptKey()) return "v10";
  // D3 裁决：明文降级只限非打包态，否则 tools/proxy-smoke 等纯 Node 自测会莫名变红；
  // 打包态无加密能力即 none，写入侧（encrypt）拒写。
  return packaged() ? "none" : "plain-dev";
}

/** 明文 → enc:v1: 密文。空值与已加密值原样返回；打包态无能力时抛错（闸门，绝不明文落盘）。 */
function encrypt(plain) {
  const s = String(plain || "");
  if (!s || s.startsWith(ENC_PREFIX)) return s;
  const b = backend();
  if (b === "safeStorage") return ENC_PREFIX + safeStorage.encryptString(s).toString("base64");
  if (b === "v10") {
    const nonce = crypto.randomBytes(NONCE_LEN);
    const c = crypto.createCipheriv("aes-256-gcm", osCryptKey(), nonce);
    const ct = Buffer.concat([c.update(s, "utf8"), c.final()]);
    return ENC_PREFIX + Buffer.concat([Buffer.from(V10, "latin1"), nonce, ct, c.getAuthTag()]).toString("base64");
  }
  if (b === "plain-dev") return s;
  throw new Error("凭据加密不可用：拒绝把凭据以明文写入磁盘（号池 token / Key / WebDAV 口令同此）——请确认本机 Local State 与当前用户 DPAPI 可用");
}

/** enc:v1: 密文 → 明文。无信封的存量明文原样返回；解不开一律抛错，不再静默回空串
 *  （旧行为会让「换了机器 / 主密钥不可得」伪装成「号池没号」，见 assertUsable 注释）。 */
function decrypt(stored) {
  const s = String(stored || "");
  if (!s.startsWith(ENC_PREFIX)) return s;             // 存量明文（开发态降级时写的）
  const raw = Buffer.from(s.slice(ENC_PREFIX.length), "base64");
  let ssFail = null;
  if (safeStorageReady()) { try { return safeStorage.decryptString(raw); } catch (e) { ssFail = e; /* 落回 v10 */ } }
  const head = raw.subarray(0, 3).toString("latin1");
  if (head !== V10) {
    throw new Error("凭据解密失败：未知密文形态（头 3 字节 " + JSON.stringify(head) + "）"
      + (ssFail ? "；本机 safeStorage 也解不开，密文可能来自其他机器" : ""));
  }
  if (raw.length < 3 + NONCE_LEN + TAG_LEN) throw new Error("凭据解密失败：v10 密文长度不足（信封被截断）");
  const key = osCryptKey();
  if (!key) throw new Error("凭据解密失败：本机 v10 主密钥不可得（Local State / DPAPI）");
  try {
    const d = crypto.createDecipheriv("aes-256-gcm", key, raw.subarray(3, 3 + NONCE_LEN));
    d.setAuthTag(raw.subarray(raw.length - TAG_LEN));
    return Buffer.concat([d.update(raw.subarray(3 + NONCE_LEN, raw.length - TAG_LEN)), d.final()]).toString("utf8");
  } catch {
    // GCM 标签校验失败 = 密文来自其他机器 / 主密钥已换。抛出去让上层计数，别回空串。
    throw new Error("凭据解密失败：v10 认证标签校验未通过（密文来自其他机器或本机主密钥已变）");
  }
}

/** 启动期闸门：Task 3 的子进程在 listen 之前调用，失败即不启动。
 *  旧行为：decryptSecret 吞错返回 "" → store.tokenUsable 判所有账号不可用 → pool 无候选 → 503，
 *  用户看到的是「号池没号」，真实原因是换了机器 / 主密钥不可得。这里提前一步把真话说清楚。 */
function assertUsable() {
  if (backend() === "none") throw new Error("凭据解密失败：打包环境既无 safeStorage 也无本机 v10 主密钥");
}

// 仅供测试自证「确实是从预期路径（asar 内那份拷贝 / 不含 node_modules/electron 的那份拷贝）require 进来的」；
// 不参与任何生产判断。
module.exports = { backend, packaged, encrypt, decrypt, assertUsable, __selfCheck: __dirname };
