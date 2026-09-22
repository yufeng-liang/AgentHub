// 二期 Task 1 闸：子进程自带的 v10 凭据解密（DPAPI + AES-256-GCM）+ 打包态拒写明文闸门。
//
// 测的两件事各有目的：
//  ① v10 分支真能解 Chromium os_crypt 形态的密文，且**跨进程**可解（同一台机器、不同进程 = 二期子进程
//     读主进程写的密文那个场景）；
//  ② 打包态拿不到任何加密能力时 encrypt() 必须抛错——静默写明文是本任务要堵的洞（§5.3 / 计划偏差 D3）。
//
// 三条手法约束：
//  · 打包判据 __dirname.includes("app.asar") 是生产判据本身，不给产品代码开「注入 flag」的测试后门，
//    所以测试自己把 electron/backend 整树拷进 <tmp>/.../app.asar/electron/ 再 require 那份拷贝
//    （Task 0 的 dev-gateway-node-load-test 已验证「拷出仓库再 require」这套打法可行且必要——
//     仓库内 require("electron") 会命中 devDependency 那个返回字符串的 index.js，判定力为零）。
//  · 只测合成凭据：Local State 里那条 encrypted_key 由本脚本自己用 koffi 调 CryptProtectData 包一个
//    自造的 32 B 假主密钥生成（与生产同一入口，测的就是这条链）。**绝不读真实 %APPDATA%\AgentHub**，
//    绝不打印密钥 / 明文 / 完整密文（一律只打 sha256 头 8 位）。
//  · koffi 或 DPAPI 本机不可用时 SKIP + exit 2 + 打印原因，不许静默通过（防止这条闸在某台机器上变成空闸）。
"use strict";
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const M = require("node:module");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agenthub-sbox-"));
const fwd = (p) => p.split(path.win32.sep).join("/");
const sha8 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 8);

// 隔离：所有落盘（config.json / stats.db / Local State / 中央仓库）都在临时目录里。
// 纯 Node 下 config.dataDir() 与 secretbox 的 Local State 都解析成 %APPDATA%\AgentHub，同一目录。
process.env.APPDATA = work;
process.env.AGENT_SKILLS_HOME = path.join(work, "hub");

let steps = 0;
const pass = (msg) => { steps++; console.log(`  ${String(steps).padStart(2)}. ${msg}`); };

/** 把 electron/backend 整树拷进指定位置；asar=true 时套上 app.asar 目录层，让生产判据为真 */
function copyInto(parent, asar) {
  const dst = asar ? path.join(parent, "app.asar", "electron") : path.join(parent, "electron");
  fs.cpSync(path.join(ROOT, "electron", "backend"), path.join(dst, "backend"), { recursive: true });
  // package.json 保持「proxy 目录上溯 3 级到根」的真实相对深度，util.appVersion() 才读到真版本号
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dst, "..", "package.json"));
  return path.join(dst, "backend");
}
const pkgTree = copyInto(path.join(work, "pkgmode"), true);   // 打包态（require 路径含 app.asar）
const devTree = copyInto(path.join(work, "devmode"), false);  // 开发态（路径不含 app.asar）

// 假 asar 拷贝树里没有 node_modules（生产里 koffi 在 app.asar/node_modules 内，已由打包版探针实测可加载，
// 那条证据归 Task 3）。测试侧用 Module._load 钩子把仓库那份真 koffi 递进去——只补环境，不动任何判据。
const KOFFI_PATH = fwd(path.join(ROOT, "node_modules", "koffi"));
const origLoad = M._load;
M._load = function (request, ...rest) {
  if (request === "koffi") return origLoad.call(this, KOFFI_PATH, ...rest);
  return origLoad.call(this, request, ...rest);
};

