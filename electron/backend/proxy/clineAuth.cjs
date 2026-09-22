// Cline 凭证助手（协议参考 §1）：WorkOS JWT 解析 / token 前缀 / 展示名 / 桌面端登录态读取。
// 只被 adapters.cjs（chat/refresh）与 discovery.cjs（scan/登录）消费，不 require 任何 proxy 模块（防环）。
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const TOKEN_PREFIX = "workos:"; // 实测不带前缀打 chat 一律 401（协议参考 §1.2）

/** 幂等补 workos: 前缀：登录/导入的 token 带，刷新响应不带，发送前统一过这里 */
function ensureTokenPrefix(token) {
  const s = String(token || "").trim();
  if (!s) return "";
  return s.startsWith(TOKEN_PREFIX) ? s : TOKEN_PREFIX + s;
}

/** JWT payload 本地解析（上游只认 token 本身，本地不验签） */
function jwtClaims(token) {
  try {
    const t = String(token || "").replace(/^workos:/, "").trim();
    const parts = t.split(".");
    if (parts.length < 2) return {};
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return payload && typeof payload === "object" ? payload : {};
  } catch {
    return {};
  }
}

/** Cline 账号 id：JWT external_id（usr-… 形态，余额路径的 userId）优先；
 *  sub 是 WorkOS 自己的 user_…，不能用于 Cline API 路径（协议参考 §1.7）。 */
function clineUid(token, fallbackAccountId) {
  const c = jwtClaims(token);
  // §1.7 优先级：external_id > clineUserId（JWT 名域声明）> 调用方 fallback（字符串或带 accountId 的对象）；sub 永不采用
  return String(c.external_id || c["https://api.cline.bot/user_id"] || (fallbackAccountId && fallbackAccountId.accountId) || fallbackAccountId || "");
}

/** 展示名：中文姓在前（CJK 判定），否则西式 firstName+lastName；再退 name/email（协议参考 §1.7） */
function clineDisplayName(claims, email) {
  const info = (claims && claims.metadata && claims.metadata.userInfo) || {};
  const first = String(info.firstName || ""), last = String(info.lastName || "");
  const hasCJK = (s) => /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(s);
  if (first && last) return hasCJK(last) ? last + first : `${first} ${last}`;
  if (info.name) return String(info.name);
  return String(email || info.email || "Cline 账号");
}

/** 过期时间三形态都认（协议参考 §1.3 口径 2）：ISO 8601 串 / 毫秒数字 / JWT exp（秒×1000） */
function clineExpiresAt(raw, claims) {
  const ms = Number(raw);
  if (raw && Number.isFinite(ms) && ms > 1e12) return ms;            // 毫秒数字
  if (typeof raw === "string" && raw) { const p = Date.parse(raw); if (Number.isFinite(p)) return p; }
  const exp = Number(claims && claims.exp);
  return exp > 0 ? exp * 1000 : 0;                                   // JWT exp 兜底（秒）
}

/** 桌面端登录态：~/.cline/data/settings/providers.json → providers.cline.settings.auth（明文，协议参考 §1.7）。
 *  只读不写：刷新结果不回写该文件——网关与桌面端两边都轮换会互相顶掉（参考项目实证决策）。 */
function readClineDesktopAuth() {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".cline", "data", "settings", "providers.json"), "utf8"));
  } catch {
    return null; // 未安装 / 未登录 / 非 JSON
  }
  const auth = parsed && parsed.providers && parsed.providers.cline && parsed.providers.cline.settings && parsed.providers.cline.settings.auth;
  const token = String((auth && auth.accessToken) || "").trim();
  if (!token) return null;
  const claims = jwtClaims(token);
  // 文件里的 auth.metadata.userInfo 是桌面端展示名的权威来源（§1.7）：token 解不出 claims（坏/旧 JWT）时也要能拼出「张三」，
  // 故把文件 userInfo 并入 claims（文件字段优先，JWT 独有字段保留）再走统一拼装。
  const fileUserInfo = (auth && auth.metadata && auth.metadata.userInfo) || {};
  const effClaims = {
    ...claims,
    metadata: {
      ...(claims.metadata || {}),
      userInfo: { ...((claims.metadata && claims.metadata.userInfo) || {}), ...fileUserInfo },
    },
  };
  const email = String(fileUserInfo.email || "");
  return {
    token: ensureTokenPrefix(token),
    refreshToken: String((auth && auth.refreshToken) || "").trim(),
    expiresAt: clineExpiresAt(auth && auth.expiresAt, effClaims),
    accountId: String((auth && auth.accountId) || ""),
    displayName: clineDisplayName(effClaims, email),
  };
}

module.exports = { TOKEN_PREFIX, ensureTokenPrefix, jwtClaims, clineUid, clineDisplayName, clineExpiresAt, readClineDesktopAuth };
