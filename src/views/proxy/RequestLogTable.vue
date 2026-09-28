<!-- 请求日志表（总览实时流 / 用量统计明细共用）：列设置按 scope 存 localStorage，
     失败状态徽标与错误摘要可点开详情，用量格第二行展示缓存读取与命中率（agent2api 口径：
     「-」= 上游未上报缓存字段，「0%」= 上报了但命中为 0，两者必须分开） -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import type { ProxyUsageRow } from "../../types";
import { fmtInt, fmtMs, fmtTime, fmtDate, channelName, statusCls } from "./format";

const props = defineProps<{ rows: ProxyUsageRow[]; scope: "home" | "stats" }>();
const emit = defineEmits<{ (e: "detail", row: ProxyUsageRow): void }>();

type ColDef = { id: string; label: string };
const COLS: Record<"home" | "stats", ColDef[]> = {
  home: [
    { id: "time", label: "时间" }, { id: "model", label: "模型" }, { id: "channel", label: "渠道" },
    { id: "key", label: "KEY" }, { id: "status", label: "状态" }, { id: "usage", label: "用量" },
    { id: "credits", label: "积分" }, { id: "ttft", label: "TTFT" }, { id: "latency", label: "耗时" },
  ],
  stats: [
    { id: "time", label: "时间" }, { id: "model", label: "模型" }, { id: "channel", label: "渠道" },
    { id: "key", label: "KEY" }, { id: "account", label: "账号" }, { id: "status", label: "状态" },
    { id: "usage", label: "用量" }, { id: "credits", label: "积分" }, { id: "ttft", label: "TTFT" },
    { id: "latency", label: "耗时" }, { id: "attempts", label: "重试" }, { id: "error", label: "错误" },
  ],
};

const LS_PREFIX = "agenthub.proxylog.";
const visible = ref<string[]>(loadCols());
function loadCols(): string[] {
  try {
    const raw = localStorage.getItem(LS_PREFIX + props.scope + ".cols");
    const saved = raw ? (JSON.parse(raw) as string[]) : null;
    const ids = COLS[props.scope].map((c) => c.id);
    const hit = (saved || []).filter((id) => ids.includes(id));
    return hit.length ? hit : ids; // 存过的列全被删光时回默认（防手改 localStorage 弄出空表）
  } catch {
    return COLS[props.scope].map((c) => c.id);
  }
}
watch(visible, (v) => {
  try { localStorage.setItem(LS_PREFIX + props.scope + ".cols", JSON.stringify(v)); } catch { /* 存不下就算了 */ }
}, { deep: true });

const cols = computed(() => COLS[props.scope].filter((c) => visible.value.includes(c.id)));
const colCount = computed(() => cols.value.length + 1); // + 尾部固定的「详情」按钮列

const settingsOpen = ref(false);
function toggleCol(id: string) {
  const has = visible.value.includes(id);
  if (has && visible.value.length <= 1) return; // 至少留一列，全关的表没有可读性
  visible.value = has
    ? visible.value.filter((x) => x !== id)
    : COLS[props.scope].map((c) => c.id).filter((x) => x === id || visible.value.includes(x));
}
function resetCols() {
  visible.value = COLS[props.scope].map((c) => c.id);
}
const onDocClick = () => { settingsOpen.value = false; };
onMounted(() => document.addEventListener("click", onDocClick));
onUnmounted(() => document.removeEventListener("click", onDocClick));

function cacheRate(r: ProxyUsageRow): string {
  if (r.cachedTokens < 0 || !r.promptTokens) return "-";
  return Math.round((r.cachedTokens / r.promptTokens) * 1000) / 10 + "%";
}
const failed = (r: ProxyUsageRow) => !(r.status >= 200 && r.status < 300);
const modelTip = (r: ProxyUsageRow) =>
  r.modelUpstream && r.modelUpstream !== r.model ? `客户端 ${r.model} → 上游 ${r.modelUpstream}` : r.model || "-";
</script>

