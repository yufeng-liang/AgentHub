// 全局类型与常量：四大模块 / 子页面 / 应用配置 / 技能仓库数据结构
// MODULES 是左栏导航的唯一事实源，App.vue 据此装配各模块视图组件
export type ModuleKey = "skills" | "sync" | "proxy" | "memory";
export type Theme = "dark" | "light";

export interface PageDef {
  id: string;
  name: string;
  /** 右侧计数徽标：静态兜底值，技能仓库的待裁决徽标由 store 实时计算覆盖 */
  badge?: string;
}

export interface ModuleDef {
  key: ModuleKey;
  name: string;
  pages: PageDef[];
}

// ===== 技能仓库：数据结构（跟 electron/backend 返回一一对应） =====

export type HealthIssue = { level: "warn" | "bad"; text: string };

export type SkillSource = { tool: string; originalName?: string; name?: string; dir?: string; firstSeen?: string; origin?: string };

export type SkillMount = {
  tool: string;
  name: string;
  path: string;
  type: "junction" | "symlink" | "copy";
  enabled: boolean;
};

export type SkillRow = {
  name: string;
  skillName: string;
  description: string;
  version: string;
  treeHash: string;
  health: HealthIssue[];
  sources: SkillSource[];
  inManifest: boolean;
  mounts: SkillMount[];
  mtimeMs: number;
  /** user=用户安装；system=工具自带（默认隐藏，搜索可见，永不收纳）；hub-extra=中央仓库有目录但未登记 */
  origin?: "user" | "system" | "hub-extra";
};

// 中央巡检：仓库里躺着但 manifest 没记账的目录
export type HubExtraRow = {
  name: string;
  isLink: boolean;
  hasSkillMd: boolean;
  mtimeMs: number;
  health: HealthIssue[];
};

export type Overview = {
  hubDir: string;
  skillCount: number;
  manifestCount: number;
  sourceCount: number;
  l1Merged: number;
  l2Conflicts: number;
  tools: { id: string; name: string; dir: string; skillCount: number; mountCount: number }[];
  mountHealth: { skill: string; tool: string; name: string; path: string; type: string; enabled: boolean; isLink: boolean; valid: boolean }[];
  orphans: OrphanRow[];
  pendingConflicts: ConflictItem[];
  recentReports: ReportRow[];
  trashCount: number;
  hubExtra: HubExtraRow[];
};

export type ReportRow = { file: string; path: string; mtimeMs: number };

export type SyncAction = {
  type: "import" | "mount" | "skip" | "error" | "conflict";
  skill: string;
  mountName?: string;
  toolId?: string;
  parentDir?: string;
  dir?: string;
  replaceReal?: boolean;
  note: string;
  sources?: { tool: string; name: string; dir: string }[];
};

export type SyncPlan = {
  mode: "junction" | "copy";
  actions: SyncAction[];
  conflicts: ConflictItem[];
  orphans: OrphanRow[];
  dedup: { duplicates: { kept: { name: string; tool: string }; removed: { name: string; tool: string }; rule: string; basis: string }[]; hints: { a: string; b: string; sim: number }[] };
  scannedSummary: { id: string; name: string; dir: string; skillCount: number; mountCount: number }[];
};

export type SyncResult = {
  mode: string;
  summary: { imported: number; merged: number; conflicts: number; skipped: number; mounted: number; repaired: number; cleaned: number };
  imports: { name: string; sources: string; action: string; path: string }[];
  merges: { kept: string; removed: string; basis: string }[];
  conflicts: { title: string; detail: string }[];
  mounts: { skill: string; dir: string; action: string; outcome: string }[];
  manifestDiff: string[];
  reportFile: string;
};

export type ConflictItem = {
  id: string;
  kind: "content" | "diff-link" | "norm" | "remote";
  skill?: string;
  toolId?: string;
  dir?: string;
  title: string;
  detail: string;
  a?: string;
  b?: string;
  localHash?: string;
  remoteHash?: string;
  at: string;
  resolved?: { at: string; choice: string };
};

export type ConflictDiff = {
  item: ConflictItem;
  left: { label: string; path: string; md: string };
  right: { label: string; path: string; md: string };
};

export type ToolRow = {
  id: string;
  name: string;
  icon: string;
  builtin: boolean;
  deletable: boolean;
  enabled: boolean;
  dir: string | null;
  candidatePaths: string[];
};

// 电脑扫描发现的第三方 agent：用户确认了才落配置（suggestId 已避开现有工具 id）
export type ProbeRow = { suggestId: string; name: string; icon: string; hitDirs: string[]; skillCount: number };

// 删除自定义工具前的干跑结果：有未裁决冲突必须先裁决
export type RemoveToolPlan = {
  builtin: boolean;
  mounts: { skill: string; path: string }[];
  sourceCount: number;
  openConflicts: number;
};

// 孤儿目录：工具目录里真实存在、但中央仓库 manifest 还没记录的技能目录
export type OrphanRow = { name: string; tool: string; dir: string; mtimeMs?: number };

export type TrashRow = { name: string; path: string; trashedAt: number; sizeBytes: number };