/** 合成主密钥 → CryptProtectData（与生产同一个 DPAPI 入口）→ 写成 Local State 的 os_crypt.encrypted_key */
let testFfi; // 结构体名在同一个 koffi 实例里是全局的，重复声明会撞名，故只初始化一次
function initTestFfi() {
  if (testFfi) return testFfi;
  const koffi = require("koffi");
  const crypt32 = koffi.load("crypt32.dll");
  koffi.struct("AgentHubTest_DATA_BLOB", { cbData: "uint32_t", pbData: "void*" });
  testFfi = {
    koffi,
    protect: crypt32.func(
      "bool __stdcall CryptProtectData(_Inout_ AgentHubTest_DATA_BLOB *pDataIn, void *pDescStr, void *pEntropy, void *pReserved, void *pPrompt, uint32_t dwFlags, _Out_ AgentHubTest_DATA_BLOB *pDataOut)"
    ),
    localFree: koffi.load("kernel32.dll").func("void* __stdcall LocalFree(void* hMem)"),
  };
  return testFfi;
}
function writeSyntheticLocalState(appdata, key) {
  const f = initTestFfi();
  const out = { cbData: 0, pbData: null };
  const kb = Buffer.from(key);
  if (!f.protect({ cbData: kb.length, pbData: f.koffi.as(kb, "void*") }, null, null, null, null, 0, out)) {
    throw new Error("CryptProtectData=false errno=" + f.koffi.errno());
  }
  const blob = Buffer.from(f.koffi.decode(out.pbData, f.koffi.array("uint8_t", out.cbData)));
  try { f.localFree(out.pbData); } catch { /* 释放失败不致命 */ }
  // Chromium 形态：5 字节 ASCII "DPAPI" + DPAPI blob，整体 base64 进 JSON
  const raw = Buffer.concat([Buffer.from("DPAPI", "latin1"), blob]);
  fs.mkdirSync(path.join(appdata, "AgentHub"), { recursive: true });
  fs.writeFileSync(path.join(appdata, "AgentHub", "Local State"), JSON.stringify({ os_crypt: { encrypted_key: raw.toString("base64") } }), "utf8");
  return raw.length;
}

/** 用指定密钥手工拼一条 v10 密文（等价于「别的机器 / 别的密钥写的存量密文」） */
function forgeV10(key, plain) {
  const nonce = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return "enc:v1:" + Buffer.concat([Buffer.from("v10", "latin1"), nonce, ct, c.getAuthTag()]).toString("base64");
}

/** 清掉某棵树下已加载的模块，下次 require 得到全新实例（secretbox 的主密钥缓存是实例级的） */
function fresh(prefix) {
  const p = path.resolve(prefix);
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(p) || k.includes("secretbox") || k.endsWith("config.cjs")) delete require.cache[k];
  }
}
const load = (tree, name) => require(path.join(tree, "proxy", name + ".cjs"));

// koffi / DPAPI 本机不可用 → SKIP + exit 2，不能静默通过（否则这条闸在那台机器上是空闸）
const SYN_KEY = Buffer.alloc(32, 7);          // 自造假主密钥，与任何真实凭据无关
const SYN_KEY_B = Buffer.alloc(32, 9);        // 另一把：造「换机器 / 主密钥已变」场景
try {
  const k = require("koffi");
  k.load("crypt32.dll");
  const n = writeSyntheticLocalState(path.join(work, "probe"), SYN_KEY);
  assert.ok(n > 5, "合成 Local State 没写进去");
  pass(`koffi + DPAPI 可用（合成 32 B 主密钥包成 ${n} B encrypted_key，含 5 字节 DPAPI 前缀）`);
} catch (e) {
  console.log("SKIP koffi/DPAPI 本机不可用，v10 那条链无法验证：" + String(e.message).split("\n")[0]);
  console.log("（这不是通过。换到 Windows + koffi 可用的机器上必须重跑本闸。）");
  M._load = origLoad;
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 交给系统回收 */ }
  process.exit(2);
}

