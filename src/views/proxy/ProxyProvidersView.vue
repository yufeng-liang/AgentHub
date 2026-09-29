<!-- 反代网关 · 自定义提供商：把第三方中转站 / 自建端点接进网关。
     一个提供商 = 一个上游端点 + 若干把 API Key（Key 走号池轮转与冷却）；模型以 `标识/模型名` 形态被客户端调用。
     与「号池」页的分工：这里管端点本身（地址、Key 集合、模型清单、连通性），号池页管各渠道账号的运行状态 -->
<script setup lang="ts">
import { computed, onMounted, ref, type Ref } from "vue";
import * as api from "../../api/ipc";
import type { ProxyProvider, ProxyProviderKind, ProxyProviderModel, ProxyProviderTestResult, ProxyAccount } from "../../types";
import { ACCOUNT_STATUS, fmtAgo } from "./format";

const rows = ref<ProxyProvider[]>([]);
const err = ref("");
const busy = ref(false);

// 系统级加密不可用时不阻断（与内置渠道凭据同一降级策略），但必须把「明文落盘」说清楚
const vault = ref<{ encrypted: boolean; driver: string; dataDir: string } | null>(null);

async function refresh() {
  try {
    const r = await api.proxyProviderList();
    if (r.ok === false) {
      err.value = r.message || "读取提供商列表失败";
      return;
    }
    rows.value = r.providers || [];
    err.value = "";
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
  vault.value = await api.proxyVaultStatus().catch(() => vault.value);
}

// ===== 新建 / 编辑表单 =====
// 模型清单的唯一真相是 modelRows（结构化表格）：它一旦有第二个可编辑源，
// 「从上游拉取」就会把已写的元数据整段抹平成裸名（曾经的真实行为）。
const formOpen = ref(false);
const editingId = ref("");
const form = ref({
  id: "",
  display: "",
  baseUrl: "",
  kind: "openai_compat" as ProxyProviderKind,
  keysText: "",
  extraHeadersText: "",
  extraBodyText: "",
  enabled: true,
});
const formErr = ref("");
const testResult = ref<ProxyProviderTestResult | null>(null);
const testing = ref(false);

const isEdit = computed(() => !!editingId.value);

/** 上游协议形态。值集合与后端 provider.cjs 的 KINDS 同源，漂移由 dev-provider-test 断言守住；
 *  下拉、列表页 tag、编辑态回填三处都查这张表——写成三元的话，加一档就有一档显示错名字。
 *  lossy 只在"该形态有几处转换是单向的"时给：完整损失清单在网关日志（emit 的 notes），
 *  这里只留一句够用户判断选哪个的话。 */
const KIND_OPTIONS: { value: ProxyProviderKind; label: string; hint: string; lossy?: string }[] = [
  { value: "openai_compat", label: "OpenAI Chat", hint: "地址是 …/v1/chat/completions" },
  { value: "anthropic_messages", label: "Anthropic Messages", hint: "只开 …/v1/messages 的 Claude 中转站", lossy: "该形态有损：多段 system 拼成一段、历史里的思考链与签名不回投" },
  { value: "openai_responses", label: "OpenAI Responses", hint: "只开 …/v1/responses 的站与自建网关", lossy: "该形态有损：思考链不回投、stop 与结构化输出无对应物" },
];
const kindLabel = (k: string) => KIND_OPTIONS.find((o) => o.value === k)?.label || k;
/** 认不出的 kind（历史数据 / 后端先加了档）一律按缺省形态处理，不让下拉显示一个空值 */
const normalizeKind = (k: unknown): ProxyProviderKind =>
  KIND_OPTIONS.some((o) => o.value === k) ? (k as ProxyProviderKind) : "openai_compat";
const kindMeta = computed(() => KIND_OPTIONS.find((o) => o.value === form.value.kind));

/** 档位词表必须与后端 util.EFFORT_LEVELS 同源，漂移由 dev-provider-test 断言守住 */
const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const CAPS = [
  { key: "images", label: "视觉" },
  { key: "tools", label: "工具" },
  { key: "reasoning", label: "思考" },
] as const;

type ModelRow = {
  model: string;
  upstream: string;
  aliases: string[];
  contextLength: string;
  maxOutputTokens: string;
  rate: string;
  caps: Record<string, boolean>;
  efforts: string[];
};

/** 空行：给"添加模型"用 */
function blankRow(): ModelRow {
  return { model: "", upstream: "", aliases: [], contextLength: "", maxOutputTokens: "", rate: "", caps: {}, efforts: [] };
}

/** 存库形状 → 表格行（字符串简写与历史缺字段都在这一步补齐，写回时再统一收敛） */
function toRow(m: ProxyProviderModel): ModelRow {
  const o = typeof m === "string" ? { model: m } : m || { model: "" };
  return {
    model: String(o.model || ""),
    upstream: String(o.upstream || ""),
    aliases: Array.isArray(o.aliases) ? o.aliases.map(String) : [],
    contextLength: o.contextLength ? String(o.contextLength) : "",
    maxOutputTokens: o.maxOutputTokens ? String(o.maxOutputTokens) : "",
    rate: o.rate != null ? String(o.rate) : "",
    caps: { ...((o.capabilities || {}) as Record<string, boolean>) },
    efforts: Array.isArray(o.reasoning?.supportedEfforts) ? [...o.reasoning!.supportedEfforts!] : [],
  };
}

const modelRows = ref<ModelRow[]>([]);

/** 表格行 → 存库条目：只写有值的键，避免 models_json 里堆一串 null/空数组 */
function rowToModel(r: ModelRow): ProxyProviderModel {
  const upstream = (r.upstream || "").trim();
  const out: Record<string, unknown> = { model: (r.model || "").trim() };
  if (upstream && upstream !== out.model) out.upstream = upstream;
  const aliases = (r.aliases || []).map((a) => String(a).trim()).filter((a) => a && a.toLowerCase() !== String(out.model).toLowerCase());
  if (aliases.length) out.aliases = [...new Set(aliases)];
  if (Number(r.contextLength) > 0) out.contextLength = Number(r.contextLength);
  if (Number(r.maxOutputTokens) > 0) out.maxOutputTokens = Number(r.maxOutputTokens);
  if (r.rate !== "" && !Number.isNaN(Number(r.rate))) out.rate = Number(r.rate);
  const caps: Record<string, boolean> = {};
  for (const c of CAPS) if (r.caps?.[c.key]) caps[c.key] = true;
  if (Object.keys(caps).length) out.capabilities = caps;
  if (r.efforts?.length) out.reasoning = { supportedEfforts: r.efforts };
  return out as ProxyProviderModel;
}

const modelNames = computed(() => modelRows.value.map((r) => (r.model || "").trim()).filter(Boolean));

/** 表格里的模型名重复会让"该名字映射到哪个上游真名"变成猜——保存前先在前端拦一道，
 *  后端的 normalizeModels 是去重静默丢，那不适合当交互反馈 */
const dupModels = computed(() => {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const n of modelNames.value) {
    const k = n.toLowerCase();
    if (seen.has(k)) dup.add(n);
    seen.add(k);
  }
  return [...dup];
});

