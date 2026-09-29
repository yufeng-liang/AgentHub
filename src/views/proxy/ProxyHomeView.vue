<!-- 反代网关 · 总览：服务开关 / 地址 / 今日核心指标 / 渠道一览 / 实时请求流（方案 §7 index.html） -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import * as api from "../../api/ipc";
import type { ProxyGatewayStatus, ProxyUsageDetail, ProxyUsageRow } from "../../types";
import { useAppStore } from "../../stores/app";
import { fmtInt, fmtK, fmtMs, fmtTime, statusCls, fmtBalance, balanceUnit } from "./format";
import RequestLogTable from "./RequestLogTable.vue";
import RequestDetailDialog from "./RequestDetailDialog.vue";
import { coalesceAsync } from "../../utils/timing";

const app = useAppStore();
const st = ref<ProxyGatewayStatus | null>(null);
const recent = ref<ProxyUsageRow[]>([]);
const busy = ref(false);
const err = ref("");
// 详情弹窗：行上点「详情」或失败徽标/错误摘要 → 按 id 取单条（含上游错误响应体）
const detailReq = ref<ProxyUsageDetail | null>(null);
async function openDetail(row: ProxyUsageRow) {
  try {
    detailReq.value = await api.proxyStatsRequest(row.id);
  } catch { /* 网关不在时取不到：弹窗不开，不打断页面 */ }
}
// 后台网关起不来的显式错误态（Task 5 §七.1）：转发体回 {ok:false, message:"后台网关未能启动：…"}，
// 此时绝不能把状态对象当 gatewayStatus 塞进 st 让页面停在假死的空态——单独亮错误卡 + 重试按钮
const gwErr = ref("");
const loading = ref(false);

let offEvent: (() => void) | undefined;
let pollTimer: ReturnType<typeof setInterval> | undefined;

async function refresh() {
  if (!st.value) loading.value = true;
  try {
    const s = await api.proxyStatus();
    if (s && (s as { ok?: boolean }).ok === false) {
      gwErr.value = (s as { message?: string }).message || "后台网关未能启动";
      err.value = "";
      return;
    }
    st.value = s;
    recent.value = await api.proxyRecent(8);
    err.value = "";
    gwErr.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    loading.value = false;
  }
}

/** 只刷实时流：request 事件高频（2s 节流合并），全量 refresh 会连带 KPI 反复触发数字补间 */
let lastReqRefresh = 0;
async function refreshRecent() {
  const now = Date.now();
  if (now - lastReqRefresh < 2000) return;
  lastReqRefresh = now;
  try {
    recent.value = await api.proxyRecent(8);
  } catch { /* 网关掉线时静默：5s 轮询的 refresh() 会把错误亮出来 */ }
}

/** 重试启动：转发体在子进程不在时会对任意命令先拉起网关，重发一次 status 即完成拉起 */
async function retryGateway() {
  if (busy.value) return;
  busy.value = true;
  try {
    await refresh();
  } finally {
    busy.value = false;
  }
}

async function toggleService() {
  if (busy.value) return;
  busy.value = true;
  const wasRunning = !!st.value?.running;
  try {
    const r = wasRunning ? await api.proxyStop() : await api.proxyStart();
    if (r && (r as { ok?: boolean }).ok === false) err.value = (r as { message?: string }).message || "操作失败";
    else app.config.proxy.restoreOnLaunch = !wasRunning; // 后端已落盘，同步内存里的配置让配置页开关跟手
  } catch (e) {
    err.value = String((e as Error).message || e);
  } finally {
    busy.value = false;
    await refresh();
  }
}

/** 接入地址：状态里有就用，没有按配置拼一个兜底 */
const base = computed(() => st.value?.baseUrl || `http://${app.config.proxy.bind}:${app.config.proxy.port}/v1`);

const curlCmd = computed(
  () =>
    `curl ${base.value}/chat/completions \\\n` +
    `  -H "Authorization: Bearer sk-你的Key" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'`,
);
const pyCmd = computed(
  () =>
    `from openai import OpenAI\n\n` +
    `client = OpenAI(\n` +
    `    base_url="${base.value}",  # 网关地址，以 /v1 结尾\n` +
    `    api_key="sk-你的Key",\n` +
    `)\n` +
    `resp = client.chat.completions.create(\n` +
    `    model="deepseek-v4-flash",\n` +
    `    messages=[{"role": "user", "content": "你好"}],\n` +
    `)\n` +
    `print(resp.choices[0].message.content)`,
);

