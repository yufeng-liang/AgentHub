// 反代网关 · 编排层：模块装配 + IPC 命令注册（对应前端 src/views/proxy/* 与 src/api/ipc.ts）
// 设置统一存框架整体配置 config.json 的 proxy 段（config.cjs 默认值深合并），每次读取走磁盘 = 热生效；
// 端口属例外：改端口由 proxy_restart 同进程 stop→listen 秒级完成（方案 §6.6 第②层）
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const config = require("../config.cjs");
const store = require("./store.cjs");
const rules = require("./rules.cjs");
const pool = require("./pool.cjs");
const adapters = require("./adapters.cjs");
const discovery = require("./discovery.cjs");
const credits = require("./credits.cjs");
const server = require("./server.cjs");
const events = require("./events.cjs");
const util = require("./util.cjs");
const ideswitch = require("./ideswitch.cjs");
const poolsync = require("./poolsync.cjs");
const ccswitch = require("./ccswitch.cjs");
const zip = require("../zip.cjs");
const secretbox = require("./secretbox.cjs");

// getShell 只在 2 条「留主进程」命令的**同名实现体**里被引用：proxy_open_rules_dir /
// proxy_open_data_dir 的 openPath。这两条在主进程由 gateway-client.cjs 用真 shell 另行实现
// （UI_LOCAL 四条之二），子进程表里的这份实现体只是命令表完整性的一部分，永远不会被派发到 ——
// 顶层 require("electron") 会让整张依赖图在纯 Node 子进程里加载不了（Task 0 实测唯一 FAIL 点），
// 故惰性取 + 拿不到时明确抛错，而不是让子进程 require 到一半炸掉。
function getShell() {
  try {
    const el = require("electron");
    return el && typeof el === "object" ? el.shell : null;
  } catch {
    return null;
  }
}

// ===== 号池 JSON 导入（粘贴 / 文件共用）：单个对象或数组，字段容忍常见别名 =====

// 一条记录归一化为 addAccount 入参；token 为空返回 null（交由上层按无效计数）
function normalizeAccountJson(raw, fallbackChannel) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const channel = adapters.get(raw.channel) ? String(raw.channel) : fallbackChannel;
  let token = String(raw.token ?? raw.accessToken ?? raw.access_token ?? raw.jwt ?? raw.JWT ?? "").trim();
  token = token.replace(/^Cloud-IDE-JWT\s+/i, "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const refreshToken = String(raw.refreshToken ?? raw.refresh_token ?? "").trim();
  const dec = util.jwtDecode(token);
  const uid = String(raw.uid ?? raw.userId ?? raw.user_id ?? dec.uid ?? "").trim();
  return {
    channel,
    uid,
    name: String(raw.name ?? raw.remark ?? "").trim(),
    token,
    refreshToken,
    expiresAt: Number(raw.expiresAt ?? raw.expires_at ?? 0) || 0,
    source: "json",
  };
}

/** 解析 JSON 文本（对象 / 数组 / {accounts:[...]} 包装），返回 { list, invalid } */
function parseAccountsJson(text, fallbackChannel) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ""));
  } catch {
    throw new Error("JSON 解析失败：内容不是合法 JSON");
  }
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed && parsed.accounts) ? parsed.accounts : [parsed];
  const list = [];
  let invalid = 0;
  for (const item of arr) {
    const acc = normalizeAccountJson(item, fallbackChannel);
    if (acc) list.push(acc);
    else invalid++;
  }
  return { list, invalid };
}

/** 批量入池：同渠道同 uid 已存在则跳过；入池即后台查一次额度 */
function importAccounts(list) {
  const existing = store.listAccounts();
  let added = 0, dup = 0;
  for (const acc of list) {
    if (acc.uid && existing.some((a) => a.channel === acc.channel && a.uid === acc.uid)) {
      dup++;
      continue;
    }
    const id = store.addAccount(acc);
    credits.refreshAccount(id).catch(() => {}); // 入池即查一次额度（失败不阻塞）
    added++;
  }
  return { added, dup };
}

/** 网关设置（框架整体配置的 proxy 段，深合并默认值后必有完整结构） */
function settings() {
  return config.loadConfig().proxy;
}

let booted = false;
// 子进程角色开关：attachGatewayMode() 置真。它改的是两件事——事件出口换管道（events.setSink）、
// boot() 不再按 restoreOnLaunch 自动 listen（监听决策归主进程）。除此之外本模块零分支。
let gatewayAttached = false;

// ===== 签到（Trae ug 签到 / WB 双区 daily-checkin / WB AI trial 加油包，参考项目实证端点） =====
/** 批量签到动作：channel 为空 = 全渠道；accountId 指定 = 单账号（OAuth 登录后自动签到用）。
 *  国际版没有每日签到体系，checkin 动作对它自动改走 trial 加油包（与号池页按钮行为一致） */
