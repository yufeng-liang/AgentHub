// Electron 主进程入口：窗口 / 托盘 / 单实例 / 主题同步 / 全局大小自适应
// 技能仓库后台能力：定时 WebDAV 同步调度、自动感知收纳、软件自更新
"use strict";
const path = require("node:path");
const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain, nativeTheme, Notification } = require("electron");
const config = require("./backend/config.cjs");
const ipc = require("./backend/ipc.cjs");
const updater = require("./backend/updater.cjs");
const remotesync = require("./backend/remotesync.cjs");
const scheduler = require("./backend/scheduler.cjs");
const watch = require("./backend/watch.cjs");
// 用量同步模块（原「用量记录同步」）：独立配置与本地库，调度器与技能仓库互不干扰
const usageConfig = require("./backend/sync-config.cjs");
const usagedb = require("./backend/db.cjs");
const usagesync = require("./backend/sync.cjs");
// 网关子进程监督器（二期）：spawn / 认领 / 管道转发 / 事件回流 / 43 条 proxy_* 命令的注册面
// （Task 5 起 ipc.cjs 经它注册，主进程不再 require proxy 域 —— stats.db 归子进程独占）。
// 日志由它自己经 gateway-log 落 proxyDir()/logs/gateway.log，主进程不再另开一份写点。
const gatewayClient = require("./backend/gateway-client.cjs");
const usageScheduler = require("./backend/usage-scheduler.cjs");

const DEV_URL = process.env.VITE_DEV_SERVER_URL || "http://localhost:1420";

// 目录名用 productName 大小写（userData = %APPDATA%\AgentHub），与安装名/任务栏一致
app.setName("AgentHub");

let mainWindow = null;
let tray = null;
let quitting = false;
// 「跳到软件更新卡片」是一次性待办：窗口销毁态下 send 过去没有监听者（App.vue 的 app:event
// 监听在渲染层挂载后才注册），所以先记账，等那个窗口的 did-finish-load 补投，投完即清
let pendingFocusUpdate = false;

/** 资源目录：打包后为 process.resourcesPath 的相邻 build，开发时为项目 build/ */
function buildDir() {
  return app.isPackaged ? path.join(process.resourcesPath, "build") : path.join(__dirname, "..", "build");
}

function iconPath(name) {
  try {
    return nativeImage.createFromPath(path.join(buildDir(), name));
  } catch {
    return nativeImage.createEmpty();
  }
}

/** 应用主题同步到原生窗口框架（标题栏/边框）：否则外框颜色只跟系统主题走，不跟应用主题走 */
function applyNativeTheme(theme) {
  if (theme === "dark" || theme === "light") nativeTheme.themeSource = theme;
}

// ===== 全局大小自适应 =====
// 以 1280 为设计基准宽，整页等比缩放（钳制 0.7~1.25）：窗口更小整体缩小、更大适度放大。
// zoomFactor 缩放的是 CSS 像素（含媒体查询），常态下有效布局宽度恒为 1280，
// 布局本身只在大窗口侧自然拉伸；浏览器预览（dev:web）不走此逻辑，由 CSS 断点兜底
const DESIGN_WIDTH = 1280;
const ZOOM_MIN = 0.7;
const ZOOM_MAX = 1.25;

