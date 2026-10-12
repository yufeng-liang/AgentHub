<!-- 积分日历（原「积分到期」，方案 Q3c）：把所有渠道所有账号的积分包拉平，按到期升序统一呈现，
     一屏看清「哪些包快过期了」。分级配色与号池页展开明细一致（主进程按 expiringSoonDays 派生）。
     默认档「有余额」滤掉剩余为 0 的包——已用完的包再谈到期没有信息量（2026-09-29）。
     两条后加的口径（2026-10-12）：
       · 上游不拆包的渠道（catpaw / cline / autoclaw / raccoon / lobster / modelscope / qoder 家）
         按账号出一条聚合行，日历因此覆盖全部有额度概念的渠道；
       · 过期满 STALE_EXPIRED_DAYS 天的行退出默认视图（几天前的过期包只剩刷屏价值），
         收进「历史过期积分」按钮，一行都不丢。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ProxyChannelView, ProxyCreditPackage } from "../../types";
import { useAppStore } from "../../stores/app";
import { coalesceAsync } from "../../utils/timing";
import { fmtDate, fmtBalancePair, pkgFallbackName } from "./format";
import {
  STATUS_OPTIONS,
  SORT_OPTIONS,
  STALE_EXPIRED_DAYS,
  aggregateRow,
  applyExpiryFilter,
  countByState,
  expiredDays,
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
let scheduleRefresh: (ReturnType<typeof coalesceAsync>) | undefined;

const statusFilter = ref<ExpiryStatusFilter>("usable");
const channelFilter = ref("all");
const sortKey = ref<ExpirySortKey>("expiryAsc");
/** 历史过期档：只看全部已过期（含默认视图自动隐藏的陈旧过期） */
const historyOpen = ref(false);

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

// 拉平：只取生态渠道（有积分/额度概念）的账号。有逐包明细的用逐包，没有的按账号出一条聚合行，
// 两者互斥所以不会重复计数；排序交给 applyExpiryFilter
const allRows = computed<ExpiryRow[]>(() => {
  const out: ExpiryRow[] = [];
  for (const ch of pool.value) {
    if (!isBuiltin(ch)) continue;
    for (const acc of ch.accounts) {
      const packs = acc.packages || [];
      if (packs.length) {
        for (const [i, pkg] of packs.entries()) {
          // key 带下标：同一账号两个包的 code 可能同为空/相同，仅 code 作 key 会撞
          out.push({ key: `${acc.id}:${i}:${pkg.code || ""}`, channelId: ch.id, channelDisplay: ch.display, accountName: acc.name || "（未命名）", pkg });
        }
        continue;
      }
      const agg = aggregateRow(ch.id, ch.display, acc);
      if (agg) out.push(agg);
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

const rows = computed(() =>
  applyExpiryFilter(allRows.value, { status: statusFilter.value, channelId: channelFilter.value, sort: sortKey.value, history: historyOpen.value }, Date.now()),
);

// 聚合标签走全量：它们是总览数字，不随筛选变化
const summary = computed(() => countByState(allRows.value));

/** 全部已过期条数（不随渠道筛选变）：按钮上的总数，也是历史档的分母 */
const historyCount = computed(() => applyExpiryFilter(allRows.value, { status: "all", channelId: "all", sort: "expiryAsc", history: true }, Date.now()).length);

/** 被「过期满 2 天」规则收起的条数：与「全部」档相减即得，所以判据只能是这一条规则在生效 */
const staleHidden = computed(() => allRows.value.length - applyExpiryFilter(allRows.value, { status: "all", channelId: "all", sort: "expiryAsc" }, Date.now()).length);

function daysText(pkg: ProxyCreditPackage): string {
  if (!pkg.expiresAt) return "长期";
  const gone = expiredDays(pkg, Date.now());
  if (gone >= 0) return gone === 0 ? "刚过期" : `过期 ${gone} 天`;
  return `剩 ${Math.max(1, Math.ceil((pkg.expiresAt - Date.now()) / 86400000))} 天`;
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
  // 主进程批量签到/额度刷新时逐账号广播 credits/status 事件，裸调 refresh 会打出 N 次
  // proxyPool IPC + N 次全表重渲染（号池页/总览页已同款合流，这里是第三处）
  scheduleRefresh = coalesceAsync(refresh, 1200);
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event !== "proxy") return;
    if ((p.type === "credits" || p.type === "status") && active.value) scheduleRefresh?.();
  });
});
onUnmounted(() => {
  if (offEvent) offEvent();
  scheduleRefresh?.cancel();
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div class="expiry-head">
        <div class="expiry-title">
          <h2>积分日历</h2>
          <span class="hint">所有渠道的积分包 / Token 套餐按到期时间升序（长期有效排最后）；预警阈值在「设置」里调整</span>
        </div>
        <div class="expiry-actions">
          <span class="agg-tag tag-err" v-if="summary.expired">已过期 {{ summary.expired }}</span>
          <span class="agg-tag tag-warn" v-if="summary.soon">即将到期 {{ summary.soon }}</span>
          <span class="agg-tag tag-dim" v-if="summary.used">已用完 {{ summary.used }}</span>
          <span class="agg-tag tag-ok" v-if="summary.ok">生效中 {{ summary.ok }}</span>
          <button v-if="historyCount" class="btn btn-sm" :class="{ 'btn-primary': historyOpen }" @click="historyOpen = !historyOpen">
            {{ historyOpen ? "返回日历" : "历史过期积分" }}
          </button>
          <button class="btn btn-sm" :disabled="loading" @click="refresh">{{ loading ? "刷新中…" : "刷新" }}</button>
        </div>
      </div>

      <div v-if="err" class="expiry-err">{{ err }}</div>

      <div class="expiry-filters">
        <!-- 历史档只看已过期，status 维度对它没有意义；与其摆一个点不动的下拉，不如换成说明性标签 -->
        <span v-if="historyOpen" class="hist-chip">全部已过期积分包</span>
        <el-select v-else v-model="statusFilter" class="f-el-select" popper-class="glass-popper" style="width: 118px">
          <el-option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
        </el-select>
        <el-select v-model="channelFilter" class="f-el-select" popper-class="glass-popper" style="width: 170px">
          <el-option value="all" label="全部渠道" />
          <el-option v-for="o in channelOptions" :key="o.value" :value="o.value" :label="o.label" />
        </el-select>
        <el-select v-model="sortKey" class="f-el-select" popper-class="glass-popper" style="width: 140px">
          <el-option v-for="o in SORT_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
        </el-select>
        <span class="expiry-count">显示 {{ rows.length }} / {{ historyOpen ? historyCount : summary.total }} 条</span>
        <span v-if="staleHidden && !historyOpen" class="expiry-count">已过期满 {{ STALE_EXPIRED_DAYS }} 天的 {{ staleHidden }} 条已收起</span>
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
                   「/ —」是上游不给总额（账号级聚合行等），与「不限」哨兵不是一回事 -->
              <td class="mono num">{{ fmtBalancePair(r.pkg.remaining, r.pkg.total, r.channelId) }}</td>
              <td class="mono">{{ r.pkg.expiresAt ? fmtDate(r.pkg.expiresAt) : "长期" }}</td>
              <td class="mono num">{{ daysText(r.pkg) }}</td>
              <td><span class="tag" :class="statusCls(r.pkg)">{{ statusText(r.pkg) }}</span></td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="6" style="text-align: center; color: var(--text-3); padding: 18px">
                {{
                  historyOpen
                    ? "没有已过期记录"
                    : summary.total
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
/* 历史档顶替 status 下拉的标签：与 .f-el-select .el-select__wrapper 同一套盒子，
   切档时筛选行不跳位 */
.hist-chip {
  display: inline-flex;
  align-items: center;
  min-height: 34px;
  padding: 0 10px;
  font-size: 13px;
  color: var(--text-3);
  background: var(--bg-soft);
  border-radius: var(--r-sm);
  box-shadow: 0 0 0 1px var(--line-strong) inset;
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
/* 数值列表头与 td.num 同侧（全站对齐规范）。必须写在本组件里：scoped 的
   .expiry-tbl th[data-v] 特异性高于全局 th.num，不补这条表头会被压回左对齐 */
.expiry-tbl th.num {
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
