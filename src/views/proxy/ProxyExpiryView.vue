<!-- 积分到期总览（方案 Q3c）：把所有渠道所有账号的积分包拉平，按到期升序统一呈现，
     一屏看清「哪些包快过期了」。分级配色与号池页展开明细一致（主进程按 expiringSoonDays 派生）。
     默认档「有余额」滤掉剩余为 0 的包——已用完的包再谈到期没有信息量（2026-09-29）。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ProxyChannelView, ProxyCreditPackage } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtDate, fmtBalance, balanceUnit, pkgFallbackName } from "./format";
import {
  STATUS_OPTIONS,
  SORT_OPTIONS,
  applyExpiryFilter,
  countByState,
  statusOf,
  type ExpiryRow,
  type ExpirySortKey,
  type ExpiryStatusFilter,
} from "./expiryRows";

const app = useAppStore();
const active = computed(() => app.activeModule === "proxy" && app.activePage === "expiry");

const pool = ref<ProxyChannelView[]>([]);
const loading = ref(false);
const err = ref("");
let offEvent: (() => void) | undefined;

const statusFilter = ref<ExpiryStatusFilter>("usable");
const channelFilter = ref("all");
const sortKey = ref<ExpirySortKey>("expiryAsc");

function isBuiltin(ch: ProxyChannelView) {
  return ch.kind !== "openai_compat";
}

async function refresh() {
  loading.value = true;
  err.value = "";
  try {
    pool.value = await api.proxyPool();
  } catch (e) {
    err.value = String((e as Error)?.message || e);
  } finally {
    loading.value = false;
  }
}

// 拉平：只取生态渠道（有积分包概念）里已刷出包的账号；排序交给 applyExpiryFilter
const allRows = computed<ExpiryRow[]>(() => {
  const out: ExpiryRow[] = [];
  for (const ch of pool.value) {
    if (!isBuiltin(ch)) continue;
    for (const acc of ch.accounts) {
      for (const [i, pkg] of (acc.packages || []).entries()) {
        out.push({ key: `${acc.id}:${pkg.code || i}`, channelId: ch.id, channelDisplay: ch.display, accountName: acc.name || "（未命名）", pkg });
      }
    }
  }
  return out;
});

const channelOptions = computed(() => {
  const seen = new Map<string, string>();
  for (const r of allRows.value) if (!seen.has(r.channelId)) seen.set(r.channelId, r.channelDisplay);
  return [...seen].map(([value, label]) => ({ value, label }));
});

// 选中的渠道从号池消失后（渠道被删/改）回落「全部」，免得下拉里显示裸 id
watch(channelOptions, (opts) => {
  if (channelFilter.value !== "all" && !opts.some((o) => o.value === channelFilter.value)) channelFilter.value = "all";
});

const rows = computed(() => applyExpiryFilter(allRows.value, { status: statusFilter.value, channelId: channelFilter.value, sort: sortKey.value }));

// 聚合标签走全量：它们是总览数字，不随筛选变化
const summary = computed(() => countByState(allRows.value));

function daysText(pkg: ProxyCreditPackage): string {
  if (!pkg.expiresAt) return "长期";
  if (pkg.expired) return "已过期";
  const d = Math.max(1, Math.ceil((pkg.expiresAt - Date.now()) / 86400000));
  return `剩 ${d} 天`;
}
function statusCls(pkg: ProxyCreditPackage): string {
  switch (statusOf(pkg)) {
    case "expired":
      return "tag-err";
    case "soon":
      return "tag-warn";
    case "used":
      return "tag-dim";
    default:
      return "tag-ok";
  }
}
function statusText(pkg: ProxyCreditPackage): string {
  switch (statusOf(pkg)) {
    case "expired":
      return "已过期";
    case "soon":
      return "即将到期";
    case "used":
      return "已用完";
    default:
      return "生效中";
  }
}
function rowCls(pkg: ProxyCreditPackage): string {
  switch (statusOf(pkg)) {
    case "expired":
      return "row-expired";
    case "soon":
      return "row-soon";
    case "used":
      return "row-used";
    default:
      return "";
  }
}