// 自动感知状态：技能库/同步中心展示"每 X 秒自动扫描"用
export type WatchStatus = { intervalSeconds: number; lastScanAt: number };

export type SkillDetail = {
  manifest: {
    name: string;
    version: string;
    description: string;
    treeHash: string;
    skillName: string;
    sources: SkillSource[];
    mounts: SkillMount[];
    mergeHistory: { at: string; action: string; detail: string }[];
    health?: HealthIssue[];
  } | null;
  dir: string;
  health: HealthIssue[];
  skillMd: string;
  /** 未收纳技能：探测到的工具目录来源 */
  sources?: SkillSource[];
};

// ===== WebDAV 跨设备同步 =====

export type WebDavStatus = {
  running: boolean;
  configured: boolean;
  deviceId: string;
  deviceName: string;
  lastSyncAt: string;
  stage: "idle" | "connect" | "pull" | "download" | "upload" | "push" | "done" | "cancelled" | "error";
  stageLabel: string;
  detail: string;
  pct?: number;
  lastError: string;
};

export type RemoteDevice = { id: string; name: string; appVersion: string; lastSyncAt: string; self: boolean };

export type WebDavLog = { at: string; text: string };

export type WebDavEvent = { event: "webdav"; stage: string; detail: string; pct?: number; running: boolean };

// ===== 全局设置弹窗：左下角设置按钮打开的三个模块（弹窗左列按钮切换） =====

export type SettingsTab = "general" | "webdav" | "data" | "timing";

export const SETTINGS_TABS: { key: SettingsTab; name: string; icon: string; desc: string }[] = [
  { key: "general", name: "通用", icon: "ph-sliders-horizontal", desc: "外观 · 模块顺序 · 更新" },
  { key: "webdav", name: "WebDAV 同步", icon: "ph-cloud", desc: "统一服务器 · 号池同步" },
  { key: "timing", name: "同步时间", icon: "ph-clock-countdown", desc: "各板块自动同步 / 刷新周期" },
  { key: "data", name: "数据与备份", icon: "ph-database", desc: "备份压缩包 · 缓存目录" },
];

// ===== 应用配置：框架（主题 / 模块顺序）+ 技能仓库 + 更新 =====

export interface AppConfig {
  theme: Theme;
  /** 界面动效开关（仅展示层）：默认关闭，用户在设置里开启后本机记住；
      false 时恢复系统鼠标指针并停用装饰动画，业务逻辑不受影响 */
  fx: boolean;
  moduleOrder: ModuleKey[];
  tools: Record<string, { enabled: boolean; paths: string[]; name?: string; icon?: string }>;
  customDirs: string[];
  mountMode: "junction" | "copy";
  l3: { enabled: boolean; threshold: number };
  trashDays: number;
  /** 软件更新：channel 更新通道；autoCheck 定时自动检查开关；notifiedVersion 由主进程维护（前端只读回传） */
  update: UpdateConfig;
  webdav: {
    endpoint: string;
    username: string;
    password: string;
    root: string;
    deviceId: string;
    deviceName: string;
  };
  schedule: {
    minimizeToTray: boolean;
    /** 关窗即销毁窗口回收 UI 内存（重开需重新加载首屏）；依赖 minimizeToTray */
    liteOnClose: boolean;
    /** 启动不建窗，直接进托盘；依赖 minimizeToTray */
    launchHidden: boolean;
    autoStart: boolean;
    /** 主 App 退出后网关子进程继续常驻（便携版不支持；自启注册目标随它切换） */
    persistentGateway: boolean;
    hourly: boolean;
    daily: boolean;
    dailyTime: string;
    notifyOnSuccess: boolean;
  };
  watch: { enabled: boolean; intervalSeconds: number };
  /** 反代网关设置（框架整体设置的一部分；端口改动需重启监听，其余热生效） */
  proxy: ProxyConfig;
  /** 记忆中枢：框架侧只管启用开关与根目录指针，其余配置在 <仓库>/config/memory.config.json */
  memory: MemoryPointerConfig;
}

export interface MemoryPointerConfig {
  enabled: boolean;
  rootDir: string;
}

export interface UpdateConfig {
  channel: string;
  autoCheck: boolean;
  notifiedVersion: string;
}

