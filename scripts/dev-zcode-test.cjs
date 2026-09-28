// ZCode 自测：node scripts/dev-zcode-test.cjs
// 用 mkdtemp 隔离 APPDATA 与 ZCODE_SWITCH_HOME，不碰真实目录；stub global.fetch，不打任何上游网络。
// 覆盖：① 地区/模型目录 ② billing 域头 ③ 额度 billing/balance 解析 + 错误分类 ④ 领取 preview/captcha/claim + 失败码 ⑤ 写回本机客户端登录态
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-zcode-test-"));
const ZHOME = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-zcode-home-"));
process.env.ZCODE_SWITCH_HOME = ZHOME;
// 隔离必须到 dataRoot 这一层：ideswitch.zcodeDataRoot 的兜底链里 ZCODE_SWITCH_DATA_ROOT /
// ZCODE_DATA_BASE_DIR 优先于 home——本机若设了它们（如 ZCode 客户端注入的真实数据目录），
// 写回会打到真实 ~/.zcode（2026-09-28 实测踩中）。清掉让 dataRoot 回落到隔离的 ZHOME。
delete process.env.ZCODE_SWITCH_DATA_ROOT;
delete process.env.ZCODE_DATA_BASE_DIR;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  \u2713", name); }
  else { fail++; console.log("  \u2717", name, extra !== undefined ? `\u2192 got ${JSON.stringify(extra)}` : ""); }
}

// ===== stub 上游：按 URL 返回 canned JSON（fetch 契约 = {status,ok,text()}） =====
const enc = (o, status = 200) => ({ status, ok: status >= 200 && status < 300, async text() { return JSON.stringify(o); } });
let lastClaimHeaders = null;
global.fetch = async (url, opts) => {
  const u = String(url);
  if (u.includes("/billing/balance")) return enc({ code: 0, data: { plans: [{ plan_id: "p1", name: "周末套餐", status: "active" }], balances: [
    { plan_id: "p1", show_name: "GLM 提示", total_units: 1000, used_units: 300, remaining_units: 700, unit_type: "token", expires_at: Math.floor(Date.now() / 1000) + 86400 },
    { entitlement_id: "e2", name: "图像额度", total_units: 50, used_units: 50, available_units: 0, meter: "image" },
  ] } });
  if (u.includes("/billing/preview")) return enc({ code: 0, data: { plans: [
    { plan_id: "pp1", name: "周末充电", description: "周末限领", priority: 10, entitlements: [{ meter: "model_usage", unit_type: "token", show_name: "GLM", grant_units: 1000000, period: "weekly" }] },
    { planId: "pp0", name: "低优", priority: 1, entitlements: [] },
  ] } });
  if (u.includes("/client/configs")) return enc({ code: 0, data: { configs: { captcha: { enabled: true, region: "cn-shanghai", prefix: "xxx", sceneId: "sid" } } } });
  if (u.includes("/billing/claim")) { lastClaimHeaders = (opts && opts.headers) || {}; return enc({ code: 1005, msg: "本期已领", data: { plan: { ends_at: Math.floor(Date.now() / 1000) + 3600 } } }); }
  return enc({ code: 0, data: {} });
};

const adapters = require("../electron/backend/proxy/adapters.cjs");
const discovery = require("../electron/backend/proxy/discovery.cjs");
const store = require("../electron/backend/proxy/store.cjs");

