// 渠道显示名一致性闸：store 的 display、渲染层 CHANNEL_NAMES、浏览器预览态 mock 三处必须逐字相等。
//
// 起因：同一个显示名在四处各写一遍（store.cjs / format.ts / ProxyPoolSyncView / mock.ts），
// 已经漂过：ProxyPoolSyncView 把 zcode_intl 写成「ZCode（智谱·国际）」而权威表是「ZCode 智谱（国际）」；
// mock 把 workbuddy 写成「WorkBuddy（中国区）」而 store/format 都是「WorkBuddy CN」——
// dev:web 预览面看到的名字和真机不一样，按截图核验的人会照着假名字调文案。
//
// 不做「单一来源」的结构改造（要跨主进程/渲染层抽表，动的是上游也在改的文件），
// 就用这道闸把「改一处忘三处」变成响亮的红。
// 跑法：node scripts/dev-channel-names-test.cjs
"use strict";
if (require.main !== module) return;

const fs = require("node:fs");
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

let pass = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok  ${name}`); }
  else { failures.push(name + (detail ? `：${detail}` : "")); console.log(`FAIL  ${name}${detail ? `：${detail}` : ""}`); }
};

/** 取「某个常量块」里的 id→display 映射。
 *  必须限定块范围：format.ts 里 BALANCE_UNIT / SOURCE_NAMES / ACCOUNT_STATUS 都是同型的
 *  `键: "值",` 表，全文件正则会把无关键混进来，那时「CHANNEL_NAMES 无孤儿键」这类判据就恒真了。 */
function blockOf(src, startRe, endRe, label) {
  const s = startRe.exec(src);
  if (!s) throw new Error(`找不到${label}（起点样式变了？闸要先跟着改，别直接删判据）`);
  const rest = src.slice(s.index);
  const e = endRe.exec(rest);
  if (!e) throw new Error(`${label} 没找到结束位置`);
  return rest.slice(0, e.index + e[0].length);
}

const storeSrc = read("electron/backend/proxy/store.cjs");
const storeBlock = blockOf(storeSrc, /^const BUILTIN_CHANNELS = \[/m, /^\];/m, "store.BUILTIN_CHANNELS");
const store = {};
for (const m of storeBlock.matchAll(/\{\s*id:\s*"([a-z_0-9]+)",\s*display:\s*"([^"]+)"/g)) store[m[1]] = m[2];

const fmtSrc = read("src/views/proxy/format.ts");
const namesBlock = blockOf(fmtSrc, /^export const CHANNEL_NAMES/m, /^\};/m, "CHANNEL_NAMES");
const names = {};
for (const m of namesBlock.matchAll(/^\s*([a-z_0-9]+):\s*"([^"]+)",\s*$/gm)) names[m[1]] = m[2];

const mockSrc = read("src/api/mock.ts");
const mockBlock = blockOf(mockSrc, /^const PROXY_POOL = \[/m, /^\];/m, "mock.PROXY_POOL");
const mock = {};
for (const m of mockBlock.matchAll(/id:\s*"([a-z_0-9]+)",\s*display:\s*"([^"]+)"/g)) mock[m[1]] = m[2];

// ===== A. 三张表都真的被解析到了（判据不空转）=====
const storeIds = Object.keys(store);
check(`① store.BUILTIN_CHANNELS 解析到 ${storeIds.length} 个渠道（>=12）`, storeIds.length >= 12, storeIds.join("/"));
check(`② CHANNEL_NAMES 解析到 ${Object.keys(names).length} 条（>=12）`, Object.keys(names).length >= 12, Object.keys(names).join("/"));
check(`③ mock.PROXY_POOL 解析到 ${Object.keys(mock).length} 条（>=8）`, Object.keys(mock).length >= 8, Object.keys(mock).join("/"));

// ===== B. store 是权威：每个内置渠道都要在 CHANNEL_NAMES 里有同名同值 =====
for (const id of storeIds) {
  check(`④ ${id}：store「${store[id]}」== CHANNEL_NAMES「${names[id]}」`, names[id] === store[id], `CHANNEL_NAMES 缺键或不等：${JSON.stringify(names[id])}`);
}
// CHANNEL_NAMES 里凡是撞上内置渠道 id 的键都得等值（反方向：渲染层私自改名也要红）
for (const id of Object.keys(names)) {
  if (!(id in store)) continue;
  check(`⑤ ${id}：CHANNEL_NAMES「${names[id]}」== store「${store[id]}」`, store[id] === names[id]);
}
// ===== C. mock 只要求「它有的键必须与权威表等值」，不要求渠道齐全（预览态本来就没铺满）=====
for (const id of Object.keys(mock)) {
  if (!(id in store)) continue; // myrelay 这类自定义提供商不在权威表
  check(`⑥ mock ${id}：「${mock[id]}」== store「${store[id]}」`, mock[id] === store[id]);
}
// ===== D. 第四处镜像必须不存在：PoolSyncView 不许自带渠道字面量表 =====
const sync = read("src/views/proxy/ProxyPoolSyncView.vue");
const hardcoded = [...sync.matchAll(/\{\s*id:\s*"(?!")[a-z_0-9]+",\s*label:\s*"/g)].map((m) => m[0]);
check(`⑦ ProxyPoolSyncView 无硬编码渠道 label 行（实得 ${hardcoded.length}）`, hardcoded.length === 0, "这张表已漂过 zcode_intl，改引用 CHANNEL_NAMES");
check("⑧ ProxyPoolSyncView 确实引用了权威表", /import\s*\{[^}]*CHANNEL_NAMES[^}]*\}\s*from\s*"\.\/format"/.test(sync), "⑦⑧ 要同时成立：只删表不引用等于把渠道列表删空");

console.log(`\n${failures.length ? "FAIL " + failures.length + " 项" : "OK 渠道显示名一致性闸全过"}（共 ${pass + failures.length} 项）`);
if (failures.length) process.exit(1);