/** 反代网关设置（与 electron/backend/config.cjs defaultConfig().proxy 保持一致） */
export interface ProxyConfig {
  port: number;
  bind: string;
  /** 网关开关的上次状态：启动应用时是否随之启动（默认 false，即首次打开是关闭的） */
  restoreOnLaunch: boolean;
  routeStrategy: "smart" | "fixed";
  /** fixed 策略下的优先渠道（渠道 id；渠道可扩充，故为字符串） */
  fixedChannel: string;
  rateLimitPerMin: number;
  concurrency: number;
  creditsRefreshMin: number;
  /** 积分包「即将到期」预警阈值（天，0~3650，默认 7）：号池到期徽标与到期总览分级共用 */
  expiringSoonDays: number;
  /** 请求流水保留期（天，1~3650）：启动 GC 与统计页「清理」共用 */
  usageRetentionDays: number;
  debugStatus: boolean;
  /** 模型 → 渠道 id 的 per-model 覆盖（渠道可扩充，故为字符串值） */
  modelOverrides: Record<string, string>;
  /** 拟人抖动：每次上游请求前随机停 40~220ms，模拟真实客户端节奏 */
  humanizeJitter: boolean;
  /** 禁用的模型（请求直接 400） */
  disabledModels: string[];
  /** 模型 → 回退模型（未知模型/号池耗尽时自动切换，单跳；旧版 per-model 配置，优先于全局回退） */
  modelFallback: Record<string, string>;
  /** 自定义模型映射：别名 → 目标模型 id（请求入口先解析别名再路由，响应 model 字段保持请求值） */
  modelAliases: Record<string, string>;
  /** per-model 元数据用户覆盖（稀疏 map，与 disabledModels/modelAliases/modelOverrides 同套路，按归并后的 canonical 模型 id 键）：
   *  能力 tri-state（true/false=显式覆盖，键缺失=未声明回落）/ 输出上限 / 推理档位（取代式，非并集）。
   *  未覆盖的键不落盘，读取时回落拉取 / seed。 */
  modelMeta?: Record<
    string,
    {
      capabilities?: { images?: boolean; video?: boolean; reasoning?: boolean; tools?: boolean };
      maxOutputTokens?: number;
      reasoning?: { supportedEfforts?: string[]; defaultEffort?: string };
    }
  >;
  /** 反向模型映射：统一请求模型名 → { [渠道 id]: 渠道实际模型名 }（渠道确定后解析并转发实际模型，响应 model 字段保持统一请求名） */
  modelReverseAliases?: Record<string, Record<string, string>>;
  /** 模型参数自定义覆盖：modelId → 自定义参数（上下文长度、最大输出、思考强度） */
  modelCustom?: Record<string, ModelCustomEntry>;

  /** 不可用时自动切换模型（统一设置，默认开）：模型未知或号池耗尽时切到 fallbackModel */
  autoFallbackEnabled: boolean;
  /** 全局统一回退模型（autoFallbackEnabled 开启且 per-model 未配置时生效） */
  fallbackModel: string;
  /** 跨渠道故障转移：渠道降级/耗尽时请求内自动跳其他渠道（默认开） */
  channelFailover: boolean;
  /** 单请求最多尝试渠道数（含主渠道；上游尝试预算按模型链放大，每模型 6 次、渠道间共享） */
  channelFailoverMax: number;
  /** 渠道降级基础时长（毫秒），失败翻倍防半开震荡 */
  channelCooldownMs: number;
  /** 渠道降级指数退避封顶（毫秒） */
  channelCooldownCapMs: number;
  /** 定时自动签到（默认关）：每天到点自动跑全渠道签到/领加油包 */
  checkinAuto: boolean;
  /** 每日自动签到时间（HH:mm） */
  checkinAutoTime: string;
  /** 生态接入默认模型（注册进 CC Switch 时使用，缺省取 fallbackModel） */
  ccSwitchModel: string;
  /** 系统提示词策略：passthrough=原样透传（默认）/ custom=替换客户端 system / append=追加网关 system */
  promptMode: "passthrough" | "custom" | "append";
  /** custom/append 用的网关系统提示词；空则用内置默认 */
  promptText: string;
}

// ===== 反代网关：数据结构（跟 electron/backend/proxy/* 返回一一对应） =====

/** 内置生态渠道：有 OAuth / 本机扫描 / 签到 / 号池同步这些"生态"概念（自建提供商没有） */
export type ProxyBuiltinChannelId = "trae" | "workbuddy" | "workbuddy_ai" | "raccoon" | "cline_free" | "cline_pass" | "autoclaw" | "autoclaw_intl" | "qoder" | "zcode" | "zcode_intl";
/** 渠道 id = 内置渠道 + 用户自建提供商的 slug。
 *  自建 slug 是运行期数据，编译期无从枚举，所以这里放宽成普通字符串（同 ProxyRoute 的既有做法），
 *  保留字面量联合只为了 IDE 补全。**需要"仅内置"约束的地方请用 ProxyBuiltinChannelId。** */
export type ProxyChannelId = ProxyBuiltinChannelId | (string & {});
/** builtin = 内置生态渠道；另外三种是自定义提供商的**上游协议形态**（与入站协议无关）。
 *  值集合与后端 provider.cjs 的 KINDS 同源，漂移由 dev-provider-test 断言守住。 */
export type ProxyProviderKind = "openai_compat" | "anthropic_messages" | "openai_responses";
export type ProxyChannelKind = "builtin" | ProxyProviderKind;

/** Key 路由：auto 或任一渠道 id（渠道后续扩充即为普通字符串，保留字面量仅为补全提示） */
export type ProxyRoute = "auto" | ProxyChannelId | (string & {});
export type ProxyAccountStatus = "online" | "cooling" | "exhausted" | "relogin" | "disabled";
export type ProxyPoolStrategy = "expire_first" | "credit_first" | "round_robin";

