// 反代网关 · AutoClaw 桌面端登录态读取（参照实现 providers/autoclaw/credentials.rs + crypto.rs）
//
// 两个来源：
//   ① %APPDATA%/AutoClaw/auth.json —— token/refreshToken 为 Electron safeStorage 密文
//      （`enc:<base64>`，v10 = AES-256-GCM，密钥在 Local State 的 os_crypt.encrypted_key，
//      DPAPI 解出）。历史版本/手工改动可能是明文（兼容处理，明文自带 Bearer 前缀需剥）。
//   ② ~/.openclaw-autoclaw/openclaw.json —— 明文 JWT（models.providers.*.models[].headers
//      里的 X-Authorization），**无 refresh_token**，只能用不能刷。
//
// 两地（国内/国际构建）共用同一个 auth.json 且文件本身没有地区标记——
// 地区判定**不在此处做**：扫描层对两个渠道各产出候选，用户自己选（猜错可见 = 401，重导即可）。
// DPAPI/AES-GCM 设施复用 qoderAuth.cjs（同为 Electron safeStorage v10 形态）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const qoderAuth = require("../qoderAuth.cjs");
const { jwtDecode } = require("../util.cjs");

const MAX_AUTH_FILE_SIZE = 256 * 1024;

function roamingDir() {
  return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
}

/** auth.json / Local State 路径（非 Windows 也给路径：读到加密字段时报错更可诊断） */
function desktopPaths() {
  const dir = path.join(roamingDir(), "AutoClaw");
  return {
    authFile: path.join(dir, "auth.json"),
    localState: path.join(dir, "Local State"),
    openclawFile: path.join(os.homedir(), ".openclaw-autoclaw", "openclaw.json"),
  };
}

function readJsonFile(file, label) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  if (!st.isFile() || st.size > MAX_AUTH_FILE_SIZE) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${label} 无法解析（不是有效 JSON）：${String((e && e.message) || e).slice(0, 80)}`);
  }
}

/** os_crypt 密钥：Local State 的 encrypted_key → DPAPI。非 Windows/读不到返回 null */
function loadOsCryptKey(localStatePath) {
  if (process.platform !== "win32") return null;
  const state = readJsonFile(localStatePath, "AutoClaw Local State");
  const b64 = state && state.os_crypt && state.os_crypt.encrypted_key;
  if (!b64) return null;
  try {
    return qoderAuth.dpapiUnprotectKey(b64);
  } catch {
    return null;
  }
}

/** 解一个 enc: 字段（或明文直回）。解密失败抛错（带人话） */
function decryptEncValue(value, key) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!raw.startsWith("enc:")) return raw.replace(/^Bearer\s+/i, "").trim();
  if (!key) throw new Error("登录态是加密格式但无法取得解密密钥（仅支持 Windows 上已登录的 AutoClaw 客户端）");
  const b64 = raw.slice(4).trim();
  let blob;
  try { blob = Buffer.from(b64, "base64"); } catch {
    throw new Error("AutoClaw 加密字段不是合法 base64");
  }
  try {
    return qoderAuth.decryptV10(blob, key).replace(/^Bearer\s+/i, "").trim();
  } catch {
    throw new Error("AutoClaw 登录态解密失败（常见于与客户端不同的 Windows 用户）");
  }
}

/** JWT 里的 user_id（解不出给空串） */
function uidFromToken(token) {
  try {
    const payload = jwtDecode(token);
    return String((payload && (payload.user_id || payload.uid || payload.sub)) || "");
  } catch { return ""; }
}

/** openclaw.json 的 token：models.providers.*.models[].headers 里第一个非空 X-Authorization */
function tokenFromOpenclaw(parsed) {
  const providers = parsed && parsed.models && parsed.models.providers;
  if (!providers || typeof providers !== "object") return "";
  for (const p of Object.values(providers)) {
    const models = p && Array.isArray(p.models) ? p.models : [];
    for (const m of models) {
      const headers = m && m.headers;
      if (!headers || typeof headers !== "object") continue;
      const t = String(headers["X-Authorization"] || headers["x-authorization"] || "").trim();
      if (t) return t.replace(/^Bearer\s+/i, "").trim();
    }
  }
  return "";
}

/**
 * 读桌面登录态（auth.json 优先，openclaw.json 兜底）。
 * 返回 { ok, token, refreshToken, deviceId, uid, name, email, source, message? }。
 * auth.json 存在但解密失败 → 如实抛/报错（不静默回落，否则错误被掩盖）。
 */
function readDesktopLogin() {
  const paths = desktopPaths();
  if (fs.existsSync(paths.authFile)) {
    const parsed = readJsonFile(paths.authFile, "AutoClaw auth.json");
    if (parsed && typeof parsed === "object") {
      const token = String(parsed.token || "");
      if (!token.trim()) throw new Error("AutoClaw auth.json 中没有 token");
      const key = loadOsCryptKey(paths.localState);
      const plain = decryptEncValue(token, key);
      const refreshToken = (() => {
        try { return decryptEncValue(parsed.refreshToken, key); } catch { return ""; }
      })();
      const info = parsed.userInfo && typeof parsed.userInfo === "object" ? parsed.userInfo : {};
      const uid = String(info.id || info.user_id || "") || uidFromToken(plain);
      return {
        ok: true,
        token: plain,
        refreshToken,
        deviceId: String(parsed.deviceId || ""),
        uid,
        name: String(info.name || info.nickname || info.user_name || ""),
        email: String(info.email || ""),
        source: "auth.json",
      };
    }
    // auth.json 存在但结构不对 → 尝试 openclaw.json，都不行才报 auth.json 的错
  }
  const oc = readJsonFile(paths.openclawFile, "AutoClaw 网关配置 openclaw.json");
  if (oc) {
    const token = tokenFromOpenclaw(oc);
    if (token) {
      return {
        ok: true,
        token,
        refreshToken: "", // openclaw.json 只有 access token，无 refresh_token（不可刷新）
        deviceId: "",
        uid: uidFromToken(token),
        name: "",
        email: "",
        source: "openclaw.json",
      };
    }
    if (fs.existsSync(paths.authFile)) throw new Error("AutoClaw auth.json 结构异常且 openclaw.json 中没有可用 token");
  }
  return { ok: false, message: "本机未找到 AutoClaw 登录态（%APPDATA%/AutoClaw/auth.json 不存在）" };
}

module.exports = { readDesktopLogin, desktopPaths, decryptEncValue, tokenFromOpenclaw, uidFromToken };
