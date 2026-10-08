// Trae OAuth 回调行为模拟测试（ELECTRON_RUN_AS_NODE 运行）
// 不依赖真实浏览器登录：起本地回环会话，直接向回调端口打请求验证
// ① 空参探测 → 200 挂起页且 error 参数正确结束会话
// ② 裸凭据/错 state 回调被安全拦截且**不**结束会话（validateTraeCallback 的纵深防御）
// ③ 粘贴解析：无凭据 URL 拒绝 / 裸 hash 凭据被拦 / 带 state+trace_id 回声的回调进入换令牌链路
// ④ authCodeInfo 形态粘贴（带会话标识）进入授权码换令牌流程
// 2026-09-30 重写：validateTraeCallback 加固后，「裸凭据直接注入」会被拦（只拒本次、不结束会话），
// 旧夹具不带 state/trace_id 打凭据回调会卡死会话、撞出下一会话「已有进行中的登录」——
// 正向用例改为从授权 URL 里取回 state/login_trace_id 回放（官方页回跳本就原样带回这两个标识）。
"use strict";

// 守卫（三期收尾，2026-09-24）：被 require 时零副作用。本仓 5 个脚本曾因缺它而在被 require 时
// 真把探针跑了一次（Task 5 实现者核验导出面时误触 phase1-browser-pass）。
// 顶层 return 在 CJS 模块包装函数里合法：作为入口时 require.main === module 照常执行。
if (require.main !== module) return;
const discovery = require("../electron/backend/proxy/discovery.cjs");
const rules = require("../electron/backend/proxy/rules.cjs");

const log = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? require("node:https") : require("node:http");
    lib.get(url, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    }).on("error", reject);
  });
}

/** 从授权 URL 里取回 state / login_trace_id：官方页回跳时本就原样带回这两个标识，
 *  模拟回调据此过 validateTraeCallback 的会话校验（缺了它们 = 裸凭据注入，会被安全拦截） */
function markersOf(authUrl) {
  const q = new URL(authUrl, "http://x").searchParams;
  return { state: q.get("state") || "", traceId: q.get("login_trace_id") || "" };
}

let pass = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { pass++; log(`  ok  ${name}`); }
  else { failures.push(name); log(`  FAIL  ${name}${detail ? `：${detail}` : ""}`); }
}