let checkinBusy = false;
async function checkinBatch({ channel, accountId, action }) {
  const acts = ["status", "checkin", "trial"];
  const act = acts.includes(String(action)) ? String(action) : "checkin";
  if (checkinBusy && act !== "status") return { ok: false, action: act, total: 0, okCount: 0, rows: [], message: "签到进行中" };
  if (act !== "status") checkinBusy = true;
  try {
    const accounts = store.listAccounts().filter(
      (a) =>
        (!channel || a.channel === channel) &&
        (!accountId || a.id === accountId) &&
        a.hasToken &&
        a.status !== "disabled"
    );
    const rows = [];
    for (const acc of accounts) {
      const ad = adapters.get(acc.channel);
      const useAct = act === "checkin" && acc.channel === "workbuddy_ai" ? "trial" : act;
      const secrets = store.accountSecrets(store.getAccount(acc.id));
      try {
        let r;
        if (useAct === "status") r = await ad.checkinStatus(acc, secrets);
        else if (useAct === "checkin") r = await ad.checkin(acc, secrets);
        else r = typeof ad.trial === "function" ? await ad.trial(acc, secrets) : { ok: false, message: "该渠道没有加油包" };
        rows.push({ accountId: acc.id, channel: acc.channel, name: acc.name, uid: acc.uid, ok: !!r.ok, ...r });
        // 签到成功（且不是幂等/不可用）后顺手刷新余额，让号池立刻看到新积分
        if (useAct !== "status" && r.ok && !r.unavailable && !r.already) {
          credits.refreshAccount(acc.id).catch(() => {});
        }
      } catch (e) {
        rows.push({ accountId: acc.id, channel: acc.channel, name: acc.name, uid: acc.uid, ok: false, message: String((e && e.message) || e) });
      }
    }
    const okCount = rows.filter((r) => r.ok).length;
    events.emit({ type: "credits" });
    return { ok: true, action: act, total: rows.length, okCount, rows };
  } finally {
    if (act !== "status") checkinBusy = false;
  }
}

// ===== 定时自动签到：每天到点自动跑一次全渠道（Trae/WorkBuddy 每日签到 + 国际版领加油包） =====
// setInterval 常驻、tick 动态读配置——开关/时间改完即生效，无需重启；当天已跑过不重跑。
// 重启应用后当天会再跑一次：签到/加油包都是幂等语义（already 不算失败），无害
let checkinTimer = null;
let lastAutoCheckinDay = "";
function checkinAutoTick() {
  try {
    const cfg = settings();
    if (!cfg.checkinAuto) return;
    const now = new Date();
    const [h, m] = String(cfg.checkinAutoTime || "09:00").split(":").map((x) => Number(x) || 0);
    const planned = new Date(now);
    planned.setHours(h, m, 0, 0);
    if (now < planned) return;
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (lastAutoCheckinDay === day) return;
    lastAutoCheckinDay = day;
    checkinBatch({ action: "checkin" }).catch(() => {});
  } catch {
    /* 配置读取失败下轮再试 */
  }
}
function startCheckinAuto() {
  stopCheckinAuto();
  checkinTimer = setInterval(checkinAutoTick, 60000);
}
function stopCheckinAuto() {
  if (checkinTimer) clearInterval(checkinTimer);
  checkinTimer = null;
}

/** 启动装配：规则热加载初始化 + 数据库 + 定时额度刷新 + 按上次的开关状态恢复网关
 *  （restoreOnLaunch 不是「用户偏好」而是「上次退出时网关是开是关」，默认 false → 首次打开是关闭的）
 *
 *  二期（Task 3）：attachGatewayMode() 之后这段自启监听**不再生效**——监听决策归主进程
 *  （Task 6 会把 restoreOnLaunch 重定义为「本次启动是否让子进程进入监听」）。
 *  今天子进程走的是 gateway.cjs 自己的装配序（rules.init + store.open + 周期 checkpoint），
 *  不经 boot()，所以这条开关是给「同一个 index.cjs 被子进程 require」留下的边界声明。 */
async function boot() {
  if (booted) return;
  booted = true;
  rules.init();
  store.open();
  credits.startScheduler(() => settings().creditsRefreshMin);
  startCheckinAuto();
  if (!gatewayAttached && settings().restoreOnLaunch) {
    server.start(settings).then(() => events.emit({ type: "status" })).catch(() => {});
  }
}

/** 停机：先让在途监听与定时任务停下，最后才关库句柄（顺序反了会让在途请求写到已关闭的 db 上）。
 *  store.close() 在这里落地 = stats.db 的句柄归属有人收（二期写权归子进程独占，Task 3 把它升级成
 *  gracefulShutdown 并接上 stopAsync / 周期 checkpoint 计时器的停止）。
 *  与下面 gracefulShutdown() 的分工：这条是**主进程退出路径**的同步版——before-quit 不会 await 它，
 *  所以全程必须同步，否则 store.close() 赶不上进程退出；子进程侧用 await 版。
 *  Task 7 的装更互锁会把两者收敛到 gateway-client.stopAndWait() 一条实现上。 */
