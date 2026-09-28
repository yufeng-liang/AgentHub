// ModelMeta 统一层 + 思考强度贯通 自测（方案 2026-09-28）：纯函数直测，无外部依赖、不起网关、不碰真实配置。
// 覆盖：① effort_catalog seed 解析容错 ② 三源「取代不并集」合并 ③ capabilities 逐键合并（含 video）
//       ④ effort 越界降级 ⑤ budget→effort 阈值 ⑥ none→off 别名
// 用法：node scripts/dev-effort-catalog-test.cjs
"use strict";
const assert = require("node:assert");

const util = require("../electron/backend/proxy/util.cjs");
const adapters = require("../electron/backend/proxy/adapters.cjs");
const anthropicIn = require("../electron/backend/proxy/protocols/anthropic-in.cjs");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`  FAIL  ${name}: ${(e && e.message) || e}`);
  }
}

// ===== ① seed 解析容错 =====
check("seed: 合法对象原样返回", () => {
  const raw = { workbuddy: { "deepseek-v4-pro": { efforts: ["low", "high"] } } };
  assert.deepStrictEqual(adapters._coerceEffortCatalog(raw), raw);
});
check("seed: 坏 JSON 字符串 → 空表（不崩）", () => {
  assert.deepStrictEqual(adapters._coerceEffortCatalog("{not valid json"), {});
});
check("seed: 合法 JSON 字符串 → 解析", () => {
  assert.deepStrictEqual(adapters._coerceEffortCatalog('{"a":{"x":{"efforts":["low"]}}}'), { a: { x: { efforts: ["low"] } } });
});
check("seed: 非对象（数组/null/数字）→ 空表", () => {
  assert.deepStrictEqual(adapters._coerceEffortCatalog([1, 2]), {});
  assert.deepStrictEqual(adapters._coerceEffortCatalog(null), {});
  assert.deepStrictEqual(adapters._coerceEffortCatalog(42), {});
});

// ===== ② 三源合并：取代不并集 =====
check("merge: reasoning 取最高非空源（override 取代 pulled，绝不并集）", () => {
  const seed = { reasoning: { supportedEfforts: ["low", "medium"], defaultEffort: "low" } };
  const pulled = { reasoning: { supportedEfforts: ["high", "xhigh"] } };
  const override = { reasoning: { supportedEfforts: ["max"], defaultEffort: "max" } };
  const m = adapters._mergeModelMeta(seed, pulled, override);
  assert.deepStrictEqual(m.reasoning.supportedEfforts, ["max"], "应整体取代为 override 的集合");
  assert.strictEqual(m.reasoning.defaultEffort, "max");
});
check("merge: override 未给 reasoning 时回落 pulled（非空取代 seed）", () => {
  const seed = { reasoning: { supportedEfforts: ["low"], defaultEffort: "low" } };
  const pulled = { reasoning: { supportedEfforts: ["high", "xhigh"] } };
  const m = adapters._mergeModelMeta(seed, pulled, null);
  assert.deepStrictEqual(m.reasoning.supportedEfforts, ["high", "xhigh"]);
  // defaultEffort：pulled 未给 → 回落 seed 的 low
  assert.strictEqual(m.reasoning.defaultEffort, "low");
});
check("merge: 单档形态 reasoning.effort（无 supportedEfforts）视作 [effort] + 默认档", () => {
  // 实测 v3/config：fast-model / deepseek-v4.1-flash 等只给 {effort:'medium'|'high'}，无 supportedEfforts 数组
  const pulled = { reasoning: { effort: "medium" } };
  const m = adapters._mergeModelMeta(null, pulled, null);
  assert.deepStrictEqual(m.reasoning.supportedEfforts, ["medium"], "单档 effort 应收敛为唯一支持档");
  assert.strictEqual(m.reasoning.defaultEffort, "medium", "单档 effort 同时作默认档");
});
check("merge: 显式 supportedEfforts 优先于同层单档 effort", () => {
  const pulled = { reasoning: { effort: "low", supportedEfforts: ["low", "high", "max"], defaultEffort: "high" } };
  const m = adapters._mergeModelMeta(null, pulled, null);
  assert.deepStrictEqual(m.reasoning.supportedEfforts, ["low", "high", "max"]);
  assert.strictEqual(m.reasoning.defaultEffort, "high");
});
check("merge: 全空 reasoning → 不发档位字段（合并集空）", () => {
  const m = adapters._mergeModelMeta({ capabilities: {} }, { capabilities: {} }, null);
  assert.strictEqual(m.reasoning, undefined);
});
check("merge: maxOutputTokens/contextLength 取最高非空源", () => {
  const seed = { contextLength: 100, maxOutputTokens: 10 };
  const pulled = { contextLength: 200, maxOutputTokens: 0 };
  const override = { maxOutputTokens: 999 };
  const m = adapters._mergeModelMeta(seed, pulled, override);
  assert.strictEqual(m.contextLength, 200, "override 无值 → pulled 取代 seed");
  assert.strictEqual(m.maxOutputTokens, 999, "override 非空 → 取代");
});