function applyViewportZoom() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const [w] = mainWindow.getSize();
  const factor = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, w / DESIGN_WIDTH));
  try {
    mainWindow.webContents.setZoomFactor(factor);
  } catch {
    /* 页面未就绪时调用可能失败，下个 resize / 加载事件会重试 */
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    title: "AgentHub",
    icon: iconPath("icon.png"),
    autoHideMenuBar: true,
    // 深色底色的窗口画布：消除深色主题启动瞬间的白闪（否则原生窗口先白后黑闪一下）
    backgroundColor: "#0a0c0f",
    // 先隐藏，等页面渲染出首帧再显示：窗口出现时内容已就绪，避免空壳闪烁
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (app.isPackaged) {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  } else {
    mainWindow.loadURL(DEV_URL);
  }

  // 首帧就绪后显示窗口（did-finish-load 兜底：HMR 重载等场景 ready-to-show 可能不触发）
  // 与 close/closed 同一口径：闭包捕获 thisWindow，不再回读可能被别的窗口改写的全局
  const thisWindow = mainWindow;
  let revealed = false;
  const reveal = () => {
    if (revealed || thisWindow.isDestroyed()) return;
    revealed = true;
    thisWindow.show();
  };
  mainWindow.once("ready-to-show", reveal);
  mainWindow.webContents.once("did-finish-load", () => {
    reveal();
    deliverFocusUpdate(true); // 页面已解析完，监听者就位，补投待办
  });

  // 窗口尺寸变化 / 页面（重）载入后按当前宽度重算缩放
  applyViewportZoom();
  mainWindow.on("resize", applyViewportZoom);
  mainWindow.webContents.on("did-finish-load", applyViewportZoom);

  // 关闭 → 缩到托盘：liteOnClose 开时销毁窗口，连渲染进程与合成表面一起回收
  // （一期打包版实测：同一次运行 424.86 → 215.47 MB 私有，−49.3%，4 进程降到 3），
  // 关掉则只 hide()（重开更快）；托盘菜单「退出」才是真正退出，后台才能持续跑网关与定时同步。
  // 两个处理器都只用 thisWindow：destroy() 不会再触发 close，无递归。
  thisWindow.on("close", (e) => {
    const cfg = config.loadConfig();
    if (quitting || !cfg.schedule || !cfg.schedule.minimizeToTray) return;
    e.preventDefault();
    if (cfg.schedule.liteOnClose) thisWindow.destroy();
    else thisWindow.hide();
  });

  // 身份校验：destroy() 是否同步派发 closed 本机实测判别不了（竞态探针在无校验版本上同样通过），
  // 两种时序的结论相反，所以按「两种都对」写——迟到的 closed 只能抹掉它自己那个窗口。
  thisWindow.on("closed", () => {
    if (mainWindow === thisWindow) mainWindow = null;
  });
}