function shutdown() {
  credits.stopScheduler();
  stopCheckinAuto();
  discovery.cancelOAuth();
  server.stop();
  store.close();
}

/** 排空在途异步作业的预算上限（ms）。它与 server.cjs 的 CLOSE_BUDGET_MS、gateway.cjs 的
 *  RESPONSE_FLUSH_MS 一起构成「等干净的三段之和 < gateway.cjs 那条唯一硬退计时器的 EXIT_CEILING_MS」
 *  这条不变式（评审 I2②：旧值 1000 + stopAsync 的 1000 已经吃掉整个 2 s 上界，"必须退"总是抢在
 *  "等干净"前面拿到决定权）。四个数字由 scripts/dev-gateway-pipe-test.cjs 的**同一条断言**钉住，
 *  合计口径也只有那一条断言在算（CLOSE + DRAIN + FLUSH = 1600 < 2000）——这里不留第二个「预算」导出，
 *  免得下一位改数的人把少算一段的那个当成真相源。 */
const DRAIN_BUDGET_MS = 800;

/** 子进程侧唯一的优雅停机实现（Task 7 的 gateway_shutdown 命令体复用它，不开第二份）。
 *  与一期 shutdown() 的三处差别：① server.stop() 换成 await server.stopAsync()——
 *    stop()（server.cjs 的 stop）连监听释放都不等，跨进程场景下 NSIS 要的是映像解锁 + 端口释放；
 *  ② store.close() 内含 checkpoint 与周期计时器停止（Task 2 落地了调用点，Task 3 成对收尾计时器）；
 *  ③ 追加 rules.close() + drainLibuvWork()：热重载 watcher 既 ref 着事件循环，它首扫丢到
 *    libuv 线程池的 readdir/stat 作业又会在进程已 exit 时被工作线程回报到已关闭的 uv_async_t 上
 *    （实测 0xC0000409 fastfail，见 rules.close 的注释）。停机的定义因此必须含「在途异步作业落地」。
 *  返回值一路原样交给父进程（gateway.cjs 把它编进 gateway_shutdown 的响应）：
 *   · drained=false 排空超时、· forced=true 监听没在预算内释放、· port 是刚释放的那个端口。
 *  这两布尔缺一不可地上报（评审 I2③）：本任务最坏的失败形态「停不干净」过去在代码里是被允许通过的那一支。 */
async function gracefulShutdown() {
  credits.stopScheduler();
  stopCheckinAuto();
  discovery.cancelOAuth();
  const st = await server.stopAsync();
  await rules.close();
  store.close();
  const drained = await drainLibuvWork();
  return { ok: true, drained, forced: !!st.forced, port: Number(st.port) || 0 };
}

/** libuv 线程池上还有没有在途作业（fs 异步请求这类）。getActiveResourcesInfo() 是 Node 18+ 的
 *  公开 API，它把 handle 与 request 混在同一个数组里返回；request 的名字一律带 "Req"
 *  （FSReqCallback / GetAddrinfoReq / FileHandleReq），handle 的名字一律是 *Wrap / Timeout /
 *  Immediate，所以按 "Req" 取的就是「工作线程上还压着的活」。只等 request 不等 handle：
 *  handle 漏关是本机代码的配置问题，不该拿「给进程续命」来兜。 */
function pendingLibuvWork() {
  try { return process.getActiveResourcesInfo().filter((n) => /Req/.test(String(n))).length; }
  catch { return 0; }   // runtime 不提供这个 API 时不阻塞停机，行为退回修复前
}

/** 排空在途异步作业，带上界：停不干净也必须让 NSIS 拿到解锁的映像，不许把安装器挂死。
 *  返回是否在预算内排空（超时只是「没等到」，不是错误）。 */
async function drainLibuvWork(budgetMs) {
  const deadline = Date.now() + (Number(budgetMs) > 0 ? Number(budgetMs) : DRAIN_BUDGET_MS);
  while (pendingLibuvWork() > 0) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
}

// ===== IPC =====

function ok(data) {
  return { ok: true, ...data };
}
function fail(message) {
  return { ok: false, message: String((message && message.message) || message) };
}
function handle(fn) {
  return async (_event, args) => {
    try {
      return await fn(args || {});
    } catch (e) {
      return fail(e);
    }
  };
}