export interface ProxyKeyRow {
  id: string;
  name: string;
  mask: string;
  route: ProxyRoute;
  dailyQuota: number;
  rateLimit: number;
  enabled: boolean;
  createdAt: number;
  todayReq: number;
  todayTokens: number;
  /** 完整 Key（后端 DPAPI 解密后随列表返回，供随时查看 / 复制；旧版本创建的 Key 无存档则为空） */
  secret?: string;
}

// ===== 反代网关：生态接入（CC Switch） =====
/** CC Switch 里的应用入口：claude / codex（Claude Code / Codex CLI）与 claude-desktop（Claude Desktop 3P，独立入口） */
export type CcSwitchAppType = "claude" | "codex" | "claude-desktop";
export interface CcSwitchEntry {
  appType: CcSwitchAppType;
  registered: boolean;
  name?: string;
}
/** live 配置的实际指向（真实流量路径的地面真相）：gateway=直连 AgentHub 网关；
 *  ccswitch=经 CC Switch 本地代理（需其运行）；other=指向其它地址；unset=未配置服务地址 */
export interface CcSwitchLiveRoute {
  url: string;
  target: "gateway" | "ccswitch" | "other" | "unset";
}
export interface CcSwitchStatus {
  installed: boolean;
  /** 库在但 providers 表缺失等异常（按未注册展示，注册时会被更准确的报错拦截） */
  incompatible?: boolean;
  dbPath?: string;
  /** proxy_config 两列语义（实测）：enabled=接管开关的持久化意图（CC Switch 退出仍为 1，下次启动自动恢复）；
   *  claudeDesktop 借 claude 行 proxy_enabled=当前是否接管中（Desktop 映射依赖它常驻）。
   *  即 enabled=1 而 CC Switch 未运行时，live 已被恢复为直连，此开关不代表流量正经过它 */
  takeover?: { claude: boolean; codex: boolean; claudeDesktop: boolean };
  /** 各应用 live 配置当前实际指向（Claude Code 读 ~/.claude/settings.json，Codex 读 ~/.codex/config.toml） */
  live?: { claude: CcSwitchLiveRoute; codex: CcSwitchLiveRoute };
  entries?: CcSwitchEntry[];
}
export interface CcSwitchRegisterResult {
  ok?: boolean;
  action?: "inserted" | "updated";
  backupPath?: string;
  dbPath?: string;
  appType?: CcSwitchAppType;
  /** 写入 CC Switch 的真实条目名（与列表里显示的一致，如「AgentHub 网关（Claude Code）」） */
  name?: string;
  message?: string;
}

/** 单个积分包/加油包明细（方案 Q6）：上游按包发放，逐包各有总额/已用/到期。
 *  expired/expiringSoon 由主进程按 expiringSoonDays 阈值派生（时间态，不落库）。 */
export interface ProxyCreditPackage {
  /** 包唯一标识（同账号内稳定，用于列表 key）；上游缺失时回落 pack{i} */
  code: string;
  /** 包名/来源（Trae group_name·display_desc / WorkBuddy PackageName·SubProductName） */
  name: string;
  /** 总额（-1 = 不限哨兵） */
  total: number;
  /** 已用 */
  used: number;
  /** 剩余（-1 = 不限哨兵） */
  remaining: number;
  /** 到期时间戳（ms）；0 = 无到期 / 长期有效 */
  expiresAt: number;
  /** 已过期（expiresAt>0 且 <= now） */
  expired?: boolean;
  /** 即将到期（now < expiresAt < now + expiringSoonDays） */
  expiringSoon?: boolean;
}
export interface ProxyAccount {
  id: string;
  channel: ProxyChannelId;
  uid: string;
  name: string;
  status: ProxyAccountStatus;
  credits: number;
  creditsAt: number;
  expiresAt: number;
  coolUntil: number;
  coolReason: string;
  /** 最近一次上游错误（号池状态气泡展示用；只留最新一条，无则为 null） */
  lastError?: { at: number; message: string } | null;
  /** 生效中的模型级负缓存（6004/11102 只罚"账号×模型"不落账号状态；空数组 = 无） */
  modelCool?: { model: string; until: number; reason: string }[];
  source: "scan" | "oauth" | "paste";
  lastUsed: number;
  todayReq: number;
  todayTokens: number;
  /** 今日消耗积分（上游实报累计；-1 = 今日尚无上报积分的请求） */
  creditsToday: number;
  createdAt: number;
  hasToken: boolean;
  /** 逐积分包明细（Q6）：仅生态渠道且已刷新过的账号有；未刷新/无包概念的账号为空或缺省 */
  packages?: ProxyCreditPackage[];
  /** 本机 agent 客户端当前登录的就是这个账号（主进程按本地登录态 uid 比对，号池列表打「本机登录」徽标） */
  liveHere?: boolean;

}

export interface ProxyPoolSummary {
  channel: ProxyChannelId;
  totalCredits: number;
  accountCount: number;
  onlineCount: number;
  earliestExpire: number;
  expired: boolean;
  expiringSoon: boolean;
  todayReq: number;
  todayTokens: number;
  lastCreditsAt: number;
}