onMounted(() => {
  refresh();
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event !== "proxy") return;
    if ((p.type === "credits" || p.type === "status") && active.value) refresh();
  });
});
onUnmounted(() => {
  if (offEvent) offEvent();
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div class="expiry-head">
        <div class="expiry-title">
          <h2>积分到期总览</h2>
          <span class="hint">所有渠道的积分包 / Token 套餐按到期时间升序（长期有效排最后）；预警阈值在「设置」里调整</span>
        </div>
        <div class="expiry-actions">
          <span class="agg-tag tag-err" v-if="summary.expired">已过期 {{ summary.expired }}</span>
          <span class="agg-tag tag-warn" v-if="summary.soon">即将到期 {{ summary.soon }}</span>
          <span class="agg-tag tag-dim" v-if="summary.used">已用完 {{ summary.used }}</span>
          <span class="agg-tag tag-ok" v-if="summary.ok">生效中 {{ summary.ok }}</span>
          <button class="btn btn-sm" :disabled="loading" @click="refresh">{{ loading ? "刷新中…" : "刷新" }}</button>
        </div>
      </div>

      <div v-if="err" class="expiry-err">{{ err }}</div>

      <div class="expiry-filters">
        <el-select v-model="statusFilter" class="f-el-select" popper-class="glass-popper" style="width: 118px">
          <el-option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
        </el-select>
        <el-select v-model="channelFilter" class="f-el-select" popper-class="glass-popper" style="width: 170px">
          <el-option value="all" label="全部渠道" />
          <el-option v-for="o in channelOptions" :key="o.value" :value="o.value" :label="o.label" />
        </el-select>
        <el-select v-model="sortKey" class="f-el-select" popper-class="glass-popper" style="width: 140px">
          <el-option v-for="o in SORT_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
        </el-select>
        <span class="expiry-count">显示 {{ rows.length }} / {{ summary.total }} 条</span>
      </div>

      <div class="tbl-wrap">
        <table class="tbl expiry-tbl">
          <tbody>
            <tr>
              <th>渠道 · 账号</th><th>包名</th><th class="num">剩余 / 总额</th><th>到期</th><th class="num">剩余天数</th><th>状态</th>
            </tr>
            <tr v-for="r in rows" :key="r.key" :class="rowCls(r.pkg)">
              <td>
                <div class="src-ch">{{ r.channelDisplay }}</div>
                <div class="src-acc">{{ r.accountName }}</div>
              </td>
              <el-tooltip :content="r.pkg.name" :disabled="!r.pkg.name" placement="top">
                <td>{{ r.pkg.name || pkgFallbackName(r.channelId) }}</td>
              </el-tooltip>
              <!-- 逐行带单位：Token 渠道（zcode 家）过 fmtToken 换算，积分渠道原值；
                   两头都是「不限」(-1) 时不缀单位 -->
              <td class="mono num">{{ fmtBalance(r.pkg.remaining, r.channelId) }} / {{ fmtBalance(r.pkg.total, r.channelId) }}<template v-if="r.pkg.remaining !== -1 || r.pkg.total !== -1"> {{ balanceUnit(r.channelId) }}</template></td>
              <td class="mono">{{ r.pkg.expiresAt ? fmtDate(r.pkg.expiresAt) : "长期" }}</td>
              <td class="mono num">{{ daysText(r.pkg) }}</td>
              <td><span class="tag" :class="statusCls(r.pkg)">{{ statusText(r.pkg) }}</span></td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="6" style="text-align: center; color: var(--text-3); padding: 18px">
                {{
                  summary.total
                    ? "当前筛选条件下没有匹配的套餐/积分包"
                    : "暂无套餐数据 —— 到「号池」页刷新生态渠道账号后，这里会列出各积分包 / Token 套餐的到期时间"
                }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.expiry-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.expiry-title h2 {
  margin: 0 0 2px;
  font-size: 16px;
}
.expiry-title .hint {
  font-size: 12px;
  color: var(--text-3);
}
.expiry-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.expiry-filters {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}
.expiry-count {
  font-size: 12px;
  color: var(--text-3);
}
.agg-tag {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 10px;
}
.expiry-err {
  color: var(--danger, #e5484d);
  font-size: 13px;
  margin-bottom: 8px;
}
.expiry-tbl {
  width: 100%;
  border-collapse: collapse;
}
.expiry-tbl th {
  text-align: left;
  font-weight: 500;
  color: var(--text-3);
  padding: 6px 10px;
  font-size: 12px;
}
.expiry-tbl td {
  padding: 6px 10px;
  border-top: 1px solid var(--border, rgba(127, 127, 127, 0.15));
  font-size: 13px;
}
.expiry-tbl td.num {
  text-align: right;
}
.src-ch {
  font-size: 12px;
  color: var(--text-3);
}
.src-acc {
  font-weight: 500;
}
.row-expired {
  background: var(--danger-bg, rgba(229, 72, 77, 0.08));
}
.row-soon {
  background: var(--warn-bg, rgba(245, 176, 65, 0.08));
}
.row-used {
  background: rgba(127, 127, 127, 0.06);
}
</style>
