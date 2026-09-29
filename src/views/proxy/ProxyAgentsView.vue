<!-- 反代网关 · 号池：顶部三渠道主按钮（各自独立成区，选中即点亮），下方整块切换为当前渠道面板。
     面板内自带工具栏（策略 / 添加账号 / 一键签到或领加油包 / 刷新），全部只作用于当前渠道，互不关联；
     签到结果按渠道各自记忆；账号经四途径添加（OAuth / 本机导入 / 文件 / 粘贴）。
     号池多设备 WebDAV 同步已移至独立「号池同步」页 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch, nextTick } from "vue";
import * as api from "../../api/ipc";
import type { ProxyChannelView, ProxyAccount, ProxyChannelId, ProxyBuiltinChannelId, ProxyChannelKind, ProxyPoolStrategy, ProxyScanCandidate, ProxyCheckinRow, ZcodeDeviceRow } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtInt, fmtK, fmtDate, fmtAgo, ACCOUNT_STATUS, SOURCE_NAMES, channelName, fmtBalance, balanceUnit } from "./format";
import { coalesceAsync } from "../../utils/timing";

const app = useAppStore();
const pool = ref<ProxyChannelView[]>([]);
const refreshingChannel = ref(false);
const refreshingId = ref("");

// ===== 积分包明细展开（Q6）=====
const expandedIds = ref<Set<string>>(new Set());
function togglePkg(id: string) {
  const next = new Set(expandedIds.value);
  next.has(id) ? next.delete(id) : next.add(id);
  expandedIds.value = next;
}
/** 已用占比（进度条宽度 %）：total<=0 或不限时不画条（模板已 v-if 拦） */
function pkgUsedPct(pkg: { used: number; total: number }): number {
  if (!pkg.total || pkg.total <= 0) return 0;
  const used = pkg.used === -1 ? 0 : Math.max(0, pkg.used);
  return Math.min(100, Math.round((used / pkg.total) * 100));
}
/** 剩余天数文案：expiresAt=0→长期；已过期→已过期；否则「剩 N 天」（不足一天按 1 天） */
function pkgDaysText(pkg: { expiresAt: number; expired?: boolean }): string {
  if (!pkg.expiresAt) return "长期";
  if (pkg.expired) return "已过期";
  const d = Math.max(1, Math.ceil((pkg.expiresAt - Date.now()) / 86400000));
  return `剩 ${d} 天`;
}
/** 状态徽标：已过期(红) / 即将到期(琥珀) / 生效中(灰) —— 阈值由主进程按 expiringSoonDays 派生 */
function pkgStatusCls(pkg: { expired?: boolean; expiringSoon?: boolean }): string {
  if (pkg.expired) return "tag-err";
  if (pkg.expiringSoon) return "tag-warn";
  return "tag-dim";
}
function pkgStatusText(pkg: { expired?: boolean; expiringSoon?: boolean }): string {
  if (pkg.expired) return "已过期";
  if (pkg.expiringSoon) return "即将到期";
  return "生效中";
}

// ===== Toast 悬浮提示（右上角、自动消失）：替代常驻页面的提示卡片 =====
const toasts = ref<{ id: number; text: string; kind: "info" | "err" }[]>([]);
let toastSeq = 0;
function toast(text: string, kind: "info" | "err" = "info") {
  if (!text) return;
  const id = ++toastSeq;
  toasts.value.push({ id, text, kind });
  if (toasts.value.length > 4) toasts.value.shift(); // 同屏最多 4 条，更早的直接让位
  setTimeout(() => {
    toasts.value = toasts.value.filter((t) => t.id !== id);
  }, 4200);
}
// 渠道主按钮：顶部三个大按钮切换，下方整块区域只显示当前渠道号池
const activeChannel = ref<ProxyChannelId>("trae");
// 本地 IDE 快捷切换
const ideStatus = ref<{ workbuddyInstalled: boolean; workbuddyAiInstalled?: boolean; traeInstalled?: boolean; raccoonInstalled?: boolean; zcodeInstalled?: boolean; currentUid: string } | null>(null);
const ideSwitching = ref("");
let offEvent: (() => void) | undefined;

// 渠道主按钮元信息：图标 + 差异说明（各渠道登录/签到形态互不相同，一眼看出各自独立）
// 键类型收在 ProxyBuiltinChannelId：既保住"漏配某个内置渠道"的编译期检查，
// 又逼着提供商走 PROVIDER_META 这条显式分支（提供商 id 是运行期数据，不可能配进这张表）
const CHANNEL_META: Record<ProxyBuiltinChannelId, { icon: string; hint: string }> = {
  trae: { icon: "ph-code-simple", hint: "回环登录 · 每日签到" },
  workbuddy: { icon: "ph-buildings", hint: "官方登录 · 每日签到" },
  workbuddy_ai: { icon: "ph-globe-hemisphere-west", hint: "国际版 · 一次性加油包" },
  raccoon: { icon: "ph-paw-print", hint: "文件导入/粘贴 · 每日签到" },
  cline_free: { icon: "ph-lightning", hint: "设备授权登录 · 粘贴 · 本机导入" },
  cline_pass: { icon: "ph-crown", hint: "设备授权登录 · 粘贴 · 本机导入" },
  autoclaw: { icon: "ph-robot", hint: "粘贴 · 本机导入（官方无网页登录）" },
  autoclaw_intl: { icon: "ph-globe", hint: "OAuth 登录（滑块验证）· 粘贴" },
  qoder: { icon: "ph-cursor", hint: "设备授权登录 · 粘贴" },
  zcode: { icon: "ph-lightning", hint: "GLM 编码套餐 · 领奖励 · 切号保远程" },
  zcode_intl: { icon: "ph-lightning", hint: "GLM 编码套餐 · 国际区（薄别名渠道）" },

};
// 自定义提供商只有 API Key：没有登录态、没有签到、没有余额概念，措辞要与生态渠道明确区分
const PROVIDER_META = { icon: "ph-plugs-connected", hint: "API Key 轮转 · 无余额概念" };

// ===== 渠道能力表（与主进程一一对应，缺能力的动作一律不摆按钮）=====
// 签到：判据是 adapters.cjs 里 checkin/checkinStatus 这两个方法存不存在——只有这四家定义了。
// Cline 双池 / AutoClaw 双区 / Qoder 官方就没有签到体系，主进程对它们只能回 unavailable，
// 界面上摆个按钮就是骗人点一次、跑一轮空请求。
const CHECKIN_CAPABLE: Record<ProxyBuiltinChannelId, boolean> = {
  trae: true,
  workbuddy: true,
  workbuddy_ai: true, // 国际版的「签到」由主进程改判成一次性加油包，能力仍在
  raccoon: true,
  cline_free: false,
  cline_pass: false,
  autoclaw: false,
  autoclaw_intl: false,
  qoder: false,
  zcode: false,
  zcode_intl: false,
};
// 写回本地客户端登录态：主进程 ideswitch.cjs 只认这三家（WB 双区 auth 文件 + 小浣熊 config/auth.json），
// Trae 是 ByteCrypto 加密信封、明确不做。必须是白名单而不是"内置渠道里排除 trae"——
// 先前那样写让 cline_*/autoclaw*/qoder 的按钮全点亮、标题还承诺"写为本地当前登录态"，
// 点下去才被主进程拒掉（后端那道门禁保留，这里是纵深不是替代）。
const IDE_WRITEBACK_CHANNELS: ProxyBuiltinChannelId[] = ["workbuddy", "workbuddy_ai", "raccoon", "zcode", "zcode_intl"];

/** 提供商 id 是运行期字符串，查不到这张表 → undefined → 一律按"无此能力"处理 */
function checkinCapable(id: ProxyChannelId) {
  return CHECKIN_CAPABLE[id as ProxyBuiltinChannelId] === true;
}
function ideWritebackCapable(id: ProxyChannelId) {
  return IDE_WRITEBACK_CHANNELS.includes(id as ProxyBuiltinChannelId);
}

function isBuiltin(ch: ProxyChannelView) {
  return ch.kind !== "openai_compat";
}
function metaOf(ch: ProxyChannelView) {
  return isBuiltin(ch) ? CHANNEL_META[ch.id as ProxyBuiltinChannelId] ?? PROVIDER_META : PROVIDER_META;
}
/** 按渠道 id 反查 kind：账号行只带 channel，而"能不能签"/"能不能写回 IDE"这类判断必须先看渠道类型 */
function channelKind(id: ProxyChannelId): ProxyChannelKind {
  return pool.value.find((c) => c.id === id)?.kind || "builtin";
}

// 签到状态区：结果按渠道各自记忆，切渠道互不串扰；跑完弹弹窗展示「发起签到那个渠道」的结果
const checkinBusy = ref(false);
const checkinOpen = ref(false);
const checkinShownChannel = ref<ProxyChannelId>("trae");
const checkinByChannel = ref<Record<string, ProxyCheckinRow[]>>({});
const shownCheckin = computed(() => checkinByChannel.value[checkinShownChannel.value] || []);
const shownCheckinName = computed(
  () => pool.value.find((c) => c.id === checkinShownChannel.value)?.display || checkinShownChannel.value
);
const shownCheckinStats = computed(() => {
  const rows = shownCheckin.value;
  return {
    ok: rows.filter((r) => r.ok && !r.already && !r.unavailable).length,
    already: rows.filter((r) => r.already).length,
    unavail: rows.filter((r) => r.unavailable).length,
    fail: rows.filter((r) => !r.ok).length,
  };
});
function putCheckin(channel: ProxyChannelId, rows: ProxyCheckinRow[]) {
  checkinByChannel.value = { ...checkinByChannel.value, [channel]: rows };
}

// 添加账号弹窗（四方式：oauth 官方登录 / local 从本机软件导入 / file 从 JSON-ZIP 文件 / paste 粘贴 JSON）
// 渠道类型收在内置：提供商的 Key 在「自定义提供商」页管（openAdd 已提前分流），这里的弹窗只服务生态渠道
type AddMethod = "oauth" | "local" | "file" | "paste";
const addOpen = ref(false);
const addChannel = ref<ProxyBuiltinChannelId>("trae");
const addMethod = ref<AddMethod>("oauth");
const pasteJson = ref("");
const pasteMsg = ref("");
const pasteErr = ref(false);
const pasteBusy = ref(false);
const fileMsg = ref("");
const fileErr = ref(false);
const fileBusy = ref(false);
const oauthWaiting = ref(false);
// 发起中：请求在途、AutoClaw 国际版正在等滑块结果。与 oauthWaiting 分开是因为
// 「等滑块」时浏览器还没开，显示「已在浏览器打开登录页」就是骗人；也不该让用户重复点
const oauthBusy = ref(false);
const oauthMsg = ref("");
const oauthMode = ref("");
const oauthErr = ref(false); // 与等待态共用 oauthMsg 一条消息位，靠它决定是不是红色错误文案
// 发起序号：取消或重开弹窗时递增，让已经飞出去的结果落地即失效
let oauthRun = 0;
// mode=device（cline / qoder）时后端回的验证码：授权页通常已自动带上，留一手给用户手输
const oauthUserCode = ref("");
// qoder 国际版 / 中国版是两套域名（登录与调度同源），登录入口就地切换
const qoderEdition = ref<"intl" | "cn">("intl");
// AutoClaw 国际版的两个上游：滑块过了之后按这个 vendor 换授权地址
const aclawVendor = ref<"zai" | "google">("zai");
// 浏览器没跳回回环地址时的兜底：把地址栏整段粘回来
const callbackInput = ref("");
const callbackBusy = ref(false);
const callbackMsg = ref("");
// 本机软件导入：候选列表 + 逐条/一键导入
const scanList = ref<ProxyScanCandidate[]>([]);
const scanBusy = ref(false);
const scanMsg = ref("");
const scanErr = ref(false);
// 用「渠道:文件」当导入中的行标识：列表在导入过程中会被重新扫描替换，下标引用不稳
const scanImporting = ref("");
// 账号重命名（点击名称进入编辑）：renamingId 当前编辑行，renameText 输入内容
const renamingId = ref("");
const renameText = ref("");

// 添加方式可用性：oauth 这一档按渠道门禁，其余三档所有内置渠道都开放
// · AutoClaw 国内版：官方只有客户端手机号+验证码登录，没有可代收的网页授权（主进程 beginOAuth 直接拒）
// · 小浣熊：上游 v1.18.0 起已支持应用内登录（打开官方授权页 → 粘回 office-raccoon:// 深链换码），
//   本分支基点（b476f52）时还没有，合并时按上游事实放行（不再挡）
function addTabAllowed(key: AddMethod): boolean {
  if (key !== "oauth") return true;
  return addChannel.value !== "autoclaw";
}

// 渠道允许的添加方式（分段控件按渠道过滤）
const METHOD_TABS = computed(
  () =>
    [
      { key: "oauth" as const, label: "OAuth 登录", icon: "ph-key" },
      { key: "local" as const, label: "从本机软件导入", icon: "ph-desktop-tower" },
      { key: "file" as const, label: "从 JSON/ZIP 文件", icon: "ph-file-arrow-up" },
      { key: "paste" as const, label: "粘贴 JSON", icon: "ph-clipboard-text" },
    ].filter((t) => addTabAllowed(t.key)) as { key: AddMethod; label: string; icon: string }[]
);

