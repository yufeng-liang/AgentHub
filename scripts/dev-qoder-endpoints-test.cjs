// Qoder 双区端点表闸：四条读端点的链路必须拿到同一个值。
//
// 起因（2026-10-08 复核）：国际版推理网关在三处写了两个值——rules.cjs 种子与 qoderAuth 是
// api2.qoder.sh，qoderSelfSign.REGIONS.global 是 api3.qoder.sh/；discovery 里还有第四份
// webOrigin/openApi 字面量表。CN 三处恰好同值，而 qoder_intl 至今没注册 ⇒ 分叉从没被跑到。
// 这道闸把「只有一个真相源」变成结构判据：任何一方私自再写一遍域名，当场红。
// 跑法：node scripts/dev-qoder-endpoints-test.cjs
"use strict";
if (require.main !== module) return;

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 与 dev-qoder-test 同口径：产品代码 require 之前先隔离数据目录，绝不碰真实 %APPDATA%\AgentHub
process.env.APPDATA = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-endpoints-test-"));

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const EP = require("../electron/backend/proxy/qoderEndpoints.cjs");
const SELF = require("../electron/backend/proxy/qoderSelfSign.cjs");
const AUTH = require("../electron/backend/proxy/qoderAuth.cjs");
const rules = require("../electron/backend/proxy/rules.cjs");

let pass = 0;
const failures = [];
const check = (n, ok, d) => {
  if (ok) { pass++; console.log(`  ok  ${n}`); }
  else { failures.push(n + (d ? `：${d}` : "")); console.log(`FAIL  ${n}${d ? `：${d}` : ""}`); }
};

// ===== A. 判据不空转：三张表都真被读到了 =====
check("⓪a EP.REGIONS 有 cn/global 两区", !!EP.REGIONS.cn && !!EP.REGIONS.global);
check("⓪b qoderAuth.PRODUCTS 有双渠道", !!AUTH.PRODUCTS.qoder && !!AUTH.PRODUCTS.qoder_intl);
check("⓪c 自签模块仍导出 REGIONS/PRODUCT_REGION", !!SELF.REGIONS && !!SELF.PRODUCT_REGION);

// ===== B. 两条签名路 + rules 种子 + discovery 表 全部等于真相源 =====
for (const product of ["qoder", "qoder_intl"]) {
  const want = EP.inferGateway(product);
  const region = EP.PRODUCT_REGION[product];
  check(`① ${product}：自签路 REGIONS[${region}].gateway == 真相源（${want}）`, SELF.REGIONS[region].gateway === want, `${SELF.REGIONS[region].gateway}`);
  check(`② ${product}：wasm 路兜底 qoderAuth.gateway == 真相源（${want}）`, AUTH.PRODUCTS[product].gateway === want, `${AUTH.PRODUCTS[product].gateway}`);

  // ③ rules.cjs 的 headers.json 种子是 wasm 路的**首选**值（qoderAdapter 里 cfg.gateway 排在
  //    auth 兜底之前），所以判据要落到「实际会落盘的那个值」上，而不是正则扫源码字面量——
  //    种子改成推导式之后，扫字面量只会得到「解析不到」，把判据变成空转红。
  const seed = rules.DEFAULTS["headers.json"][product];
  check(`③ ${product}：rules 种子含 gateway 字段`, !!seed && typeof seed.gateway === "string", JSON.stringify(seed && seed.gateway));
  check(`③b ${product}：rules 种子 gateway == 真相源（${want}）`, !!seed && seed.gateway === want, `${seed && seed.gateway}`);
  check(`③c ${product}：rules 种子 openApi == 真相源`, !!seed && seed.openApi === EP.REGIONS[region].openApi, `${seed && seed.openApi}`);
}

