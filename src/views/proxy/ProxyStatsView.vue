<!-- 反代网关 · 用量统计：指标卡（含缓存命中率）+ 近 7 日趋势 + TOP 排行 + 请求明细
     （时间/状态/渠道/模型/KEY 筛选 + 列设置 + 清理 + 详情弹窗；方案 §7 stats.html）
     口径：不设日聚合冗余表，全部由 usage_requests 流水直查；保留期在设置页可调 -->
<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ProxyStatsOverview, ProxyUsageDetail, ProxyUsageRow } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtInt, fmtK, fmtMs, channelName } from "./format";
import RequestLogTable from "./RequestLogTable.vue";
import RequestDetailDialog from "./RequestDetailDialog.vue";

const app = useAppStore();

const DAYS = 7;
const ov = ref<ProxyStatsOverview | null>(null);
const detail = ref<{ total: number; page: number; pageSize: number; rows: ProxyUsageRow[] } | null>(null);
const page = ref(1);
const pageSize = 10;
const dim = ref<"channel" | "model" | "key" | "account">("channel");
const err = ref("");
const tip = ref("");
let tipTimer: ReturnType<typeof setTimeout> | undefined;
function showTip(msg: string) {
  tip.value = msg;
  if (tipTimer) clearTimeout(tipTimer);
  tipTimer = setTimeout(() => (tip.value = ""), 2600);
}

const DIMS = [
  { value: "channel" as const, label: "渠道" },
  { value: "model" as const, label: "模型" },
  { value: "key" as const, label: "Key" },
  { value: "account" as const, label: "账号" },
];