// OAuth 面板文案按渠道切换（两种登录形态完全不同，说清楚用户才知道要做什么）
const OAUTH_HELP: Record<string, { title: string; desc: string }> = {
  trae: {
    title: "用 Trae SOLO CN 官方授权页登录",
    desc: "跳转官方授权页（登录域由官方下发），授权后回调本机回环地址完成登录。<br />每账号独立执行一次，可反复添加多账号；3 分钟无响应即超时。<br />若浏览器停在回调页没自动跳回，可把地址栏内容整段粘到下方。",
  },
  workbuddy: {
    title: "用 WorkBuddy CN 官方登录页登录",
    desc: "跳转官方登录页，登录完成后本机每 1.5 秒轮询一次授权结果，无需手动回调。<br />每账号独立执行一次，可反复添加多账号；3 分钟无响应即超时。",
  },
  workbuddy_ai: {
    title: "用 WorkBuddy AI 官方登录页登录",
    desc: "跳转国际版官方登录页，登录完成后本机自动轮询授权结果。<br />每账号独立执行一次，可反复添加多账号；3 分钟无响应即超时。",
  },
  raccoon: {
    title: "用「商汤小浣熊」官方授权页登录",
    desc: "在应用内弹出的授权窗里完成登录，授权码由本应用直接截获入池——不经过系统浏览器，也不会拉起或顶掉本机小浣熊客户端的登录（深链永不出本应用）。<br />每账号独立执行一次，可反复添加多账号；3 分钟无响应即超时。<br />授权窗被意外拦截时，可把 office-raccoon://auth/callback?code=… 整段粘到下方兜底。",
  },
  zcode: {
    title: "用 Z.ai 官方授权页登录 ZCode（智谱）",
    desc: "跳转 Z.ai 授权页完成登录后，本机按服务端轮询自动完成入池（无需粘贴回调）。<br />登录后后台自动初始化套餐并解析编码套餐 API Key（约几十秒），期间账号已可用于 Start 套餐对话。<br />若浏览器停在 zcode:// 回调页，可把地址栏整段粘到下方兜底。",
  },
  // ===== 新增五渠道（autoclaw 国内版无网页登录，不出 OAuth 档，故本表无它的条目） =====
  cline_free: {
    title: "用 Cline 账号设备授权登录（免费池）",
    desc: "跳转 Cline 授权页并自动携带验证码，确认后本机自动轮询完成登录。<br />也可改用「从本机软件导入」（读取 ~/.cline 登录态）或「粘贴 JSON」。",
  },
  cline_pass: {
    title: "用 Cline 账号设备授权登录（订阅池）",
    desc: "与免费池同一账号同一登录流程，只是模型池不同。<br />确认授权后本机自动轮询完成登录。",
  },
  autoclaw_intl: {
    title: "用 AutoClaw 国际版 OAuth 登录",
    desc: "先完成滑块验证，再跳转 Zai / Google 授权页；登录后自动回到本应用。<br />没有国际版账号也可「粘贴 JSON」导入 token。",
  },
  qoder: {
    title: "用 Qoder 账号设备授权登录",
    desc: "跳转 Qoder 授权页登录并选择账号，本机每 2 秒轮询自动完成。<br />国际版 / 中国版在下方切换；也可「粘贴 JSON」导入。",
  },
  zcode_intl: {
    title: "用 ZCode 智谱（国际 / Z.AI）订阅登录态登录",
    desc: "跳转 ZCode 授权页（Z.AI 账号）登录，本机轮询自动完成并换取编码套餐 API Key 入池。<br />需已在 z.ai 控制台开通编码套餐；也可「粘贴 JSON」导入 coding key。",
  },
};

// 「打开登录页」之后的等待文案：超时窗口按渠道各不相同，写死一个数会把用户钉在假等待里干等——
// Trae / WorkBuddy 双区 3 分钟，cline 以上游下发的 expires_in 为准（约 5 分钟），
// qoder 与 AutoClaw 国际版给了双倍（6 分钟：授权页还要登录 + 选账号 / 走上游回调）
const OAUTH_WAIT_MSG: Record<string, string> = {
  trae: "已在浏览器打开官方授权页，完成授权后自动回到本应用并入池（3 分钟无响应即超时）…",
  workbuddy: "已在浏览器打开官方登录页，登录完成后本机自动轮询入池（3 分钟无响应即超时）…",
  workbuddy_ai: "已在浏览器打开国际版官方登录页，登录完成后本机自动轮询入池（3 分钟无响应即超时）…",
  cline_free: "已在浏览器打开 Cline 授权页，页面已自动带上验证码，点确认后本机自动轮询入池（有效期以上游下发为准，约 5 分钟）…",
  cline_pass: "已在浏览器打开 Cline 授权页，页面已自动带上验证码，点确认后本机自动轮询入池（有效期以上游下发为准，约 5 分钟）…",
  qoder: "已在浏览器打开 Qoder 授权页，登录并选择账号后本机每 2 秒轮询自动入池（6 分钟无响应即超时）…",
  autoclaw_intl: "已在浏览器打开授权页，完成登录与账号选择后自动回到本应用入池（6 分钟无响应即超时）…",
  zcode: "已在浏览器打开 ZCode 授权页，完成登录后本机自动轮询、换取编码套餐 Key 并入池（3 分钟无响应即超时）…",
  zcode_intl: "已在浏览器打开 ZCode 授权页，完成登录后本机自动轮询、换取编码套餐 Key 并入池（3 分钟无响应即超时）…",
};
const OAUTH_WAIT_DEFAULT = "已在浏览器打开官方登录页，完成授权后自动加入号池…";
// 滑块阶段的提示（还没开浏览器，绝不能复用上面的「已在浏览器打开」文案）
const CAPTCHA_WAIT_MSG = "请在弹出的滑块中完成验证，通过后自动打开授权页…";

// 粘贴 JSON 的渠道专属说明：几家新渠道的 token 形态互不相同（前缀、打包串、JWT 声明），
// 光给一个通用 JSON 示例用户不知道该粘什么。字段口径与主进程 normalizeAccountJson 同源：
// 它只认 token/accessToken/access_token/jwt + refreshToken + uid，多余的键（如 device_id）会被丢掉，
// 所以说明里不承诺"把 device_id 一起粘进来"——刷新链路的 device_id 由适配器从 token 声明里解
const PASTE_HINT: Record<string, string> = {
  cline_free: "粘贴 WorkOS JWT（不带 workos: 前缀会自动补）与 refresh_token",
  cline_pass: "粘贴 WorkOS JWT（不带 workos: 前缀会自动补）与 refresh_token —— 与免费池同一套凭据，只是入不同的池",
  autoclaw: "粘贴 access_token（可带 Bearer 前缀自动剥）与 refresh_token；刷新要用的 device_id 由本应用从 token 声明里解",
  autoclaw_intl: "粘贴国际版 access_token（可带 Bearer 前缀自动剥）与 refresh_token；刷新要用的 device_id 由本应用从 token 声明里解",
  qoder: "粘贴 accessToken；refreshToken 粘打包串（oauth刷新令牌|userId|machineId 或 pat|PAT|…|userId|machineId）",
  zcode: "粘贴编码套餐 API Key（coding key，形如 {apiKey} 或 {apiKey}.{secret}）；无 refresh 概念，失效请重新登录",
  zcode_intl: "粘贴编码套餐 API Key（coding key，国际版一般为 {apiKey}.{secret}）；无 refresh 概念，失效请重新登录",
};
const pasteHint = computed(() => PASTE_HINT[addChannel.value] || "");

// 粘贴 JSON 的字段示例（placeholder 用，随渠道切换 token 字段名提示）
const pastePlaceholder = computed(() => {
  if (addChannel.value === "zcode") {
    return `zcode 支持三种形态：\n① 轻量：{ "zcodeJwtToken": "…", "codingPlanKey": "apiKey.secret（选填）", "provider": "zai" }\n② 快照：{ "credentials": {…}, "config": {…} }（整份凭据，含切号快照）\n③ zcode-account-switcher 导出文件的 accounts 数组条目`;
  }
  const tokenKey = addChannel.value === "trae" ? "jwt" : "accessToken";
  const extra = addChannel.value === "raccoon" ? `\n  "officeIdentity": "选填，团队版组织标识",` : "";
  return `单个对象或数组均可，字段容忍别名：\n{\n  "name": "主账号（选填）",\n  "${tokenKey}": "渠道原生 token（必填）",\n  "refreshToken": "选填",${extra}\n  "uid": "选填，缺省从 token 解析"\n}`;
});

// 移出确认
const delOpen = ref(false);
const delRow = ref<ProxyAccount | null>(null);

const STRATEGIES: { value: ProxyPoolStrategy; label: string }[] = [
  { value: "expire_first", label: "到期优先" },
  { value: "credit_first", label: "余额优先" },
  { value: "round_robin", label: "轮询" },
];

const loading = ref(false);
const zcodeHasReward = ref(false);

async function checkZcodeReward() {
  try {
    const res = await api.proxyCheckinStatus("zcode");
    if (res && res.ok && Array.isArray(res.rows)) {
      zcodeHasReward.value = res.rows.some((r) => {
        if (!r.ok || r.already || r.unavailable) return false;
        if (Array.isArray(r.plans) && r.plans.length > 0) return true;
        return !r.already && !r.unavailable && r.ok;
      });
    } else {
      zcodeHasReward.value = false;
    }
  } catch {
    zcodeHasReward.value = false;
  }
  // 顺带刷新指纹告警灯与领取模式状态（无声失败不影响主流程，弹窗打开时会再拉一次实时的）
  try {
    const ds = await api.proxyZcodeDeviceStatus();
    devRows.value = ds.rows || [];
    devLiveMid.value = ds.liveMid || "";
    devAnchorMid.value = ds.anchorMid || "";
    devClaimMode.value = !!ds.claimMode;
  } catch { /* 忽略 */ }
}

async function refresh() {
  if (!pool.value.length) loading.value = true;
  try {
    pool.value = await api.proxyPool();
    ideStatus.value = await api.proxyIdeStatus().catch(() => null);
    void checkZcodeReward();
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    loading.value = false;
  }
}

/** 右上角刷新按钮：只刷当前渠道（不是全量），结果走 Toast 提示 */
async function refreshCurrentChannel() {
  if (refreshingChannel.value) return;
  const channel = activeChannel.value; // 期间可能切渠道，消息与结果都归属发起时的渠道
  refreshingChannel.value = true;
  try {
    const r = await api.proxyCreditsRefreshChannel(channel);
    const unavail = (r.results || []).filter((x) => x.unavailable);
    let text = `${channelName(channel)} 已刷新 ${r.total ?? 0} 个账号，失败 ${r.failed ?? 0}`;
    if (unavail.length) text += ` · ${unavail.length} 个账号积分服务未开放（${unavail[0].message || ""}）`;
    toast(text, r.failed ? "err" : "info");
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    refreshingChannel.value = false;
    await refresh();
  }
}

// ===== 每日签到（三渠道不同形态：Trae ug 签到 / WB 中国区 daily-checkin / 国际版无签到只有加油包） =====

function checkinTagCls(r: ProxyCheckinRow) {
  if (!r.ok) return r.needCaptcha || r.deviceBurned ? "tag-warn" : "tag-err";
  if (r.already) return "tag-dim";
  if (r.unavailable) return "tag-warn";
  return "tag-ok";
}
function checkinTagText(r: ProxyCheckinRow) {
  if (!r.ok) return r.needCaptcha ? "需过码" : r.deviceBurned ? "指纹被烧" : "失败";
  if (r.already) return checkinShownChannel.value === "zcode" ? "已领取" : "已签到";
  if (r.unavailable) return "不开放";
  return "成功";
}

/** 渠道级一键签到（只对当前渠道），跑完弹弹窗逐账号展示、结果只记在该渠道名下 */
async function runCheckinChannel() {
  if (checkinBusy.value) return;
  const channel = activeChannel.value; // 签到期间可能切渠道：发起渠道先存快照，结果才不会记错名下
  checkinBusy.value = true;
  try {
    let r = await api.proxyCheckinRun({ channel, action: "checkin" });
    if ((r as unknown as { needCaptcha?: boolean; captcha?: { region?: string; prefix?: string; sceneId?: string } }).needCaptcha) {
      // zcode 领取的人机校验二段流：渲染层过码后带参数重试一次
      const solved = await solveZcodeCaptcha((r as unknown as { captcha: { region?: string; prefix?: string; sceneId?: string } }).captcha);
      if (!solved) {
        toast("人机校验未完成，已取消领取", "err");
        return;
      }
      r = await api.proxyCheckinRun({ channel, action: "checkin", captcha: solved });
    }
    if (r.ok === false) {
      toast(r.message || "签到失败", "err");
      return;
    }
    putCheckin(channel, r.rows);
    checkinShownChannel.value = channel;
    checkinOpen.value = true;
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    checkinBusy.value = false;
    await refresh();
  }
}

/** 单账号签到（表格行内按钮），结果同样进弹窗 */
async function runCheckinAccount(acc: ProxyAccount) {
  if (checkinBusy.value) return;
  checkinBusy.value = true;
  try {
    const r = await api.proxyCheckinRun({ channel: acc.channel, accountId: acc.id, action: "checkin" });
    if (r.ok === false) {
      toast(r.message || "签到失败", "err");
      return;
    }
    putCheckin(acc.channel, r.rows);
    checkinShownChannel.value = acc.channel;
    checkinOpen.value = true;
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    checkinBusy.value = false;
    await refresh();
  }
}

/** 国际版加油包（trial）：AI 无每日签到，只有一次性加油包 */
async function runTrial() {
  if (checkinBusy.value) return;
  checkinBusy.value = true;
  try {
    const r = await api.proxyCheckinRun({ channel: "workbuddy_ai", action: "trial" });
    if (r.ok === false) {
      toast(r.message || "领取失败", "err");
      return;
    }
    putCheckin("workbuddy_ai", r.rows);
    checkinShownChannel.value = "workbuddy_ai";
    checkinOpen.value = true;
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    checkinBusy.value = false;
    await refresh();
  }
}

// ===== ZCode 独立人机校验（过码）=====
const solvingCaptchaId = ref<string>("");

/** 判断该账号当前是否因 3007/人机校验而报错或需过码 */
function isNeedCaptcha(acc?: ProxyAccount | null): boolean {
  if (!acc) return false;
  const msg = String(acc.lastError?.message || acc.coolReason || "");
  return acc.channel === "zcode" && (/人机校验|验证码|3007|captcha|verify/i.test(msg));
}

/** 触发独立人机校验过码流程（两段式：子进程回滑块配置 → 渲染层过码 → 带参完成） */
async function runSolveCaptcha(acc: ProxyAccount) {
  if (!acc || solvingCaptchaId.value) return;
  solvingCaptchaId.value = acc.id;
  try {
    let r = await api.proxyZcodeSolveCaptcha(acc.id);
    const first = r as unknown as { needCaptcha?: boolean; captcha?: { region?: string; prefix?: string; sceneId?: string } };
    if (first.needCaptcha) {
      const solved = await solveZcodeCaptcha(first.captcha);
      if (!solved) {
        toast("人机校验未完成，已取消", "err");
        return;
      }
      r = await api.proxyZcodeSolveCaptcha(acc.id, solved.verifyParam, solved.region);
    }
    if (r.ok) {
      toast(r.message || "人机校验通过，账号已恢复可用", "info");
      if (errRow.value?.id === acc.id) errRow.value = null;
    } else {
      toast(r.message || "人机校验未完成", "err");
    }
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    solvingCaptchaId.value = "";
    await refresh();
  }
}

/** 一键把账号应用为本地 IDE 当前登录态：所有渠道首调只做预检（后端返回 needConfirm + probe：
 *  目标客户端是否在运行 / 安装路径 / 切完是否自动重启），弹确认框让用户过目；确认后带 confirmAck
 *  重调才真正执行——关客户端 → 等退出 → 写回（Trae 加密信封无法写回，预检即如实回报不弹框） */
