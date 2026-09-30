<!-- 列设置按钮 + 下拉菜单：挂在父页的卡片标题行里（原先在表格上方独占一行，
     与标题行、筛选行三行错落很难看）。列的可见状态以 v-model 交给父页，
     父页再作为 visible prop 传给 RequestLogTable；持久化按 scope 存 localStorage，
     挂载时若有存档立即覆盖（存过的列全被删光时回默认，防手改 localStorage 弄出空表） -->
<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import type { ColDef } from "./logCols";
import { LOG_DEFAULT_COLS } from "./logCols";

const props = defineProps<{ cols: ColDef[]; scope: "home" | "stats" }>();
const visible = defineModel<string[]>({ required: true });

const open = ref(false);
function toggleCol(id: string) {
  const has = visible.value.includes(id);
  if (has && visible.value.length <= 1) return; // 至少留一列，全关的表没有可读性
  visible.value = has
    ? visible.value.filter((x) => x !== id)
    : props.cols.map((c) => c.id).filter((x) => x === id || visible.value.includes(x));
}
function resetCols() {
  visible.value = [...LOG_DEFAULT_COLS[props.scope]];
}

const LS_PREFIX = "agenthub.proxylog.";
function load(): string[] {
  try {
    const raw = localStorage.getItem(LS_PREFIX + props.scope + ".cols");
    const saved = raw ? (JSON.parse(raw) as string[]) : null;
    const ids = props.cols.map((c) => c.id);
    const hit = (saved || []).filter((id) => ids.includes(id));
    return hit.length ? hit : [...LOG_DEFAULT_COLS[props.scope]];
  } catch {
    return [...LOG_DEFAULT_COLS[props.scope]];
  }
}
// setup 同步落一次存档：首帧就按用户的列集渲染，不出「先全列后收窄」的闪动
visible.value = load();
watch(visible, (v) => {
  try { localStorage.setItem(LS_PREFIX + props.scope + ".cols", JSON.stringify(v)); } catch { /* 存不下就算了 */ }
}, { deep: true });

const onDocClick = () => { open.value = false; };
onMounted(() => document.addEventListener("click", onDocClick));
onUnmounted(() => document.removeEventListener("click", onDocClick));
</script>

<template>
  <span class="csm-wrap" @click.stop>
    <button class="btn btn-sm" :class="{ 'btn-primary': open }" @click="open = !open">
      <i class="ph ph-gear"></i> 列设置
    </button>
    <div v-if="open" class="csm-pop glass">
      <div class="csm-head">显示列 <button class="btn btn-sm" @click="resetCols">恢复默认</button></div>
      <label v-for="c in cols" :key="c.id" class="csm-item">
        <input type="checkbox" :checked="visible.includes(c.id)" @change="toggleCol(c.id)" />{{ c.label }}
      </label>
    </div>
  </span>
</template>

<style scoped>
.csm-wrap {
  position: relative;
  display: inline-flex;
}
.csm-pop {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 60;
  min-width: 128px;
  padding: 8px;
  border-radius: var(--r-md, 8px);
  border: 1px solid var(--line);
}
.csm-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  color: var(--text-3);
  margin-bottom: 4px;
}
.csm-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  padding: 3px 2px;
  cursor: pointer;
  white-space: nowrap;
}
</style>
