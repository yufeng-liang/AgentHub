/** 模型目录表格的虚拟窗口数学。
 *  单独成模块是为了让结构闸（scripts/dev-models-vrows-test.cjs）能直接调用同一份实现，
 *  而不是在测试里抄一遍——抄一遍就等于测了个自证的假绿。 */

/** 行高。实测值，不是估值：133 个模型渲染出来的 <tr> 高度全部恰好 60px
 *  （td 上下 padding 各 13px + 模型列两行 13px 文本）。占位行按它算总高，
 *  所以这一格改动若让行高变了，必须重新量，不能只改这个数。 */
export const ROW_H = 60;

/** 视口上下各多挂几行：滚动时不至于先看到空白再补上 */
export const OVERSCAN = 4;

/** 还没量到滚动容器高度时先按这个行数渲染，避免首屏空白 */
export const MIN_ROWS = 8;

export interface WinRange {
  start: number;
  end: number;
  padTop: number;
  padBottom: number;
}

/** total 行里，视口首行为 firstVisible、视口可见 viewRows 行时，该挂载哪一段、上下各垫多少像素。 */
export function winRange(total: number, firstVisible: number, viewRows: number): WinRange {
  if (total <= 0) return { start: 0, end: 0, padTop: 0, padBottom: 0 };
  const first = Math.max(0, Math.min(firstVisible, total - 1));
  const start = Math.max(0, first - OVERSCAN);
  const count = Math.max(viewRows, MIN_ROWS) + OVERSCAN * 2;
  const end = Math.min(total, start + count);
  return { start, end, padTop: start * ROW_H, padBottom: (total - end) * ROW_H };
}

 /** 占位行与空态行的 colspan。单渠道视图少一列「来源渠道」。
  *  2026-09-30 重组：原「元数据」列（独立编辑入口）并进「能力」格，9/8 列收敛为 8/7 列。
  *  放这儿而不是写在组件里：结构闸要拿「渲染出来的 colspan」和表头实际列数对，
  *  组件里写死一个数、或者门禁自己注入一个数，都只是自证。 */
 export function colCountFor(activeTab: string): number {
   return activeTab ? 7 : 8;
 }