/** 快速上手四步 + 每步的问号提示（接入地址随端口/绑定配置实时联动） */
const steps = computed<{ id: string; title: string; desc: string; link?: boolean }[]>(() => [
  { id: "start", title: "启动网关服务", desc: "点页面上方的服务开关，状态变为 RUNNING 即可开始接收请求。" },
  { id: "key", title: "生成一个 API Key", desc: "到「API Keys」页点“生成 Key”，复制并保存好。", link: true },
  { id: "base", title: "记下接入地址", desc: `就是上方地址条里的 Base URL，当前为 ${base.value}。` },
  { id: "model", title: "在客户端填三项", desc: "接入地址、API Key、模型名，填完用下面的示例先发一条测试。" },
]);
const tips: Record<string, string> = {
  start: "服务启动后网关才开始转发请求；监听端口和绑定地址可以在「配置 → 反代网关」里修改，改完需要重新启动服务。",
  key: "API Key 相当于访问网关的密码，客户端用它证明身份。生成后可随时在 Key 列表里查看 / 复制完整 Key；泄露或丢失就删掉重新生成一个。",
  base: "同一个地址讲两种协议：OpenAI 兼容软件（Cursor / Cline / Roo / TRAE 等）直接填上面的 Base URL；<br />Claude Code 走 <span class=\"mono\">ANTHROPIC_BASE_URL</span>，它会把地址拼成 <span class=\"mono\">&lt;base&gt;/v1/messages</span>，所以要填<b>去掉末尾 /v1</b> 的形式（例如 http://127.0.0.1:9527），Key 填在 <span class=\"mono\">ANTHROPIC_AUTH_TOKEN</span>。<br />默认只监听本机；局域网其他设备访问需在「配置 → 反代网关」里改绑定地址。",
  model: "模型名要填网关实际提供的名称（在「模型目录」页能看到）。接入自定义提供商后，用它的前缀形态 <b>标识/模型名</b>（如 myrelay/gpt-4o）——这个形式是唯一确定的路由写法，裸模型名一律先归内置生态渠道，只有内置目录里没有、且恰好只有一家提供商拥有时才会落到提供商。",
};
const openHint = ref<string | null>(null);
function toggleHint(id: string) {
  openHint.value = openHint.value === id ? null : id;
}
function closeHint() {
  openHint.value = null;
}

/** 地址条与端点标签：点一下整条进剪贴板；文本全部来自实时配置，改端口/绑定后跟着变 */
const endpoints = [
  { key: "chat", text: "POST /v1/chat/completions" },
  { key: "messages", text: "POST /v1/messages" },
  { key: "responses", text: "POST /v1/responses" },
  { key: "models", text: "GET /v1/models" },
  // 二期 Task 3 拆语义：/healthz = 进程活着（liveness），/readyz = 号池可用（readiness）。
  // 两条都列出来，免得只看 healthz 以为「200 = 网关能干活」
  { key: "health", text: "GET /healthz" },
  { key: "ready", text: "GET /readyz" },
] as const;
const copied = ref("");
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
function copyText(text: string, key: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
  copied.value = key;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = ""), 1500);
}

/** 去 Keys 页生成 Key */
function goKeys() {
  app.activeModule = "proxy";
  app.setPage("keys");
}

const exTab = ref<"curl" | "py" | "app" | "cli">("curl");

/** 编程 CLI 的接法：两家拼 URL 的规矩正好相反，写错一侧就是 404，所以两段都标在注释里 */
const cliCmd = computed(() => {
  const origin = base.value.replace(/\/v1$/, "");
  return (
    `# Claude Code —— 走 /v1/messages\n` +
    `setx ANTHROPIC_BASE_URL   "${origin}"      # 只到端口：它自己拼 /v1/messages\n` +
    `setx ANTHROPIC_AUTH_TOKEN "sk-你的Key"\n` +
    `setx ANTHROPIC_MODEL      "我的中转/claude-sonnet-4-5"\n\n` +
    `# Codex CLI —— 走 /v1/responses，配置在 ~/.codex/config.toml\n` +
    `model_provider = "agenthub"\n` +
    `model = "我的中转/gpt-4o"        # 自定义 base_url 时 Codex 不拉模型目录，只能手填\n\n` +
    `[model_providers.agenthub]\n` +
    `name = "AgentHub 网关"\n` +
    `base_url = "${base.value}"    # 必须自带 /v1：它只做 base + "/responses"\n` +
    `wire_api = "responses"            # "chat" 已从 Codex 删除，写它会硬报错\n` +
    `env_key = "AGENTHUB_API_KEY"\n` +
    `stream_idle_timeout_ms = 300000\n\n` +
    `setx AGENTHUB_API_KEY "sk-你的Key"        # 换终端才生效；macOS/Linux 用 export`
  );
});

