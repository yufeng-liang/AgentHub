// ZCode「过码 / 领取」两段式 IPC 契约闸（2026-09-30 补）。
//
// 为什么需要它：渲染层 src/api/ipc.ts 的 call() 把「返回体 ok===false」一律转成异常抛出。
// 两段式人机校验里有两处踩在这条约定上：
//   ① 过码（proxy_zcode_solve_captcha）第一段只回滑块配置、业务上还没做完，如果写成 ok:false，
//      UI 就再也读不到 needCaptcha，滑块永远弹不出来，只剩一句没信息量的
//      「命令 proxy_zcode_solve_captcha 执行失败」——后端看着正常，纯粹是返回体形状把 UI 打死了。
//   ② 领取（proxy_checkin_run）是批量接口，响应恒为 { ok:true, rows }，needCaptcha/captcha/planId
//      一律挂在**结果行**上；渲染层若去读响应级 r.needCaptcha 就永远是 undefined，二段流形同虚设。
// 这两类缺陷 vue-tsc 都看不见（返回体是对象字面量 / 行对象是宽类型），静态样式闸更看不见。
//
// 判据（直接跑真实 handler，不是照抄一份实现）：
//   ① 过码第一段（不带 verifyParam）必须满足「渲染层不会抛」＝ ok !== false，且带回 needCaptcha + captcha
//   ② 过码第二段（带 verifyParam）成功 → ok:true；失败 → ok:false 且必须带 message
//   ③ 反证：把第一段的旧形状（ok:false 且无 message）喂给同一条判据，必须判为「会抛」
//   ④ 拉配置失败：ok:false 但带 message（正确的失败形态，UI 能显示原因）
//   ⑤ 领取第一跳：响应体恒 ok:true 且**没有**响应级 needCaptcha，需过码状态在结果行上（带 captcha + planId）
//   ⑥ 领取补跑：带 {accountId, captcha, planId} → 该行 ok:true 且不再需过码，且 planId 原样传给适配器
//
// 沙箱：APPDATA / AGENT_SKILLS_HOME 指到临时目录；store / adapters / credits 全部打桩，
// 不联网、不碰真库。跑法：node scripts/dev-zcode-captcha-ipc-test.cjs
"use strict";
if (require.main !== module) return;

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-zcode-captcha-"));
process.env.APPDATA = path.join(WORK, "appdata");
process.env.AGENT_SKILLS_HOME = path.join(WORK, "hub");
fs.mkdirSync(process.env.APPDATA, { recursive: true });

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  ok  ${name}`);
  } else {
    failures.push(name + (detail ? `：${detail}` : ""));
    console.log(`FAIL  ${name}${detail ? `：${detail}` : ""}`);
  }
}

// 渲染层 call() 的拦截判据（src/api/ipc.ts:78）：ok 严格等于 false 就抛
const rendererThrows = (res) => !!res && typeof res === "object" && res.ok === false;

const PROXY = path.join(ROOT, "electron", "backend", "proxy");
const index = require(path.join(PROXY, "index.cjs"));
const store = require(path.join(PROXY, "store.cjs"));
const adapters = require(path.join(PROXY, "adapters.cjs"));

const ACC = { id: "acc-zcode-1", channel: "zcode", name: "测试号", uid: "zcode-user-1", hasToken: true, status: "online" };
store.getAccount = () => ACC;
store.accountSecrets = () => ({ token: "t", jwt: "j" });
store.listAccounts = () => [ACC];
// 领取成功后会顺手刷余额（走网络）；闸里换成空实现，避免真打上游
require(path.join(PROXY, "credits.cjs")).refreshAccount = () => Promise.resolve();

let nextConfig = { ok: true, captcha: { sceneId: "scene-1", prefix: "prefix-1", region: "cn" } };
let nextSolve = { ok: true, message: "人机校验通过" };
const checkinCalls = [];
adapters.get = () => ({
  solveCaptchaConfig: async () => nextConfig,
  solveCaptchaWithParam: async () => nextSolve,
  checkinStatus: async () => ({ ok: true, plans: [{ planId: "plan-1", name: "GLM 编码套餐", priority: 1 }] }),
  /** 第一跳（不带 captcha）照上游形状回「需过码」；带了 captcha 才真正领取 */
  checkin: async (_acc, _secrets, opts) => {
    checkinCalls.push(opts || null);
    if (!opts || !opts.captcha) {
      return {
        ok: false,
        needCaptcha: true,
        planId: "plan-1",
        captcha: { sceneId: "scene-1", prefix: "prefix-1", region: "cn" },
        message: "领取需要完成一次人机校验",
      };
    }
    return { ok: true, message: "领取成功" };
  },
});

const CAPTCHA_CMD = "proxy_zcode_solve_captcha";
const CHECKIN_CMD = "proxy_checkin_run";

(async () => {
  // ① 过码第一段：只回滑块配置
  const first = await index.dispatch(CAPTCHA_CMD, { accountId: ACC.id });
  check("① 过码第一段不会被渲染层 call() 当成异常", !rendererThrows(first), JSON.stringify(first));
  check("① 过码第一段带回 needCaptcha", first && first.needCaptcha === true, JSON.stringify(first));
  check(
    "① 过码第一段带回可用的滑块配置（sceneId 非空）",
    !!(first && first.captcha && first.captcha.sceneId),
    JSON.stringify(first && first.captcha)
  );

  // ② 过码第二段：成功 / 失败两条路
  const done = await index.dispatch(CAPTCHA_CMD, { accountId: ACC.id, verifyParam: "vp-1", region: "cn" });
  check("② 过码第二段成功回 ok:true", done && done.ok === true, JSON.stringify(done));

  nextSolve = { ok: false, message: "人机校验未通过，请重试" };
  const denied = await index.dispatch(CAPTCHA_CMD, { accountId: ACC.id, verifyParam: "vp-bad", region: "cn" });
  check("② 过码第二段失败回 ok:false", denied && denied.ok === false, JSON.stringify(denied));
  check(
    "② 过码第二段失败必须带 message（否则 UI 只有通用文案）",
    !!(denied && typeof denied.message === "string" && denied.message.trim()),
    JSON.stringify(denied)
  );

  // ③ 反证：旧形状必须被同一条判据判为「会抛」
  const legacy = { ok: false, needCaptcha: true, captcha: { sceneId: "scene-1" } };
  check("③ 反证：过码第一段旧形状（ok:false 无 message）会被渲染层抛掉", rendererThrows(legacy));

  // ④ 拉配置失败时：ok:false 但带 message
  nextConfig = { ok: false, message: "上游滑块验证未启用（captcha-config enabled=false）" };
  const cfgFail = await index.dispatch(CAPTCHA_CMD, { accountId: ACC.id });
  check("④ 拉配置失败：ok:false 且带 message", rendererThrows(cfgFail) && !!cfgFail.message, JSON.stringify(cfgFail));
  nextConfig = { ok: true, captcha: { sceneId: "scene-1", prefix: "prefix-1", region: "cn" } };

  // ⑤ 领取第一跳：批量响应恒 ok:true，需过码挂在结果行上
  const batch = await index.dispatch(CHECKIN_CMD, { channel: "zcode", accountId: ACC.id, action: "checkin" });
  check(
    "⑤ 领取响应体恒 ok:true（渲染层不能拿响应级 needCaptcha 当判据）",
    batch && batch.ok === true,
    JSON.stringify(batch && { ok: batch.ok })
  );
  check(
    "⑤ 响应体上没有 needCaptcha（证明「读响应体」这条判据必然进不去）",
    batch && batch.needCaptcha === undefined,
    JSON.stringify(batch && { needCaptcha: batch.needCaptcha })
  );
  const row = ((batch && batch.rows) || [])[0] || {};
  check("⑤ 需过码状态在结果行上", row.needCaptcha === true, JSON.stringify(row));
  check("⑤ 结果行带回滑块配置（sceneId 非空）", !!(row.captcha && row.captcha.sceneId), JSON.stringify(row.captcha));
  check("⑤ 结果行带回 planId（补跑时原样带回，不重新挑套餐）", !!row.planId, JSON.stringify(row.planId));

  // ⑥ 过码后按行补跑：只带那一个账号 + captcha + planId
  const solvedRun = await index.dispatch(CHECKIN_CMD, {
    channel: "zcode",
    accountId: row.accountId,
    action: "checkin",
    captcha: { verifyParam: "vp-1", region: "cn", sceneId: row.captcha && row.captcha.sceneId },
    planId: row.planId,
  });
  const solvedRow = ((solvedRun && solvedRun.rows) || [])[0] || {};
  check("⑥ 带 captcha 补跑后该行 ok:true", solvedRun.ok === true && solvedRow.ok === true, JSON.stringify(solvedRow));
  check("⑥ 补跑后不再需要过码", solvedRow.needCaptcha !== true, JSON.stringify(solvedRow));
  const retryOpts = checkinCalls[checkinCalls.length - 1];
  check(
    "⑥ 适配器收到的是原行的 planId 与 verifyParam",
    !!(
      retryOpts &&
      retryOpts.planId === row.planId &&
      retryOpts.captcha &&
      retryOpts.captcha.verifyParam === "vp-1"
    ),
    JSON.stringify(retryOpts)
  );

  // 清理尽力而为：store.cjs 的 sqlite 句柄可能还开着，rmSync 在 Windows 上会 EPERM
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 临时目录留给系统回收 */ }
  console.log(failures.length ? `\n${pass} 通过 / ${failures.length} 失败` : `\n${pass} 通过 / 0 失败`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.log(`FAIL  闸自身异常：${(e && e.stack) || e}`);
  process.exit(1);
});
