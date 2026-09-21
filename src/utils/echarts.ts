// echarts 按需注册入口：全库只用折线图 + 网格 / 提示框 / 图例（含滚动图例）+ canvas 渲染器。
// 所有图表一律从本文件 import，禁止再 import "echarts" —— 那会把 1009 KB 的全量包拉回首屏。
// LegendScrollComponent 是冗余项而非义务：component/legend/install.js 里 LegendComponent 自己就
// use(installLegendScroll)，两端实测过——实装 5.6.0 与 package.json 的下限 5.4.3（查 registry
// 包内 lib/component/legend/install.js）安装链一致，只注册 LegendComponent 也能解析 legend.type
// "scroll"。显式那行刻意保留：两种写法注册集完全相同、installLegendScroll.js 反正会进图，删它
// 省不下字节，而它把「这里要滚动图例」写在了名字里——别当「未使用」清掉。
// Heatmap.vue 是纯 DOM 格子，不碰 echarts，因此不需要 HeatmapChart。全库无 registerTheme、
// 无 graphic option、无 mark*。
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, LegendScrollComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([LineChart, GridComponent, LegendComponent, LegendScrollComponent, TooltipComponent, CanvasRenderer]);

export const init = echarts.init;
export const graphic = echarts.graphic;
export type ECharts = echarts.ECharts;