// ===== C. discovery 不再自带第四份表 =====
const disc = read("electron/backend/proxy/discovery.cjs");
const discLiterals = (disc.match(/https:\/\/(qoder\.com|openapi\.qoder)[^"']*/g) || []);
check(`④ discovery 里 qoder 域名字面量归零（实得 ${discLiterals.length}：${discLiterals.join(" ")}）`, discLiterals.length === 0, "登录链路的域名改读 EP.REGIONS");

// ===== D. 机器标识目录与 qoderAuth 同源（此前自签候选表只列 ~/.qoder ⇒ CN 号读到国际版客户端的 id） =====
for (const product of ["qoder", "qoder_intl"]) {
  const f = EP.machineIdFileOf(product);
  const home = AUTH.PRODUCTS[product].homeDir;
  check(`⑤ ${product}：machine_id 文件落在该产品主目录（${home}）`, f.includes(home.replace(/\\/g, "/")), f);
  check(`⑤b ${product}：两表的主目录口径一致`, EP.PRODUCT_HOME[product] === home, `${EP.PRODUCT_HOME[product]} vs ${home}`);
}

// ===== E. 域名字面量只许出现在真相源里 =====
const dupes = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
  const p = path.join(d, e.name);
  if (e.isDirectory()) return walk(p);
  if (!/\.cjs$/.test(e.name)) return;
  const hits = (fs.readFileSync(p, "utf8").match(/https:\/\/api[23][^"'\s]*/g) || []);
  if (hits.length && !/qoderEndpoints\.cjs$/.test(p)) dupes.push(`${path.relative(ROOT, p)}(${hits[0]})`);
});
walk(path.join(ROOT, "electron", "backend"));
check(`⑥ electron/backend 里 api2/api3 字面量只在真相源出现（实得 ${dupes.join(", ") || "无"}）`, dupes.length === 0, "第二处域名就是下一个漂移点");

// ===== F. 区服只有一个来源：渠道 id =====
// 上游 ProxyAgentsView 历史上没有区服 radio（fork 加的），下次合并可能把它带回来；
// 而主进程一旦又读 edition，就会出现「渠道说 CN、参数说 intl」的分裂账号（meta.mode=global
// 打在 CN 网关上，答非所问且无从察觉）。两头都钉住。
ok7();
function ok7() {
  const disc = read("electron/backend/proxy/discovery.cjs");
  // 必须按**三参签名**锁定：本文件里有两个 beginQoderOAuth 声明，
  // 前面那个 (channel, onDone) 的被后面同名声明整体遮蔽（函数声明提升 + 后者覆盖），是死码。
  // 按名字匹配会命中死的那份 ⇒ 判据看着绿、实际什么也没测到（本闸第一次跑就是这么撞出来的）。
  const qFn = /async function beginQoderOAuth\(channel, edition, onDone\) \{[\s\S]{0,900}/.exec(disc);
  check("⑦ 主进程区服读渠道 id（活的 beginQoderOAuth 内不读 edition）",
    !!qFn && /EP\.regionOf\(channel\)/.test(qFn[0]) && !/qoderRegionOfMode\(edition\)/.test(qFn[0]),
    qFn ? "没看到 EP.regionOf(channel)" : "按三参签名找不到 beginQoderOAuth（签名变了？判据要跟着改，别改成宽松匹配）");
  const decls = (disc.match(/async function beginQoderOAuth/g) || []).length;
  check(`⑦c beginQoderOAuth 声明数已知（当前 2 个，第二个才活着）`, decls === 2, `实得 ${decls} 个：若变成 1 说明死码被清理，本条与上一条的锚点都要复核`);
  const agents = read("src/views/proxy/ProxyAgentsView.vue");
  check("⑦b 渲染层没有 qoder 区服 radio（qoderEdition 已删）", !/qoderEdition/.test(agents), "radio 回来了就会与「区服跟随渠道」冲突");
}

console.log(`\n${failures.length ? "FAIL " + failures.length + " 项" : "OK Qoder 端点表闸全过"}（共 ${pass + failures.length} 项）`);
if (failures.length) process.exit(1);