async function ideSwitch(acc: ProxyAccount) {
  if (ideSwitching.value) return;
  ideSwitching.value = acc.id;
  try {
    const r = await api.proxyIdeSwitch(acc.id);
    if (r.needConfirm) {
      // 客户端正在运行：弹确认框，用户确认「关闭客户端并切换」后带 confirmAck 重调
      pendingConfirm.value = { kind: "switch", accountId: acc.id, channel: acc.channel, name: acc.name || acc.uid || "", message: r.message || "", probe: r.probe || null };
      return;
    }
    toast(r.message || (r.ok ? "已切换" : "暂不支持"), r.ok ? "info" : "err");
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    ideSwitching.value = "";
    ideStatus.value = await api.proxyIdeStatus().catch(() => ideStatus.value);
  }
}

/** 切号/领取模式/恢复指纹统一确认框：kind 区分确认后真正调用的通道 */
const pendingConfirm = ref<{ kind: "switch" | "claim" | "restore"; accountId: string; channel: string; name: string; message: string; probe: api.IdeSwitchProbe | null } | null>(null);
/** 确认框标题与按钮文案：切号 / 进入领取模式 / 恢复本机指纹 */
const confirmTitleText = computed(() => {
  const k = pendingConfirm.value?.kind;
  if (k === "claim") return "进入领取模式（临时借出指纹）";
  if (k === "restore") return "恢复本机锚定指纹";
  return `切换 ${channelName(pendingConfirm.value?.channel || "zcode")} 登录账号`;
});
/** 确认框按钮文案：目标客户端在跑就是「关闭客户端并执行」，没开就直接执行 */
const confirmActionText = computed(() => {
  const k = pendingConfirm.value?.kind;
  const verb = k === "claim" ? "进入领取模式" : k === "restore" ? "恢复本机指纹" : "切换并写入登录态";
  const p = pendingConfirm.value && pendingConfirm.value.probe;
  if (p && p.running) return p.relaunch ? `关闭客户端并${k === "switch" ? "切换" : "执行"}` : `关闭客户端（需手动重开）`;
  return verb;
});
const confirmBusy = ref(false);
async function confirmIdeSwitch() {
  const p = pendingConfirm.value;
  if (!p || confirmBusy.value) return;
  confirmBusy.value = true;
  try {
    const r = p.kind === "claim"
      ? await api.proxyZcodeClaimMode(p.accountId, true)
      : p.kind === "restore"
        ? await api.proxyZcodeRestoreMid(true)
        : await api.proxyIdeSwitch(p.accountId, true);
    toast(r.message || (r.ok ? "已完成" : "失败"), r.ok ? "info" : "err");
    if (r.ok) pendingConfirm.value = null;
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    confirmBusy.value = false;
    ideStatus.value = await api.proxyIdeStatus().catch(() => ideStatus.value);
    await refreshDevState();
  }
}

/**
 * 进入领取模式（人工链路）：把本机指纹临时借出为该账号专属指纹并重启客户端，
 * 用户在官方客户端里人工领取周末套餐；领完点工具栏「恢复本机指纹」。
 * 首调只做预检（needConfirm + probe），确认后带 confirmAck 重调。
 */
async function enterClaimMode(acc: ProxyAccount) {
  if (ideSwitching.value) return;
  ideSwitching.value = acc.id;
  try {
    const r = await api.proxyZcodeClaimMode(acc.id);
    if (r.needConfirm) {
      pendingConfirm.value = { kind: "claim", accountId: acc.id, channel: acc.channel, name: acc.name || acc.uid || "", message: r.message || "", probe: r.probe || null };
      return;
    }
    toast(r.message || (r.ok ? "已进入领取模式" : "无法进入领取模式"), r.ok ? "info" : "err");
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    ideSwitching.value = "";
    await refreshDevState();
  }
}

/** 恢复本机锚定指纹（领取模式收尾）：写回 anchor.remoteMid 并重启客户端，手机远程恢复 */
async function restoreRemoteMid() {
  if (devBusy.value) return;
  devBusy.value = true;
  try {
    const r = await api.proxyZcodeRestoreMid();
    if (r.needConfirm) {
      pendingConfirm.value = { kind: "restore", accountId: "", channel: "zcode", name: "", message: r.message || "", probe: r.probe || null };
      return;
    }
    toast(r.message || (r.ok ? "已恢复" : "恢复失败"), r.ok ? "info" : "err");
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    devBusy.value = false;
    await refreshDevState();
  }
}

/** zcode 切号回滚（切出问题/远程连接异常时一键还原最近一次切前状态） */
async function zcodeRollback() {
  const r = await api.proxyZcodeSwitchRollback().catch((e) => ({ ok: false, message: String((e as Error).message || e) }));
  toast(r.message || (r.ok ? "已回滚" : "回滚失败"), r.ok ? "info" : "err");
}

// ===== zcode 设备指纹诊断/修复（周末套餐 1004：号间共用一枚指纹时一号领取全组被烧） =====
const devDlgOpen = ref(false);
const devRows = ref<ZcodeDeviceRow[]>([]);
const devLiveMid = ref("");
const devAnchorMid = ref("");
const devClaimMode = ref(false);
const devBusy = ref(false);

async function openDeviceDiag() {
  devBusy.value = true;
  try {
    const r = await api.proxyZcodeDeviceStatus();
    devRows.value = r.rows || [];
    devLiveMid.value = r.liveMid || "";
    devAnchorMid.value = r.anchorMid || "";
    devClaimMode.value = !!r.claimMode;
    devDlgOpen.value = true;
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    devBusy.value = false;
  }
}

/** 领取模式状态静默刷新（工具栏警示按钮与诊断弹窗头部都吃这份数据） */
async function refreshDevState() {
  try {
    const r = await api.proxyZcodeDeviceStatus();
    devRows.value = r.rows || [];
    devLiveMid.value = r.liveMid || "";
    devAnchorMid.value = r.anchorMid || "";
    devClaimMode.value = !!r.claimMode;
  } catch { /* 忽略：下次轮询再拿 */ }
}

async function runDeviceRepair(all: boolean) {
  if (devBusy.value) return;
  devBusy.value = true;
  try {
    const r = await api.proxyZcodeDeviceRepair(all);
    devRows.value = r.rows || [];
    devLiveMid.value = r.liveMid || "";
    toast(r.repaired ? `已给 ${r.repaired} 个账号重派全新设备指纹` : "当前没有需要修复的指纹", "info");
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    devBusy.value = false;
  }
}

/** 有账号处于撞车/疑似被烧状态时工具栏按钮点亮告警 */
const devHasIssue = computed(() => devRows.value.some((r) => r.conflictWith.length > 0 || r.burnedLikely || !r.deviceMid));

/** 该账号能否写回本地客户端（Trae 的登录态是加密信封，写不了） */

function ideSupported(acc: ProxyAccount) {
  // 自定义提供商的账号是一把第三方 API Key，本机没有对应的客户端登录态可写。
  // 必须挡在最前面：下面的分支对未知渠道会回落到 WorkBuddy 的判定，
  // 放过去就会把中转站 Key 写进 WorkBuddy 的登录文件。
  if (channelKind(acc.channel) !== "builtin") return false;
  if (!ideWritebackCapable(acc.channel)) return false;
  if (!ideStatus.value) return true;
  if (acc.channel === "raccoon") return ideStatus.value.raccoonInstalled !== false;
  if (acc.channel === "zcode" || acc.channel === "zcode_intl") return ideStatus.value.zcodeInstalled !== false;

  return acc.channel === "workbuddy_ai" ? ideStatus.value.workbuddyAiInstalled !== false : ideStatus.value.workbuddyInstalled !== false;
}

function ideTitle(acc: ProxyAccount) {
  if (channelKind(acc.channel) !== "builtin") return "自定义提供商只有一把 API Key，本机没有对应的客户端登录态可写回";
  if (acc.channel === "trae") return "Trae 本地登录态为 ByteCrypto 加密信封（绑定设备密钥），无法构造合法信封，暂不支持写回";
  // 新渠道（Cline / AutoClaw / Qoder）本机就没有这套登录文件，别说成"未安装"
  if (acc.channel === "raccoon") return "把该账号写为小浣熊本机登录态（~/.box-agent/config/auth.json）；点击后弹确认框，确认即自动关闭客户端、写入、再重新打开，登录文件缺失时按号池凭据重建";
  if (acc.channel === "zcode" || acc.channel === "zcode_intl") return "把该账号写为本机 ZCode 当前登录态（合并式写回，移动端远程连接地址保持不变）；点击后弹确认框，确认即自动关闭客户端、写入、再重新打开";
  if (!ideSupported(acc)) return "本机未找到对应客户端的登录文件（未安装或从未登录过）";
  return `把该账号写为本地 ${channelName(acc.channel)} 当前登录态；点击后弹确认框，确认即自动关闭客户端、写入、再重新打开`;
}

// ===== ZCode 活动领取（上游 v1.31 起走 checkin 二段流：一键领取 → needCaptcha → 渲染层过码 → 带参重试）=====
// 旧「领取面板」（proxy_zcode_claim_* 三命令）随上游渠道重构退役：领取动作并入渠道「一键领取」，
// planId 由适配器自动选当前可领套餐，本组件只负责过码这一段。
const zcapOpen = ref(false);
let zcapTimer: number | undefined = undefined;

/** 领取专用阿里云滑块：复用 loadAliyunCaptcha，挂到 zcap-captcha-* 节点，回调返回 verify param */
function runZcodeCaptcha(region: string, prefix: string, sceneId: string): Promise<string> {
  return new Promise<string>(async (resolve) => {
    try {
      await loadAliyunCaptcha(region, prefix);
    } catch {
      zcapOpen.value = false;
      resolve("");
      return;
    }
    const w = window as unknown as AliyunCaptchaWindow;
    if (typeof w.initAliyunCaptcha !== "function") { zcapOpen.value = false; resolve(""); return; }
    let done = false;
    const finish = (v: string) => {
      if (done) return;
      done = true;
      if (zcapTimer) { clearTimeout(zcapTimer); zcapTimer = undefined; }
      zcapOpen.value = false;
      resolve(v);
    };
    zcapOpen.value = true;
    await nextTick(); // 挂载节点随弹窗渲染，先等 DOM 就绪
    const mount = document.getElementById("zcap-captcha-element");
    if (mount) mount.innerHTML = "";
    w.initAliyunCaptcha!({
      SceneId: sceneId,
      mode: "popup",
      element: "#zcap-captcha-element",
      button: "#zcap-captcha-trigger",
      slideStyle: { width: 360, height: 40 },
      language: "cn",
      captchaVerifyCallback: async (param: string) => {
        finish(param);
        return { captchaResult: true, bizResult: true }; // 领取结果由 checkin 重试判定，这里只负责取到 param
      },
      onBizResultCallback: () => {},
      getInstance: (inst) => { aclawInstance = inst || null; },
      onError: () => finish(""),
    });
    setTimeout(() => (document.getElementById("zcap-captcha-trigger") as HTMLButtonElement | null)?.click(), 2100);
    zcapTimer = window.setTimeout(() => finish(""), ACLAW_CAPTCHA_TIMEOUT_MS);
  });
}

/** checkin 结果里的 needCaptcha → 弹过码 → 组装重试参数；取消/超时返回 null */
async function solveZcodeCaptcha(cfg: { region?: string; prefix?: string; sceneId?: string } | undefined) {
  if (!cfg || !cfg.sceneId) return null;
  const verifyParam = await runZcodeCaptcha(cfg.region || "", cfg.prefix || "", cfg.sceneId);
  return verifyParam ? { verifyParam, region: cfg.region || "", sceneId: cfg.sceneId } : null;
}

async function refreshOne(acc: ProxyAccount) {
  refreshingId.value = acc.id;
  try {
    await api.proxyAccountRefresh(acc.id);
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    refreshingId.value = "";
    await refresh();
  }
}

async function setStrategy(ch: ProxyChannelView, strategy: ProxyPoolStrategy) {
  try {
    await api.proxyPoolStrategy(ch.id, strategy);
    await refresh();
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  }
}

async function toggleAccount(acc: ProxyAccount) {
  try {
    await api.proxyAccountToggle(acc.id, acc.status === "disabled");
    await refresh();
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  }
}

/** 手动解除冷却：账号级立即回 online，模型级负缓存一并豁免（解了就要能立刻被调度） */
const coolOffId = ref("");

// ===== 账号重命名（自定义备注）：点击名称变输入框，失焦/回车提交，Esc 取消 =====

function startRename(acc: ProxyAccount) {
  renamingId.value = acc.id;
  renameText.value = acc.name || "";
}

async function commitRename(acc: ProxyAccount) {
  const name = renameText.value.trim();
  if (!name || name === acc.name) {
    renamingId.value = "";
    return;
  }
  try {
    const r = await api.proxyAccountRename(acc.id, name);
    if (r.ok === false) toast(r.message || "重命名失败", "err");
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    renamingId.value = "";
    renameText.value = "";
    await refresh();
  }
}

async function releaseCool(acc: ProxyAccount) {
  if (coolOffId.value) return;
  coolOffId.value = acc.id;
  try {
    const r = await api.proxyAccountCoolOff(acc.id);
    if (r.ok === false) {
      toast(r.message || "解除失败", "err");
      return;
    }
    toast(r.releasedModels ? `已解除冷却，并豁免 ${r.releasedModels} 个模型级冷却` : "已解除冷却");
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  } finally {
    coolOffId.value = "";
    await refresh();
  }
}

async function doDelete() {
  if (!delRow.value) return;
  try {
    await api.proxyAccountRemove(delRow.value.id);
    delOpen.value = false;
    await refresh();
  } catch (e) {
    toast(String((e as Error).message || e), "err");
  }
}

// ===== 添加账号 =====

function openAdd(ch: ProxyChannelView) {
  // 提供商的 Key 归「自定义提供商」页管（一把一填，带去重与连通性探测）。这里不复用四方式弹窗：
  // OAuth / 本机软件导入 / 凭据包 JSON 对中转站都不成立，硬塞进去只会摆三个必然失败的按钮
  if (!isBuiltin(ch)) {
    app.setPage("providers");
    return;
  }
  // 上面已按 kind 分流，走到这里 ch 必是内置渠道
  addChannel.value = ch.id as ProxyBuiltinChannelId;
  // 没有应用内 OAuth 的渠道（autoclaw 国内版官方无网页登录）默认落到「从本机软件导入」，
  // 否则会停在一个已被隐藏的标签页上（raccoon 上游已支持 OAuth，走上面的正常分支）
  addMethod.value = addTabAllowed("oauth") ? "oauth" : "local";
  pasteJson.value = "";
  pasteMsg.value = "";
  pasteErr.value = false;
  fileMsg.value = "";
  fileErr.value = false;
  oauthMsg.value = "";
  oauthMode.value = "";
  oauthErr.value = false;
  oauthUserCode.value = "";
  callbackInput.value = "";
  callbackMsg.value = "";
  scanMsg.value = "";
  scanErr.value = false;
  addOpen.value = true;
  loadScan(); // 打开即扫描本机，切到「从本机软件导入」时结果已经在了
}

