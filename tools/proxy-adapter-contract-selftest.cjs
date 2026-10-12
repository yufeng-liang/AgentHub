// 反代网关 · 适配器契约符合性自测：双表一致（CHANNELS↔ADAPTERS）+ 必需/推荐方法符合 + 守卫可拦截
// 用法：node tools/proxy-adapter-contract-selftest.cjs（纯逻辑，不触碰 SQLite；
// 也可按 proxy-smoke 同款在 ELECTRON_RUN_AS_NODE=1 electron 下跑）
//
// 上游这份自测按它自己 9 家渠道立的口径，本分支曾为 Cline/AutoClaw 的内联实现改过三条判据；
// 2026-10-12 两份上游目录实现（cline/ 与 autoclaw/）接线完成后**全部回到上游口径**，留这段是为
// 了下一次合并时别再改回去：
//   ① 必需集与上游同为 cfg/models/chat/queryCredits——15 家内置渠道现在都有。自定义提供商不受
//      影响：它不进 ADAPTERS、也不过 assertAdapterContract，那侧的门槛是 credits.cjs 的 creditsCapable()。
//   ② 模型目录硬要求 fetchModels() 全员存在、签到两法（checkin/checkinStatus）全员成对。
//      fork 原来的「fetchModels 或非空 models() 二选一」与 NO_CHECKIN 豁免表都已清空——
//      豁免表一旦留着，新增渠道漏接签到就有了可以塞进去的现成格子。
//   ③ 最小适配器用例跟着必需集走：四个必需方法齐了才通过；只有 models/chat 必须被拦。
"use strict";

async function main() {
  const assert = (cond, msg) => {
    if (!cond) throw new Error("断言失败: " + msg);
  };
  const store = require("../electron/backend/proxy/store.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");

  // 1. 契约方法清单固定（漏改契约注释块即失败）
  assert(
    JSON.stringify(adapters.REQUIRED_ADAPTER_METHODS) === JSON.stringify(["cfg", "models", "chat", "queryCredits"]),
    "REQUIRED_ADAPTER_METHODS = 上游四件套（fork 收窄过的理由随 Cline/AutoClaw 接线一起失效，见文件头 ①）"
  );

  // 2. 双表一致性：两向差集必须为空（只加一张表 = 模型被路由到无账号渠道/渠道不出现在 UI）
  const report = adapters.consistencyReport();
  assert(!report.channelsWithoutAdapter.length, `CHANNELS 全有适配器（缺：${report.channelsWithoutAdapter.join("/")}）`);
  assert(!report.adaptersWithoutChannel.length, `ADAPTERS 全有渠道行（缺：${report.adaptersWithoutChannel.join("/")}）`);
  assert(Object.keys(adapters.ADAPTERS).length === store.CHANNELS.length, `ADAPTERS 数 = CHANNELS 数 = ${store.CHANNELS.length}`);

  // 3a. 必需方法 + 目录来源 + refreshToken 全员符合（上游口径：fetchModels() 必须存在）
  //     fork 曾允许「fetchModels 或非空 models() 二选一」，那是 AutoClaw 内联目录时代的产物；
  //     接上游 autoclaw/ 目录后它有官方目录接口，这条放宽失去依据——留着就等于给未来的漏接留门。
  for (const c of store.CHANNELS) {
    const ad = adapters.get(c.id);
    assert(ad, `渠道 ${c.id} 适配器已注册`);
    adapters.assertAdapterContract(c.id, ad);
    assert(typeof ad.fetchModels === "function", `渠道 ${c.id} 缺 fetchModels()（模型目录必须能从上游拉）`);
    assert(ad.models().length > 0, `渠道 ${c.id} 的 models() 非空`);
    assert(typeof ad.refreshToken === "function", `渠道 ${c.id} 推荐方法 refreshToken() 存在`);
  }

  // 3b. 签到两法必须成对且全员齐备（号池页按这一对摆「行内签到」；只接一半就是工具栏承诺了行内拒绝的那件事）
  // 签到两法全员成对（上游口径）。fork 的 NO_CHECKIN 豁免表已清空：Cline 双池随 cline/ 目录、
  // AutoClaw 两地区随 autoclaw/ 目录接线后都有官方签到接口了。豁免表留着比缺判据更危险——
  // 它给「新渠道先不加签到」准备了现成的格子。
  for (const c of store.CHANNELS) {
    const ad = adapters.get(c.id);
    const has = ["checkin", "checkinStatus"].map((m) => typeof ad[m] === "function");
    assert(has[0] === has[1], `渠道 ${c.id} 的 checkin/checkinStatus 必须成对（实际 ${has.join("/")}）`);
    assert(has[0], `渠道 ${c.id} 缺签到实现（新渠道要接 checkin + checkinStatus）`);
  }

  // 4. 守卫可拦截：缺 chat 的残缺适配器必须抛错且点名缺失方法
  let threw = "";
  try {
    adapters.assertAdapterContract("残缺渠道", { cfg() {}, models() { return []; } });
  } catch (e) {
    threw = String((e && e.message) || e);
  }
  assert(/缺少必需的适配器方法 chat/.test(threw), "缺 chat 的残缺适配器被断言拦截（实际：" + (threw || "未抛错") + "）");

  // 5. 四个必需方法齐备的最小适配器通过契约（refreshToken/checkin 等由调用点守卫，不在契约层封死）
  let minimal = true;
  try {
    adapters.assertAdapterContract("最小渠道", { cfg() {}, models() { return []; }, chat() {}, queryCredits() {} });
  } catch {
    minimal = false;
  }
  assert(minimal, "实现 cfg/models/chat/queryCredits 的最小适配器通过契约");

  // 5b. 只有 models/chat（缺 cfg/queryCredits）必须被拦。fork 收窄必需集的那段日子里这条是绿的，
  //     接线完成后它就是「必需集真的升回去了」的证据。
  let loose = false;
  try {
    adapters.assertAdapterContract("只有 models/chat 的渠道", { models() { return []; }, chat() {} });
    loose = true;
  } catch { /* 期望抛错 */ }
  assert(!loose, "缺 cfg()/queryCredits() 的适配器被契约守卫拦截");

  console.log(`适配器契约自测全过（${store.CHANNELS.length} 渠道 × 上游四件套必需集 + 签到全员成对 + 双表一致 + 守卫拦截）`);
}

main().catch((e) => {
  console.error((e && e.message) || e);
  process.exit(1);
});
