import type { ProxyModel } from "../../types";
import { channelName } from "./format";

/** 模型目录「渠道」列的纯算法：摘要文案、态别类名、Popover 行序、窄宽度阈值。
 *
 *  单独成模块的原因与 virtualWindow.ts / fmtCtx 一样：结构闸要 import **同一份实现**来比对
 *  渲染结果。把文案规则写在模板里，门禁就只能跟着模板走——组件把「已排除」写成「排除」
 *  或者把渠道全名铺进格子，闸都不会红（2026-10-08 拷问时定案 Q10 正是为了堵这个）。 */

/** 窄宽度降级阈值：滚动容器 clientWidth 低于它，能力列先去掉 K/M 后缀、再砍「视」（定案 Q13）。
 *  860/888 是本页实测的窄端（列宽按百分比摊，能力列 22.5% ≈ 193px），五枚全显放不下。 */
export const CAP_COMPACT_BELOW = 1000;

const srcOf = (m: ProxyModel) => (m.sources || []) as string[];
const exOf = (m: ProxyModel) => (m.excluded || []) as string[];

/** 还剩几个渠道可走（排除后） */
export function liveCount(m: ProxyModel): number {
  const ex = new Set(exOf(m));
  return srcOf(m).filter((s) => !ex.has(s)).length;
}

/** 陈旧排除：排除集里的渠道已经不在该模型的来源里了（下架 / 目录改名）。
 *  不主动清理（与 modelOverrides 现状同构），路由时自然失效；界面给灰字 + 一键清除。 */
export function staleExcluded(m: ProxyModel): string[] {
  const src = srcOf(m);
  return exOf(m).filter((ch) => !src.includes(ch));
}

/** 格子里的摘要：只报结果态。
 *  被排除渠道的全名不进格子（定案 Q10a）——渠道名最长八个字，20% 的列宽放两颗就撑破，
 *  而这条信息属于「点开看」的层级。 */
export function chanSummary(m: ProxyModel): string {
  if (m.override) return `📌 ${channelName(m.override)}`;
  const live = liveCount(m);
  if (!live) return "全部已排除";
  return `自动路由 · ${live} 渠道`;
}

/** 摘要的态别类名：钉定 / 排除 / 一个不剩 / 自动。闸按它比对可见类名（㉓c㉕）。 */
export function chanTone(m: ProxyModel): string {
  if (m.override) return "chan-pinned";
  if (exOf(m).length && !liveCount(m)) return "chan-none";
  if (exOf(m).length) return "chan-excluded";
  return "";
}

export type ChanRow = { id: string; name: string; on: boolean; pinned: boolean; stale: boolean; mapped: boolean };

/** Popover 行序（定案 Q10c）：反向映射命中的置顶标「映射」→ 其余按内置清单序 → 被排除的沉底。
 *  @param order 内置渠道 id 的权威顺序（渲染层从号池渠道列表拿；这里不写死渠道名，
 *               否则新增渠道又要改两处）。 */
export function chanRows(m: ProxyModel, order: string[], mappedChannels: string[] = []): ChanRow[] {
  const ex = new Set(exOf(m));
  const mapped = new Set(mappedChannels);
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  const rows: ChanRow[] = srcOf(m).map((id) => ({
    id,
    name: channelName(id),
    on: !ex.has(id),
    pinned: m.override === id,
    stale: false,
    mapped: mapped.has(id),
  }));
  // 先按「映射 > 内置序」排，再把可用的挪到前面、被排除的沉底——两级排序都要稳定，
  // 所以自己算权重而不是连续 sort 两次（后者在 V8 里对相等元素的顺序虽稳定，但读起来像两次都生效）。
  const weight = (r: ChanRow) => (r.on ? 0 : 100) + (r.mapped ? 0 : 10) + rank(r.id);
  return rows
    .sort((a, b) => weight(a) - weight(b))
    .concat(staleExcluded(m).map((id) => ({ id, name: channelName(id), on: false, pinned: false, stale: true, mapped: false })));
}
