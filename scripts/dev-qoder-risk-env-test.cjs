// Qoder 风控身份（UMID 组件）的环境编号闸。
//
// 起因（2026-10-10）：qoderAuth.readRiskIdentity 原来是 `runtime-info.exe --account-stdin`，
// **没带环境编号**。本机对两个已安装客户端的 umid 组件实测：
//   · 不传 env 与传 0 输出逐字相同；
//   · 0 / 3 / 4 之间 machineToken/machineCode/machineType 三件套完全不同；
//   · 换 uid、甚至传空串，输出不变 ⇒ 这一版组件的 uid 不参与身份
//     （参考仓「身份按 uid 生成 ⇒ 要先拉一次拿 uid 再叠头」那半条在本机证否，故未实现两段拉取）。
// 国际版要 env=3；省略它等于拿中国版环境的风控身份去领国际版活动（上游因此只回 VIEW_DETAILS 促销）。
//
// 判据形态：child_process 是内建模块、进不了 require.cache（试过，桩不住且会**真的 spawn 第三方组件**），
// 所以从产品侧开口——riskArgv(product) 是纯函数，直接断言 argv；组件路径回落走 candidates。
// 跑法：node scripts/dev-qoder-risk-env-test.cjs
"use strict";
if (require.main !== module) return;

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 数据目录隔离（与同目录其它闸同口径）：绝不碰真实 %APPDATA%\AgentHub
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-risk-env-"));
process.env.APPDATA = TMP;

let pass = 0;
const failures = [];
const check = (n, ok, d) => {
  if (ok) { pass++; console.log(`  ok  ${n}`); }
  else { failures.push(n + (d ? `：${d}` : "")); console.log(`FAIL  ${n}${d ? `：${d}` : ""}`); }
};

// ===== ⓪ 真·安装目录名（桩表之前先读真身：这两个值是磁盘事实，误改会让两区认错同一个客户端目录）
// 判据是 /\bCN\b/ 而不是全等——所以「Qoder 国内版」这种看着更中文化的改名同样致命且静默：
// wantCn 会变 false，CN 渠道直接命中国际版的 resources（那里的 runtime-info.exe 真实存在）。
// 若客户端厂商改了目录名导致这里红：用 node -e 跑 findResources 两区各一次，确认路径互不相同后重录。
const realInstall = require("../electron/backend/proxy/qoderInstall.cjs");
const realLabels = realInstall.EXE_LABELS;
check(`⓪a EXE_LABELS.qoder == "Qoder CN"（实得 ${JSON.stringify(realLabels.qoder)}）`, realLabels.qoder === "Qoder CN");
check(`⓪b EXE_LABELS.qoder_intl == "Qoder"（实得 ${JSON.stringify(realLabels.qoder_intl)}）`, realLabels.qoder_intl === "Qoder");
check("⓪c 区服判据把两区分开（CN 命中 / intl 不命中）", /\bCN\b/i.test(realLabels.qoder) === true && /\bCN\b/i.test(realLabels.qoder_intl) === false, "相等即两区会解析到同一个安装目录");

// 假组件路径表（真实探测在 qoderInstall.cjs，这里只桩它的返回值）
const PROBE_DIR = path.join(TMP, "umid");
fs.mkdirSync(PROBE_DIR, { recursive: true });
const CN_EXE = path.join(PROBE_DIR, "runtime-info-cn.exe");
const INTL_EXE = path.join(PROBE_DIR, "runtime-info-intl.exe");
fs.writeFileSync(CN_EXE, "");
fs.writeFileSync(INTL_EXE, "");

const installPath = require.resolve("../electron/backend/proxy/qoderInstall.cjs");
let available = { qoder: CN_EXE, qoder_intl: INTL_EXE };
require.cache[installPath] = {
  id: installPath, filename: installPath, loaded: true,
  exports: {
    EXE_LABELS: { qoder: "Qoder CN", qoder_intl: "Qoder" },
    runtimeInfoPath: (product) => available[product] || "",
  },
};

const auth = require("../electron/backend/proxy/qoderAuth.cjs");

// ===== A. argv 带对的环境编号 =====
const cnArgv = auth.riskArgv("qoder");
const intlArgv = auth.riskArgv("qoder_intl");
check(`① cn argv = ["0","--account-stdin"]（实得 ${JSON.stringify(cnArgv)}）`, JSON.stringify(cnArgv) === JSON.stringify(["0", "--account-stdin"]));
check(`② intl argv = ["3","--account-stdin"]（实得 ${JSON.stringify(intlArgv)}）`, JSON.stringify(intlArgv) === JSON.stringify(["3", "--account-stdin"]));
check("③ 两区编号不同（同值就等于其中一边必错）", cnArgv[0] !== intlArgv[0], `${cnArgv[0]} vs ${intlArgv[0]}`);
check("④ --account-stdin 形态保持（uid 仍走 stdin）", cnArgv.includes("--account-stdin") && intlArgv.includes("--account-stdin"));
check("⑤ 编号在第一位（客户端就是这个顺序）", /^\d+$/.test(cnArgv[0]) && /^\d+$/.test(intlArgv[0]));
// 未知渠道不能静默落到某个区：兜底值必须是显式选择而不是 undefined 字符串
check("⑥ 未知 product 兜底为一个数字而不是 undefined", /^\d+$/.test(auth.riskArgv("no-such-channel")[0]), JSON.stringify(auth.riskArgv("no-such-channel")));

// ===== B. 组件候选：自己的在前，缺失时回落另一区，全缺回空 =====
available = { qoder: CN_EXE, qoder_intl: INTL_EXE };
check("⑦ 两区都装着 → intl 有 2 个候选且自己排第一",
  JSON.stringify(auth.riskIdentityCandidates("qoder_intl")) === JSON.stringify([INTL_EXE, CN_EXE]),
  JSON.stringify(auth.riskIdentityCandidates("qoder_intl")));
available = { qoder: CN_EXE, qoder_intl: "" };
check("⑧ 国际版客户端没装 → 仍能拿到 CN 组件作候选",
  JSON.stringify(auth.riskIdentityCandidates("qoder_intl")) === JSON.stringify([CN_EXE]),
  JSON.stringify(auth.riskIdentityCandidates("qoder_intl")));
available = { qoder: "", qoder_intl: path.join(PROBE_DIR, "不存在的组件.exe") };
check("⑨ 候选按存在性过滤（不返回不存在的路径，也不返回空串）",
  auth.riskIdentityCandidates("qoder_intl").length === 0 && auth.riskIdentityCandidates("qoder").length === 0);
check("⑩ 未知 product 不抛（返回空候选）", auth.riskIdentityCandidates("no-such-channel").length === 0);

console.log(`\n${failures.length ? "FAIL " + failures.length + " 项" : "OK Qoder 风控身份环境编号闸全过"}（共 ${pass + failures.length} 项）`);
if (failures.length) process.exit(1);
