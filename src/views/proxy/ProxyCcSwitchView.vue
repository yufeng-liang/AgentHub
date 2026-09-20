<!-- 反代网关 · 生态接入（CC Switch）：把 AgentHub 网关注册为 CC Switch 的 provider 条目，
     上游格式 = OpenAI Chat Completions（http://127.0.0.1:{port}/v1），Claude Code / Codex 的原生协议
     由 CC Switch 翻译后再打到网关；注册前自动备份 CC Switch 数据库，且只 upsert 固定 id 条目 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import * as api from "../../api/ipc";
import type { CcSwitchStatus, CcSwitchRegisterResult, ProxyKeyRow } from "../../types";
import { useAppStore } from "../../stores/app";

const app = useAppStore();
const st = ref<CcSwitchStatus | null>(null);
const keys = ref<ProxyKeyRow[]>([]);
const keyId = ref("");
const model = ref("");
const busy = ref<"claude" | "codex" | "">("");
const result = ref<CcSwitchRegisterResult | null>(null);
const err = ref("");
const saved = ref(false); // 默认模型已写回配置

const installed = computed(() => !!st.value?.installed);
const incompatible = computed(() => !!st.value?.incompatible);
const port = computed(() => app.config?.proxy?.port ?? 9527);
const keyOpts = computed(() => keys.value.filter((k) => k.enabled));
/** 模型占位：未填时用全局回退模型 */
const fallback = computed(() => app.config?.proxy?.fallbackModel || "");

function entry(appType: "claude" | "codex") {
  return (st.value?.entries || []).find((x) => x.appType === appType);
}

