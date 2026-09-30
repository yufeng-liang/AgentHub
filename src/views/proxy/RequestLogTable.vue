<!-- 请求日志表（总览实时流 / 用量统计明细共用）：可见列由父页经 visible prop 传入
     （列设置按钮在父页卡片标题行，见 ColSettingsMenu.vue），
     失败状态徽标与错误摘要可点开详情，用量格第二行展示缓存读取与命中率（agent2api 口径：
     「-」= 上游未上报缓存字段，「0%」= 上报了但命中为 0，两者必须分开）。
     提示浮层一律 el-tooltip（上游 v1.38.0 口径），原生 title 在本页不许复活：
     content 可能为空时必须 :disabled，否则会飘出一个空玻璃泡——原生 title 给空串是不显示，
     这两档语义得对齐。骨架屏同页共用，首屏拉取时先占位再落数据 -->
<script setup lang="ts">
import { computed } from "vue";
import type { ProxyUsageRow } from "../../types";
import { fmtInt, fmtMs, fmtTime, fmtDate, channelName, statusCls, balanceUnit } from "./format";
import { LOG_COLS } from "./logCols";

const props = defineProps<{ rows: ProxyUsageRow[]; scope: "home" | "stats"; loading?: boolean; visible: string[] }>();
const emit = defineEmits<{ (e: "detail", row: ProxyUsageRow): void }>();

const cols = computed(() => LOG_COLS[props.scope].filter((c) => props.visible.includes(c.id)));
const colCount = computed(() => cols.value.length + 1); // + 尾部固定的「详情」按钮列

function cacheRate(r: ProxyUsageRow): string {
  if (r.cachedTokens < 0 || !r.promptTokens) return "-";
  return Math.round((r.cachedTokens / r.promptTokens) * 1000) / 10 + "%";
}
const failed = (r: ProxyUsageRow) => !(r.status >= 200 && r.status < 300);
// 无上游改写时不再复读模型名：原生 title 时代它是「格子看不全时的补充」，
// 换成 280px 玻璃浮层后复读就是纯噪声，所以无映射即无提示
const modelTip = (r: ProxyUsageRow) =>
  r.modelUpstream && r.modelUpstream !== r.model ? `客户端 ${r.model} → 上游 ${r.modelUpstream}` : "";
const statusTip = (r: ProxyUsageRow) =>
  failed(r) ? `${r.error || "失败"}（点击查看详细报错）` : r.error || "";
const errTip = (r: ProxyUsageRow) =>
  `${r.error}${r.hasErrorBody ? "（点击查看上游响应体）" : ""}`;

// 骨架屏：列可配置，所以宽度按列查表（上游那张内联表是写死 8 列的）
const SKEL_W: Record<string, string> = {
  time: "62px", model: "140px", channel: "84px", key: "76px", account: "84px", status: "44px",
  usage: "124px", credits: "50px", ttft: "50px", latency: "50px", attempts: "38px", error: "160px",
};
const skelW = (id: string) => SKEL_W[id] || "70px";
const emptyText = computed(() =>
  props.scope === "home" ? "暂无请求记录 —— 用上方地址发起第一个请求即出现在这里" : "暂无请求记录");
</script>

<template>
  <div class="rlt-root">
    <div class="tbl-wrap">
      <table class="tbl">
        <tbody>
          <tr>
            <th v-for="c in cols" :key="c.id">{{ c.label }}</th>
            <th class="rlt-op"></th>
          </tr>
          <template v-if="loading && !rows.length">
            <tr v-for="n in 5" :key="'sk' + n">
              <td v-for="c in cols" :key="c.id"><div class="skeleton" :style="{ height: '15px', width: skelW(c.id) }"></div></td>
              <td class="rlt-op"><div class="skeleton" style="height: 15px; width: 40px; margin-left: auto"></div></td>
            </tr>
          </template>
          <tr v-for="r in rows" :key="r.id">
            <template v-for="c in cols" :key="c.id">
              <el-tooltip v-if="c.id === 'time'" :content="fmtDate(r.ts)" placement="top">
                <td class="mono">{{ fmtTime(r.ts) }}</td>
              </el-tooltip>
              <el-tooltip v-else-if="c.id === 'model'" :content="modelTip(r)" :disabled="!modelTip(r)" placement="top">
                <td class="mono">{{ r.model || "-" }}</td>
              </el-tooltip>
              <td v-else-if="c.id === 'channel'">{{ channelName(r.channel) || "-" }}</td>
              <td v-else-if="c.id === 'key'" class="mono">{{ r.keyName || "-" }}</td>
              <td v-else-if="c.id === 'account'">{{ r.accountName || "-" }}</td>
              <td v-else-if="c.id === 'status'">
                <el-tooltip :content="statusTip(r)" :disabled="!statusTip(r)" placement="top">
                  <span
                    class="tag" :class="[statusCls(r.status), { clickable: failed(r) }]"
                    @click="failed(r) && emit('detail', r)"
                  >{{ r.status || "-" }}</span>
                </el-tooltip>
              </td>
              <td v-else-if="c.id === 'usage'" class="mono usage-cell">
                <div>in {{ fmtInt(r.promptTokens) }} / out {{ fmtInt(r.completionTokens) }}</div>
                <div class="usage-sub" :class="{ na: r.cachedTokens < 0 }">缓存 {{ r.cachedTokens < 0 ? "-" : fmtInt(r.cachedTokens) }} · 命中 {{ cacheRate(r) }}</div>
              </td>
              <el-tooltip
                v-else-if="c.id === 'credits'"
                :content="r.creditsUsed < 0 ? '上游未上报消耗' + balanceUnit(r.channel) : '上游实报消耗' + balanceUnit(r.channel)"
                placement="top"
              >
                <td class="mono">{{ r.creditsUsed < 0 ? "-" : fmtInt(r.creditsUsed) }}</td>
              </el-tooltip>
              <td v-else-if="c.id === 'ttft'" class="mono">{{ fmtMs(r.ttftMs) }}</td>
              <td v-else-if="c.id === 'latency'" class="mono">{{ fmtMs(r.latencyMs) }}</td>
              <td v-else-if="c.id === 'attempts'" class="mono">
                <el-tooltip v-if="r.attempts > 1" content="换号/限流重试后成功（或最终失败）" placement="top">
                  <span class="tag tag-warn">×{{ r.attempts }}</span>
                </el-tooltip>
                <template v-else>{{ r.attempts || "-" }}</template>
              </td>
              <td v-else-if="c.id === 'error'" class="rlt-err">
                <el-tooltip v-if="r.error" :content="errTip(r)" placement="top">
                  <span class="rlt-err-text" @click="emit('detail', r)">{{ r.error }}</span>
                </el-tooltip>
                <template v-else>-</template>
              </td>
            </template>
            <td class="rlt-op"><button class="btn btn-sm" @click="emit('detail', r)">详情</button></td>
          </tr>
          <tr v-if="!rows.length && !loading">
            <td :colspan="colCount" class="rlt-empty">{{ emptyText }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
/* 表头对齐内容：global 的表头对齐规范默认左对齐，本表无需再覆盖；
   操作列（表头空 + 详情按钮）保持右对齐 */
.tbl th.rlt-op {
  text-align: right !important;
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
