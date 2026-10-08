// 反代网关 · 视图共享格式化工具
/** 千分位 */
export const fmtInt = (n: number) => Math.round(n || 0).toLocaleString("en-US");

/** 大数缩写：1,234 → 1.2K */
export function fmtK(n: number): string {
  const v = n || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v));
}

/** 毫秒 → 人类可读延迟 */
export function fmtMs(ms: number): string {
  if (!ms) return "-";
  return ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : Math.round(ms) + "ms";
}

/** 时间戳 → HH:MM:SS */
export function fmtTime(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 时间戳 → YYYY-MM-DD */
export function fmtDate(ts: number): string {
  if (!ts) return "-";
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 相对时间：3 分钟前（宽容处理 ISO 字符串 / 非法值，不出现 NaN） */
export function fmtAgo(ts: number): string {
  const t = Number(ts);
  if (!t || !Number.isFinite(t)) return "从未";
  const diff = Date.now() - t;
  if (diff < 60000) return "刚刚";
  if (diff < 3600000) return Math.floor(diff / 60000) + " 分钟前";
  if (diff < 86400000) return Math.floor(diff / 3600000) + " 小时前";
  return Math.floor(diff / 86400000) + " 天前";
}

/**
 * 大数中文数量级：万 / 百万 / 千万 / 亿 / 百亿，换算档固定保留两位小数。
 * 渠道额度共用一套换算（积分与 Token 同规）；不足 1 万保持千分位整数。
 */
export function fmtCnAmount(n: number): string {
  const v = Number(n) || 0;
  if (v <= 0) return "0";
  if (v >= 1e10) return (v / 1e10).toFixed(2) + " 百亿";
  if (v >= 1e8) return (v / 1e8).toFixed(2) + " 亿";
  if (v >= 1e7) return (v / 1e7).toFixed(2) + " 千万";
  if (v >= 1e6) return (v / 1e6).toFixed(2) + " 百万";
  if (v >= 1e4) return (v / 1e4).toFixed(2) + " 万";
  return fmtInt(v);
}

/**
 * 格式化 Token 数量：
 * 智谱不是积分，是 Token，支持换算单位百万、千万、亿，保留合理小数位并去除末尾零。
 * （上游 v1.4x 把本函数删了、统一走 fmtCnAmount；本分支的智谱 Token 口径仍需要它，
 *  单位表 balanceUnit()==="Token" 就是靠 fmtToken 换算的，不能跟着退。）
 */
export function fmtToken(n: number): string {
  const v = Number(n) || 0;
  if (v <= 0) return "0";
  if (v >= 1e8) {
    const s = (v / 1e8).toFixed(2).replace(/\.?0+$/, "");
    return `${s} 亿`;
  }
  if (v >= 1e7) {
    const s = (v / 1e7).toFixed(2).replace(/\.?0+$/, "");
    return `${s} 千万`;
  }
  if (v >= 1e6) {
    const s = (v / 1e6).toFixed(2).replace(/\.?0+$/, "");
    return `${s} 百万`;
  }
  if (v >= 1e4) {
    const s = (v / 1e4).toFixed(1).replace(/\.?0+$/, "");
    return `${s} 万`;
  }
  return fmtInt(v);
}

/** 各渠道计费单位（逐渠道适配：有的渠道叫积分，有的渠道是 Token 包）。
 *  真相源在后端 store.cjs BUILTIN_CHANNELS[].unit（402 文案用），此处是展示镜像——两边加渠道必须同步。
 *  · trae / workbuddy 家 / raccoon / lobster：上游按积分计（Trae 积分包、CodeBuddy 加油包、小浣熊 points、
 *    龙虾每日签到积分）；
 *  · zcode 家：智谱编码套餐不是积分，是 Token 包（billing/balance 的 remaining_units）；
 *  · qoder 家：官方是浮点 Credits（实测 0.0066 级精度，整数化会抹掉小额消耗）；
 *  · cline / autoclaw / modelscope：订阅/加速池，官方无余额接口、消耗也从不实报，单位落不到界面上，
 *    兜底用中性「额度」；自建提供商同此。 */
export const CHANNEL_UNITS: Record<string, string> = {
  trae: "积分",
  workbuddy: "积分",
  workbuddy_ai: "积分",
  raccoon: "积分",
  cline_free: "额度",
  cline_pass: "额度",
  autoclaw: "额度",
  autoclaw_intl: "额度",
  modelscope: "额度",
  lobster: "积分",
  qoder: "Credits",
  qoder_intl: "Credits",
  zcode: "Token",
  zcode_intl: "Token",
};
export const balanceUnit = (channel?: string): string => (channel && CHANNEL_UNITS[channel]) || "额度";
/** Token 计价渠道（智谱家）：余额展示要过 fmtToken 换算（亿/万），浮层给原值 */
export const isTokenChannel = (channel?: string): boolean => balanceUnit(channel) === "Token";

/**
 * 格式化 Qoder Credits（浮点计量，实测精度到 1e-16）：
 * 整数部分正常显示，小数最多保留 2 位并去尾零——整数化会丢掉小额消耗的真实计量。
 */
export function fmtCredits(n: number): string {
  const v = Number(n) || 0;
  if (!Number.isFinite(v)) return "0";
  if (Number.isInteger(v)) return fmtInt(v);
  const s = v.toFixed(2).replace(/\.?0+$/, "");
  return s === "" || s === "-" ? "0" : s;
}

/** Qoder 双区共用一套展示口径（Credits 浮点 + 领 Credits 动作），判断收敛到一处 */
export const isQoderChannel = (id?: string): boolean => id === "qoder" || id === "qoder_intl";

/** 渠道成本档 → 展示文案（cost-first 路由排序的标注；'' = 未标注按普通） */
export const COST_TIER_NAMES: Record<string, string> = {
  free: "免费",
  low: "低成本",
  normal: "普通",
};
export const costTierName = (tier?: string) => COST_TIER_NAMES[tier || "normal"] || "普通";

/** 积分包明细的包名兜底：各渠道上游叫法不同（Trae 积分包 / WorkBuddy 加油包 / zcode 套餐额度），
 *  上游没给名字时按渠道口径兜，而不是一律「积分包」 */
export function pkgFallbackName(channel?: string): string {
  const u = balanceUnit(channel);
  return u === "Token" ? "套餐额度" : u === "积分" ? "积分包" : "额度包";
}

/** 渠道余额格式化：Token 渠道输出换算后的 Token（智谱 150000000 → 1.5 亿），
 *  Qoder 双区输出浮点 Credits，其余渠道按中文数量级 */
export function fmtBalance(val: number, channel?: string): string {
  if (val === -1) return "不限";
  if (isQoderChannel(channel)) return fmtCredits(val);
  if (isTokenChannel(channel)) return fmtToken(val);
  return fmtCnAmount(val);
}
export const CHANNEL_NAMES: Record<string, string> = {
  trae: "Trae SOLO CN",
  workbuddy: "WorkBuddy CN",
  workbuddy_ai: "WorkBuddy AI",
  raccoon: "商汤小浣熊",
  cline_free: "Cline 免费池",
  cline_pass: "Cline 订阅池",
  autoclaw: "智谱 AutoClaw（国内）",
  autoclaw_intl: "智谱 AutoClaw（国际）",
  modelscope: "ModelScope（魔搭）",
  lobster: "LobsterAI（有道）",
  zcode: "ZCode（智谱）",
  zcode_intl: "ZCode 智谱（国际）",
  qoder: "Qoder",
  qoder_intl: "Qoder 国际",
};
export const channelName = (id: string) => CHANNEL_NAMES[id] || id || "-";

/** 账号状态 → 标签 */
export const ACCOUNT_STATUS: Record<string, { text: string; cls: string }> = {
  online: { text: "在线", cls: "tag-ok" },
  cooling: { text: "冷却中", cls: "tag-warn" },
  exhausted: { text: "已耗尽", cls: "tag-err" },
  relogin: { text: "需重登", cls: "tag-err" },
  disabled: { text: "已停用", cls: "tag-dim" },
};

/** 账号来源 → 文案 */
export const SOURCE_NAMES: Record<string, string> = {
  scan: "本机导入",
  oauth: "OAuth 登录",
  paste: "手动粘贴",
  json: "文件导入",
};

/** HTTP 状态 → 标签类 */
export const statusCls = (s: number) => (s >= 200 && s < 300 ? "tag-ok" : s >= 500 ? "tag-err" : s >= 400 ? "tag-warn" : "tag-dim");

/** 模型倍率 → 展示文案（null/undefined = 未知） */
export const fmtRate = (r: number | null | undefined) => (r == null || Number.isNaN(Number(r)) ? "—" : `×${Number(r)}`);

 /** 模型能力 → 紧凑标签列表：图=图片输入 / 视=视频输入 / 思=思考链 / 工=工具调用 / ↑=输出上限。
  *  2026-10-08：合并列腾出的宽度还给这列，改回全显（此前是「首枚 + 计数角标」）。
  *  实测不需要窄宽度降档：表挂 min-width:860 + table-layout:fixed，能力格最窄也有 ~204px，
  *  而五枚加铅笔图标约 120px —— 降档只会在默认窗口下把「视」白白藏掉。
  *  2026-09-30 去重：上下文长度不进这列（表里有独立且可编辑的「上下文」列）。 */
 export function capabilityTags(m: {
   capabilities?: { images?: boolean; video?: boolean; reasoning?: boolean; tools?: boolean };
   maxOutputTokens?: number;
 }): string[] {
   const out: string[] = [];
   const c = m.capabilities || {};
   if (c.images) out.push("图");
   if (c.video) out.push("视");
   if (c.reasoning) out.push("思");
   if (c.tools) out.push("工");
   const n = Number(m.maxOutputTokens) || 0;
   // 未知也要出一枚：静默不显等于替用户宣布「这模型没有输出上限」，而真实含义是目录里没给
   out.push("↑" + (n ? fmtK(n) : "—"));
   return out;
 }

/** 模型能力 → 可读全称（浮窗用）：把 图/思/工 的缩写还原成完整说法 */
export function capabilityNames(m: { capabilities?: { images?: boolean; reasoning?: boolean; tools?: boolean } }): string[] {
  const out: string[] = [];
  const c = m.capabilities || {};
  if (c.images) out.push("图片输入");
  if (c.reasoning) out.push("思考链");
  if (c.tools) out.push("工具调用");
  return out;
}

/**
 * 上下文长度 → 紧凑显示（K/M）。
 * 记忆中枢的模型行也要用同一套缩写，实现已提到 utils/format.ts（此处转出保持既有引用不变）。
 */
export { fmtCtx } from "../../utils/format";

/**
 * 上下文长度输入框的显示值 → 数字。
 * 输入框允许用户直接写 "128K" / "1M" / "1.5m"（大小写不敏感，允许空格），
 * 编辑回数字后交给 updateModelCustom。纯数字原样返回；无法识别返回 undefined（视为清空）。
 */
export function parseCtxInput(raw: string): number | undefined {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  const m = /^([0-9]*\.?[0-9]+)\s*([kmb]?)$/i.exec(s);
  if (!m) return undefined;
  const num = Number(m[1]);
  if (!Number.isFinite(num) || num <= 0) return undefined;
  const unit = m[2].toLowerCase();
  const mult = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" ? 1e9 : 1;
  const out = Math.round(num * mult);
  return out > 0 ? out : undefined;
}