<template>
  <div class="rlt-root">
    <div class="rlt-tools">
      <div class="rlt-settings-wrap" @click.stop>
        <button class="btn btn-sm" :class="{ 'btn-primary': settingsOpen }" @click="settingsOpen = !settingsOpen">
          <i class="ph ph-gear"></i> 列设置
        </button>
        <div v-if="settingsOpen" class="rlt-settings glass">
          <div class="rlt-set-head">显示列 <button class="btn btn-sm" @click="resetCols">恢复默认</button></div>
          <label v-for="c in COLS[scope]" :key="c.id" class="rlt-set-item">
            <input type="checkbox" :checked="visible.includes(c.id)" @change="toggleCol(c.id)" />{{ c.label }}
          </label>
        </div>
      </div>
    </div>
    <div class="tbl-wrap">
      <table class="tbl">
        <tbody>
          <tr>
            <th v-for="c in cols" :key="c.id">{{ c.label }}</th>
            <th class="rlt-op"></th>
          </tr>
          <tr v-for="r in rows" :key="r.id">
            <template v-for="c in cols" :key="c.id">
              <td v-if="c.id === 'time'" class="mono" :title="fmtDate(r.ts)">{{ fmtTime(r.ts) }}</td>
              <td v-else-if="c.id === 'model'" class="mono" :title="modelTip(r)">{{ r.model || "-" }}</td>
              <td v-else-if="c.id === 'channel'">{{ channelName(r.channel) || "-" }}</td>
              <td v-else-if="c.id === 'key'" class="mono">{{ r.keyName || "-" }}</td>
              <td v-else-if="c.id === 'account'">{{ r.accountName || "-" }}</td>
              <td v-else-if="c.id === 'status'">
                <span
                  class="tag" :class="[statusCls(r.status), { clickable: failed(r) }]"
                  :title="failed(r) ? `${r.error || '失败'}（点击查看详细报错）` : r.error"
                  @click="failed(r) && emit('detail', r)"
                >{{ r.status || "-" }}</span>
              </td>
              <td v-else-if="c.id === 'usage'" class="mono usage-cell">
                <div>in {{ fmtInt(r.promptTokens) }} / out {{ fmtInt(r.completionTokens) }}</div>
                <div class="usage-sub" :class="{ na: r.cachedTokens < 0 }">缓存 {{ r.cachedTokens < 0 ? "-" : fmtInt(r.cachedTokens) }} · 命中 {{ cacheRate(r) }}</div>
              </td>
              <td v-else-if="c.id === 'credits'" class="mono" :title="r.creditsUsed < 0 ? '上游未上报消耗积分' : '上游实报消耗积分'">
                {{ r.creditsUsed < 0 ? "-" : fmtInt(r.creditsUsed) }}
              </td>
              <td v-else-if="c.id === 'ttft'" class="mono">{{ fmtMs(r.ttftMs) }}</td>
              <td v-else-if="c.id === 'latency'" class="mono">{{ fmtMs(r.latencyMs) }}</td>
              <td v-else-if="c.id === 'attempts'" class="mono">
                <span v-if="r.attempts > 1" class="tag tag-warn" title="换号/限流重试后成功（或最终失败）">×{{ r.attempts }}</span>
                <template v-else>{{ r.attempts || "-" }}</template>
              </td>
              <td v-else-if="c.id === 'error'" class="rlt-err">
                <span
                  v-if="r.error" class="rlt-err-text" :title="`${r.error}${r.hasErrorBody ? '（点击查看上游响应体）' : ''}`"
                  @click="emit('detail', r)"
                >{{ r.error }}</span>
                <template v-else>-</template>
              </td>
            </template>
            <td class="rlt-op"><button class="btn btn-sm" @click="emit('detail', r)">详情</button></td>
          </tr>
          <tr v-if="!rows.length">
            <td :colspan="colCount" class="rlt-empty">暂无请求记录</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.rlt-tools {
  display: flex;
  justify-content: flex-end;
  padding: 0 0 6px;
}
.rlt-settings-wrap {
  position: relative;
}
.rlt-settings {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 60;
  min-width: 128px;
  padding: 8px;
  border-radius: var(--r-md, 8px);
  border: 1px solid var(--line);
}
.rlt-set-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 4px;
}
.rlt-set-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 3px 2px;
  cursor: pointer;
  white-space: nowrap;
}
.usage-cell {
  line-height: 1.5;
}
.usage-sub {
  font-size: 10px;
  color: var(--text-3);
}
.usage-sub.na {
  opacity: 0.6;
}
.tag.clickable {
  cursor: pointer;
  text-decoration: underline dotted;
  text-underline-offset: 2px;
}
.rlt-err {
  max-width: 220px;
}
.rlt-err-text {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
  color: var(--err, #e05555);
}
.rlt-err-text:hover {
  text-decoration: underline;
}
.rlt-op {
  white-space: nowrap;
  text-align: right;
}
.rlt-empty {
  text-align: center;
  color: var(--text-3);
  padding: 18px;
}
</style>
