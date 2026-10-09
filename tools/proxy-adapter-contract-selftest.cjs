// 反代网关 · 适配器契约符合性自测：双表一致（CHANNELS↔ADAPTERS）+ 必需/推荐方法符合 + 守卫可拦截
// 用法：node tools/proxy-adapter-contract-selftest.cjs（纯逻辑，不触碰 SQLite；
// 也可按 proxy-smoke 同款在 ELECTRON_RUN_AS_NODE=1 electron 下跑）
//
// 上游这份自测按它自己 9 家渠道立的口径，本分支改了三条判据（都属「探针口径 ≠ 产品坏了」）：
//   ① 必需集只钉 models/chat。cfg/queryCredits 在本分支不是必需：Cline 免费/订阅池与 AutoClaw
//      两地区没有对外余额接口，自定义提供商也刻意不定义 queryCredits（credits.cjs 的
//      creditsCapable() 先判能力再刷，那里写着理由）。把它们列进必需集 = 网关子进程在 require
//      阶段就抛「渠道 cline_free 缺少必需的适配器方法 queryCredits()」，整个网关起不来。
//   ② 「推荐方法全员存在」改成两条更严且成立得更彻底的：模型目录必须有来源（fetchModels 或
//      非空 models()，上游硬要求 fetchModels 全员存在，而本分支 AutoClaw 两地区的目录是内置常量）、
//      refreshToken 14 家全有；checkin 与 checkinStatus 必须**成对**，且缺这一对的渠道只能是下面
//      NO_CHECKIN 点名的四家。新增渠道漏接签到照样红，而 Cline/AutoClaw 的豁免是可审计的显式名单。
//   ③ 最小适配器用例跟着必需集走：只实现 models/chat 必须通过；只有 cfg/queryCredits 必须被拦，
//      免得「收窄必需集」被读成「契约没门槛」。
"use strict";

async function main() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error("断言失败: " + msg);
  };
  const store = require("../electron/backend/proxy/store.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");

  // 1. 契约方法清单固定（漏改契约注释块即失败）
  assert(
    JSON.stringify(adapters.REQUIRED_ADAPTER_METHODS) === JSON.stringify(["models", "chat"]),
    "REQUIRED_ADAPTER_METHODS = models/chat（cfg/queryCredits 不必需的理由见文件头 ①）"
  );

  // 2. 双表一致性：两向差集必须为空（只加一张表 = 模型被路由到无账号渠道/渠道不出现在 UI）
  const report = adapters.consistencyReport();
  assert(!report.channelsWithoutAdapter.length, `CHANNELS 全有适配器（缺：${report.channelsWithoutAdapter.join("/")}）`);
  assert(!report.adaptersWithoutChannel.length, `ADAPTERS 全有渠道行（缺：${report.adaptersWithoutChannel.join("/")}）`);
  assert(Object.keys(adapters.ADAPTERS).length === store.CHANNELS.length, `ADAPTERS 数 = CHANNELS 数 = ${store.CHANNELS.length}`);

  // 3a. 必需方法 + 「目录有来源」+ refreshToken 全员符合
  //     上游原判据在这里还硬要求 fetchModels() 全员存在；本分支的 AutoClaw 两地区做不到——
  //     它的模型目录是内置常量（AUTOCLAW_MODELS），官方没有对外目录接口。改成成立的口径：
  //     要么能拉云端目录（fetchModels），要么静态 models() 非空，二者必居其一。
  for (const c of store.CHANNELS) {
    const ad = adapters.get(c.id);
    assert(ad, `渠道 ${c.id} 适配器已注册`);
    adapters.assertAdapterContract(c.id, ad);
    let staticCount = 0;
    try { staticCount = ad.models().length; } catch { /* 算 0，由下面这条断言点名 */ }
    assert(typeof ad.fetchModels === "function" || staticCount > 0,
      `渠道 ${c.id} 的模型目录必须有来源（fetchModels() 或 models() 非空，现在两者皆空）`);
    assert(typeof ad.refreshToken === "function", `渠道 ${c.id} 推荐方法 refreshToken() 存在`);
  }

  // 3b. 签到两法必须成对（号池页按这一对摆「行内签到」；只接一半就是工具栏承诺了行内拒绝的那件事）
  const NO_CHECKIN = ["cline_free", "cline_pass", "autoclaw", "autoclaw_intl"]; // 官方无签到接口
  for (const c of store.CHANNELS) {
    const ad = adapters.get(c.id);
    const has = ["checkin", "checkinStatus"].map((m) => typeof ad[m] === "function");
    assert(has[0] === has[1], `渠道 ${c.id} 的 checkin/checkinStatus 必须成对（实际 ${has.join("/")}）`);
    if (NO_CHECKIN.includes(c.id)) assert(!has[0], `渠道 ${c.id} 在 NO_CHECKIN 豁免表里就不该有签到（接上了就从表里删掉它）`);
    else assert(has[0], `渠道 ${c.id} 缺签到实现（新渠道要接 checkin + checkinStatus，或进 NO_CHECKIN 并写明理由）`);
  }

  // 4. 守卫可拦截：缺 chat 的残缺适配器必须抛错且点名缺失方法
  let threw = "";
  try {
    adapters.assertAdapterContract("残缺渠道", { cfg() {}, models() { return []; } });
  } catch (e) {
    threw = String((e && e.message) || e);
  }
  assert(/缺少必需的适配器方法 chat/.test(threw), "缺 chat 的残缺适配器被断言拦截（实际：" + (threw || "未抛错") + "）");

  // 5. 只实现必需方法的最小适配器通过契约（推荐/可选方法由调用点守卫，不在契约层封死）
  let minimal = true;
  try {
    adapters.assertAdapterContract("最小渠道", { models() { return []; }, chat() {} });
  } catch {
    minimal = false;
  }
  assert(minimal, "只实现 models/chat 的最小适配器通过契约");

  // 5b. 只有 cfg/queryCredits（无 models/chat）必须被拦：必需集收窄不等于放宽到没门槛
  let loose = false;
  try {
    adapters.assertAdapterContract("只有可选方法的渠道", { cfg() {}, queryCredits() {} });
    loose = true;
  } catch { /* 期望抛错 */ }
  assert(!loose, "只实现 cfg/queryCredits 而无 models/chat 的适配器被拦截");

  console.log(`适配器契约自测全过（${store.CHANNELS.length} 渠道 × 必需/推荐 + 签到成对与豁免表 + 双表一致 + 守卫拦截）`);
}

main().catch((e) => {
  console.error((e && e.message) || e);
  process.exit(1);
});