/** 渠道降级状态（号池视图 / 网关状态里随渠道返回；null = 正常） */
export interface ProxyChannelHealth {
  /** 降级截止时刻（毫秒时间戳），到期自动回切 */
  until: number;
  /** 降级原因（渠道耗尽 / 上游边缘拦截 / 限流等） */
  reason: string;
  /** 连续降级次数（驱动指数退避翻倍） */
  streak: number;
}

export interface ProxyChannelView {
  id: ProxyChannelId;
  display: string;
  domain: string;
  kind: ProxyChannelKind;
  /** 提供商可停用（停用即从路由视图消失）；内置渠道恒 true */
  enabled?: boolean;
  /** 仅 openai_compat：已归一化的上游地址（写入侧一次成型，展示与拼接同源） */
  baseUrl?: string;
  poolStrategy: ProxyPoolStrategy;
  summary: ProxyPoolSummary;
  accounts: ProxyAccount[];
  /** 降级状态：null = 正常 */
  health: ProxyChannelHealth | null;
}

// ===== 自定义提供商（中转站 / 自建端点，上游可为 chat、Messages、Responses 三种形态） =====

/** models 条目：字符串 = 裸名且上游同名；对象 = 可带客户端可见名与上游真名的别名映射及目录元数据 */
export type ProxyProviderModel = string | {
  model: string;
  /** 上游真实模型名，缺省 = model。`slug/model` 路由时发给上游的是这个 */
  upstream?: string;
  /** 额外的可请求名：原名与别名都能命中同一上游模型，但别名不出现在 /v1/models */
  aliases?: string[];
  /** 思考档位声明。supportedEfforts 决定客户端要的档位能否原样透传，不支持时按此降级 */
  reasoning?: { supportedEfforts?: string[]; defaultEffort?: string };
  name?: string;
  rate?: number;
  capabilities?: Record<string, boolean | string | number>;
  contextLength?: number;
  maxOutputTokens?: number;
};

/** 提供商条目（模型表按对象处理；字符串简写只在读侧兼容，写侧一律展开成对象） */
export type ProxyProviderModelRow = Exclude<ProxyProviderModel, string>;

export interface ProxyProvider {
  /** 路由前缀，创建后不可改（accounts.channel 以它为键） */
  id: string;
  display: string;
  domain: string;
  kind: ProxyChannelKind;
  enabled: boolean;
  baseUrl: string;
  models: ProxyProviderModel[];
  extraHeaders: Record<string, string>;
  extraBody: Record<string, unknown>;
  updatedAt: number;
  keyCount?: number;
  onlineCount?: number;
}

export interface ProxyProviderTestResult {
  ok: boolean;
  message?: string;
  status?: number;
  ms?: number;
  model?: string;
  sample?: string;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface ProxyGatewayStatus {
  running: boolean;
  port: number;
  bind: string;
  baseUrl: string;
  uptime: number;
  active: number;
  today: { req: number; tokens: number; successRate: number; ttftAvg: number };
  channels: (ProxyPoolSummary & { id: ProxyChannelId; display: string; health: ProxyChannelHealth | null })[];
  keyCount: number;
  vaultOk: boolean;
  dbDriver: string;
  /** 当前 stats.db-wal 的字节数（三期 Task 3：量「WAL 是否还在单调增长」的唯一出口） */
  walBytes: number;
  /** 最近一次周期 checkpoint 的观测；从未做过 / 进程刚起时为 null。
   *  after === before 即「跑了但没截动」，是二期 1,388,472 B 冻结缺陷的判别量。 */
  lastCheckpoint: { ok: boolean; before: number; after: number; err: string } | null;
}

export interface ProxyUsageRow {
  id: number;
  ts: number;
  reqId: string;
  keyId: string;
  keyName: string;
  channel: string;
  accountId: string;
  accountName: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  ttftMs: number;
  latencyMs: number;
  status: number;
  error: string;
  /** 读缓存命中 tokens；-1 = 上游未上报（0 = 上报了但确实为 0），展示层据此区分「-」与「0%」 */
  cachedTokens: number;
  cacheWriteTokens: number;
  /** 上游实报消耗积分；-1 = 上游未上报 */
  creditsUsed: number;
  /** 实际发出的上游请求次数（换号/限流重试累计；0 = 未到上游就被拦下） */
  attempts: number;
  /** 上游实际收到的模型名（别名/回退解析后）；空 = 未到上游 */
  modelUpstream: string;
  /** 失败请求是否落了上游错误响应体（详情弹窗按 id 再取） */
  hasErrorBody: boolean;
}

/** 单条请求详情（详情弹窗）：列表行 + 完整上游错误响应体（≤2KB） */
export interface ProxyUsageDetail extends ProxyUsageRow {
  errorBody: string;
}

export interface ProxyStatsOverview {
  today: { req: number; tokens: number; successRate: number; ttftAvg: number; /** 缓存命中率 %；-1 = 今日无回报缓存字段的请求 */ cacheHitRate: number; /** 今日消耗积分（实报累计）；-1 = 今日无上报 */ creditsUsed: number };
  trend: { day: string; req: number; tokens: number }[];
  tops: Record<"channel" | "model" | "key" | "account", { name: string; req: number; tokens: number }[]>;
}

export interface ProxyStatsDetail {
  total: number;
  page: number;
  pageSize: number;
  rows: ProxyUsageRow[];
}

export interface ModelCustomEntry {
  /** 自定义上下文长度（Token） */
  contextLength?: number;
  /** 自定义最大输出 Token */
  maxOutputTokens?: number;
  /** 自定义思考强度（"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | string） */
  reasoningEffort?: string;
}

export interface ProxyModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  sources: ProxyChannelId[];
  /** 目录元数据（catalog.json）：显示名 / 倍率（积分倍率，null=未知）/ 能力 / 上下文长度 */
  name?: string;
  rate?: number | null;
  /** 生效（三源合并后）能力：拉取 / seed / 用户覆盖逐键合并的结果 */
  capabilities?: { images?: boolean; video?: boolean; reasoning?: boolean; tools?: boolean };
  contextLength?: number;
  maxOutputTokens?: number;
  /** 生效（合并后）推理档位：supportedEfforts 取代式合并、defaultEffort 最高优先非空源胜出 */
  reasoning?: { supportedEfforts?: string[]; defaultEffort?: string };
  /** 元数据来源标记：哪些组来自 proxy.modelMeta 用户覆盖（"capabilities"|"maxOutputTokens"|"reasoning"），用于「已覆盖」徽标与「清除覆盖」 */
  metaOverridden?: string[];
  /** 管理态（proxy_models 返回时合并）：启用 / per-model 渠道覆盖 / 回退模型 */