(async () => {
  console.log("① 地区映射与模型目录:");
  const cn = adapters._zcodeRegionByChannel("zcode");
  const intl = adapters._zcodeRegionByChannel("zcode_intl");
  ok("国内版 → bigmodel / open.bigmodel.cn", cn.upstreamProvider === "bigmodel" && cn.openaiBase.includes("open.bigmodel.cn") && cn.bizHost === "https://bigmodel.cn");
  ok("国际版 → zai / api.z.ai", intl.upstreamProvider === "zai" && intl.openaiBase.includes("api.z.ai") && intl.bizHost === "https://api.z.ai");
  ok("uid 前缀两地不同", cn.uidPrefix === "zcode-user-" && intl.uidPrefix === "zcode-intl-user-");
  const z = adapters.get("zcode");
  ok("模型目录 11 条 GLM", z.models().length === 11 && z.models().includes("glm-4.6") && z.models().includes("glm-5.3"));
  ok("id 即上游真名（无别名映射）", z.upstreamFor("glm-4.6") === "glm-4.6");
  const body = z.rewriteBody("glm-4.6", { messages: [] });
  ok("rewriteBody 注入 stream + include_usage", body.stream === true && body.stream_options.include_usage === true && body.model === "glm-4.6");

  console.log("② billing 域头（与对话域区分）:");
  const bh = z._billingHeaders("JWT", "mid-1");
  ok("X-Title 是 electron、X-Release-Channel 是 stable", bh["x-title"] === "Z Code@electron" && bh["x-release-channel"] === "stable");
  ok("Authorization=Bearer jwt、带 X-Device-Mid", bh.authorization === "Bearer JWT" && bh["x-device-mid"] === "mid-1");
  ok("token 空则不带 X-Device-Mid", !("x-device-mid" in z._billingHeaders("", "")));

  console.log("③ 额度 billing/balance 解析:");
  const q = await z.queryCredits({ meta: JSON.stringify({ jwt: "j.w.t", device_mid: "dm" }) }, {});
  ok("两个套餐包解析出来", Array.isArray(q.packages) && q.packages.length === 2, q.packages);
  const p1 = q.packages.find((p) => p.code === "p1");
  ok("p1: 总1000/用300/余700 且 show_name 优先", p1 && p1.total === 1000 && p1.used === 300 && p1.remaining === 700 && p1.name === "GLM 提示", p1);
  ok("p1 到期换成毫秒", p1 && p1.expiresAt > 1e12, p1 && p1.expiresAt);
  const e2 = q.packages.find((p) => p.code === "e2");
  ok("e2: available_units=0 作剩余、无到期回 0", e2 && e2.remaining === 0 && e2.expiresAt === 0, e2);
  ok("无 jwt → unavailable（不查额度）", (await z.queryCredits({ meta: "{}" }, {})).unavailable === true);

  console.log("④ 额度错误分类:");
  const savedFetch = global.fetch;
  global.fetch = async () => enc({ code: 401, msg: "expired" }, 401);
  ok("401 → authError", (await z.queryCredits({ meta: JSON.stringify({ jwt: "j" }) }, {})).authError === true);
  global.fetch = savedFetch;

  // __ZCODE_TEST_BODY2__
  console.log("⑤ 领取 preview / captcha / claim:");
  store.getAccount = (id) => id === "z1"
    ? { id: "z1", channel: "zcode", name: "n", uid: "u", meta: JSON.stringify({ jwt: "j.w.t", device_mid: "dm-xyz" }) }
    : (id === "z2" ? { id: "z2", channel: "zcode", name: "n2", uid: "u2", meta: JSON.stringify({}) } : null);
  const pv = await discovery.zcodeClaimPreview("z1");
  ok("preview ok、按 priority 降序（pp1 在前）", pv.ok && pv.plans.length === 2 && pv.plans[0].planId === "pp1", pv.plans && pv.plans.map((p) => p.planId));
  ok("grants 格式化（GLM · 1000000 Token（每周））", pv.plans[0].grants[0] === "GLM · 1000000 Token（每周）", pv.plans[0].grants);
  ok("无 jwt 账号 preview 报错", !(await discovery.zcodeClaimPreview("z2")).ok);
  ok("不存在账号 preview 报错", !(await discovery.zcodeClaimPreview("nope")).ok);
  const cc = await discovery.zcodeClaimCaptchaConfig();
  ok("captcha 配置解析（enabled/sceneId）", cc.ok && cc.enabled === true && cc.sceneId === "sid" && cc.region === "cn-shanghai");
  const cl = await discovery.zcodeClaim("z1", "pp1", "verify-param", "cn-shanghai");
  ok("claim 1005 → ok:false + code + nextAt + 中文文案", cl.ok === false && cl.code === 1005 && cl.nextAt > Date.now() && /本期/.test(cl.message), cl);
  ok("claim 请求带滑块头 + X-Device-Mid", lastClaimHeaders["x-aliyun-captcha-verify-param"] === "verify-param" && lastClaimHeaders["x-aliyun-captcha-verify-region"] === "cn-shanghai" && lastClaimHeaders["x-device-mid"] === "dm-xyz", lastClaimHeaders);
  ok("claim 缺滑块参数直接拒", !(await discovery.zcodeClaim("z1", "pp1", "", "")).ok);
  ok("claim 缺 planId 直接拒", !(await discovery.zcodeClaim("z1", "", "verify", "")).ok);

  console.log("⑥ 写回本机 ZCode 客户端登录态:");
  const ide = require("../electron/backend/proxy/ideswitch.cjs");
  store.getAccount = (id) => id === "w1"
    ? { id: "w1", channel: "zcode", name: "写回号", uid: "zcode-user-42", meta: JSON.stringify({ jwt: "jj", device_mid: "dm9", user_id: "42", region: "cn", upstreamProvider: "bigmodel", oauthAccessToken: "oauth-abc", oauthRefreshToken: "rt", userInfo: JSON.stringify({ id: "42" }) }) }
    : (id === "w0" ? { id: "w0", channel: "zcode", name: "无oauth", uid: "u", meta: JSON.stringify({ jwt: "jj" }) } : null);
  const sw = ide.switchIdeAccount("w1");
  ok("写回成功、路径在 .zcode/v2/credentials.json", sw.ok && sw.file.includes(path.join(".zcode", "v2", "credentials.json")), sw);
  // 隔离守卫：写回必须落在 ZHOME 内。dataRoot 解析被外部 env 劫持时（见文件头注释），在这里硬失败
  // 而不是默默写进真实客户端目录——该断言 2026-09-28 实测拦下过一次真实目录污染。
  ok("隔离守卫：写回文件在 ZHOME 内", sw.ok && path.isAbsolute(sw.file) && sw.file.startsWith(ZHOME + path.sep), { file: sw.file, ZHOME });
  const cred = JSON.parse(fs.readFileSync(sw.file, "utf8"));
  ok("credentials.json 五键齐（含 refresh + user_info）",
    cred.zcodejwttoken === "jj" && cred["oauth:active_provider"] === "bigmodel" && cred["oauth:bigmodel:access_token"] === "oauth-abc" && cred["oauth:bigmodel:refresh_token"] === "rt" && cred["oauth:bigmodel:user_info"] === JSON.stringify({ id: "42" }), Object.keys(cred));
  const tel = JSON.parse(fs.readFileSync(path.join(ZHOME, ".zcode", "v2", "telemetry-state.json"), "utf8"));
  ok("telemetry-state.json 写入 deviceMid", tel.deviceMid === "dm9", tel);
  // 二次写回：保留客户端未知键 + 生成备份
  fs.writeFileSync(sw.file, JSON.stringify({ ...cred, clientOnlyKey: "keep" }, null, 2));
  const sw2 = ide.switchIdeAccount("w1");
  const cred2 = JSON.parse(fs.readFileSync(sw.file, "utf8"));
  ok("二次写回保留未知键 + 有备份", sw2.ok && cred2.clientOnlyKey === "keep" && !!sw2.backup, sw2);
  ok("缺 oauthAccessToken 的账号拒绝写回", !ide.switchIdeAccount("w0").ok);
  const st = ide.ideSwitchStatus();
  ok("状态探测 zcodeInstalled + uid 从 user_info 取", st.zcodeInstalled === true && st.channels.zcode.uid === "42", st.channels.zcode);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
