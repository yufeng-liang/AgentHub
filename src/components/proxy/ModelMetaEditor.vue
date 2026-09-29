<!-- 反代网关 · 模型元数据编辑器（行内抽屉/弹窗）：统一编辑单个模型的
     能力 tri-state（未声明/开/关）+ 推理档位（允许档位多选 + 默认档）+ 输出上限。
     纯表单：只回填/构造 proxy.modelMeta[id] 的稀疏覆盖，由父组件落盘（persist）与清除；不新增 IPC。 -->
<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { ProxyModel } from "../../types";
import { fmtInt } from "../../views/proxy/format";

type Cap = "images" | "video" | "reasoning" | "tools";
/** 与 ProxyConfig.modelMeta[id] 一致的稀疏覆盖形状 */
type MetaOverride = {
  capabilities?: { images?: boolean; video?: boolean; reasoning?: boolean; tools?: boolean };
  maxOutputTokens?: number;
  reasoning?: { supportedEfforts?: string[]; defaultEffort?: string };
};

const props = defineProps<{ model: ProxyModel | null; override?: MetaOverride }>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "save", payload: MetaOverride): void;
  (e: "clear", group: "capabilities" | "maxOutputTokens" | "reasoning"): void;
}>();

/** 思考强度词表（与后端 EFFORT_RANK 对齐；none 收为 off 别名） */
const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CAP_DEFS: { key: Cap; label: string }[] = [
  { key: "images", label: "图片输入" },
  { key: "video", label: "视频输入" },
  { key: "reasoning", label: "思考链" },
  { key: "tools", label: "工具调用" },
];

// 草稿：tri-state 用 boolean | undefined（undefined = 未声明，键不落盘）
const capDraft = ref<Record<Cap, boolean | undefined>>({ images: undefined, video: undefined, reasoning: undefined, tools: undefined });
const efforts = ref<string[]>([]);
const defaultEffort = ref<string>("");
const maxOut = ref<number | null>(null);
// 打开或切换模型时，从当前稀疏覆盖回填草稿
watch(
  () => props.model?.id,
  () => {
    const ov = props.override || {};
    const c = ov.capabilities || {};
    capDraft.value = { images: c.images, video: c.video, reasoning: c.reasoning, tools: c.tools };
    efforts.value = [...(ov.reasoning?.supportedEfforts || [])];
    defaultEffort.value = ov.reasoning?.defaultEffort || "";
    maxOut.value = typeof ov.maxOutputTokens === "number" ? ov.maxOutputTokens : null;
  },
  { immediate: true },
);

/** 哪些组已被用户覆盖（来自后端 metaOverridden 出处标记） */
const overridden = computed(() => new Set(props.model?.metaOverridden || []));
// 生效（三源合并后）值：草稿为未声明时以此作回落提示
const effCap = computed<Record<string, boolean | undefined>>(() => (props.model?.capabilities || {}) as Record<string, boolean | undefined>);
const effReasoning = computed(() => props.model?.reasoning || {});
const effMaxOut = computed<number | undefined>(() => props.model?.maxOutputTokens);

function setCap(key: Cap, v: boolean | undefined) {
  capDraft.value = { ...capDraft.value, [key]: v };
}
function capHint(key: Cap): string {
  const e = effCap.value[key];
  return e === undefined ? "—" : e ? "开" : "关";
}
function toggleEffort(lv: string) {
  const s = new Set(efforts.value);
  if (s.has(lv)) s.delete(lv);
  else s.add(lv);
  // 保持词表顺序，避免造出上游不认的乱序集
  efforts.value = EFFORT_LEVELS.filter((x) => s.has(x));
  // 默认档若已不在允许集里则清空
  if (defaultEffort.value && !s.has(defaultEffort.value)) defaultEffort.value = "";
}