/** 号池全量视图：三渠道聚合 + 账号明细 + 调度策略（号池页数据源） */
function poolView() {
  const agents = store.listAgents();
  return store.CHANNELS.map((c) => {
    const summary = pool.poolSummary(c.id);
    const accounts = pool.poolAccounts(c.id).map((a) => ({ ...a, modelCool: pool.accountModelCool(a.id) }));
    return {
      ...c,
      poolStrategy: (agents.find((a) => a.id === c.id) || {}).poolStrategy || "expire_first",
      summary,
      accounts,
    };
  });
}

function gatewayStatus() {
  const s = server.status();
  const cfg = settings();
  return {
    ...s,
    port: s.running ? s.port : cfg.port,
    bind: s.running ? s.bind : cfg.bind,
    baseUrl: `http://${s.running ? s.bind : cfg.bind}:${s.running ? s.port : cfg.port}/v1`,
    today: store.statsToday(),
    channels: store.CHANNELS.map((c) => ({ id: c.id, display: c.display, ...pool.poolSummary(c.id) })),
    keyCount: store.listKeys().length,
    vaultOk: vaultOk(),
    dbDriver: store.driver(),
  };
}

// 保险可用性 = 「凭据能不能被解」，与在哪个进程无关。旧实现只看 safeStorage，
// 子进程里没有 electron 绑定 → 恒 false → 网关页误报（见 §5.7 更正：这条命令因此可转发）。
function vaultOk() { return secretbox.backend() !== "none"; }

// rememberRunning（proxy.restoreOnLaunch 的写权）二期 Task 5 撤出本文件、上移到
// gateway-client.cjs：启停命令的转发体在主进程，成功后由**主进程**写 config.json。
// 子进程永不写 config.json —— 那是主进程的写权（Task 2 的写权归属），留在这里就会双写。

/** 子进程侧后台作业（二期 Task 5）：额度定时刷新 + 定时自动签到。
 *  这两个计时器过去在主进程 boot() 里跑；43 条命令下沉子进程后随实现体一起下沉 ——
 *  留在主进程就会双跑（同一批号被签到两次、同一批号被刷两次额度），这是 gateway.cjs
 *  文件头「子进程不跑计时器」那条注释的解除时刻。签到/刷新的实现体本就在本模块
 *  （checkinBatch / credits），gateway.cjs 装配时调用这里这一个入口，不开第二份实现。 */
function startBackgroundJobs() {
  credits.startScheduler(() => settings().creditsRefreshMin);
  startCheckinAuto();
}

