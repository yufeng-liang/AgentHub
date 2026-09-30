<!-- 反代网关 · 模型目录：渠道 tab（全部/各渠道）+ 官方目录拉取 + 启停开关 / 渠道覆盖 / 倍率与能力 / 自定义模型映射
     管理态存框架整体配置（disabledModels / modelOverrides / modelAliases），保存即热生效（服务端每请求读盘） -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ComponentPublicInstance } from "vue";
import * as api from "../../api/ipc";
import type { ModelCustomEntry, ProxyChannelId, ProxyChannelView, ProxyModel } from "../../types";
import { useAppStore } from "../../stores/app";
import { capabilityTags, channelName, fmtCtx, fmtInt, fmtRate, parseCtxInput } from "./format";
import { ROW_H, colCountFor, winRange } from "./virtualWindow";
import ModelMetaEditor from "../../components/proxy/ModelMetaEditor.vue";

const app = useAppStore();
const models = ref<ProxyModel[]>([]);
const err = ref("");
const msg = ref("");
const syncing = ref("");
const filter = ref("");
const activeTab = ref(""); // "" = 全部
/** 号池可用性过滤（默认开）：只看当前激活号池里有可用账号的渠道的模型。
 *  单渠道 Tab 是显式选择，不受此开关限制。 */
const onlyAvailable = ref(true);
const mainTab = ref<"catalog" | "alias" | "reverse">("catalog");
const ruleDialogOpen = ref(false);

// 渠道候选 = 号池当前渠道（渠道后续扩充时自动跟进，不写死）
const channels = ref<{ id: string; display: string }[]>([]);
const CHANNEL_OPTIONS = computed<{ value: "" | ProxyChannelId; label: string }[]>(() => [
  { value: "", label: "自动（打分）" },
  ...channels.value.map((c) => ({ value: c.id as ProxyChannelId, label: c.display })),
]);

// 渠道 tab 只显示有模型的渠道：复用下方 modelsByChannel 预分组（O(渠道) 查直值，不再 O(渠道×模型) 逐对扫描）
const tabChannels = computed(() => channels.value.filter((c) => (modelsByChannel.value[c.id] || []).length > 0));
// ===== 号池激活态：渠道健康计算 + 可用性过滤 =====
// 取数路径与号池页一致（proxy_pool 直查），随 refresh() 一起刷新
const poolViews = ref<ProxyChannelView[]>([]);
const channelView = computed<Record<string, { enabled: boolean; online: number; accounts: number; health: string }>>(() => {
   const map: Record<string, { enabled: boolean; online: number; accounts: number; health: string }> = {};
   for (const c of poolViews.value) {
     map[c.id] = { enabled: c.enabled !== false, online: c.summary?.onlineCount ?? 0, accounts: c.summary?.accountCount ?? 0, health: c.health?.reason || "" };
   }
   return map;
});
/** 渠道可用 = 启用 + 号池里有账号 + 有在线账号；三者缺一即视为不可用（灰显） */
function channelAvailable(id: string): boolean {
   const v = channelView.value[id];
   return !!v && v.enabled && v.accounts > 0 && v.online > 0;
}
/** 渠道 chip 的悬停说明：灰显原因一句话说清 */
function channelHint(id: string): string {
   const v = channelView.value[id];
   if (!v) return "";
   if (!v.enabled) return "该渠道已在号池中禁用";
   if (!v.accounts) return "该渠道号池中没有账号";
   if (!v.online) return `该渠道账号当前全部不可用${v.health ? `（${v.health}）` : ""}`;
   return "渠道可用";
}

const rows = computed(() => {
   const kw = filter.value.trim().toLowerCase();
   return models.value.filter((m) => {
     if (activeTab.value && !m.sources.includes(activeTab.value as ProxyChannelId)) return false;
     // 「仅看可用」只作用于合并视图（"" Tab）：单渠道 Tab 是用户显式选择，不受限
     if (!activeTab.value && onlyAvailable.value) {
       const avail = m.sources.some((s) => channelAvailable(s));
       if (!avail) return false;
     }
     if (!kw) return true;
     return m.id.toLowerCase().includes(kw) || String(m.name || "").toLowerCase().includes(kw);
   });
});
// ===== 虚拟滚动：只挂载视口附近那十几行 =====
// 为什么必须做：133 行全量渲染 = 6212 个 DOM 节点，而滚动容器 clientHeight 实测只有 476px
// （一屏 7 行）。切进本页要付 RecalcStyle ~315ms + Layout ~65ms（单帧最长 500–620ms）；
// 且 App.vue 用 v-show 保活、访问过的页永不卸载，这 133 行挂的 266 个 el-select
// （冷挂载实测 +10131 个事件监听器）会让之后**任意两页之间**的切换都付 ~150ms 长任务。
const firstVisible = ref(0);
const viewRows = ref(0);
const range = computed(() => winRange(rows.value.length, firstVisible.value, viewRows.value));
const win = computed(() => rows.value.slice(range.value.start, range.value.end));
const vPadTop = computed(() => range.value.padTop);
const vPadBottom = computed(() => range.value.padBottom);

let scrollerEl: Element | null = null;
let scrollerRo: ResizeObserver | null = null;
function measureView() {
  viewRows.value = scrollerEl ? Math.ceil(scrollerEl.clientHeight / ROW_H) : 0;
}
/** 函数式 ref：滚动容器在 v-if 里，切子 Tab 会重建，元素到手/消失各回调一次。
 *  形参类型必须与 Vue 的 VNodeRef 一致（含 ComponentPublicInstance），
 *  写窄了 strictFunctionTypes 下会因参数逆变直接报 TS2322。 */
function bindScroller(el: Element | ComponentPublicInstance | null) {
  scrollerRo?.disconnect();
  scrollerRo = null;
  scrollerEl = el instanceof Element ? el : null;
  if (scrollerEl) {
    scrollerRo = new ResizeObserver(measureView);
    scrollerRo.observe(scrollerEl);
    measureView();
  }
}
onBeforeUnmount(() => {
  scrollerRo?.disconnect();
  scrollerRo = null;
  scrollerEl = null;
});

function onScrollerScroll(e: Event) {
  // 只存「首个可见行下标」而不是 scrollTop：同一行内的滚动像素变化不会触发任何重渲染
  firstVisible.value = Math.max(0, Math.floor((e.target as HTMLElement).scrollTop / ROW_H));
}

// 换搜索词 / 换渠道 / 换子 Tab 后原来的位置已不属于新列表，回到顶部。
// mainTab 必须在内：滚动容器整个在 v-if 里，切走再切回会拿到一个 scrollTop=0 的**新**元素，
// 而 firstVisible 还停在离开时的行号上 —— 实测那样会在表头下面垫出 3360px 空白，整屏看着是空的。
watch([filter, activeTab, mainTab], () => {
  firstVisible.value = 0;
  if (scrollerEl) scrollerEl.scrollTop = 0;
});
// ===== 思考强度选项 =====
const REASONING_EFFORT_ALL = [
   { value: "", label: "默认" },
   { value: "off", label: "关闭 (off)" },
   { value: "minimal", label: "极低 (minimal)" },
   { value: "low", label: "低 (low)" },
   { value: "medium", label: "中等 (medium)" },
   { value: "high", label: "高 (high)" },
   { value: "xhigh", label: "极高 (xhigh)" },
   { value: "max", label: "最大 (max)" },
];
/** 该模型可选的思考强度：元数据里声明了 supportedEfforts 就只给那些档位（+ 默认），
 *  否则给全量词表 —— 下拉选项与元数据编辑器的「允许档位」不再互相矛盾。 */