// ===== ③ capabilities 逐键合并（含 video） =====
check("merge: capabilities 逐键 —— 显式 true/false 覆盖，undefined 不覆盖", () => {
  const seed = { capabilities: { images: true, reasoning: true, tools: true } };
  const pulled = { capabilities: { images: false } };       // 显式 false 覆盖
  const override = { capabilities: { video: true } };        // 新增 video
  const m = adapters._mergeModelMeta(seed, pulled, override);
  assert.strictEqual(m.capabilities.images, false, "pulled 显式 false 覆盖 seed 的 true");
  assert.strictEqual(m.capabilities.reasoning, true, "未被高层覆盖 → 保留 seed");
  assert.strictEqual(m.capabilities.tools, true);
  assert.strictEqual(m.capabilities.video, true, "override 新增 video 能力");
});
check("merge: 非布尔（undefined/null/字符串）不写入 capabilities", () => {
  const m = adapters._mergeModelMeta(
    { capabilities: { images: true } },
    { capabilities: { images: undefined, video: null, reasoning: "yes" } },
    null
  );
  assert.strictEqual(m.capabilities.images, true, "undefined 不覆盖已声明的 true");
  assert.ok(!("video" in m.capabilities), "null 不写入");
  assert.ok(!("reasoning" in m.capabilities), "字符串不写入");
});

// ===== ④ effort 越界降级（util.normalizeReasoningEffort，算法不改，仅喂合并后 supportedEfforts） =====
function downgrade(cur, supported) {
  const obj = { reasoning_effort: cur };
  util.normalizeReasoningEffort(obj, { supportedEfforts: supported });
  return obj.reasoning_effort;
}
check("downgrade: 越界高档 → 降到 ≤ 请求档的最高支持档", () => {
  assert.strictEqual(downgrade("max", ["low", "medium", "high"]), "high");
  assert.strictEqual(downgrade("xhigh", ["low", "medium"]), "medium");
});
check("downgrade: 支持档全高于请求 → 取最低档", () => {
  assert.strictEqual(downgrade("low", ["high", "xhigh", "max"]), "high");
});
check("downgrade: 请求档在支持集 → 原样保留", () => {
  assert.strictEqual(downgrade("medium", ["low", "medium", "high"]), "medium");
});
check("downgrade: 支持集为空 → 不动（无原料不收敛）", () => {
  assert.strictEqual(downgrade("high", []), "high");
});