(async () => {
  rules.init();

  // ===== 会话 1：空探测 → 挂起页 → error 参数结束会话 =====
  let done1 = null;
  const r1 = await new Promise((resolve) => {
    discovery.beginOAuth("trae", (res) => { done1 = res; }).then(resolve);
  });
  log(`会话1: ok=${r1.ok} port=${r1.port}`);
  const probe1 = await httpGet(`http://127.0.0.1:${r1.port}/authorize`);
  check("①a 空探测回 200 挂起页", probe1.status === 200 && probe1.body.includes("正在等待授权结果"));
  const err1 = await httpGet(`http://127.0.0.1:${r1.port}/authorize?error=access_denied&error_description=test`);
  await sleep(300);
  check("①b error 参数 → 400 且 onDone 收到明确失败", err1.status === 400 && done1 !== null && done1.ok === false && /access_denied/.test(done1.message || ""));
  check("①c 挂起页含 hash 回捞脚本", probe1.body.includes("location.hash") && probe1.body.includes("location.replace"));

  // ===== 会话 2：安全拦截纵深——裸凭据 / 错 state 都只拒本次、不结束会话 =====
  const r2 = await new Promise((resolve) => {
    discovery.beginOAuth("trae", (res) => {}).then(resolve);
  });
  log(`\n会话2: port=${r2.port}`);
  const probe2 = await httpGet(`http://127.0.0.1:${r2.port}/authorize`);
  check("②a 空探测仍回挂起页", probe2.status === 200 && probe2.body.includes("正在等待授权结果"));
  const bare1 = await httpGet(`http://127.0.0.1:${r2.port}/authorize?refreshToken=bad-token&userInfo=${encodeURIComponent(JSON.stringify({ UserID: "123", ScreenName: "测试" }))}`);
  const alive1 = await httpGet(`http://127.0.0.1:${r2.port}/authorize`);
  check("②b 裸凭据（无 state/trace_id）被安全拦截", bare1.status === 400 && /安全拦截/.test(bare1.body));
  check("②c 拦截后会话仍存活（挂起页还在）", alive1.status === 200 && alive1.body.includes("正在等待授权结果"));
  const badState = await httpGet(`http://127.0.0.1:${r2.port}/authorize?state=wrong-state&refreshToken=bad-token`);
  const alive2 = await httpGet(`http://127.0.0.1:${r2.port}/authorize`);
  check("②d 错 state 被拦（外来回调）", badState.status === 400 && /state 校验不通过/.test(badState.body));
  check("②e 错 state 拦截后会话仍存活", alive2.status === 200 && alive2.body.includes("正在等待授权结果"));
  await discovery.cancelOAuth(); // 拦截路径不结束会话，显式收掉再开下一会话

  // ===== 会话 3：粘贴解析——无凭据 / 裸 hash / 带会话标识的凭据回调 =====
  const r3 = await new Promise((resolve) => {
    discovery.beginOAuth("trae", (res) => {}).then(resolve);
  });
  const m3 = markersOf(r3.url);
  log(`\n会话3: port=${r3.port}`);
  const noCred = await discovery.submitCallbackUrl("http://127.0.0.1:1/authorize", "trae");
  check("③a 粘贴无凭据 URL → 解析拒绝", noCred.ok === false && /解析|凭据/.test(noCred.message || ""), noCred.message);
  const hashForm = await discovery.submitCallbackUrl("http://127.0.0.1:1/authorize#refreshToken=hash-bad-token", "trae");
  check("③b 裸 hash 凭据过得了解析、过不了校验（安全拦截）", hashForm.ok === false && /安全拦截/.test(hashForm.message || ""), hashForm.message);
  await discovery.cancelOAuth(); // 3a/3b 都是被拒路径，会话还活着，收掉再开正向会话
  // 正向：带 state/login_trace_id 回声的凭据回调 → 过校验 → 进换令牌链路（坏 token 会在真上游换失败，
  // 但「进入链路并收尾」本身就是要证的——probe 后会话没被杀，凭据回调照常处理）
  let done3 = null;
  const r3b = await new Promise((resolve) => {
    discovery.beginOAuth("trae", (res) => { done3 = res; }).then(resolve);
  });
  const m3b = markersOf(r3b.url);
  const goodForm = await discovery.submitCallbackUrl(
    `http://127.0.0.1:1/authorize?state=${encodeURIComponent(m3b.state)}&login_trace_id=${encodeURIComponent(m3b.traceId)}&refreshToken=bad-token&userInfo=${encodeURIComponent(JSON.stringify({ UserID: "123", ScreenName: "测试" }))}`,
    "trae"
  );
  await sleep(2500);
  check("③c 带会话标识的凭据回调进入换令牌链路", goodForm.ok === true, goodForm.message);
  check("③d 换令牌链路收尾（坏 token 如实报失败，不悬挂）", done3 !== null && done3.ok === false, JSON.stringify(done3));

  // ===== 会话 4：authCodeInfo 形态粘贴（带会话标识，独立会话避免上一会话已因坏凭据结束） =====
  let done4 = null;
  const r4 = await new Promise((resolve) => {
    discovery.beginOAuth("trae", (res) => { done4 = res; }).then(resolve);
  });
  const m4 = markersOf(r4.url);
  const authCodeInfoForm = await discovery.submitCallbackUrl(
    `http://127.0.0.1:1/authorize?state=${encodeURIComponent(m4.state)}&login_trace_id=${encodeURIComponent(m4.traceId)}&authCodeInfo=${encodeURIComponent(JSON.stringify({ AuthCode: "some-code" }))}`,
    "trae"
  );
  await sleep(200);
  log(`  粘贴authCodeInfo形态: ${JSON.stringify(authCodeInfoForm)} onDone=${JSON.stringify(done4)}`);
  check("④ authCodeInfo 被解析并进入授权码换令牌流程", authCodeInfoForm.ok === true && done4 !== null && done4.ok === false && /HTTP|授权码|令牌/i.test(done4.message || ""));
  await discovery.cancelOAuth();

  log(`\n${failures.length ? "FAIL " + failures.length + " 项" : "OK Trae OAuth 回调模拟全过"}（共 ${pass + failures.length} 项）`);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