  enabled: boolean;
  override: "" | ProxyChannelId;
  fallback: string;
  custom?: ModelCustomEntry;
}

export interface ProxyScanCandidate {
  /** 扫描只认本机那 4 家生态应用的登录文件，自定义提供商没有"本机凭据"可扫 */
  channel: ProxyBuiltinChannelId;
  uid: string;
  name: string;
  credits?: number;
  expiresAt?: number;
  source: string;
  file: string;
  /** Trae 本地登录态已加密：检测到但需走 OAuth / 粘贴 */
  encrypted?: boolean;
  imported: boolean;
}

export interface ProxyRuleFile {
  file: string;
  desc: string;
  size: number;
  mtimeMs: number;
  ok: boolean;
  error: string;
}

/** 主进程推送的反代网关事件（app:event，event="proxy"） */
export interface ProxyEvent {
  event: "proxy";
  type: "request" | "status" | "credits" | "oauth-done" | "poolsync";
  ok?: boolean;
  message?: string;
  id?: string;
  uid?: string;
  /** poolsync 事件：同步进度（stage/detail/percent/running） */
  stage?: string;
  detail?: string;
  percent?: number;
  running?: boolean;
}

/** zcode 账号级设备指纹（deviceMid）诊断行：周末套餐领取资格的设备维判据 */
export interface ZcodeDeviceRow {
  id: string;
  name: string;
  uid: string;
  deviceMid: string;
  /** 指纹缩略（前 8 位）供列表展示 */
  short: string;
  /** 该账号是否为本机 ZCode 客户端当前登录账号 */
  isLive: boolean;
  /** 与同池其它账号共用同一枚指纹的行下标（互为指认） */
  conflictWith: number[];
  /** 指纹等于 live 指纹但本人不是当前登录号：任何消耗都在烧 live 号的资格 */
  liveShared: boolean;
  /** 本周资格大概率已被消耗（撞车组或 live 共享）：preview 有套餐但 claim 必 1004 */
  burnedLikely: boolean;
}

export interface ZcodeDeviceStatusResult {
  ok: boolean;
  /** 本机 telemetry-state.json 当前 deviceMid */
  liveMid: string;
  /** 本机远程锚定指纹（anchor.remoteMid，终生恒定；远程链接 mid 参数的合法值） */
  anchorMid?: string;
  /** 锚定值落锚时间（毫秒时间戳，0 = 未知） */
  anchorSavedAt?: number;
  /** 指纹借出中（领取模式）：live ≠ 锚定值，手机远程不可用 */
  claimMode?: boolean;
  rows: ZcodeDeviceRow[];
  /** 本次修复重派的账号数（repair 专有） */
  repaired?: number;
  message?: string;
}

/** zcode 领取模式/恢复锚定指纹的返回（proxy_zcode_claim_mode / proxy_zcode_restore_mid） */
export interface ZcodeClaimModeResult {
  ok: boolean;
  channel?: string;
  /** 客户端在跑且未确认：为 true 时前端弹确认框，用户确认后带 confirmAck 重调 */
  needConfirm?: boolean;
  probe?: {
    channel: string;
    clientName: string;
    file: string;
    exe: string;
    running: boolean;
    relaunch: boolean;
    note?: string;
    warning?: string;
  };
  /** 借出/恢复的指纹变化（from → to） */
  from?: string;
  to?: string;
  /** 目标指纹与 live 相同（幂等无操作） */
  unchanged?: boolean;
  /** 本机锚定指纹（领取期间不可变更的事实源） */
  anchorMid?: string;
  /** 客户端是否已自动重启 */
  relaunched?: boolean;
  message?: string;
}