function showWindow() {
  // 两种派发时序下都安全：本机判别不了 destroy() 与 closed（置 null）是否同批
  // （Task 7 §0c 的竞态探针在无身份校验的版本上同样通过），所以不主张任一时序为事实，
  // 而是同时挡「null」与「非 null 但已销毁」两种落点——只挡 null 时，若 closed 还没跑，
  // show() 会抛 Object has been destroyed（主进程未捕获 → 进程退出）。
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

// ===== 技能仓库：WebDAV 定时同步 =====

function triggerSync() {
  const cfg = config.loadConfig();
  if (remotesync.isRunning()) return;
  if (!remotesync.configured(cfg)) {
    notify("AgentHub", "请先在「技能仓库 · WebDAV 同步」页配置服务器地址和账号");
    return;
  }
  remotesync.run(cfg).catch(() => {});
}

// ===== 用量同步：本机用量上传/拉取 =====

function triggerUsageSync() {
  // 运行中/恢复中不重复触发：原来直接 run 抛错只 console.error，托盘用户毫无反馈
  const p = usagesync.progress();
  if (p && (p.running || p.restoring)) {
    notify("AgentHub", p.restoring ? "正在恢复备份，请稍候" : "用量同步正在进行中");
    return;
  }
  const cfg = usageConfig.loadConfig();
  usagesync.run(cfg).catch((e) => {
    console.error("[usage-sync]", e);
    notify("AgentHub", `用量同步启动失败：${String((e && e.message) || e)}`);
  });
}

/** 今日用量摘要（托盘菜单用），无数据时返回 null */
function usageTodaySummary() {
  try {
    const cfg = usageConfig.loadConfig();
    const s = usagedb.getSummary(cfg.totalMode || "full");
    // 无记录时返回 null（托盘显示「今日用量 —」）；todayTokens 恒 >= 0，不能用其判断空态
    return s && s.todayRecordCount > 0 ? s.todayTokens : null;
  } catch {
    return null;
  }
}

// 托盘今日用量：与渲染进程 formatToken 同口径的中文单位分级（两位小数）
function formatNum(n) {
  if (!isFinite(n)) return "0";
  const abs = Math.abs(n);
  const units = [[1e10, "百亿"], [1e8, "亿"], [1e7, "千万"], [1e6, "百万"], [1e4, "万"], [1e3, "千"]];
  for (const [div, unit] of units) {
    if (abs >= div) {
      return (n / div).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + unit;
    }
  }
  return Math.round(n).toLocaleString("en-US");
}

// ===== 托盘 =====

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 托盘菜单（动态构建：技能同步状态 + 今日用量 + 更新提示 + 暂停/恢复定时同步） */
function buildTrayMenu() {
  const cfg = config.loadConfig();
  const running = remotesync.isRunning();
  const p = remotesync.progress();
  const statusText = running
    ? `同步中…（${p.stageLabel}）`
    : remotesync.configured(cfg)
      ? `上次同步 ${fmtTime(remotesync.loadRemoteState().lastSyncAt) || "—"}`
      : "未配置 WebDAV";
  const usageToday = usageTodaySummary();
  const items = [
    { label: `技能仓库：${statusText}`, enabled: false },
    { label: usageToday != null ? `今日用量 ${formatNum(usageToday)} token` : "今日用量 —", enabled: false },
    { type: "separator" },
  ];
  const st = updater.getStatus();
  if (st.status === "available" || st.status === "downloaded") {
    items.push({ label: `发现新版本 v${st.latestVersion} →`, click: focusSettingsUpdate });
    items.push({ type: "separator" });
  }
  items.push(
    { label: "显示主界面", click: showWindow },
    { label: "立即同步技能", enabled: remotesync.configured(cfg) && !running, click: triggerSync },
    { label: "立即同步用量", click: triggerUsageSync },
    {
      label: scheduler.isPaused() ? "恢复定时同步" : "暂停定时同步",
      enabled: remotesync.configured(cfg) && !!(cfg.schedule && (cfg.schedule.hourly || cfg.schedule.daily)),
      click: () => { scheduler.setPaused(!scheduler.isPaused()); refreshTrayMenu(); },
    },
    {
      label: usageScheduler.isPaused() ? "恢复用量定时同步" : "暂停用量定时同步",
      click: () => { usageScheduler.setPaused(!usageScheduler.isPaused()); refreshTrayMenu(); },
    },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  );
  return Menu.buildFromTemplate(items);
}

/** 新版本提示点击（托盘条目与桌面通知共用）→ 打开主界面并定位到「软件更新」卡片 */
function focusSettingsUpdate() {
  pendingFocusUpdate = true;
  showWindow();
  deliverFocusUpdate();
}

/**
 * 销账式投递：投成功才清待办。
 * fromLoadFinished 是由那一次 did-finish-load 触发的补投——此刻渲染层监听者已就位；
 * 别用 isLoadingMainFrame() 当就绪判据，它在 did-finish-load 之后仍为 true（本机探针实测：
 * 用它做闸，补投这一路永远 return，销毁态点通知就是 0 次送达）。
 */
function deliverFocusUpdate(fromLoadFinished) {
  if (!pendingFocusUpdate) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!fromLoadFinished && mainWindow.webContents.isLoadingMainFrame()) return;
  try {
    mainWindow.webContents.send("app:event", { event: "focus-update" });
    pendingFocusUpdate = false;
  } catch {
    /* 窗口刚好没了：待办留着，下次载入完成再补 */
  }
}

