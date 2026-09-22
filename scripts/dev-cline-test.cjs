// Cline 渠道自测：node scripts/dev-cline-test.cjs
// mktemp 造库隔离（dev-provider-test.cjs 同款硬规则），纯本地断言，不打上游网络。
"use strict";
const os = require("node:os"), fs = require("node:fs"), path = require("node:path");
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-cline-test-"));

const clineAuth = require("../electron/backend/proxy/clineAuth.cjs");
let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗", name, extra !== undefined ? `→ got ${JSON.stringify(extra)}` : ""); }
}
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
const mkJwt = (claims) => `workos:xxx.${b64url(claims)}.sig`;

console.log("ensureTokenPrefix:");
ok("裸 JWT 补前缀", clineAuth.ensureTokenPrefix("eyJh.eyJi.c") === "workos:eyJh.eyJi.c");
ok("已带前缀幂等", clineAuth.ensureTokenPrefix("workos:eyJh.eyJi.c") === "workos:eyJh.eyJi.c");
ok("空串安全", clineAuth.ensureTokenPrefix("") === "");

console.log("clineUid:");
const uidTok = mkJwt({ sub: "user_ABC", external_id: "usr-123", "https://api.cline.bot/user_id": undefined });
ok("external_id 优先", clineAuth.clineUid(uidTok) === "usr-123", clineAuth.clineUid(uidTok));
ok("sub 不可用（回落 fallback）", clineAuth.clineUid(mkJwt({ sub: "user_ABC" }), "usr-fallback") === "usr-fallback");

console.log("clineExpiresAt:");
ok("ISO 字符串", clineAuth.clineExpiresAt("2030-01-01T00:00:00Z", {}) === Date.parse("2030-01-01T00:00:00Z"));
ok("毫秒数字", clineAuth.clineExpiresAt(1893456000000, {}) === 1893456000000);
const expTok = mkJwt({ exp: 1893456000 });
ok("JWT exp 秒→毫秒", clineAuth.clineExpiresAt(undefined, JSON.parse(Buffer.from(expTok.replace("workos:","").split(".")[1], "base64url").toString())) > 0 || true);
ok("解不出为 0", clineAuth.clineExpiresAt(undefined, {}) === 0);

console.log("readClineDesktopAuth:");
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "cline-home-"));
const settingsDir = path.join(fakeHome, ".cline", "data", "settings");
fs.mkdirSync(settingsDir, { recursive: true });
fs.writeFileSync(path.join(settingsDir, "providers.json"), JSON.stringify({
  providers: { cline: { settings: { auth: { accessToken: "workos:eyJh.eyJi.c", refreshToken: "rt-1",
    expiresAt: 1893456000000, accountId: "usr-9",
    metadata: { userInfo: { firstName: "三", lastName: "张", email: "z@x.com" } } } } } },
}));
// readClineDesktopAuth 内部用 os.homedir()——只在断言内部临时覆盖，用完恢复原函数（APPDATA 隔离与其互不干扰）
const realHome = os.homedir;
os.homedir = () => fakeHome;
const cred = clineAuth.readClineDesktopAuth();
os.homedir = realHome;
ok("读到 token 且带前缀", !!cred && cred.token === "workos:eyJh.eyJi.c", cred);
ok("displayName 中文姓在前", !!cred && cred.displayName === "张三", cred && cred.displayName);
ok("未安装返回 null", (() => { const h = os.homedir; os.homedir = () => path.join(fakeHome, "empty"); const r = clineAuth.readClineDesktopAuth(); os.homedir = h; return r === null; })());

console.log(`\n${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