/** 收拢草稿 → 稀疏覆盖：未声明的键、空组一律不写；由父组件决定整键删除 */
function onSave() {
  const payload: MetaOverride = {};
  const cap: { images?: boolean; video?: boolean; reasoning?: boolean; tools?: boolean } = {};
  (Object.keys(capDraft.value) as Cap[]).forEach((k) => {
    const v = capDraft.value[k];
    if (v !== undefined) cap[k] = v;
  });
  if (Object.keys(cap).length) payload.capabilities = cap;
  const r: { supportedEfforts?: string[]; defaultEffort?: string } = {};
  if (efforts.value.length) r.supportedEfforts = [...efforts.value];
  if (defaultEffort.value) r.defaultEffort = defaultEffort.value;
  if (Object.keys(r).length) payload.reasoning = r;
  if (typeof maxOut.value === "number" && maxOut.value > 0) payload.maxOutputTokens = Math.round(maxOut.value);
  emit("save", payload);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="model" class="p-mask" @click.self="emit('close')">
      <div class="p-dlg glass meta-dlg" role="dialog" aria-modal="true" aria-label="模型元数据编辑">
        <div class="p-title">
          <span class="meta-heading">编辑模型元数据</span>
          <span class="mono meta-id">{{ model.id }}</span>
          <button class="btn btn-sm dlg-close" @click="emit('close')">关闭</button>
        </div>

        <div class="dlg-body">
          <!-- 能力 tri-state：未声明 = 键缺失，回落生效值 -->
          <div class="sec-title">
            能力
            <span v-if="overridden.has('capabilities')" class="tag tag-warn">已覆盖</span>
            <button v-if="overridden.has('capabilities')" class="btn btn-sm clr-btn" @click="emit('clear', 'capabilities')">清除覆盖</button>
          </div>
          <div class="cap-grid">
            <div v-for="cd in CAP_DEFS" :key="cd.key" class="cap-row">
              <span :id="`cap-lbl-${cd.key}`" class="cap-label">{{ cd.label }}</span>
              <div class="tri" role="radiogroup" :aria-labelledby="`cap-lbl-${cd.key}`">
                <button type="button" class="tri-opt" :class="{ active: capDraft[cd.key] === undefined }" role="radio" :aria-checked="capDraft[cd.key] === undefined" @click="setCap(cd.key, undefined)">未声明</button>
                <button type="button" class="tri-opt" :class="{ active: capDraft[cd.key] === true }" role="radio" :aria-checked="capDraft[cd.key] === true" @click="setCap(cd.key, true)">开</button>
                <button type="button" class="tri-opt" :class="{ active: capDraft[cd.key] === false }" role="radio" :aria-checked="capDraft[cd.key] === false" @click="setCap(cd.key, false)">关</button>
              </div>
              <span v-if="capDraft[cd.key] === undefined" class="cap-hint">沿用：{{ capHint(cd.key) }}</span>
            </div>
          </div>

          <!-- 推理档位：允许档位多选（取代式）+ 默认档 -->
          <div class="sec-title">
            推理档位
            <span v-if="overridden.has('reasoning')" class="tag tag-warn">已覆盖</span>
            <button v-if="overridden.has('reasoning')" class="btn btn-sm clr-btn" @click="emit('clear', 'reasoning')">清除覆盖</button>
          </div>
          <div class="field">
            <span id="efforts-lbl" class="fld-label">允许档位</span>
            <div class="chips" role="group" aria-labelledby="efforts-lbl">
              <button type="button" v-for="lv in EFFORT_LEVELS" :key="lv" class="chip" :class="{ on: efforts.includes(lv) }" :aria-pressed="efforts.includes(lv)" @click="toggleEffort(lv)">{{ lv }}</button>
            </div>
          </div>
          <div class="field">
            <label class="fld-label" for="meta-default-effort">默认档</label>
            <select id="meta-default-effort" v-model="defaultEffort" class="f-select" style="width: 160px">
              <option value="">（未设 · 回落）</option>
              <option v-for="lv in (efforts.length ? efforts : EFFORT_LEVELS)" :key="lv" :value="lv">{{ lv }}</option>
            </select>
            <span v-if="effReasoning.defaultEffort" class="cap-hint">沿用：{{ effReasoning.defaultEffort }}</span>
          </div>

          <!-- 输出上限 + 只读的生效上下文 -->
          <div class="sec-title">
            输出上限
            <span v-if="overridden.has('maxOutputTokens')" class="tag tag-warn">已覆盖</span>
            <button v-if="overridden.has('maxOutputTokens')" class="btn btn-sm clr-btn" @click="emit('clear', 'maxOutputTokens')">清除覆盖</button>
          </div>
          <div class="field">
            <label class="fld-label" for="meta-maxout">maxOutputTokens</label>
            <input id="meta-maxout" v-model.number="maxOut" class="input" type="number" min="0" step="1024" style="width: 160px" placeholder="未设 · 回落" />
            <span v-if="effMaxOut" class="cap-hint">沿用：{{ fmtInt(effMaxOut) }}</span>
          </div>

          <!-- 只读参考：上下文长度的可编辑入口在表格「上下文」列（proxy.modelCustom），
               这里只给生效值，所以单独成条、不混进上面任何一段表单里 -->
          <div class="ref-strip">
            <span class="ref-k">上下文长度（生效）</span>
            <b class="mono">{{ model.contextLength ? fmtInt(model.contextLength) : "—" }}</b>
          </div>
        </div>

        <div class="dlg-foot">
          <button class="btn" @click="emit('close')">取消</button>
          <button class="btn btn-cta" @click="onSave">保存覆盖</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* 弹窗自身不覆盖全局 .p-dlg 的 overflow:hidden —— global.css 那里写明：
   .glass::before 反光层 inset 是 -30%，一旦改成 auto 就会被算进滚动区、凭空多一条滚动条。
   滚动交给下面内层 .dlg-body，标题与底部按钮因此钉住不跟着滚。 */
.meta-dlg {
  width: min(560px, calc(100vw - 48px));
  max-height: min(80vh, 720px);
  display: flex;
  flex-direction: column;
}
/* 全局 .p-title 是块级（只有字号/字重/下边距），所以原先「关闭」上的
   margin-left:auto 根本不生效，按钮就贴在模型名后面看着像个 chip。这里补成 flex 行。 */
.p-title {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: none;
}
.meta-heading {
  flex: none;
}
.meta-id {
  font-size: 12px;
  color: var(--text-3);
  font-weight: 500;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dlg-close {
  margin-left: auto;
  flex: none;
}
.dlg-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.sec-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-3);
  margin: 14px 0 6px;
}
.clr-btn {
  margin-left: auto;
}
.cap-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cap-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cap-label {
  width: 68px;
  flex: none;
  font-size: 12px;
  color: var(--text-2);
}
.cap-hint {
  font-size: 11px;
  color: var(--text-3);
}
/* 三态选择器。原先这里借用 .seg / .seg-item 两个类名，但它们是
   ProxyModelsView.vue 的 <style scoped> 私有类（全局样式表里没有 .seg），
   套上 scoped 属性选择器后跨组件完全不匹配 —— 于是三颗按钮是无样式裸 button，
   「未声明/开/关」挤成一坨且选中态看不出区别。改成本组件自有的 .tri。 */