function effortOptions(m: ProxyModel) {
   const allowed = (m.reasoning?.supportedEfforts || []).filter(Boolean);
   if (!allowed.length) return REASONING_EFFORT_ALL;
   return REASONING_EFFORT_ALL.filter((o) => !o.value || allowed.includes(o.value));
}
/** 思考强度下拉的悬停说明：声明了允许档位时点明出处，用户知道选项为何变少 */
function effortTip(m: ProxyModel): string {
   const allowed = (m.reasoning?.supportedEfforts || []).filter(Boolean);
   return allowed.length
     ? `自定义思考强度（该模型声明支持：${allowed.join(" / ")}），直接注入出站请求参数`
     : "自定义思考强度，直接注入出站请求参数";
}

// ===== 上下文长度输入：显示 K/M 缩写，编辑时展开为数字 =====
// ctxDraft 存「正在编辑的原始文本」：有 key 时输入框显示草稿，无 key 时显示 ctxDisplay 的缩写值。
// 不在草稿态做任何格式化，用户输入的每个字符都原样保留，光标不会跳。
const ctxDraft = ref<Record<string, string>>({});

/** 该模型当前生效的上下文长度（自定义优先，否则渠道目录值） */
function ctxValue(m: ProxyModel): number {
  return Number((app.config.proxy.modelCustom || {})[m.id]?.contextLength) || Number(m.contextLength) || 0;
}

/** 非编辑态显示值：K/M 缩写 */
function ctxDisplay(m: ProxyModel): string {
  return fmtCtx(ctxValue(m));
}

/** 悬停提示：编辑说明 + 当前精确值（缩写有精度损失，精确数字放这里） */
function ctxTip(m: ProxyModel): string {
  const v = ctxValue(m);
  return v ? `自定义上下文长度（Token）：${fmtInt(v)}，可直接写 128K / 1M，留空恢复默认` : "自定义上下文长度（Token），留空则恢复默认";
}

/** 提交编辑：解析 "128K"/"1M" 为数字落库；草稿清掉后回到缩写显示 */
async function commitCtx(m: ProxyModel) {
  const raw = ctxDraft.value[m.id];
  if (raw === undefined) return;
  delete ctxDraft.value[m.id];
  const parsed = parseCtxInput(raw);
  // 认不出来的非空文本按「不提交」处理，让显示退回当前值：
  // parseCtxInput 对无效输入返回 undefined，而 undefined 在下游等于「清空覆盖、恢复默认」——
  // 把 tooltip 里的 131,072（带千分位）原样粘进来就会静默删掉用户已有的自定义覆盖。
  // 「留空恢复默认」是用户主动动作，两者不能走同一条路。
  if (parsed === undefined && raw.trim() !== "") return;
  // 与「当前生效值」比较而不是与自定义值比较：只聚焦再失焦时草稿就是原始数字，
  // 若拿自定义值(0)比就会把目录自带值误写成一条自定义覆盖（凭空多出「自」标记）
  if ((parsed || 0) === ctxValue(m)) return;
  await updateModelCustom(m, { contextLength: parsed });
}

// ===== 模型自定义参数更新 =====
async function updateModelCustom(m: ProxyModel, patch: Partial<ModelCustomEntry>) {
  const mc = { ...(app.config.proxy.modelCustom || {}) };
  const cur = { ...(mc[m.id] || {}) };
  const next = { ...cur, ...patch };

  if (!next.contextLength || next.contextLength <= 0) delete next.contextLength;
  if (!next.maxOutputTokens || next.maxOutputTokens <= 0) delete next.maxOutputTokens;
  if (!next.reasoningEffort) delete next.reasoningEffort;

  if (Object.keys(next).length > 0) mc[m.id] = next;
  else delete mc[m.id];

  app.config.proxy.modelCustom = mc;
  await persist(`模型 ${m.id} 自定义参数已生效`);
  await refresh();
}

// ===== 模型映射（别名）管理 =====
const aliasName = ref("");
const aliasTarget = ref("");
const aliases = computed<[string, string][]>(() => Object.entries(app.config.proxy.modelAliases || {}));

// ===== 反向模型映射管理（统一请求名 -> 各渠道实际模型） =====
const reverseName = ref("");
const reverseTargets = ref<Record<string, string>>({});
const reverseAliases = computed<[string, Record<string, string>][]>(() =>
  Object.entries(app.config.proxy.modelReverseAliases || {})
);

/** 渠道 → 模型列表的预分组：computed 只在 models 变化时重算一次，
 *  模板（反向映射表单的每渠道下拉）取直值，不再每渲染每渠道全量 filter（O(渠道×模型)） */
const modelsByChannel = computed<Record<string, ProxyModel[]>>(() => {
  const map: Record<string, ProxyModel[]> = {};
  for (const c of channels.value) map[c.id] = [];
  for (const m of models.value) {
    for (const src of m.sources) {
      if (map[src]) map[src].push(m);
    }
  }
  return map;
});
function channelModels(chId: string) {
  return modelsByChannel.value[chId] || [];
}

async function addReverseAlias() {
  const name = reverseName.value.trim();
  if (!name) return;
  const targetMap: Record<string, string> = {};
  for (const [ch, target] of Object.entries(reverseTargets.value)) {
    if (target && target.trim()) targetMap[ch] = target.trim();
  }
  if (!Object.keys(targetMap).length) {
    err.value = "至少为一个渠道选择目标模型";
    return;
  }
  const rev = { ...(app.config.proxy.modelReverseAliases || {}) };
  rev[name] = targetMap;
  app.config.proxy.modelReverseAliases = rev;
  reverseName.value = "";
  reverseTargets.value = {};
  await persist(`反向映射 ${name} 已生效`);
  await refresh();
}

async function removeReverseAlias(name: string) {
  const rev = { ...(app.config.proxy.modelReverseAliases || {}) };
  delete rev[name];
  app.config.proxy.modelReverseAliases = rev;
  await persist(`已移除反向映射 ${name}`);
  await refresh();
}

function editReverseAlias(name: string, targetMap: Record<string, string>) {
  reverseName.value = name;
  reverseTargets.value = { ...targetMap };
}

/** 管理态写回整体配置（save 即热生效；保存后重拉对齐服务端口径） */
async function persist(successMsg: string) {
  const r = await app.save();
  if (r && r.ok === false) {
    err.value = r.message || "保存失败";
    return;
  }
  msg.value = successMsg;
  setTimeout(() => (msg.value = ""), 2000);
}