function parseJsonObject(text: string, label: string): Record<string, unknown> | string {
  const t = String(text || "").trim();
  if (!t) return {};
  try {
    const v = JSON.parse(t);
    if (!v || typeof v !== "object" || Array.isArray(v)) return `${label}必须是 JSON 对象`;
    return v as Record<string, unknown>;
  } catch (e) {
    return `${label}不是合法 JSON：${String((e as Error).message || e)}`;
  }
}

function keysFromText(): { key: string }[] {
  return String(form.value.keysText || "")
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((key) => ({ key }));
}

function openCreate() {
  editingId.value = "";
  form.value = { id: "", display: "", baseUrl: "", kind: "openai_compat", keysText: "", extraHeadersText: "", extraBodyText: "", enabled: true };
  modelRows.value = [];
  rowTest.value = {};
  formErr.value = "";
  testResult.value = null;
  formOpen.value = true;
}

function openEdit(row: ProxyProvider) {
  editingId.value = row.id;
  form.value = {
    id: row.id,
    display: row.display,
    baseUrl: row.baseUrl,
    kind: normalizeKind(row.kind),
    keysText: "",
    extraHeadersText: row.extraHeaders && Object.keys(row.extraHeaders).length ? JSON.stringify(row.extraHeaders, null, 2) : "",
    extraBodyText: row.extraBody && Object.keys(row.extraBody).length ? JSON.stringify(row.extraBody, null, 2) : "",
    enabled: row.enabled,
  };
  modelRows.value = (row.models || []).map(toRow);
  rowTest.value = {};
  formErr.value = "";
  testResult.value = null;
  formOpen.value = true;
}

async function doSave() {
  if (busy.value) return;
  const models = modelRows.value.filter((r) => (r.model || "").trim()).map(rowToModel);
  if (dupModels.value.length) {
    formErr.value = `模型名重复：${dupModels.value.join("、")}（同名会说不清该映射到哪个上游真名）`;
    return;
  }
  const headers = parseJsonObject(form.value.extraHeadersText, "extraHeaders");
  if (typeof headers === "string") {
    formErr.value = headers;
    return;
  }
  const body = parseJsonObject(form.value.extraBodyText, "extraBody");
  if (typeof body === "string") {
    formErr.value = body;
    return;
  }
  busy.value = true;
  try {
    const input = {
      id: form.value.id.trim(),
      display: form.value.display.trim(),
      baseUrl: form.value.baseUrl.trim(),
      kind: form.value.kind,
      models,
      extraHeaders: headers as Record<string, string>,
      extraBody: body,
      enabled: form.value.enabled,
    };
    const r = isEdit.value
      ? await api.proxyProviderUpdate(input)
      : await api.proxyProviderCreate({ ...input, keys: keysFromText() });
    if (r.ok === false) {
      formErr.value = r.message || "保存失败";
      return;
    }
    formOpen.value = false;
    await refresh();
  } catch (e) {
    formErr.value = String((e as Error).message || e);
  } finally {
    busy.value = false;
  }
}

// ===== 逐模型：行操作 / 批量 / 连通性 =====
const rowSel = ref<Set<string>>(new Set());
const rowTest = ref<Record<string, { state: "testing" | "ok" | "fail"; ms?: number; message?: string; sample?: string }>>({});

function rowId(r: ModelRow) {
  return (r.model || "").trim().toLowerCase() || `__blank_${modelRows.value.indexOf(r)}`;
}
// 浮层正文走 el-tooltip（上游 v1.38.0 口径）。这三条都可能为空，空串必须 :disabled——
// 原生 title 给空串是不显示，el-tooltip 给空串会飘出一个空玻璃泡，两档语义得对齐
const rowOkTip = (r: ModelRow) => rowTest.value[rowId(r)]?.sample || "";
const rowFailTip = (r: ModelRow) => rowTest.value[rowId(r)]?.message || "";
const testTip = computed(() =>
  testResult.value ? ((testResult.value.ok ? testResult.value.sample : testResult.value.message) || "") : "");