/** 关弹窗：正在等回调 / 等滑块时一并收尾，不留后台悬挂的授权流程与挂起的滑块等待 */
function closeAdd() {
  addOpen.value = false;
  if (oauthWaiting.value || oauthBusy.value) cancelOauth();
}

function switchMethod(m: AddMethod) {
  // 等待回调与滑块进行中都不许切走：切走会把挂载容器与状态一起丢掉
  if (oauthWaiting.value || oauthBusy.value) return;
  addMethod.value = m;
  if (m === "local" && !scanList.value.length) loadScan();
}

/** 渠道专属登录参数：qoder 要区服（两套域名），AutoClaw 国际版要上游 vendor（滑块两跳同值） */
function oauthOpts(channel: ProxyBuiltinChannelId): { edition?: "intl" | "cn"; vendor?: "zai" | "google" } {
  if (channel === "qoder") return { edition: qoderEdition.value };
  if (channel === "autoclaw_intl") return { edition: "intl", vendor: aclawVendor.value };
  return {};
}

/** 底栏左侧提示：发起中（含滑块）与等待授权是两回事——后者浏览器才真的开过 */
const oauthFootHint = computed(() => {
  if (!oauthBusy.value) return "已在浏览器打开登录页，完成后会自动入池";
  return addChannel.value === "autoclaw_intl" ? "请在弹出的滑块中完成验证…" : "正在发起登录…";
});
const oauthCtaLabel = computed(() => {
  if (oauthBusy.value) return addChannel.value === "autoclaw_intl" ? "滑块验证中…" : "发起中…";
  if (oauthWaiting.value) return "等待授权…";
  return addChannel.value === "autoclaw_intl" ? "滑块验证并打开登录页" : "打开登录页";
});

async function beginOauth() {
  if (oauthWaiting.value || oauthBusy.value) return;
  const run = ++oauthRun; // 发起序号：取消或重开之后，迟到的结果不再往 UI 上写
  const ch = addChannel.value;
  oauthBusy.value = true; // 先只标"发起中"：等结果回来确认拿到 url，才谈得上"已在浏览器打开"
  oauthErr.value = false;
  oauthMsg.value = "";
  oauthUserCode.value = "";

  callbackMsg.value = "";
  try {
    const r = ch === "autoclaw_intl" ? await beginAutoClawIntlLogin() : await api.proxyOauthBegin(ch, oauthOpts(ch));
    if (run !== oauthRun) return;
    if (r.ok === false) {
      oauthErr.value = true;
      oauthMsg.value = r.message || "无法启动登录";
      return;
    }
    // 没有 url 就不是等待态（滑块拿不到 url 属于异常）：停在这里，别把"已在浏览器打开"演成假等待
    if (!r.url) {
      oauthErr.value = true;
      oauthMsg.value = "未拿到授权地址，请重新发起，或改用「粘贴 JSON」导入凭据";
      return;
    }
    oauthMode.value = r.mode || "";
    oauthUserCode.value = r.userCode || "";
    oauthWaiting.value = true;
    oauthMsg.value = OAUTH_WAIT_MSG[ch] || OAUTH_WAIT_DEFAULT;
  } catch (e) {
    if (run !== oauthRun) return;
    oauthErr.value = true;
    oauthMsg.value = String((e as Error).message || e);
  } finally {
    if (run === oauthRun) oauthBusy.value = false;
  }
}

// ===== AutoClaw 国际版：阿里云滑块前置（官方浏览器端 SDK 动态注入，主进程只管滑块参数的两跳） =====
const ACLAW_SDK = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const ACLAW_CAPTCHA_TIMEOUT_MS = 120000; // 滑块弹出后的等待上限：与参考项目同值 120s

/** 滑块 SDK 挂在 window 上的两个入口：无 npm 包，只能注脚本 + 取全局函数，故就地声明形状 */
interface AliyunCaptchaWindow {
  AliyunCaptchaConfig?: { region: string; prefix: string };
  initAliyunCaptcha?: (opts: {
    SceneId: string;
    mode: "popup";
    element: string;
    button: string;
    slideStyle: { width: number; height: number };
    language: string;
    captchaVerifyCallback: (param: string) => Promise<{ captchaResult: boolean; bizResult: boolean }>;
    onBizResultCallback?: (result: boolean) => void;
    getInstance?: (inst: { hide?: () => void } | null) => void;
    onError?: (err: unknown) => void;
  }) => void;
}
type OauthBeginResult = Awaited<ReturnType<typeof api.proxyOauthBegin>>;

let aclawInstance: { hide?: () => void } | null = null;
let aclawCaptchaTimer: number | undefined;

/** AliyunCaptchaConfig 必须先于脚本赋值：SDK 在加载期读它，顺序反了弹窗会一直转圈 */
async function loadAliyunCaptcha(region: string, prefix: string): Promise<void> {
  const w = window as unknown as AliyunCaptchaWindow;
  w.AliyunCaptchaConfig = { region, prefix };
  if (document.querySelector(`script[src="${ACLAW_SDK}"]`)) return; // 同一弹窗内重复发起时脚本只注一次
  await new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    s.src = ACLAW_SDK;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("滑块组件加载失败（检查网络/代理），可改用「粘贴 JSON」导入 token"));
    document.head.appendChild(s);
  });
}

/**
 * 第一跳只回滑块配置、没有 url（后端契约），滑块过了之后带 captchaVerifyParam 二次调用才拿到授权地址。
 * 结果从 SDK 的验证回调里才成立，所以整段包成一个 promise 交给 beginOauth 收尾
 */
async function beginAutoClawIntlLogin(): Promise<OauthBeginResult> {
  const first = await api.proxyOauthBegin("autoclaw_intl", oauthOpts("autoclaw_intl"));
  if (!first.needCaptcha) return first; // 上游把滑块关了：这一跳就是最终结果
  const cfg = first.captcha;
  if (!cfg) return { ok: false, message: "上游未返回滑块配置，请重新发起或改用「粘贴 JSON」导入" };
  await loadAliyunCaptcha(cfg.region, cfg.prefix);
  const w = window as unknown as AliyunCaptchaWindow;
  if (typeof w.initAliyunCaptcha !== "function") {
    return { ok: false, message: "滑块组件未就绪（脚本被网络或策略拦下），请检查网络后重试" };
  }
  oauthMsg.value = CAPTCHA_WAIT_MSG;
  return new Promise<OauthBeginResult>((resolve) => {
    let settled = false;
    let lastErr = ""; // 滑块可原地重拖，失败先记着，等超时或用户放弃再一次性报出来
    const finish = (r: OauthBeginResult) => {
      if (settled) return;
      settled = true;
      if (aclawCaptchaTimer) { clearTimeout(aclawCaptchaTimer); aclawCaptchaTimer = undefined; }
      resolve(r);
    };
    // 重复发起前清掉上一次的验证码 DOM：同一容器里 init 两次会叠出两层滑块
    const mount = document.getElementById("aliyun-captcha-element");
    if (mount) mount.innerHTML = "";
    w.initAliyunCaptcha!({
      SceneId: cfg.sceneId,
      mode: "popup",
      element: "#aliyun-captcha-element",
      button: "#aliyun-captcha-trigger", // popup 模式必须有触发按钮，SDK 只认这个元素的点击，漏了滑块弹不出来
      slideStyle: { width: 360, height: 40 },
      language: "cn",
      captchaVerifyCallback: async (param: string) => {
        try {
          const second = await api.proxyOauthBegin("autoclaw_intl", { vendor: aclawVendor.value, captchaVerifyParam: param });
          if (second.ok) finish(second);
          else lastErr = second.message || "获取授权地址失败";
          // 两个 result 都为 true SDK 才收起滑块；失败就留着让用户原地再拖一次
          return { captchaResult: !!second.ok, bizResult: !!second.ok };
        } catch (e) {
          lastErr = String((e as Error).message || e);
          return { captchaResult: false, bizResult: false };
        }
      },
      onBizResultCallback: () => {}, // SDK 要求的收尾回调：业务结果已由上面的 resolve 路径处理，这里不重复做事
      getInstance: (inst) => { aclawInstance = inst || null; },
      onError: (err) => {
        const code = err && typeof err === "object" ? String((err as { code?: unknown }).code ?? "") : String(err ?? "");
        finish({ ok: false, message: `滑块组件异常${code ? `（${code}）` : ""}，请重试或改用「粘贴 JSON」导入 token` });
      },
    });
    // 初始化后至少等 2.1s 再点触发按钮，弹层才出得来（参考项目实测的 SDK 时序要求）
    setTimeout(() => (document.getElementById("aliyun-captcha-trigger") as HTMLButtonElement | null)?.click(), 2100);
    aclawCaptchaTimer = window.setTimeout(
      () => finish({ ok: false, message: lastErr || "滑块验证未完成（2 分钟超时或已关闭），请重新发起" }),
      ACLAW_CAPTCHA_TIMEOUT_MS
    );
  });
}

async function cancelOauth() {
  oauthRun++; // 进行中的发起视为作废：结果回来也不再改 UI，只把这一次的前端等待收掉
  if (aclawCaptchaTimer) { clearTimeout(aclawCaptchaTimer); aclawCaptchaTimer = undefined; }
  aclawInstance?.hide?.();
  aclawInstance = null;
  await api.proxyOauthCancel().catch(() => {});
  oauthBusy.value = false;
  oauthWaiting.value = false;
  oauthErr.value = false;
  oauthMsg.value = "";
  oauthMode.value = "";
  oauthUserCode.value = "";
}

/** 兜底：把浏览器地址栏内容整段粘回来完成登录（仅回环模式用得上） */
async function submitCallback() {
  if (callbackBusy.value || !callbackInput.value.trim()) return;
  callbackBusy.value = true;
  callbackMsg.value = "";
  try {
    const r = await api.proxyOauthSubmitCallback(addChannel.value, callbackInput.value.trim());
    callbackMsg.value = r.ok ? "已提交，正在换取凭据…" : r.message || "提交失败";
    if (r.ok) callbackInput.value = "";
  } catch (e) {
    callbackMsg.value = String((e as Error).message || e);
  } finally {
    callbackBusy.value = false;
  }
}

// ===== 从本机软件导入（本机已登录的客户端里直接取凭据） =====

async function loadScan() {
  if (scanBusy.value) return;
  scanBusy.value = true;
  scanErr.value = false;
  try {
    scanList.value = await api.proxyScan();
    scanMsg.value = scanList.value.length ? `发现 ${scanList.value.length} 个候选登录态` : "未在本机发现可导入的登录态";
  } catch (e) {
    scanErr.value = true;
    scanMsg.value = String((e as Error).message || e);
  } finally {
    scanBusy.value = false;
  }
}

/** 候选排序与过滤：只显示当前渠道的（各渠道各自管理本机登录态，不混在一起） */
const scanRows = computed(() =>
  scanList.value
    .filter((c) => c.channel === addChannel.value)
    .sort((a, b) => {
      if (a.imported !== b.imported) return a.imported ? 1 : -1;
      return 0;
    })
);

const scanKey = (c: ProxyScanCandidate) => `${c.channel}:${c.file}`;

/**
 * 导入单个候选。下标只在"当下这一份列表"里有意义，主进程还会按 file/uid 复核一次；
 * 一键导入时列表会被重新扫描整体替换，所以这里不依赖旧下标，始终以 file/uid 为准
 */
async function importScan(c: ProxyScanCandidate, opts?: { silent?: boolean }) {
  if (scanImporting.value) return;
  scanImporting.value = scanKey(c);
  if (!opts?.silent) scanErr.value = false;
  try {
    const idx = scanList.value.indexOf(c);
    const r = await api.proxyScanImport(idx, c.channel, c.file, c.uid);
    scanMsg.value = r.message || (r.updated ? "已更新该账号凭据" : "已加入号池");
    if (!opts?.silent) {
      await loadScan();
      await refresh();
    }
    return r.ok;
  } catch (e) {
    scanErr.value = true;
    scanMsg.value = String((e as Error).message || e);
    return false;
  } finally {
    scanImporting.value = "";
  }
}

/** 一键导入全部可用候选（加密 / 已导入的跳过），跑完只刷新一次 */
async function importAllScan() {
  const targets = scanRows.value.filter((c) => !c.encrypted && !c.imported);
  if (!targets.length) {
    scanErr.value = true;
    scanMsg.value = "没有可导入的候选（已全部导入或不含可用凭据）";
    return;
  }
  let okCount = 0;
  for (const c of targets) {
    if (await importScan(c, { silent: true })) okCount++;
  }
  scanMsg.value = `已导入 ${okCount} 个账号`;
  await loadScan();
  await refresh();
}

// 粘贴 JSON：文本进主进程统一解析（单对象 / 数组 / {accounts:[]} 均可）
async function doPasteJson() {
  if (pasteBusy.value || !pasteJson.value.trim()) return;
  pasteBusy.value = true;
  pasteMsg.value = "";
  try {
    const r = await api.proxyAccountImportJson(addChannel.value, pasteJson.value);
    pasteErr.value = !r.ok;
    pasteMsg.value = r.message || (r.ok ? "导入完成" : "导入失败");
    if (r.ok) {
      await refresh();
      if ((r.added ?? 0) > 0) pasteJson.value = ""; // 有入账才清空，全失败时保留现场便于改
    }
  } catch (e) {
    pasteErr.value = true;
    pasteMsg.value = String((e as Error).message || e);
  } finally {
    pasteBusy.value = false;
  }
}

// 从 JSON/ZIP 文件添加：主进程弹文件框，zip 取包内全部 .json 合并导入
async function doImportFile() {
  if (fileBusy.value) return;
  fileBusy.value = true;
  fileMsg.value = "";
  try {
    const r = await api.proxyAccountImportFile(addChannel.value);
    if (r.canceled) return; // 用户取消选择，不留痕迹
    fileErr.value = !r.ok;
    fileMsg.value = r.message || (r.ok ? "导入完成" : "导入失败");
    if (r.ok) await refresh();
  } catch (e) {
    fileErr.value = true;
    fileMsg.value = String((e as Error).message || e);
  } finally {
    fileBusy.value = false;
  }
}

/** 本页是否处于前台：v-show 保活的页面切走后，秒级 tick 与事件全量刷新都应停掉，
    不能在后台空烧主线程拖累前台页的鼠标跟手度 */