async function refresh() {
  try {
    models.value = await api.proxyModels();
    // 号池视图一次取全：channels 只要 id/display 两列，poolViews 还要 enabled/在线数/降级原因
    // （渠道 chip 高亮与「仅看可用」过滤的数据源），同一份响应喂两边，别打两次 IPC
    const views = await api.proxyPool().catch(() => null);
    if (views) {
      channels.value = views;
      poolViews.value = views;
    }
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

/** 启停开关：默认开；关闭即写入 disabledModels 落盘（软件记录，重启保持） */
async function toggleEnabled(m: ProxyModel, v: string | number | boolean) {
   const on = !!v;
   const list = new Set(app.config.proxy.disabledModels || []);
   if (on) list.delete(m.id);
   else list.add(m.id);
   app.config.proxy.disabledModels = [...list];
   await persist(on ? `已启用 ${m.id}` : `已禁用 ${m.id}`);
   await refresh();
}

async function setOverride(m: ProxyModel, v: string) {
  const ov = { ...(app.config.proxy.modelOverrides || {}) };
  if (v) ov[m.id] = v as ProxyChannelId;
  else delete ov[m.id];
  app.config.proxy.modelOverrides = ov;
  await persist(v ? `${m.id} → 固定走 ${channelName(v)}` : `${m.id} 恢复自动路由`);
  await refresh();
}

// ===== 模型元数据编辑（能力 / 档位 / 输出上限覆盖）=====
type MetaOverride = {
  capabilities?: { images?: boolean; video?: boolean; reasoning?: boolean; tools?: boolean };
  maxOutputTokens?: number;
  reasoning?: { supportedEfforts?: string[]; defaultEffort?: string };
};
const editing = ref<ProxyModel | null>(null);
// 当前模型的稀疏覆盖（喂给编辑器回填草稿）；modelMeta 在浏览器 mock 里可能缺省
const editingOverride = computed<MetaOverride | undefined>(() => (editing.value ? (app.config.proxy.modelMeta || {})[editing.value.id] : undefined));
const openMetaEditor = (m: ProxyModel) => (editing.value = m);
const closeMetaEditor = () => (editing.value = null);
const META_GROUP_LABEL: Record<string, string> = { capabilities: "能力", maxOutputTokens: "输出上限", reasoning: "推理档位" };

/** 保存整键覆盖：空覆盖则删键（回落拉取 / seed）；复用现有 persist + refresh，不新增 IPC */
async function saveMeta(payload: MetaOverride) {
  const id = editing.value?.id;
  if (!id) return;
  const mm = { ...(app.config.proxy.modelMeta || {}) };
  if (payload && Object.keys(payload).length) mm[id] = payload;
  else delete mm[id];
  app.config.proxy.modelMeta = mm;
  await persist(`已保存 ${id} 的元数据覆盖`);
  editing.value = null;
  await refresh();
}

/** 清除某一组覆盖（删子键）：组清空后整键也删；保持编辑器打开并重指刷新后的行 */
async function clearMetaGroup(group: "capabilities" | "maxOutputTokens" | "reasoning") {
  const id = editing.value?.id;
  if (!id) return;
  const mm = { ...(app.config.proxy.modelMeta || {}) };
  const cur = { ...(mm[id] || {}) };
  delete cur[group];
  if (Object.keys(cur).length) mm[id] = cur;
  else delete mm[id];
  app.config.proxy.modelMeta = mm;
  await persist(`已清除 ${id} 的${META_GROUP_LABEL[group]}覆盖`);
  await refresh();
  editing.value = models.value.find((x) => x.id === id) || null;
}


async function addAlias() {
  const from = aliasName.value.trim();
  const to = aliasTarget.value;
  if (!from || !to) return;
  if (from === to) {
    err.value = "别名与目标模型不能相同";
    return;
  }
  const al = { ...(app.config.proxy.modelAliases || {}) };
  al[from] = to;
  app.config.proxy.modelAliases = al;
  aliasName.value = "";
  aliasTarget.value = "";
  await persist(`映射 ${from} → ${to} 已生效`);
}

async function removeAlias(from: string) {
  const al = { ...(app.config.proxy.modelAliases || {}) };
  delete al[from];
  app.config.proxy.modelAliases = al;
  await persist(`已移除映射 ${from}`);
}

/** 拉取官方模型目录（云端接口，用号池账号 token，不依赖本地软件）：写回 rules/catalog.json 热生效 */
async function syncCatalog(channel: string) {
  if (syncing.value) return;
  syncing.value = channel;
  let failMsg = "";
  let okMsg = "";
  try {
    const r = await api.proxyModelsSync(channel);
    if (r && r.ok === false) failMsg = r.message || "拉取失败";
    else {
      const rateInfo = r.withRate ? `，其中 ${r.withRate} 个含倍率` : "";
      okMsg = `已拉取 ${r.count ?? 0} 个模型到 ${channelName(channel)}目录${rateInfo}`;
    }
  } catch (e) {
    failMsg = String((e as Error).message || e);
  } finally {
    syncing.value = "";
    await refresh();
  }
  // 提示必须在 refresh 之后落：refresh 成功会清 err，先设后刷就成了「闪红」
  if (failMsg) err.value = failMsg;
  else {
    msg.value = okMsg;
    setTimeout(() => (msg.value = ""), 3000);
  }
}

/** 全部渠道并发拉取：只打有可用账号的渠道——未配置/全离线的渠道必然失败，逐个打是纯噪声；
 *  目录内置的渠道（AutoClaw 静态表）按「跳过」汇总进提示不算失败。真失败才亮红，且在
 *  refresh 之后设置——refresh 成功会清 err，先设后刷就只剩一闪而过的红 */
async function syncAll() {
  if (syncing.value) return;
  syncing.value = "__all__";
  const targets = channels.value.filter((c) => channelAvailable(c.id));
  try {
    const results = await Promise.all(targets.map((c) => api.proxyModelsSync(c.id).catch((e) => ({ ok: false as const, message: String((e as Error).message || e) }))));
    const okParts: string[] = [];
    const skipParts: string[] = [];
    const failParts: string[] = [];
    results.forEach((r, i) => {
      const name = channelName(targets[i].id);
      if (r && r.ok !== false) okParts.push(`${name} ${r.count ?? 0} 个`);
      else if (r && /不支持同步/.test(r.message || "")) skipParts.push(name);
      else failParts.push(`${name}：${(r && r.message) || "失败"}`);
    });
    syncing.value = "";
    await refresh();
    if (failParts.length) err.value = failParts.join("；");
    let text = okParts.length ? `已拉取 ${okParts.join("、")}` : "";
    if (skipParts.length) text = [text, `跳过 ${skipParts.join("、")}（目录内置）`].filter(Boolean).join("；");
    if (!text && !targets.length) text = "当前没有带可用账号的渠道，无需拉取";
    if (text) {
      msg.value = text;
      setTimeout(() => (msg.value = ""), 3000);
    }
  } finally {
    syncing.value = "";
  }
}

onMounted(refresh);
</script>

<template>
  <section class="page">
    <!-- 目录页要「一屏显示」：page-body 变弹性列，目录卡片吃掉剩余高度、表格在卡内滚动（见下方 .page-fill） -->
    <div class="page-body" :class="{ 'page-fill': mainTab === 'catalog' }">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>

      <!-- 顶部三大 Tab：合并模型目录 / 自定义模型映射 / 全渠道反向模型映射 + 路由说明按钮 -->
      <div class="models-main-tabs">
        <button class="main-tab-btn" :class="{ active: mainTab === 'catalog' }" @click="mainTab = 'catalog'">
          {{ activeTab ? channelName(activeTab) + "模型目录" : "合并模型目录" }}
        </button>
        <button class="main-tab-btn" :class="{ active: mainTab === 'alias' }" @click="mainTab = 'alias'">
          自定义模型映射
        </button>
        <button class="main-tab-btn" :class="{ active: mainTab === 'reverse' }" @click="mainTab = 'reverse'">
          全渠道反向模型映射
        </button>
        <div style="flex: 1"></div>
        <button class="btn btn-ghost" @click="ruleDialogOpen = true">
          <i class="ph ph-info"></i>路由与切换规则
        </button>
      </div>

      <!-- Tab 1: 模型目录 -->
      <template v-if="mainTab === 'catalog'">
        <!-- 页头工具条：渠道分段选择器在左、搜索与官方目录拉取在右 -->
        <div class="models-head">
          <div class="seg">
            <button class="seg-item" :class="{ active: !activeTab }" @click="activeTab = ''">全部</button>
            <el-tooltip
              v-for="c in tabChannels"
              :key="c.id"
              :content="channelHint(c.id)"
              :disabled="channelAvailable(c.id)"
              placement="top"
            >
              <button
                class="seg-item"
                :class="{ active: activeTab === c.id, unavailable: !channelAvailable(c.id) }"
                @click="activeTab = c.id"
              >
                <span v-if="channelAvailable(c.id)" class="seg-dot" aria-hidden="true"></span>
                {{ c.display }}
              </button>
            </el-tooltip>
          </div>
          <span class="head-tools">
            <label class="search-box">
              <i class="ph ph-magnifying-glass"></i>
              <input v-model="filter" class="search-input" placeholder="搜索模型" spellcheck="false" />
              <el-tooltip v-if="filter" content="清空搜索" placement="top">
                <button class="search-clear" @click.prevent="filter = ''"><i class="ph ph-x"></i></button>
              </el-tooltip>
            </label>
            <el-tooltip v-if="!activeTab" content="只显示当前激活号池里有可用账号的渠道的模型；关闭后显示全部渠道" placement="top">
              <label class="avail-toggle"><input v-model="onlyAvailable" type="checkbox" class="avail-check" /><span>仅看可用</span></label>
            </el-tooltip>
            <button v-if="activeTab" class="btn btn-cta" :disabled="!!syncing" @click="syncCatalog(activeTab)">
              <i class="ph ph-cloud-arrow-down"></i>{{ syncing === activeTab ? "拉取中…" : "拉取模型" }}
            </button>
            <button v-else class="btn btn-cta" :disabled="!!syncing" @click="syncAll">
              <i class="ph ph-cloud-arrow-down"></i>{{ syncing === "__all__" ? "拉取中…" : "全部拉取" }}
            </button>
          </span>
          <Transition name="headmsg">
            <span v-if="msg" class="head-msg tag tag-ok">{{ msg }}</span>
          </Transition>
        </div>

        <div class="card models-card" style="margin-top: 10px">
          <div class="card-title">
            {{ activeTab ? channelName(activeTab) + "模型目录" : "合并模型目录" }}
            <span class="right">{{ rows.length }} 个模型 · 保存即热生效</span>
          </div>
          <!-- .table-scroll 本身就是 overflow:auto，原先那句 inline overflow-x:hidden 才是把它锁死的开关 -->
          <div class="table-scroll" :ref="bindScroller" @scroll.passive="onScrollerScroll">
            <table class="table table-bare models-table" style="table-layout: fixed; width: 100%; min-width: 880px">
              <!-- 列宽用百分比而非像素：写死像素在窄容器下会撑破。百分比恒等比缩放，配合
                   table-layout:fixed + 单元格 overflow:hidden + 控件 width:100%。
                   2026-09-30 重组：原「元数据」列（独立编辑按钮）并进「能力」格 —— 整格可点开编辑器，
                   9/8 列收敛为 8/7 列，模型列与各控件列都多分到宽度；表挂 min-width:880px + 卡内横滚。
                   能力列加宽（7.5%→12%）：去掉了与上下文列重复的 K/M 数字后，这列现在是
                   「chips + 编辑入口 + 覆盖徽标」三合一。 -->
              <colgroup>
                <col style="width: auto" />
                <col style="width: 10%" />
                <col style="width: 12%" />
                <col style="width: 6%" />
                <col style="width: 12%" />
                <col v-if="!activeTab" style="width: 10.5%" />
                <col style="width: 12%" />
                <col style="width: 7.5%" />
              </colgroup>
              <thead>
                <tr>
                  <th>模型</th>
                  <th>上下文</th>
                  <th>思考强度</th>
                  <th>倍率</th>
                  <th>能力<span class="th-sub"> · 编辑</span></th>
                  <th v-if="!activeTab">来源渠道</th>
                  <th>渠道覆盖</th>
                  <th style="text-align: center">状态</th>
                </tr>
              </thead>
              <tbody>
                <!-- 上下占位行把没挂载的行数按像素垫回来，滚动条长度与滚动手感保持不变 -->
                <tr v-if="vPadTop" class="v-spacer" :style="{ height: vPadTop + 'px' }" aria-hidden="true">
                  <td :colspan="colCountFor(activeTab)"></td>
                </tr>
                <tr v-for="m in win" :key="m.id">
                  <td style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">
                    <el-tooltip :content="m.id" placement="top">
                      <div class="mono" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ m.id }}</div>
                    </el-tooltip>
                    <el-tooltip v-if="m.name && m.name !== m.id" :content="m.name" placement="top">
                      <div class="model-name" style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap">{{ m.name }}</div>
                    </el-tooltip>
                  </td>
                  <td>
                    <div class="custom-cell">
                      <!-- 非编辑态显示 K/M 缩写（131K / 1M），聚焦才展开成完整数字草稿。
                           本 fork 的列宽此前已实测到「6 位数字刚好放得下」（见下方 .custom-cell），
                           收这段的真实收益是：非编辑态不再顶到列边、可直接写 128K / 1.5M 落库，
                           精确值改由 tooltip 给出（缩写有精度损失）。宽度仍交给 flex，不写死 px。 -->
                      <el-tooltip :content="ctxTip(m)" placement="top">
                        <input
                          type="text"
                          class="f-input custom-input"
                          :value="ctxDraft[m.id] ?? ctxDisplay(m)"
                          placeholder="自动"
                          @focus="ctxDraft[m.id] = String(ctxValue(m) || '')"
                          @input="ctxDraft[m.id] = ($event.target as HTMLInputElement).value"
                          @change="commitCtx(m)"
                          @blur="commitCtx(m)"
                          @keydown.enter="($event.target as HTMLInputElement).blur()"
                        />
                      </el-tooltip>
                      <el-tooltip v-if="(app.config.proxy.modelCustom || {})[m.id]?.contextLength" content="已自定义覆盖上下文" placement="top">
                        <span class="custom-badge">自</span>
                      </el-tooltip>
                    </div>
                  </td>
                  <td>
                    <div class="custom-cell">
                      <el-tooltip :content="effortTip(m)" placement="top">
                        <span class="cell-select">
                          <el-select
                            class="f-el-select custom-el-select"
                            popper-class="glass-popper"
                            :persistent="false"
                            :model-value="(app.config.proxy.modelCustom || {})[m.id]?.reasoningEffort || ''"
                            style="width: 100%"
                            placeholder="默认"
                            @update:model-value="(v: string) => updateModelCustom(m, { reasoningEffort: v })"
                          >
                            <el-option v-for="opt in effortOptions(m)" :key="opt.value" :value="opt.value" :label="opt.label" />
                          </el-select>
                        </span>
                      </el-tooltip>
                      <el-tooltip v-if="(app.config.proxy.modelCustom || {})[m.id]?.reasoningEffort" content="已自定义覆盖思考强度" placement="top">
                        <span class="custom-badge">自</span>
                      </el-tooltip>
                    </div>
                  </td>
                  <td class="mono">{{ fmtRate(m.rate) }}</td>
                  <td class="cell-chips cap-cell" role="button" tabindex="0" :aria-label="`编辑 ${m.id} 的能力与档位`" @click="openMetaEditor(m)" @keydown.enter.prevent="openMetaEditor(m)">
                    <!-- 2026-09-30 重组：原「元数据」列并进能力格 —— chips 一眼看能力，整格可点开编辑器，
                         悬停露出铅笔提示可编辑；有用户覆盖时「覆盖」徽标跟过来（信息不丢，列数 -1）。
                         role=button + 键盘 Enter，可访问性与原按钮打平。 -->
                    <span class="cap-chips">
                      <el-tooltip v-if="capabilityTags(m).length > 1" :content="`能力：${capabilityTags(m).join(' / ')}（点击编辑）`" placement="top">
                        <span class="chip-sum"><span class="tag tag-dim">{{ capabilityTags(m)[0] }}</span><span class="tag tag-dim chip-more">+{{ capabilityTags(m).length - 1 }}</span></span>
                      </el-tooltip>
                      <span v-else-if="capabilityTags(m).length" class="tag tag-dim">{{ capabilityTags(m)[0] }}</span>
                      <span v-else class="cap-none">—</span>
                    </span>
                    <i class="ph ph-pencil-simple cap-edit-ic" aria-hidden="true"></i>
                    <el-tooltip v-if="m.metaOverridden && m.metaOverridden.length" content="含用户覆盖" placement="top">
                      <span class="tag tag-warn meta-badge">覆盖</span>
                    </el-tooltip>
                  </td>
                  <td v-if="!activeTab" class="cell-chips">
                    <el-tooltip v-if="m.sources.length > 1" :content="`来源渠道：${m.sources.map((s: string) => channelName(s)).join(' / ')}`" placement="top">
                      <span class="chip-sum"><span class="tag tag-dim">{{ channelName(m.sources[0]) }}</span><span class="tag tag-dim chip-more">+{{ m.sources.length - 1 }}</span></span>
                    </el-tooltip>
                    <span v-else-if="m.sources.length" class="tag tag-dim">{{ channelName(m.sources[0]) }}</span>
                    <span v-else style="color: var(--text-3)">—</span>
                  </td>
                  <td>
                    <el-tooltip :content="m.sources.length === 1 ? '单源模型强制走所属渠道，无需覆盖' : ''" :disabled="m.sources.length !== 1" placement="top">
                      <span class="cell-select">
                        <el-select
                          class="f-el-select override-el-select"
                          popper-class="glass-popper"
                          :persistent="false"
                          style="width: 100%"
                          :model-value="m.override"
                          :disabled="!m.enabled || m.sources.length === 1"
                          @update:model-value="(v: string) => setOverride(m, v)"
                        >
                          <el-option
                            v-for="o in CHANNEL_OPTIONS.filter((o) => !o.value || m.sources.includes(o.value as ProxyChannelId))"
                            :key="o.value"
                            :value="o.value"
                            :label="o.label"
                          />
                        </el-select>
                      </span>
                    </el-tooltip>
                  </td>
                  <td style="text-align: center">
                    <div
                      class="switch"
                      :class="{ on: m.enabled }"
                      role="switch"
                      :aria-checked="!!m.enabled"
                      @click="toggleEnabled(m, !m.enabled)"
                    ></div>
                  </td>
                </tr>
                <tr v-if="vPadBottom" class="v-spacer" :style="{ height: vPadBottom + 'px' }" aria-hidden="true">
                  <td :colspan="colCountFor(activeTab)"></td>
                </tr>
                <tr v-if="!rows.length">
                  <td :colspan="colCountFor(activeTab)" style="text-align: center; color: var(--text-3); padding: 24px 0">
                    无匹配模型 —— 点上方「拉取模型」从官方目录云端同步（用号池账号 token，不依赖本地软件）
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>

      <!-- Tab 2: 自定义模型映射 -->
      <div v-else-if="mainTab === 'alias'" class="card">
        <div class="card-title">
          自定义模型映射
          <span class="right">客户端请求别名 → 实际模型 · 响应模型字段保持请求值</span>
        </div>
        <div class="alias-form">
          <input v-model="aliasName" class="input" style="width: 220px" placeholder="别名（如 gpt-4o）" />
          <span class="alias-arrow">→</span>
          <el-select v-model="aliasTarget" class="f-el-select" popper-class="glass-popper" :persistent="false" style="width: 260px" placeholder="目标模型" filterable>
            <el-option v-for="m in models" :key="m.id" :value="m.id" :label="m.id" />
          </el-select>
          <button class="btn" :disabled="!aliasName.trim() || !aliasTarget" @click="addAlias">添加映射</button>
        </div>
        <div v-if="aliases.length" class="alias-list">
          <span v-for="[from, to] in aliases" :key="from" class="tag tag-dim alias-item">
            <span class="mono">{{ from }}</span> → <span class="mono">{{ to }}</span>
            <el-tooltip content="移除映射" placement="top">
              <button class="alias-del" @click="removeAlias(from)">×</button>
            </el-tooltip>
          </span>
        </div>
        <div v-else class="set-desc" style="margin-top: 8px; color: var(--text-3)">
          暂无映射 —— 例如把 gpt-4o 映射到 kimi-k3，客户端按 gpt-4o 请求即自动走 kimi-k3
        </div>
      </div>

      <!-- Tab 3: 全渠道反向模型映射 -->
      <div v-else-if="mainTab === 'reverse'" class="card">
        <div class="card-title">
          全渠道反向模型映射
          <span class="right">统一请求名 → 各渠道实际模型 · 响应模型字段保持请求名</span>
        </div>
        <div class="set-desc" style="margin-bottom: 10px">
          解决不同渠道同一模型命名不一致（例如 Trae 的 glm-5.3 与 WorkBuddy/ZCode 的名称不同）。客户端按统一名称请求，网关根据路由渠道自动发给对应渠道的模型名。
        </div>
        <div class="rev-form">
          <div class="rev-row">
            <span class="rev-label">统一请求名：</span>
            <input v-model="reverseName" class="input" style="width: 240px" placeholder="统一名称（如 glm-5.3-flash）" />
          </div>
          <div class="rev-channels-grid">
            <div v-for="c in channels" :key="c.id" class="rev-ch-item">
              <span class="rev-ch-label">{{ c.display }}：</span>
              <el-select
                class="f-el-select"
                popper-class="glass-popper"
                :persistent="false"
                style="width: 190px"
                :model-value="reverseTargets[c.id] || ''"
                placeholder="（不映射此渠道）"
                filterable
                @update:model-value="(v: string) => reverseTargets[c.id] = v"
              >
                <el-option value="" label="（不映射此渠道）" />
                <el-option v-for="cm in channelModels(c.id)" :key="cm.id" :value="cm.id" :label="cm.id" />
              </el-select>
            </div>
          </div>
          <div class="rev-actions">
            <button class="btn btn-cta" :disabled="!reverseName.trim()" @click="addReverseAlias">
              <i class="ph ph-plus"></i>保存反向映射
            </button>
            <button v-if="reverseName" class="btn" style="margin-left: 8px" @click="reverseName = ''; reverseTargets = {}">
              重置
            </button>
          </div>
        </div>
        <div v-if="reverseAliases.length" class="rev-list">
          <div v-for="[uname, cmap] in reverseAliases" :key="uname" class="rev-card-item">
            <div class="rev-card-head">
              <span class="mono rev-card-title">{{ uname }}</span>
              <div class="rev-card-btns">
                <el-tooltip content="编辑映射" placement="top">
                  <button class="btn btn-sm" @click="editReverseAlias(uname, cmap)"><i class="ph ph-pencil-simple"></i>编辑</button>
                </el-tooltip>
                <el-tooltip content="移除映射" placement="top">
                  <button class="btn btn-sm btn-del" @click="removeReverseAlias(uname)"><i class="ph ph-trash"></i>删除</button>
                </el-tooltip>
              </div>
            </div>
            <div class="rev-card-routes">
              <span v-for="(target, ch) in cmap" :key="ch" class="tag tag-dim rev-route-tag">
                <span class="rev-route-ch">{{ channelName(ch) }}</span>：<span class="mono">{{ target }}</span>
              </span>
            </div>
          </div>
        </div>
        <div v-else class="set-desc" style="margin-top: 10px; color: var(--text-3)">
          暂无反向映射 —— 输入统一名称并为各渠道指定对应实际模型后点保存即可生效。
        </div>
      </div>
    </div>

    <!-- 路由与切换规则小弹窗 -->
    <Teleport to="body">
      <div v-if="ruleDialogOpen" class="p-mask" @click.self="ruleDialogOpen = false">
        <div class="p-dlg glass rule-dlg" role="dialog" aria-modal="true" aria-label="路由与切换规则">
          <header class="rule-head">
            <div class="rule-head-left">
              <span class="rule-head-icon"><i class="ph ph-git-fork"></i></span>
              <div class="rule-head-text">
                <div class="rule-title">路由与切换规则</div>
                <div class="rule-sub">网关请求调度与模型切换说明</div>
              </div>
            </div>
            <el-tooltip content="关闭" placement="top">
              <button class="rule-close" @click="ruleDialogOpen = false"><i class="ph ph-x"></i></button>
            </el-tooltip>
          </header>
          <div class="rule-body">
            <div class="rule-item"><b>1. 渠道路由：</b>模型仅存在于单渠道 → 强制走该渠道；多源重叠 → per-model 覆盖优先，否则按路由策略打分。</div>
            <div class="rule-item"><b>2. 自定义模型映射：</b>请求入口先把别名解析为实际模型再路由（响应模型字段保持请求值）。</div>
            <div class="rule-item"><b>3. 反向模型映射：</b>一个统一请求名映射到各渠道不同模型名，渠道确定后自动转为该渠道模型转发（响应保持统一请求名）。</div>
            <div class="rule-item"><b>4. 上下文与思考强度：</b>支持在表格中行内自定义覆盖，修改后即时注入出站参数并反映在模型目录。</div>
            <div class="rule-item"><b>5. 全局回退降级：</b>模型未知或号池耗尽 → 按配置页「不可用时自动切换模型」统一设置切到全局回退模型（客户端无感）。</div>
            <div class="rule-item"><b>6. 模型级负缓存：</b>模型级限流（6004）/ 该号不支持（11102）→ 只冷却「账号×模型」组合，切模型即豁免。</div>
            <div class="rule-item"><b>7. 用量统计标记：</b>切换命中会在用量明细的备注列标记 alias→实际模型 / rev→实际模型 / fallback→实际模型。</div>
          </div>
          <footer class="rule-foot">
            <button class="btn btn-primary" @click="ruleDialogOpen = false">我知道了</button>
          </footer>
        </div>
      </div>
    </Teleport>

    <!-- 元数据编辑器：自身 Teleport 到 body，留在这里不产生额外布局。
         必须留在 <section> 之内 —— 挂到 </section> 之后会让本组件变成 fragment 根，
         App.vue 上的 v-show 会被静默忽略（只 warn 不报错），页面一旦挂载就再也藏不起来，
         切到同模块别的页时目标页被追加到它后面、落在屏幕外，看起来就是「点了没反应」 -->
    <ModelMetaEditor
      :model="editing"
      :override="editingOverride"
      @close="closeMetaEditor"
      @save="saveMeta"
      @clear="clearMetaGroup"
    />
  </section>
  </template>