// ===== ⑤ budget → effort 阈值（anthropic-in._budgetToEffort） =====
const b2e = anthropicIn._budgetToEffort;
check("budget: type=disabled → off", () => {
  assert.strictEqual(b2e({ type: "disabled", budget_tokens: 8000 }), "off");
});
check("budget: 0 → off", () => {
  assert.strictEqual(b2e({ type: "enabled", budget_tokens: 0 }), "off");
});
check("budget: 阈值边界 1/4096/4097/16384/16385/32768/32769", () => {
  assert.strictEqual(b2e({ budget_tokens: 1 }), "low");
  assert.strictEqual(b2e({ budget_tokens: 4096 }), "low");
  assert.strictEqual(b2e({ budget_tokens: 4097 }), "medium");
  assert.strictEqual(b2e({ budget_tokens: 16384 }), "medium");
  assert.strictEqual(b2e({ budget_tokens: 16385 }), "high");
  assert.strictEqual(b2e({ budget_tokens: 32768 }), "high");
  assert.strictEqual(b2e({ budget_tokens: 32769 }), "max");
  assert.strictEqual(b2e({ budget_tokens: 1000000 }), "max");
});
check("budget: 非法/负 → undefined（enabled 无档，不派生）", () => {
  assert.strictEqual(b2e({ budget_tokens: -5 }), undefined);
  assert.strictEqual(b2e({ budget_tokens: NaN }), undefined);
  assert.strictEqual(b2e({ type: "enabled" }), undefined);
  assert.strictEqual(b2e(null), undefined);
});
check("budget: toInternal 加法语义 —— 保留 thinking 透传 + 派生 reasoning_effort", () => {
  const r = anthropicIn.toInternal({ model: "deepseek-v4", max_tokens: 100, messages: [{ role: "user", content: "hi" }], thinking: { type: "enabled", budget_tokens: 8000 } });
  assert.ok(r.ok, "转换应成功");
  assert.strictEqual(r.body.reasoning_effort, "medium", "8000 → medium");
  assert.deepStrictEqual(r.body.extraBody.thinking, { type: "enabled", budget_tokens: 8000 }, "原始 thinking 必须原样透传");
});
check("budget: toInternal disabled → 不带 reasoning_effort（删档），thinking 仍透传", () => {
  const r = anthropicIn.toInternal({ model: "deepseek-v4", max_tokens: 100, messages: [{ role: "user", content: "hi" }], thinking: { type: "disabled" } });
  assert.ok(r.ok);
  assert.ok(!("reasoning_effort" in r.body), "disabled → 不发档位");
  assert.deepStrictEqual(r.body.extraBody.thinking, { type: "disabled" });
});

// ===== ⑥ none→off 别名 =====
check("alias: normalizeEffortName none/None/NONE → off", () => {
  assert.strictEqual(util.normalizeEffortName("none"), "off");
  assert.strictEqual(util.normalizeEffortName("None"), "off");
  assert.strictEqual(util.normalizeEffortName(" NONE "), "off");
  assert.strictEqual(util.normalizeEffortName("high"), "high");
});
check("alias: 请求 none → off 后按支持集判档", () => {
  // 请求 none（=off），支持集含 off → 保留 off
  assert.strictEqual(downgrade("none", ["off", "low", "high"]), "off");
});
check("alias: seedToMeta 把 efforts 里的 none 归一成 off", () => {
  const m = adapters._seedToMeta({ efforts: ["none", "low", "high"], default: "none" });
  assert.deepStrictEqual(m.reasoning.supportedEfforts, ["off", "low", "high"]);
  assert.strictEqual(m.reasoning.defaultEffort, "off");
});
check("alias: merge 里 supportedEfforts 的 none 也归一成 off", () => {
  const m = adapters._mergeModelMeta(null, { reasoning: { supportedEfforts: ["none", "medium"] } }, null);
  assert.deepStrictEqual(m.reasoning.supportedEfforts, ["off", "medium"]);
});

// ===== metaOverridden 标记 =====
check("metaOverridden: 标出 override 显式给的键", () => {
  assert.deepStrictEqual(adapters._metaOverriddenKeys({ capabilities: { images: true }, maxOutputTokens: 100 }).sort(), ["capabilities", "maxOutputTokens"]);
  assert.deepStrictEqual(adapters._metaOverriddenKeys({ reasoning: { defaultEffort: "high" } }), ["reasoning"]);
  assert.deepStrictEqual(adapters._metaOverriddenKeys(null), []);
  assert.deepStrictEqual(adapters._metaOverriddenKeys({}), []);
});

console.log(`\neffort-catalog 自测：${passed} 通过 / ${failed} 失败`);
process.exit(failed ? 1 : 0);
