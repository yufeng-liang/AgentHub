<!-- 请求详情弹窗（总览实时流 / 用量统计明细共用）：基础元数据 + token 明细（含缓存命中率）
     + 错误文案 + 上游错误响应体（失败请求落库的 ≤2KB 原文，可复制） -->
<script setup lang="ts">
import type { ProxyUsageDetail } from "../../types";
import { ref } from "vue";
import { fmtInt, fmtMs, fmtTime, fmtDate, channelName, statusCls } from "./format";

defineProps<{ req: ProxyUsageDetail | null }>();
const emit = defineEmits<{ (e: "close"): void }>();

const copied = ref(false);
async function copyBody(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1500);
  } catch { /* 剪贴板不可用就静默 */ }
}
function cacheRate(r: ProxyUsageDetail): string {
  if (r.cachedTokens < 0 || !r.promptTokens) return "-";
  return Math.round((r.cachedTokens / r.promptTokens) * 1000) / 10 + "%";
}
</script>

<template>
  <Teleport to="body">
    <div v-if="req" class="p-mask" @click.self="emit('close')">
      <div class="p-dlg glass req-dlg" role="dialog" aria-modal="true" aria-label="请求详情">
        <div class="p-title">
          请求详情
          <span class="tag" :class="statusCls(req.status)">{{ req.status || "-" }}</span>
          <button class="btn btn-sm dlg-close" @click="emit('close')">关闭</button>
        </div>

        <div class="kv-grid">
          <div class="kv"><span>req_id</span><b class="mono">{{ req.reqId || "-" }}</b></div>
          <div class="kv"><span>时间</span><b class="mono">{{ fmtDate(req.ts) }} {{ fmtTime(req.ts) }}</b></div>
          <div class="kv"><span>渠道</span><b>{{ channelName(req.channel) || "-" }}</b></div>
          <div class="kv"><span>KEY</span><b class="mono">{{ req.keyName || "-" }}</b></div>
          <div class="kv"><span>账号</span><b>{{ req.accountName || "-" }}</b></div>
          <div class="kv">
            <span>模型</span>
            <b class="mono">
              {{ req.model || "-" }}
              <template v-if="req.modelUpstream && req.modelUpstream !== req.model">
                <span class="model-arrow">→ {{ req.modelUpstream }}</span>
              </template>
            </b>
          </div>
          <div class="kv"><span>TTFT / 耗时</span><b class="mono">{{ fmtMs(req.ttftMs) }} / {{ fmtMs(req.latencyMs) }}</b></div>
          <div class="kv"><span>上游尝试</span><b class="mono">{{ req.attempts || "-" }} 次</b></div>
          <div class="kv">
            <span>Token</span>
            <b class="mono">
              in {{ fmtInt(req.promptTokens) }} · out {{ fmtInt(req.completionTokens) }}
              <span class="usage-sub">缓存 {{ req.cachedTokens < 0 ? "-" : fmtInt(req.cachedTokens) }}（{{ cacheRate(req) }}）· 写缓存 {{ req.cacheWriteTokens < 0 ? "-" : fmtInt(req.cacheWriteTokens) }}</span>
              <span class="usage-sub">消耗积分 {{ req.creditsUsed < 0 ? "-" : fmtInt(req.creditsUsed) }}<template v-if="req.creditsUsed < 0">（上游未上报）</template></span>
            </b>
          </div>
        </div>

        <template v-if="req.error">
          <div class="sec-title">错误</div>
          <pre class="err-pre">{{ req.error }}</pre>
        </template>
        <template v-if="req.errorBody">
          <div class="sec-title">
            上游响应体
            <button class="btn btn-sm" @click="copyBody(req.errorBody)">
              <i class="ph" :class="copied ? 'ph-check' : 'ph-copy'"></i> {{ copied ? "已复制" : "复制" }}
            </button>
          </div>
          <pre class="body-pre">{{ req.errorBody }}</pre>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.req-dlg {
  width: min(640px, calc(100vw - 48px));
  max-height: min(72vh, 640px);
  overflow: auto;
}
.dlg-close {
  margin-left: auto;
}
.kv-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px 18px;
  margin: 10px 0 4px;
}
.kv {
  display: flex;
  gap: 8px;
  align-items: baseline;
  font-size: 12px;
  min-width: 0;
}
.kv span {
  color: var(--text-3);
  flex: none;
  width: 72px;
}
.kv b {
  font-weight: 500;
  word-break: break-all;
}
.model-arrow {
  color: var(--warn);
}
.usage-sub {
  display: block;
  font-size: 10px;
  color: var(--text-3);
}
.sec-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-3);
  margin: 12px 0 4px;
}
.err-pre,
.body-pre {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--r-md, 8px);
  background: var(--bg-2, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--line);
  font-size: 11px;
  font-family: var(--font-mono);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 200px;
  overflow: auto;
}
.err-pre {
  color: var(--err, #e05555);
}
</style>
