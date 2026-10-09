import type { ProxyModel } from "../../types";
import { channelName } from "./format";

/** 模型目录「渠道」列的纯算法：摘要文案、态别类名、Popover 行序。
 *
 *  单独成模块的原因与 virtualWindow.ts / fmtCtx 一样：结构闸要 import **同一份实现**来比对
 *  渲染结果。把文案规则写在模板里，门禁就只能跟着模板走——组件把「已排除」写成「排除」
 *  或者把渠道全名铺进格子，闸都不会红（2026-10-08 拷问时定案 Q10 正是为了堵这个）。 */

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
 *  而这条信息属于「点开看」的层级。
 *  钉定态一律写「首选 X」而不是「只走 X」（2026-10-09）：modelOverrides 在 server.cjs:113
 *  只决定主渠道，备选队列仍取「其余未排除的拥有该模型的渠道」（:713），主渠道降级或耗尽时
 *  请求照转。写成「只走」是对路由行为的假陈述——它会让用户在主渠道熔断后完全想不到请求
 *  其实已经换了一家。真要独占请到配置页关掉「跨渠道自动转移」。
 *  @param only 顶部渠道 chip 选中时传该渠道 id：整列降为一颗开关，摘要也说这一件事（定案 Q5=C）。 */
export function chanSummary(m: ProxyModel, only?: string): string {
  if (only) {
    const off = new Set(exOf(m));
    return off.has(only) ? `已排除 ${channelName(only)}` : `走 ${channelName(only)}`;
  }
  if (m.override) return `📌 首选 ${channelName(m.override)}`;
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
 *               否则新增渠道又要改两处）。
 *  @param frozenIds 弹层**打开期间**钉住的行序（定案 Q10c 的补充，2026-10-09）：沉底规则若
 *               当场生效，用户点掉第 1 行后第 2 行会顶到他的鼠标底下且同样是开的——「开关点了
 *               没反应」的观感就是这么来的。渲染层在 @show 时冻结、@hide 时解除，
 *               于是顺序只在重新打开时重排。名单里没有的渠道（这期间才出现的）排在末尾，
 *               彼此仍按默认序。 */
export function chanRows(m: ProxyModel, order: string[], mappedChannels: string[] = [], frozenIds: string[] | null = null): ChanRow[] {
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
  const defaulted = rows
    .sort((a, b) => weight(a) - weight(b))
    .concat(staleExcluded(m).map((id) => ({ id, name: channelName(id), on: false, pinned: false, stale: true, mapped: false })));
  if (!frozenIds || !frozenIds.length) return defaulted;
  const pos = new Map(frozenIds.map((id, i) => [id, i]));
  // 冻结位用 weight() 兜底而不是常量：同一批「不在名单里」的行之间要保序，
  // 而 Array#sort 只在比较结果确定时才稳定。
  const frozenRank = (r: ChanRow) => (pos.has(r.id) ? pos.get(r.id)! : frozenIds.length + weight(r));
  return defaulted.slice().sort((a, b) => frozenRank(a) - frozenRank(b));
}
