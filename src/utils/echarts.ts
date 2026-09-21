// echarts 按需注册入口：全库只用折线图 + 网格 / 提示框 / 图例（含滚动图例）+ canvas 渲染器。
// 所有图表一律从本文件 import，禁止再 import "echarts" —— 那会把 1009 KB 的全量包拉回首屏。
// 两个坑：legend.type 为 "scroll" 时 LegendScrollComponent 要单独注册（它与 LegendComponent
// 是两个独立 install），漏了图例直接不渲染且没有任何报错；Heatmap.vue 是纯 DOM 格子，不碰
// echarts，因此不需要 HeatmapChart。全库无 registerTheme、无 graphic option、无 mark*。
import * as echarts from "echarts/core";
import { LineChart } from "echarts/charts";
import { GridComponent, LegendComponent, LegendScrollComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";

echarts.use([LineChart, GridComponent, LegendComponent, LegendScrollComponent, TooltipComponent, CanvasRenderer]);

export const init = echarts.init;
export const graphic = echarts.graphic;
export type ECharts = echarts.ECharts;