/** 本页是否处于前台：页面经 v-show 保活，切走后轮询与事件刷新必须停下来，
    否则总览在后台持续拉数据重渲染，挤占前台页（号池等）的每一帧 */
const active = computed(() => app.activeModule === "proxy" && app.activePage === "home");

// 事件合流 + 轮询防重入：refresh 在跑（或主进程正慢）时再触发只补一次，不叠加并发；
// poolsync/credits 等高频事件经 1s 窗口合并，不再逐条全量刷新
const scheduleRefresh = coalesceAsync(refresh, 1000);

function startPoll() {
  stopPoll(); // 先清旧轮询再建，快速来回切页不会叠出多个 interval
  pollTimer = setInterval(scheduleRefresh, 5000);
}
function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
}

watch(active, (on) => {
  if (on) {
    refresh();
    startPoll();
  } else {
    stopPoll();
    scheduleRefresh.cancel();
  }
});

onMounted(() => {
  refresh();
  startPoll();
  document.addEventListener("click", closeHint);
  offEvent = api.onUpdateEvent((e) => {
    const p = e as { event?: string; type?: string };
    if (p.event !== "proxy") return;
    // request 事件（主进程 2s 节流合并）驱动实时流追加；本地再压一道 2s 间隔，
    // 且只刷流水区不刷 KPI——高流量下全量刷新会把页面打满（原实现直接忽略该事件，靠 5s 轮询）
    if (p.type === "request") {
      if (!active.value) return;
      refreshRecent();
      return;
    }
    if (!active.value) return;
    scheduleRefresh();
  });
});
onUnmounted(() => {
  stopPoll();
  scheduleRefresh.cancel();
  clearTimeout(copiedTimer);
  document.removeEventListener("click", closeHint);
  if (offEvent) offEvent();
});
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="gwErr" class="card err-card">
        <div class="err-row">
          <div class="set-desc err-text">{{ gwErr }}</div>
          <button class="btn btn-primary" :disabled="busy" @click="retryGateway">{{ busy ? "重试中…" : "重试启动" }}</button>
        </div>
      </div>
      <div v-if="err" class="card err-card">
        <div class="set-desc err-text">{{ err }}</div>
      </div>
      <!-- 页头工具栏（已去标题化）：地址条/端点/DPAPI 与状态、服务开关排成一行 -->
      <div class="toolbar">
        <button class="pill mono copy-chip" :title="`点击复制：${base}`" @click="copyText(base, 'base')">
          {{ base }}<i class="ph" :class="copied === 'base' ? 'ph-check' : 'ph-copy'"></i>
        </button>
        <button
          v-for="ep in endpoints"
          :key="ep.key"
          class="tag tag-dim copy-chip"
          :title="`点击复制：${ep.text}`"
          @click="copyText(ep.text, ep.key)"
        >
          {{ ep.text }}<i class="ph" :class="copied === ep.key ? 'ph-check' : 'ph-copy'"></i>
        </button>
        <span class="tag" :class="st?.vaultOk ? 'tag-ok' : 'tag-warn'">{{ st?.vaultOk ? "DPAPI 凭证加密" : "凭证加密不可用" }}</span>
        <span class="toolbar-right">
          <span class="pill">
            <span class="dot" :class="{ off: !st?.running }"></span>{{ st?.running ? "RUNNING" : "STOPPED" }}
          </span>
          <button class="btn" :class="st?.running ? 'btn-stop' : 'btn-primary'" :disabled="busy" @click="toggleService">
            {{ busy ? "处理中…" : st?.running ? "停止服务" : "启动服务" }}
          </button>
        </span>
      </div>
      <div class="kpis">
        <div class="kpi"><span>今日请求</span><b class="acc">{{ fmtInt(st?.today.req || 0) }}</b></div>
        <div class="kpi"><span>今日 Token</span><b>{{ fmtK(st?.today.tokens || 0) }}</b></div>
        <div class="kpi"><span>成功率</span><b>{{ (st?.today.successRate ?? 100).toFixed(1) }}%</b></div>
        <div class="kpi"><span>TTFT 均值</span><b>{{ fmtMs(st?.today.ttftAvg || 0) }}</b></div>
      </div>
      <div class="agent-cards-grid">
        <div v-for="c in st?.channels || []" :key="c.id" class="card">
          <div class="card-title">
            {{ c.display }}
            <span class="tag" :class="c.onlineCount > 0 ? 'tag-ok' : 'tag-dim'">
              {{ c.accountCount ? `${c.onlineCount}/${c.accountCount} 可用` : "未配置" }}
            </span>
          </div>
          <div style="display: flex; align-items: baseline; gap: 8px">
            <b class="big-num" :title="c.id === 'zcode' ? `${fmtInt(c.totalCredits)} Tokens` : ''">{{ fmtBalance(c.totalCredits, c.id) }}</b>
            <span style="font-size: 11px; color: var(--text-3)">{{ balanceUnit(c.id) }}</span>
          </div>
          <div class="rows" style="margin-top: 6px">
            <div class="row"><div class="grow"><div class="name">今日请求 / Token</div></div><span class="num">{{ c.todayReq }} · {{ fmtK(c.todayTokens) }}</span></div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top: 12px">
        <div class="card-title">
          实时请求流 <span class="right">最近 {{ recent.length }} 条</span>

        </div>
        <RequestLogTable :rows="recent" scope="home" @detail="openDetail" />
      </div>
      <RequestDetailDialog :req="detailReq" @close="detailReq = null" />
      <div class="card">
        <div class="card-title">快速上手 <span class="right">四步完成接入</span></div>
        <div class="steps">
          <div v-for="(s, i) in steps" :key="s.id" class="step">
            <span class="step-no">{{ i + 1 }}</span>
            <div class="step-main">
              <div class="step-t">
                {{ s.title }}
                <span class="qwrap">
                  <span class="qmark" :class="{ on: openHint === s.id }" @click.stop="toggleHint(s.id)">?</span>
                  <span v-if="openHint === s.id" class="qpop" @click.stop>{{ tips[s.id] }}</span>
                </span>
              </div>
              <div class="step-d">
                {{ s.desc }}
                <button v-if="s.link" class="step-link" @click="goKeys">去生成 →</button>
              </div>
            </div>
          </div>
        </div>
        <div class="ex-tabs">
          <button class="ex-tab" :class="{ on: exTab === 'curl' }" @click="exTab = 'curl'">curl 命令</button>
          <button class="ex-tab" :class="{ on: exTab === 'py' }" @click="exTab = 'py'">Python（OpenAI SDK）</button>
          <button class="ex-tab" :class="{ on: exTab === 'app' }" @click="exTab = 'app'">桌面客户端</button>
          <button class="ex-tab" :class="{ on: exTab === 'cli' }" @click="exTab = 'cli'">编程 CLI</button>
          <span class="ex-note">把 <b>sk-你的Key</b> 换成第 2 步生成的 Key<span class="qwrap">
            <span class="qmark" :class="{ on: openHint === 'replace' }" @click.stop="toggleHint('replace')">?</span>
            <span v-if="openHint === 'replace'" class="qpop">示例里的"sk-你的Key"和模型名都是占位符，替换成你自己的真实值才能跑通。</span>
          </span></span>
        </div>
        <div v-if="exTab === 'curl'" class="code">{{ curlCmd }}</div>
        <div v-if="exTab === 'py'" class="code">{{ pyCmd }}</div>
        <div v-if="exTab === 'cli'" class="code">{{ cliCmd }}</div>
        <ol v-if="exTab === 'app'" class="app-steps">
          <li>打开客户端的「设置 → 模型服务」，点「添加」，选择 <b>OpenAI 兼容 / 自定义</b> 类型。</li>
          <li>API 地址：填上方第 3 步的 Base URL（以 <b>/v1</b> 结尾；个别客户端只要求填到端口，按它的提示来）。</li>
          <li>API Key：填第 2 步生成的 <b>sk-开头</b> 的 Key。</li>
          <li>模型：手动输入模型名（以渠道实际提供的为准），保存后发一句话测试。</li>
        </ol>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* 地址条/端点/DPAPI 与状态、开关同行排放；空间不足时整体折行。
   这里绝不能回到强制单行：flex 子项的 min-width:auto 会拿 nowrap 的
   min-content 撑破 .page，整页出横向滚动条。white-space: nowrap 只留给
   每个 chip 自己，保证「DPAPI 凭证加密」这类带空格的文案不在 chip 内断行 */
