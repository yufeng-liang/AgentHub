// 积分到期页的行过滤与排序：纯函数，与渲染解耦（scripts/dev-expiry-rows-test.cjs 直接断言）
import type { ProxyCreditPackage } from "../../types";

export interface ExpiryRow {
  key: string;
  channelId: string;
  channelDisplay: string;
  accountName: string;
  pkg: ProxyCreditPackage;
}

/** 状态筛选；usable = 有余额（排除已用完），是页面默认档 */
export type ExpiryStatusFilter = "usable" | "all" | "ok" | "soon" | "expired" | "used";
export type ExpirySortKey = "expiryAsc" | "expiryDesc" | "remainDesc" | "remainAsc";

export const STATUS_OPTIONS: { value: ExpiryStatusFilter; label: string }[] = [
  { value: "usable", label: "有余额" },
  { value: "all", label: "全部" },
  { value: "ok", label: "生效中" },
  { value: "soon", label: "即将到期" },
  { value: "expired", label: "已过期" },
  { value: "used", label: "已用完" },
];

export const SORT_OPTIONS: { value: ExpirySortKey; label: string }[] = [
  { value: "expiryAsc", label: "到期时间 ↑" },
  { value: "expiryDesc", label: "到期时间 ↓" },
  { value: "remainDesc", label: "剩余额度 ↓" },
  { value: "remainAsc", label: "剩余额度 ↑" },
];

export type ExpiryState = "expired" | "soon" | "used" | "ok";

/** 已用完 = 剩余为 0；-1 是「不限」哨兵，绝不能当成 0 */
export const isUsedUp = (pkg: ProxyCreditPackage) => pkg.remaining === 0;

/** 状态归类：过期 > 即将到期 > 已用完 > 生效中（过期且余额为 0 的包仍算「已过期」，那是更该看到的信息） */
export function statusOf(pkg: ProxyCreditPackage): ExpiryState {
  if (pkg.expired) return "expired";
  if (pkg.expiringSoon) return "soon";
  if (isUsedUp(pkg)) return "used";
  return "ok";
}

/** 剩余额度排序键：-1（不限）视为最大 */
const remainKey = (pkg: ProxyCreditPackage) => (pkg.remaining === -1 ? Number.POSITIVE_INFINITY : pkg.remaining);
/** 到期排序键：0（长期有效）视为最大，故升序时排在最后 */
const expiryKey = (pkg: ProxyCreditPackage) => pkg.expiresAt || Number.POSITIVE_INFINITY;

function byExpiry(a: ExpiryRow, b: ExpiryRow, dir: 1 | -1): number {
  const ea = expiryKey(a.pkg);
  const eb = expiryKey(b.pkg);
  // 两个长期包（都是 Infinity）相减得 NaN，所以先比不相等再相减
  if (ea !== eb) return dir * (ea - eb);
  // 同到期一律按剩余降序（升/降序共用同一个第二关键字，免得降序把次序也翻过来）
  return remainKey(b.pkg) - remainKey(a.pkg);
}

export interface ExpiryFilter {
  status: ExpiryStatusFilter;
  /** "all" = 不限渠道 */
  channelId: string;
  sort: ExpirySortKey;
}

export function applyExpiryFilter(rows: ExpiryRow[], f: ExpiryFilter): ExpiryRow[] {
  const out = rows.filter((r) => {
    if (f.channelId !== "all" && r.channelId !== f.channelId) return false;
    if (f.status === "all") return true;
    if (f.status === "usable") return !isUsedUp(r.pkg);
    return statusOf(r.pkg) === f.status;
  });
  out.sort((a, b) => {
    switch (f.sort) {
      case "expiryDesc":
        return byExpiry(a, b, -1);
      case "remainDesc":
        return remainKey(b.pkg) - remainKey(a.pkg) || byExpiry(a, b, 1);
      case "remainAsc":
        return remainKey(a.pkg) - remainKey(b.pkg) || byExpiry(a, b, 1);
      default:
        return byExpiry(a, b, 1);
    }
  });
  return out;
}

export function countByState(rows: ExpiryRow[]): Record<ExpiryState, number> & { total: number } {
  const out = { expired: 0, soon: 0, used: 0, ok: 0, total: rows.length };
  for (const r of rows) out[statusOf(r.pkg)]++;
  return out;
}