<style scoped>
/* ===== 目录页「一屏显示」：整页不出页面级滚动条，表格用满剩余高度、在卡内滚动 =====
   .page 本身就是 height:100% 的弹性列（global.css），page-body 撑满剩余高度即可；
   块布局下 .models-main-tabs 的 margin-bottom 与 .page-body > * + * 的 margin-top 会折叠成 12px，
   弹性列不折叠，故显式清零前者，保持原有节奏不变 */
.page-fill {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.page-fill > .models-main-tabs {
  margin-bottom: 0;
}
.models-card {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
/* 卡片标题不参与伸缩，剩余高度全给表格容器 */
.models-card > .card-title {
  flex: none;
}
/* 覆盖全局 .table-scroll 的 max-height: min(480px, 62vh) 硬上限：改由卡片剩余高度决定 */
.models-card > .table-scroll {
  flex: 1;
  min-height: 0;
  max-height: none;
}

/* ===== 顶部三大 Tab 切换按钮 ===== */
.models-main-tabs {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  border-bottom: 1px solid var(--line);
  padding-bottom: 10px;
}
.main-tab-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
  background: var(--bg-soft);
  color: var(--text-2);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}
.main-tab-btn:hover {
  color: var(--text);
  border-color: var(--line-strong);
  background: var(--panel);
}
.main-tab-btn.active {
  color: var(--accent-strong);
  border-color: var(--accent-line);
  background: var(--accent-dim);
}

/* ===== 路由与切换规则弹窗 ===== */
.p-mask {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.rule-dlg {
  width: 580px;
  max-width: 95vw;
  background: var(--panel);
  border: 1px solid var(--line-strong);
  border-radius: var(--r-lg);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.4);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rule-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.rule-head-left {
  display: flex;
  align-items: center;
  gap: 10px;
}
.rule-head-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--r-sm);
  background: var(--accent-dim);
  color: var(--accent-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}
.rule-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
}
.rule-sub {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 2px;
}
.rule-close {
  background: transparent;
  border: none;
  font-size: 16px;
  color: var(--text-3);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--r-sm);
}
.rule-close:hover {
  color: var(--text);
  background: var(--bg-soft);
}
.rule-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  font-size: 12px;
  line-height: 1.65;
  color: var(--text-2);
  background: var(--code-bg);
  padding: 14px 16px;
  border-radius: var(--r-sm);
  border: 1px solid var(--line);
}
.rule-item b {
  color: var(--text);
}
.rule-foot {
  display: flex;
  justify-content: flex-end;
}