const active = computed(() => app.activeModule === "proxy" && app.activePage === "agents");
watch(active, (on) => {
  if (!on) return;
  now.value = Date.now(); // 切回来先校准时钟，冷却倒计时才不会停在旧读数
  refresh();
});

// ===== 冷却剩余时间（秒级跳动：一个定时器驱动全表，冷却多为 1min~6h，秒级粒度直观） =====
const now = ref(Date.now());
let nowTimer: number | undefined;
/** 只有存在未到期的 cooling 账号时才值得每秒跳数：now 不更新，ref 不变，全表不 patch */
function tickNow() {
  if (!active.value) return;
  const ch = pool.value.find((c) => c.id === activeChannel.value);
  if (ch?.accounts.some((a) => a.status === "cooling" && a.coolUntil)) now.value = Date.now();
}
function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}
/** cooling 状态且未到期的剩余时长；其余状态返回空（不展示） */
function coolLeft(acc: ProxyAccount): string {
  if (acc.status !== "cooling" || !acc.coolUntil) return "";
  return acc.coolUntil > now.value ? fmtLeft(acc.coolUntil - now.value) : "";
}
/** 模型级负缓存（6004/11102 不落账号状态）的剩余时长：取最早到期的模型；无则空 */
function modelCoolLeft(acc: ProxyAccount): string {
  const list = (acc.modelCool || []).filter((m) => m.until > now.value);
  if (!list.length) return "";
  return fmtLeft(Math.min(...list.map((m) => m.until)) - now.value);
}
/** 悬浮明细：逐条列出被冷却的模型与原因 */
function modelCoolTitle(acc: ProxyAccount): string {
  return (acc.modelCool || [])
    .map((m) => `${m.model}：${m.reason || "模型级冷却"}，至 ${fmtClock(m.until)}`)
    .join("\n");
}
/** 气泡里展示的绝对时间点（HH:mm:ss） */
function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

// ===== UID 查看（列表副行只显示缩略，点击弹小窗看全文 + 复制） =====
const uidRow = ref<ProxyAccount | null>(null);
const uidCopied = ref(false);
/** 列表副行的 UID 缩略：过长截断，全文在弹窗里看 */
function uidBrief(uid: string): string {
  return uid.length > 14 ? `${uid.slice(0, 14)}…` : uid;
}
async function copyUid() {
  if (!uidRow.value?.uid) return;
  try {
    await navigator.clipboard.writeText(uidRow.value.uid);
    uidCopied.value = true;
    setTimeout(() => (uidCopied.value = false), 1600);
  } catch {
    toast("复制失败，请手动选择复制", "err");
  }
}

// ===== 最近错误小窗（点击状态标签弹出）：只展示错误全文本身，液态玻璃小卡 =====
const errRow = ref<ProxyAccount | null>(null);
const errCopied = ref(false);
async function copyErr() {
  if (!errRow.value?.lastError) return;
  try {
    await navigator.clipboard.writeText(errRow.value.lastError.message);
    errCopied.value = true;
    setTimeout(() => (errCopied.value = false), 1600);
  } catch {
    toast("复制失败，请手动选择复制", "err");
  }
}

// ===== 事件订阅与生命周期 =====

// 事件合流：批量签到/额度刷新时主进程逐账号广播 credits 事件，逐条全量 refresh 会打满 IPC
// （事件风暴 → 刷新风暴）；合流后同刻只在跑一次、间隔内合并为末尾一次
const scheduleRefresh = coalesceAsync(refresh, 1200);