function register(ipcMain) {
  // ===== 服务启停 / 状态（主进程侧的薄包装见 gateway-client.cjs：转发 + 成功后写 restoreOnLaunch） =====
  ipcMain.handle("proxy_status", handle(() => gatewayStatus()));
  ipcMain.handle("proxy_start", handle(async () => {
    const r = await server.start(settings);
    // claimed 分支的 restoreOnLaunch 守卫（评审 I3）随写权一起上移到 gateway-client.cjs：
    // 那条分支里本进程没有监听，配置不能记「本机在监听」，判断依据是响应里的 claimed 字段。
    events.emit({ type: "status" });
    // claimed：端口其实被**已常驻的网关**占着（server.cjs 的 EADDRINUSE 分支查过 gateway.json 并双检通过），
    // 此时本进程没有监听，接管状态与端口归属都由认领方维持（Task 6 的认领路径依赖这条不报错）
    return r.ok ? ok({ port: r.port, already: !!r.already, claimed: !!r.claimed }) : fail(r.message);
  }));
  ipcMain.handle("proxy_stop", handle(() => {
    server.stop();
    events.emit({ type: "status" });
    return ok({});
  }));
  // 改端口后调用：同进程 stop→listen，秒级完成（方案 §6.6）
  ipcMain.handle("proxy_restart", handle(async () => {
    const st = await server.stopAsync();
    // 评审裁定（Task 5 刀 2）：stop 没在预算内释放端口（forced=true）时**不盲启**。旧实现无视
    // forced 继续 start()，那个端口上挂着的正是自己没释放干净的旧监听 —— EADDRINUSE 分支的
    // probeResidentGateway 还会把它误认成「常驻网关」接管（claimed），看似成功实则无人监听，
    // 而且主进程会照常把 restoreOnLaunch 记成 true。代价：用户要手动再点一次（预算 1.5 s 内
    // 端口通常早释放了，forced 本来就是罕见路径），换来「成功必然真在监听」这个不变式。
    if (st.forced) {
      events.emit({ type: "status" });
      return fail("旧监听未能在预算内释放（端口 " + (Number(st.port) || settings().port) + " 仍被占用），请稍后重试");
    }
    const r = await server.start(settings);
    credits.startScheduler(() => settings().creditsRefreshMin); // 刷新周期一并热生效
    events.emit({ type: "status" });
    return r.ok ? ok({ port: r.port }) : fail(r.message);
  }));

  // ===== API Keys =====
  ipcMain.handle("proxy_keys_list", handle(() => store.listKeys()));
  ipcMain.handle("proxy_key_create", handle(({ name, route, dailyQuota, rateLimit }) => {
    const r = store.createKey({ name, route, dailyQuota, rateLimit });
    const row = store.listKeys().find((k) => k.id === r.id);
    // 完整 Key 已以 DPAPI 信封存库，列表接口随时可取（列表行内即带 secret）
    return { ...row, secret: r.secret };
  }));
  ipcMain.handle("proxy_key_update", handle(({ id, name, route, dailyQuota, rateLimit, enabled }) => {
    if (!store.updateKey(id, { name, route, dailyQuota, rateLimit, enabled })) return fail("Key 不存在");
    return ok({});
  }));
  ipcMain.handle("proxy_key_delete", handle(({ id }) => {
    if (!store.deleteKey(id)) return fail("Key 不存在");
    return ok({});
  }));

  // ===== 号池 =====
  ipcMain.handle("proxy_pool", handle(() => poolView()));
  ipcMain.handle("proxy_pool_strategy", handle(({ channel, strategy }) => {
    if (!store.setPoolStrategy(channel, strategy)) return fail("不支持的调度策略");
    return ok({});
  }));
  // 手动粘贴（方案 §2.4 三途径之一）；token 仅本地加密存储
  ipcMain.handle("proxy_account_add", handle(({ channel, name, token, refreshToken, uid }) => {
    if (!adapters.get(channel)) return fail("未知渠道");
    if (!String(token || "").trim()) return fail("请粘贴 token / JWT");
    const clean = String(token).trim().replace(/^Cloud-IDE-JWT\s+/i, "").replace(/^Bearer\s+/i, "");
    const dec = util.jwtDecode(clean);
    const id = store.addAccount({
      channel,
      uid: String(uid || dec.uid || ""),
      name: String(name || "").trim() || (dec.uid ? `账号 ${dec.uid.slice(-6)}` : "手动添加"),
      token: clean,
      refreshToken: String(refreshToken || "").trim(),
      source: "paste",
    });
    credits.refreshAccount(id).catch(() => {}); // 入池即查一次额度（失败不阻塞）
    return ok({ id });
  }));
  ipcMain.handle("proxy_account_remove", handle(({ id }) => {
    const acc = store.getAccount(id);
    if (!acc) return fail("账号不存在");
    // 先写墓碑再删本机：删除要经 WebDAV 传播到其他设备（号池同步拉取时按墓碑移除）
    poolsync.noteRemoved(poolsync.accountKeyOf(acc));
    if (!store.removeAccount(id)) return fail("账号不存在");
    return ok({});
  }));
  ipcMain.handle("proxy_account_toggle", handle(({ id, enabled }) => {
    const acc = store.getAccount(id);
    if (!acc) return fail("账号不存在");
    store.updateAccount(id, enabled
      ? { status: "online", coolUntil: 0, coolReason: "" }
      : { status: "disabled" });
    return ok({});
  }));
  // 手动解除冷却：cooling 账号立即回 online，同时豁免该账号的模型级负缓存
  ipcMain.handle("proxy_account_cool_off", handle(({ id }) => {
    const r = pool.releaseCool(String(id || ""));
    return r.ok ? ok({ releasedModels: r.releasedModels }) : fail(r.message);
  }));
  ipcMain.handle("proxy_account_refresh", handle(({ id }) => credits.refreshAccount(id)));
  ipcMain.handle("proxy_credits_refresh", handle(() => credits.refreshAll()));
  // 号池页右上角「刷新当前渠道」：只刷一个编译器的号池额度
  ipcMain.handle("proxy_credits_refresh_channel", handle(({ channel }) => {
    if (!channel) return fail("缺少渠道参数");
    return credits.refreshChannel(String(channel));
  }));

  // ===== 签到（Trae ug 签到 / WB 双区 daily-checkin / WB AI trial 加油包，参考项目实证端点） =====
  // 批量签到动作见模块级 checkinBatch（手动 IPC 与定时自动签到共用）
  ipcMain.handle("proxy_checkin_status", handle(({ channel, accountId }) => checkinBatch({ channel, accountId, action: "status" })));
  ipcMain.handle("proxy_checkin_run", handle(({ channel, accountId, action }) => checkinBatch({ channel, accountId, action: action || "checkin" })));

  // ===== 凭据接入：本机软件导入 =====
  ipcMain.handle("proxy_scan", handle(() => {
    const found = discovery.scanAll();
    const existing = store.listAccounts();
    return found.map((c) => ({
      ...c,
      token: "", // 凭据不出主进程：导入时按候选标识回读
      refreshToken: "",
      imported: !!(c.uid && existing.some((a) => a.channel === c.channel && a.uid === c.uid)),
    }));
  }));
  // 导入本机候选：index 指向 proxy_scan 返回的数组下标；
  // 同时带上 channel/file 做一次身份核对 —— 两次扫描之间文件可能增减，只认下标会导错账号
  ipcMain.handle("proxy_scan_import", handle(({ index, channel, file, uid }) => {
    const found = discovery.scanAll();
    let c = found[Number(index)];
    if (file || uid) {
      // 身份核对：以 file/uid 为准回查，防止两次扫描之间候选增减导致按下标导错账号
      const hit = found.find((x) => (file && x.file === file) || (uid && x.uid === uid && (!channel || x.channel === channel)));
      if (!hit) return fail("候选已变化（本地登录态可能刚被更新），请重新扫描后再导入");
      c = hit;
    }
    if (!c) return fail("候选不存在，请重新扫描");
    const r = discovery.importCandidate(c, channel || undefined);
    credits.refreshAccount(r.id).catch(() => {});
    return ok({ id: r.id, updated: r.updated });
  }));
  // oauth_begin 的形状（Task 5）：本进程只创建 OAuth 会话，登录页的打开由**主进程**做 ——
  // 会话建好、拿到 url 后推 {type:"oauth-open", url} 事件（CRITICAL_EVENTS 成员，背压不丢），
  // 主进程收到才 shell.openExternal。旧实现在这里直接开浏览器，下沉后拿不到 shell。
  // 抛错时机说明：beginOAuth 同步抛的错（已有进行中的登录 / 未知渠道 / 小浣熊不支持）在
  // handle() 里收成 {ok:false, message}，用户立刻看到；旧实现「beginOAuth 成功之后才可能
  // 因 shell 缺失而抛错」的那条路径随 openExternal 下移而消失（主进程 shell 恒在）。
  ipcMain.handle("proxy_oauth_begin", handle(async ({ channel }) => {
    const ch = adapters.get(channel) ? String(channel) : store.CHANNELS[0].id;
    const r = await discovery.beginOAuth(ch, (result) => {
      if (result.ok) {
        credits.refreshAccount(result.id).catch(() => {});
        // 登录后自动签到一次（参考项目 login.sh / signin 同款：自动签到 + 查积分）
        checkinBatch({ accountId: result.id, action: "checkin" }).catch(() => {});
      }
      events.emit({ type: "oauth-done", channel: ch, ...result });
    });
    if (r.ok && r.url) events.emit({ type: "oauth-open", channel: ch, url: r.url });
    return r.ok ? ok({ url: r.url, mode: r.mode }) : fail(r.message);
  }));
  ipcMain.handle("proxy_oauth_cancel", handle(() => ok({ cancelled: discovery.cancelOAuth() })));
  // 浏览器没跳回回环地址时的兜底：把地址栏内容整段粘回来完成登录
  ipcMain.handle("proxy_oauth_submit_callback", handle(({ channel, url }) => discovery.submitCallbackUrl(url, channel)));

  // ===== 凭据接入：粘贴 JSON / 从 JSON/ZIP 文件添加（批量，字段容忍别名） =====
  ipcMain.handle("proxy_account_import_json", handle(({ channel, json }) => {
    const fallback = adapters.get(channel) ? String(channel) : store.CHANNELS[0].id;
    const { list, invalid } = parseAccountsJson(json, fallback);
    if (!list.length) return fail(invalid ? `没有可导入的账号（${invalid} 条记录缺 token）` : "没有可导入的账号");
    const r = importAccounts(list);
    const parts = [`成功导入 ${r.added} 个账号`];
    if (r.dup) parts.push(`${r.dup} 个同 UID 已存在跳过`);
    if (invalid) parts.push(`${invalid} 条记录缺 token 忽略`);
    return ok({ ...r, invalid, message: parts.join("，") });
  }));
  // 从 JSON/ZIP 文件添加 · 子进程半段（Task 5 拆两段）：主进程弹框读字节、base64 过管道
  // 投到这条命令（zip.readZip + importAccounts，即拆分前的 :412-432 主体）。文件选择框在
  // 纯 Node 子进程里弹不了，字节过管道后实现体留在这一侧——号池写权（store）归子进程独占。
  // name：原始文件名，zip 判定沿用「按扩展名」（拆分前就是 /\.zip$/i），结果文案也用它。
  ipcMain.handle("proxy_account_import_blob", handle(({ channel, blob, name }) => {
    const fallback = adapters.get(channel) ? String(channel) : store.CHANNELS[0].id;
    const buf = Buffer.from(String(blob || ""), "base64");
    if (!buf.length) return fail("文件内容为空");
    const fileName = String(name || "");
    let texts = [];
    if (/\.zip$/i.test(fileName)) {
      let entries;
      try {
        entries = zip.readZip(buf).filter((e) => /\.json$/i.test(e.name));
      } catch (e) {
        return fail("压缩包读取失败：" + String((e && e.message) || e));
      }
      if (!entries.length) return fail("压缩包里没有 .json 文件");
      texts = entries.map((e) => e.data.toString("utf8"));
    } else {
      texts = [buf.toString("utf8")];
    }
    let added = 0, dup = 0, invalid = 0;
    for (const text of texts) {
      let parsed;
      try {
        parsed = parseAccountsJson(text, fallback);
      } catch {
        invalid++; // 单个 JSON 坏了不拖垮整包
        continue;
      }
      invalid += parsed.invalid;
      const r2 = importAccounts(parsed.list);
      added += r2.added;
      dup += r2.dup;
    }
    if (!added && !dup) return fail(`没有可导入的账号（${invalid ? `${invalid} 条记录无效` : "文件为空"}）`);
    const parts = [`成功导入 ${added} 个账号`];
    if (dup) parts.push(`${dup} 个同 UID 已存在跳过`);
    if (invalid) parts.push(`${invalid} 条记录无效忽略`);
    return ok({ added, dup, invalid, message: parts.join("，") });
  }));
  ipcMain.handle("proxy_account_import_file", handle(() =>
    fail("该命令的文件选择半段只在主进程：子进程表保留这个占位名是为逐字相等闸（④ ⊇ ②）无例外，字节应经 proxy_account_import_blob 投递")));
  // webdav_shared_save 的反向跨界半段（Task 5）：主进程改了 WebDAV 共享口令后投这条命令，
  // 在**子进程内**给 sync-state.json 记 keyChangeAt（那份文件归子进程独占，主进程不再直接写）
  ipcMain.handle("proxy_poolsync_password_changed", handle(() => {
    poolsync.onSharedPasswordMaybeChanged();
    return ok({});
  }));

  // ===== 模型目录 =====
  // 合并视图 + 管理态（启停/渠道覆盖/回退模型）；管理态由渲染层写回整体配置（app.save），服务端每请求读盘热生效
  ipcMain.handle("proxy_models", handle(() => {
    const cfg = settings();
    return adapters.mergedModels().map((m) => ({
      ...m,
      enabled: !(cfg.disabledModels || []).includes(m.id),
      override: (cfg.modelOverrides || {})[m.id] || "",
      fallback: (cfg.modelFallback || {})[m.id] || "",
    }));
  }));
  // 官方模型目录拉取（三渠道通用）：取号池里第一个 online 有 token 的账号，adapter.fetchModels 走云端接口
  // （Trae get_detail_param / WB v3/config + console models），结果写回 rules/catalog.json 热生效。
  // 拉取失败不写空——保留旧目录，面板报错由用户重试
  ipcMain.handle("proxy_models_sync", handle(async ({ channel }) => {
    const ch = String(channel || "");
    const adapter = adapters.get(ch);
    if (!adapter || typeof adapter.fetchModels !== "function") return fail(`未知渠道 "${ch}"`);
    const acc = pool.poolAccounts(ch).find((a) => a.status === "online" && a.hasToken);
    if (!acc) return fail(`${store.channelDisplay(ch)}号池无可用账号，无法拉取模型目录`);
    const secrets = store.accountSecrets(store.getAccount(acc.id));
    const r = await adapter.fetchModels(acc, secrets);
    if (!r || !r.ok || !Array.isArray(r.models) || !r.models.length) {
      return fail((r && r.message) || "目录拉取失败");
    }
    const file = path.join(rules.rulesDir(), "catalog.json");
    const cur = JSON.parse(JSON.stringify(rules.get("catalog.json") || {}));
    cur[ch] = { syncedAt: Date.now(), models: r.models };
    fs.writeFileSync(file, JSON.stringify(cur, null, 2), "utf8");
    rules.reload("catalog.json");
    const withRate = r.models.filter((m) => m && m.rate != null).length;
    return ok({ channel: ch, count: r.models.length, withRate });
  }));

  // ===== 生态接入：CC Switch =====
  ipcMain.handle("proxy_ccswitch_status", handle(() => ccswitch.status()));
  ipcMain.handle("proxy_ccswitch_register", handle(({ appType, apiKey, model, port }) =>
    ccswitch.register({ appType, apiKey, model, port })));

  // ===== 本地 IDE 快捷切换账号 =====
  ipcMain.handle("proxy_ide_switch", handle(({ accountId }) => ideswitch.switchIdeAccount(accountId)));
  ipcMain.handle("proxy_ide_status", handle(() => ideswitch.ideSwitchStatus()));

  // ===== 统计 =====
  ipcMain.handle("proxy_stats_overview", handle(({ days }) => ({
    today: store.statsToday(),
    trend: store.statsTrend(days || 7),
    tops: {
      channel: store.statsTop("channel", days || 7),
      model: store.statsTop("model", days || 7),
      key: store.statsTop("key", days || 7),
      account: store.statsTop("account", days || 7),
    },
  })));
  ipcMain.handle("proxy_stats_top", handle(({ dim, days }) => store.statsTop(dim, days)));
  ipcMain.handle("proxy_stats_detail", handle(({ page, pageSize, channel, keyId, model }) =>
    store.statsDetail({ page, pageSize, channel, keyId, model })));
  ipcMain.handle("proxy_recent", handle(({ limit }) => store.recentRequests(limit)));

  // ===== 规则文件 / 目录 / 安全 =====
  ipcMain.handle("proxy_rules_list", handle(() => rules.list()));
  ipcMain.handle("proxy_open_rules_dir", handle(async () => {
    const shell = getShell();
    if (!shell) throw new Error("该操作需要主进程界面，不能由后台常驻网关执行");
    await shell.openPath(rules.rulesDir());
    return ok({});
  }));
  ipcMain.handle("proxy_open_data_dir", handle(async () => {
    const shell = getShell();
    if (!shell) throw new Error("该操作需要主进程界面，不能由后台常驻网关执行");
    await shell.openPath(store.proxyDir());
    return ok({});
  }));
  ipcMain.handle("proxy_vault_status", handle(() => ({
    encrypted: vaultOk(),
    driver: store.driver(),
    dataDir: store.proxyDir(),
  })));

  // ===== 号池 WebDAV 同步（统一服务器 + proxy 根目录；压缩包用 WebDAV 密码加密；
  //        可选 channel = 只同步某一个编译器） =====
  ipcMain.handle("proxy_poolsync_status", handle(() => poolsync.progress()));
  ipcMain.handle("proxy_poolsync_run", handle(async ({ channel }) => {
    if (poolsync.progress().running) return fail("号池同步已在进行中");
    // 前台 await 跑完：号池体量小（几十账号），一轮就是几次请求；进度仍走 app:event 广播
    return poolsync.run({ channel: channel ? String(channel) : "" });
  }));
  ipcMain.handle("proxy_poolsync_cancel", handle(() => poolsync.cancel()));
}