/* ===== 页头工具条：分段选择器 + 搜索 + 拉取，一条 30px 控件线；反馈消息浮层不占布局 ===== */
.models-head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.head-tools {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* 渠道分段选择器：容器框住选项，选中项点亮（与号池弹窗的方式切换同一语言）；
   容器 padding 3px + 内项 22px + 边框 = 30px，与右侧 .btn / 搜索框同高成一条线
   单行放满 11 个渠道时固有宽约 1172px，而 .page 内容宽只有 966px —— 不换行会把整块
   page-body 撑出 .page 的横向滚动（表格「模型」列被推到屏幕外，要左右拖才看得全）。
   故这里允许换行，并清掉 flex item 的 min-width:auto（它正是阻止收缩到固有宽以下的那道锁）。
   渠道再怎么增都不会再撑出横向滚动，最多多一行。 */
.seg {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px;
  min-width: 0;
  /* flex-basis 不能留 auto：auto 取的是不换行的固有宽 1172px，而 models-head 是可换行容器
     —— 可换行容器「先折行、后收缩」，单是 seg 就超过 922px 容器时它把 head-tools 甩到下一行，
     而不是压缩 seg（页头因此从 55px 涨到 95px，白丢一行表格高度）。
     给个能让两者同排进第一行的基准（320 + 10 gap + 工具条 313 ≤ 922），
     折行判定通过后 seg 再 grow 吃满剩余，实得 ~599px。 */
  flex: 1 1 320px;
  padding: 3px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.seg-item {
  display: inline-flex;
  align-items: center;
  height: 22px;
  /* 横向 7px：12 个渠道标签的固有宽约 1172px，而 seg 与搜索条同排时只分到 ~599px。
     留 11px 会折成 3 行（末行只剩「ZCode 智谱（国际）」一个），收到 7px 正好 2 行（7+5）。
     高度方向不动，仍是 3px 容器 padding + 22px 项 + 边框 = 30px 一条线 */
  padding: 0 7px;
  border: 1px solid transparent;
  border-radius: calc(var(--r-sm) - 3px);
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  font-family: var(--font-ui);
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s, box-shadow 0.2s;
}
.seg-item:hover {
  color: var(--text);
}
.seg-item.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
  font-weight: 600;
  box-shadow: 0 0 10px -6px var(--accent-line);
}
.seg-item:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: 1px;
}
/* 搜索框：图标 + 无框输入 + 快捷清空；聚焦时整框点亮主色并给图标染色 */
.search-box {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  width: 210px;
  height: var(--ctl-h);
  padding: 0 10px;
  border: 1px solid var(--line-strong);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
  transition: border-color 0.2s, box-shadow 0.2s;
}
.search-box:focus-within {
  border-color: var(--accent-line);
  box-shadow: 0 0 0 3px var(--accent-dim);
}
.search-box > .ph {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-3);
  transition: color 0.2s;
}
.search-box:focus-within > .ph {
  color: var(--accent-strong);
}
.search-input {
  flex: 1;
  min-width: 0;
  border: none;
  background: none;
  outline: none;
  color: var(--text);
  font-size: 12px;
  font-family: var(--font-ui);
}
.search-input::placeholder {
  color: var(--text-3);
}
.search-clear {
  flex-shrink: 0;
  display: grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-3);
  font-size: 10px;
  line-height: 1;
  cursor: pointer;
  transition: color 0.15s, background 0.15s;
}
.search-clear:hover {
  color: var(--text);
  background: var(--line);
}
/* 拉取按钮里的云下载图标与文字同高（.btn 自带 6px 图文间距） */
.head-tools .btn .ph {
  font-size: 13px;
}
/* 拉取反馈：浮在工具条下缘，进出均不挤动任何布局 */
.head-msg {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 6;
  max-width: min(560px, 82%);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  box-shadow: 0 8px 24px -12px rgba(0, 0, 0, 0.6);
}
.headmsg-enter-active,
.headmsg-leave-active {
  transition: opacity 0.25s var(--ease), transform 0.25s var(--ease);
}
.headmsg-enter-from,
.headmsg-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}
@media (prefers-reduced-motion: reduce) {
  .headmsg-enter-active,
  .headmsg-leave-active {
    transition: none;
  }
}
.err-card {
  margin-bottom: 12px;
  border-color: var(--err, #e05555);
}
.err-text {
  color: var(--err, #e05555);
}
.model-name {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
.alias-form {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.alias-arrow {
  color: var(--text-3);
}
.alias-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}
.alias-item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.alias-del {
  border: none;
  background: transparent;
  color: var(--text-3);
  cursor: pointer;
  font-size: 14px;
  line-height: 1;
  padding: 0 2px;
}
.alias-del:hover {
  color: var(--err, #e05555);
}
/* ===== 表格内容不得溢出列宽（与上面百分比 colgroup 配套） =====
   改前实测：整表比容器宽 4px 被 overflow-x:hidden 静默裁掉，且渠道覆盖 +14、
   状态 +18、元数据 +10、思考强度 +9 —— 都是控件写死像素宽撑出来的。
   三道锁：① 单元格 padding 从 12 收到 8，把横向余量还给内容；
   ② overflow:hidden 让任何超出都停在列内（不渗到隔壁列、也不撑破表格）；
   ③ 下面把 input / el-select 改成随列伸缩，从源头消除超出。 */
/* 虚拟滚动的占位行：只负责垫高度，不参与单元格上下 padding 与分隔线，也不该有悬停反馈 */
.models-table tbody tr.v-spacer > td {
  padding: 0;
  border: 0;
}
.models-table tbody tr.v-spacer {
  cursor: default;
}
/* 全局 .table tbody tr 带逐行入场动画（rowIn + 按 --i 错峰）。虚拟滚动下行会随滚动
   不断挂载/卸载，那个动画会在每次滚动时对新进入的行重播，看着像整表在闪 —— 这张表关掉。
   代价：fx 开启的用户进本页时不再有逐行淡入；页仍保留 .page-anim 的整页入场。 */
.models-table tbody tr {
  animation: none;
}
.models-table :is(th, td) {
  padding-left: 8px;
  padding-right: 8px;
  overflow: hidden;
}
/* 能力 / 来源渠道两列：多枚标签在 920 下曾被省略号切成 "图 …"、"WorkBuddy CN …"，
   而这两列的宽度是上面按 888 容器倒推的，加宽就要动模型列。改成只显首枚 + 计数角标，
   全量清单交给 tooltip —— 单行，不碰 ROW_H=60 的虚拟滚动垫高数学。 */
.cell-chips .tag {
  font-size: 10px;
  padding: 1px 4px;
}
.chip-sum {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  min-width: 0;
}
.chip-sum .tag:first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chip-more {
  flex-shrink: 0;
}
/* 状态列：开关固有宽 42px（40 + 1px 双边框），是表里唯一的交互控件，
   被列宽切掉就点不准。左右 padding 收到 2px、列宽给 7.5%。
   表挂了 min-width:900px 后，7.5% 的下限就是 67px（此前按 920 窗口的 599px 容器算是 45px），
   两种口径都放得下 42px 开关。 */
.models-table th:last-child,
.models-table td:last-child {
  padding-left: 2px;
  padding-right: 2px;
}
/* .switch 是块级 div，td 上的 text-align:center 对它无效（原本就靠左），
   padding 归零后会贴到列边线上，显式居中 */
.models-table td:last-child .switch {
  margin: 0 auto;
}
/* el-tooltip 的触发器是包在 el-select 外面的一层 span（.cell-select 是显式加的，
   不用 .el-tooltip__trigger 选：那会把「覆盖」角标也拉成整行宽的色块）。
   不给它宽度的话，里面 width:100% 的 el-select 会按 span 的 shrink-to-fit 算宽，等于没改。 */
.models-table td > .cell-select,
.custom-cell > .cell-select {
  display: block;
  flex: 1 1 auto;
  min-width: 0;
}
/* 自定义单元格（上下文与思考强度）：占满整列，「自」角标（实测 17px + 4 间距）不参与伸缩，
   有角标时由 input / select 让位，谁都不越出列宽。
   上下文列 10% = 89px、内可视 73，扣掉角标占位后 input 还剩 52，
   而 6 位 Token 数（"131072" + 12px padding）实测需 50 —— 刚好放得下，故不再往下列。 */
.custom-cell {
  position: relative;
  display: flex;
  width: 100%;
  align-items: center;
}
.custom-input {
  flex: 1 1 auto;
  min-width: 0;
  width: auto;
  height: 26px;
  padding: 0 6px;
  font-size: 11.5px;
  border-radius: var(--r-sm);
  background: var(--bg-soft);
  border: 1px solid var(--line);
  color: var(--text);
  font-family: var(--font-mono);
}
.custom-input:focus {
  border-color: var(--accent-line);
}
.custom-el-select :deep(.el-select__wrapper) {
  min-height: 26px;
  height: 26px;
  font-size: 11.5px;
  padding: 0 8px;
}
.custom-badge {
  flex: 0 0 auto;
  margin-left: 4px;
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 9px;
  background: var(--accent-dim);
  color: var(--accent-strong);
  font-weight: 600;
  line-height: 1;
}

/* 反向模型映射卡片样式 */
.rev-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.rev-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.rev-label {
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}
.rev-channels-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 10px;
}
.rev-ch-item {
  display: flex;
  align-items: center;
  gap: 6px;
}
.rev-ch-label {
  font-size: 11px;
  color: var(--text-3);
  width: 90px;
  text-align: right;
  flex-shrink: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rev-actions {
  display: flex;
  align-items: center;
}
.rev-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}
.rev-card-item {
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.rev-card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.rev-card-title {
  font-weight: 600;
  font-size: 13px;
  color: var(--text);
}
.rev-card-btns {
  display: flex;
  align-items: center;
  gap: 6px;
}
.btn-sm {
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
}
.btn-del:hover {
  color: var(--err, #e05555);
}
.rev-card-routes {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.rev-route-tag {
  font-size: 11px;
}
/* ===== 2026-09-30 重组新增 ===== */
/* 表头副标注「能力 · 编辑」弱化 */
.th-sub {
  font-weight: 400;
  color: var(--text-3);
  font-size: 11px;
}
/* 渠道 chip：可用渠道带绿点高亮；禁用/无可用账号灰显（禁用感来自降饱和 + 虚线边框） */
.seg-item.unavailable {
  color: var(--text-3);
  opacity: 0.55;
  border: 1px dashed var(--line);
}
.seg-item.unavailable.active {
  opacity: 1;
}
.seg-dot {
  display: inline-block;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent-strong, #4ade80);
  margin-right: 4px;
  flex-shrink: 0;
}
/* 「仅看可用」开关（合并视图工具条内） */
.avail-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  font-size: 11px;
  color: var(--text-2);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.avail-check {
  accent-color: var(--accent-strong, #4ade80);
  width: 12px;
  height: 12px;
  margin: 0;
  cursor: pointer;
}
/* 能力格 = 可点击编辑入口：默认静默，悬停点亮 */
.cap-cell {
  cursor: pointer;
}
.cap-cell:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: -2px;
}
.cap-chips {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
  overflow: hidden;
}
.cap-none {
  color: var(--text-3);
}
.cap-edit-ic {
  flex: 0 0 auto;
  margin-left: 4px;
  font-size: 12px;
  color: var(--text-3);
  opacity: 0;
  transition: opacity 0.15s;
}
.cap-cell:hover .cap-edit-ic,
.cap-cell:focus-visible .cap-edit-ic {
  opacity: 1;
  color: var(--accent-strong, #4ade80);
}
.cap-cell:hover .tag {
  border-color: var(--line-strong);
}
/* 视觉重心：悬停整格淡淡提亮，暗示「整格可点」 */
.cap-cell:hover {
  background: var(--bg-soft);
}
.rev-route-ch {
  color: var(--text-3);
}
.meta-edit {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.meta-edit .ph {
  font-size: 13px;
}
.meta-badge {
  /* 元数据列 13%（888 容器下 115px、内可视 99px）要容纳「编辑」按钮 58 + 间距 + 角标 35 = 97。
     间距 6px 时正好顶到列右界，收 2px 留点余量。
     （这两个宽度是带 data-v-* 复测出来的：合成节点若不复制 scoped 属性，
     .meta-badge[data-v-x] 不匹配，量到的 28px 是全局 .tag 的宽，据此调列宽会假绿。） */
  margin-left: 4px;
}
</style>