onMounted(() => {
  nowTimer = window.setInterval(tickNow, 1000);
  refresh();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string; ok?: boolean; message?: string; channel?: string };
    if (p.event !== "proxy") return;
    if (p.type === "oauth-done") {
      oauthRun++; // 会话已由后端收尾：还挂着的滑块等待不再二次改写界面
      if (aclawCaptchaTimer) { clearTimeout(aclawCaptchaTimer); aclawCaptchaTimer = undefined; }
      oauthBusy.value = false;
      oauthWaiting.value = false;
      oauthMode.value = "";
      oauthUserCode.value = "";
      oauthErr.value = !p.ok;
      oauthMsg.value = p.ok ? "登录成功，已加入号池（已自动签到）" : `登录失败：${p.message || ""}`;
      if (p.ok) {
        addOpen.value = false;
        refresh();
      }
    } else if (p.type === "credits" || p.type === "status") {
      if (active.value) scheduleRefresh(); // 页面不在前台就不拉不渲染，切回时 watch(active) 会补一次
    }
  });
});
onUnmounted(() => {
  if (offEvent) offEvent();
  scheduleRefresh.cancel();
  if (nowTimer) clearInterval(nowTimer);
  if (aclawCaptchaTimer) clearTimeout(aclawCaptchaTimer); // 滑块等待定时器别留到页面销毁之后
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <!-- 渠道主按钮：五个渠道卡片；只留名称，第二行显示 1/1 可用 -->
      <div class="channel-switch">
        <button
          v-for="ch in pool"
          :key="ch.id"
          class="channel-btn"
          :class="{ active: activeChannel === ch.id }"
          @click="activeChannel = ch.id"
        >
          <span class="ch-text">
            <span class="ch-name">{{ ch.display }}</span>
            <span class="ch-hint">{{ metaOf(ch).hint }}</span>
          </span>
          <span class="ch-badge" :class="{ ok: ch.summary.onlineCount > 0 }">
            {{ ch.summary.accountCount ? `${ch.summary.onlineCount}/${ch.summary.accountCount} 可用` : "空号池" }}

          </span>
        </button>
      </div>
      <template v-for="ch in pool" :key="ch.id">
      <div v-if="ch.id === activeChannel" class="card channel-panel" style="margin-bottom: 12px">
        <div class="card-title">
          <i class="ph" :class="metaOf(ch).icon"></i>
          {{ ch.display }}
          <span class="tag" :class="ch.summary.onlineCount > 0 ? 'tag-ok' : 'tag-dim'">
            {{ ch.summary.accountCount ? `${ch.summary.onlineCount}/${ch.summary.accountCount} 可用` : "空号池" }}
          </span>
          <span v-if="ch.summary.expired" class="tag tag-err">有账号已过期</span>
          <!-- 文案跟随 expiringSoonDays 阈值（默认 7 天，与后端 poolSummary/expiresBadge 同源），别写死 24h -->
          <span v-else-if="ch.summary.expiringSoon" class="tag tag-warn">{{ app.config.proxy.expiringSoonDays ?? 7 }} 天内有到期</span>
          <!-- 工具栏：只属于当前渠道（策略 / 添加 / 签到或加油包 / 刷新），与其他渠道互不关联 -->
          <span class="panel-tools">
            <select
              class="f-select strategy-select"
              :value="ch.poolStrategy"
              @change="setStrategy(ch, ($event.target as HTMLSelectElement).value as ProxyPoolStrategy)"
            >
              <option v-for="s in STRATEGIES" :key="s.value" :value="s.value">{{ s.label }}</option>
            </select>
            <button class="btn btn-sm" @click="openAdd(ch)">{{ isBuiltin(ch) ? "添加账号" : "管理 Key" }}</button>
            <!-- 签到 / 加油包 / 额度刷新都是生态渠道专属动作：自定义提供商只有一把 API Key，
                 既没有每日签到可领，也没有余额可查（主进程一律明确拒答，不该在界面上摆出来） -->
            <template v-if="isBuiltin(ch)">
              <button
                v-if="ch.id === 'workbuddy_ai'"
                class="btn btn-sm"
                :disabled="checkinBusy"
                :title="'国际版无每日签到，这是一次性 trial 加油包'"
                @click="runTrial"
              >{{ checkinBusy ? "领取中…" : "领加油包" }}</button>
              <button
                v-else-if="ch.id === 'zcode' && zcodeHasReward"
                class="btn btn-sm"
                :disabled="checkinBusy"
                :title="'领取当前可领的奖励套餐（周末包等）；需要人机校验时会弹官方验证窗'"
                @click="runCheckinChannel"
              >{{ checkinBusy ? "领取中…" : "一键领取" }}</button>
              <button v-else-if="checkinCapable(ch.id)" class="btn btn-sm" :disabled="checkinBusy" @click="runCheckinChannel">
                {{ checkinBusy ? "签到中…" : "一键签到" }}
              </button>
              <button
                v-if="ch.id === 'zcode'"
                class="btn btn-sm"
                :class="{ 'btn-warning': devHasIssue }"
                :disabled="devBusy"
                title="设备指纹（deviceMid）诊断与修复：多账号共用同一枚指纹时，一个账号领取周末套餐会把全组账号的当周资格烧掉（服务端提示「不符合领取条件」/1004）。修复即给这些账号重派全新随机指纹"
                @click="openDeviceDiag"
              >{{ devBusy ? "检测中…" : devHasIssue ? "指纹异常" : "指纹诊断" }}</button>
              <button
                v-if="ch.id === 'zcode' && devClaimMode"
                class="btn btn-sm btn-warning"
                :disabled="devBusy"
                title="本机指纹当前借出给某账号领周末套餐（领取模式），手机远程连接不可用；点击写回本机锚定指纹并重启客户端，远程即恢复"
                @click="restoreRemoteMid"
              >{{ devBusy ? "恢复中…" : "恢复本机指纹" }}</button>
              <button
                v-if="ch.id === 'zcode' || ch.id === 'zcode_intl'"
                class="btn btn-sm"
                title="切号出问题或移动端远程连接异常时，一键还原到最近一次切换前的状态"
                @click="zcodeRollback"
              >切号回滚</button>
              <button class="btn btn-sm btn-primary" :disabled="refreshingChannel" @click="refreshCurrentChannel">
                {{ refreshingChannel ? "刷新中…" : "刷新" }}
              </button>
            </template>

          </span>
        </div>
        <!-- 聚合顶部（单一数据源实时推导） -->
        <div class="agg">
          <!-- 提供商没有余额与到期概念（API Key 不设额度、不过期）：硬显示 0 会被读成「余额不足」，
               而这三项对生态渠道是真信息，所以按 kind 隐藏而不是换成假数据 -->
          <div v-if="isBuiltin(ch)" class="agg-item">
            <span>总余额</span>
            <b :title="ch.id === 'zcode' || ch.id === 'zcode_intl' ? `${fmtInt(ch.summary.totalCredits)} Tokens` : ''">{{ fmtBalance(ch.summary.totalCredits, ch.id) }}</b>
            <span v-if="ch.id === 'zcode' || ch.id === 'zcode_intl'" style="font-size: 11px; font-weight: normal; color: var(--text-3); margin-left: 2px">Tokens</span>
          </div>
          <div class="agg-item"><span>{{ isBuiltin(ch) ? "账号数" : "Key 数" }}</span><b>{{ ch.summary.accountCount }}</b></div>

          <div class="agg-item"><span>可用</span><b>{{ ch.summary.onlineCount }}</b></div>
          <div v-if="isBuiltin(ch)" class="agg-item"><span>最早到期</span><b>{{ ch.summary.earliestExpire ? fmtDate(ch.summary.earliestExpire) : "-" }}</b></div>
          <div class="agg-item"><span>今日消耗</span><b>{{ ch.summary.todayReq }} 次 · {{ fmtK(ch.summary.todayTokens) }}</b></div>
          <div v-if="isBuiltin(ch)" class="agg-item"><span>上次刷新</span><b>{{ fmtAgo(ch.summary.lastCreditsAt) }}</b></div>
        </div>
        <!-- 账号明细：6 列两行式布局 —— 账号列首行为名称、副行是来源与 UID（点击看全文）；
             状态列点击弹液态玻璃小窗（只显最近一次上游错误全文），冷却剩余时间直接在列表里秒级跳动 -->
        <div class="tbl-wrap" style="margin-top: 8px">
          <table class="tbl pool-tbl">
            <tbody>
              <tr>
                <th>账号</th><th>状态</th>
                <template v-if="isBuiltin(ch)"><th>余额</th><th>到期</th></template>
                <th>今日</th><th>操作</th>
              </tr>
              <template v-for="(acc, i) in ch.accounts" :key="acc.id">
              <tr :style="{ '--i': i }">
                <td class="acc-cell">
                  <button
                    v-if="isBuiltin(ch) && acc.packages && acc.packages.length"
                    class="pkg-caret"
                    :class="{ open: expandedIds.has(acc.id) }"
                    :title="expandedIds.has(acc.id) ? '收起积分包明细' : '展开积分包明细'"
                    @click="togglePkg(acc.id)"
                  ><i class="ph ph-caret-right" /></button>
                  <span v-if="renamingId !== acc.id" class="acc-name" :title="acc.name + '（点击重命名）'" @click="startRename(acc)">{{ acc.name || "（未命名账号）" }}</span>
                  <input
                    v-else
                    v-model="renameText"
                    class="input input-xs"
                    style="width: 120px"
                    @blur="commitRename(acc)"
                    @keydown.enter="commitRename(acc)"
                    @keydown.esc="renamingId = ''"
                  />
                  <span class="acc-sub">
                    <span class="acc-src">{{ SOURCE_NAMES[acc.source] || acc.source }}</span>
                    <i>·</i>
                    <button class="acc-uid mono" :disabled="!acc.uid" title="点击查看完整 UID" @click="uidRow = acc">
                      {{ acc.uid ? uidBrief(acc.uid) : "无 UID" }}
                    </button>
                    <template v-if="acc.liveHere">
                      <i>·</i>
                      <span class="tag tag-info acc-live" :title="`${ch.display} 客户端在本机当前登录的就是这个账号`"><i class="ph ph-desktop-tower"></i>本机登录</span>
                    </template>
                  </span>
                </td>
                <td>
                  <!-- 状态标签：有最近错误的账号可点击，弹小窗看错误全文 -->
                  <span
                    class="tag status-tag"
                    :class="[isNeedCaptcha(acc) ? 'tag-warn' : ACCOUNT_STATUS[acc.status]?.cls || 'tag-dim', { 'has-err': !!acc.lastError }]"
                    :title="acc.lastError ? '点击查看最近一次上游错误' : ''"
                    @click="acc.lastError && (errRow = acc)"
                  >
                    {{ isNeedCaptcha(acc) ? "需过码" : (ACCOUNT_STATUS[acc.status]?.text || acc.status) }}
                  </span>
                  <!-- 冷却剩余时间：秒级跳动，到点自动归零消失（状态派生在主进程惰性完成） -->
                  <span v-if="coolLeft(acc)" class="cool-left mono">剩 {{ coolLeft(acc) }}</span>
                  <!-- 模型级冷却（6004/11102 不落账号状态）：悬浮看逐模型明细 -->
                  <span v-if="modelCoolLeft(acc)" class="cool-left mono" :title="modelCoolTitle(acc)">模型冷却剩 {{ modelCoolLeft(acc) }}</span>
                </td>
                <template v-if="isBuiltin(ch)">
                  <td class="mono num" :title="acc.channel === 'zcode' && acc.credits > 0 ? `${fmtInt(acc.credits)} Tokens` : ''">{{ acc.hasToken ? (acc.credits === -1 ? "不限" : fmtBalance(acc.credits, acc.channel)) : "-" }}</td>
                  <td class="mono">{{ acc.expiresAt ? fmtDate(acc.expiresAt) : "-" }}</td>
                </template>
                <td class="mono num">{{ acc.todayReq }} 次 · {{ fmtK(acc.todayTokens) }} · {{ acc.creditsToday < 0 ? "-" : fmtInt(acc.creditsToday) }} 积分</td>
                <td>
                  <!-- 单行「刷新」= 查一次余额，对只有 API Key 的提供商没有对象（主进程会明确拒答），故隐藏 -->
                  <button v-if="isBuiltin(ch)" class="btn-link btn-sm" :disabled="refreshingId === acc.id" @click="refreshOne(acc)">
                    {{ refreshingId === acc.id ? "刷新中…" : "刷新" }}
                  </button>
                  <button
                    v-if="acc.hasToken && isBuiltin(ch) && (checkinCapable(acc.channel) || acc.channel === 'zcode')"
                    class="btn-link btn-sm"
                    :disabled="checkinBusy"
                    :title="acc.channel === 'workbuddy_ai' ? '国际版无每日签到，用上方工具栏「领加油包」' : acc.channel === 'raccoon' ? '登录送积分（幂等，锁定当日积分 7 天）' : acc.channel === 'zcode' ? '领取当前可领的奖励套餐（如需人机校验会弹官方验证窗）' : '对该账号执行每日签到'"
                    @click="runCheckinAccount(acc)"
                  >
                    {{ acc.channel === "zcode" ? "领取" : "签到" }}
                  </button>
                  <button
                    v-if="acc.channel === 'zcode'"
                    class="btn-link btn-sm"
                    :class="{ 'btn-captcha-warn': isNeedCaptcha(acc) }"
                    :disabled="solvingCaptchaId === acc.id"
                    :title="isNeedCaptcha(acc) ? '触发了上游阿里云人机校验，点击弹出验证码窗口进行过码' : '手动完成一次阿里云人机校验以刷新上游风控信誉'"
                    @click="runSolveCaptcha(acc)"
                  >
                    {{ solvingCaptchaId === acc.id ? "过码中…" : (isNeedCaptcha(acc) ? "需过码" : "过码") }}
                  </button>
                  <button
                    v-if="acc.channel === 'zcode'"
                    class="btn-link btn-sm"
                    :disabled="ideSwitching === acc.id"
                    title="领取模式（人工操作）：把本机指纹临时借出为该账号专属指纹并重启客户端，之后在官方客户端里点「限时可领取」人工领取周末套餐；领完回工具栏点「恢复本机指纹」。期间手机远程不可用"
                    @click="enterClaimMode(acc)"
                  >
                    {{ ideSwitching === acc.id ? "处理中…" : "领取模式" }}
                  </button>
                  <button
                    v-if="isBuiltin(ch)"
                    class="btn-link btn-sm"
                    :disabled="ideSwitching === acc.id || !ideSupported(acc)"
                    :title="ideTitle(acc)"
                    @click="ideSwitch(acc)"
                  >
                    {{ ideSwitching === acc.id ? "切换中…" : "切到 IDE" }}
                  </button>
                  <button
                    v-if="acc.status === 'cooling' || (acc.modelCool && acc.modelCool.length)"
                    class="btn-link btn-sm"
                    :disabled="coolOffId === acc.id"
                    :title="acc.status === 'cooling'
                      ? '立即结束冷却，账号马上回到可用调度（同时豁免其模型级冷却）'
                      : '该账号部分模型在冷却中（6004 限流/11102 不支持），解除后这些模型立即恢复可用'"
                    @click="releaseCool(acc)"
                  >
                    {{ coolOffId === acc.id ? "解除中…" : "解冷却" }}
                  </button>
                  <button class="btn-link btn-sm" @click="toggleAccount(acc)">{{ acc.status === "disabled" ? "启用" : "停用" }}</button>
                  <button class="btn-link btn-sm danger" @click="delRow = acc; delOpen = true">移出</button>
                </td>
              </tr>
              <!-- 展开：该账号逐积分包明细（Q6）—— 包名 / 已用 / 总额 / 剩余 / 到期 / 剩余天数 / 状态 + 进度条 -->
              <tr v-if="isBuiltin(ch) && expandedIds.has(acc.id) && acc.packages && acc.packages.length" class="pkg-row" :key="acc.id + '-pkg'">
                <td :colspan="isBuiltin(ch) ? 6 : 4" class="pkg-cell">
                  <table class="pkg-tbl">
                    <tbody>
                      <tr>
                        <th>积分包</th><th>已用</th><th>总额</th><th>剩余</th><th>到期</th><th>剩余天数</th><th>状态</th>
                      </tr>
                      <tr v-for="(pkg, pi) in acc.packages" :key="pkg.code || pi">
                        <td class="pkg-name" :title="pkg.name">
                          {{ pkg.name || "积分包" }}
                          <div v-if="pkg.total > 0" class="pkg-bar" :title="`已用 ${fmtInt(pkg.used)} / 总额 ${fmtInt(pkg.total)}`">
                            <span class="pkg-bar-used" :style="{ width: pkgUsedPct(pkg) + '%' }" />
                          </div>
                        </td>
                        <td class="mono num">{{ pkg.used === -1 ? "不限" : fmtInt(pkg.used) }}</td>
                        <td class="mono num">{{ pkg.total === -1 ? "不限" : fmtInt(pkg.total) }}</td>
                        <td class="mono num">{{ pkg.remaining === -1 ? "不限" : fmtInt(pkg.remaining) }}</td>
                        <td class="mono">{{ pkg.expiresAt ? fmtDate(pkg.expiresAt) : "长期" }}</td>
                        <td class="mono num">{{ pkgDaysText(pkg) }}</td>
                        <td><span class="tag" :class="pkgStatusCls(pkg)">{{ pkgStatusText(pkg) }}</span></td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>
              <!-- 已刷新过但无包 / 尚未刷新：给一句可操作提示（builtin 且有 token） -->
              <tr v-else-if="isBuiltin(ch) && acc.hasToken && (!acc.packages || !acc.packages.length)" class="pkg-hint-row" :key="acc.id + '-hint'">
                <td :colspan="6" class="pkg-hint">未刷新，点「刷新」获取积分包明细</td>
              </tr>
              </template>
              <tr v-if="!ch.accounts.length">
                <td colspan="6" style="text-align: center; color: var(--text-3); padding: 14px">

                  号池为空 —— 点「添加账号」：OAuth 登录 / 从本机软件导入 / 文件导入 / 手动粘贴
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      </template>
    </div>

    <!-- 添加账号弹窗（三方式：OAuth 登录 / 从 JSON/ZIP 文件 / 粘贴 JSON） -->
    <Teleport to="body">
      <div v-if="addOpen" class="p-mask" @click.self="closeAdd()">
        <div class="p-dlg glass add-dlg" role="dialog" aria-modal="true" aria-label="添加账号">
          <!-- 头部：图标 + 标题 + 入池渠道 + 关闭 -->
          <header class="add-head">
            <span class="add-head-icon"><i class="ph ph-user-plus"></i></span>
            <div class="add-head-text">
              <div class="add-title">
                添加账号
                <span class="add-chip">{{ pool.find((c) => c.id === addChannel)?.display || addChannel }}</span>
              </div>
              <div class="add-sub">凭据仅本机 DPAPI 加密保管，不入日志、不外发</div>
            </div>
            <button class="add-close" title="关闭" @click="closeAdd()"><i class="ph ph-x"></i></button>
          </header>

          <!-- 方式切换：分段控件 -->
          <div class="add-tabs">
            <button
              v-for="t in METHOD_TABS"
              :key="t.key"
              class="add-tab"
              :class="{ active: addMethod === t.key, disabled: (oauthWaiting || oauthBusy) && addMethod === 'oauth' && t.key !== 'oauth' }"
              @click="switchMethod(t.key)"
            >
              <i class="ph" :class="t.icon"></i>{{ t.label }}
            </button>
          </div>

          <!-- 方式内容：各面板共用固定高度，切换时弹窗不跳高度 -->
          <div class="add-body">
            <!-- OAuth 官方登录（各渠道登录形态不同：回环 / 轮询 / 设备码 / 滑块+回调） -->
            <div v-if="addMethod === 'oauth'" class="add-pane center">
              <div class="add-pane-icon"><i class="ph ph-key"></i></div>
              <div class="add-pane-title">{{ OAUTH_HELP[addChannel]?.title || "用官方登录页登录" }}</div>
              <div class="add-pane-desc" v-html="OAUTH_HELP[addChannel]?.desc || ''"></div>
              <!-- qoder 区服切换：国际版与中国版是两套域名与账号体系，登录参数直接决定回调到哪个 openapi -->
              <el-radio-group
                v-if="addChannel === 'qoder'"
                v-model="qoderEdition"
                size="small"
                class="oauth-radio-row"
                :disabled="oauthWaiting || oauthBusy"
              >
                <el-radio-button value="intl">国际版</el-radio-button>
                <el-radio-button value="cn">中国版</el-radio-button>
              </el-radio-group>
              <!-- AutoClaw 国际版的两个上游：滑块通过后按这个 vendor 换授权地址 -->
              <el-radio-group
                v-if="addChannel === 'autoclaw_intl'"
                v-model="aclawVendor"
                size="small"
                class="oauth-radio-row"
                :disabled="oauthWaiting || oauthBusy"
              >
                <el-radio-button value="zai">Zai 账号</el-radio-button>
                <el-radio-button value="google">Google 账号</el-radio-button>
              </el-radio-group>
              <!-- 设备码：授权页 URL 一般已自动带上（verification_uri_complete），没带上就照这里手输 -->
              <div v-if="oauthMode === 'device' && oauthUserCode" class="oauth-code-row">
                <span>如页面未自动带上验证码，请手动输入：</span>
                <code class="oauth-user-code">{{ oauthUserCode }}</code>
              </div>
              <!-- 回环模式兜底 + 手动粘贴模式主操作：整段粘贴回调地址 -->
              <div v-if="(oauthMode === 'loopback' || oauthMode === 'manual' || oauthMode === 'window' || addChannel === 'zcode' || addChannel === 'zcode_intl') && oauthWaiting" class="cb-row">

                <input
                  v-model="callbackInput"
                  class="input"
                  style="flex: 1"
                  :placeholder="addChannel === 'raccoon' ? '授权窗没自动完成？把 office-raccoon://auth/callback?code=… 整段粘到这里' : addChannel === 'zcode' ? '授权完成后一般无需操作；若停在回调页，把地址栏整段粘到这里（zcode://…）' : '浏览器没跳回？把地址栏整段粘到这里'"
                />
                <button class="btn btn-sm" :disabled="!callbackInput.trim() || callbackBusy" @click="submitCallback">
                  {{ callbackBusy ? "提交中…" : "提交" }}
                </button>
              </div>
              <div v-if="callbackMsg" class="add-msg">{{ callbackMsg }}</div>
              <div v-if="oauthMsg" class="add-msg" :class="{ err: oauthErr }">{{ oauthMsg }}</div>
              <!-- 粘贴窗口被遮挡时 SDK 会把弹层转成内嵌滑块，就地渲染在这行下面 -->
              <div id="aliyun-captcha-element" class="captcha-mount"></div>
              <button id="aliyun-captcha-trigger" class="captcha-trigger" type="button" aria-hidden="true" tabindex="-1"></button>
            </div>

            <!-- 从本机软件导入：读本机已登录客户端的凭据，零请求入池 -->
            <div v-else-if="addMethod === 'local'" class="add-pane">
              <div class="scan-head">
                <span class="scan-hint">读取本机已登录客户端的登录态，凭据不出本机</span>
                <button class="btn btn-sm" :disabled="scanBusy" @click="loadScan">{{ scanBusy ? "扫描中…" : "重新扫描" }}</button>
                <button class="btn btn-sm" :disabled="scanBusy || !scanRows.length" @click="importAllScan">全部导入</button>
              </div>
              <div class="scan-list">
                <div v-for="(c, i) in scanRows" :key="`${c.channel}-${c.uid || i}`" class="scan-row" :class="{ dim: c.imported || c.encrypted }">
                  <div class="scan-main">
                    <div class="scan-name">
                      {{ c.name || c.uid || "（未识别账号）" }}
                      <span v-if="c.imported" class="tag tag-ok">已导入</span>
                      <span v-else-if="c.encrypted" class="tag tag-warn">加密不可读</span>
                    </div>
                    <div class="scan-file">{{ c.file }}<template v-if="c.credits"> · 余额 {{ fmtInt(c.credits) }}</template></div>
                  </div>
                  <button
                    class="btn btn-sm"
                    :disabled="c.imported || c.encrypted || !!scanImporting"
                    :title="c.encrypted ? '本机登录态已加密，请改用 OAuth 登录' : ''"
                    @click="importScan(c)"
                  >
                    {{ scanImporting === scanKey(c) ? "导入中…" : c.imported ? "已导入" : "导入" }}
                  </button>
                </div>
                <div v-if="!scanRows.length" class="scan-empty">
                  未在本机发现可导入的登录态 —— 请先在本机登录对应客户端，或改用「OAuth 登录」
                </div>
              </div>
              <div v-if="scanMsg" class="add-msg" :class="{ err: scanErr }">{{ scanMsg }}</div>
            </div>

            <!-- 从 JSON/ZIP 文件添加 -->
            <div v-else-if="addMethod === 'file'" class="add-pane center">
              <div class="add-pane-icon"><i class="ph ph-file-arrow-up"></i></div>
              <div class="add-pane-title">从导出文件批量入池</div>
              <div class="add-pane-desc">
                <span class="mono">.json</span> 支持单对象 / 数组 / <span class="mono">{accounts:[]}</span> 包装；<br />
                <span class="mono">.zip</span> 会读取包内全部 .json 合并导入，同渠道同 UID 自动跳过。
              </div>
              <div v-if="fileMsg" class="add-msg" :class="{ err: fileErr }">{{ fileMsg }}</div>
            </div>

            <!-- 粘贴 JSON -->
            <div v-else class="add-pane paste-pane">
              <div class="paste-label">凭据 JSON</div>
              <div v-if="pasteHint" class="paste-hint">{{ pasteHint }}</div>
              <textarea
                v-model="pasteJson"
                class="input mono paste-area"
                :placeholder="pastePlaceholder"
                spellcheck="false"
              ></textarea>
              <div v-if="pasteMsg" class="add-msg" :class="{ err: pasteErr }">{{ pasteMsg }}</div>
            </div>
          </div>

          <!-- 底部操作：左侧状态/提示，右侧按方式给对应主操作 -->
          <footer class="add-foot">
            <span class="add-foot-hint">
              <template v-if="addMethod === 'oauth' && (oauthBusy || oauthWaiting)"><i class="ph ph-circle-notch"></i>{{ oauthFootHint }}</template>

              <template v-else-if="addMethod === 'local'">导入后仍可刷新余额、切到 IDE 或停用</template>
              <template v-else>入池后可在下方列表里刷新余额、切到 IDE 或停用</template>
            </span>
            <button class="btn" @click="closeAdd()">{{ addMethod === "oauth" && (oauthBusy || oauthWaiting) ? "取消登录" : "取消" }}</button>

            <button
              v-if="addMethod === 'oauth'"
              class="btn btn-cta"
              :disabled="oauthWaiting || oauthBusy"
              @click="beginOauth"
            >{{ oauthCtaLabel }}</button>
            <button
              v-else-if="addMethod === 'file'"
              class="btn btn-cta"
              :disabled="fileBusy"
              @click="doImportFile"
            >{{ fileBusy ? "导入中…" : "选择文件…" }}</button>
            <button
              v-else-if="addMethod === 'paste'"
              class="btn btn-cta"
              :disabled="!pasteJson.trim() || pasteBusy"
              @click="doPasteJson"
            >{{ pasteBusy ? "导入中…" : "解析并加入号池" }}</button>
            <button
              v-else
              class="btn btn-cta"
              :disabled="scanBusy || !scanRows.some((c) => !c.imported && !c.encrypted)"
              @click="importAllScan"
            >加入号池</button>
          </footer>
        </div>
      </div>

      <!-- 移出确认 -->
      <div v-if="delOpen" class="p-mask" @click.self="delOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">移出号池</div>
          <div class="set-desc">
            确定把「{{ delRow?.name }}」移出号池？本地加密保管的凭据会一并删除，该账号不再参与调度。
          </div>
          <div class="p-actions">
            <button class="btn" @click="delOpen = false">取消</button>
            <button class="btn btn-primary danger-solid" @click="doDelete">移出</button>
          </div>
        </div>
      </div>

      <!-- 切号确认：预检事实（客户端是否在跑 / 安装路径 / 切完是否自动重启）先给用户过目再动手 -->
      <div v-if="pendingConfirm" class="p-mask" @click.self="pendingConfirm = null">
        <div class="p-dlg glass">
          <div class="p-title">{{ confirmTitleText }}</div>
          <div class="set-desc">
            {{ pendingConfirm?.message }}<br />
            <template v-if="pendingConfirm?.probe?.note">{{ pendingConfirm.probe.note }}<br /></template>
            <template v-if="pendingConfirm?.kind === 'switch'">切换后流量与奖励归属「{{ pendingConfirm?.name }}」。</template>
          </div>
          <div v-if="pendingConfirm?.probe" class="ide-probe">
            <div class="ide-probe-row">
              <span class="ide-probe-k">客户端状态</span>
              <span class="ide-probe-v">
                <span class="ide-dot" :class="{ on: pendingConfirm.probe.running }"></span>
                {{ pendingConfirm.probe.running ? "正在运行（将先关闭）" : "未运行（直接写入登录态）" }}
              </span>
            </div>
            <div v-if="pendingConfirm.probe.exe" class="ide-probe-row">
              <span class="ide-probe-k">程序路径</span>
              <span class="ide-probe-v mono" :title="pendingConfirm.probe.exe">{{ pendingConfirm.probe.exe }}</span>
            </div>
            <div v-if="pendingConfirm.probe.running" class="ide-probe-row">
              <span class="ide-probe-k">切换完成后</span>
              <span class="ide-probe-v">{{ pendingConfirm.probe.relaunch ? "自动重新打开客户端" : "需要手动打开客户端" }}</span>
            </div>
            <div v-if="pendingConfirm.probe.warning" class="ide-probe-warn">
              <i class="ph ph-warning"></i>{{ pendingConfirm.probe.warning }}
            </div>
          </div>
          <div class="p-actions">
            <button class="btn" @click="pendingConfirm = null">取消</button>
            <button class="btn btn-primary" :disabled="confirmBusy" @click="confirmIdeSwitch">
              {{ confirmBusy ? "切换中…" : confirmActionText }}
            </button>
          </div>
        </div>
      </div>

      <!-- 签到结果弹窗：一键签到 / 单账号签到 / 领加油包跑完即弹，逐账号一行（结果仍按渠道记忆，切渠道互不串扰） -->
      <div v-if="checkinOpen" class="p-mask" @click.self="checkinOpen = false">
        <div class="p-dlg glass checkin-dlg">
          <div class="p-title checkin-head">
            <i class="ph ph-seal-check"></i>
            {{ shownCheckinName }} · 签到结果
            <span class="checkin-stats">
              <span class="tag tag-ok">成功 {{ shownCheckinStats.ok }}</span>
              <span class="tag tag-dim">已签到 {{ shownCheckinStats.already }}</span>
              <span class="tag tag-warn">不开放 {{ shownCheckinStats.unavail }}</span>
              <span class="tag tag-err">失败 {{ shownCheckinStats.fail }}</span>
            </span>
          </div>
          <div class="checkin-rows">
            <div v-for="r in shownCheckin" :key="r.accountId" class="checkin-row">
              <div class="checkin-name">
                {{ r.name || r.uid || r.accountId }}
                <span class="tag" :class="checkinTagCls(r)">{{ checkinTagText(r) }}</span>
              </div>
              <span class="checkin-msg">
                <template v-if="r.credit">+{{ r.credit }} 积分 · </template>
                <template v-if="r.streakDays">连续 {{ r.streakDays }} 天 · </template>
                {{ r.message || "" }}
              </span>
            </div>
            <div v-if="!shownCheckin.length" class="checkin-empty">本次没有需要签到的账号</div>
          </div>
          <div class="p-actions">
            <button class="btn btn-primary" @click="checkinOpen = false">完成</button>
          </div>
        </div>
      </div>

      <!-- ZCode 领取过码弹窗（极简：只承载阿里云滑块挂载点） -->
      <div v-if="zcapOpen" class="p-mask" @click.self="zcapOpen = false">
        <div class="p-dlg glass">
          <div class="p-title"><i class="ph ph-shield-check"></i> 完成人机验证</div>
          <div class="set-desc">验证通过后自动继续领取；关闭弹窗即取消本次领取。</div>
          <div id="zcap-captcha-element" class="captcha-mount"></div>
          <button id="zcap-captcha-trigger" class="captcha-trigger" type="button" aria-hidden="true" tabindex="-1"></button>
        </div>
      </div>

      <!-- 设备指纹诊断弹窗：逐账号列出专属 deviceMid 与冲突状态，
           撞车/疑似被烧的行高亮，一键重派全新随机指纹（1004 的唯一出路） -->
      <div v-if="devDlgOpen" class="p-mask" @click.self="devDlgOpen = false">
        <div class="p-dlg glass checkin-dlg">
          <div class="p-title checkin-head">
            <i class="ph ph-fingerprint"></i>
            设备指纹诊断
            <span class="checkin-stats">
              <span v-if="devClaimMode" class="tag tag-warn">领取模式中 · 远程不可用</span>
              <span class="tag" :class="devHasIssue ? 'tag-warn' : 'tag-ok'">{{ devHasIssue ? "发现异常" : "全部独立" }}</span>
              <span class="tag tag-dim" :title="`本机 telemetry-state.json 当前指纹：${devLiveMid || '（无）'}`">本机指纹 {{ devLiveMid ? devLiveMid.slice(0, 8) : "（无）" }}</span>
              <span class="tag tag-dim" :title="`锚定指纹（远程连接的合法值，终生恒定）：${devAnchorMid || '（未锚定）'}`">锚定 {{ devAnchorMid ? devAnchorMid.slice(0, 8) : "（未锚定）" }}</span>
            </span>
          </div>
          <div class="dev-hint">
            周末套餐领取资格 = 账号本周未领 + 设备指纹本周未被消耗。多个账号共用同一枚指纹时，一个账号领取成功会把全组账号的当周资格烧掉（服务端报「不符合领取条件」）。切号只写登录态、不动指纹；要在官方客户端里领套餐请用账号行的「领取模式」（临时借出指纹 → 人工领取 → 恢复锚定值），AgentHub 内「一键领取」不受影响。以下异常多为存量遗留，修复即给这些账号重派全新随机指纹。
          </div>
          <div class="checkin-rows">
            <div v-for="r in devRows" :key="r.id" class="checkin-row">
              <div class="checkin-name">
                {{ r.name || r.uid || r.id }}
                <span v-if="r.isLive" class="tag tag-info">本机登录</span>
                <span v-if="r.conflictWith.length" class="tag tag-err">与 {{ r.conflictWith.map((x) => devRows[x] ? (devRows[x].name || devRows[x].uid || "另一账号") : "另一账号").join("、") }} 共用指纹</span>
                <span v-else-if="r.burnedLikely" class="tag tag-warn">占用本机指纹</span>
                <span v-else class="tag tag-ok">独立</span>
              </div>
              <span class="checkin-msg mono">指纹 {{ r.short }}<template v-if="r.burnedLikely && r.conflictWith.length"> · 本周资格大概率已被消耗（1004）</template></span>
            </div>
            <div v-if="!devRows.length" class="checkin-empty">号池里还没有 zcode 账号</div>
          </div>
          <div class="p-actions">
            <button class="btn" :disabled="devBusy" @click="runDeviceRepair(true)">{{ devBusy ? "处理中…" : "全部换随机指纹" }}</button>
            <button class="btn btn-primary" :disabled="devBusy || !devHasIssue" @click="runDeviceRepair(false)">{{ devBusy ? "修复中…" : "修复异常指纹" }}</button>
          </div>
        </div>
      </div>

      <!-- UID 查看弹窗：全文展示 + 一键复制（列表副行显示缩略，点击看全文） -->
      <div v-if="uidRow" class="p-mask" @click.self="uidRow = null">
        <div class="p-dlg glass uid-dlg">
          <div class="p-title">账号 UID</div>
          <div class="set-desc">{{ uidRow.name }}（{{ channelName(uidRow.channel) }}）</div>
          <div class="uid-text mono">{{ uidRow.uid || "-" }}</div>
          <div class="p-actions">
            <button class="btn" @click="uidRow = null">关闭</button>
            <button class="btn btn-primary" :disabled="!uidRow.uid" @click="copyUid">{{ uidCopied ? "已复制" : "复制 UID" }}</button>
          </div>
        </div>
      </div>

      <!-- 最近错误小窗：点状态标签弹出，液态玻璃小卡只装错误全文本身（可复制给排查工具） -->
      <div v-if="errRow" class="p-mask" @click.self="errRow = null">
        <div class="p-dlg glass err-dlg">
          <div class="p-title err-head">
            <i class="ph ph-warning-circle"></i>
            最近错误
            <span v-if="errRow.lastError" class="err-time mono">{{ fmtClock(errRow.lastError.at) }}</span>
          </div>
          <div class="err-text mono">{{ errRow.lastError?.message || "（无错误详情）" }}</div>
          <div class="p-actions">
            <button class="btn" @click="errRow = null">关闭</button>
            <button
              v-if="errRow.channel === 'zcode' && isNeedCaptcha(errRow)"
              class="btn btn-warning"
              :disabled="solvingCaptchaId === errRow.id"
              @click="runSolveCaptcha(errRow)"
            >
              {{ solvingCaptchaId === errRow.id ? "正在打开验证窗…" : "立即过码" }}
            </button>
            <button class="btn btn-primary" :disabled="!errRow.lastError" @click="copyErr">{{ errCopied ? "已复制" : "复制错误" }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- Toast 悬浮提示：右上角自动消失（刷新/签到摘要与错误提示都走这里） -->
    <Teleport to="body">
      <div class="toast-host">
        <TransitionGroup name="toast">
          <div v-for="t in toasts" :key="t.id" class="toast-item glass" :class="{ err: t.kind === 'err' }">
            <i class="ph" :class="t.kind === 'err' ? 'ph-warning-circle' : 'ph-check-circle'"></i>
            <span>{{ t.text }}</span>
          </div>
        </TransitionGroup>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
/* ===== Toast 悬浮提示：右上角玻璃小卡，自动消失（替代常驻页面卡片） ===== */
.toast-host {
  position: fixed;
  top: 18px;
  right: 18px;
  z-index: 120; /* 盖过 .p-mask(50)：弹窗内触发的操作提示也要浮在最上层 */
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.toast-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  max-width: 380px;
  padding: 9px 14px;
  border-radius: var(--r-ctl);
  border: 1px solid var(--accent-line);
  font-size: 12px;
  line-height: 1.55;
  color: var(--text);
  word-break: break-all;
  box-shadow: var(--glass-shadow);
}
.toast-item .ph {
  flex-shrink: 0;
  font-size: 14px;
  color: var(--accent-strong);
  margin-top: 1px;
}
.toast-item.err {
  border-color: var(--danger, var(--err, #e05555));
}
.toast-item.err .ph {
  color: var(--danger, var(--err, #e05555));
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.28s var(--ease), transform 0.28s var(--ease);
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(24px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active {
    transition: none;
  }
}
/* ===== 渠道主按钮：三列大按钮，各自独立成区，选中才点亮 ===== */
.channel-switch {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}
.channel-btn {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  padding: 12px 13px;
  border-radius: var(--r-ctl);
  border: 1px solid var(--line);
  background: var(--bg-soft);
  color: var(--text-2);
  font-family: var(--font-ui);
  text-align: left;
  cursor: pointer;
  overflow: hidden;
  transition: border-color 0.22s, color 0.22s, background 0.22s, transform 0.28s var(--ease-spring), box-shadow 0.25s;
}
/* 底部光条：选中时从中间向两侧展开，作为"当前渠道"的指示锚点 */
.channel-btn::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: 0;
  width: 0;
  height: 2px;
  border-radius: var(--r-pill);
  background: var(--accent);
  box-shadow: 0 0 10px var(--accent);
  transform: translateX(-50%);
  transition: width 0.3s var(--ease);
}
.channel-btn:hover {
  color: var(--text);
  border-color: var(--line-strong);
  transform: translateY(-2px);
  box-shadow: 0 8px 20px -14px rgba(0, 0, 0, 0.8);
}
:root[data-theme="light"] .channel-btn:hover {
  box-shadow: 0 8px 20px -14px rgba(15, 23, 42, 0.4);
}
.channel-btn:active {
  transform: scale(0.98);
}
.channel-btn:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: 2px;
}
.channel-btn.active {
  color: var(--text);
  border-color: var(--accent-line);
  background: linear-gradient(180deg, var(--accent-dim), transparent 140%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 0 24px -10px var(--accent-line);
}
.channel-btn.active::after {
  width: 100%;
}
.ch-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ch-name {
  font-size: 12.5px;
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ch-sub {
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.channel-btn.active .ch-sub {
  color: var(--accent-strong);
}
.ch-badge {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 10.5px;
  padding: 2.5px 8px;
  border-radius: var(--r-pill);
  border: 1px solid var(--line-strong);
  color: var(--text-2);
  transition: border-color 0.22s, background 0.22s, color 0.22s;
}
.ch-badge.ok {
  color: var(--accent-strong);
}
.channel-btn.active .ch-badge {
  border-color: var(--accent-line);
  background: var(--accent-dim);
  color: var(--accent-strong);
}
/* 渠道面板：切渠道时新面板淡入上浮；v-for 按 key 复用，数据刷新不会重播 */
.channel-panel {
  animation: panelIn 0.32s var(--ease);
}
@keyframes panelIn {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
@media (prefers-reduced-motion: reduce) {
  .channel-panel {
    animation: none;
  }
}
/* 面板工具栏：策略 / 添加账号 / 签到或加油包 / 刷新，全部只作用于当前渠道 */
.panel-tools {
  margin-left: auto;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* 面板标题里的渠道图标：与主按钮同图标，形成"按钮 → 面板"的视觉呼应 */
.channel-panel .card-title .ph {
  font-size: 13px;
  color: var(--accent-strong);
}
.danger {
  color: var(--err, #e05555);
}
.agg {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
  margin-top: 4px;
}
.agg-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.agg-item span {
  font-size: 11px;
  color: var(--text-3);
}
.agg-item b {
  font-family: var(--font-mono);
  font-size: 13px;
}
/* 策略下拉与工具栏其他按钮同为小控件档（--ctl-h-sm = 24px），严格同高对齐 */
.strategy-select {
  width: 108px;
  margin-right: 8px;
  vertical-align: middle;
  height: var(--ctl-h-sm);
  font-size: 11px;
}
/* ===== 添加账号弹窗：头部 + 分段方式切换 + 等高面板 + 固定底部操作（弹窗外壳版式见 global.css 的 .p-dlg） ===== */
.add-dlg {
  width: 560px;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.add-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 15px 18px 13px;
  border-bottom: 1px solid var(--line);
}
.add-head-icon {
  width: 34px;
  height: 34px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--r-sm);
  background: var(--accent-dim);
  color: var(--accent);
  font-size: 17px;
}
.add-head-text {
  flex: 1;
  min-width: 0;
}
.add-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  line-height: 1.3;
}
.add-chip {
  padding: 2px 8px;
  border-radius: var(--r-pill);
  border: 1px solid var(--accent-line);
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-size: 10.5px;
  font-weight: 600;
  white-space: nowrap;
}
.add-sub {
  font-size: 10.5px;
  color: var(--text-3);
  margin-top: 3px;
}
.add-close {
  width: 26px;
  height: 26px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border: 1px solid var(--line-strong);
  border-radius: 50%;
  background: var(--bg-soft);
  color: var(--text-3);
  cursor: pointer;
  font-size: 13px;
  transition: color 0.15s, border-color 0.15s, transform 0.2s var(--ease);
}
.add-close:hover {
  color: var(--text);
  border-color: var(--accent-line);
  transform: rotate(90deg);
}
.add-tabs {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: 1fr;
  gap: 4px;
  margin: 14px 18px 0;
  padding: 4px;
  border-radius: var(--r-ctl);
  background: var(--bg-soft);
  border: 1px solid var(--line);
}
.add-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  height: 28px;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  font-size: 12px;
  font-weight: 500;
  font-family: var(--font-ui);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.add-tab:hover {
  color: var(--text);
}
.add-tab.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
  font-weight: 600;
}
.add-tab.disabled {
  opacity: 0.4;
  pointer-events: none;
}
/* 定高内容区：三种方式共用一个高度，切 tab 时弹窗不跳 */
.add-body {
  height: 248px;
  display: flex;
  flex-direction: column;
  padding: 16px 18px 4px;
}
.add-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.add-pane.center {
  align-items: center;
  justify-content: center;
  text-align: center;
  gap: 10px;
  /* 新渠道的 OAuth 面板比旧三档多一两行（区服/上游选择、设备码行、长错误文案），
     定高面板挤不下时让内容自己滚；safe center 保证首行不被居中裁到看不见 */
  overflow-y: auto;
  justify-content: safe center;
}
.add-pane-icon {
  width: 42px;
  height: 42px;
  flex-shrink: 0;
  display: grid;
  place-items: center;
  border-radius: var(--r-ctl);
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-size: 21px;
}
.add-pane-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.add-pane-desc {
  font-size: 11px;
  line-height: 1.75;
  color: var(--text-3);
  max-width: 420px;
}
.add-msg {
  font-size: 11px;
  line-height: 1.6;
  color: var(--ok, var(--accent-strong));
  word-break: break-all;
  max-width: 100%;
}
.add-msg.err {
  color: var(--err, #e05555);
}
/* 粘贴面板：标签 + 撑满的文本域 */
.paste-pane {
  gap: 8px;
}
.paste-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-2);
}
.paste-area {
  flex: 1;
  width: 100%;
  min-height: 0;
  padding: 9px 11px;
  resize: none;
  line-height: 1.6;
  font-size: 11.5px;
}
.add-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 18px 14px;
  border-top: 1px solid var(--line);
  margin-top: 12px;
}
.add-foot-hint {
  flex: 1;
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--text-3);
}
.add-foot-hint .ph {
  font-size: 13px;
}
.mono {
  font-family: var(--font-code);
}

/* ===== 切号确认弹窗：预检事实块（客户端状态 / 程序路径 / 切完是否自动重启 + 未保存丢失告警） ===== */
.ide-probe {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 10px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.ide-probe-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 11px;
  line-height: 1.5;
}
.ide-probe-k {
  flex-shrink: 0;
  width: 68px;
  color: var(--text-3);
}
.ide-probe-v {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  color: var(--text-2);
  overflow-wrap: anywhere;
}
/* 程序路径可能很长：单行右截断，完整内容由 title 悬浮显示，别把弹窗撑宽 */
.ide-probe-v.mono {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.ide-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
}
.ide-dot.on {
  background: var(--warn);
}
.ide-probe-warn {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 11px;
  line-height: 1.55;
  color: var(--warn);
}
.ide-probe-warn .ph {
  flex-shrink: 0;
  margin-top: 1px;
  font-size: 13px;
}

/* ===== 本机软件导入面板：候选列表（等高面板内滚，避免撑高弹窗） ===== */
.scan-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.scan-hint {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scan-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.scan-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
}
.scan-row:last-child {
  border-bottom: none;
}
.scan-row.dim {
  opacity: 0.62;
}
.scan-ch {
  flex-shrink: 0;
  width: 96px;
  font-size: 11px;
  font-weight: 600;
  color: var(--accent-strong);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scan-main {
  flex: 1;
  min-width: 0;
}
.scan-name {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scan-file {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.scan-empty {
  padding: 22px 12px;
  text-align: center;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.7;
}
/* 回调地址兜底行：输入框 + 提交按钮等高并排 */
.cb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 420px;
}
/* OAuth 面板内的渠道专属开关：qoder 区服 / AutoClaw 国际版上游，都是"发起前定一次"的小选择 */
.oauth-radio-row {
  margin-top: 2px;
}
/* 设备码行：授权页一般自动带上验证码，这里给出可整段选中的读数供手输 */
.oauth-code-row {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  max-width: 420px;
  font-size: 11px;
  color: var(--text-3);
}
.oauth-user-code {
  padding: 3px 10px;
  border-radius: var(--r-sm);
  border: 1px solid var(--accent-line);
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-family: var(--font-code);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 1.5px;
  user-select: all;
}
/* 阿里云滑块的挂载容器：没 init 过时它是空节点，:empty 让弹窗高度不跳；
   预置 display:none 反而会让 popup 降级成内嵌形态时看不见滑块，故不用 */
.captcha-mount {
  width: 100%;
  max-width: 360px;
}
.captcha-mount:empty {
  display: none;
}
/* popup 模式的触发按钮：SDK 只认这个元素的点击，由代码在 init 后 .click() 驱动，
   所以留在文档流里（SDK 要能量到位置）但视觉上 1×1 透明、也不接真实点击 */
.captcha-trigger {
  width: 1px;
  height: 1px;
  padding: 0;
  border: 0;
  background: transparent;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}
/* 粘贴面板的渠道说明：一行讲清这个渠道该粘哪些字段 */
.paste-hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-3);
}

/* 号池同步卡片已移至独立「号池同步」页；此处样式不再使用 */

/* ===== 签到结果弹窗：逐账号一行，多行限高滚动 ===== */
.checkin-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-2);
}
.checkin-head .ph {
  font-size: 15px;
  color: var(--accent-strong);
}
.checkin-stats {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.checkin-dlg {
  width: 460px;
}
/* 设备指纹诊断弹窗稍宽：行内要放撞车对象标签 + 指纹缩略 */
.checkin-dlg:has(.dev-hint) {
  width: 560px;
}
.dev-hint {
  margin-top: 8px;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-3);
}
.checkin-rows {
  margin-top: 10px;
  max-height: 320px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.checkin-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 7px 10px;
  border-radius: var(--r-sm);
  background: var(--bg-soft);
  border: 1px solid var(--line);
}
.checkin-name {
  flex-shrink: 0;
  max-width: 45%;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 550;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.checkin-msg {
  flex: 1;
  min-width: 0;
  font-size: 11px;
  color: var(--text-3);
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.checkin-empty {
  padding: 18px 0;
  text-align: center;
  font-size: 11.5px;
  color: var(--text-3);
}
/* ===== UID 查看弹窗 ===== */
.uid-dlg {
  width: 400px;
}
.uid-text {
  margin-top: 10px;
  padding: 11px 12px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: var(--bg-soft);
  font-size: 12.5px;
  letter-spacing: 0.4px;
  word-break: break-all;
  user-select: all;
}
/* ===== 列表布局：账号两行式 + 数字列右对齐 ===== */
.pool-tbl th:nth-child(3),
.pool-tbl th:nth-child(5),
.pool-tbl td.num {
  text-align: right;
}
/* ===== 积分包展开明细（Q6）===== */
.pkg-caret {
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-3);
  padding: 0 4px 0 0;
  font-size: 12px;
  transition: transform 0.15s;
  display: inline-block;
}
.pkg-caret.open {
  transform: rotate(90deg);
  color: var(--text-1);
}
.pkg-row > .pkg-cell {
  padding: 0 0 8px 26px;
  background: var(--bg-2, rgba(127, 127, 127, 0.05));
}
.pkg-tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.pkg-tbl th {
  text-align: left;
  font-weight: 500;
  color: var(--text-3);
  padding: 4px 8px;
}
.pkg-tbl td {
  padding: 4px 8px;
  border-top: 1px solid var(--border, rgba(127, 127, 127, 0.15));
}
.pkg-tbl td.num {
  text-align: right;
}
.pkg-name {
  min-width: 140px;
  max-width: 240px;
}
.pkg-bar {
  height: 4px;
  border-radius: 2px;
  background: var(--border, rgba(127, 127, 127, 0.25));
  margin-top: 3px;
  overflow: hidden;
}
.pkg-bar-used {
  display: block;
  height: 100%;
  background: var(--accent, #4c8bf5);
  border-radius: 2px;
}
.pkg-hint-row > .pkg-hint {
  padding: 4px 8px 6px 26px;
  font-size: 12px;
  color: var(--text-3);
}
.acc-cell {
  line-height: 1.3;
}
.acc-name {
  display: block;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  cursor: text;
  border-bottom: 1px dashed transparent;
}
.acc-name:hover {
  border-bottom-color: var(--text-3);
}
.acc-sub {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--text-3);
}
.acc-sub i {
  font-style: normal;
  opacity: 0.6;
}
/* 「本机登录」徽标：本机 agent 客户端当前登录的就是这个账号（与全局 tag 同构，自带小图标） */
.acc-live {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  white-space: nowrap;
}
.acc-live .ph {
  font-size: 11px;
}
.acc-uid {
  border: none;
  background: none;
  padding: 0;
  color: var(--text-3);
  font-size: 10.5px;
  cursor: pointer;
  max-width: 130px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color 0.15s;
}
.acc-uid:hover:not(:disabled) {
  color: var(--accent-strong);
}
/* ===== 状态列：冷却剩余 + 点击弹最近错误小窗 ===== */
.cool-left {
  margin-left: 6px;
  font-size: 10.5px;
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
}
/* 有错误的账号状态标签才可点：hover 时用警示色描边提示"这里能点" */
.status-tag.has-err {
  cursor: pointer;
  transition: border-color 0.2s, box-shadow 0.2s, filter 0.2s;
}
.status-tag.has-err:hover {
  border-color: var(--danger);
  box-shadow: 0 0 10px -4px var(--danger);
  filter: brightness(1.12);
}
/* ===== 最近错误小窗：液态玻璃小卡只装错误全文 ===== */
.err-dlg {
  width: 480px;
}
.err-head {
  display: flex;
  align-items: center;
  gap: 7px;
}
.err-head .ph {
  font-size: 15px;
  color: var(--danger);
}
.err-time {
  margin-left: auto;
  font-size: 10.5px;
  font-weight: 400;
  color: var(--text-3);
}
.err-text {
  margin-top: 10px;
  padding: 11px 12px;
  max-height: 240px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-2);
  word-break: break-all;
  white-space: pre-wrap;
  user-select: text;
}
.tag-err {
  background: var(--danger-dim);
  color: var(--danger);
  border: 1px solid transparent;
}
.btn-captcha-warn {
  color: #f59e0b !important;
  font-weight: 600;
  background: rgba(245, 158, 11, 0.12) !important;
  border-radius: 4px;
  padding: 2px 7px !important;
  animation: pulse 1.8s infinite;
}
.btn-warning {
  background: #f59e0b !important;
  color: #ffffff !important;
  border: none;
  font-weight: 500;
}
.btn-warning:hover {
  background: #d97706 !important;
}
</style>