// ===== 请求明细筛选（时间预设 / 状态 / 渠道 / 模型 / KEY）=====
const RANGES = [
  { value: "today", label: "今天" },
  { value: "7d", label: "7 天" },
  { value: "30d", label: "30 天" },
  { value: "all", label: "全部" },
] as const;
const range = ref<"today" | "7d" | "30d" | "all">("7d");
const status = ref<"" | "ok" | "fail">("");
const channel = ref("");
const model = ref("");
const keyId = ref("");
// 下拉选项从 TOP 排行取（近 7 日出现过的就有意义）；KEY 要 id → 单独拉 Key 列表
const keyOptions = ref<{ id: string; name: string }[]>([]);
const sinceTs = computed(() => {
  if (range.value === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  if (range.value === "7d") return Date.now() - 7 * 86400000;
  if (range.value === "30d") return Date.now() - 30 * 86400000;
  return 0;
});

async function loadDetail() {
  try {
    detail.value = await api.proxyStatsDetail({
      page: page.value,
      pageSize,
      channel: channel.value || undefined,
      keyId: keyId.value || undefined,
      model: model.value || undefined,
      status: status.value || undefined,
      sinceTs: sinceTs.value || undefined,
    });
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}
watch([range, status, channel, model, keyId], () => {
  page.value = 1;
  loadDetail();
});

// ===== 详情弹窗：按 id 取单条（列表不带 2KB 级 error_body）=====
const detailReq = ref<ProxyUsageDetail | null>(null);
const detailLoading = ref(false);
async function openDetail(row: ProxyUsageRow) {
  detailLoading.value = true;
  try {
    detailReq.value = await api.proxyStatsRequest(row.id);
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    detailLoading.value = false;
  }
}

// ===== 清理：按设置页保留期删旧流水 =====
const cleanOpen = ref(false);
const cleaning = ref(false);
async function doCleanup() {
  cleaning.value = true;
  try {
    const r = await api.proxyStatsCleanup();
    showTip(`已清理保留期（${app.config.proxy.usageRetentionDays} 天）之前的流水 ${fmtInt(r.deleted)} 条`);
    cleanOpen.value = false;
    page.value = 1;
    await Promise.all([loadDetail(), refresh()]);
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    cleaning.value = false;
  }
}

const topRows = computed(() => {
  const rows = ov.value?.tops[dim.value] || [];
  const total = rows.reduce((s, r) => s + r.req, 0) || 1;
  return rows.map((r) => ({ ...r, label: dim.value === "channel" ? channelName(r.name) : r.name, pct: Math.round((r.req / total) * 100) }));
});

const totalPages = computed(() => Math.max(1, Math.ceil((detail.value?.total || 0) / pageSize)));

// 近 7 日趋势：零依赖 SVG 折线（对齐设计稿 charts.js 的 line）
const trendPath = computed(() => {
  const t = ov.value?.trend || [];
  if (!t.length) return { line: "", area: "", max: 0 };
  const w = 560;
  const h = 96;
  const max = Math.max(...t.map((x) => x.req), 1);
  const pts = t.map((x, i) => [((i + 0.5) / t.length) * w, h - 8 - (x.req / max) * (h - 20)] as const);
  const line = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const area = `${line} L${pts[pts.length - 1][0].toFixed(1)},${h} L${pts[0][0].toFixed(1)},${h} Z`;
  return { line, area, max };
});

async function refresh() {
  try {
    ov.value = await api.proxyStatsOverview(DAYS);
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

function goPage(p: number) {
  page.value = Math.min(totalPages.value, Math.max(1, p));
  loadDetail();
}

onMounted(async () => {
  refresh();
  loadDetail();
  try {
    keyOptions.value = (await api.proxyKeysList()).map((k) => ({ id: k.id, name: k.name }));
  } catch { /* Key 列表拉不到就只有渠道/模型筛选可用 */ }
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>
      <div v-if="tip" class="card tip-card"><div class="set-desc">{{ tip }}</div></div>
      <!-- 工具栏（页头已去标题化：号池同步入口 + 统计范围贴在正文顶部右侧） -->
      <div class="toolbar">
        <button class="btn" @click="app.setPage('poolsync')">号池同步</button>
        <span class="pill">范围 近 {{ DAYS }} 日</span>
      </div>
      <div class="kpis kpis-6" style="margin-top: 12px">

        <div class="kpi"><span>今日请求</span><b class="acc">{{ fmtInt(ov?.today.req || 0) }}</b></div>
        <div class="kpi"><span>今日 Token</span><b>{{ fmtK(ov?.today.tokens || 0) }}</b></div>
        <div class="kpi"><span>成功率</span><b>{{ (ov?.today.successRate ?? 100).toFixed(1) }}%</b></div>
        <div class="kpi"><span>TTFT 均值</span><b>{{ fmtMs(ov?.today.ttftAvg || 0) }}</b></div>
        <div class="kpi">
          <span>缓存命中率</span>
          <b :title="ov?.today.cacheHitRate != null && ov.today.cacheHitRate < 0 ? '今日暂无回报缓存字段的请求' : '读缓存 tokens ÷ prompt tokens（按上报缓存字段的请求计）'">
            {{ ov?.today.cacheHitRate != null && ov.today.cacheHitRate >= 0 ? ov.today.cacheHitRate.toFixed(1) + "%" : "-" }}
          </b>
        </div>
        <div class="kpi">
          <span>今日消耗积分</span>
          <b :title="ov?.today.creditsUsed != null && ov.today.creditsUsed < 0 ? '今日暂无回报积分的请求' : '上游实报积分累计'">
            {{ ov?.today.creditsUsed != null && ov.today.creditsUsed >= 0 ? fmtInt(ov.today.creditsUsed) : "-" }}
          </b>
        </div>
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">近 {{ DAYS }} 日请求趋势 <span class="right">峰值 {{ fmtInt(trendPath.max) }} / 日</span></div>
        <svg viewBox="0 0 560 96" class="trend" preserveAspectRatio="none">
          <path v-if="trendPath.area" :d="trendPath.area" class="trend-area" />
          <path v-if="trendPath.line" :d="trendPath.line" class="trend-line" />
        </svg>
        <div class="trend-days">
          <span v-for="t in ov?.trend || []" :key="t.day">{{ t.day.slice(5) }}</span>
        </div>
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          用量占比 TOP
          <div class="chips" style="margin-left: 8px">
            <button v-for="d in DIMS" :key="d.value" class="chip" :class="{ active: dim === d.value }" @click="dim = d.value">{{ d.label }}</button>
          </div>
        </div>
        <div class="rows">
          <div v-for="r in topRows" :key="r.name" class="row">
            <div class="grow"><div class="name">{{ r.label }}</div></div>
            <div class="ratio" style="flex: 1">
              <div class="ratio-track"><div class="ratio-fill" :style="{ width: r.pct + '%' }"></div></div>
              <span class="num">{{ r.pct }}% · {{ fmtInt(r.req) }} 次 · {{ fmtK(r.tokens) }}</span>
            </div>
          </div>
          <div v-if="!topRows.length" class="set-desc" style="padding: 8px 0">近 {{ DAYS }} 日暂无请求数据</div>
        </div>
      </div>

      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          请求明细
          <span class="right">
            {{ fmtInt(detail?.total || 0) }} 条<template v-if="sinceTs"> · {{ RANGES.find((r) => r.value === range)?.label }}</template>
            <button class="btn btn-sm" style="margin-left: 8px" :disabled="cleaning" @click="cleanOpen = true">
              <i class="ph ph-broom"></i> 清理
            </button>
          </span>
        </div>
        <!-- 上游 v1.38.0 的 tooltip 改动落在这张内联表上，而 fork 已把它抽成
             RequestLogTable.vue，故此处只留筛选条；那份浮层改到组件里补 -->
        <!-- 筛选条：时间预设 + 状态 + 渠道 + 模型 + KEY（改任一项回到第 1 页） -->
        <div class="filter-bar">
          <div class="chips">
            <button v-for="r in RANGES" :key="r.value" class="chip" :class="{ active: range === r.value }" @click="range = r.value">{{ r.label }}</button>
          </div>
          <select class="f-select" v-model="status" style="width: 108px">
            <option value="">全部状态</option>
            <option value="ok">仅成功</option>
            <option value="fail">仅失败</option>
          </select>
          <select class="f-select" v-model="channel" style="width: 150px">
            <option value="">全部渠道</option>
            <option v-for="c in ov?.tops.channel || []" :key="c.name" :value="c.name">{{ channelName(c.name) }}</option>
          </select>
          <select class="f-select" v-model="model" style="width: 190px">
            <option value="">全部模型</option>
            <option v-for="m in ov?.tops.model || []" :key="m.name" :value="m.name">{{ m.name }}</option>
          </select>
          <select class="f-select" v-model="keyId" style="width: 150px">
            <option value="">全部 KEY</option>
            <option v-for="k in keyOptions" :key="k.id" :value="k.id">{{ k.name }}</option>
          </select>
        </div>
        <RequestLogTable :rows="detail?.rows || []" scope="stats" @detail="openDetail" />
        <div class="pager">
          <button class="btn btn-sm" :disabled="page <= 1" @click="goPage(page - 1)">上一页</button>
          <button class="btn btn-sm" :disabled="page >= totalPages" @click="goPage(page + 1)">下一页</button>
          <span class="pager-info">第 {{ page }}/{{ totalPages }} 页</span>
        </div>
      </div>
    </div>

    <!-- 清理确认弹窗：按设置页保留期删旧流水（不可恢复，删前问一道） -->
    <Teleport to="body">
      <div v-if="cleanOpen" class="p-mask" @click.self="cleanOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">清理请求流水</div>
          <div class="set-desc">
            将删除保留期（设置页当前为 {{ app.config.proxy.usageRetentionDays }} 天）之前的全部请求流水，此操作不可恢复。
          </div>
          <div class="p-actions">
            <button class="btn" @click="cleanOpen = false">取消</button>
            <button class="btn btn-primary danger-solid" :disabled="cleaning" @click="doCleanup">{{ cleaning ? "清理中…" : "确认清理" }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <RequestDetailDialog :req="detailReq" @close="detailReq = null" />
    <Teleport to="body">
      <div v-if="detailLoading" class="p-mask" style="background: transparent"><div class="set-desc">加载详情…</div></div>
    </Teleport>
  </section>
</template>

<style scoped>
/* 页头标题化已去除：入口按钮与统计范围贴正文顶部右侧 */
.toolbar {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
.tip-card {
  margin-bottom: 12px;
  border-color: var(--accent);
}
.kpis-6 {
  grid-template-columns: repeat(6, minmax(0, 1fr));
}
.trend {
  width: 100%;
  height: 96px;
  display: block;
}
.trend-line {
  fill: none;
  stroke: var(--accent);
  stroke-width: 1.5;
}
.trend-area {
  fill: var(--accent-dim, rgba(68, 224, 127, 0.12));
  stroke: none;
}
.trend-days {
  display: flex;
  justify-content: space-around;
  font-size: 10px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  padding: 0 0 8px;
}
.pager {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
}
.pager-info {
  font-size: 11px;
  color: var(--text-3);
  font-family: var(--font-mono);
}
</style>
