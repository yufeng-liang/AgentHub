<!-- 反代网关 · 提供商：把第三方中转站 / 自建 OpenAI 兼容端点接进网关。
     一个提供商 = 一个上游端点 + 若干把 API Key（Key 走号池轮转与冷却）；模型以 `标识/模型名` 形态被客户端调用。
     与「号池」页的分工：这里管端点本身（地址、Key 集合、模型清单、连通性），号池页管各渠道账号的运行状态 -->
<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
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
// modelsText / keysText 用文本承载：一行一个模型名是常态，
// 需要 upstream 别名或目录元数据时整段写 JSON 数组即可（两种写法都支持，见 parseModelsText）
const formOpen = ref(false);
const editingId = ref("");
const form = ref({
  id: "",
  display: "",
  baseUrl: "",
  kind: "openai_compat" as ProxyProviderKind,
  modelsText: "",
  keysText: "",
  extraHeadersText: "",
  extraBodyText: "",
  enabled: true,
});
const formErr = ref("");
const testResult = ref<ProxyProviderTestResult | null>(null);
const testing = ref(false);

const isEdit = computed(() => !!editingId.value);

/** 一行一个（也容忍逗号分隔）；整段以 [ 或 { 开头则按 JSON 解析，供 upstream 别名与元数据用 */
function parseModelsText(text: string): ProxyProviderModel[] | string {
  const t = String(text || "").trim();
  if (!t) return [];
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      const v = JSON.parse(t);
      return Array.isArray(v) ? (v as ProxyProviderModel[]) : [v as ProxyProviderModel];
    } catch (e) {
      return `模型清单不是合法 JSON：${String((e as Error).message || e)}`;
    }
  }
  return t.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
}

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

function modelsPreview(text: string): string {
  const m = parseModelsText(text);
  return typeof m === "string" ? "" : m.map((x) => (typeof x === "string" ? x : x.model)).join(", ");
}

function openCreate() {
  editingId.value = "";
  form.value = { id: "", display: "", baseUrl: "", kind: "openai_compat", modelsText: "", keysText: "", extraHeadersText: "", extraBodyText: "", enabled: true };
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
    kind: row.kind === "anthropic_messages" ? "anthropic_messages" : "openai_compat",
    modelsText: row.models && row.models.length ? JSON.stringify(row.models, null, 2) : "",
    keysText: "",
    extraHeadersText: row.extraHeaders && Object.keys(row.extraHeaders).length ? JSON.stringify(row.extraHeaders, null, 2) : "",
    extraBodyText: row.extraBody && Object.keys(row.extraBody).length ? JSON.stringify(row.extraBody, null, 2) : "",
    enabled: row.enabled,
  };
  formErr.value = "";
  testResult.value = null;
  formOpen.value = true;
}

