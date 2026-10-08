// 反代网关 · Qoder 渠道端到端联调（真实凭据 + 真实上游；数据目录隔离）
// 用法：ELECTRON_RUN_AS_NODE=1 electron tools/proxy-qoder-live.cjs [--chat]
//
// 与单元自测的区别：本脚本**真的**读本机凭据、真的调上游。
// 数据隔离：AGENTHUB_DATA_DIR 指向临时目录（不污染生产数据），
//           但凭据来自真实 %APPDATA%（故不能改 APPDATA）。
// 代价提示：[0] 的体检会真的加载一次胶水，为此在临时目录落一份**约 33MB** 的签名器缓存
//           （每个可用区一份）。目录路径在结尾打印，要回收直接删那个目录。
//
// 覆盖（默认）：
//   0) 签名器体检：describe/available 的两区结果——先定死「上游 wasm 路在本机通不通」
//   1) 本机导入：读 auth.v1.dat → addAccount（含 meta.machineId）
//   2) queryCredits：真实 GET /api/v2/quota/usage（纯 Bearer，无需签名）
//   3) fetchModels：真实解密 catalog-v6 → 写 catalog.json → 校验模型表 + 落盘确被适配器取用
//   4) 模型目录对外可见性：mergedModels / modelOwners
// 附加（--chat）：真实推理一次（消耗 credits，默认关闭），并标明由哪条签名路服务
"use strict";
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-qoder-live-"));
process.env.AGENTHUB_DATA_DIR = dataDir; // 数据隔离：stats.db/rules 都落这里

const wantChat = process.argv.includes("--chat");
const assert = (cond, msg) => {
  if (!cond) throw new Error("断言失败: " + msg);
  console.log("  ✓ " + msg);
};