.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  white-space: nowrap;
}
.toolbar-right {
  margin-left: auto;
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.pill .dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  display: inline-block;
}
.pill .dot.off {
  background: var(--text-3);
}
/* 地址 / 端点快捷复制：悬停点亮，点击后图标短暂变对勾 */
.copy-chip {
  cursor: pointer;
  border: 1px solid transparent;
  user-select: none;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.copy-chip .ph {
  font-size: 11px;
  margin-left: 2px;
  opacity: 0.5;
}
.copy-chip:hover {
  color: var(--accent-strong);
  border-color: var(--accent-line);
}
.copy-chip:hover .ph {
  opacity: 1;
}
/* 停止服务用危险色描边，与启动服务的实心主色形成状态区分 */
.btn-stop {
  color: var(--danger);
}
.btn-stop:hover {
  border-color: var(--danger);
  background: var(--danger-dim);
}
/* 渠道数不固定：按可用宽度自适应排布，接多少渠道都不挤 */
.grid-3 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 12px;
}
.big-num {
  font-family: var(--font-ui);
  font-variant-numeric: tabular-nums;
  font-size: 22px;
  letter-spacing: -1px;
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
/* 网关起不来的错误态：文案 + 重试按钮同行，按钮不许被文案挤下去 */
.err-row {
  display: flex;
  align-items: center;
  gap: 12px;
  justify-content: space-between;
}

/* ===== 快速上手 ===== */
.steps {
  display: grid;
  gap: 10px;
  margin-bottom: 12px;
}
.step {
  display: flex;
  gap: 10px;
  align-items: flex-start;
}
.step-no {
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--accent-dim, rgba(52, 211, 153, 0.14));
  color: var(--accent-strong);
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-top: 1px;
}
.step-t {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 6px;
}
.step-d {
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.6;
  margin-top: 2px;
}
.step-link {
  border: none;
  background: none;
  padding: 0;
  color: var(--accent-strong);
  font-size: 11px;
  cursor: pointer;
  white-space: nowrap;
}
.step-link:hover {
  text-decoration: underline;
}