function refreshTrayMenu() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  const icon = iconPath("tray.png");
  tray = new Tray(icon.isEmpty() ? iconPath("icon.png") : icon);
  tray.setToolTip("AgentHub · Agent中控台");
  refreshTrayMenu();
  tray.on("double-click", showWindow);
}

// ===== 桌面通知：默认仅同步失败提醒，设置里可开启「成功也通知」；失败持续期间不重复弹 =====

let lastNotifiedOk = null;
function notifySync(okFlag, message) {
  try {
    refreshTrayMenu();
    if (!Notification.isSupported()) return;
    if (okFlag) {
      lastNotifiedOk = true;
      const cfg = config.loadConfig();
      if (!(cfg.schedule && cfg.schedule.notifyOnSuccess)) return;
    } else {
      // 失败持续中不重复打扰；首次失败/失败恢复后再失败才提醒
      if (lastNotifiedOk === false) return;
      lastNotifiedOk = false;
    }
    const n = new Notification({
      title: okFlag ? "WebDAV 同步完成" : "WebDAV 同步失败",
      body: message || (okFlag ? "中央仓库已与远端同步" : "请检查 WebDAV 配置与网络"),
      icon: iconPath("icon.png"),
    });
    n.show();
  } catch {
    /* 通知失败静默 */
  }
}

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: iconPath("icon.png") });
  n.show();
}

// 用量同步完成/失败通知：与技能同步同一套去重逻辑，配置读用量模块自己的 schedule
let lastUsageNotifiedOk = null;
function notifyUsageSync(okFlag, message) {
  try {
    refreshTrayMenu(); // 同步结束后刷新托盘「今日用量」
    if (!Notification.isSupported()) return;
    const cfg = usageConfig.loadConfig();
    if (okFlag) {
      lastUsageNotifiedOk = true;
      if (!(cfg.schedule && cfg.schedule.notifyOnSuccess)) return;
    } else {
      if (lastUsageNotifiedOk === false) return;
      lastUsageNotifiedOk = false;
    }
    const n = new Notification({
      title: okFlag ? "用量同步完成" : "用量同步失败",
      body: message || (okFlag ? "本机用量已上传并拉取最新数据" : "请检查用量同步的 WebDAV 配置"),
      icon: iconPath("icon.png"),
    });
    n.show();
  } catch {
    /* 通知失败静默 */
  }
}

// 自动感知回执：零冲突收纳直接报告结果；发现冲突只提醒，等用户去软件里裁决
watch.setOnEvent(({ kind, summary, count }) => {
  refreshTrayMenu();
  if (kind === "conflict") {
    notify("AgentHub 技能仓库", `发现 ${count || 0} 个需要裁决的冲突，已跳过自动收纳`);
    return;
  }
  if (kind === "synced" && summary) {
    notify("AgentHub 技能仓库", `自动收纳完成：${summary.imported} 个新增 · 挂载 ${summary.mounted} 处 · 合并重复 ${summary.merged} 份`);
  }
});