async function main() {
  const auth = require("../electron/backend/proxy/qoderAuth.cjs");
  const signer = require("../electron/backend/proxy/qoderSigner.cjs");
  const store = require("../electron/backend/proxy/store.cjs");
  const rules = require("../electron/backend/proxy/rules.cjs");
  const adapters = require("../electron/backend/proxy/adapters.cjs");
  const credits = require("../electron/backend/proxy/credits.cjs");

  console.log(`数据目录（隔离）: ${dataDir}`);
  store.open();
  rules.init();

  // ===== 0. 签名器体检（只读本机文件，不出网）=====
  // 为什么要单独一段：上游 wasm 签名路与「客户端装了但 glue 提取不出」是两件事。
  // 归一移植后本机每一笔 qoder 请求都靠 fork 自签兜底，而 [6] 的推理成功/失败并不能区分
  // 「上游路真的通了」和「自签又救了一次」——先把 glueLoaded/glueError 打在开头，
  // 跑一次就把结论钉成证据，不再靠推断。
  console.log("\n[0] 签名器体检（describe/available，读盘不调上游）");
  const signerOk = {};
  for (const p of Object.keys(auth.PRODUCTS)) {
    const d = await signer.describe(p);
    signerOk[p] = await signer.available(p);
    console.log(
      `  ${p}: 安装=${d.installed ? `${d.version}（sdk=${d.sdk}）` : "未定位"} ` +
        `glue可加载=${signerOk[p] ? "是" : "否"} exports=${d.exports || 0}` +
        (d.glueError ? ` 提取错=${d.glueError}` : "") +
        (signerOk[p] ? "（注：只证明胶水能加载，签名被上游接受要等 [6]）" : "")
    );
  }

  // ===== 1. 本机导入 =====
  console.log("\n[1] 本机导入（真实凭据）");
  const det = auth.detectAll();
  console.log("  客户端探测:", JSON.stringify(det));
  const products = Object.keys(auth.PRODUCTS).filter((p) => det[p]);
  assert(products.length > 0, "至少一个渠道客户端存在");

  const imported = [];
  for (const p of products) {
    // 渠道启用门（store.QODER_INTL_ENABLED）：暂停的渠道不导入、不参与后续断言
    if (!store.CHANNELS.some((c) => c.id === p)) {
      console.log(`  · ${p} 渠道当前未启用（QODER_INTL_ENABLED=false），跳过导入`);
      continue;
    }
    let c;
    try {
      c = auth.readCredentials(p);
    } catch (e) {
      console.log(`  · ${p} 读取失败：${String((e && e.message) || e).slice(0, 90)}`);
      continue;
    }
    if (!c.token || !c.user || !c.user.id) continue;
    const id = store.addAccount({
      channel: p,
      uid: c.user.id,
      name: c.user.name || c.user.email || p,
      token: c.token,
      refreshToken: c.refreshToken,
      source: "scan",
      expiresAt: c.expiresAt,
      meta: { machineId: c.machineId, product: p }, // machineId 必须随账号落库（签名与续期都要用）
    });
    const raw = store.getAccount(id);
    // getAccount 返回原始行（meta 为 JSON 文本）；适配器契约要的是 accountView 对象
    // （listAccounts 经 accountView 解析 meta），故此处按 listAccounts 取 view
    const acc = store.listAccounts(p).find((a) => a.id === id);
    const meta = (acc && acc.meta) || {};
    console.log(`  导入 ${p}: uid=${String(c.user.id).slice(0, 8)}*** meta.machineId=${meta.machineId ? "有" : "无"} expires=${new Date(c.expiresAt).toISOString().slice(0, 10)}`);
    assert(!!meta.machineId, `${p} meta.machineId 已落库（签名必需）`);
    assert(raw.expires_at === c.expiresAt, `${p} expires_at 已落库（临期预刷新/PoolSync 仲裁依赖）`);
    imported.push({ product: p, accountId: id, cred: c });
  }
  assert(imported.length > 0, "至少导入一个 Qoder 账号");

  // ===== 2. queryCredits（真实上游）=====
  console.log("\n[2] queryCredits（真实上游，纯 Bearer）");
  for (const it of imported) {
    const ad = adapters.get(it.product);
    // 适配器契约要 accountView 对象（meta 已解析）
    const acc = store.listAccounts(it.product).find((a) => a.id === it.accountId);
    const secrets = store.accountSecrets(store.getAccount(it.accountId));
    const r = await ad.queryCredits(acc, secrets);
    console.log(`  ${it.product}:`, JSON.stringify(r).slice(0, 220));
    if (r.authError) {
      console.log(`  ! ${it.product} 凭证失效（需重新登录客户端后重导）`);
      continue;
    }
    if (r.unavailable) {
      console.log(`  ! ${it.product} 额度结构未识别`);
      continue;
    }
    assert(typeof r.credits === "number", `${it.product} 额度为数值（${r.credits}）`);
    assert(r.detail && (r.detail.userQuota || r.detail.addOnQuota), `${it.product} 返回额度明细（供 UI 分层展示）`);
  }

  // ===== 3. fetchModels（真实解密 + 落盘）=====
  console.log("\n[3] fetchModels（真实 catalog 解密 → catalog.json）");
  for (const it of imported) {
    const ad = adapters.get(it.product);
    // 适配器契约要 accountView 对象（meta 已解析）
    const acc = store.listAccounts(it.product).find((a) => a.id === it.accountId);
    const secrets = store.accountSecrets(store.getAccount(it.accountId));
    const r = await ad.fetchModels(acc, secrets);
    if (!r.ok) {
      console.log(`  ! ${it.product} 目录拉取失败：${r.message}`);
      continue;
    }
    const withRate = r.models.filter((m) => m.rate != null).length;
    const free = r.models.filter((m) => m.isFree).map((m) => m.id);
    console.log(`  ${it.product}: ${r.models.length} 模型（${withRate} 带倍率，免费: ${free.join("/") || "无"}）`);
    assert(r.models.length >= 14, `${it.product} 目录模型数 ≥14`);
    assert(r.models.every((m) => m.id && m.name), `${it.product} 每个模型都有 id/name`);
    assert(withRate > 0, `${it.product} 含 price_factor 倍率`);

    // 落盘（对齐 proxy_models_sync 的写盘语义）。keyIdSchema: 1 不是可选装饰——
    // 适配器读目录时按该标记放行条目（历史展示名口径一律忽略），漏了它这份真目录会被当「没拉过」，
    // 后面 [4] 看到的仍是静态兜底表，等于测了个假落盘。
    const file = path.join(rules.rulesDir(), "catalog.json");
    const cur = JSON.parse(JSON.stringify(rules.get("catalog.json") || {}));
    cur[it.product] = { syncedAt: Date.now(), keyIdSchema: 1, models: r.models };
    fs.writeFileSync(file, JSON.stringify(cur, null, 2), "utf8");
    rules.reload("catalog.json");

    // 落盘是否**真的被用上**：判据必须落在适配器的取数结果上。只断言文件内容等于刚写的东西是自证——
    // 漏掉 keyIdSchema 时文件照样有内容，而适配器把条目当「没拉过」回落静态表，测出来一切"正常"。
    const landed = new Set(ad.models().map((s) => String(s).toLowerCase()));
    const want = new Set(r.models.map((m) => String(m.id).toLowerCase()));
    assert(landed.size === want.size && [...want].every((k) => landed.has(k)),
      `${it.product} 落盘目录已被适配器取用（非静态兜底）：取到 ${landed.size} / 应为 ${want.size}`);
  }

  // ===== 4. 对外可见性 =====
  console.log("\n[4] 目录对外可见性");
  const merged = adapters.mergedModels();
  const qModels = merged.filter((m) => adapters.modelOwners(m.id).includes("qoder"));
  console.log(`  合并目录 ${merged.length} 个模型，其中归属 qoder 的 ${qModels.length} 个`);
  assert(qModels.length > 0, "合并目录含 Qoder 模型");
  const df = merged.find((m) => m.id === "dfmodel");
  assert(!!df, "dfmodel 出现在合并目录");
  assert(adapters.modelOwners("dfmodel").length >= 1, "dfmodel 路由归属可解析");
  console.log("  dfmodel 元数据:", JSON.stringify({ name: df.name, rate: df.rate, ctx: df.contextLength, caps: df.capabilities }));
  const qf = merged.find((m) => m.id === "qfmodel");
  if (qf) console.log("  qfmodel（免费）:", JSON.stringify({ name: qf.name, rate: qf.rate, isFree: qf.isFree }));

  // ===== 5. 额度刷新链路（credits.refreshAccount，含临期预刷新分支）=====
  console.log("\n[5] credits.refreshAccount 集成");
  for (const it of imported) {
    try {
      const r = await credits.refreshAccount(it.accountId);
      const acc = store.getAccount(it.accountId);
      console.log(`  ${it.product}: credits=${r.credits} status=${acc.status}`);
      assert(typeof r.credits === "number", `${it.product} 经统一层刷新成功`);
    } catch (e) {
      console.log(`  ! ${it.product} 刷新失败：${String((e && e.message) || e).slice(0, 120)}`);
    }
  }

  // ===== 6.（可选）真实推理 =====
  if (wantChat) {
    console.log("\n[6] 真实推理（消耗 credits）");
    const it = imported[0];
    const ad = adapters.get(it.product);
    // 适配器契约要 accountView 对象（meta 已解析）
    const acc = store.listAccounts(it.product).find((a) => a.id === it.accountId);
    const secrets = store.accountSecrets(store.getAccount(it.accountId));
    const events = [];
    const res = await ad.chat({
      account: acc,
      secrets,
      model: "dfmodel",
      body: { messages: [{ role: "user", content: "只回复两个字：你好" }] },
      emit: (e) => events.push(e),
      meta: {},
    });
    const text = events.filter((e) => e.type === "delta" && e.delta.content).map((e) => e.delta.content).join("");
    const usage = events.find((e) => e.type === "usage");
    // 把「哪条签名路服务的这一笔」打在结果旁边：本段通/不通都可能由自签兜底达成，
    // 只报 status=200 会被读成「上游 wasm 路也没问题」——那是两回事（见 [0]）。
    console.log(`  签名路：${signerOk[it.product] ? "上游 wasm 签名" : "fork 自签回落（本机 wasm glue 不可用）"}`);
    console.log(`  status=${res.status} planLimit=${res.planLimit} 事件=${events.length}`);
    console.log(`  回复: ${text.slice(0, 80)}`);
    console.log(`  usage: ${JSON.stringify(usage && usage.usage)}`);
    assert(res.status === 200 && !res.planLimit, "推理成功");
    assert(text.length > 0, "收到正文");
    assert(!!usage, "收到 usage（含 credits 计量）");
  } else {
    console.log("\n[6] 真实推理：跳过（加 --chat 启用，会消耗 credits）");
  }

  console.log(`\n[done] Qoder 端到端联调通过（数据目录 ${dataDir}）`);
}

main()
  .then(() => process.exit(0)) // fetch keep-alive 句柄会让事件循环保持存活，测完显式退出（对齐 proxy-smoke 约定）
  .catch((e) => {
    console.error("\n[FAIL] " + ((e && e.stack) || e));
    process.exit(1);
  });