async function doSave() {
  if (busy.value) return;
  const models = parseModelsText(form.value.modelsText);
  if (typeof models === "string") {
    formErr.value = models;
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

/** 连通性探测：优先用表单里当场填的地址 + 第一行 Key；编辑态不重填 Key 时改从号池挑一把
 *  （主进程按 accountId 自己解密，明文不经过渲染层）。两条路都不读号池调度，
 *  所以按新地址试一次不会把号池里的 Key 打成冷却。 */
async function doTest() {
  if (testing.value) return;
  const keys = keysFromText();
  const model = modelsPreview(form.value.modelsText).split(",")[0]?.trim() || "";
  if (!model) {
    testResult.value = { ok: false, message: "请先填至少一个模型名" };
    return;
  }
  if (!keys[0]?.key) {
    if (!isEdit.value) {
      formErr.value = "请先在「API Key」里填一把 Key 再测试";
      return;
    }
    // 编辑态：弹选择框让用户指定用号池里哪把 Key 试，选完自动继续这次探测
    keyPickList.value = (await api.proxyPool()).find((c) => c.id === editingId.value)?.accounts || [];
    keyPickId.value = keyPickList.value[0]?.id || "";
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
      model: modelsPreview(form.value.modelsText).split(",")[0]?.trim() || "",
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
async function confirmKeyPick() {
  keyPickOpen.value = false;
  await runTest({ accountId: keyPickId.value });
}

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

/** 从上游 /models 拉清单回填文本框（需要该提供商已有 Key，主进程用号池里的 Key 去打） */
const fetchBusy = ref(false);
async function doFetchModels() {
  if (!isEdit.value || fetchBusy.value) {
    if (!isEdit.value) formErr.value = "「从上游拉取」要先保存一次（拉取用号池里已存的 Key）";
    return;
  }
  fetchBusy.value = true;
  formErr.value = "";
  try {
    const r = await api.proxyProviderFetchModels(editingId.value);
    if (r.ok === false) {
      formErr.value = r.message || "拉取失败";
      return;
    }
    form.value.modelsText = (r.models || []).join("\n");
  } catch (e) {
    formErr.value = String((e as Error).message || e);
  } finally {
    fetchBusy.value = false;
  }
}

onMounted(refresh);
</script>

<template>
  <section class="page">
    <div class="page-body">
      <div v-if="err" class="card err-card"><div class="set-desc err-text">{{ err }}</div></div>
      <div class="toolbar">
        <button class="btn btn-primary" @click="openCreate()">添加提供商</button>
      </div>
      <div class="tbl-wrap" style="margin-top: 12px">
        <table class="tbl">
          <tbody>
            <tr><th>标识</th><th>名称</th><th>上游协议</th><th>上游地址</th><th>Key</th><th>模型</th><th>状态</th><th>更新</th><th>操作</th></tr>
            <tr v-for="p in rows" :key="p.id">
              <td class="mono">{{ p.id }}</td>
              <td>{{ p.display }}</td>
              <td><span class="tag tag-dim">{{ p.kind === "anthropic_messages" ? "Anthropic Messages" : "OpenAI Chat" }}</span></td>
              <td class="mono url-cell" :title="p.baseUrl">{{ p.baseUrl }}</td>
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
                还没有自定义提供商 —— 点上方「添加提供商」接入中转站或自建端点；
                接好后客户端用 <span class="mono">标识/模型名</span> 调用即可，与其他渠道共用同一个网关地址
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card" style="margin-top: 12px">
        <div class="card-title">接入约定</div>
        <div class="code">
          客户端只需把 base_url 指向本网关并填一个网关 Key，模型名写 <b>标识/模型名</b>（如 myrelay/gpt-4o）即可直达该提供商。<br />
          标识是路由前缀，创建后不可改；不带前缀的裸模型名一律先归内置渠道，只有在内置目录里查不到、
          且恰好只有一家提供商拥有时才会落到提供商——这样自建条目永远不会悄悄顶掉生态渠道。
        </div>
      </div>
    </div>

    <Teleport to="body">
      <!-- 新建 / 编辑 -->
      <div v-if="formOpen" class="p-mask" @click.self="formOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">{{ isEdit ? "编辑提供商" : "添加提供商" }}</div>
          <div v-if="formErr" class="set-row">
            <div class="set-info"><div class="set-desc err-text">{{ formErr }}</div></div>
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">标识</div>
              <div class="set-desc">模型名前缀（{{ form.id || "myslug" }}/gpt-4o）；2~32 位小写字母、数字、- 或 _</div>
            </div>
            <input v-model="form.id" class="input mono" style="width: 200px" :disabled="isEdit" placeholder="myslug" />
          </div>
          <div v-if="isEdit" class="set-row">
            <div class="set-info"><div class="set-desc">标识创建后不可改（Key 与历史流水都挂在它上面）。要换名请新建一个再删掉旧的。</div></div>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">显示名</div><div class="set-desc">只影响界面展示</div></div>
            <input v-model="form.display" class="input" style="width: 200px" placeholder="我的中转站" />
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">上游地址</div>
              <div class="set-desc">填到版本前缀为止，如 https://relay.example.com/v1；保存时会自动去掉尾部的 /v1 与 /chat/completions</div>
            </div>
            <input v-model="form.baseUrl" class="input mono" style="width: 300px" placeholder="https://relay.example.com/v1" />
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">上游协议</div>
              <div class="set-desc">中转站给的是 OpenAI 兼容地址就选 OpenAI Chat；只认 /v1/messages 的 Claude 中转站选 Anthropic Messages。<br />两种网关都能接，内部会互转，客户端侧看不出区别。<br />
                选 Anthropic Messages 时有几处转换是单向的：多段 system 会拼成一段、历史里的思考链与签名不带回上游、cache_control 与服务端工具（web_search 等）丢弃。</div>
            </div>
            <el-select v-model="form.kind" popper-class="glass-popper" style="width: 220px">
              <el-option value="openai_compat" label="OpenAI Chat 兼容" />
              <el-option value="anthropic_messages" label="Anthropic Messages" />
            </el-select>
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">模型清单</div>
              <div class="set-desc">一行一个模型名。需要「客户端名 ≠ 上游真名」或补上下文长度等元数据时，整段改写 JSON 数组：<br />[{ "model": "gpt-4o", "upstream": "gpt-4o-2024-11-20", "contextLength": 128000 }]<br />留空也能用：带前缀的模型名会原样透传给上游</div>
            </div>
            <div class="models-col">
              <textarea v-model="form.modelsText" class="input mono" rows="5" placeholder="gpt-4o&#10;claude-sonnet-4.5&#10;deepseek-v3.2"></textarea>
              <div class="models-tools">
                <button class="btn btn-sm" :disabled="fetchBusy" @click="doFetchModels">{{ fetchBusy ? "拉取中…" : "从上游拉取" }}</button>
                <span v-if="modelsPreview(form.modelsText)" class="set-desc">预览：{{ modelsPreview(form.modelsText) }}</span>
              </div>
            </div>
          </div>
          <div v-if="!isEdit" class="set-row">
            <div class="set-info">
              <div class="set-name">API Key</div>
              <div class="set-desc">一行一把，可留空稍后在「Key 管理」里加。多把 Key 自动轮转，被限流的那把单独冷却</div>
            </div>
            <textarea v-model="form.keysText" class="input mono" rows="3" placeholder="sk-..."></textarea>
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">自定义请求头</div>
              <div class="set-desc">JSON 对象，选填。鉴权头由网关按 Key 生成，不允许在此覆盖</div>
            </div>
            <textarea v-model="form.extraHeadersText" class="input mono" rows="2" placeholder='{ "X-Channel": "agenthub" }'></textarea>
          </div>
          <div class="set-row">
            <div class="set-info">
              <div class="set-name">附加请求体字段</div>
              <div class="set-desc">JSON 对象，选填，深合并进上游请求体。不允许覆盖 model / messages / stream</div>
            </div>
            <textarea v-model="form.extraBodyText" class="input mono" rows="2" placeholder='{ "reasoning": { "effort": "high" } }'></textarea>
          </div>
          <div class="set-row">
            <div class="set-info"><div class="set-name">启用</div><div class="set-desc">停用即从路由视图消失，带该前缀的请求会报「模型不在目录中」</div></div>
            <el-switch v-model="form.enabled" />
          </div>
          <div v-if="testResult" class="set-row">
            <div class="set-info">
              <div class="set-name">连通性</div>
              <div class="set-desc" :class="testResult.ok ? '' : 'err-text'">
                <template v-if="testResult.ok">
                  通过 · {{ testResult.ms }}ms · 收尾 {{ testResult.finishReason || "-" }}
                  · token {{ testResult.usage?.prompt_tokens ?? "?" }}/{{ testResult.usage?.completion_tokens ?? "?" }}
                  <template v-if="testResult.sample">· 首段「{{ testResult.sample }}」</template>
                </template>
                <template v-else>失败：{{ testResult.message }}<template v-if="testResult.status">（HTTP {{ testResult.status }}）</template></template>
              </div>
            </div>
          </div>
          <div class="p-actions">
            <button class="btn" :disabled="testing" @click="doTest">{{ testing ? "测试中…" : "测试连接" }}</button>
            <button class="btn" @click="formOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="busy" @click="doSave">{{ busy ? "保存中…" : "保存" }}</button>
          </div>
          <div class="set-desc" style="margin-top: 8px">测试会向上游发一次真实最小请求（max_tokens=16），产生计费；不会改动号池 Key 的冷却状态。</div>
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

      <!-- 删除确认 -->
      <div v-if="delOpen" class="p-mask" @click.self="delOpen = false">
        <div class="p-dlg glass">
          <div class="p-title">删除提供商</div>
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
.models-col {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1;
  min-width: 0;
}
.models-tools {
  display: flex;
  align-items: center;
  gap: 10px;
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
