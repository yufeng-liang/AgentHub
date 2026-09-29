<!-- 积分到期总览（方案 Q3c）：把所有渠道所有账号的积分包拉平，按到期升序统一呈现，
     一屏看清「哪些包快过期了」。分级配色与号池页展开明细一致（主进程按 expiringSoonDays 派生）。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import * as api from "../../api/ipc";
import type { ProxyChannelView, ProxyCreditPackage } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtInt, fmtDate } from "./format";

const app = useAppStore();
const active = computed(() => app.activeModule === "proxy" && app.activePage === "expiry");

const pool = ref<ProxyChannelView[]>([]);
const loading = ref(false);
const err = ref("");
let offEvent: (() => void) | undefined;

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

interface ExpiryRow {
  key: string;
  channelDisplay: string;
  accountName: string;
  pkg: ProxyCreditPackage;
}

// 拉平：只取生态渠道（有积分包概念）里已刷出包的账号
const rows = computed<ExpiryRow[]>(() => {
  const out: ExpiryRow[] = [];
  for (const ch of pool.value) {
    if (!isBuiltin(ch)) continue;
    for (const acc of ch.accounts) {
      for (const [i, pkg] of (acc.packages || []).entries()) {
        out.push({ key: `${acc.id}:${pkg.code || i}`, channelDisplay: ch.display, accountName: acc.name || "（未命名）", pkg });
      }
    }
  }
  // 到期升序；无到期(0=长期)排最后；同到期按剩余降序
  out.sort((a, b) => {
    const ea = a.pkg.expiresAt || Number.POSITIVE_INFINITY;
    const eb = b.pkg.expiresAt || Number.POSITIVE_INFINITY;
    if (ea !== eb) return ea - eb;
    const ra = a.pkg.remaining === -1 ? Number.POSITIVE_INFINITY : a.pkg.remaining;
    const rb = b.pkg.remaining === -1 ? Number.POSITIVE_INFINITY : b.pkg.remaining;
    return rb - ra;
  });
  return out;
});

const summary = computed(() => {
  let expired = 0;
  let soon = 0;
  let ok = 0;
  for (const r of rows.value) {
    if (r.pkg.expired) expired++;
    else if (r.pkg.expiringSoon) soon++;
    else ok++;
  }
  return { expired, soon, ok, total: rows.value.length };
});

function daysText(pkg: ProxyCreditPackage): string {
  if (!pkg.expiresAt) return "长期";
  if (pkg.expired) return "已过期";
  const d = Math.max(1, Math.ceil((pkg.expiresAt - Date.now()) / 86400000));
  return `剩 ${d} 天`;
}
function statusCls(pkg: ProxyCreditPackage): string {
  if (pkg.expired) return "tag-err";
  if (pkg.expiringSoon) return "tag-warn";
  return "tag-dim";
}
function statusText(pkg: ProxyCreditPackage): string {
  if (pkg.expired) return "已过期";
  if (pkg.expiringSoon) return "即将到期";
  return "生效中";
}
function amount(v: number): string {
  return v === -1 ? "不限" : fmtInt(v);
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
          <span class="hint">所有渠道积分包按到期时间升序（长期有效排最后）；预警阈值在「设置」里调整</span>
        </div>
        <div class="expiry-actions">
          <span class="agg-tag tag-err" v-if="summary.expired">已过期 {{ summary.expired }}</span>
          <span class="agg-tag tag-warn" v-if="summary.soon">即将到期 {{ summary.soon }}</span>
          <span class="agg-tag tag-dim">生效中 {{ summary.ok }}</span>
          <button class="btn btn-sm" :disabled="loading" @click="refresh">{{ loading ? "刷新中…" : "刷新" }}</button>
        </div>
      </div>

      <div v-if="err" class="expiry-err">{{ err }}</div>

      <div class="tbl-wrap">
        <table class="tbl expiry-tbl">
          <tbody>
            <tr>
              <th>渠道 · 账号</th><th>积分包</th><th>剩余 / 总额</th><th>到期</th><th>剩余天数</th><th>状态</th>
            </tr>
            <tr v-for="r in rows" :key="r.key" :class="{ 'row-expired': r.pkg.expired, 'row-soon': !r.pkg.expired && r.pkg.expiringSoon }">
              <td>
                <div class="src-ch">{{ r.channelDisplay }}</div>
                <div class="src-acc">{{ r.accountName }}</div>
              </td>
              <el-tooltip :content="r.pkg.name" :disabled="!r.pkg.name" placement="top">
                <td>{{ r.pkg.name || "积分包" }}</td>
              </el-tooltip>
              <td class="mono num">{{ amount(r.pkg.remaining) }} / {{ amount(r.pkg.total) }}</td>
              <td class="mono">{{ r.pkg.expiresAt ? fmtDate(r.pkg.expiresAt) : "长期" }}</td>
              <td class="mono num">{{ daysText(r.pkg) }}</td>
              <td><span class="tag" :class="statusCls(r.pkg)">{{ statusText(r.pkg) }}</span></td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="6" style="text-align: center; color: var(--text-3); padding: 18px">
                暂无积分包数据 —— 到「号池」页刷新生态渠道账号后，这里会列出各积分包的到期时间
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
</style>