try {
  // ===== 1) 无 Local State：打包判据决定 plain-dev 还是 none =====
  const noKeyAppdata = path.join(work, "appdata-none");
  fs.mkdirSync(path.join(noKeyAppdata, "AgentHub"), { recursive: true });
  process.env.APPDATA = noKeyAppdata;

  fresh(devTree);
  const devSb = load(devTree, "secretbox");
  assert.ok(!devSb.__selfCheck.includes("app.asar"), "开发态拷贝不该落在 asar 路径里，这条断言会假绿");
  assert.strictEqual(devSb.backend(), "plain-dev", "开发态无 Local State 应降级明文（保住 tools/proxy-smoke 与既有自测）");
  assert.strictEqual(devSb.encrypt("abc"), "abc", "plain-dev 下明文照旧");   // 既有自测的保命语义
  pass("开发态（非 asar）无加密能力 → plain-dev，encrypt 明文照旧");

  // ===== 4) 闸门必抛（测生产判据本身，不测注入的 flag）=====
  fresh(pkgTree);
  const sb = load(pkgTree, "secretbox");
  assert.ok(sb.__selfCheck.includes("app.asar"), "拷贝没进 asar 路径，这条断言会假绿");   // 判据自证
  assert.strictEqual(sb.backend(), "none", "打包态 + 无 Local State + 无 safeStorage 必须是 none");
  assert.throws(() => sb.encrypt("token-abc"), /凭据加密/, "打包态无能力时必须拒写，不得静默明文");
  assert.throws(() => sb.assertUsable(), /凭据解密失败/);
  pass("打包态无能力 → backend()=none，encrypt/assertUsable 双双抛错（拒写明文闸门）");

  // ===== 2) 有 Local State：v10 双向自解 =====
  const v10Appdata = path.join(work, "appdata-v10");
  const keyBytes = writeSyntheticLocalState(v10Appdata, SYN_KEY);
  process.env.APPDATA = v10Appdata;
  fresh(pkgTree);
  const vb = load(pkgTree, "secretbox");
  assert.strictEqual(vb.backend(), "v10", "打包态 + 可用 Local State 必须走 v10，不再误判 none");
  assert.strictEqual(vb.assertUsable(), undefined, "v10 可用时启动期闸门不该抛");
  const SYN_PLAIN = "trae-token-合成-0123456789";
  const cipher = vb.encrypt(SYN_PLAIN);
  assert.ok(cipher.startsWith("enc:v1:"), "v10 密文仍走 enc:v1: 信封（与存量格式同前缀）");
  const payload = Buffer.from(cipher.slice("enc:v1:".length), "base64");
  assert.strictEqual(payload.subarray(0, 3).toString("latin1"), "v10", "载荷头三字节必须是 ASCII v10");
  assert.strictEqual(payload.length, 3 + 12 + Buffer.byteLength(SYN_PLAIN, "utf8") + 16, "载荷 = v10(3)+nonce(12)+密文+tag(16)");
  assert.strictEqual(vb.decrypt(cipher), SYN_PLAIN, "v10 自解密文必须还原明文");
  pass(`v10 后端：${keyBytes} B encrypted_key → DPAPI → AES-256-GCM 往返一致，载荷布局逐字节核对`);

  // 同一明文两次密文不同且都能解 —— 防「nonce 复用/固定 IV」这种看着也能跑的写法混过去
  const cipher2 = vb.encrypt(SYN_PLAIN);
  assert.notStrictEqual(cipher, cipher2, "同明文两次加密不该相同（nonce 必须随机）");
  assert.strictEqual(vb.decrypt(cipher2), SYN_PLAIN);
  pass("同明文两次密文不同且都能解（nonce 随机）");

  // ===== 3) enc:v1: 兼容性：手工拼的信封（存量密文字节布局）能解 =====
  assert.strictEqual(vb.decrypt(forgeV10(SYN_KEY, "manual-envelope")), "manual-envelope",
    "非本模块加密、同格式的存量密文必须可解（无需迁移）");
  pass("enc:v1: + v10 载荷：手工拼装的「存量密文」可解，无需数据迁移");

  // ===== 5) 未知密文形态不静默；空串与存量明文原样返回 =====
  assert.throws(() => sb.decrypt("enc:v1:" + Buffer.from("junkjunkjunk").toString("base64")), /未知密文形态/);
  assert.strictEqual(sb.decrypt(""), "", "空值原样返回（存量明文路径不破）");
  assert.strictEqual(sb.decrypt("plain"), "plain", "无信封的存量明文原样返回");
  assert.strictEqual(vb.decrypt(""), "");
  assert.strictEqual(vb.decrypt("plain-token"), "plain-token");
  pass("未知密文形态抛错；空串与存量明文原样返回");

  // 截断信封 / 主密钥不符（换机器）都要抛错，而不是回空串蒙混
  assert.throws(() => vb.decrypt("enc:v1:" + Buffer.from("v10short").toString("base64")), /长度不足/);
  assert.throws(() => vb.decrypt(forgeV10(SYN_KEY_B, "from-other-machine")), /凭据解密失败/,
    "GCM 认证标签校验未通过时必须抛错，不得静默返回空串");
  pass("截断信封 / 主密钥变更（换机器）一律抛错，不静默回空串");

  // ===== 6) 同文不同进程可解（这才是「存量密文无需迁移」的硬证据）=====
  const hook = `const M = require("node:module");
const real = M._load;
M._load = function (request, ...rest) {
  if (request === "koffi") return real.call(this, ${JSON.stringify(KOFFI_PATH)}, ...rest);
  return real.call(this, request, ...rest);
};`;
  // 父进程加密 → 子进程解密
  const xfer = path.join(work, "xproc.enc");
  fs.writeFileSync(xfer, cipher, "utf8");
  const decSrc = `"use strict";
const fs = require("node:fs"), crypto = require("node:crypto");
${hook}
const sb = require(${JSON.stringify(fwd(path.join(pkgTree, "proxy", "secretbox.cjs")))});
const plain = sb.decrypt(fs.readFileSync(process.argv[1], "utf8").trim());
console.log("CHILD-DEC backend=" + sb.backend() + " sha256=" + crypto.createHash("sha256").update(plain).digest("hex").slice(0, 8));
`;
  let r = spawnSync(process.execPath, ["-e", decSrc, fwd(xfer)], {
    cwd: work, encoding: "utf8",
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1", APPDATA: v10Appdata }),
  });
  assert.strictEqual(r.status, 0, "子进程解密失败：\n" + ((r.stdout || "") + (r.stderr || "")).slice(0, 800));
  assert.match(r.stdout, /backend=v10/, "子进程没走 v10 后端：" + r.stdout.trim());
  assert.ok(r.stdout.includes("sha256=" + sha8(SYN_PLAIN)),
    "父进程 v10 密文在另一个进程里解不出同一明文：\n" + r.stdout.trim());
  pass("父进程加密 → 子进程（独立进程、各自取一次 DPAPI 主密钥）解密一致");

  // 反向：子进程加密 → 父进程解密
  const back = path.join(work, "xproc2.enc");
  const encSrc = `"use strict";
const fs = require("node:fs");
${hook}
const sb = require(${JSON.stringify(fwd(path.join(pkgTree, "proxy", "secretbox.cjs")))});
fs.writeFileSync(process.argv[1], sb.encrypt(process.argv[2]), "utf8");
console.log("CHILD-ENC backend=" + sb.backend());
`;
  r = spawnSync(process.execPath, ["-e", encSrc, fwd(back), "from-child-process"], {
    cwd: work, encoding: "utf8",
    env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: "1", APPDATA: v10Appdata }),
  });
  assert.strictEqual(r.status, 0, "子进程加密失败：\n" + ((r.stdout || "") + (r.stderr || "")).slice(0, 800));
  assert.match(r.stdout, /backend=v10/);
  assert.strictEqual(vb.decrypt(fs.readFileSync(back, "utf8").trim()), "from-child-process",
    "子进程写的 v10 密文父进程解不出 = 跨进程不互解，二期子进程一上线就空号池");
  pass("子进程加密 → 父进程解密一致（双向互解，存量密文无需迁移）");

  // ===== 委派：config.cjs 不得留第二份真相源 =====
  fresh(path.join(ROOT, "electron", "backend"));
  const cfgMod = require(path.join(ROOT, "electron", "backend", "config.cjs"));
  const delegated = cfgMod.encryptSecret("webdav-pw-synthetic");
  assert.ok(delegated.startsWith("enc:v1:"), "config.encryptSecret 未走 v10 后端（没委派到 secretbox）：" + delegated.slice(0, 12));
  assert.strictEqual(cfgMod.decryptSecret(delegated), "webdav-pw-synthetic", "config.decryptSecret 未委派");
  assert.throws(() => cfgMod.decryptSecret(forgeV10(SYN_KEY_B, "x")), /凭据解密失败/, "config.decryptSecret 未把抛错语义透出来");
  const cfgSrc = fs.readFileSync(path.join(ROOT, "electron", "backend", "config.cjs"), "utf8");
  assert.ok(!/isEncryptionAvailable|encryptString|decryptString/.test(cfgSrc),
    "config.cjs 里还留着 safeStorage 直接调用的第二份加解密实现（必须逐字委派 secretbox）");
  pass("config.encryptSecret/decryptSecret 已逐字委派 secretbox，config.cjs 内无第二份实现");

  // loadConfig 链路上不许有未捕获抛错：磁盘上躺着一把解不开的密文时，配置读取必须照常返回
  const cfgFile = path.join(v10Appdata, "AgentHub", "config.json");
  const existed = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, "utf8") : null;
  fs.writeFileSync(cfgFile, JSON.stringify({
    webdav: { endpoint: "https://example.invalid", username: "u", password: "enc:v1:" + Buffer.from("junkjunkjunk").toString("base64") },
  }), "utf8");
  try {
    fresh(path.join(ROOT, "electron", "backend"));
    const cfg2 = require(path.join(ROOT, "electron", "backend", "config.cjs"));
    const loaded = cfg2.loadConfig();
    assert.strictEqual(loaded.webdav.password, "", "解不开的 webdav 口令应回空串（保住旧语义：让用户重填）");
    assert.strictEqual(loaded.proxy.port, 9527, "loadConfig 的深合并照常工作");
    pass("config.loadConfig() 遇到解不开的密文不抛错（整个配置读取不能因一把口令炸掉）");
  } finally {
    if (existed === null) fs.rmSync(cfgFile, { force: true });
    else fs.writeFileSync(cfgFile, existed, "utf8");
  }

  // ===== Step 4：tokenUsable 接住抛错并计数（Task 3 的 /readyz 要区分「没号」与「解不开」）=====
  const storeSrc = fs.readFileSync(path.join(ROOT, "electron", "backend", "proxy", "store.cjs"), "utf8");
  assert.ok(!/require\(\s*.better-sqlite3.\s*\)/.test(storeSrc), "store.cjs 还留着 better-sqlite3 的 require 回退（该包不在依赖里，本机也实测不存在）");
  fresh(path.join(ROOT, "electron", "backend"));
  const st = require(path.join(ROOT, "electron", "backend", "proxy", "store.cjs"));
  assert.strictEqual(st.driver(), "node:sqlite", "驱动判据只剩 node:sqlite / none");
  assert.strictEqual(typeof st.decryptFailureCount, "function", "store.decryptFailureCount() 未导出（Task 3 的 /readyz 要用）");
  const id = st.addAccount({ channel: "trae", uid: "u-synthetic", name: "合成号", token: cipher, refreshToken: "", source: "paste" });
  // 把 token_enc 换成「格式正确但主密钥不同」的信封 = 换机器后的存量号池
  const { DatabaseSync } = require("node:sqlite");
  const raw = new DatabaseSync(path.join(st.proxyDir(), "stats.db"));
  raw.prepare("UPDATE accounts SET token_enc = ? WHERE id = ?").run(forgeV10(SYN_KEY_B, "foreign"), id);
  raw.close();
  const before = st.decryptFailureCount();
  const row = st.listAccounts("trae").find((a) => a.id === id);
  assert.ok(row, "写进去的合成号查不到");
  assert.strictEqual(row.hasToken, false, "解不开的 token 不能算可用号（否则全 401 空转）");
  assert.strictEqual(st.decryptFailureCount(), before + 1, "解密失败必须计数，供 /readyz 区分「没号」与「解不开」");
  assert.strictEqual(st.accountSecrets(st.getAccount(id)).token, "", "accountSecrets 解不开时回空串并计数，不把整条请求抛穿");
  assert.ok(st.decryptFailureCount() >= before + 2, "读路径的失败同样要计数");
  st.removeAccount(id);
  st.close();   // 关掉父进程持有的 DB 句柄，否则 Windows 删不掉临时目录（EBUSY）
  pass("tokenUsable 接住抛错、hasToken=false、decryptFailureCount() 递增（读路径不抛穿）");

  // ===== 7) vaultOk() 在四种后端下的取值（§5.7 定案，Task 5 归属表的前提）=====
  // 每种后端一个干净子进程：backend() 由「路径是否含 app.asar」+「本机能否拿到加密能力」共同决定，
  // 拆成子进程既免了删缓存的把戏，顺带把「整张网关图能在独立进程里跑通」一起证了。
  const vaultSrc = (tree, fakeElectron) => `"use strict";
const M = require("node:module");
const real = M._load;
M._load = function (request, ...rest) {
  if (request === "koffi") return real.call(this, ${JSON.stringify(KOFFI_PATH)}, ...rest);
  ${fakeElectron ? 'if (request === "electron") return { safeStorage: { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from("fx" + s, "utf8"), decryptString: (b) => Buffer.from(b).subarray(2).toString("utf8") } };' : ""}
  return real.call(this, request, ...rest);
};
const sb = require(${JSON.stringify(fwd(path.join(tree, "proxy", "secretbox.cjs")))});
const idx = require(${JSON.stringify(fwd(path.join(tree, "proxy", "index.cjs")))});
const st = idx.gatewayStatus();
console.log("VAULT backend=" + sb.backend() + " vaultOk=" + st.vaultOk + " driver=" + st.dbDriver);
`;
  const vaultCases = [
    { tree: pkgTree, appdata: noKeyAppdata, fake: false, backend: "none", vaultOk: false, label: "none → vaultOk=false（网关页如实报「保险不可用」）" },
    { tree: devTree, appdata: noKeyAppdata, fake: false, backend: "plain-dev", vaultOk: true, label: "plain-dev → vaultOk=true" },
    { tree: pkgTree, appdata: v10Appdata, fake: false, backend: "v10", vaultOk: true, label: "v10 → vaultOk=true（子进程不再误报，Task 5 才能把 proxy_status 转成转发）" },
    { tree: pkgTree, appdata: noKeyAppdata, fake: true, backend: "safeStorage", vaultOk: true, label: "safeStorage → vaultOk=true" },
  ];
  for (const c of vaultCases) {
    const rr = spawnSync(process.execPath, ["-e", vaultSrc(c.tree, c.fake)], {
      cwd: work, encoding: "utf8",
      env: Object.assign({}, process.env, {
        ELECTRON_RUN_AS_NODE: "1", APPDATA: c.appdata,
        AGENT_SKILLS_HOME: path.join(work, "hub-" + c.backend),
      }),
    });
    const out = (rr.stdout || "") + (rr.stderr || "");
    assert.strictEqual(rr.status, 0, `gatewayStatus 子进程失败（${c.backend}）：\n` + out.slice(0, 1200));
    assert.ok(out.includes("VAULT backend=" + c.backend + " vaultOk=" + c.vaultOk),
      `${c.label} —— 实得：\n` + out.slice(0, 600));
    pass("index.gatewayStatus().vaultOk " + c.label);
  }
} finally {
  M._load = origLoad;
  try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* Windows 偶发 EBUSY，交给系统回收 */ }
}

console.log(`OK 凭据双后端互解、打包态拒写明文（${steps} 项）`);