// ===== 子进程侧的命令出口（二期 Task 3）=====

// 表只在首次用到时构建一次，之后复用模块内缓存（每条命令重建一次 43 个闭包是纯浪费）
let TABLE = null;

/** 子进程侧：把 register() 的 ipcMain 换成收集器，43 条命令名与实现体一字不动地复用。
 *  为什么这样而不是重构出 COMMANDS 表：那是 290 行的重排，会掩盖「二期只改出口、不改命令语义」这个契约，
 *  且 Task 5 的逐字相等闸（dev-gateway-forward-parity-test）就没法拿旧注册当基线。 */
function dispatchTable() {
  if (TABLE) return TABLE;
  const cmds = {};
  register({ handle: (name, fn) => { cmds[name] = fn; } });
  TABLE = cmds;
  return TABLE;
}

/** 走管道调一条命令。第一个参数是假的 _event：全仓 43 条处理体都不使用 event / event.sender
 *  （逐条核过；真依赖 UI 的那 4 条靠 getShell() 的惰性 require 抛错，见 §5.7）。 */
async function dispatch(cmd, args) {
  const fn = dispatchTable()[cmd];
  if (!fn) throw new Error("未知命令: " + cmd);
  return fn({ sender: { send() {} } }, args || {});
}

/** 子进程装配：把事件出口接到管道广播上（emit 由 gateway.cjs 在 serve() 建成之后给，装配序不是风格）。
 *  同时让 boot() 不再按 restoreOnLaunch 自动 listen —— 监听决策归主进程（Task 6 的新语义）。 */
function attachGatewayMode({ emit } = {}) {
  if (typeof emit !== "function") throw new Error("attachGatewayMode 需要 emit(payload) 函数");
  gatewayAttached = true;
  events.setSink(emit);
}

// gatewayStatus 一并导出：proxy_status 命令走它，Task 1 的闸直接断言 vaultOk 字段，
// Task 5 的转发化也要按这个名字取（藏在 register 里没法单测）
// dispatchTable/dispatch/attachGatewayMode/gracefulShutdown：二期 Task 3 的子进程入口与管道出口
// startBackgroundJobs：二期 Task 5 的子进程后台作业入口（credits 定时刷新 + 定时自动签到，
// 过去在主进程 boot() 里，随命令实现体一起下沉；gateway.cjs 装配时调用）
// DRAIN_BUDGET_MS：停机预算的四个数字之一，供 dev-gateway-pipe-test 断言它们仍复合（合计只在那一条断言里算）
module.exports = { boot, shutdown, gracefulShutdown, DRAIN_BUDGET_MS, register, settings, gatewayStatus, dispatchTable, dispatch, attachGatewayMode, startBackgroundJobs };