function addModelRow() {
  modelRows.value.push(blankRow());
}
function removeModelRow(i: number) {
  const id = rowId(modelRows.value[i]);
  modelRows.value.splice(i, 1);
  rowSel.value.delete(id);
  delete rowTest.value[id];
}
function toggleRow(r: ModelRow) {
  const id = rowId(r);
  if (rowSel.value.has(id)) rowSel.value.delete(id);
  else rowSel.value.add(id);
  rowSel.value = new Set(rowSel.value);
}
/** 别名输入框用逗号串承载，写回时切分去空去重——比让用户在表格里操作数组少一层歧义 */
function setAliases(r: ModelRow, text: string) {
  const list = String(text || "")
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
  r.aliases = [...new Set(list)];
}
function setCap(r: ModelRow, key: string, on: boolean) {
  if (on) r.caps = { ...r.caps, [key]: true };
  else {
    const next = { ...r.caps };
    delete next[key];
    r.caps = next;
  }
}
const allSelected = computed(
  () => modelRows.value.length > 0 && modelRows.value.every((r) => (r.model || "").trim() ? rowSel.value.has(rowId(r)) : true),
);
function toggleAll() {
  if (allSelected.value) rowSel.value = new Set();
  else rowSel.value = new Set(modelRows.value.filter((r) => (r.model || "").trim()).map(rowId));
}

/** 批量设置：留空的字段不参与修改——"全选后顺手清了上下文"这种误操作代价太高 */
const batch = ref({ contextLength: "", maxOutputTokens: "", rate: "", images: "", tools: "", reasoning: "", efforts: [] as string[] });
function applyBatch() {
  const b = batch.value;
  const touched = b.contextLength || b.maxOutputTokens || b.rate || b.images || b.tools || b.reasoning || b.efforts.length;
  if (!touched) {
    formErr.value = "批量设置里至少要填一项（留空表示不修改）";
    return;
  }
  formErr.value = "";
  for (const r of modelRows.value) {
    if (!rowSel.value.has(rowId(r))) continue;
    if (b.contextLength) r.contextLength = b.contextLength;
    if (b.maxOutputTokens) r.maxOutputTokens = b.maxOutputTokens;
    if (b.rate) r.rate = b.rate;
    for (const [key, val] of [["images", b.images], ["tools", b.tools], ["reasoning", b.reasoning]] as const) {
      if (!val) continue;
      if (val === "1") r.caps = { ...r.caps, [key]: true };
      else delete r.caps[key];
    }
    if (b.efforts.length) r.efforts = [...b.efforts];
  }
}

/** 单个模型探一次真实请求。Key 来源与"测试连接"一致：表单里现填的优先，
 *  编辑态不重填则从号池挑一把（明文不出主进程）。刻意不做"批量测全部"——
 *  一次点下去就是 N 个真实计费请求，用户要的是按需验一个。 */
async function testOne(r: ModelRow) {
  const model = (r.model || "").trim();
  if (!model) return;
  const id = rowId(r);
  if (rowTest.value[id]?.state === "testing") return;
  const keys = keysFromText();
  const key = keys[0]?.key || "";
  if (!key && !isEdit.value) {
    formErr.value = "请先在「API Key」里填一把 Key 再测试";
    return;
  }
  if (!key) {
    keyPickList.value = (await api.proxyPool()).find((c) => c.id === editingId.value)?.accounts || [];
    keyPickId.value = keyPickList.value[0]?.id || "";
    keyPickModel.value = model;
    keyPickOpen.value = true;
    return;
  }
  await runRowTest(id, model, { key });
}

async function runRowTest(id: string, model: string, { key = "", accountId = "" }) {
  rowTest.value = { ...rowTest.value, [id]: { state: "testing" } };
  const headers = parseJsonObject(form.value.extraHeadersText, "extraHeaders");
  const body = parseJsonObject(form.value.extraBodyText, "extraBody");
  try {
    const r: ProxyProviderTestResult = await api.proxyProviderTest({
      id: form.value.id.trim(),
      accountId: accountId || undefined,
      baseUrl: form.value.baseUrl.trim(),
      key,
      model,
      kind: form.value.kind,
      extraHeaders: typeof headers === "string" ? {} : (headers as Record<string, string>),
      extraBody: typeof body === "string" ? {} : body,
    });
    rowTest.value = {
      ...rowTest.value,
      [id]: r.ok
        ? { state: "ok", ms: r.ms, sample: r.sample }
        : { state: "fail", ms: r.ms, message: r.message || "探测失败" },
    };
  } catch (e) {
    rowTest.value = { ...rowTest.value, [id]: { state: "fail", message: String((e as Error).message || e) } };
  }
}

/** 连通性探测（整店一次）：仍用列表里第一个模型，作用是"地址与 Key 通不通" */
async function doTest() {
  if (testing.value) return;
  const model = modelNames.value[0] || "";
  if (!model) {
    testResult.value = { ok: false, message: "请先添加至少一个模型" };
    return;
  }
  const keys = keysFromText();
  if (!keys[0]?.key) {
    if (!isEdit.value) {
      formErr.value = "请先在「API Key」里填一把 Key 再测试";
      return;
    }
    keyPickList.value = (await api.proxyPool()).find((c) => c.id === editingId.value)?.accounts || [];
    keyPickId.value = keyPickList.value[0]?.id || "";
    keyPickModel.value = "";
    keyPickOpen.value = true;
    return;
  }
  await runTest({ key: keys[0].key });
}

async function runTest({ key = "", accountId = "" }) {
  testing.value = true;
  testResult.value = null;
  formErr.value = "";
  try {
    const headers = parseJsonObject(form.value.extraHeadersText, "extraHeaders");
    const body = parseJsonObject(form.value.extraBodyText, "extraBody");
    testResult.value = await api.proxyProviderTest({
      id: form.value.id.trim(),
      accountId: accountId || undefined,
      baseUrl: form.value.baseUrl.trim(),
      key,
      model: modelNames.value[0] || "",
      kind: form.value.kind,
      extraHeaders: typeof headers === "string" ? {} : (headers as Record<string, string>),
      extraBody: typeof body === "string" ? {} : body,
    });
  } catch (e) {
    testResult.value = { ok: false, message: String((e as Error).message || e) };
  } finally {
    testing.value = false;
  }
}