/** 签到批量结果行（proxy_checkin_status / proxy_checkin_run 返回） */
export interface ProxyCheckinRow {
  accountId: string;
  channel: ProxyChannelId;
  name: string;
  uid: string;
  ok: boolean;
  /** 服务对该账号不开放（如 Trae code 1001 / 国际版无签到体系）：不是失败，幂等处理 */
  unavailable?: boolean;
  /** 已签到 / 已领取过：幂等成功 */
  already?: boolean;
  checkedIn?: boolean;
  enable?: boolean;
  active?: boolean;
  streakDays?: number;
  dailyCredit?: number;
  todayCredit?: number;
  credits?: number;
  credit?: number;
  consecutiveDays?: number;
  checkinDates?: string[];
  weekProgress?: boolean[];
  claimed?: boolean;
  success?: boolean;
  reward?: unknown;
  /** zcode 领取奖励：需要人机校验（滑块/点选）；自动签到 tick 里出现时表示要到号池页手动领取 */
  needCaptcha?: boolean;
  /** zcode 领取奖励：本行需要过码时的滑块配置。挂在「结果行」上而不是响应体上——
   *  批量接口（proxy_checkin_run）的响应恒为 ok:true + rows，needCaptcha 从来不是响应级字段 */
  captcha?: { sceneId?: string; region?: string; prefix?: string };
  /** zcode 领取奖励：本行选定的可领套餐 id，过码后补跑时原样带回（否则会重新挑套餐） */
  planId?: string;
  /** zcode 领取奖励 1004：设备指纹本周已被消耗，须「指纹修复」换新指纹后重试 */
  deviceBurned?: boolean;
  /** zcode 渠道：账号当前可领取的奖励套餐列表（adapters.cjs 组装） */
  plans?: { planId: string; name: string; description: string; priority: number; endsAt: number }[];
  /** zcode 领取奖励：已领取过时的下次可领窗口（毫秒时间戳） */
  nextAt?: number;
  message?: string;
}

/** 更新状态快照（主进程 electron/backend/updater.cjs 维护，经 invoke 拉取 + app:event 事件推送） */
export interface UpdateStatus {
  /** idle 未检查 | checking 检查中 | up-to-date 已是最新 | available 有新版本
   *  downloading 下载中 | downloaded 已下载待安装 | error 出错 */
  status: "idle" | "checking" | "up-to-date" | "available" | "downloading" | "downloaded" | "error";
  /** 便携版：无安装目录可覆盖，不支持自动更新，仅提示手动下载 */
  isPortable: boolean;
  currentVersion: string;
  latestVersion: string;
  /** 下载进度百分比（0~100） */
  percent: number;
  /** 更新说明（已由主进程从 GitHub 渲染后的 HTML 还原为纯文本） */
  notes: string;
  message: string;
}

/** 主进程推送的更新事件：event="state" 时其余字段为完整状态；event="focus-update" 为通知/托盘点击的跳转信号 */
export interface UpdateEvent extends UpdateStatus {
  event: "state" | "focus-update" | "usage-local-synced";
}

/** 四大模块 → 子页面映射（内置顺序即默认导航顺序，可在「设置 · 通用」中调整）
 *  skills 的 skill-detail 为技能详情页：从技能库点卡片进入，不在横条菜单中展示；
 *  各模块的「配置」是隐藏页面（id=config，不走横条菜单），由横条右侧「配置」按钮切换 */
export const MODULES: ModuleDef[] = [
  {
    key: "skills",
    name: "技能仓库",
    pages: [
      { id: "dashboard", name: "仪表盘" },
      { id: "library", name: "中央技能库" },
      { id: "dedup", name: "去重与冲突" },
      { id: "sync", name: "同步中心" },
      { id: "webdav", name: "WebDAV 同步" },
    ],
  },
  {
    key: "sync",
    name: "用量统计",
    pages: [
      { id: "overview", name: "总览" },
      { id: "detail", name: "用量明细" },
      { id: "costs", name: "费用" },
      { id: "billing", name: "计费规则" },
      { id: "log", name: "同步日志" },
    ],
  },
  {
    key: "proxy",
    name: "反代网关",
    pages: [
      { id: "home", name: "总览" },
      { id: "keys", name: "API Keys" },
      { id: "providers", name: "自定义提供商" },
      { id: "agents", name: "号池" },
      { id: "expiry", name: "积分日历" },

      { id: "models", name: "模型目录" },
      { id: "stats", name: "用量统计" },
      { id: "poolsync", name: "号池同步" },
      { id: "ccswitch", name: "生态接入" },
    ],
  },
  {
    key: "memory",
    name: "记忆中枢",
    pages: [
      { id: "dashboard", name: "仪表盘" },
      // 待确认收件箱（事实失效 / 项目归类 / 去重三类人工裁决）不是独立页签：
      // 它是「记忆浏览」内的第四个视图（列表 / 热力图 / 待确认 / 回收站），条目带待处理红点
      { id: "browse", name: "记忆浏览" },
      { id: "projects", name: "项目归档" },
      { id: "profile", name: "深层画像" },
      { id: "agents", name: "Agent 接入" },
      { id: "index", name: "检索与索引" },
      { id: "auto", name: "自动化" },
      { id: "import", name: "导入与去重" },
      { id: "sync", name: "WebDAV同步" },
    ],
  },
];