// ===== 单实例锁 =====
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showWindow());

  app.whenReady().then(() => {
    const boot = config.loadConfig();
    // 建窗前先应用主题，避免深色配置下标题栏先白后黑闪烁
    applyNativeTheme(boot.theme);

    // 用量同步：初始化本地库（惰性打开），并确保本机设备登记在册（设备列表/本机口径立即可用）
    usagedb.get();
    const usageCfg0 = usageConfig.loadConfig();
    const usageLocalId = usagesync.ensureLocalDeviceId(usageCfg0);
    usagedb.upsertDevice(usageLocalId, usageCfg0.deviceName || "这台电脑", usagesync.enabledSourceIds(usageCfg0).join(","), usagedb.getLastSyncAt(usageLocalId));

    ipc.register({ ipcMain, app, shell, nativeTheme });
    remotesync.setOnFinish(notifySync);
    usagesync.setOnFinish(notifyUsageSync);
    // 网关子进程（Task 5 起为正式启动路径，不再是 opt-in）：43 条命令全部在子进程跑，
    // 主进程不再 boot() proxy 域（rules/store/credits/checkin 计时器都随实现体下沉，gateway.cjs）。
    // 这里先 spawn；网关是否进入监听由配置的 restoreOnLaunch 决定 —— start 成功后转发
    // proxy_start（与用户点开关同一条路径，claimed 守卫等语义完全一致）。Task 6 会把启动器
    // 与自启的时机一并复核，本条保持「应用起来 = 子进程在」的最小不变式。
    // 不 await：whenReady 回调保持同步；成败都由 gateway-client 写进 proxyDir()/logs/gateway.log。
    // 这条裸调与转发侧 ensureStarted 汇入同一条互斥：在飞去重长在 start() 本体（评审 I1），
    // boot-start 在飞期间渲染层首条 proxy 命令只会拿到同一条 promise，不会再 spawn 第二个子进程。
    gatewayClient.start({ persistent: boot.schedule.persistentGateway })
      .then((r) => {
        if (!r.ok || !boot.proxy || !boot.proxy.restoreOnLaunch) return;
        return gatewayClient.call("proxy_start", {}).catch(() => {});
      })
      .catch((e) => {
        console.error("网关子进程启动失败：" + String((e && e.message) || e));
      });
    // 子进程回流的代理事件扇给所有窗口（与 events.cjs 一期语义一致：无窗口时直接丢弃）。
    // oauth-open 是唯一要在主进程就地消费的事件：登录页由 shell.openExternal 打开 ——
    // 会话在子进程（拿不到 shell），事件经管道回来，这里收到才开浏览器（CRITICAL_EVENTS 保投递）。
    gatewayClient.onEvent((payload) => {
      if (payload && payload.type === "oauth-open" && payload.url) {
        shell.openExternal(String(payload.url)).catch(() => {});
      }
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send("app:event", payload);
      }
    });
    // 启动即进托盘：首帧不建窗，GPU 侧连建窗残留都不产生（一期打包版实测私有 166.05 MB / GPU 32.2，
    // 对比「建过再销毁」的 215.47 MB，再省 49.42 MB）。
    // minimizeToTray 关时不生效 —— 那种配置下关窗就是退出，不该留一个没有界面的进程
    if (!(boot.schedule.launchHidden && boot.schedule.minimizeToTray)) createWindow();
    createTray();
    scheduler.start();
    usageScheduler.start();
    watch.start();
    updater.init({ onShowWindow: showWindow, onTrayRefresh: refreshTrayMenu, onFocusUpdate: focusSettingsUpdate });

    // 依据配置启用开机自启（便携版不支持：注册的会是临时解压副本路径，退出即失效）。
    // 开关唯一来源是框架配置（设置 · 通用 · 应用行为），用量模块旧配置字段不再参与
    config.applyAutoStart(config.loadConfig());

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWindow();
    });
  });

  app.on("before-quit", (e) => {
    // 下载完的更新：拦下这次退出，静默装完自动重启
    if (updater.pendingInstall()) {
      e.preventDefault();
      quitting = true;
      scheduler.stop();
      usageScheduler.stop();
      watch.stop();
      updater.triggerInstall();
      return;
    }
    // Task 5 起主进程不持有网关的任何句柄（store/rules 都在子进程），退出路径无需收口：
    // 非常驻子进程由看门狗的 parent-exit 分支优雅停机（gateway.cjs gracefulExit，≤5s）；
    // 常驻子进程按设计 detach 存活（活过主 App，Task 6/7 的停机语义复核点）。
    quitting = true;
    scheduler.stop();
    usageScheduler.stop();
    watch.stop();
  });

  app.on("window-all-closed", () => {
    // Windows 下常驻托盘，不随窗口关闭退出（定时同步要后台跑）
  });
}