async function refresh() {
  try {
    st.value = await api.proxyCcSwitchStatus();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

async function loadKeys() {
  try {
    keys.value = (await api.proxyKeysList()) || [];
    if (!keyId.value && keyOpts.value.length) keyId.value = keyOpts.value[0].id;
  } catch {
    /* Key 列表失败不阻断页面（空态提示去 API Keys 页） */
  }
}

async function register(appType: "claude" | "codex") {
  if (busy.value) return;
  busy.value = appType;
  err.value = "";
  result.value = null;
  try {
    const key = keys.value.find((k) => k.id === keyId.value);
    if (!key || !key.secret) {
      err.value = "请选择可用的网关 API Key（列表中的 Key 需要带完整密钥）";
      return;
    }
    const r = await api.proxyCcSwitchRegister({
      appType,
      apiKey: key.secret,
      model: (model.value || fallback.value || "").trim(),
      port: port.value,
    });
    if (r?.ok) {
      result.value = r;
      await refresh();
    } else {
      err.value = r?.message || "注册失败";
    }
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    busy.value = "";
  }
}

/** 默认模型写回配置（缺省用 fallbackModel），下次注册生效 */
function onModelChange() {
  if (!app.config?.proxy) return;
  app.config.proxy.ccSwitchModel = model.value.trim();
  saved.value = true;
  app.save().then(() => (saved.value = false)).catch(() => (saved.value = false));
}

onMounted(() => {
  model.value = ((app.config?.proxy?.ccSwitchModel || app.config?.proxy?.fallbackModel || "") as string).trim();
  refresh();
  loadKeys();
});
</script>

<template>
  <section class="page">
    <div class="page-head">
      <div>
        <div class="page-title">生态接入</div>
        <div class="page-sub">把 AgentHub 网关注册为 CC Switch 的 provider，Claude Code / Codex 的协议翻译由 CC Switch 完成</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-primary" :disabled="!installed || incompatible || busy === 'claude'" @click="register('claude')">
          {{ busy === "claude" ? "注册中…" : "注册 Claude Code" }}
        </button>
        <button class="btn btn-primary" :disabled="!installed || incompatible || busy === 'codex'" @click="register('codex')">
          {{ busy === "codex" ? "注册中…" : "注册 Codex" }}
        </button>
      </div>
    </div>
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>

      <div v-if="result && result.ok" class="card ok-card">
        <div class="set-desc">
          {{ result.action === "updated" ? "已更新已有条目" : "已注册新条目" }}：{{ result.appType === "claude" ? "Claude Code" : "Codex" }}
        </div>
        <div class="set-desc" style="margin-top: 6px">
          数据库：<span class="mono">{{ result.dbPath }}</span> · 写前备份：<span class="mono">{{ result.backupPath }}</span>
        </div>
        <div class="set-desc" style="margin-top: 6px">重启 CC Switch（或在其界面重新加载）使配置生效</div>
      </div>

      <!-- 接入状态与说明 -->
      <div class="card">
        <div class="card-title">
          CC Switch 接入状态
          <span class="right">
            <span v-if="!st" class="tag tag-dim">检测中…</span>
            <span v-else-if="!installed" class="tag tag-warn">未安装</span>
            <span v-else-if="incompatible" class="tag tag-warn">库异常</span>
            <span v-else class="tag tag-ok">已就绪</span>
          </span>
        </div>
        <div v-if="!st" class="set-desc">正在检测本机 CC Switch…</div>
        <div v-else-if="!installed" class="set-desc">
          未检测到 CC Switch：请先下载安装 cc-switch（GitHub：farion1231/cc-switch）并启动一次，再回到这里注册。
        </div>
        <div v-else-if="incompatible" class="set-desc">检测到 CC Switch 数据库但结构不符，可能版本过旧；注册时会有更具体的报错。</div>
        <div v-else class="set-desc">
          网关协议为 OpenAI Chat Completions（<span class="mono">http://127.0.0.1:{{ port }}/v1</span>）。Claude Code 与 Codex 的原生协议由
          CC Switch 翻译成 Chat Completions 再打到网关；每次注册前自动备份 CC Switch 数据库，且不修改其它 provider。
        </div>
        <div class="kpis" style="margin-top: 12px">
          <div class="kpi"><span>网关地址</span><b class="mono">127.0.0.1:{{ port }}/v1</b></div>
          <div class="kpi"><span>Claude Code</span><b>{{ entry("claude")?.registered ? "已注册" : "未注册" }}</b></div>
          <div class="kpi"><span>Codex</span><b>{{ entry("codex")?.registered ? "已注册" : "未注册" }}</b></div>
          <div class="kpi"><span>数据库</span><b class="mono">{{ st?.dbPath || "-" }}</b></div>
        </div>
      </div>

      <!-- 注册参数：Key / 默认模型 -->
      <div class="card" style="margin-top: 12px">
        <div class="card-title">注册参数</div>
        <div class="set-desc" style="margin-bottom: 10px">
          网关 Key 与默认模型会写入条目配置（Claude 条目同时覆盖 Sonnet / Opus / Haiku / 子代理等模型字段）；
          默认模型写回配置，对下次注册生效
        </div>
        <div v-if="keyOpts.length" class="co-row">
          <span class="co-label">网关 API Key</span>
          <select class="f-select" style="min-width: 300px" v-model="keyId">
            <option v-for="k in keyOpts" :key="k.id" :value="k.id">{{ k.name }} · {{ k.mask }}</option>
          </select>
        </div>
        <div v-else class="set-desc err-text">还没有可用的网关 Key，请先到「API Keys」页生成</div>
        <div class="co-row" style="margin-top: 10px">
          <span class="co-label">默认模型</span>
          <input v-model="model" class="input mono" style="width: 300px" placeholder="留空使用 fallbackModel：{{ fallback || '—' }}" @change="onModelChange" />
          <span v-if="saved" class="tag tag-ok">已保存</span>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.ok-card {
  margin-bottom: 12px;
  border-color: var(--ok, #2fa977);
}
.err-text {
  color: var(--err, #e05555);
}
.co-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.co-label {
  min-width: 110px;
  font-size: 13px;
  color: var(--text-2);
}
</style>