/* 问号徽章 + 点击气泡 */
.qwrap {
  position: relative;
  display: inline-flex;
}
.qmark {
  flex: none;
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  color: var(--text-3);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  user-select: none;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.qmark:hover,
.qmark.on {
  color: var(--accent-strong);
  border-color: var(--accent-strong);
  background: var(--accent-dim, rgba(52, 211, 153, 0.14));
}
.qpop {
  position: absolute;
  top: calc(100% + 7px);
  left: -10px;
  z-index: 30;
  width: 250px;
  padding: 9px 11px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-strong);
  background: var(--bg-soft);
  box-shadow: 0 8px 24px -8px rgba(0, 0, 0, 0.55);
  color: var(--text-2);
  font-size: 11px;
  font-weight: 400;
  line-height: 1.65;
  animation: qpop-in 0.16s ease-out;
}
@keyframes qpop-in {
  from {
    opacity: 0;
    transform: translateY(-3px);
  }
}

/* 示例 tab 切换：窄窗口时说明文字折到下一行，不跟 tab 挤一行 */
.ex-tabs {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.ex-tab {
  display: inline-flex;
  align-items: center;
  height: var(--ctl-h-sm);
  padding: 0 11px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line-strong);
  background: transparent;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s, transform 0.28s var(--ease-spring), box-shadow 0.25s;
}
.ex-tab:hover {
  color: var(--text);
  border-color: rgba(255, 255, 255, 0.22);
  transform: scale(1.05);
  box-shadow: 0 0 12px -4px var(--accent-line);
}
.ex-tab.on {
  color: var(--accent-strong);
  border-color: var(--accent-line);
  background: var(--accent-dim);
}
.ex-note {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-3);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ex-note b {
  color: var(--text-2);
  font-weight: 600;
}
/* ex-note 贴着卡片右缘：气泡改为向左展开，向右展开会探出页面右缘、把 .page 撑出横向滚动 */
.ex-note .qpop {
  left: auto;
  right: -10px;
}

/* 客户端配置步骤 */
.app-steps {
  margin: 0;
  padding: 11px 13px 11px 28px;
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-2);
  background: var(--code-bg);
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  display: grid;
  gap: 6px;
}
.app-steps b {
  color: var(--text);
  font-weight: 600;
}

/* Agent 渠道卡片自适应网格，避免多渠道落单孤立 */
.agent-cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  margin-top: 12px;
}
@media (min-width: 1080px) {
  .agent-cards-grid {
    grid-template-columns: repeat(4, 1fr);
  }
}
</style>