// ===== 记忆中枢：数据结构（与 electron/backend/memory 的返回一一对应） =====

export type MemoryLayer = "l1" | "l2";

export type MemoryRow = {
  id: string;
  /** 相对仓库根的 MD 路径 */
  path: string;
  /** daily 文件的节锚点（非 daily 为 null） */
  anchor?: string | null;
  type: string;
  layer: MemoryLayer;
  title: string;
  summary: string;
  tags: string[];
  project: string | null;
  agent: string;
  device?: string | null;
  session?: string | null;
  created: number;
  updated?: number;
  importance: number;
  pinned?: boolean;
  starred?: boolean;
  /** 已失效（双时间轴） */
  superseded?: boolean;
  validTo?: number | null;
  supersededBy?: string | null;
  /** 检索得分（仅搜索接口返回） */
  score?: number;
  scoreParts?: Record<string, number>;
};

export type MemoryDetail = MemoryRow & {
  body: string;
  hash?: string;
  refs?: string[];
  dedupStatus?: string;
  aiProcessed?: boolean;
  bodyMissing?: boolean;
};

export type MemoryStats = {
  total: number;
  projects: number;
  today: number;
  yesterday: number;
  pending: number;
  l2: number;
  agents: number;
  indexBytes: number;
  llmToday: number;
  llmCalls: number;
};

export type MemoryIndexStatus = {
  rows: number;
  fts: number;
  ftsW: number;
  consistent: boolean;
  projects: number;
  today: number;
  pending: number;
  sizeBytes: number;
  walBytes: number;
  lastBuildAt: number;
  lastScanAt: number;
  rootDir: string;
};

export type MemoryTimelineNode = {
  id: string;
  title: string;
  created: number;
  validFrom?: number | null;
  validTo?: number | null;
  supersededBy?: string | null;
  current: boolean;
};

export type MemoryProjectCard = {
  slug: string;
  name: string;
  remotes: string[];
  aliases: string[];
  localPaths: string[];
  origin: string;
  updated: number;
  count: number;
  l2: number;
  latest: number;
  agents: string[];
};

export type MemoryAgentCard = {
  id: string;
  name: string;
  custom?: boolean;
  optional?: boolean;
  enabled: boolean;
  note?: string;
  configPath: string;
  configExists: boolean;
  format: string;
  snippetHint?: string;
  instructionPath: string;
  instructionExists: boolean;
  injected: boolean;
  verifyConfig: { ok: boolean; message: string };
  beat: { lastCall: number; calls: number; writes: number; searches: number; errors: number; lastTool: string } | null;
  pathReady: boolean;
};

export type MemoryAgentVerify = {
  agent: string;
  name: string;
  /** none < detected < configured < handshaked < verified */
  level: "none" | "detected" | "configured" | "handshaked" | "verified";
  config: { ok: boolean; message: string };
  handshake: { ok: boolean; message?: string; latencyMs?: number; tools?: number; serverInfo?: Record<string, unknown> };
  real: { ok: boolean; message?: string; lastCall?: number; calls?: number; writes?: number; searches?: number; errors?: number; lastTool?: string };
  command: { command: string | null; args: string[]; env: Record<string, string>; hostExists: boolean; bridgeExists: boolean };
  configPath: string;
  instructionPath: string;
  instructionInjected: boolean;
};

export type MemoryBridgeStatus = { running: boolean; port: number; tokenReady?: boolean; pid?: number };

export type MemoryConfigFieldMeta = {
  type: string;
  def: unknown;
  label: string;
  group: string;
  hot?: boolean;
  desc?: string;
  min?: number;
  max?: number;
  step?: number;
  options?: string[];
  tier?: "basic" | "advanced" | "internal";
};

export type MemoryConfigEnvelope = {
  config: Record<string, any>;
  schema: Record<string, MemoryConfigFieldMeta>;
  root: string;
  diff: { key: string; value: unknown; default: unknown }[];
};

export type MemoryStatusEnvelope = {
  enabled: boolean;
  root: string;
  bridge: MemoryBridgeStatus;
  index: MemoryIndexStatus | null;
  verifiedAgents: number;
  beats: { agent: string; last_call: number; calls: number; writes: number; searches: number; errors: number; last_tool: string }[];
};

export type MemoryToolRow = {
  name: string;
  description: string;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
};

export type MemoryBeatsRow = { agent: string; last_call: number; calls: number; writes: number; searches: number; errors: number; last_tool: string };

/** 记忆中枢事件（event="memory"，type 区分：新记忆/索引/桥/任务/配置等） */
export interface MemoryEvent {
  event: "memory";
  type: string;
  [key: string]: unknown;
}