// 编辑态测试连接的 Key 选择框（明文不出主进程，只回账号 id 与展示字段）
const keyPickOpen = ref(false);
const keyPickId = ref("");
const keyPickList = ref<ProxyAccount[]>([]);
// 从"某一行的测试按钮"进来时记住模型名，选完 Key 直接续上那次探测；整店测试留空
const keyPickModel = ref("");
async function confirmKeyPick() {
  keyPickOpen.value = false;
  if (keyPickModel.value) {
    const model = keyPickModel.value;
    keyPickModel.value = "";
    await runRowTest(model.toLowerCase(), model, { accountId: keyPickId.value });
    return;
  }
  await runTest({ accountId: keyPickId.value });
}

// ===== 从上游拉取：三态 diff，勾选合并 =====
const importOpen = ref(false);
const importState = ref<"loading" | "ready" | "error" | "stale">("loading");
const importErr = ref("");
const upstreamIds = ref<string[]>([]);
// 拉取时的地址/协议签名：改过之后再结果就"过期"了，直接应用会拿旧清单配新地址
const importSig = ref("");
const selAdd = ref<Set<string>>(new Set());
const selKeep = ref<Set<string>>(new Set());
const selDrop = ref<Set<string>>(new Set());

const importGroups = computed(() => {
  const cur = new Set(modelNames.value.map((s) => s.toLowerCase()));
  const up = new Set(upstreamIds.value.map((s) => s.toLowerCase()));
  return {
    added: upstreamIds.value.filter((id) => !cur.has(id.toLowerCase())),
    existing: upstreamIds.value.filter((id) => cur.has(id.toLowerCase())),
    removed: [...cur].filter((k) => !up.has(k)).map((k) => modelNames.value.find((m) => m.toLowerCase() === k) || k),
  };
});

function sigNow() {
  return `${form.value.baseUrl.trim()}|${form.value.kind}`;
}

async function openImport() {
  if (!isEdit.value) {
    formErr.value = "「从上游拉取」要先保存一次（拉取用号池里已存的 Key）";
    return;
  }
  formErr.value = "";
  importOpen.value = true;
  await doImport();
}

async function doImport() {
  importState.value = "loading";
  importErr.value = "";
  importSig.value = sigNow();
  try {
    const r = await api.proxyProviderFetchModels(editingId.value);
    if (r.ok === false) {
      importState.value = "error";
      importErr.value = r.message || "拉取失败";
      return;
    }
    upstreamIds.value = (r.models || []).map(String);
    const g = importGroups.value;
    // 新增默认不勾（用户可能只想看），已存在默认保持，下架默认保留——删除必须是显式动作
    selAdd.value = new Set();
    selKeep.value = new Set(g.existing);
    selDrop.value = new Set(g.removed);
    importState.value = "ready";
  } catch (e) {
    importState.value = "error";
    importErr.value = String((e as Error).message || e);
  }
}