.tri {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  padding: 2px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
}
.tri-opt {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0 9px;
  border: 1px solid transparent;
  border-radius: calc(var(--r-sm) - 2px);
  background: transparent;
  color: var(--text-2);
  font-size: 11px;
  font-family: var(--font-ui);
  white-space: nowrap;
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.tri-opt:hover {
  color: var(--text);
}
.tri-opt.active {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
  font-weight: 600;
}
.tri-opt:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: 1px;
}
.field {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 6px 0;
  flex-wrap: wrap;
}
/* 68px 定宽装不下 "maxOutputTokens"（实测约 105px），标签会溢出压住输入框。
   改成下限宽度 + 不换行：同段的「允许档位 / 默认档」仍是 68px 保持左对齐，
   长标签自己撑开。 */
.fld-label {
  min-width: 68px;
  flex: none;
  font-size: 12px;
  color: var(--text-2);
  white-space: nowrap;
}
/* 只读参考条：描边 + 两端对齐，与上面的可编辑表单明显区分 */
.ref-strip {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
  font-size: 12px;
  color: var(--text-2);
}
.ref-k {
  color: var(--text-3);
}
.ref-strip b {
  margin-left: auto;
}
.chips {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  height: 24px;
  padding: 0 10px;
  border: 1px solid var(--line);
  border-radius: var(--r-sm);
  background: var(--bg-soft);
  color: var(--text-2);
  font-size: 11px;
  font-family: var(--font-ui);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.chip:hover {
  color: var(--text);
}
.chip.on {
  background: var(--accent-dim);
  border-color: var(--accent-line);
  color: var(--accent-strong);
  font-weight: 600;
}
.chip:focus-visible {
  outline: 2px solid var(--accent-line);
  outline-offset: 1px;
}
.dlg-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  flex: none;
  margin-top: 16px;
}
</style>
