// getTrend 冒烟：多天模式（含 cacheHitRate）+ 单日按小时模式（24 点补齐）
"use strict";

// 守卫（三期收尾，2026-09-24）：被 require 时零副作用。本仓 5 个脚本曾因缺它而在被 require 时
// 真把探针跑了一次（Task 5 实现者核验导出面时误触 phase1-browser-pass）。
// 顶层 return 在 CJS 模块包装函数里合法：作为入口时 require.main === module 照常执行。
if (require.main !== module) return;
const db = require("../electron/backend/db.cjs");

function show(tag, rows) {
  console.log(`[${tag}] rows=${rows.length}`);
  const withData = rows.filter((r) => r.total > 0);
  console.log(`  非空点=${withData.length}`, JSON.stringify(withData.slice(0, 2)));
  const bad = rows.filter((r) => typeof r.cacheHitRate !== "number" || Number.isNaN(r.cacheHitRate));
  console.log(`  cacheHitRate 异常点=${bad.length}`);
}

const multi = db.getTrend("local", 7, null, null, null);
show("多天-7d", multi);

const now = new Date();
const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const single = db.getTrend("local", 1, null, null, today);
console.log(`[单日 ${today}] rows=${single.length}（应为 24）`);
show("单日", single);
console.log("  首尾点 date:", single[0]?.date, "/", single[23]?.date);

// 空天（很久以前）也应补齐 24 点且全 0
const empty = db.getTrend("local", 1, null, null, "2020-01-01");
console.log(`[空天 2020-01-01] rows=${empty.length} 全零=${empty.every((r) => r.total === 0)}`);
