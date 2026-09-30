// 请求日志表的列定义（总览实时流 / 用量统计明细共用）。
// 单独成模块：列设置按钮挂在父页卡片标题行（ColSettingsMenu），父页也要拿这份清单
export type ColDef = { id: string; label: string };

export const LOG_COLS: Record<"home" | "stats", ColDef[]> = {
  home: [
    { id: "time", label: "时间" }, { id: "model", label: "模型" }, { id: "channel", label: "渠道" },
    { id: "key", label: "KEY" }, { id: "status", label: "状态" }, { id: "usage", label: "用量" },
    // 表头用中性「消耗」：行级单位已逐渠道化（积分/Token/额度，见悬浮提示），列头不能钉死单一口径
    { id: "credits", label: "消耗" }, { id: "ttft", label: "TTFT" }, { id: "latency", label: "耗时" },
  ],
  stats: [
    { id: "time", label: "时间" }, { id: "model", label: "模型" }, { id: "channel", label: "渠道" },
    { id: "key", label: "KEY" }, { id: "account", label: "账号" }, { id: "status", label: "状态" },
    { id: "usage", label: "用量" }, { id: "credits", label: "消耗" }, { id: "ttft", label: "TTFT" },
    { id: "latency", label: "耗时" }, { id: "attempts", label: "重试" }, { id: "error", label: "错误" },
  ],
};

/** 恢复默认时的列集。stats 裁掉 KEY/账号/TTFT 三列：12 列在常规窗口必出横向滚动，
 *  裁后 9 列一屏放得下；被裁的列仍可从列设置里勾回来 */
export const LOG_DEFAULT_COLS: Record<"home" | "stats", string[]> = {
  home: LOG_COLS.home.map((c) => c.id),
  stats: ["time", "model", "channel", "status", "usage", "credits", "latency", "attempts", "error"],
};