// 模板里 ref 会自动解包，所以不能把 selAdd 当 Ref 传进函数——各自给一个显式切换器
function toggleAdd(id: string) {
  const s = new Set(selAdd.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selAdd.value = s;
}
function toggleDrop(id: string) {
  const s = new Set(selDrop.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  selDrop.value = s;
}

function applyImport() {
  const keep = new Set(modelNames.value.map((s) => s.toLowerCase()));
  for (const id of importGroups.value.removed) {
    if (!selDrop.value.has(id)) keep.delete(id.toLowerCase());
  }
  const rows = modelRows.value.filter((r) => keep.has(rowId(r)));
  for (const id of selAdd.value) {
    if (!keep.has(id.toLowerCase())) rows.push({ ...blankRow(), model: id });
  }
  modelRows.value = rows;
  importOpen.value = false;
}

const importStale = computed(() => importState.value === "ready" && importSig.value !== sigNow());

// ===== Key 管理 =====
const keysOpen = ref(false);
const keysRow = ref<ProxyProvider | null>(null);
const keysList = ref<ProxyAccount[]>([]);
const newKey = ref({ name: "", key: "" });
const keyErr = ref("");
const keyBusy = ref(false);
async function openKeys(row: ProxyProvider) {
  keysRow.value = row;
  newKey.value = { name: "", key: "" };
  keyErr.value = "";
  await reloadKeys(row.id);
  keysOpen.value = true;
}
async function reloadKeys(id: string) {
  const ch = (await api.proxyPool()).find((c) => c.id === id);
  keysList.value = ch?.accounts || [];
}
async function doAddKey() {
  if (!keysRow.value || keyBusy.value) return;
  keyBusy.value = true;
  keyErr.value = "";
  try {
    const r = await api.proxyProviderAddKey(keysRow.value.id, newKey.value.key.trim(), newKey.value.name.trim());
    if (r.ok === false) {
      keyErr.value = r.message || "添加失败";
      return;
    }
    newKey.value = { name: "", key: "" };
    await reloadKeys(keysRow.value.id);
    await refresh();
  } catch (e) {
    keyErr.value = String((e as Error).message || e);
  } finally {
    keyBusy.value = false;
  }
}
async function doRemoveKey(acc: ProxyAccount) {
  if (!keysRow.value) return;
  try {
    const r = await api.proxyProviderRemoveKey(acc.id);
    if (r.ok === false) keyErr.value = r.message || "移出失败";
    await reloadKeys(keysRow.value.id);
    await refresh();
  } catch (e) {
    keyErr.value = String((e as Error).message || e);
  }
}

async function toggleEnabled(row: ProxyProvider) {
  try {
    await api.proxyProviderUpdate({ id: row.id, enabled: !row.enabled });
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

// ===== 删除确认 =====
const delOpen = ref(false);
const delRow = ref<ProxyProvider | null>(null);
async function doDelete() {
  if (!delRow.value) return;
  try {
    const r = await api.proxyProviderDelete(delRow.value.id);
    if (r.ok === false) err.value = r.message || "删除失败";
    delOpen.value = false;
    await refresh();
  } catch (e) {
    err.value = String((e as Error).message || e);
  }
}

onMounted(refresh);
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>
      <div class="toolbar">
        <button class="btn btn-primary" @click="openCreate()">添加自定义提供商</button>
      </div>
      <div class="tbl-wrap" style="margin-top: 12px">
        <table class="tbl">
          <tbody>
            <tr><th>标识</th><th>名称</th><th>上游协议</th><th>上游地址</th><th>Key</th><th>模型</th><th>状态</th><th>更新</th><th>操作</th></tr>
            <tr v-for="p in rows" :key="p.id">
              <td class="mono">{{ p.id }}</td>
              <td>{{ p.display }}</td>
              <td><span class="tag tag-dim">{{ kindLabel(p.kind) }}</span></td>
              <el-tooltip :content="p.baseUrl" :disabled="!p.baseUrl" placement="top">
                <td class="mono url-cell">{{ p.baseUrl }}</td>
              </el-tooltip>
              <td class="mono num">{{ p.onlineCount ?? 0 }}/{{ p.keyCount ?? 0 }}</td>
              <td class="mono num">{{ p.models.length }}</td>
              <td>
                <span class="tag" :class="p.enabled ? 'tag-ok' : 'tag-dim'">{{ p.enabled ? "启用" : "已停用" }}</span>
                <span v-if="p.enabled && !(p.keyCount ?? 0)" class="tag tag-warn">无 Key</span>
              </td>
              <td class="mono">{{ fmtAgo(p.updatedAt) }}</td>
              <td>
                <button class="btn-link btn-sm" @click="openKeys(p)">Key 管理</button>
                <button class="btn-link btn-sm" @click="openEdit(p)">编辑</button>
                <button class="btn-link btn-sm" @click="toggleEnabled(p)">{{ p.enabled ? "停用" : "启用" }}</button>
                <button class="btn-link btn-sm danger" @click="delRow = p; delOpen = true">删除</button>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="9" style="text-align: center; color: var(--text-3); padding: 18px">
                还没有自定义提供商 —— 点上方「添加自定义提供商」接入中转站或自建端点；
                接好后客户端用 <span class="mono">标识/模型名</span> 调用即可，与其他渠道共用同一个网关地址
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top: 12px">
        <div class="card-title">接入约定</div>
        <div class="code">
          客户端把 base_url 指向本网关、填一把网关 Key，模型名写 <b>标识/模型名</b>（如 myrelay/gpt-4o）即可直达该提供商。<br />
          不带前缀的裸模型名一律先归内置渠道，只有内置目录里没有、且只有一家提供商拥有时才会落到提供商——自建条目不会悄悄顶掉生态渠道。<br />
          模型清单里的别名同样能请求（<span class="mono">标识/别名</span>），但不出现在 /v1/models。
        </div>
      </div>
    </div>

    <Teleport to="body">
      <!-- 新建 / 编辑 -->
      <div v-if="formOpen" class="p-mask" @click.self="formOpen = false">
        <div class="p-dlg glass form-dlg">
          <div class="form-head">
            <div class="p-title">{{ isEdit ? "编辑自定义提供商" : "添加自定义提供商" }}</div>
            <div v-if="formErr" class="set-desc err-text">{{ formErr }}</div>
          </div>
          <div class="form-body">
            <div class="f-grid">
              <div class="f-row">
                <div class="set-name">标识</div>
                <input v-model="form.id" class="input mono f-input" :disabled="isEdit" placeholder="myslug" />
                <div class="set-desc">模型名前缀（{{ form.id || "myslug" }}/gpt-4o），创建后不可改</div>
              </div>
              <div class="f-row">
                <div class="set-name">显示名</div>
                <input v-model="form.display" class="input f-input" placeholder="我的中转站" />
                <div class="set-desc">只影响界面展示，留空则用标识</div>
              </div>
            </div>
            <div class="f-row">
              <div class="set-name">上游地址</div>
              <input v-model="form.baseUrl" class="input mono f-input" placeholder="https://relay.example.com/v1" />
              <div class="set-desc">填到 <span class="mono">/v1</span> 为止，端点名由网关按下面的协议补</div>
            </div>
            <div class="f-row">
              <div class="set-name">上游协议</div>
              <el-select v-model="form.kind" popper-class="glass-popper" class="f-sel">
                <el-option v-for="o in KIND_OPTIONS" :key="o.value" :value="o.value" :label="o.label" />
              </el-select>
              <div class="set-desc">{{ kindMeta?.hint }}；内部会互转，客户端看不出区别</div>
              <div v-if="kindMeta?.lossy" class="set-desc f-warn">{{ kindMeta.lossy }}</div>
            </div>
            <div class="f-row f-models">
              <div class="set-name">模型清单<span class="f-count">{{ modelRows.filter((r) => r.model).length }} 个</span></div>
              <div class="models-bar">
                <button class="btn btn-sm" @click="openImport">从上游拉取</button>
                <button class="btn btn-sm" @click="addModelRow">添加模型</button>
                <label v-if="modelRows.length" class="m-selall">
                  <input type="checkbox" :checked="allSelected" @change="toggleAll" /> 全选
                </label>
                <span v-if="dupModels.length" class="set-desc err-text">模型名重复：{{ dupModels.join("、") }}</span>
              </div>

              <!-- 批量条紧贴工具条而不是压在列表末尾：它是「勾选之后的下一步」，
                   隔着一屏模型行放下面，勾完就看不见回来了 -->
              <div v-if="rowSel.size" class="m-batch">
                <span class="set-desc">已选 {{ rowSel.size }} 个 →</span>
                <label class="m-num">上下文<input v-model="batch.contextLength" class="input mono" type="number" placeholder="不改" /></label>
                <label class="m-num">最大输出<input v-model="batch.maxOutputTokens" class="input mono" type="number" placeholder="不改" /></label>
                <label class="m-num">倍率<input v-model="batch.rate" class="input mono" type="number" step="0.1" placeholder="不改" /></label>
                <label v-for="c in CAPS" :key="c.key" class="m-num">
                  {{ c.label }}
                  <select v-model="batch[c.key]" class="input">
                    <option value="">不改</option><option value="1">设为支持</option><option value="0">设为不支持</option>
                  </select>
                </label>
                <el-select v-model="batch.efforts" multiple collapse-tags size="small" popper-class="glass-popper" class="m-efforts" placeholder="档位（不改）">
                  <el-option v-for="e in EFFORT_LEVELS" :key="e" :value="e" :label="e" />
                </el-select>
                <button class="btn btn-sm" @click="applyBatch">应用到所选</button>
              </div>

              <div v-if="!modelRows.length" class="models-empty set-desc">
                还没有模型 —— 点「添加模型」手填，或「从上游拉取」后勾选导入；留空也能用，带前缀的模型名原样透传给上游
              </div>

              <div v-for="(m, i) in modelRows" :key="i" class="m-row" :class="{ on: rowSel.has(rowId(m)) }">
                <div class="m-line">
                  <input type="checkbox" class="m-check" :checked="rowSel.has(rowId(m))" @change="toggleRow(m)" />
                  <input v-model="m.model" class="input mono m-name" placeholder="gpt-4o" />
                  <input :value="m.aliases.join(', ')" class="input mono m-alias" placeholder="别名，逗号分隔"
                         @input="setAliases(m, ($event.target as HTMLInputElement).value)" />
                  <input v-model="m.upstream" class="input mono m-up" placeholder="上游真名（缺省同模型名）" />
                </div>
                <div class="m-line m-sub">
                  <label class="m-num">上下文<input v-model="m.contextLength" class="input mono" type="number" placeholder="128000" /></label>
                  <label class="m-num">最大输出<input v-model="m.maxOutputTokens" class="input mono" type="number" placeholder="4096" /></label>
                  <label class="m-num">倍率<input v-model="m.rate" class="input mono" type="number" step="0.1" placeholder="-" /></label>
                  <label v-for="c in CAPS" :key="c.key" class="m-cap">
                    <input type="checkbox" :checked="!!m.caps[c.key]" @change="setCap(m, c.key, ($event.target as HTMLInputElement).checked)" /> {{ c.label }}
                  </label>
                  <el-select v-model="m.efforts" multiple collapse-tags collapse-tags-tooltip size="small"
                             popper-class="glass-popper" class="m-efforts" placeholder="思考档位">
                    <el-option v-for="e in EFFORT_LEVELS" :key="e" :value="e" :label="e" />
                  </el-select>
                  <button class="btn btn-sm m-test" :disabled="!m.model || rowTest[rowId(m)]?.state === 'testing'" @click="testOne(m)">
                    {{ rowTest[rowId(m)]?.state === "testing" ? "测试中…" : "测试" }}
                  </button>
                  <el-tooltip v-if="rowTest[rowId(m)]?.state === 'ok'" :content="rowOkTip(m)" :disabled="!rowOkTip(m)" placement="top">
                    <span class="tag tag-ok">可用 {{ rowTest[rowId(m)]?.ms }}ms</span>
                  </el-tooltip>
                  <el-tooltip v-else-if="rowTest[rowId(m)]?.state === 'fail'" :content="rowFailTip(m)" :disabled="!rowFailTip(m)" placement="top">
                    <span class="tag tag-warn m-fail">{{ (rowTest[rowId(m)]?.message || "").slice(0, 40) }}</span>
                  </el-tooltip>
                  <button class="btn-link btn-sm m-del danger" @click="removeModelRow(i)">移除</button>
                </div>
              </div>
            </div>
            <div v-if="!isEdit" class="f-row">
              <div class="set-name">API Key</div>
              <textarea v-model="form.keysText" class="input mono f-input" rows="3" placeholder="sk-..."></textarea>
              <div class="set-desc">一行一把；多把自动轮转，被限流的那把单独冷却。可留空，之后在「Key 管理」里加</div>
            </div>
            <div class="f-grid">
              <div class="f-row">
                <div class="set-name">自定义请求头</div>
                <textarea v-model="form.extraHeadersText" class="input mono f-input" rows="2" placeholder='{ "X-Channel": "agenthub" }'></textarea>
                <div class="set-desc">JSON 对象，选填；鉴权头由网关按 Key 生成，不能在这里覆盖</div>
              </div>
              <div class="f-row">
                <div class="set-name">附加请求体字段</div>
                <textarea v-model="form.extraBodyText" class="input mono f-input" rows="2" placeholder='{ "reasoning": { "effort": "high" } }'></textarea>
                <div class="set-desc">JSON 对象，选填，深合并进上游请求体；不能覆盖 model / messages / stream</div>
              </div>
            </div>
            <div class="f-inline">
              <div class="f-inline-info">
                <div class="set-name">启用</div>
                <div class="set-desc">停用即从路由视图消失，带该前缀的请求会报「模型不在目录中」</div>
              </div>
              <el-switch v-model="form.enabled" />
            </div>
          </div>
          <!-- 操作条固定在弹窗底部：表单比视口高，按钮跟着滚走的话每次保存都要先滚到底 -->
          <div class="form-foot">
            <!-- 测试期间按钮是 disabled（鼠标事件被浏览器吞掉，浮层此时不出），但那一秒按钮自己写着「测试中…」，
                 不需要浮层解释，所以不额外套 span 承接 hover —— 只有"常置 disabled 且提示在解释为什么点不动"才套 -->
            <el-tooltip content="向上游发一次 max_tokens=16 的真实最小请求：会计费，但不改动号池 Key 的冷却状态" placement="top">
              <button class="btn" :disabled="testing" @click="doTest">
                {{ testing ? "测试中…" : "测试连接" }}
              </button>
            </el-tooltip>
            <el-tooltip v-if="testResult" :content="testTip" :disabled="!testTip" placement="top">
              <span class="set-desc f-foot-msg" :class="{ 'err-text': !testResult.ok }">
                <template v-if="testResult.ok">
                  通过 {{ testResult.ms }}ms · {{ testResult.finishReason || "-" }} · token {{ testResult.usage?.prompt_tokens ?? "?" }}/{{ testResult.usage?.completion_tokens ?? "?" }}
                </template>
                <template v-else>失败：{{ testResult.message }}<template v-if="testResult.status">（HTTP {{ testResult.status }}）</template></template>
              </span>
            </el-tooltip>
            <button class="btn f-foot-push" @click="formOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="busy" @click="doSave">{{ busy ? "保存中…" : "保存" }}</button>
          </div>
        </div>
      </div>

      <!-- Key 管理 -->
      <div v-if="keysOpen" class="p-mask" @click.self="keysOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">{{ keysRow?.display }} · API Key</div>
          <div v-if="vault && !vault.encrypted" class="set-row">
            <div class="set-info">
              <div class="set-name">系统加密不可用</div>
              <div class="set-desc err-text">本机 DPAPI / safeStorage 取不到密钥，Key 将<b>明文</b>写入 stats.db（与现有渠道账号同一策略）。换机器或重装系统前请先导出。</div>
            </div>
          </div>
          <div v-if="keyErr" class="set-row"><div class="set-info"><div class="set-desc err-text">{{ keyErr }}</div></div></div>
          <div class="tbl-wrap">
            <table class="tbl">
              <tbody>
                <tr><th>名称</th><th>状态</th><th>今日</th><th>最近使用</th><th>操作</th></tr>
                <tr v-for="acc in keysList" :key="acc.id">
                  <td>{{ acc.name }}</td>
                  <td>
                    <span class="tag" :class="acc.status === 'online' ? 'tag-ok' : 'tag-dim'">{{ ACCOUNT_STATUS[acc.status]?.text || acc.status }}</span>
                    <span v-if="acc.coolReason" class="set-desc"> · {{ acc.coolReason }}</span>
                  </td>
                  <td class="mono num">{{ acc.todayReq }} 次</td>
                  <td class="mono">{{ fmtAgo(acc.lastUsed) }}</td>
                  <td><button class="btn-link btn-sm danger" @click="doRemoveKey(acc)">移出</button></td>
                </tr>
                <tr v-if="!keysList.length"><td colspan="5" class="empty-row">还没有 Key —— 在下方填一把。没有可用 Key 的提供商不会被调度</td></tr>
              </tbody>
            </table>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">名称</div></div>
            <input v-model="newKey.name" class="input" style="width: 160px" placeholder="主 Key" />
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">API Key</div><div class="set-desc">加密存库；同一把重复粘贴会被拒</div></div>
            <input v-model="newKey.key" class="input mono" style="width: 300px" placeholder="sk-..." />
          </div>
          <div class="p-actions">
            <button class="btn" @click="keysOpen = false">关闭</button>
            <button class="btn btn-primary" :disabled="keyBusy || !newKey.key.trim()" @click="doAddKey">{{ keyBusy ? "添加中…" : "添加 Key" }}</button>
          </div>
        </div>
      </div>

      <!-- 编辑态测试连接时从号池挑一把 Key -->
      <div v-if="keyPickOpen" class="p-mask" @click.self="keyPickOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">选一把已有 Key 来测试</div>
          <div class="set-desc" style="margin-bottom: 8px">表单里的 Key 输入框是空的（编辑态不重填），测试需要一把真 Key。选中的 Key 只用于这次请求，不会被改动冷却状态。</div>
          <el-select v-model="keyPickId" popper-class="glass-popper" style="width: 100%">
            <el-option v-for="a in keyPickList" :key="a.id" :value="a.id" :label="`${a.name}（${ACCOUNT_STATUS[a.status]?.text || a.status}）`" />
          </el-select>
          <div class="p-actions">
            <button class="btn" @click="keyPickOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="!keyPickId" @click="confirmKeyPick">测试</button>
          </div>
        </div>
      </div>

      <!-- 从上游拉取：三态 diff 勾选合并（新增默认不勾 / 已存在默认保留 / 下架默认保留，删除要显式取消勾选） -->
      <div v-if="importOpen" class="p-mask" @click.self="importOpen = false">
        <div class="p-dlg glass imp-dlg">
          <div class="p-title">从上游拉取模型</div>
          <div v-if="importState === 'loading'" class="set-desc">正在请求上游 /v1/models…</div>
          <div v-else-if="importState === 'error'" class="set-desc err-text">
            {{ importErr }}
            <div class="p-actions"><button class="btn" @click="importOpen = false">关闭</button><button class="btn btn-primary" @click="doImport">重试</button></div>
          </div>
          <template v-else>
            <div v-if="importStale" class="set-desc imp-stale">
              地址或上游协议在拉取之后改过了，这份清单已经过期——先重新拉取再合并，否则会把旧地址的模型配到新地址上。
              <button class="btn-link btn-sm" @click="doImport">重新拉取</button>
            </div>
            <div class="set-desc imp-sum">上游共 {{ upstreamIds.length }} 个模型：新增 {{ importGroups.added.length }} · 已存在 {{ importGroups.existing.length }} · 上游已下架 {{ importGroups.removed.length }}</div>

            <div v-if="importGroups.added.length" class="imp-group">
              <div class="imp-head">
                <b>新增</b>
                <span class="set-desc">默认不勾选，勾上的才加进清单</span>
                <button class="btn-link btn-sm" @click="selAdd = new Set(importGroups.added)">全选</button>
                <button class="btn-link btn-sm" @click="selAdd = new Set()">清空</button>
              </div>
              <label v-for="id in importGroups.added" :key="id" class="imp-item">
                <input type="checkbox" :checked="selAdd.has(id)" @change="toggleAdd(id)" /> <span class="mono">{{ id }}</span>
              </label>
            </div>

            <div v-if="importGroups.existing.length" class="imp-group">
              <div class="imp-head"><b>已存在</b><span class="set-desc">保留现有配置（别名、上下文、档位都不动）</span></div>
              <div class="imp-item set-desc">共 {{ importGroups.existing.length }} 个：{{ importGroups.existing.join("、") }}</div>
            </div>

            <div v-if="importGroups.removed.length" class="imp-group">
              <div class="imp-head">
                <b>上游已下架</b>
                <span class="set-desc">默认保留；取消勾选即从清单里删除</span>
              </div>
              <label v-for="id in importGroups.removed" :key="id" class="imp-item">
                <input type="checkbox" :checked="selDrop.has(id)" @change="toggleDrop(id)" /> <span class="mono">{{ id }}</span>
              </label>
            </div>

            <div v-if="!importGroups.added.length && !importGroups.removed.length" class="set-desc">上游清单与本地一致，无需合并。</div>

            <div class="p-actions">
              <button class="btn" @click="importOpen = false">取消</button>
              <button class="btn btn-primary" :disabled="importStale" @click="applyImport">
                合并（新增 {{ selAdd.size }} 个、删除 {{ importGroups.removed.length - selDrop.size }} 个）
              </button>
            </div>
          </template>
        </div>
      </div>

      <!-- 删除确认 -->
      <div v-if="delOpen" class="p-mask" @click.self="delOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">删除自定义提供商</div>
          <div class="set-desc">
            确定删除「{{ delRow?.display }}」（{{ delRow?.id }}）？它的 {{ delRow?.keyCount ?? 0 }} 把 Key 会一并移出。
            正在用 <span class="mono">{{ delRow?.id }}/模型名</span> 的客户端会立即收到「模型不在任何渠道目录中」。
          </div>
          <div class="p-actions">
            <button class="btn" @click="delOpen = false">取消</button>
            <button class="btn btn-primary danger-solid" @click="doDelete">删除</button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
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
.danger {
  color: var(--err, #e05555);
}
.url-cell {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* ===== 表单弹窗：标题与操作条固定，只有中间字段区滚动 =====
   整窗一起滚的话「保存」会在填到一半时滚出视口，每次提交都得先滚到底。
   .p-dlg 自带 padding 与 overflow:hidden，这里改成三段式布局，内边距下放到各段。 */
.form-dlg {
  width: 780px;
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  padding: 0;
}
.form-head {
  flex: none;
  padding: 16px 18px 0;
}
.form-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 2px 18px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.form-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 18px 14px;
  border-top: 1px solid var(--line);
}
/* 测试结果挤在按钮排里：长了就截断，完整内容在 el-tooltip 浮层上 */
.f-foot-msg {
  max-width: 330px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.f-foot-push {
  margin-left: auto;
}
/* 字段一律「标签在上、控件吃满宽度」。老的左标签 + 右窄控件写法把 URL 和 JSON 挤断，
   而省下来的说明只能塞进左列那条缝——说明越长，布局越歪。 */
.f-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.f-models {
  gap: 6px;
}
.f-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.f-warn {
  color: var(--warn, #d9a13b);
}
.f-count {
  margin-left: 6px;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--text-3);
}
.f-input {
  width: 100%;
}
/* 上游协议下拉：.f-input 是给原生 input 的壳（根上再画一层边框 + 10px 内边距），
   挂到 el-select 根上会同时坏两处：① 内层 .el-select__wrapper 自带走一遍边框底色，
   于是套出双层框；② Element 的弹层按根的 border-box 定宽（取 selectRef.offsetWidth）、
   却按内层 wrapper 定位，弹层因此整体右移一个内边距、右缘越过控件。这里只给根定宽，
   尺寸交给 wrapper，与同列 .f-input 的 30px / 12px 齐平。 */
.f-sel {
  width: 100%;
}
.f-sel :deep(.el-select__wrapper) {
  min-height: var(--ctl-h);
  font-size: 12px;
}
.f-inline {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
}
.f-inline-info {
  min-width: 0;
}
.models-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.m-selall {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-3);
  margin-left: auto;
}
.models-empty {
  padding: 10px;
  border: 1px dashed var(--border, rgba(255, 255, 255, 0.12));
  border-radius: 8px;
  text-align: center;
}
.m-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px;
  border: 1px solid var(--border, rgba(255, 255, 255, 0.1));
  border-radius: 8px;
}
.m-row.on {
  border-color: var(--accent);
  background: var(--accent-dim, rgba(90, 140, 255, 0.08));
}
.m-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.m-sub {
  padding-left: 22px;
}
.m-check {
  flex: none;
}
.m-name {
  width: 208px;
}
.m-alias {
  width: 196px;
}
.m-up {
  width: 244px;
}
.m-num {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-3);
}
.m-num .input {
  width: 86px;
}
.m-cap {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 12px;
  color: var(--text-3);
}
.m-efforts {
  width: 168px;
}
.m-test {
  flex: none;
}
.m-del {
  margin-left: auto;
}
.m-fail {
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.m-batch {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 8px;
  border: 1px solid var(--accent);
  border-radius: 8px;
}
/* 导入弹窗 */
.imp-dlg {
  max-height: 78vh;
  overflow: auto;
}
.imp-stale {
  color: var(--warn, #d9a13b);
  margin-bottom: 6px;
}
.imp-sum {
  margin-bottom: 8px;
}
.imp-group {
  margin-bottom: 10px;
}
.imp-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 4px;
}
.imp-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 0 2px 6px;
  font-size: 13px;
}
textarea.input {
  width: 100%;
  max-width: 320px;
  resize: vertical;
  font-size: 12px;
  line-height: 1.6;
}
.empty-row {
  text-align: center;
  color: var(--text-3);
  padding: 14px;
}
</style>
