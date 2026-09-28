// 反代网关 · 渠道适配器（方案 §6.3 IR 内核 + §2 协议事实基线）
// 进线 OpenAI body → 归一 → 渠道改写 → 上游 fetch → SSE 事件流转换 → 统一 OpenAI 输出
// 三渠道（trae / workbuddy / workbuddy_ai）差异收敛为「配置（rules/headers.json）+ 改写函数」，
// WorkBuddy CN 与国际版共享适配器核心，配置层隔离、代码零复制（方案 §2.3）
"use strict";
const crypto = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const rules = require("./rules.cjs");
const store = require("./store.cjs");
const util = require("./util.cjs");
const raccoonAuth = require("./raccoonAuth.cjs");
const clineAuth = require("./clineAuth.cjs");
const acCred = require("./autoclawCredentials.cjs");
const acPrompt = require("./autoclawPrompt.cjs");
const aup = require("./protocols/anthropic-up.cjs");
const qcosy = require("./qoderCosy.cjs");

const FIRST_BYTE_MS = 30000; // 首 token 30s 超时判失败。实测成功请求 TTFT P99≈8.7s、最大 20.2s，
// 10s 会误杀慢模型/thinking 首包（参考项目无首字节总超时，读空闲容忍 300s，这里取全覆盖+余量的折中）
const STREAM_IDLE_MS = 300000; // 流中读超时 300s

// ===== HTTP 基础 =====

/** 流式请求：首字节超时内必须拿到响应头并开始产出，否则 abort 判失败（可故障转移） */
async function fetchStream(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FIRST_BYTE_MS);
  let resp;
  try {
    resp = await fetch(url, { ...opts, signal: ctrl.signal, redirect: "follow" });
  } catch (e) {
    clearTimeout(timer);
    throw Object.assign(new Error(e.name === "AbortError" ? "上游首字节超时（10s）" : `网络错误：${e.message}`), { network: true });
  }
  if (!resp.ok) {
    clearTimeout(timer);
    const text = await resp.text().catch(() => "");
    const err = Object.assign(new Error(`上游 HTTP ${resp.status}：${text.slice(0, 200)}`), {
      status: resp.status,
      body: text,
      // 上游明示的限流等待（Retry-After 三头族，参考项目 P1-2），分类器据此对齐墙钟
      retryAfterMs: util.parseRetryAfterHeaders(resp.headers),
    });
    throw err;
  }
  return { resp, cancelTimer: () => clearTimeout(timer) };
}

/** 普通 JSON 请求（额度查询 / token 刷新），60s 总超时（参考项目 120s 口径的折中：含冷启动排队） */
async function httpJson(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const resp = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* 非 JSON 响应留原文 */ }
    return { status: resp.status, ok: resp.ok, data, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 逐块读 SSE：web stream 异步迭代 + 空闲 300s 判死；客户端断连后继续消费至 EOF（保 usage 完整） */
async function pumpSse(resp, onEvent) {
  const scanner = new util.SseScanner(onEvent);
  const decoder = new TextDecoder();
  const reader = resp.body.getReader();
  // 单个 idle 定时器循环重置：原来每读一个 chunk 就新挂一个 300s 定时器且旧的不清，
  // 长流（几千 chunk）会同时挂几千个待触发定时器，高并发时随流量线性膨胀
  let idleTimer = null;
  const armIdle = () =>
    new Promise((_, rej) => {
      idleTimer = setTimeout(() => rej(Object.assign(new Error("流中读超时（300s）"), { idleTimeout: true })), STREAM_IDLE_MS);
    });
  try {
    for (;;) {
      const read = await Promise.race([reader.read(), armIdle()]);
      clearTimeout(idleTimer);
      idleTimer = null;
      if (read.done) break;
      scanner.feed(decoder.decode(read.value, { stream: true }));
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
  scanner.feed(decoder.decode());
  scanner.flush();
}

/** 账号级稳定指纹：device_id（15 位数字）/ machine_id（64 hex），同账号多次请求保持一致 */
function deviceIds(account) {
  const h = crypto.createHash("sha256").update(String(account.id || account.uid || "anon")).digest("hex");
  const digits = h.replace(/[a-f]/g, "").padEnd(15, "0").slice(0, 15);
  return { deviceId: digits, machineId: h };
}

/** 权威目录（rules/catalog.json）：渠道 → Map(模型id小写 → 条目{id,name,rate,capabilities,contextLength,...}) */
function catalogMap(channel) {
  const cat = rules.get("catalog.json") || {};
  const sec = cat[channel] || {};
  const map = new Map();
  for (const m of Array.isArray(sec.models) ? sec.models : []) {
    if (m && m.id) map.set(String(m.id).toLowerCase(), m);
  }
  return map;
}

/** 目录 id 并集去重（大小写不敏感）：catalog 优先，旧文件兜底不丢 */
function unionIds(catalogIds, legacyIds) {
  const out = [];
  for (const id of [...catalogIds, ...legacyIds]) {
    const s = String(id);
    if (s && !out.some((x) => x.toLowerCase() === s.toLowerCase())) out.push(s);
  }
  return out;
}

function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

/** 按 key 深度优先找数组（util.dig 只取标量，包列表这类结构要单独挖） */
function findList(node, key, depth) {
  if (!node || typeof node !== "object" || (depth || 0) > 5) return null;
  if (Array.isArray(node)) {
    for (const v of node) {
      const hit = findList(v, key, (depth || 0) + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (Array.isArray(node[key])) return node[key];
  for (const v of Object.values(node)) {
    const hit = findList(v, key, (depth || 0) + 1);
    if (hit) return hit;
  }
  return null;
}

/** 渠道上游候选域：accountOrigins 优先，其次 creditsUrl / exchangeUrl 的 origin */
function candidateOrigins(c, extra) {
  const out = [];
  for (const o of Array.isArray(c.accountOrigins) ? c.accountOrigins : []) {
    const s = String(o || "").replace(/\/+$/, "");
    if (s && !out.includes(s)) out.push(s);
  }
  for (const u of [c.creditsUrl, c.exchangeUrl, extra]) {
    try {
      const o = new URL(String(u)).origin;
      if (!out.includes(o)) out.push(o);
    } catch { /* 配置缺项跳过 */ }
  }
  return out;
}

// ===== Trae SOLO CN（方案 §2.1） =====

/** 订阅包取余量：CN 档位优先级 100(CNExpress) > 6 > 5 > 4 > 1 > 9 > 8 > 0，命中即用 */
const TRAE_PACK_PRIORITY = [100, 6, 5, 4, 1, 9, 8, 0];

function pickEntitlementPack(packs) {
  const shaped = packs.map((p) => ({
    productType: Number(util.dig(p, /^product_type$/i)) || 0,
    credits: Number(util.dig(p, /remain|balance|left|available|total_credit|credits|quota/i)) || 0,
    expiresAt: util.toMs(util.dig(p, /end_time|expire|deadline|valid_until/i)),
  }));
  for (const want of TRAE_PACK_PRIORITY) {
    const hit = shaped.find((s) => s.productType === want);
    if (hit) return hit;
  }
  // 档位都不认识（上游加了新套餐）：退化成余量最大的那个包
  return shaped.reduce((a, b) => (b.credits > a.credits ? b : a), { productType: 0, credits: 0, expiresAt: 0 });
}

const trae = {
  id: "trae",

  cfg() {
    return rules.get("headers.json").trae;
  },

  /** 模型显示名 → (config_name, model_name)；映射表外置热加载。
   *  宽松归一化匹配（参考项目 normalizeModelName）：下划线↔横线、大小写不敏感，
   *  客户端传 deepseek_v4_pro / DeepSeek-V4-Pro 之类变体也能命中映射；未命中原样透传（上游接受裸 config_name） */
  mapModel(model) {
    const map = rules.get("model_map.json") || {};
    let hit = map[model];
    if (!hit) {
      const norm = (s) => String(s).toLowerCase().replace(/_/g, "-");
      const want = norm(model);
      for (const k of Object.keys(map)) {
        if (norm(k) === want) { hit = map[k]; break; }
      }
    }
    if (Array.isArray(hit) && hit.length >= 2) return { configName: String(hit[0]), modelName: String(hit[1]) };
    return { configName: model, modelName: model };
  },

  models() {
    const catalog = [...catalogMap("trae").values()].map((m) => String(m.id));
    return unionIds(catalog, Object.keys(rules.get("model_map.json") || {}));
  },

  /** 拉取官方模型目录：get_detail_param（参考项目实证：config_info_list[].config_name + display_config.display_name），
   *  镜像域优先（与对话出口同域），失败回退官方域 */
  async fetchModels(account, secrets) {
    const c = this.cfg();
    const body = JSON.stringify({
      function: "solo_work_lite",
      config_names: null,
      need_prompt: false,
      current_config_info: null,
      poly_prompt: true,
    });
    let lastErr = "";
    for (const url of [c.modelsUrl, c.mirrorModelsUrl].filter(Boolean)) {
      const headers = { ...this.headers(account, secrets), referer: url };
      const r = await httpJson(url, { method: "POST", headers, body })
        .catch((e) => ({ ok: false, status: 0, message: String((e && e.message) || e) }));
      if (!r.ok || !r.data) {
        lastErr = r.status === 401 ? "账号登录态失效（401），请重新登录" : `HTTP ${r.status || 0} ${r.message || ""}`.trim();
        continue;
      }
      const list = findList(r.data, "config_info_list", 0) || [];
      const models = [];
      for (const it of list) {
        const id = it && (it.config_name || it.configName);
        if (typeof id !== "string" || !id) continue;
        const name = (it.display_config && (it.display_config.display_name || it.display_config.name)) || id;
        if (!models.some((m) => m.id === id)) {
          models.push({ id, name: String(name), rate: null, capabilities: {}, contextLength: 131072, maxOutputTokens: 0 });
        }
      }
      if (models.length) return { ok: true, models };
      lastErr = "官方目录解析为空（接口可能已变更）";
    }
    return { ok: false, message: lastErr || "目录拉取失败" };
  },

  /** 完整请求头指纹（逐字段对齐参考项目实证抓包，缺任何一项都可能被上游风控识别为非官方客户端） */
  headers(account, secrets) {
    const c = this.cfg();
    const { deviceId, machineId } = deviceIds(account);
    const tid = util.traceId(); // "00-<hex32>-<hex32>-01"
    const h = {
      "content-type": "application/json",
      "accept": "*/*",
      "accept-language": "zh-CN,zh;q=0.9",
      "user-agent": c.userAgent,
      "authorization": `Cloud-IDE-JWT ${secrets.token}`,
      "x-ide-token": secrets.token,
      "x-cloudide-token": secrets.token,
      "x-app-id": c.appId,
      "x-app-version": "default",
      "x-app-version-code": c.ideVersionCode,
      "x-ide-version": c.ideVersion,
      "x-ide-version-code": c.ideVersionCode,
      "x-ide-version-type": "stable",
      "x-device-type": "windows",
      "x-device-brand": c.deviceBrand || "CREFG-XX",
      "x-device-cpu": "Intel",
      "x-device-id": deviceId,
      "x-machine-id": machineId,
      "x-os-version": c.osVersion || "Windows 11 Home China",
      "request-traffic-type": "prod",
      "package-type": "stable_cn",
      "x-lgw-req-sdk-type": "3",
      "x-lscbd-aid": "787976",
      "x-lscbd-platform": "windows",
      "x-ss-dp": "787976",
      "app-version": c.ideVersion,
      "x-custom-trace-id": tid.slice(3, 19),
      "x-flow-traceparent": `04-${tid.slice(3, 35)}-${crypto.randomBytes(16).toString("hex")}-01`,
      "x-tt-trace-id": tid,
      "x-request-id": `req_${crypto.randomUUID().replace(/-/g, "")}`,
      // referer 在 chat() 里按实际请求 URL 覆盖（同源伪装）
    };
    // X-Uid 官方客户端恒带（参考项目 SOLOHeaders 实证），缺了是风控识别点
    if (account && account.uid) h["x-uid"] = String(account.uid);
    return h;
  },

  /** function 字段按模型分发（TraeWorkAssistant models_sync.rs 实证：部分模型仅在
   *  solo_agent 下可用）；映射表外置 rules/function_map.json，未命中默认 solo_work_lite */
  functionForModel(model) {
    const map = rules.get("function_map.json") || {};
    const direct = map[String(model)];
    if (direct) return String(direct);
    const norm = (s) => String(s).toLowerCase().replace(/_/g, "-");
    const want = norm(model);
    for (const k of Object.keys(map)) {
      if (norm(k) === want) return String(map[k]);
    }
    return "solo_work_lite";
  },

  /** OpenAI body → llm_utils_chat 改写（对齐参考项目 prepare_llm_chat_body） */
  rewriteBody(model, body, account) {
    const c = this.cfg();
    const { configName } = this.mapModel(model);
    const { deviceId, machineId } = deviceIds(account);
    const out = { ...body };
    // 消息内容数组化：content string → [{type:text,text:...}]
    out.messages = (body.messages || []).map((m) => {
      const msg = { ...m };
      if (typeof msg.content === "string") msg.content = [{ type: "text", text: msg.content }];
      // assistant tool_calls：function → function_call，空 name 条目剔除
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        msg.tool_calls = msg.tool_calls
          .filter((tc) => tc && tc.function && tc.function.name)
          .map((tc) => ({
            id: tc.id,
            type: "function",
            function_call: { name: tc.function.name, arguments: typeof tc.function.arguments === "string" ? tc.function.arguments : JSON.stringify(tc.function.arguments || {}) },
          }));
        if (!msg.tool_calls.length) delete msg.tool_calls;
      }
      return msg;
    });
    // tools[].function.parameters object → JSON string
    if (Array.isArray(out.tools)) {
      out.tools = out.tools.map((t) => {
        if (t && t.function && t.function.parameters && typeof t.function.parameters === "object") {
          return { ...t, function: { ...t.function, parameters: JSON.stringify(t.function.parameters) } };
        }
        return t;
      });
    }
    // tool_choice 归一化（对齐参考项目）："none"（字符串或对象）→ 删 tool_choice 并同时删除 tools/functions；
    // {type:function} → name 字符串；{type:auto/required} → 字符串
    const tc = out.tool_choice;
    const tcType = typeof tc === "string" ? tc : tc && typeof tc === "object" ? tc.type : "";
    if (tcType === "none") {
      delete out.tools;
      delete out.functions;
      delete out.tool_choice;
    } else if (tc && typeof tc === "object") {
      out.tool_choice = (tc.function && tc.function.name) || tcType || "auto";
    }
    // 必填注入字段（方案 §2.1）
    out.config_name = configName;
    // model 与 config_name 同值（traework2api payload.go 实证形态：上游认这两个键同值）。
    // model_map 第二列（__dev 内部名）保留备用：若上游报 "the model is unknown"，
    // 切换 TraeWorkAssistant 形态——把本行改为 out.model_name = modelName 并删掉 out.model
    out.model = configName;
    out.stream = true; // 强制流式，非流式本地聚合
    out.function = this.functionForModel(model);
    out.max_tokens = 4096;
    out.conversation_id = util.uuid();
    out.user_id = account.uid || "";
    out.session_id = util.uuid();
    out.device_id = deviceId;
    out.machine_id = machineId;
    out.project_id = util.uuid();
    out.workspace_id = "e04cdd";
    out.prompt_max_tokens = 168000;
    out.mode = "FunctionCall";
    out.ide_version = c.ideVersion;
    out.ide_version_code = c.ideVersionCode;
    out.app_id = c.appId;
    out.package_type = "stable_cn";
    return out;
  },

  /**
   * 对话主流程：emit 结构化事件（delta/usage/finish/error），返回上游级结果供换号决策
   * 官方域优先，网络层失败回退社区镜像域（方案 §2.1 镜像兜底）
   */
  async chat({ account, secrets, model, body, emit }) {
    const c = this.cfg();
    const payload = JSON.stringify(this.rewriteBody(model, body, account));
    const base = this.headers(account, secrets);
    let lastErr = null;
    for (const url of [c.chatUrl, c.mirrorChatUrl]) {
      if (!url) continue;
      try {
        // referer 与请求 URL 同源（参考项目实证：伪装成同源请求，恒为 <host>/api/agent/v3/llm_utils_chat）
        return await this.chatOnce(url, { ...base, referer: url }, payload, model, emit);
      } catch (e) {
        lastErr = e;
        // 网络错误直接换镜像；404（TLB 整域下线/路径失效）也换——官方域随时可能停 agent 服务
        if (!e.network && !(e && e.status === 404)) throw e;
      }
    }
    throw lastErr || new Error("上游不可达");
  },

  async chatOnce(url, headers, payload, model, emit) {
    const { resp, cancelTimer } = await fetchStream(url, { method: "POST", headers, body: payload });
    let settled = false;
    const result = { status: 200, planLimit: false };
    const seenToolIndex = new Set(); // 流式 tool_calls：每个 index 只在首片带 name（OpenAI 官方形态，issue #82）
    try {
      await pumpSse(resp, (event, raw) => {
        if (!settled) {
          settled = true;
          cancelTimer(); // 首个 SSE 事件到达 = 首字节达标
        }
        const data = parseJson(raw);
        if (!data) return;
        const ev = event || data.event || data.type || "";
        if (ev === "output" || ev === "thought") {
          const delta = {};
          if (typeof data.response === "string") delta.content = data.response;
          else if (typeof data.content === "string") delta.content = data.content;
          if (typeof data.reasoning_content === "string") delta.reasoning_content = data.reasoning_content;
          // 工具调用差量：function_call → function，剥 namespace / partial_arguments；
          // name 键首片保留、后续分片删除（键缺失比空串安全：覆盖型客户端 ?? 对空串会误清工具名）
          if (Array.isArray(data.tool_calls)) {
            delta.tool_calls = data.tool_calls.map((tc, i) => {
              const fc = tc.function_call || tc.function || {};
              const idx = tc.index != null ? tc.index : i;
              const fn = { arguments: fc.arguments || "" };
              if (!seenToolIndex.has(String(idx))) {
                seenToolIndex.add(String(idx));
                fn.name = fc.name || "";
              }
              return { index: idx, id: tc.id, type: "function", function: fn };
            });
          }
          if (Object.keys(delta).length) emit({ type: "delta", delta });
        } else if (ev === "token_usage") {
          // usage 透传完整对象（参考项目实证：含 reasoning_tokens / credit 等扩展字段），缺总数本地补
          const usage = {
            prompt_tokens: Number(data.prompt_tokens ?? data.prompt ?? 0) || 0,
            completion_tokens: Number(data.completion_tokens ?? data.completion ?? 0) || 0,
            total_tokens: Number(data.total_tokens ?? data.total ?? 0) || 0,
          };
          for (const [k, v] of Object.entries(data)) {
            if (typeof v === "number" && !(k in usage)) usage[k] = v;
          }
          Object.assign(usage, util.openaiCacheTokens(data)); // 缓存字段归一（trae 上游字段名不定，认全三种命名）
          if (!usage.total_tokens) usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
          emit({ type: "usage", usage });
        } else if (ev === "done" || ev === "turn_completion") {
          emit({ type: "finish", reason: data.finish_reason || data.finishReason || "stop" });
        } else if (ev === "error") {
          // code:1005 = 积分不足 PlanLimit；4008 = 限流；4001 = 模型配置问题（不罚号，交由分类器处理）
          const code = Number(data.code) || 0;
          if (code === 1005) result.planLimit = true;
          const status = code === 1005 ? 402 : code === 4008 ? 429 : 502;
          emit({ type: "error", status, code, message: data.message || data.msg || `上游错误 ${code}` });
        }
        // metadata / timing_cost / extra_info 忽略
      });
    } finally {
      cancelTimer();
    }
    return result;
  },

  /**
   * 额度查询：CN 现行口径是 v2 pay 接口（v1 兜底），空体请求（参考项目实测）；
   * 余额 = 全部订阅包 (credits_limit - usage.credits_amount) 求和（老实现只取单一档位包，口径错）。
   * 实测关键：pay/ug 域对部分账号（scope=marscode 等）整体拒绝，HTTP 401 + code 1001，
   * 但同一 token 在 GetUserInfo/对话域完全正常 —— 这是「积分服务不开放」，不是凭证失效，
   * 返回 unavailable 而不是 authError，避免把好号打成 relogin
   */
  async queryCredits(account, secrets) {
    const c = this.cfg();
    const { deviceId } = deviceIds(account);
    const headers = { ...this.headers(account, secrets), "x-user-region": "CN", "x-device-id": deviceId };
    const body = "{}";
    let lastErr = "";
    for (const base of candidateOrigins(c)) {
      for (const path of ["/trae/api/v2/pay/ide_user_ent_usage", "/trae/api/v1/pay/ide_user_ent_usage"]) {
        const r = await httpJson(base + path, { method: "POST", headers, body }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        const code = Number((r.data && r.data.code) || 0);
        if ((r.status === 401 || r.status === 403) && code === 1001) {
          return { credits: 0, unavailable: true, message: "积分服务未对该账号开放（官方接口 code 1001）" };
        }
        if (r.status === 401) return { authError: true };
        if (!r.ok || !r.data) {
          lastErr = `HTTP ${r.status}${r.message ? ` ${r.message}` : ""}`;
          continue;
        }
        const packs = findList(r.data, "user_entitlement_pack_list") || [];
        if (packs.length) {
          let credits = 0;
          let expiresAt = 0;
          for (const p of packs) {
            const limit = Number(util.dig(p, /^credits_limit$/i)) || 0;
            if (limit <= 0) continue;
            const used = Number(util.dig(p, /^credits_amount$/i)) || 0;
            credits += Math.max(limit - used, 0);
            const end = util.toMs(util.dig(p, /end_time|expire|deadline|valid_until/i));
            if (end && end > Date.now() && (!expiresAt || end < expiresAt)) expiresAt = end;
          }
          if (credits > 0) return { credits, expiresAt };
          // 新版字段缺失时退回旧档位口径（单一包 remain）
          const best = pickEntitlementPack(packs);
          if (best.credits > 0) return { credits: best.credits, expiresAt: best.expiresAt };
          return { credits: 0, expiresAt };
        }
        lastErr = "上游未返回订阅包";
      }
    }
    throw new Error(`额度查询失败：${lastErr || "上游无可用响应"}`);
  },

  /** 签到状态：GET+did（cockpit 现行）为主，POST+Cloud-IDE-JWT 兜底；code 1001 = 签到服务对该账号不开放 */
  async checkinStatus(account, secrets) {
    const c = this.cfg();
    const { deviceId } = deviceIds(account);
    const base = c.checkinBase || "https://api.trae.cn";
    const tries = [
      {
        url: `${base}/trae/api/v2/ug/checkin_credits/status?did=${encodeURIComponent(deviceId)}`,
        method: "GET",
        headers: {
          authorization: `Bearer ${secrets.token}`,
          origin: "https://www.trae.cn",
          referer: "https://www.trae.cn/",
          "x-app-type": "trae",
          "x-device-id": deviceId,
          "x-user-region": "CN",
        },
      },
      {
        url: `${base}/trae/api/v2/ug/checkin_credits/status`,
        method: "POST",
        headers: { authorization: `Cloud-IDE-JWT ${secrets.token}`, "x-user-region": "CN", "x-device-id": deviceId },
      },
    ];
    let lastMsg = "";
    for (const t of tries) {
      const opts = { method: t.method, headers: { "content-type": "application/json", accept: "application/json", ...t.headers } };
      if (t.method === "POST") opts.body = "{}";
      const r = await httpJson(t.url, opts).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      const code = Number((r.data && r.data.code) ?? 0);
      const msg = String((r.data && r.data.message) || r.message || "");
      if (code === 1001) return { ok: true, unavailable: true, checkedIn: false, message: "签到服务未对该账号开放（官方接口 code 1001）" };
      if (code !== 0 && code !== 200) {
        lastMsg = msg || `HTTP ${r.status}`;
        continue;
      }
      if (!r.ok || !r.data) {
        lastMsg = `HTTP ${r.status}`;
        continue;
      }
      return {
        ok: true,
        checkedIn: !!(r.data.checked_in ?? r.data.checkedIn),
        enable: !!(r.data.enable),
        credits: Number((r.data.credits ?? r.data.total_credits) || 0),
        consecutiveDays: Number((r.data.consecutive_days ?? r.data.consecutiveDays) || 0),
        creditsEarnedToday: Number((r.data.credits_earned_today ?? r.data.creditsEarnedToday) || 0),
        checkinDate: String(r.data.checkin_date ?? r.data.checkinDate ?? ""),
        message: r.data.checked_in ? `今日已签到 · 共 ${r.data.credits ?? 0} 积分` : "今日未签到",
      };
    }
    return { ok: false, message: lastMsg || "查询签到状态失败" };
  },

  /** 签到领取：code 1001 = 服务不开放；「已签到」文案 = 幂等成功 */
  async checkin(account, secrets) {
    const c = this.cfg();
    const { deviceId } = deviceIds(account);
    const base = c.checkinBase || "https://api.trae.cn";
    const r = await httpJson(`${base}/trae/api/v2/ug/checkin_credits/claim`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Cloud-IDE-JWT ${secrets.token}`,
        "x-user-region": "CN",
        "x-device-id": deviceId,
        origin: "https://www.trae.cn",
        referer: "https://www.trae.cn/",
        "x-app-type": "trae",
      },
      body: "{}",
    }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    const code = Number((r.data && r.data.code) ?? 0);
    const msg = String((r.data && r.data.message) || r.message || "");
    if (code === 1001) return { ok: true, unavailable: true, message: "签到服务未对该账号开放（官方接口 code 1001）" };
    if (code !== 0 && code !== 200) {
      const already = /已签到|已经签到|already/i.test(msg);
      return { ok: already, already, message: msg || `签到失败 HTTP ${r.status}` };
    }
    if (!r.ok || !r.data) return { ok: false, message: msg || `签到失败 HTTP ${r.status}` };
    // 领取后回查状态拿积分明细
    const st = await this.checkinStatus(account, secrets);
    return { ok: true, already: false, message: (r.data.message || "签到成功"), status: st.ok ? st : null };
  },

  /**
   * Token 刷新：ExchangeToken（对齐参考项目：ClientID + RefreshToken + ClientSecret "-"，x-cloudide-token 空串）。
   * 上游多域时依次尝试，避免某个域被墙/维护就整条链路失效；
   * extraOrigins（OAuth 回调 loginHost 的 origin）排最前——官方回调会指定换令牌的域
   */
  async refreshToken(account, secrets, extraOrigins) {
    const c = this.cfg();
    if (!secrets.refreshToken) return { ok: false, message: "无 refreshToken，请重新登录或粘贴" };
    const headers = { "content-type": "application/json", "user-agent": c.userAgent, "x-cloudide-token": "" };
    const body = JSON.stringify({ ClientID: c.clientId, RefreshToken: secrets.refreshToken, ClientSecret: "-", UserID: "" });
    const bases = candidateOrigins(c);
    const candidates = [
      ...(Array.isArray(extraOrigins) ? extraOrigins.filter((x) => x && !bases.includes(x)) : []),
      ...bases,
    ];
    let lastErr = "";
    for (const base of candidates) {
      const r = await httpJson(`${base}/cloudide/api/v3/trae/oauth/ExchangeToken`, { method: "POST", headers, body }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      // 响应嵌套 Result.Token / Result.RefreshToken（参考项目实证），兼容扁平字段
      const d = (r.data && (r.data.Result || r.data.result || r.data.data || r.data)) || null;
      const rawToken = d && (d.Token || d.access_token || d.accessToken);
      if (r.ok && rawToken) {
        const token = String(rawToken).replace(/^Cloud-IDE-JWT\s+/i, "");
        const newRefresh = d.RefreshToken || d.refresh_token || d.refreshToken;
        return {
          ok: true,
          token,
          refreshToken: newRefresh ? String(newRefresh) : secrets.refreshToken,
        };
      }
      const errMsg = r.data && (r.data.ResponseMetadata && r.data.ResponseMetadata.Error && r.data.ResponseMetadata.Error.Message);
      lastErr = errMsg || (r.data && (r.data.message || r.data.msg)) || r.message || `刷新失败 HTTP ${r.status}`;
    }
    return { ok: false, message: lastErr };
  },

  /** 用户信息（OAuth 回调后补全 uid/昵称） */
  async userInfo(token) {
    const c = this.cfg();
    const r = await httpJson(c.userInfoUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Cloud-IDE-JWT ${token}`, "user-agent": c.userAgent },
      body: "{}",
    });
    const d = r.data && (r.data.data || r.data);
    if (r.ok && d) {
      return {
        uid: String(d.id || d.user_id || d.uid || util.jwtDecode(token).uid || ""),
        name: String(d.name || d.nickname || d.user_name || ""),
      };
    }
    const dec = util.jwtDecode(token);
    return { uid: dec.uid, name: "" };
  },
};

// ===== WorkBuddy CN / AI 双实例（方案 §2.2/§2.3，共享适配器核心） =====

/**
 * 计费响应 → { credits, expiresAt }。
 * 个人口径 get-user-resource 把额度拆成 Response.Data.Accounts[] 多个套餐包，
 * 正确余额 = 全部包的剩余求和（老实现只取第一个包，实测 CN 981 vs 129、AI 588 vs 527）。
 * 企业口径 get-enterprise-user-usage 返回 limit_num / used_num 一套（无 Accounts）。
 * credits = -1 表示企业无限额度哨兵（调用方与 UI 识别，不参与求和）。
 */
function parseWbResource(data, isEnterprise) {
  if (isEnterprise) {
    // 企业端点两层 data 都可能（data.data / data 直接挂字段），宽容取
    const d = (data && (data.data || data)) || data;
    const limit = Number(util.dig(d, /^limit_num$|^limitnum$/i));
    if (!Number.isFinite(limit)) return null;
    const used = Number(util.dig(d, /^used_num$|^usednum$|^credit$/i)) || 0;
    return {
      credits: limit < 0 ? -1 : Math.max(limit - used, 0),
      used,
      expiresAt: util.toMs(util.dig(d, /cycle_end_time|cycle_reset_time|end_time|expire/i)),
    };
  }
  const accounts = findList(data, "Accounts") || [];
  if (!accounts.length) return null;
  let remain = 0;
  let used = 0;
  let size = 0;
  let earliestEnd = 0;
  const num = (a, re) => Number(util.dig(a, re)) || 0;
  for (const a of accounts) {
    // 单包口径（参考项目 packageRemainUsed）：Cycle 期套餐优先，缺 Cycle 退回 Capacity 三字段
    let r, u, s;
    const cycSize = num(a, /^CycleCapacitySize(Precise)?$/i);
    if (cycSize > 0) {
      r = num(a, /^CycleCapacityRemain(Precise)?$/i);
      s = cycSize;
      r = Math.max(0, Math.min(r, s));
      u = Math.max(s - r, num(a, /^CycleCapacityUsed(Precise)?$/i));
    } else {
      r = num(a, /^CapacityRemain(Precise)?$/i);
      u = num(a, /^CapacityUsed(Precise)?$/i);
      s = num(a, /^CapacitySize(Precise)?$/i);
      if (!u && s > r) u = s - r;
    }
    remain += r;
    used += u;
    size += s;
    const end = util.toMs(util.dig(a, /^PackageEndTime$|^CycleEndTime$|^CycleResetTime$/i));
    // 只取未来的到期时间：响应里混着已过期的历史包（Status=3），取其到期会把账号误判成「余额已到期」
    if (end && end > Date.now() && (!earliestEnd || end < earliestEnd)) earliestEnd = end;
  }
  // TotalDosage 作 size 下限（已消耗的总量不该小于套餐总量）
  const dosage = Number(util.dig(data, /^TotalDosage$/i)) || 0;
  if (dosage > size) {
    size = dosage;
    if (size - remain > used) used = size - remain;
  } else if (size > 0 && size - remain > used) {
    used = size - remain;
  }
  return { credits: Math.max(remain, 0), used, expiresAt: earliestEnd };
}

/** 官方客户端会话头族（参考项目 ChatMeta 实证：后台按 X-Conversation-Request-ID 聚合请求，
 *  一次 user send 内的所有重试/换号必须复用同一个 ID）。meta 由 server 在轮转循环外生成一次，
 *  循环内换号沿用同值；B3 规范只认 16/32 hex TraceId，入站透传值非法时回落消息级 ID */
function wbConversationHeaders(body, meta) {
  const hex32 = () => crypto.randomBytes(16).toString("hex");
  const fromMeta = meta && typeof meta.conversationRequestId === "string" && /^[0-9a-fA-F]{16}([0-9a-fA-F]{16})?$/.test(meta.conversationRequestId)
    ? meta.conversationRequestId
    : "";
  const convReqId = fromMeta || hex32();
  const messageId = hex32();
  const h = {
    "x-conversation-request-id": convReqId, // 对话轮聚合主键，必发
    "x-conversation-message-id": messageId,
    "x-request-id": messageId,
    "x-root-request-id": convReqId,
    "x-trace-id": convReqId,
    "x-b3-traceid": convReqId,
    "x-b3-spanid": messageId.slice(0, 16),
    "x-b3-sampled": "1",
  };
  // X-Conversation-ID 透传客户端原值优先，没给就不伪造
  const convId = body && (body.conversation_id || body.conversationId);
  if (typeof convId === "string" && convId) h["x-conversation-id"] = convId;
  return h;
}

/** X-Device-Token 文件兜底（参考项目 device_token.go：≤1KB、5min 缓存） */
let deviceTokenCache = { at: 0, value: "" };
function readDeviceTokenFile() {
  if (deviceTokenCache.at && Date.now() - deviceTokenCache.at < 5 * 60000) return deviceTokenCache.value;
  try {
    const raw = require("node:fs").readFileSync(require("node:path").join(store.proxyDir(), "device_token.txt"), "utf8");
    deviceTokenCache.value = String(raw).trim().slice(0, 1024);
  } catch {
    deviceTokenCache.value = "";
  }
  deviceTokenCache.at = Date.now();
  return deviceTokenCache.value;
}

function makeWorkBuddy(channelId) {
  return {
    id: channelId,

    cfg() {
      return rules.get("headers.json")[channelId];
    },

    models() {
      const catalog = [...catalogMap(channelId).values()].map((m) => String(m.id));
      const legacy = (rules.get("wb_models.json") || {})[channelId];
      return unionIds(catalog, Array.isArray(legacy) ? legacy : []);
    },

    /** 拉取官方模型目录：v3/config 主路（三段式 CLI UA 否则 400 code 12403；含倍率 credits/能力/上下文）
     *  + console models 备路，两路结果按 id 合并、v3 权威；非对话模型（nes-/completion-/maxOutput≤256/文生图）剔除 */
    async fetchModels(account, secrets) {
      const c = this.cfg();
      const baseHeaders = this.headers(account, secrets);
      const parseRate = (v) => {
        const m = /([0-9]+(?:\.[0-9]+)?)/.exec(String(v ?? ""));
        return m ? Number(m[1]) : null;
      };
      const shape = (it) => {
        if (!it || typeof it !== "object") return null;
        const id = it.id || it.model || it.name;
        if (typeof id !== "string" || !id) return null;
        if (/^(nes-|completion-|codewise-)/i.test(id)) return null;
        const tags = Array.isArray(it.tags) ? it.tags.map(String) : [];
        const maxOut = Number(it.maxOutputTokens ?? it.max_output_tokens) || 0;
        if (maxOut && maxOut <= 256) return null;
        if (tags.some((t) => /text-to-image|image-gen|embedding/i.test(t))) return null;
        return {
          id,
          name: String(it.name || it.display_name || id),
          rate: parseRate(it.credits),
          capabilities: {
            images: !!(it.supportsImages ?? it.supports_images),
            reasoning: !!(it.supportsReasoning ?? it.supports_reasoning),
            tools: !!(it.supportsToolCall ?? it.supports_tool_call),
          },
          // reasoning 元数据（参考项目 effort 降级原料）：supportedEfforts/defaultEffort 必须随目录落盘，
          // 否则 deepseek 系 reasoning_effort 档位无法按模型收敛，只认 high 的模型请求 low 会 400
          reasoning: it.reasoning && typeof it.reasoning === "object"
            ? {
                effort: it.reasoning.effort ?? null,
                defaultEffort: String(it.reasoning.defaultEffort ?? it.reasoning.default_effort ?? ""),
                supportedEfforts: Array.isArray(it.reasoning.supportedEfforts ?? it.reasoning.supported_efforts)
                  ? (it.reasoning.supportedEfforts ?? it.reasoning.supported_efforts).map(String)
                  : [],
              }
            : null,
          contextLength: Number(it.maxInputTokens ?? it.max_input_tokens ?? it.context_length) || 0,
          maxOutputTokens: maxOut,
        };
      };
      const merged = new Map();
      const ingest = (data, authoritative) => {
        const list = findList(data, "models", 0);
        if (!Array.isArray(list)) return;
        for (const raw of list) {
          const m = shape(raw);
          if (!m) continue;
          const key = m.id.toLowerCase();
          if (!merged.has(key) || authoritative) merged.set(key, m);
        }
      };
      const [alt, v3] = await Promise.all([
        httpJson(c.modelsUrl, { method: "GET", headers: baseHeaders })
          .catch(() => ({ ok: false, status: 0 })),
        httpJson(c.modelsV3Url, {
          method: "GET",
          headers: { ...baseHeaders, "user-agent": c.catalogUA || baseHeaders["user-agent"], "x-codebuddy-request": "1" },
        }).catch(() => ({ ok: false, status: 0 })),
      ]);
      if (alt.ok && alt.data) ingest(alt.data, false); // 备路先入
      if (v3.ok && v3.data) ingest(v3.data, true); // 主路权威覆盖
      const models = [...merged.values()];
      if (!models.length) {
        return { ok: false, message: `目录拉取失败（v3 HTTP ${v3.status || 0} / console HTTP ${alt.status || 0}）` };
      }
      return { ok: true, models };
    },

    /** chat 出站头组：逐字段对齐官方 WorkBuddy 桌面端（参考项目逆向实证）。
     *  渠道白名单校验（400 code 11128 "unapproved channel"）按这套指纹认客户端：
     *  ① 三段式 UA（WorkBuddy/ver 平台/ver CLI/ver，AI 版平台段必须 WorkBuddy AI 否则 11140）；
     *  ② X-CodeBuddy-Request: 1 风控闸门头全请求必带；
     *  ③ 用量归属头组 X-Agent-Purpose/X-IDE-Name/Type/Version/X-Product（官方 banner 白名单同形，
     *     旧版 x-product=SaaS 就是"网关特征"，11128 的直接诱因）；
     *  ④ X-Machine-ID/X-Session-ID 按 uid 稳定派生（每账号一台固定虚拟设备）；
     *  ⑤ Origin/Referer 按域名（CN=codebuddy.cn，AI=workbuddy.ai）；
     *  ⑥ 缺省字段 X-No-* 占位（X-Domain 有值才发、无值改发 X-No-Department-Info，二者不并存）。
     *  红线：chat 请求绝不携带 X-Refresh-Token（仅允许出现在刷新端点） */
    headers(account, secrets) {
      const c = this.cfg();
      const origin = c.origin || (channelId === "workbuddy_ai" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn");
      const ideName = c.ideName || "WorkBuddy";
      const h = {
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
        "accept-language": channelId === "workbuddy_ai" ? "en-US" : "zh-CN",
        "user-agent": c.userAgent,
        "origin": origin,
        "referer": origin + "/",
        "x-requested-with": "XMLHttpRequest",
        "x-codebuddy-request": "1",
        "authorization": `Bearer ${secrets.token}`,
        // 用量归属头组：伪造官方桌面端，缺了就是上游用量统计里的「网关特征」
        "x-agent-purpose": "conversation",
        "x-ide-name": ideName,
        "x-ide-type": ideName,
        "x-ide-version": c.clientVersion || "5.5.4",
        "x-product": ideName,
      };
      // 设备风控头（参考项目：auth 每号 > config 全局 > 文件兜底），空则不注入
      const devToken = (account && account.deviceToken) || c.deviceToken || readDeviceTokenFile();
      if (account && account.uid) {
        h["x-user-id"] = account.uid;
        // 每账号一台固定虚拟设备：跨重启稳定、账号间互异（防设备指纹缺失/漂移关联风控）
        const stable = (purpose) => crypto.createHash("sha256").update(`agenthub:${purpose}:${account.uid}`).digest("hex").slice(0, 36);
        h["x-machine-id"] = stable("machine");
        h["x-session-id"] = stable("session");
      } else {
        h["x-no-user-id"] = "1";
      }
      if (devToken) h["x-device-token"] = devToken;
      if (channelId === "workbuddy_ai") {
        // 国际版个人号无企业 ID：显式声明 + 国际版域（对齐官方国际客户端形态）
        h["x-no-enterprise-id"] = "1";
        h["x-domain"] = "www.workbuddy.ai";
      } else {
        const ent = account.enterpriseId || "";
        if (ent) h["x-enterprise-id"] = ent;
        else h["x-no-enterprise-id"] = "1";
        const domain = account.domain || "";
        if (domain) h["x-domain"] = domain;
        else h["x-no-department-info"] = "1";
      }
      return h;
    },

    /** billing 域请求头（余额/签到/上报）：官方白名单头组 = 单段 UA WorkBuddy/<ver> + X-CodeBuddy-Request。
     *  UA 不能用三段式（官方计费/banner 接口显式覆写为单段形态，多带 CLI 段反而不像） */
    billingHeaders(account, secrets) {
      const c = this.cfg();
      const h = {
        "content-type": "application/json",
        "accept": "application/json",
        "accept-language": channelId === "workbuddy_ai" ? "en-US" : "zh-CN",
        "user-agent": c.billingUA || `WorkBuddy/${c.clientVersion || "5.5.4"}`,
        "x-codebuddy-request": "1",
        "authorization": `Bearer ${secrets.token}`,
      };
      if (account.uid) h["x-user-id"] = account.uid;
      const ent = account.enterpriseId || "";
      if (ent) {
        h["x-enterprise-id"] = ent;
        h["x-tenant-id"] = ent;
      }
      const domain = account.domain || "";
      if (domain) h["x-domain"] = domain;
      const devToken = (account && account.deviceToken) || c.deviceToken || readDeviceTokenFile();
      if (devToken) h["x-device-token"] = devToken;
      return h;
    },

    /** OpenAI body → WB 改写（对齐参考项目 payload.go + sanitize.go + thinking.go + tool_pairing.go 全管线）。
     *  11128 的三类诱因都在这里拦截：role 白名单外的 developer、整句精确匹配的审核指纹、
     *  裸错误码数字（模板表 "11128"→"11-128"）与不成对的工具调用（上游对后续每条消息都 400） */
    rewriteBody(model, body, account) {
      const tpl = rules.get("wb_template_map.json") || {};
      const out = { ...body };
      out.model = model;
      out.stream = true; // WB 只支持 SSE，非流式本地聚合模拟（方案 §2.2）
      // 官方 CLI 流式必发：上游据此在末帧返回 usage
      if (!out.stream_options) out.stream_options = { include_usage: true };
      // max_completion_tokens → max_tokens 翻译（新版 OpenAI SDK/_codex_ 客户端发前者，上游不认）
      if (out.max_completion_tokens != null) {
        const mct = Number(out.max_completion_tokens);
        if (Number.isFinite(mct) && mct > 0 && out.max_tokens == null) out.max_tokens = mct;
        delete out.max_completion_tokens;
      }
      // tool_choice 归一（对象报 400 code 11101）：{type:function} → name；none→none；any/required→required；其余→auto
      if (out.tool_choice && typeof out.tool_choice === "object") {
        const tc = out.tool_choice;
        if (tc.function && tc.function.name) out.tool_choice = tc.function.name;
        else if (tc.type === "none") out.tool_choice = "none";
        else if (tc.type === "any" || tc.type === "required") out.tool_choice = "required";
        else out.tool_choice = "auto";
      }
      // reasoning_effort 的删除移到最后（thinking 注入/降级完成后再处理）
      const applyTpl = (s) => {
        let t = String(s);
        for (const [from, to] of Object.entries(tpl)) {
          if (from) t = t.split(from).join(to);
        }
        return t;
      };
      // 文本指纹清洗（对齐 sanitize.go）：模板表逐字替换 → header 键值段整段剥除 → cc_ 裸键值剥除 → 裸键名缩写
      const cleanText = (s) => {
        let t = applyTpl(s);
        t = t.replace(/x-anthropic-billing-header:[^;\n]*;?\s*/gi, "");
        t = t.replace(/\bcc_[a-z0-9_]+=[^;\n]*;?\s*/gi, "");
        t = t.replace(/x-anthropic-billing-header/gi, "x-anthropic-billing-hdr");
        return t;
      };
      // 孤儿 tool_call↔tool 配对清理（参考项目实证：不成对会让上游对之后每条消息都返 400）
      const rawMsgs = (Array.isArray(body.messages) ? body.messages : []).map((m) => ({ ...m }));
      // 工具结果组重排（参考项目 repackToolResultBlocks）：把插在 assistant.tool_calls 与 tool 结果
      // 之间的非 tool 消息挪到该组之后——Codex 类客户端会夹通知消息，不打散配对且语义顺序不变
      const repacked = [];
      let pendingAfterGroup = [];
      for (const m of rawMsgs) {
        if (m.role === "tool") { repacked.push(m); continue; }
        if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          if (pendingAfterGroup.length) { repacked.push(...pendingAfterGroup); pendingAfterGroup = []; }
          repacked.push(m);
          continue;
        }
        pendingAfterGroup.push(m);
      }
      if (pendingAfterGroup.length) repacked.push(...pendingAfterGroup);
      const validToolIds = new Set();
      for (const m of repacked) {
        if (m && m.role === "assistant" && Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) if (tc && tc.id) validToolIds.add(String(tc.id));
        }
      }
      const answeredIds = new Set();
      for (const m of repacked) {
        if (m && m.role === "tool" && m.tool_call_id) answeredIds.add(String(m.tool_call_id));
      }
      const merged = [];
      for (const m of repacked) {
        const msg = { ...m };
        // developer 角色归一（上游 role 白名单，命中即 400 code 11128）
        if (typeof msg.role === "string" && msg.role.trim().toLowerCase() === "developer") msg.role = "system";
        // 孤儿清理：无配对的 tool_calls / tool 结果整条剔除
        if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
          msg.tool_calls = msg.tool_calls.filter((tc) => tc && tc.id && answeredIds.has(String(tc.id)));
          if (!msg.tool_calls.length) delete msg.tool_calls;
        }
        if (msg.role === "tool" && !validToolIds.has(String(msg.tool_call_id || ""))) continue;
        // 指纹清洗：cc_* 键值 / x-anthropic-* 引用剥离
        for (const k of Object.keys(msg)) {
          if (/^cc_|^x-anthropic-/i.test(k)) delete msg[k];
        }
        if (typeof msg.content === "string") msg.content = cleanText(msg.content);
        else if (Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) =>
            part && part.type === "text" && typeof part.text === "string" ? { ...part, text: cleanText(part.text) } : part
          );
        }
        // reasoning_content（思维链回填）实测同样携带指纹，与 content 同等清洗
        if (typeof msg.reasoning_content === "string") msg.reasoning_content = cleanText(msg.reasoning_content);
        // tool_calls 的 arguments 套同一套文本清洗（JSON 字符串按文本洗，不做键剥离防破坏结构）
        if (Array.isArray(msg.tool_calls)) {
          msg.tool_calls = msg.tool_calls.map((tc) =>
            tc && tc.function && typeof tc.function.arguments === "string"
              ? { ...tc, function: { ...tc.function, arguments: cleanText(tc.function.arguments) } }
              : tc
          );
        }
        // 连续同角色自动合并（role:tool 例外，tool_call_id 必须逐条保留）。
        // array↔array 直接拼接保多模态 part（压扁成文本会丢 image_url），string↔string 用 \n\n；
        // string 与 array 混态不合并（同样为不丢 part）
        const prev = merged[merged.length - 1];
        if (prev && prev.role === msg.role && msg.role !== "tool" && !msg.tool_calls && !prev.tool_calls) {
          if (typeof prev.content === "string" && typeof msg.content === "string") {
            prev.content = [prev.content, msg.content].filter(Boolean).join("\n\n");
            continue;
          }
          if (Array.isArray(prev.content) && Array.isArray(msg.content)) {
            prev.content = prev.content.concat(msg.content);
            continue;
          }
        }
        merged.push(msg);
      }
      out.messages = merged;
      // console 域（国际版官方客户端路径）要求首条消息必须是 system，否则 400 code 11128
      // "first message is not system prompt"（参考项目 ensureConsoleSystem 实证，吸收 PR #45）
      if (channelId === "workbuddy_ai" && out.messages.length) {
        const firstRole = String(out.messages[0].role || "").trim().toLowerCase();
        if (firstRole !== "system") {
          out.messages.unshift({ role: "system", content: "You are a helpful assistant." });
        }
      }
      // 会话 id：客户端已传则保留；否则按前 3 条消息指纹稳定派生——同一会话多轮复用，
      // 结合 prompt_cache_key 使上游前缀缓存可命中（参考项目实证：命中后 credit≈0.02 vs 0.34）
      if (!out.conversation_id) out.conversation_id = util.stableConvId(body.messages) || util.uuid();
      // deepseek 思维链管线（参考项目 thinking.go）：注入 thinking 开关 → effort 按目录档位
      // 降级 → 多轮 reasoning_content 回填（缺失会 400）。显式空 reasoning_effort 最后删除
      const catEntry = catalogMap(channelId).get(String(model).toLowerCase());
      if (util.isDeepSeekModel(model)) {
        util.injectThinking(out, (catEntry && catEntry.reasoning && catEntry.reasoning.defaultEffort) || "");
        util.backfillReasoningContent(out);
      }
      util.normalizeReasoningEffort(out, catEntry && catEntry.reasoning);
      if (out.reasoning_effort != null && !out.reasoning_effort) delete out.reasoning_effort;
      // prompt_cache_key（参考项目 cache_key.go：账号段硬隔离，跨账号绝不碰撞——防命中错账号前缀缓存）
      if (!out.prompt_cache_key) {
        out.prompt_cache_key = util.promptCacheKey((account && account.uid) || "", String(out.conversation_id || ""));
      }
      return out;
    },

    /** 对话主流程：WB 上游已近似 OpenAI 形态，透传归一（方案 §6.3 SSE 转换 WB）。
     *  国际版优先走 /console/chat/completions（官方国际客户端现行路径），404/405 回退 /v2（参考项目实证）。
     *  meta = 轮内会话元数据（server 在换号循环外生成一次，重试/换号复用同值） */
    async chat({ account, secrets, model, body, emit, meta }) {
      const c = this.cfg();
      const payload = JSON.stringify(this.rewriteBody(model, body, account));
      const headers = { ...this.headers(account, secrets), ...wbConversationHeaders(body, meta) };
      const urls = [c.consoleChatUrl, c.chatUrl].filter(Boolean);
      let resp = null;
      let cancelTimer = () => {};
      let lastErr = null;
      for (const url of urls) {
        try {
          const r = await fetchStream(url, { method: "POST", headers, body: payload });
          resp = r.resp;
          cancelTimer = r.cancelTimer;
          break;
        } catch (e) {
          lastErr = e;
          // 仅 404/405（路径不存在）换下一候选，其余错误直接上抛分类
          if (!e || (e.status !== 404 && e.status !== 405)) throw e;
        }
      }
      if (!resp) throw lastErr || new Error("上游不可达");
      let settled = false;
      const result = { status: 200, planLimit: false };
      const seenToolIndex = new Set(); // 流式 tool_calls：每个 index 只在首片带 name（issue #82）
      try {
        await pumpSse(resp, (_event, raw) => {
          if (!settled) {
            settled = true;
            cancelTimer();
          }
          if (raw === "[DONE]") {
            emit({ type: "finish", reason: "" }); // 空 reason = 上游已收尾，沿用已记录的 finish_reason
            return;
          }
          const data = parseJson(raw);
          if (!data) return;
          // 402 积分耗尽（insufficient credits）以错误体形式出现；4008 = 模型级限流。
          // 必须置 result.planLimit：只 emit error 的话 server 侧换号分支认不到，
          // 该账号既不冷却也不换号，请求被记 200 成功，下次还会继续选中这个已耗尽的号
          if (data.error) {
            const codeNum = Number(data.error.code) || 0;
            const msgStr = String(data.error.message || "");
            const status = codeNum === 402 || /insufficient|credit|quota|balance/i.test(msgStr) ? 402 : codeNum === 4008 ? 429 : 502;
            if (status === 402) result.planLimit = true;
            emit({ type: "error", status, code: codeNum, message: msgStr || "insufficient credits" });
            return;
          }
          const choice = Array.isArray(data.choices) && data.choices[0];
          if (choice) {
            if (choice.delta && Object.keys(choice.delta).length) {
              // 归一：剥空串噪声字段；tool_calls 每个 index 首片带 name、后续分片删 name 键
              // （键缺失比空串安全：覆盖型客户端 ?? 对空串会误清工具名，累加型会拼成 name×帧数）
              const d = { ...choice.delta };
              if (d.content === "") delete d.content;
              if (d.reasoning_content === "") delete d.reasoning_content;
              if (Array.isArray(d.tool_calls)) {
                d.tool_calls = d.tool_calls.map((tc) => {
                  const idx = tc && tc.index != null ? Number(tc.index) : 0;
                  const key = String(idx);
                  if (tc && tc.function && seenToolIndex.has(key) && "name" in tc.function) {
                    const f = { ...tc.function };
                    delete f.name;
                    return { ...tc, function: f };
                  }
                  seenToolIndex.add(key);
                  return tc;
                });
              }
              if (Object.keys(d).length) emit({ type: "delta", delta: d });
            }
            if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
          }
          if (data.usage) {
            emit({
              type: "usage",
              usage: {
                prompt_tokens: Number(data.usage.prompt_tokens) || 0,
                completion_tokens: Number(data.usage.completion_tokens) || 0,
                total_tokens: Number(data.usage.total_tokens) || 0,
                ...util.openaiCacheTokens(data.usage),
                ...util.upstreamCredit(data.usage),
              },
            });
          }
        });
      } finally {
        cancelTimer();
      }
      return result;
    },

    /**
     * 额度查询：billing/meter 计费域。
     * 个人账号走 get-user-resource（p_tcaca，全部套餐包求和），企业成员的个人资源恒为空、
     * 必须走 get-enterprise-user-usage（空体 + X-Enterprise-Id 头，返回 limit_num/used_num）。
     * 计费域与对话域不同（CN 计费在 www.codebuddy.cn），主域失败时回退插件域
     */
    async queryCredits(account, secrets) {
      const c = this.cfg();
      const bases = [];
      for (const b of [c.billingBase, c.pluginBase]) {
        const s = String(b || "").replace(/\/+$/, "");
        if (s && !bases.includes(s)) bases.push(s);
      }
      const ent = account.enterpriseId || "";
      const path = ent ? "/billing/meter/get-enterprise-user-usage" : "/billing/meter/get-user-resource";
      // 请求体对齐参考项目实证（workbuddy2api / cockpit-tools 同款）：分页 + p_tcaca + 有效期区间；
      // 企业版官方客户端发空体 {}
      const now = new Date();
      const p2 = (n) => String(n).padStart(2, "0");
      const fmtTime = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
      const body = ent
        ? "{}"
        : JSON.stringify({
            PageNumber: 1,
            PageSize: 100,
            ProductCode: "p_tcaca",
            Status: [0, 3],
            PackageEndTimeRangeBegin: fmtTime(now),
            PackageEndTimeRangeEnd: fmtTime(new Date(now.getTime() + 365 * 101 * 86400000)),
          });
      let lastErr = "";
      for (const base of bases) {
        for (const p of [path, "/v2" + path]) {
          const r = await httpJson(`${base}${p}`, {
            method: "POST",
            headers: this.billingHeaders(account, secrets),
            body,
          }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
          if (r.status === 401) return { authError: true };
          if (!r.ok || !r.data) {
            lastErr = `HTTP ${r.status}`;
            continue;
          }
          const shaped = parseWbResource(r.data, !!ent);
          if (shaped) return shaped;
          lastErr = "上游未返回可用额度字段";
        }
      }
      throw new Error(`额度查询失败：${lastErr || "上游无可用响应"}`);
    },

    /** 计费域 JSON 请求：paths 候选依次尝试（非 v2 优先、/v2 兜底），401 先换 token 再试一次 */
    async billingCall(account, secrets, paths, body) {
      const c = this.cfg();
      const bases = [];
      for (const b of [c.billingBase, c.pluginBase]) {
        const s = String(b || "").replace(/\/+$/, "");
        if (s && !bases.includes(s)) bases.push(s);
      }
      let creds = secrets;
      for (let pass = 0; pass < 2; pass++) {
        for (const base of bases) {
          for (const p of paths) {
            const r = await httpJson(`${base}${p}`, {
              method: "POST",
              headers: this.billingHeaders(account, creds),
              body: body || "{}",
            }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
            if (r.status === 401 && pass === 0) break; // 换 token 后重来
            return r;
          }
        }
        // 401 走单飞刷新（与 server/credits 侧共享互斥，防并发轮换互相践踏）
        const rr = await refreshTokenLocked(this.id, account, creds).catch(() => ({ ok: false }));
        if (!rr.ok) return { ok: false, status: 401, data: null, message: rr.message };
        creds = { token: rr.token, refreshToken: rr.refreshToken };
      }
      return { ok: false, status: 0, data: null, message: "上游无可用响应" };
    },

    /**
     * 每日签到状态：checkin-activity-status（新）→ checkin-status（旧）逐路径降级。
     * 参考 cockpit-tools 实测：code===0 为成功；code!=0 为业务失败（如已签到/未开放）
     */
    async checkinStatus(account, secrets) {
      const r = await this.billingCall(account, secrets, [
        "/billing/meter/checkin-activity-status",
        "/v2/billing/meter/checkin-activity-status",
        "/billing/meter/checkin-status",
        "/v2/billing/meter/checkin-status",
      ], "{}");
      const d = (r.data && (r.data.data || r.data)) || null;
      const code = Number((r.data && r.data.code) ?? 0);
      if (!r.ok || !d || (code !== 0 && code !== 200)) {
        return {
          ok: false,
          unavailable: /已签到|already|未开启|未开放|已过期/i.test(String((r.data && (r.data.message || r.data.msg)) || r.message || "")),
          message: String((r.data && (r.data.message || r.data.msg)) || r.message || `HTTP ${r.status}`),
        };
      }
      const b = (k1, k2) => {
        const v = d[k1] ?? d[k2];
        if (typeof v === "boolean") return v;
        if (typeof v === "number") return v !== 0;
        return false;
      };
      return {
        ok: true,
        active: b("active", "Active"),
        checkedIn: b("today_checked_in", "todayCheckedIn"),
        streakDays: Number(d.streak_days ?? d.streakDays ?? 0) || 0,
        dailyCredit: Number(d.daily_credit ?? d.dailyCredit ?? 0) || 0,
        todayCredit: Number(d.today_credit ?? d.todayCredit ?? 0) || 0,
        checkinDates: Array.isArray(d.checkin_dates ?? d.checkinDates) ? (d.checkin_dates ?? d.checkinDates).map(String) : [],
        weekProgress: Array.isArray(d.week_progress) ? d.week_progress.map(Boolean) : [],
      };
    },

    /** 每日签到领取：daily-checkin（code!=0 且幂等码/「已签到」文案 → already，不算失败） */
    async checkin(account, secrets) {
      const r = await this.billingCall(account, secrets, [
        "/billing/meter/daily-checkin",
        "/v2/billing/meter/daily-checkin",
      ], "{}");
      const code = Number((r.data && r.data.code) ?? 0);
      const msg = String((r.data && (r.data.message || r.data.msg)) || r.message || "");
      const d = (r.data && (r.data.data || r.data)) || null;
      if (r.ok && (code === 0 || code === 200)) {
        return {
          ok: true,
          success: d && d.success != null ? !!d.success : true,
          message: (d && d.message) || "签到成功",
          credit: Number((d && (d.credit ?? d.today_credit ?? d.todayCredit)) ?? 0) || 0,
          streakDays: Number((d && (d.streak_days ?? d.streakDays)) ?? 0) || 0,
          reward: (d && d.reward) || null,
        };
      }
      const already = /\b(10001|14001)\b/.test(msg) || /已签到|今日已签到|already/i.test(msg);
      return { ok: already, already, message: msg || `签到失败 HTTP ${r.status}` };
    },

    /** 国际版一次性 trial 加油包（CN 无此端点）：幂等码 14051 = 已领过 */
    async trial(account, secrets) {
      const r = await this.billingCall(account, secrets, ["/billing/ide/trial", "/v2/billing/ide/trial"], "{}");
      const code = Number((r.data && r.data.code) ?? 0);
      const msg = String((r.data && (r.data.message || r.data.msg)) || r.message || "");
      if (r.ok && (code === 0 || code === 200)) return { ok: true, claimed: true, message: msg || "加油包领取成功" };
      if (/\b14051\b/.test(msg) || /已领取|已领过|already/i.test(msg)) return { ok: true, claimed: false, already: true, message: msg || "已领取过" };
      return { ok: false, message: msg || `领取失败 HTTP ${r.status}` };
    },

    /** Token 刷新：X-Refresh-Token 头 + 空体 {}（该头只允许出现在此端点）。
     *  头组对齐参考项目 RefreshHeaders：CommonHeaders 完整形态（origin/referer/风控闸门/机器指纹）
     *  + refresh 专属头；X-Auth-Refresh-Source 走 rules 配置（workbuddy2api="plugin"、TWA="workbuddy"） */
    async refreshToken(account, secrets) {
      const c = this.cfg();
      if (!secrets.refreshToken) return { ok: false, message: "无 refreshToken，请重新登录或从本机导入" };
      const bases = [];
      for (const b of [c.billingBase, c.pluginBase]) {
        const s = String(b || "").replace(/\/+$/, "");
        if (s && !bases.includes(s)) bases.push(s);
      }
      const origin = c.origin || (channelId === "workbuddy_ai" ? "https://www.workbuddy.ai" : "https://www.codebuddy.cn");
      const headers = {
        "content-type": "application/json",
        accept: "application/json",
        origin,
        referer: origin + "/",
        "user-agent": c.userAgent,
        "x-requested-with": "XMLHttpRequest",
        "x-codebuddy-request": "1",
        "accept-language": channelId === "workbuddy_ai" ? "en-US" : "zh-CN",
        "x-refresh-token": secrets.refreshToken,
        "x-auth-refresh-source": c.refreshSource || "plugin",
      };
      if (account && account.uid) {
        const stable = (purpose) => crypto.createHash("sha256").update(`agenthub:${purpose}:${account.uid}`).digest("hex").slice(0, 36);
        headers["x-machine-id"] = stable("machine");
        headers["x-session-id"] = stable("session");
      }
      if (account && account.enterpriseId) headers["x-enterprise-id"] = account.enterpriseId;
      let lastErr = "";
      for (const base of bases) {
        const r = await httpJson(`${base}/v2/plugin/auth/token/refresh`, {
          method: "POST",
          headers,
          body: "{}",
        }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
        const d = r.data && (r.data.data || r.data);
        if (r.ok && d && (d.accessToken || d.access_token)) {
          return {
            ok: true,
            token: String(d.accessToken || d.access_token),
            refreshToken: d.refreshToken || d.refresh_token ? String(d.refreshToken || d.refresh_token) : secrets.refreshToken,
          };
        }
        lastErr = (r.data && (r.data.message || r.data.msg)) || r.message || `刷新失败 HTTP ${r.status}`;
      }
      return { ok: false, message: lastErr };
    },
  };
}

const workbuddy = makeWorkBuddy("workbuddy");
const workbuddy_ai = makeWorkBuddy("workbuddy_ai");

// ===== 商汤小浣熊（Raccoon AI 桌面端，渠道 id: raccoon） =====
// 协议事实基线见 docs/raccoon-反代/会话1~5（静态逆向，asar 解包 + PyInstaller 反汇编）。
// 防伪强度低：无请求签名/HMAC/证书 pinning/混淆。鉴权 = JWT Bearer + x-client-* 六头 + 受信设备绑定。
// 关键结论：
//   · 上行 LLM 是纯 OpenAI Chat Completions（上游疑似 LiteLLM 网关），1:1 透传即可；
//   · SenseNova 方言（XML 伪 tool_calls/reasoning_content）是客户端后处理，反代无需实现；
//   · 纯对话/积分调用不触发受信设备绑定（X-Client-Device-ID 大写头只出现在 bind/heartbeat），
//     LLM 只带小写 x-client-device-id（遥测性质）；号池每号独立指纹即可；
//   · 积分/配额查询全在渲染层（/points/v1、/office/v3/setting_info），主进程/box-agent 不参与。
// 指纹注入：x-client-* 六头按号隔离（会话2 §6），deviceId 每号一个随机 UUID 入池固定。

/** raccoon 账号级稳定指纹：复用 store.meta 里的画像，缺省时按 uid/id 派生随机 UUID 兜底（不编码序号/日期防风控识别） */
function raccoonIdentity(account) {
  const meta = (account && account.meta) || {};
  const seed = crypto.createHash("sha256").update(`agenthub:raccoon:${(account && (account.uid || account.id)) || "anon"}`).digest("hex");
  // 由 hash 派生一个合法 UUID v4 形态（8-4-4-4-12），账号内稳定、账号间互异
  const uuid = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}`;
  return {
    deviceId: meta.deviceId || uuid,
    deviceName: meta.deviceName || "DESKTOP-" + seed.slice(0, 7).toUpperCase().replace(/[^A-Z0-9]/g, "X"),
    osVersion: meta.osVersion || "10.0.26200",
    platform: meta.clientPlatform || "desktop-windows-x64",
    platformNoArch: String(meta.clientPlatform || "desktop-windows-x64").replace(/-(x64|arm64)$/i, ""),
    officeIdentity: String(meta.officeIdentity || "").trim(),
  };
}

/** LLM 请求头（box-agent 链路）：六头 + 会话关联头 + Bearer。仅 x-client-* 给官方域用 */
function raccoonChatHeaders(c, account, secrets, sessionId, turnId, title) {
  const idn = raccoonIdentity(account);
  const h = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${secrets.token}`,
    "x-client-name": c.clientName,
    "x-client-platform": idn.platform,
    "x-client-version": c.clientVersion,
    "x-client-os-version": idn.osVersion,
    "x-client-channel": c.clientChannel,
    "x-client-device-id": idn.deviceId,
    // 会话级关联头：request 内同 id（重试/换号复用），跨 request 不复用（会话2 §1.4）
    "X-RACCOON-Session-ID": sessionId,
    "X-RACCOON-Turn-ID": turnId,
    // 官方客户端取首条用户消息前 20 字符作标题；空串是异常信号（风控识别点）
    "X-RACCOON-Title": title || "",
    "X-RACCOON-Call-Kind": "chat",
  };
  // 团队版才带组织码（个人版 office_identity="personal"，不带）
  if (idn.officeIdentity && idn.officeIdentity !== "personal") h["X-Org-Code"] = idn.officeIdentity;
  return h;
}

/** 浏览器域请求头（积分/配额/账号类）：渲染层 fetchWithAuth 形态（X-Client-* 大写、不带架构、版本带 v） */
function raccoonWebHeaders(c, account, secrets) {
  const idn = raccoonIdentity(account);
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${secrets.token}`,
    "X-Client-Platform": idn.platformNoArch,
    "X-Client-Version": c.webClientVersion || "v1.0.35",
    "X-Client-Device-ID": idn.deviceId,
  };
  if (idn.officeIdentity && idn.officeIdentity !== "personal") h["X-Org-Code"] = idn.officeIdentity;
  return h;
}

/** 刷新端点专用头（会话1 §1.3：只凭 refresh_token，不带旧 access）。
 *  不复用 raccoonWebHeaders 再 delete authorization——那种写法依赖键名恰好小写，一旦头名风格
 *  变化 delete 会静默失效，把已过期的 access 一起发上去，服务端完全可能因此 401 */
function raccoonRefreshHeaders(c, account) {
  const idn = raccoonIdentity(account);
  const h = {
    "content-type": "application/json",
    accept: "application/json",
    "X-Client-Platform": idn.platformNoArch,
    "X-Client-Version": c.webClientVersion || "v1.0.35",
    "X-Client-Device-ID": idn.deviceId,
  };
  if (idn.officeIdentity && idn.officeIdentity !== "personal") h["X-Org-Code"] = idn.officeIdentity;
  return h;
}

const raccoon = {
  id: "raccoon",

  // 临期预刷新窗口（credits.cjs 用）：小浣熊 access 仅 3h（会话1 §2），若沿用默认 24h，
  // 每轮额度刷新（含定时 30min 一轮）都会触发一次刷新——与桌面端抢同一个 refresh_token
  // 互相作废（掉登录根因）。贴官方 300s 惰性语义，把主动轮换压到接近到期才发生
  refreshWindowSec: 300,

  cfg() {
    return rules.get("headers.json").raccoon;
  },

  /** 模型别名归一：raccoon-chat / raccoon-chat-ml → 官方默认模型（会话3 §4.1） */
  mapModel(model) {
    const m = String(model || "");
    if (/^raccoon-chat(-ml)?$/i.test(m)) return this.cfg().defaultModel;
    return m;
  },

  models() {
    const catalog = [...catalogMap("raccoon").values()].map((m) => String(m.id));
    return unionIds(catalog, [this.cfg().defaultModel]);
  },

  /** 拉取官方模型目录：GET /model_catalog，返回 {default_model, models:[{name,...,params:{context_window,max_tokens},points_multiplier}]}
   *  access 仅 3h，401 时就地刷新一次再重试（chat/额度链路都有，目录拉取原来没有） */
  async fetchModels(account, secrets) {
    let r = await this.fetchModelsOnce(account, secrets);
    if (r.authError) {
      const rr = await refreshTokenLocked(this.id, account, secrets).catch(() => ({ ok: false }));
      if (rr.ok) {
        if (account && account.id) {
          store.updateAccount(account.id, { token: rr.token, refreshToken: rr.refreshToken, status: "online", coolUntil: 0, coolReason: "" });
        }
        r = await this.fetchModelsOnce(account, { token: rr.token, refreshToken: rr.refreshToken });
      }
    }
    if (r.authError) return { ok: false, message: "账号登录态失效（401），请重新登录" };
    return r;
  },

  async fetchModelsOnce(account, secrets) {
    const c = this.cfg();
    const headers = raccoonWebHeaders(c, account, secrets);
    const r = await httpJson(c.modelsUrl, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401) return { ok: false, authError: true, message: "登录态已过期（HTTP 401）" };
    const list = findList(r.data, "models", 0);
    if (!r.ok || !Array.isArray(list) || !list.length) {
      return { ok: false, message: `目录拉取失败（HTTP ${r.status || 0}）${r.message ? " " + r.message : ""}` };
    }
    const models = [];
    for (const raw of list) {
      const id = raw && (raw.name || raw.id || raw.model);
      if (typeof id !== "string" || !id || raw.visible === false) continue;
      const params = (raw && raw.params) || {};
      models.push({
        id,
        name: String(raw.display_name || raw.description || raw.name || id),
        rate: Number(raw.points_multiplier ?? raw.billing_effective_multiplier ?? raw.billing_multiplier) || null,
        capabilities: {
          images: (Array.isArray(raw.tags) ? raw.tags : []).some((t) => /image|vision/i.test(String(t))),
          reasoning: true,
          tools: true,
        },
        contextLength: Number(raw.context_window ?? params.context_window) || 0,
        maxOutputTokens: Number(raw.max_tokens ?? params.max_tokens) || 0,
      });
    }
    if (!models.length) return { ok: false, message: "目录为空或无可对话模型" };
    return { ok: true, models };
  },

  /** OpenAI body → raccoon 改写：模型别名归一 + 强制流式 usage；剥离 AgentHub 注入的内部字段，
   *  只留 OpenAI 标准字段（raccoon 上游疑似 LiteLLM，未知字段可能 400）；
   *  max_tokens 缺省时补 80000（官方 hosted 默认值，会话3 §1.3），客户端已发则尊重原值 */
  rewriteBody(model, body) {
    const out = { ...(body || {}) };
    out.model = this.mapModel(model);
    out.stream = true;
    if (!out.stream_options || typeof out.stream_options !== "object") out.stream_options = {};
    out.stream_options.include_usage = true;
    // 官方客户端恒发 max_tokens=80000（hosted）；上游对缺失该字段的复杂请求（带 tools/长 prompt）
    // 会静默丢弃不返回字节——表现为 10s 首字节超时，而极简测试连接能过
    if (!out.max_tokens && !out.max_completion_tokens) out.max_tokens = 80000;
    // max_completion_tokens → max_tokens 翻译（新版 OpenAI SDK 客户端发前者）
    if (out.max_completion_tokens != null) {
      const mct = Number(out.max_completion_tokens);
      if (Number.isFinite(mct) && mct > 0 && out.max_tokens == null) out.max_tokens = mct;
      delete out.max_completion_tokens;
    }
    // 内部/非标准字段（不发给上游；其他标准字段如 temperature/top_p/tools 原样透传）
    delete out.conversation_id;
    delete out.conversationId;
    delete out.prompt_cache_key;
    return out;
  },

  /** 对话主流程：纯 OpenAI 协议透传（会话3 §7）。usage 在末尾 usage chunk；错误体 /error 或 顶层 code */
  async chat({ account, secrets, model, body, emit, meta }) {
    const c = this.cfg();
    const payload = JSON.stringify(this.rewriteBody(model, body));
    // 会话头稳定性：同一会话内 X-RACCOON-Session-ID 必须恒定（官方客户端行为）。
    // 原来每请求随机生成，多轮对话时上游看到"新 session 却带完整历史"的逻辑矛盾，
    // 触发风控静默丢弃（真实请求 10s 超时而测试连接通过的根因）。
    // sessionId = sha256(账号uid + 消息指纹)，跨请求稳定；turnId = sessionId + 消息数（第几轮）
    const convKey = (meta && meta.conversationId) || util.stableConvId(body && body.messages) || "";
    const uid = String((account && account.uid) || "anon");
    let sessionId, turnId;
    if (convKey) {
      const seed = crypto.createHash("sha256").update(`raccoon:sess:${uid}:${convKey}`).digest("hex");
      sessionId = `${seed.slice(0, 8)}-${seed.slice(8, 12)}-4${seed.slice(13, 16)}-a${seed.slice(17, 20)}-${seed.slice(20, 32)}`;
      const turnN = Array.isArray(body && body.messages) ? body.messages.length : 1;
      const tSeed = crypto.createHash("sha256").update(`${seed}:turn:${turnN}`).digest("hex");
      turnId = `${tSeed.slice(0, 8)}-${tSeed.slice(8, 12)}-4${tSeed.slice(13, 16)}-a${tSeed.slice(17, 20)}-${tSeed.slice(20, 32)}`;
    } else {
      sessionId = util.uuid();
      turnId = util.uuid();
    }
    // 官方客户端标题：首条用户消息前 20 字符（认证与令牌会话 §3.3）
    let title = "";
    const msgs = Array.isArray(body && body.messages) ? body.messages : [];
    const firstUser = msgs.find((m) => m && m.role === "user" && typeof m.content === "string");
    if (firstUser) title = String(firstUser.content).replace(/\s+/g, " ").trim().slice(0, 20);
    const headers = raccoonChatHeaders(c, account, secrets, sessionId, turnId, title);
    const { resp, cancelTimer } = await fetchStream(c.chatUrl, { method: "POST", headers, body: payload });
    const result = { status: 200, planLimit: false };
    try {
      await pumpSse(resp, (_event, raw) => {
        if (raw === "[DONE]") { emit({ type: "finish", reason: "" }); return; }
        const data = parseJson(raw);
        if (!data) return;
        // 错误体：上游失败可能在流内返回 {error:{code,message}} 或 {code:1000007,...}（会话3 §6.1）
        const errObj = data.error || null;
        const codeNum = Number((errObj && errObj.code) ?? (data.choices ? 0 : data.code)) || 0;
        const msgStr = String((errObj && errObj.message) || data.message || "");
        if (errObj || (codeNum && codeNum !== 0 && codeNum !== 200)) {
          const isQuota = codeNum === 1000007 || /insufficient|credit|quota|balance|积分|余额|欠费/i.test(msgStr);
          const status = isQuota ? 402 : codeNum === 401 || codeNum === 200003 ? 401 : codeNum === 429 ? 429 : 502;
          if (isQuota) result.planLimit = true;
          emit({ type: "error", status, code: codeNum, message: msgStr || `上游错误 ${codeNum}` });
          return;
        }
        const choice = Array.isArray(data.choices) && data.choices[0];
        if (choice) {
          if (choice.delta && Object.keys(choice.delta).length) emit({ type: "delta", delta: choice.delta });
          if (choice.message && Object.keys(choice.message).length) emit({ type: "delta", delta: choice.message }); // 非流式兜底
          if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
        }
        if (data.usage) {
          emit({
            type: "usage",
            usage: {
              prompt_tokens: Number(data.usage.prompt_tokens ?? data.usage.input_tokens) || 0,
              completion_tokens: Number(data.usage.completion_tokens ?? data.usage.output_tokens) || 0,
              total_tokens: Number(data.usage.total_tokens) || 0,
              ...util.openaiCacheTokens(data.usage),
              ...util.upstreamCredit(data.usage),
            },
          });
        }
      });
    } finally {
      cancelTimer();
    }
    return result;
  },

  /** 积分余额：GET /points/v1/balance。返回 {available_points,...}，号池取 available_points 作余额。
   *  顶层 code 非 0/200 或 HTTP 401 → authError（会话4 §1：统一 {code,data} 信封） */
  async queryCredits(account, secrets) {
    const c = this.cfg();
    const headers = raccoonWebHeaders(c, account, secrets);
    const r = await httpJson(c.balanceUrl, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401) return { authError: true };
    const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
    if (code === 200003 || /authorization_verify_error/i.test(String((r.data && r.data.message) || ""))) return { authError: true };
    if (!r.ok || !r.data || (code !== 0 && code !== 200)) {
      throw new Error(`额度查询失败：HTTP ${r.status}${r.data && r.data.message ? " " + r.data.message : ""}${r.message ? " " + r.message : ""}`);
    }
    const d = r.data.data || r.data;
    const credits = Number(d.available_points ?? d.availablePoints) || 0;
    return { credits, raw: d };
  },

  /** 今日消耗积分：小浣熊对话响应不带 per-request 消耗，只能靠积分明细 /bills 反查。
   *  取 type=expense 明细（按时间倒序），累加「今日（本地日）」的消耗（points 负数取绝对值），
   *  翻到出现非今日记录即停。成功返回今日消耗（>=0）；失败/无端点返回 null（调用方据此保持
   *  未上报 -1，不造假）。注意明细有几分钟同步延迟，故为「近实时」而非精确到最后一条。 */
  async queryTodayCredits(account, secrets) {
    const c = this.cfg();
    if (!c.billsUrl) return null;
    const headers = raccoonWebHeaders(c, account, secrets);
    const now = new Date();
    const isToday = (iso) => {
      const t = new Date(iso);
      return t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate();
    };
    let sum = 0, offset = 0, cursor = "";
    for (let pages = 0; pages < 10; pages += 1) {
      const qs = new URLSearchParams({ "paging.limit": "50", type: "expense" });
      if (cursor) qs.set("cursor", cursor); else qs.set("paging.offset", String(offset));
      const r = await httpJson(`${c.billsUrl}?${qs.toString()}`, { method: "GET", headers }).catch(() => ({ ok: false, status: 0, data: null }));
      if (r.status === 401) return null; // 401 交由 refreshAccount 主链路刷新，这里不误判
      const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
      if (!r.ok || !r.data || (code !== 0 && code !== 200)) return null;
      const d = r.data.data || r.data;
      const items = Array.isArray(d.items) ? d.items : [];
      if (!items.length) break;
      let sawOlder = false;
      for (const it of items) {
        const ts = it.created_at || it.createdAt;
        if (ts && !isToday(ts)) { sawOlder = true; continue; }
        const p = Number(it.points);
        if (Number.isFinite(p) && p < 0) sum += -p;
      }
      if (sawOlder) break; // 倒序明细已翻到昨天：今日记录已全覆盖
      const nextCursor = d.next_cursor || (d.paging && d.paging.next_cursor) || "";
      const hasMore = d.has_more === true || (d.paging && (Number(d.paging.offset || 0) + items.length) < Number(d.paging.total || 0));
      if (nextCursor) cursor = String(nextCursor);
      else if (hasMore) offset += items.length;
      else break;
    }
    return Math.round(sum);
  },

  /** 签到状态：小浣熊无独立"签到状态"接口，每日积分随登录自动发放，标 unavailable 说明查询不适用 */
  async checkinStatus(account, secrets) {
    try {
      const r = await this.queryCredits(account, secrets);
      if (r.authError) return { ok: false, message: "凭证失效，请重新登录" };
      return { ok: true, unavailable: true, checkedIn: false, credits: r.credits, message: `小浣熊无独立签到查询，每日登录自动发放（当前积分 ${r.credits}）` };
    } catch (e) {
      return { ok: false, message: String((e && e.message) || e) };
    }
  },

  /** 每日签到 = 登录送积分：POST /login/points/grant（幂等，granted=true 才是本次新发放）。
   *  同时锁定当日积分 7 天（会话4 §7.5：当天登录延长） */
  async checkin(account, secrets) {
    const c = this.cfg();
    const headers = raccoonWebHeaders(c, account, secrets);
    const r = await httpJson(c.grantUrl, { method: "POST", headers, body: "{}" }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
    if (r.status === 401) return { ok: false, message: "凭证失效，请重新登录" };
    const code = Number((r.data && r.data.code) ?? (r.ok ? 0 : -1));
    if (!r.ok || !r.data || (code !== 0 && code !== 200)) {
      return { ok: false, message: (r.data && r.data.message) || r.message || `签到失败 HTTP ${r.status}` };
    }
    const granted = !!(r.data.data && r.data.data.granted);
    return { ok: true, already: !granted, claimed: granted, message: granted ? "已领取每日积分" : "今日已领取过" };
  },

  /** 加油包领取：raccoon 加油包为付费购买（无免费"领取"动作），不支持 → 返回不可用提示 */
  async trial() {
    return { ok: false, message: "小浣熊加油包为付费购买，无免费领取动作" };
  },

  /** Token 刷新：POST /auth/v1/refresh，body 仅 {refresh_token}（会话1 §1.3）。
   *  与桌面端共用 ~/.box-agent/config/auth.json：刷前以文件里的最新 refresh_token 为准
   *  （桌面端可能刚刷过并旋转，用号池快照里的旧值会吃 401 —— 掉登录根因），
   *  刷新成功后原子写回，让两边始终持同一份凭据；文件归属校验不过则绝不碰文件。
   *  旋转竞态兜底：401 可能是并发刷新已旋转 refresh——重读文件，值变了就用新值再试一次，
   *  仍 401 才判失效（方案文档 §2.3：/401 后重读文件再试一次） */
  async refreshToken(account, secrets) {
    const c = this.cfg();
    const uid = account && account.uid;
    const own0 = raccoonAuth.ownedTokens(uid, secrets && secrets.refreshToken);
    let refreshToken = (own0 && own0.refreshToken) || (secrets && secrets.refreshToken) || "";
    if (!refreshToken) return { ok: false, message: "无 refreshToken，请重新登录或粘贴" };
    let headers = raccoonRefreshHeaders(c, account);

    for (let attempt = 0; attempt < 2; attempt++) {
      const body = JSON.stringify({ refresh_token: refreshToken });
      const r = await httpJson(c.refreshUrl, { method: "POST", headers, body }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      const d = (r.data && (r.data.data || r.data)) || null;
      const token = d && (d.access_token || d.accessToken || d.token);
      if (r.ok && token) {
        // 服务端旋转 refresh 就覆盖，不返回则保留旧的（会话1 §1.3；协议支持旋转但不强制）
        const nextRefresh = d.refresh_token || d.refreshToken ? String(d.refresh_token || d.refreshToken) : refreshToken;
        // 回写共用文件（仅当文件确属本号）：桌面端下次刷新读到新值，不再拿旧 refresh 撞 401
        const own = raccoonAuth.ownedTokens(uid, nextRefresh);
        if (own) raccoonAuth.writeTokens({ accessToken: String(token), refreshToken: nextRefresh });
        return { ok: true, token: String(token), refreshToken: nextRefresh };
      }
      if (r.status === 401) {
        // 401 可能是桌面端并发刷新旋转了 refresh——重读文件，值变了就用新值再试一次
        const own = raccoonAuth.ownedTokens(uid, refreshToken);
        const latest = (own && own.refreshToken) || "";
        if (latest && latest !== refreshToken) {
          refreshToken = latest;
          continue; // 值变了，再试一次
        }
        return { ok: false, expired: true, message: "登录态已过期，请重新登录" };
      }
      return { ok: false, message: (d && (d.message || d.msg)) || r.message || `刷新失败 HTTP ${r.status}` };
    }
    return { ok: false, expired: true, message: "登录态已过期（重试后仍 401），请重新登录" };
  },

  /** 用户信息（导入后补全 uid/昵称）：GET /auth/v1/user_info（会话4 §6）。
   *  兼容单参 userInfo(token)（discovery 签名）与双参 userInfo(token, account)（OAuth 上下文） */
  async userInfo(token, account) {
    const c = this.cfg();
    const acc = account || {};
    const headers = raccoonWebHeaders(c, acc, { token });
    const r = await httpJson(c.userInfoUrl, { method: "GET", headers }).catch(() => ({ ok: false, status: 0, data: null }));
    const d = r.data && (r.data.data || r.data);
    if (r.ok && d) {
      return {
        uid: String(d.id || d.user_id || d.uid || ""),
        name: String(d.name || d.nickname || d.user_name || ""),
      };
    }
    // 接口不可用时本地解码兜底：小浣熊 JWT 顶层是 iss（账户 ID）/ sid，util.jwtDecode 读不出，
    // 必须用 raccoon 自己的口径（与 discovery.scanRaccoon 一致），否则 uid 恒空、号池去重失效
    return { uid: raccoonAuth.tokenUid(token), name: "" };
  },
};

// ===== Cline（cline-free / cline-pass 同账号两额度池，makeCline(pool) 参数化；协议参考 §1） =====
const CLINE_BASE = "https://api.cline.bot/api/v1"; // 只有单层 v1：拼成 /api/v1/v1/... 实测 404，别再补
const CLINE_HEADERS_BASE = {
  "content-type": "application/json",
  accept: "text/event-stream",
  "x-client-type": "cline-sdk", // 关键：缺它免费池全 403 "only available via Cline product surfaces"；cline-cli 走兼容路径回 500，禁用
  "user-agent": "Cline/3.0.62",
  "x-client-version": "3.0.62",
  "http-referer": "https://cline.bot",
  "x-title": "Cline",
};

/** cline 错误 → AgentHub 语义。403 刻意不当限额：ENTITLEMENT/API_REQUEST 是「账号×模型」
 *  维度的确定性拒绝，换号同样 403，冷却只会把确定失败变成静默跳过——透传让用户看到
 *  「该订阅/换模型」（协议参考 §1.6）。429→402 走既有「切号+planLimit」链路。 */
function clineErrorStatus(status, errObj) {
  if (status === 401) return 401;
  if (status === 429) return 402;
  if (status === 403 || status === 404) return status;
  return 502;
}

/** 远程目录归池：free 组归 free 池、clinePass 组归 pass 池；recommended 走 credit 计费不收、
 *  clineCloud 实测 403 不收（协议参考 §1.4）。归池看分组不看前缀——free 组混有裸名条目。 */
function pickClineModels(groups, pool) {
  const arr = (groups && (pool === "pass" ? groups.clinePass : groups.free)) || [];
  return arr.map((m) => String((m && m.id) || "")).filter(Boolean);
}

function makeCline(pool) {
  const channel = pool === "pass" ? "cline_pass" : "cline_free";
  return {
    id: channel,
    refreshWindowSec: 600, // accessToken 1h、临期 10min 主动刷（协议参考 §1.3；语义同 raccoon.refreshWindowSec）

    headers(secrets) {
      return { ...CLINE_HEADERS_BASE, authorization: `Bearer ${clineAuth.ensureTokenPrefix(secrets && secrets.token)}` };
    },

    // 目录 id 本身带池前缀（cline-free/xxx），两池天然不重名，mergedModels/modelOwners 零特判
    models() {
      return unionIds([...catalogMap(channel).values()].map((m) => String(m.id)), []);
    },
    modelEntries() { return [...catalogMap(channel).values()].map((m) => ({ client: String(m.id), upstream: String(m.id), entry: m })); },

    /** 拉取官方推荐目录（免鉴权 GET /ai/cline/recommended-models）：按响应分组归池，
     *  元数据（name/rate/能力/上下文）从静态目录回填，目录缺的条目用 id 兜底；
     *  拉取失败/空目录返回 ok:false（index.cjs 管道失败不写空，保留旧目录） */
    async fetchModels(account, secrets) {
      const r = await httpJson(`${CLINE_BASE}/ai/cline/recommended-models`, { method: "GET", headers: this.headers(secrets) })
        .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      if (!r.ok) return { ok: false, message: `目录拉取失败（HTTP ${r.status || 0}）${r.message ? " " + r.message : ""}` };
      const ids = pickClineModels(r.data || {}, pool);
      if (!ids.length) return { ok: false, message: "目录为空" };
      const cat = catalogMap(channel);
      const models = ids.map((id) => {
        const meta = cat.get(id.toLowerCase());
        return {
          id, name: String((meta && meta.name) || id), rate: (meta && meta.rate) ?? null,
          capabilities: (meta && meta.capabilities) || { images: false, reasoning: true, tools: true },
          contextLength: Number((meta && meta.contextLength) || 0), maxOutputTokens: Number((meta && meta.maxOutputTokens) || 0),
        };
      });
      return { ok: true, models };
    },

    /** 客户端名 → 上游名：带前缀原样（前缀是计费通道选择器，剥掉 404）；裸名补本池前缀 */
    upstreamFor(clientModel) {
      const s = String(clientModel || "");
      return s.startsWith("cline-free/") || s.startsWith("cline-pass/") ? s : `${pool === "pass" ? "cline-pass/" : "cline-free/"}${s}`;
    },

    rewriteBody(model, body) {
      const out = { ...(body || {}) };
      out.model = this.upstreamFor(model);
      out.stream = true;
      if (!out.stream_options || typeof out.stream_options !== "object") out.stream_options = {};
      out.stream_options.include_usage = true;
      delete out.conversation_id; delete out.conversationId; delete out.prompt_cache_key;
      return out; // 其余字段完全透传（协议参考 §1.4：上游是标准 OpenAI body）
    },

    async chat({ secrets, model, body, emit }) {
      const payload = JSON.stringify(this.rewriteBody(model, body));
      const { resp, cancelTimer } = await fetchStream(`${CLINE_BASE}/chat/completions`, { method: "POST", headers: this.headers(secrets), body: payload });
      const result = { status: 200, planLimit: false };
      try {
        // stream:true 恒回裸 chat.completion.chunk；上游错误可能以 {"error":"..."} 或 {"error":{...}} 出现（协议参考 §1.5）
        await pumpSse(resp, (_event, raw) => {
          if (raw === "[DONE]") { emit({ type: "finish", reason: "" }); return; }
          const data = parseJson(raw);
          if (!data) return;
          if (data.error) {
            const isObj = typeof data.error === "object" && data.error !== null;
            const status = clineErrorStatus(Number((isObj && data.error.status) || 0), data.error);
            if (status === 402) result.planLimit = true;
            const msg = isObj ? String(data.error.message || "上游错误") : String(data.error);
            emit({ type: "error", status: status || 502, code: 0, message: msg });
            return;
          }
          const choice = Array.isArray(data.choices) && data.choices[0];
          if (choice) {
            if (choice.delta && Object.keys(choice.delta).length) emit({ type: "delta", delta: choice.delta });
            if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
          }
          if (data.usage) {
            emit({ type: "usage", usage: {
              prompt_tokens: Number(data.usage.prompt_tokens) || 0,
              completion_tokens: Number(data.usage.completion_tokens) || 0,
              total_tokens: Number(data.usage.total_tokens) || 0,
              ...util.openaiCacheTokens(data.usage),
              ...util.upstreamCredit(data.usage),
            } });
          }
        });
      } finally { cancelTimer(); }
      return result;
    },

    /** 刷新（协议参考 §1.3）：grantType 是 camelCase（源实现 @cline/core 就发这个键名，别改 snake_case）。
     *  刷新前重读桌面端文件取最新 refresh_token（桌面端可能刚刷过并旋转）；成功不回写文件（防互相顶掉）。 */
    async refreshToken(account, secrets) {
      let rt = (secrets && secrets.refreshToken) || "";
      if (account && account.source === "scan") {
        const live = clineAuth.readClineDesktopAuth();
        if (live && live.refreshToken && (!account.uid || clineAuth.clineUid(live.token) === account.uid)) rt = live.refreshToken;
      }
      if (!rt) return { ok: false, message: "无 refreshToken，请重新登录或粘贴" };
      const r = await httpJson(`${CLINE_BASE}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ refreshToken: rt, grantType: "refresh_token" }),
      }).catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      if (r.status === 401 || r.status === 403) return { ok: false, expired: true, message: "登录态已过期，请重新登录" };
      const d = (r.data && (r.data.data || r.data)) || null;
      const token = d && d.accessToken;
      if (!r.ok || !token) {
        const msg = (r.data && r.data.error && (r.data.error.message || r.data.error)) || r.message || `刷新失败 HTTP ${r.status}`;
        return { ok: false, message: String(msg).slice(0, 200) };
      }
      // 响应的 accessToken 不带 workos: 前缀，统一补；refreshToken 缺失沿用旧值（协议参考 §1.3 三个实测口径）
      return { ok: true, token: clineAuth.ensureTokenPrefix(token), refreshToken: String(d.refreshToken || rt), expiresAt: clineAuth.clineExpiresAt(d.expiresAt, clineAuth.jwtClaims(token)) };
    },

    /** uid/昵称本地解码兜底（不依赖网络；余额/订阅查询 v1 不做，见 spec §九） */
    async userInfo(token) {
      const c = clineAuth.jwtClaims(token);
      return { uid: String(c.external_id || ""), name: clineAuth.clineDisplayName(c, c.email) };
    },
  };
}
const cline_free = makeCline("free");
const cline_pass = makeCline("pass");

// ===== AutoClaw（智谱，makeAutoClaw(region) 两地区参数化；协议参考 §2） =====
// 头集合两地逐字相同（参考 region.rs 实测），只换域名；账号 id 前缀 user- / intl-user-。
const AUTOCLAW_AUTH_APP_ID = "100003";
const AUTOCLAW_AUTH_APP_KEY = "38d2391985e2369a5fb8227d8e6cd5e5"; // 客户端内嵌指纹
const AUTOCLAW_REGIONS = {
  cn: {
    userapi: "https://autoglm-acceleration-api.zhipuai.cn",
    upstream: "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw",
    catalogUrl: "https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw-model-config", // 目录藏在 /proxy/ 一级，不是对话的 /proxy/autoclaw
    uidPrefix: "user-",
  },
  intl: {
    userapi: "https://autoglm-api.autoglm.ai",
    upstream: "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw",
    catalogUrl: "https://autoglm-api.autoglm.ai/autoclaw-proxy/proxy/autoclaw-model-config",
    uidPrefix: "intl-user-",
  },
};
// 静态路由表 = 实际客户端模型选择器当前仅有的两个（协议参考 §2.4；其余条目官方已下架）
const AUTOCLAW_MODELS = [
  { id: "glm-5.3", routeId: "zaicoding_glm-5.3", name: "GLM-5.3", contextLength: 1048576, maxOutputTokens: 307200, capabilities: { images: false, reasoning: true, tools: true } },
  { id: "glm-5.3-flash", routeId: "zai_glm-5.3-flash", name: "GLM-5.3-Flash", contextLength: 1048576, maxOutputTokens: 131072, capabilities: { images: true, reasoning: true, tools: true } },
];
const AUTOCLAW_DEFAULT_ROUTE = "zai_auto";
const AUTOCLAW_ROUTE_RE = /^[a-z][a-z0-9]*_[A-Za-z0-9._:-]{1,127}$/; // 合法路由 id 形态

/** X-Auth-Sign = MD5("{appId}&{秒级时间戳}&{appKey}") 小写 hex（X-Auth-TimeStamp 是秒，别用毫秒） */
function autoclawSign(ts) {
  return crypto.createHash("md5").update(`${AUTOCLAW_AUTH_APP_ID}&${ts}&${AUTOCLAW_AUTH_APP_KEY}`).digest("hex");
}

/** 模型 → 路由 id（协议参考 §2.4 解析顺序）：静态表 → 已带前缀透传 → 合法形态透传 → 兜底 zai_auto */
function autoclawResolveRoute(model) {
  const s = String(model || "").trim();
  const hit = AUTOCLAW_MODELS.find((m) => m.id.toLowerCase() === s.toLowerCase());
  if (hit) return hit.routeId;
  if (/^(zai_|zaicoding_)/i.test(s)) return s;
  if (AUTOCLAW_ROUTE_RE.test(s)) return s;
  return AUTOCLAW_DEFAULT_ROUTE;
}

function makeAutoClaw(region) {
  const cfg = AUTOCLAW_REGIONS[region];
  const channel = region === "intl" ? "autoclaw_intl" : "autoclaw";

  /** 桌面文件里的 token → 号池 uid 口径（地区前缀 + JWT user_id，与 userInfo / scanAutoClaw 同源）。
   *  解不出（不是 JWT / 缺 user_id）返回空串，调用方据此判「认不出身份」——宁可不采用文件值。 */
  function autoclawFileUid(token) {
    const c = util.jwtDecode(token).payload || {};
    const id = String(c.user_id || "");
    return id ? `${cfg.uidPrefix}${id}` : "";
  }

  return {
    id: channel,
    refreshWindowSec: 300, // 临期 5 分钟（对齐官方 DESKTOP_REFRESH_AHEAD_MS，协议参考 §2.3）

    _llmHeaders(token, routeId) {
      // LLM 域头（协议参考 §2.2 A，逐字）。铁律：认证头是 X-Authorization 不是 Authorization；
      // 2026-09-22 起 chat 路径禁发 X-Harness-Type: zcode（带上稳定 403 pay-view / 406 空体）
      return {
        "content-type": "application/json",
        accept: "*/*", // 不是 text/event-stream，照抄源实现
        "x-product": "autoclaw",
        "x-client-type": "pc",
        "x-tm": "win", // platformTm：darwin→mac / linux→linux / 其余 win
        "x-version": "1.17.8", // DESKTOP_APP_VERSION，进兼容路径判定
        "x-lang": "zh-CN",
        "x-channel": "official",
        "x_trace_id": "autoclaw-desktop", // 下划线写法照抄源实现
        "x-authorization": `Bearer ${token}`,
        "x-request-id": util.uuid(),
        "x-request-model": routeId,
      };
    },

    _userapiHeaders(token) {
      // userapi 域头（协议参考 §2.2 B）：保留 X-Harness-Type + 签名头族；authorization 小写、token 空则整条不发
      const ts = Math.floor(Date.now() / 1000);
      const h = {
        "content-type": "application/json",
        accept: "*/*",
        "x-product": "autoclaw",
        "x-client-type": "pc",
        "x-harness-type": "zcode",
        "x-tm": "win",
        "x-lang": "zh-CN",
        "x-channel": "official",
        "x-auth-appid": AUTOCLAW_AUTH_APP_ID,
        "x-auth-timestamp": String(ts),
        "x-auth-sign": autoclawSign(ts),
        "x-trace-id": util.uuid(),
      };
      if (token) h["authorization"] = `Bearer ${token}`;
      return h;
    },

    models() { return AUTOCLAW_MODELS.map((m) => m.id); },
    modelEntries() { return AUTOCLAW_MODELS.map((m) => ({ client: m.id, upstream: m.id, entry: m })); },
    upstreamFor(model) { return autoclawResolveRoute(String(model || "").trim()); },

    rewriteBody(model, body) {
      const out = { ...(body || {}) };
      const routeId = autoclawResolveRoute(model);
      const dirHit = AUTOCLAW_MODELS.find((m) => m.routeId === routeId);
      out.model = dirHit ? dirHit.id : String(model || AUTOCLAW_DEFAULT_ROUTE); // body.model = 剥前缀后的模型 id
      out.stream = true;
      if (!out.stream_options || typeof out.stream_options !== "object") out.stream_options = {};
      out.stream_options.include_usage = true;
      delete out.conversation_id; delete out.conversationId; delete out.prompt_cache_key;
      // normalizeSystemPrompt 是**就地**改写（改 m.content、往 messages 头部 unshift），而 out 只是
      // body 的浅拷——messages 数组和每条消息对象都还与调用方共享。server.cjs 的模型回退 + 换号循环
      // 复用同一个 body，autoclaw 失败后落到 cline/qoder/trae 时，客户端正文里已经被人塞进 OpenClaw
      // 身份前缀、外来身份句也已被改写，入站 token 估算同样吃这份脏正文。故归一前先把 messages 拷一层。
      // 只拷到「消息对象 + content 为数组时的 part 对象」这一层：数组元素里没有更深的可变结构，
      // 图片 base64 是字符串（值语义），不必递归。
      if (Array.isArray(out.messages)) {
        out.messages = out.messages.map((m) => {
          if (!m || typeof m !== "object") return m;
          if (!Array.isArray(m.content)) return { ...m };
          return { ...m, content: m.content.map((p) => (p && typeof p === "object" ? { ...p } : p)) };
        });
      }
      acPrompt.normalizeSystemPrompt(out); // 2026-09-22 白名单闸门（幂等）
      out._routeId = routeId; // chat 组装时取走放进 X-Request-Model，序列化前 delete
      return out;
    },

    async chat({ secrets, model, body, emit }) {
      const prepared = this.rewriteBody(model, body);
      const routeId = prepared._routeId || AUTOCLAW_DEFAULT_ROUTE;
      delete prepared._routeId;
      const payload = JSON.stringify(prepared);
      const headers = this._llmHeaders((secrets && secrets.token) || "", routeId);
      const { resp, cancelTimer } = await fetchStream(`${cfg.upstream}/chat/completions`, { method: "POST", headers, body: payload });
      const result = { status: 200, planLimit: false };
      try {
        await pumpSse(resp, (_event, raw) => {
          if (raw === "[DONE]") { emit({ type: "finish", reason: "" }); return; }
          const data = parseJson(raw);
          if (!data) return;
          const errObj = data.error || null;
          if (errObj) {
            // 401→401 刷新；429→402；其余先过内容拦截三文案再 Fatal 透传（协议参考 §2.6）
            const msg = String(errObj.message || errObj);
            const blocked = /blocked by security policy|unapproved channel|illegal api invocation/i.test(msg);
            const status = Number((errObj && errObj.status) || 0);
            const s = status === 401 ? 401 : status === 429 ? 402 : blocked ? 502 : (status || 502);
            if (s === 402) result.planLimit = true;
            emit({ type: "error", status: s, code: Number(errObj.code) || 0, message: msg.slice(0, 300) });
            return;
          }
          const choice = Array.isArray(data.choices) && data.choices[0];
          if (choice) {
            if (choice.delta && Object.keys(choice.delta).length) emit({ type: "delta", delta: choice.delta });
            if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
          }
          if (data.usage) {
            emit({ type: "usage", usage: {
              prompt_tokens: Number(data.usage.prompt_tokens) || 0,
              completion_tokens: Number(data.usage.completion_tokens) || 0,
              total_tokens: Number(data.usage.total_tokens) || 0,
              ...util.openaiCacheTokens(data.usage),
              ...util.upstreamCredit(data.usage),
            } });
          }
        });
      } finally { cancelTimer(); }
      return result;
    },

    /** 刷新（协议参考 §2.3）：POST {userapi}/userapi/v1/refresh；code 400002 降级 /agent-refresh；
     *  410000/401 → 401。deviceId：meta.device_id 优先，缺省回落 JWT device_id 声明。
     *  桌面导入（source=scan）：刷新前重读 auth.json（桌面端重登自动跟上）；成功只更号池行，不回写文件。 */
    async refreshToken(account, secrets) {
      let rt = (secrets && secrets.refreshToken) || "";
      let deviceId = String((account && account.meta && account.meta.device_id) || "");
      if (!deviceId && secrets && secrets.token) {
        // util.jwtDecode 返回 {token,uid,exp,payload}，声明在 payload（简报写 .device_id 直取是笔误，按真实接口修正）
        const claims = util.jwtDecode(secrets.token).payload || {};
        deviceId = String(claims.device_id || "");
      }
      if (account && account.source === "scan") {
        try {
          const live = acCred.readAutoClawAuth();
          // 身份比对（cline 的 refreshToken 同款，见上方 makeCline）：桌面端换账号登录后 auth.json 里
          // 是**新账号**的凭据，无条件采用就会拿新账号的 refresh_token 去刷新旧账号那一行——
          // 上游不报 401，直接把新账号的额度刷进旧行，号池从此错位。认不出身份（uid 解不出/不一致）
          // 就整份文件值都不采用，继续用号池快照。
          const sameIdentity = !!live && (!account.uid || autoclawFileUid(live.token) === String(account.uid));
          if (live && live.refreshToken && sameIdentity) rt = live.refreshToken;
          if (live && live.deviceId && !deviceId && sameIdentity) deviceId = live.deviceId;
        } catch { /* 文件读不了就用号池快照 */ }
      }
      if (!rt) return { ok: false, message: "无 refreshToken，请重新粘贴或导入" };
      const body = JSON.stringify({ refresh_token: rt, source_id: "autoclaw", ...(deviceId ? { device_id: deviceId } : {}) });
      let r = await httpJson(`${cfg.userapi}/userapi/v1/refresh`, { method: "POST", headers: this._userapiHeaders((secrets && secrets.token) || ""), body })
        .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      if (r.data && Number(r.data.code) === 400002) {
        r = await httpJson(`${cfg.userapi}/userapi/v1/agent-refresh`, { method: "POST", headers: this._userapiHeaders((secrets && secrets.token) || ""), body })
          .catch((e) => ({ ok: false, status: 0, data: null, message: String((e && e.message) || e) }));
      }
      const code = Number(r.data && r.data.code);
      if (code === 410000 || r.status === 401) return { ok: false, expired: true, message: "登录态已过期，请重新登录" };
      const d = r.data && r.data.data;
      const token = d && String(d.access_token || "").replace(/^Bearer\s+/i, "");
      if (!(code === 0 && token)) return { ok: false, message: (r.data && r.data.message) || r.message || `刷新失败 HTTP ${r.status}` };
      const exp = Number(util.jwtDecode(token).exp) || 0; // 过期按新 token JWT exp 重算（解不出保留 0）
      return { ok: true, token, refreshToken: String((d && d.refresh_token) || rt), expiresAt: exp > 0 ? exp * 1000 : 0 };
    },

    /** uid 用地区前缀 + JWT user_id（两地 userId 空间可能撞号，协议参考 §2.8） */
    async userInfo(token) {
      const c = util.jwtDecode(token).payload || {}; // 声明在 payload（util.jwtDecode 顶层只有 uid/exp）
      return { uid: `${cfg.uidPrefix}${String(c.user_id || "")}`, name: String(c.user_name || c.nickname || "AutoClaw 账号") };
    },
  };
}
const autoclaw = makeAutoClaw("cn");
const autoclaw_intl = makeAutoClaw("intl");

// ===== Qoder（阿里，国际/中国版单渠道按账号地区切换；协议参考 §3） =====
// 四组域名按 region 内置切换（地区不接受任意 URL）；模型目录/凭证两地区不通用。
const QODER_REGIONS = {
  global: { openApi: "https://openapi.qoder.sh", center: "https://center.qoder.sh", webOrigin: "https://qoder.com", gateway: "https://api3.qoder.sh/" },
  cn: { openApi: "https://openapi.qoder.com.cn", center: "https://gateway.qoder.com.cn", webOrigin: "https://qoder.com.cn", gateway: "https://gateway.qoder.com.cn/" },
};
const QODER_CHAT_PATH = "algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"; // gateway 基址带尾斜杠
const QODER_MODEL_LIST_PATH = "algo/api/v2/model/list?Encode=1";
const QODER_REFRESH_PATH = "/algo/api/v3/user/refresh_token"; // center 域
const QODER_USERINFO_PATH = "/api/v1/userinfo"; // open_api 域
// 兜底清单（协议参考 §3.8；upstreamKey/reasoning/efforts/vision/倍率快照 2026-09-20 实测；global 17 / cn 10）
const QODER_FALLBACK = {
  global: [
    ["Qwen3.8-Flash", "qfmodel", true, ["low", "medium", "xhigh"], true, "0.1"],
    ["Qwen3.8-Max", "qmodel_38max", true, ["low", "medium", "xhigh"], true, "0.5"],
    ["Auto", "auto", false, [], true, "1"],
    ["Ultimate", "ultimate", true, [], true, "1.6"],
    ["Performance", "performance", true, [], true, "1.1"],
    ["Efficient", "efficient", false, [], true, "0.3"],
    ["Sonus", "smodel", true, [], true, "3.2"],
    ["Cantus", "cmodel", true, [], true, "3.2"],
    ["Qwen3.7-Max", "qmodel_latest", true, [], true, "0.5"],
    ["Qwen3.7-Plus", "qmodel", false, [], true, "0.1"],
    ["Kimi-K3", "kmodel_latest", false, [], true, "0.8"],
    ["Kimi-K2.8-Preview", "kmodel", false, [], true, "0.3"],
    ["GLM-5.3", "gmodel", true, [], true, "0.6"],
    ["GLM-5.3-Flash", "gfmodel", true, [], true, "0.1"],
    ["DeepSeek-V4-Pro", "dmodel", true, [], true, "0.8"],
    ["DeepSeek-Flash", "dfmodel", true, [], true, "0.2"],
    ["MiniMax-M3", "mmodel", false, [], true, "0.2"],
  ],
  cn: [
    ["Qwen3.8-Flash", "qfmodel", true, ["low", "medium", "xhigh"], true, "0.1"],
    ["Qwen3.8-Max", "qmodel_38max", true, ["low", "medium", "xhigh"], true, "0.5"],
    ["Auto", "auto", false, [], true, "1"],
    ["Qwen3.7-Max", "qmodel_latest", true, [], true, "0.5"],
    ["Qwen3.7-Plus", "qmodel", false, [], true, "0.1"],
    ["DeepSeek-V4-Pro", "dmodel", true, [], true, "0.8"],
    ["DeepSeek-Flash", "dfmodel", false, [], true, "0.2"],
    ["GLM-5.3", "gmodel", true, [], true, "0.6"],
    ["Kimi-K2.8-Preview", "kmodel", true, [], true, "0.3"],
    ["MiniMax-M3", "mmodel", false, [], true, "0.2"],
  ],
};

/** 错误分类（协议参考 §3.6，按顺序判；先看响应体语义再看状态码）。
 *  403 双语义：带 pricing/额度特征是套餐不足（402 换号），裸 403 才是登录态（401 刷新）——
 *  只看状态码会把「该充值」误报成「登录失效」。 */
function qoderClassify({ httpStatus, text }) {
  const t = String(text || "");
  const hasPricing = /https?:\/\/[^"\\]*\/pricing[^"\\]*/i.test(t) || /pricingurl|insufficient|no_quota|quota_exceed|exceed_quota|exceeded|credit|upgrade|subscription|plan|trial/i.test(t);
  if (hasPricing || /"code"\s*:\s*112/.test(t)) return { status: 402, message: "当前账号额度不足或套餐不支持该模型" };
  if (httpStatus === 429 || /rate limit|too many/i.test(t)) return { status: 402, message: t.slice(0, 300) || "上游限流" };
  if (httpStatus === 401 || httpStatus === 403) return { status: 401, message: t.slice(0, 300) || "登录态失效或权限不足" };
  return { status: 502, message: t.slice(0, 300) || "上游错误" };
}

/** 会话/记录 id 派生（协议参考 §3.4 公式：sha256 前 16 hex，\0 分隔） */
function qoderIds({ userId, upstreamKey, maxTokens, seed }) {
  const h = (label, ...parts) => crypto.createHash("sha256").update(label + "\0" + parts.join("\0")).digest("hex").slice(0, 16);
  return {
    sessionId: h("qoder-session", String(userId || ""), String(upstreamKey || "")) + "-" + (seed || util.uuid()),
    recordId: h("qoder-record", String(upstreamKey || ""), "mt=" + String(maxTokens)),
  };
}

/** 内部 OpenAI body → Qoder 固定业务信封（协议参考 §3.4 逐字段） */
function qoderBody({ internal, modelEntry, ids, requestId, lastUserText }) {
  const maxTokens = Math.min(Number((internal && internal.max_tokens) || 0) || 32768, 32768); // >32K 上游退化
  const srcMessages = (internal && Array.isArray(internal.messages) ? internal.messages : []).slice();
  const sysTexts = []; // system/developer 收集置顶（上游不看顶层 system 字段）
  const rest = [];
  for (const m of srcMessages) {
    if (m && (m.role === "system" || m.role === "developer")) {
      const t = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      if (t && t.trim()) sysTexts.push(t.trim());
    } else rest.push(m);
  }
  const messages = [];
  if (sysTexts.length) messages.push({ role: "system", content: sysTexts.join("\n\n") });
  for (const m of rest) {
    if (!m || typeof m.role !== "string") continue;
    if (m.role === "user") {
      if (Array.isArray(m.content)) { // 无图压平文本；有图 → [{text},{image_url}]（image_url 原样抽出）
        const parts = [];
        for (const p of m.content) {
          if (p && p.type === "text") parts.push({ type: "text", text: String(p.text || "") });
          else if (p && p.type === "image_url") parts.push({ type: "image_url", image_url: p.image_url });
        }
        messages.push({ role: "user", content: parts });
      } else messages.push({ role: "user", content: String(m.content ?? "") });
    } else if (m.role === "assistant") {
      const hasToolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length;
      const content = m.content == null || m.content === "" ? (hasToolCalls ? " " : "") : String(m.content); // 纯空体会被拒
      const out = { role: "assistant", content };
      if (hasToolCalls) out.tool_calls = m.tool_calls;
      messages.push(out);
    } else if (m.role === "tool") {
      messages.push({ role: "tool", tool_call_id: String(m.tool_call_id || ""), content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "") });
    }
  }
  const isReasoning = !!(modelEntry && modelEntry.is_reasoning);
  return {
    request_id: String(requestId),
    request_set_id: ids.recordId,
    chat_record_id: ids.recordId,
    session_id: ids.sessionId,
    stream: true, // 恒 true（非流式由 Aggregator 本地聚合）
    chat_task: "FREE_INPUT",
    is_reply: true,
    is_retry: false,
    source: 1,
    version: "3",
    session_type: "qodercli",
    agent_id: "agent_common",
    task_id: "common",
    code_language: "",
    chat_prompt: "",
    image_urls: null,
    aliyun_user_type: "",
    system: "",
    messages,
    tools: Array.isArray(internal && internal.tools) ? internal.tools : [],
    parameters: { max_tokens: maxTokens }, // enable_thinking/reasoning_effort 仅显式开思考时追加（发 false 会把思考混进正文或断连）
    chat_context: {
      chatPrompt: "",
      imageUrls: null,
      extra: { context: [], modelConfig: { key: String(modelEntry.key), is_reasoning: isReasoning }, originalContent: String(lastUserText || "") },
      features: [],
      text: String(lastUserText || ""),
    },
    model_config: { key: String(modelEntry.key), is_reasoning: isReasoning, is_vl: !!(modelEntry && modelEntry.is_vl), source: "system" }, // 精简版：剥 thinking_config（原样回传会覆盖 parameters.enable_thinking）
    business: { product: "cli", version: "1.0.0", type: "agent", stage: "start", id: util.uuid(), name: String(lastUserText || "").slice(0, 30), begin_at: Date.now() },
  };
}

/** 信封 SSE 帧解包（协议参考 §3.5）：HTTP 恒 200，{statusCodeValue, body}，body 是内层 JSON 字符串需二次解析；
 *  body 也可能直接是 "[DONE]" 字符串或非字符串对象。 */
function qoderUnpack(frame) {
  const code = Number(frame && frame.statusCodeValue);
  if (code !== 200) {
    const bodyVal = frame && frame.body;
    const text = typeof bodyVal === "string" ? bodyVal : JSON.stringify(bodyVal ?? "");
    return { ok: false, status: code, text };
  }
  const bodyVal = frame && frame.body;
  if (bodyVal === "[DONE]") return { done: true };
  const inner = typeof bodyVal === "string" ? parseJson(bodyVal) : bodyVal;
  return { ok: true, chunk: inner || null };
}

/** thinking 标签跨分片状态机（协议参考 §3.5）：reasoning 以 <thinking>/<think>/<reasoning>/<thought>
 *  混在 content，标签可能切在任意位置；闭标签后吃掉紧跟换行（先 \n\n 再单个）；流结束必须 flush。 */
class TagSplitter {
  constructor() { this.buf = ""; this.inTag = false; }
  feed(piece) {
    this.buf += piece;
    let out = "";
    for (;;) {
      if (!this.inTag) {
        const m = this.buf.match(/<(thinking|think|reasoning|thought)>/);
        if (!m) {
          const keep = Math.min(this.buf.length, 8); // 最长开标签半截（"<thought>" 8 字符内）
          const safe = this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(safe.length);
          return out + safe;
        }
        out += this.buf.slice(0, m.index);
        this.buf = this.buf.slice(m.index + m[0].length);
        this.inTag = true;
      } else {
        const m = this.buf.match(/<\/(thinking|think|reasoning|thought)>/);
        if (!m) {
          const keep = Math.min(this.buf.length, 9); // "</thought>" 9 字符内
          const safe = this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(safe.length);
          return out;
        }
        this.buf = this.buf.slice(m.index + m[0].length).replace(/^\r?\n\r?\n/, "").replace(/^\r?\n/, "");
        this.inTag = false;
      }
    }
  }
  flush() { const rest = this.buf; this.buf = ""; return rest; }
}

function makeQoder() {
  return {
    id: "qoder",
    refreshWindowSec: 300, // 临期 5 分钟（协议参考 §3.7）

    _regionOf(account) {
      const m = (account && account.meta && (account.meta.mode || account.meta.edition)) || "global";
      return m === "cn" ? "cn" : "global"; // ""/global/intl → Global，cn → Cn（协议参考 §3.1）
    },

    models() {
      const seen = [];
      for (const region of ["global", "cn"]) for (const [id] of QODER_FALLBACK[region]) if (!seen.includes(id)) seen.push(id);
      return unionIds([...catalogMap("qoder").values()].map((m) => String(m.id)), seen); // 两区并集、global 优先
    },
    modelEntries() {
      const seen = new Map();
      for (const region of ["global", "cn"]) {
        for (const [id, key, reasoning, efforts, vision, rate] of QODER_FALLBACK[region]) {
          if (!seen.has(id.toLowerCase())) seen.set(id.toLowerCase(), {
            client: id, upstream: key,
            entry: { id, name: id, rate: Number(rate) || 0, capabilities: { images: vision, reasoning, tools: true }, contextLength: 200000, maxOutputTokens: 0, _key: key, _efforts: efforts },
          });
        }
      }
      for (const m of catalogMap("qoder").values()) {
        // fetchModels 写回的 _key/_efforts 是上游真实值，必须保留（覆盖成展示 id 会 400）；DEFAULTS 条目无 _key，回落展示 id
        const upKey = String(m._key || m.id);
        if (!seen.has(String(m.id).toLowerCase())) seen.set(String(m.id).toLowerCase(), { client: String(m.id), upstream: upKey, entry: { ...m, _key: upKey, _efforts: (Array.isArray(m._efforts) && m._efforts) || [] } });
      }
      return [...seen.values()];
    },
    upstreamFor(model) {
      const e = this.modelEntries().find((x) => x.client.toLowerCase() === String(model || "").toLowerCase());
      return e ? e.upstream : String(model || "");
    },
    _resolveEntry(model) {
      const s = String(model || "").toLowerCase();
      const hit = this.modelEntries().find((x) => x.client.toLowerCase() === s || (x.entry._key || "").toLowerCase() === s);
      if (!hit) return null;
      // 归一化到 chat/qoderBody 的消费面：目录条目的上游 key 在 _key、能力在 capabilities.{reasoning,images}，
      // 而消费面读 key/is_reasoning/is_vl——三者不同名，直取会发 "undefined"/恒 false。浅拷贝补齐，不动缓存对象。
      const cap = hit.entry.capabilities || {};
      return {
        ...hit.entry,
        key: hit.entry._key || hit.entry.key,
        is_reasoning: hit.entry.is_reasoning ?? !!cap.reasoning,
        is_vl: hit.entry.is_vl ?? !!cap.images,
      };
    },

    rewriteBody(model, body) {
      const out = { ...(body || {}) };
      out.stream = true;
      if (!out.stream_options || typeof out.stream_options !== "object") out.stream_options = {};
      out.stream_options.include_usage = true;
      delete out.conversation_id; delete out.conversationId; delete out.prompt_cache_key;
      return out; // 信封组装在 chat 里做（需要 account 上下文）
    },

    async chat({ account, secrets, model, body, emit }) {
      const cfg = QODER_REGIONS[this._regionOf(account)];
      const entry = this._resolveEntry(model) || { key: "auto", is_reasoning: false, is_vl: false, _efforts: [] };
      const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === "user");
      const lastUserText = typeof (lastUser && lastUser.content) === "string" ? lastUser.content : "";
      const prepared = this.rewriteBody(model, body);
      const requestId = util.uuid();
      const userId = (account && ((account.meta && account.meta.user_id) || account.uid)) || "";
      const machineId = qoderMachineId();
      const ids = qoderIds({ userId, upstreamKey: entry.key, maxTokens: prepared.max_tokens, seed: (prepared.session_id || "") || undefined });
      const envelope = qoderBody({ internal: prepared, modelEntry: entry, ids, requestId, lastUserText });
      // 思考档位（协议参考 §3.4）：reasoning_effort → reasoning → thinking 命中即停；off/none/disabled/false 不发；
      // true/null → enable_thinking:true 无档位；minimal/min→low、high/max→xhigh；白名单 = 目录 efforts，不支持退默认档
      const effSrc = prepared.reasoning_effort ?? prepared.reasoning ?? prepared.thinking;
      if (effSrc !== undefined && !["off", "none", "disabled", false].includes(effSrc)) {
        if (effSrc === true || effSrc === null) {
          envelope.parameters.enable_thinking = true;
        } else {
          const map = { minimal: "low", min: "low", high: "xhigh", max: "xhigh" };
          let effort = map[String(effSrc)] || String(effSrc);
          const allow = (entry._efforts && entry._efforts.length) ? entry._efforts : ["low", "medium", "xhigh"];
          if (!allow.includes(effort)) effort = allow.includes("medium") ? "medium" : allow[0];
          envelope.parameters.enable_thinking = true;
          envelope.parameters.reasoning_effort = effort;
        }
      }
      const encoded = qcosy.encodeBody(Buffer.from(JSON.stringify(envelope), "utf8")); // 必须先编码后签名
      const url = `${cfg.gateway}${QODER_CHAT_PATH}`;
      const headers = {
        ...qcosy.buildCosyHeaders({ url, body: encoded, uid: userId, token: (secrets && secrets.token) || "", name: (account && account.name) || "", email: (account && account.meta && account.meta.email) || "", machineId, requestId }),
        "content-type": "application/json",
        "accept": "text/event-stream",
        "cache-control": "no-cache",
        "accept-encoding": "identity",
        "x-model-key": String(entry.key),
        "x-model-source": "system",
      };
      const { resp, cancelTimer } = await fetchStream(url, { method: "POST", headers, body: encoded });
      const result = { status: 200, planLimit: false };
      const splitter = new TagSplitter();
      let usage = null; // usage 取最后一帧（协议参考 §3.5）
      const flushUsage = () => { if (usage) emit({ type: "usage", usage }); };
      try {
        // HTTP 恒 200；错误在信封 statusCodeValue 里——fetchStream 的 !resp.ok 分支不会触发
        await pumpSse(resp, (_event, raw) => {
          if (raw === "[DONE]") { flushUsage(); emit({ type: "finish", reason: "" }); return; }
          const frame = parseJson(raw);
          if (!frame) return;
          const u = qoderUnpack(frame);
          if (u.done) { flushUsage(); emit({ type: "finish", reason: "" }); return; }
          if (!u.ok) {
            const cls = qoderClassify({ httpStatus: u.status, text: u.text });
            if (cls.status === 402) result.planLimit = true;
            emit({ type: "error", status: cls.status, code: 0, message: cls.message });
            return;
          }
          const chunk = u.chunk;
          if (!chunk) return;
          const choice = Array.isArray(chunk.choices) && chunk.choices[0];
          if (choice && choice.delta) {
            const delta = { ...choice.delta };
            if (typeof delta.content === "string" && delta.content) delta.content = splitter.feed(delta.content);
            if (Object.keys(delta).length) emit({ type: "delta", delta });
          }
          if (choice && choice.finish_reason) { flushUsage(); emit({ type: "finish", reason: choice.finish_reason }); }
          if (chunk.usage) usage = { prompt_tokens: Number(chunk.usage.prompt_tokens) || 0, completion_tokens: Number(chunk.usage.completion_tokens) || 0, total_tokens: Number(chunk.usage.total_tokens) || 0, ...util.openaiCacheTokens(chunk.usage), ...util.upstreamCredit(chunk.usage) };
        });
        const tail = splitter.flush();
        if (tail) emit({ type: "delta", delta: { content: tail } }); // 不 flush 会丢末尾文字
      } finally { cancelTimer(); }
      return result;
    },

    /** 刷新（协议参考 §3.7）：secrets.refreshToken 是打包串——
     *  5 段 `pat|<PAT>|<作业刷新令牌>|<userId>|<machineId>`（PAT 来源，重走 jobToken/exchange）
     *  3 段 `<oauth刷新令牌>|<userId>|<machineId>`（OAuth 来源，走 center refresh_token） */
    async refreshToken(account, secrets) {
      const packed = String((secrets && secrets.refreshToken) || "");
      const cfg = QODER_REGIONS[this._regionOf(account)];
      const segs = packed.split("|");
      const baseHeaders = { "content-type": "application/json", "cosy-version": "1.0.1", "cosy-clienttype": "5", "user-agent": "qoder-local-proxy" };
      if (segs.length >= 5 && segs[0] === "pat") {
        const r = await httpJson(`${cfg.openApi}/api/v1/jobToken/exchange`, { method: "POST", headers: baseHeaders, body: JSON.stringify({ personal_token: segs[1] }) })
          .catch((e) => ({ ok: false, status: 0, data: null, message: String(e) }));
        const token = r.ok && r.data && r.data.data && r.data.data.token ? String(r.data.data.token) : "";
        if (!token) return { ok: false, message: `PAT 换取失败 HTTP ${r.status}` };
        const exp = Number(util.jwtDecode(token).exp || 0) * 1000;
        return { ok: true, token, refreshToken: packed, expiresAt: exp };
      }
      if (segs.length >= 3) {
        const r = await httpJson(`${cfg.center}${QODER_REFRESH_PATH}`, { method: "POST", headers: { ...baseHeaders, authorization: `Bearer ${(secrets && secrets.token) || ""}` }, body: JSON.stringify({ refreshToken: segs[0] }) })
          .catch((e) => ({ ok: false, status: 0, data: null, message: String(e) }));
        if (r.status === 401) return { ok: false, expired: true, message: "登录态已过期，请重新登录" };
        const d = r.data && (r.data.data || r.data);
        const token = d && d.token ? String(d.token) : "";
        if (!r.ok || !token) return { ok: false, message: (d && d.message) || `刷新失败 HTTP ${r.status}` };
        // refresh_token 不得含 |（协议参考 §2.3/oauth.rs 同判据）；缺失沿用旧值
        const nextRt = d.refresh_token && !String(d.refresh_token).includes("|") ? `${String(d.refresh_token)}|${segs[1]}|${segs[2]}` : packed;
        const exp = Number(util.jwtDecode(token).exp || 0) * 1000;
        return { ok: true, token, refreshToken: nextRt, expiresAt: exp };
      }
      return { ok: false, message: "refreshToken 打包串格式不认识（应为 3 段或 pat| 开头 5 段）" };
    },

    async userInfo(token) {
      // 声明在 payload（util.jwtDecode 顶层只有 token/uid/exp；简报直取 .user_id 是笔误，按真实接口修正）
      const c = util.jwtDecode(token).payload || {};
      return { uid: String(c.user_id || c.sub || ""), name: String(c.nickname || c.name || "Qoder 账号") };
    },

    /** 远程目录（COSY 签名 + 信封，按地区缓存 1h 由 proxy_models_sync 层处理）；失败如实回错由 UI 引导手填 */
    async fetchModels(account, secrets) {
      const cfg = QODER_REGIONS[this._regionOf(account)];
      const url = `${cfg.gateway}${QODER_MODEL_LIST_PATH}`;
      const requestId = util.uuid();
      const encoded = qcosy.encodeBody(Buffer.from(JSON.stringify({ region: this._regionOf(account) }), "utf8"));
      const headers = qcosy.buildCosyHeaders({ url, body: encoded, uid: (account && account.uid) || "", token: (secrets && secrets.token) || "", name: "", email: "", machineId: qoderMachineId(), requestId });
      const r = await httpJson(url, { method: "GET", headers }).catch((e) => ({ ok: false, status: 0, data: null, message: String(e) }));
      const chat = r.data && (r.data.chat || (r.data.data && r.data.data.chat));
      if (!r.ok || !Array.isArray(chat)) return { ok: false, message: `目录拉取失败（HTTP ${r.status || 0}）` };
      const models = chat.filter((m) => m && m.key).map((m) => ({
        id: String(m.display_name || m.key).replace(/\s+/g, ""), // 对外 id = display_name 去所有空白（协议参考 §3.8）
        name: String(m.display_name || m.key),
        rate: Number(m.price_factor) || 0, // 0 是合法值不能当缺失丢弃
        capabilities: { images: !!m.is_vl, reasoning: !!m.is_reasoning, tools: true },
        contextLength: 200000, maxOutputTokens: 0,
        _key: String(m.key),
        _efforts: (m.thinking_config && m.thinking_config.enabled && Object.keys(m.thinking_config.enabled.efforts || {})) || [],
      }));
      return models.length ? { ok: true, models } : { ok: false, message: "目录为空" };
    },
  };
}

/** qoder 机器标识（协议参考 §3.7）：按序找候选文件，第一个存在的非空（≤256 字符、无控制字符）用之；
 *  都没有则生成 UUID v4 写入 <config_dir>/qoder-machine-id，进程内缓存。 */
let _qoderMid = null;
function qoderMachineId() {
  if (_qoderMid) return _qoderMid;
  const fs = require("node:fs");
  const configDir = store.proxyDir();
  const candidates = [path.join(configDir, "qoder-machine-id"), path.join(os.homedir(), ".qoder-proxy", "machine_id"), path.join(os.homedir(), ".qoder", ".auth", "machine_id"), path.join(os.homedir(), ".qoder", "machine_id")];
  for (const f of candidates) {
    try {
      const v = fs.readFileSync(f, "utf8").trim();
      if (v && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v)) { _qoderMid = v; return _qoderMid; }
    } catch { /* 下一个候选 */ }
  }
  _qoderMid = util.uuid();
  try { fs.mkdirSync(configDir, { recursive: true }); fs.writeFileSync(path.join(configDir, "qoder-machine-id"), _qoderMid); } catch { /* 只读环境用内存值 */ }
  return _qoderMid;
}
const qoder = makeQoder();

// ===== 自定义提供商：通用 OpenAI 兼容适配器（按 agents 行动态实例化，一张表行 = 一个上游端点） =====

/** extraBody 深合并：只递归普通对象，数组与标量整体替换。
 *  拼接语义会让用户写 {"stop":["a"]} 时拿到意外的并集，替换语义才可预测。 */
function deepMerge(base, patch) {
  if (patch === undefined) return base;
  if (!isPlainObj(base) || !isPlainObj(patch)) return patch;
  const out = { ...base };
  for (const k of Object.keys(patch)) out[k] = deepMerge(base[k], patch[k]);
  return out;
}
function isPlainObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** models_json 条目归一：字符串 = 裸模型名（上游同名）；对象 = 带元数据与别名。
 *  {model(客户端裸名), upstream(上游真名，缺省=model), name/rate/capabilities/contextLength/maxOutputTokens} */
function compatModelEntries(row) {
  const out = [];
  for (const m of Array.isArray(row.models) ? row.models : []) {
    if (typeof m === "string") {
      if (m.trim()) out.push({ client: m.trim(), upstream: m.trim(), entry: null });
      continue;
    }
    if (!isPlainObj(m) || !m.model) continue;
    const client = String(m.model).trim();
    if (!client) continue;
    out.push({ client, upstream: String(m.upstream || client).trim(), entry: m });
  }
  return out;
}

/** 上游错误 → HTTP 语义。中转站的错误体形状远比内置渠道散，这里只认 OpenAI 形状 + 常见措辞：
 *  余额/配额类判 402（换号）、鉴权类判 401（冷却该 Key）、其余按码透传，认不出的一律 502（可换号）。 */
function statusFromCompatError(errObj, data) {
  const raw = String((errObj && (errObj.type || errObj.code)) || "");
  const msg = String((errObj && errObj.message) || (data && data.message) || "");
  if (/insufficient_quota|quota|balance|exhausted|欠费|余额|积分/i.test(raw + " " + msg)) return 402;
  if (/auth|api[_ ]?key|invalid[_ ]?key|unauthorized/i.test(raw + " " + msg)) return 401;
  const n = Number(errObj && errObj.code);
  if (n === 429 || n === 401 || n === 404 || n === 400 || n === 402 || (n >= 500 && n < 600)) return n;
  return 502;
}

/** 出站端点统一在这里拼：`base_url` 存的是**不含 /v1 的根**（归一化侧保证），所以 /v1 必须由这里补。
 *  真机实测（2026-09-23，一家只开 /v1/messages 的中转站）：只拼 leaf 会打到它的前端页面——
 *  回 200 + text/html，比 404 更难归因。Anthropic 生态里 `base + "/v1/messages"` 是唯一约定
 *  （Claude Code 对 ANTHROPIC_BASE_URL 也这么拼），OpenAI 兼容站的挂载点同样是 /v1。
 *  规则只写这一处：换协议只换 leaf。 */
function compatUrl(base, leaf) {
  return `${base}/v1/${leaf}`;
}

function makeOpenaiCompat(row) {
  const entries = compatModelEntries(row);
  const chatUrl = compatUrl(row.baseUrl, "chat/completions");
  // 客户端名 → 上游真名 / → 条目。别名与模型名同等参与解析（别名不进 /v1/models，
  // 但客户端拿它发请求必须能命中），所以两张表都要把 aliases 铺进去。
  const upstreamByClient = new Map();
  const entryByClient = new Map();
  for (const e of entries) {
    upstreamByClient.set(e.client.toLowerCase(), e.upstream);
    entryByClient.set(e.client.toLowerCase(), e);
    for (const a of (e.entry && Array.isArray(e.entry.aliases) ? e.entry.aliases : [])) {
      const k = String(a || "").toLowerCase();
      if (!k) continue;
      upstreamByClient.set(k, e.upstream);
      entryByClient.set(k, e);
    }
  }
  /** 剥掉自家的 `slug/` 前缀（那是路由信息，上游听不懂） */
  const stripPrefix = (clientModel) => {
    const s = String(clientModel || "");
    return s.slice(0, row.id.length + 1).toLowerCase() === `${row.id}/`.toLowerCase() ? s.slice(row.id.length + 1) : s;
  };
  return {
    /** 提供商没有 rules/headers.json 那套 UA/指纹伪装：头 = 标准 JSON + Bearer + 用户自定义覆盖 */
    headers(secrets) {
      const h = {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${secrets.token || ""}`,
      };
      for (const [k, v] of Object.entries(row.extraHeaders || {})) h[String(k)] = String(v);
      return h;
    },

    /** 客户端模型名 → 上游真名：先剥自家的 `slug/` 前缀，再查条目配的 upstream（模型名与别名同表）。
     *  目录外模型原样透传：用户显式点名了提供商，而中转站实际开放的
     *  模型常常领先于它的清单（内置渠道同款"透传试错"语义）。 */
    upstreamFor(clientModel) {
      const s = stripPrefix(clientModel);
      return upstreamByClient.get(s.toLowerCase()) || s;
    },

    /** 客户端模型名（或别名）→ 该条目的元数据；查不到回 null，调用方按"无目录元数据"处理 */
    entryFor(clientModel) {
      return entryByClient.get(stripPrefix(clientModel).toLowerCase()) || null;
    },

    models() {
      return entries.map((e) => e.client);
    },

    modelEntries() {
      return entries;
    },

    /** 拉上游自己的清单（GET {base}/v1/models）：中转站大多支持（真机实测连只开 /v1/messages
     *  的 Claude 中转站也开了它），失败如实回错，由 UI 引导手填。
     *  Anthropic 形态的站认 x-api-key，别发 Bearer。 */
    async fetchModels(secrets) {
      const headers = row.kind === "anthropic_messages"
        ? { "x-api-key": String(secrets && secrets.token || ""), "anthropic-version": "2023-06-01" }
        : this.headers(secrets);
      const r = await httpJson(compatUrl(row.baseUrl, "models"), { method: "GET", headers })
        .catch((e) => ({ ok: false, status: 0, data: null, text: String((e && e.message) || e) }));
      if (!r.ok) {
        return {
          ok: false,
          message: `HTTP ${r.status || 0} ${(r.text || "").slice(0, 200)}` +
            (r.status === 404 ? "（该上游没有模型目录接口，请在模型清单里手填）" : ""),
        };
      }
      const list = (r.data && (Array.isArray(r.data) ? r.data : r.data.data)) || [];
      const models = list.map((m) => String((m && (m.id ?? m.model ?? m.name)) || "")).filter(Boolean);
      return { ok: true, models };
    },

    rewriteBody(model, body) {
      const out = { ...(body || {}) };
      out.model = this.upstreamFor(model);
      out.stream = true; // 一律流式打上游，非流式由 server 侧 Aggregator 本地聚合（见 chat() 注释）
      if (!isPlainObj(out.stream_options)) out.stream_options = {};
      out.stream_options.include_usage = true;
      // 思考档位按该模型声明的支持集降级（与内置渠道同一个 util，档位词表也同源）：
      // 客户端要 low 而上游只有 medium/high 时，透传过去是一个 400，降级才可用
      const entry = this.entryFor(model);
      util.normalizeReasoningEffort(out, entry && entry.entry && entry.entry.reasoning);
      // 网关自己注入的内部字段，上游不认（raccoon 同款剔除清单）
      delete out.conversation_id;
      delete out.conversationId;
      delete out.prompt_cache_key;
      return deepMerge(out, row.extraBody || {});
    },

    /** 对话：按提供商的上游协议形态分派。两种形态共用同一套 emit 词汇与同一份调度、号池、记账代码。
     *  Anthropic 形态上游不发 stream_options / 不接 OpenAI body，见 chatAnthropic。 */
    async chat(ctx) {
      return row.kind === "anthropic_messages" ? this.chatAnthropic(ctx) : this.chatOpenai(ctx);
    },

    /** OpenAI 协议 1:1 透传 */
    async chatOpenai({ secrets, model, body, emit }) {
      const payload = JSON.stringify(this.rewriteBody(model, body));
      const { resp, cancelTimer } = await fetchStream(chatUrl, { method: "POST", headers: this.headers(secrets), body: payload });
      const result = { status: 200, planLimit: false };
      try {
        // 少数中转站无视 stream:true、直接回一整个 JSON：SseScanner 找不到 data: 行会一条都不产出，
        // 客户端就拿到 200 空响应。这里按 content-type 单独走非流式分支，别让它静默变空。
        const ctype = String(resp.headers.get("content-type") || "");
        if (!ctype.includes("event-stream")) {
          const text = await resp.text();
          const data = parseJson(text);
          if (!data) throw Object.assign(new Error(`上游返回非 JSON（${text.slice(0, 200)}）`), { status: 502 });
          this.emitWholeResponse(data, emit, result);
          return result;
        }
        await pumpSse(resp, (_event, raw) => {
          if (raw === "[DONE]") { emit({ type: "finish", reason: "" }); return; }
          const data = parseJson(raw);
          if (!data) return;
          if (data.error) {
            const status = statusFromCompatError(data.error, data);
            if (status === 402) result.planLimit = true;
            emit({ type: "error", status, code: Number(data.error.code) || 0, message: String(data.error.message || "上游错误") });
            return;
          }
          const choice = Array.isArray(data.choices) && data.choices[0];
          if (choice) {
            if (choice.delta && Object.keys(choice.delta).length) emit({ type: "delta", delta: choice.delta });
            if (choice.message && Object.keys(choice.message).length) emit({ type: "delta", delta: choice.message });
            if (choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
          }
          if (data.usage) {
            emit({
              type: "usage",
              usage: {
                prompt_tokens: Number(data.usage.prompt_tokens ?? data.usage.input_tokens) || 0,
                completion_tokens: Number(data.usage.completion_tokens ?? data.usage.output_tokens) || 0,
                total_tokens: Number(data.usage.total_tokens) || 0,
                ...util.openaiCacheTokens(data.usage),
                ...util.upstreamCredit(data.usage),
              },
            });
          }
        });
      } finally {
        cancelTimer();
      }
      return result;
    },

    /**
     * Anthropic Messages 形态上游（很多 Claude 中转站只开这一种）。
     * 请求与事件流的互转都在 protocols/anthropic-up.cjs；这里只管 HTTP 与错误映射。
     */
    async chatAnthropic({ secrets, model, body, emit }) {
      const t = aup.toRequest(this.upstreamFor(model), body);
      if (!t.ok) throw Object.assign(new Error(t.message), { status: 400, fatal: true });
      // extraBody 深合并：允许只覆盖 thinking.max_tokens 这类嵌套字段而不丢掉整个对象
      const payloadObj = deepMerge(t.request, row.extraBody || {});
      const headers = { "content-type": "application/json", accept: "application/json", "anthropic-version": "2023-06-01" };
      for (const [k, v] of Object.entries(row.extraHeaders || {})) headers[k] = String(v);
      headers["x-api-key"] = secrets.token || "";
      const { resp, cancelTimer } = await fetchStream(compatUrl(row.baseUrl, "messages"), { method: "POST", headers, body: JSON.stringify(payloadObj) });
      const result = { status: 200, planLimit: false };
      // type 表认不出的形状交给通用关键词表；而"欠费"无论上游把 type 写成什么都必须认出来——
      // 只有 402 会走「切号 + planLimit」这条既有链路，落到 400/502 就是把坏 Key 当好 Key 反复打。
      const statusOf = (errObj, data) => {
        const byType = aup.upstreamErrorStatus(errObj);
        const generic = statusFromCompatError(errObj, data);
        const s = generic === 402 || byType === 502 ? generic : byType;
        if (s === 402) result.planLimit = true;
        return s;
      };
      const tr = aup.makeTranslator(emit, t.nameMap, statusOf);
      try {
        const ctype = String(resp.headers.get("content-type") || "");
        if (!ctype.includes("event-stream")) {
          const text = await resp.text();
          const data = parseJson(text);
          if (!data) throw Object.assign(new Error(`上游返回非 JSON（${text.slice(0, 200)}）`), { status: 502 });
          aup.emitWhole(data, emit, t.nameMap, statusOf);
          return result;
        }
        await pumpSse(resp, (_event, raw) => {
          const data = parseJson(raw);
          if (data) tr.push(data);
        });
        tr.close();
      } finally {
        cancelTimer();
      }
      return result;
    },

    /** 非流式上游响应 → 同一套 emit 词汇（role 帧 + 正文 + tool_calls + usage + finish） */
    emitWholeResponse(data, emit, result) {
      if (data.error) {
        const status = statusFromCompatError(data.error, data);
        if (status === 402) result.planLimit = true;
        emit({ type: "error", status, code: Number(data.error.code) || 0, message: String(data.error.message || "上游错误") });
        return;
      }
      const choice = Array.isArray(data.choices) && data.choices[0];
      if (choice && choice.message && Object.keys(choice.message).length) emit({ type: "delta", delta: choice.message });
      if (choice && choice.finish_reason) emit({ type: "finish", reason: choice.finish_reason });
      if (data.usage) {
        emit({
          type: "usage",
          usage: {
            prompt_tokens: Number(data.usage.prompt_tokens ?? data.usage.input_tokens) || 0,
            completion_tokens: Number(data.usage.completion_tokens ?? data.usage.output_tokens) || 0,
            total_tokens: Number(data.usage.total_tokens) || 0,
            ...util.openaiCacheTokens(data.usage),
            ...util.upstreamCredit(data.usage),
          },
        });
      }
    },

    // 提供商是 API Key 直连：没有刷新链路，也没有"余额"这个概念。
    // 刻意不定义 queryCredits —— credits.refreshAll/refreshChannel 靠它缺席来跳过，别补一个假的。
    async refreshToken() {
      return { ok: false, noRefresh: true, message: "该渠道为 API Key 直连，无自动刷新；Key 失效请换新" };
    },
    async userInfo() {
      return { uid: "", name: "" };
    },
  };
}

// 实例缓存按 `${id}:${updated_at}`：store.saveProvider 会前进 updated_at，于是改完配置自然换实例，
// 不必重启网关。上限防的是"反复编辑同一个提供商"堆积——每次编辑一个新时间戳、旧实例永不复用。
const compatCache = new Map();
function compatAdapter(id) {
  const row = store.channelList().find((c) => c.id === id && c.kind !== "builtin");
  if (!row) return null;
  const key = `${row.id}:${row.updatedAt}`;
  let ad = compatCache.get(key);
  if (!ad) {
    if (compatCache.size > 64) compatCache.clear();
    ad = makeOpenaiCompat(row);
    compatCache.set(key, ad);
  }
  return ad;
}

const ADAPTERS = { trae, workbuddy, workbuddy_ai, raccoon, cline_free, cline_pass, autoclaw, autoclaw_intl, qoder };

/** 渠道 → 适配器：内置 8 家查静态表，未命中再试动态提供商。
 *  ADAPTERS 本身保持只含内置 —— mergedModels()/modelOwners() 靠这个前提把裸模型名
 *  的归属判定完全留给内置渠道（提供商的模型只以 slug/model 出现），见那里的注释。 */
function get(channel) {
  return ADAPTERS[channel] || compatAdapter(channel) || null;
}

// ===== 刷新并发互斥（single-flight） =====
// 上游 refreshToken 是轮换语义（参考项目实证：旧 refreshToken 可能一次性失效）：
// 并发 401 各自拿同一个旧 token 刷，后发者必然失败并把好号误判 relogin。
// 按账号收敛为单飞——并发调用共享同一个 promise，成功者写库，其余复用结果
const refreshInflight = new Map();

function refreshTokenLocked(channel, account, secrets, extraOrigins) {
  const ad = get(channel);
  if (!ad) return Promise.resolve({ ok: false, message: `未知渠道 ${channel}` });
  const key = `${channel}:${(account && (account.id || account.uid)) || ""}`;
  const inflight = refreshInflight.get(key);
  if (inflight) return inflight;
  const p = Promise.resolve()
    .then(() => ad.refreshToken(account, secrets, extraOrigins))
    .finally(() => refreshInflight.delete(key));
  refreshInflight.set(key, p);
  return p;
}

/** 合并模型目录（/v1/models）：canonical id 归并 + 来源标记 + 目录元数据（倍率/能力/上下文） */
function mergedModels() {
  const seen = new Map();
  const catMaps = {};
  for (const channel of Object.keys(ADAPTERS)) catMaps[channel] = catalogMap(channel);
  for (const [channel, ad] of Object.entries(ADAPTERS)) {
    for (const m of ad.models()) {
      const id = String(m);
      const cur = seen.get(id.toLowerCase());
      if (cur) {
        if (!cur.sources.includes(channel)) cur.sources.push(channel);
      } else {
        seen.set(id.toLowerCase(), { id, object: "model", created: 0, owned_by: channel, sources: [channel] });
      }
    }
  }
  for (const entry of seen.values()) {
    entry.name = entry.id;
    entry.rate = null;
    entry.capabilities = {};
    entry.contextLength = 0;
    entry.maxOutputTokens = 0;
    // 多源模型按来源顺序取第一个有值条目（catalog 顺序即渠道优先级）
    for (const channel of entry.sources) {
      const meta = catMaps[channel].get(entry.id.toLowerCase());
      if (!meta) continue;
      if (meta.name && meta.name !== entry.id && entry.name === entry.id) entry.name = String(meta.name);
      if (entry.rate == null && meta.rate != null && !Number.isNaN(Number(meta.rate))) entry.rate = Number(meta.rate);
      entry.capabilities = { ...entry.capabilities, ...(meta.capabilities || {}) };
      if (!entry.contextLength && meta.contextLength) entry.contextLength = Number(meta.contextLength) || 0;
      if (!entry.maxOutputTokens && meta.maxOutputTokens) entry.maxOutputTokens = Number(meta.maxOutputTokens) || 0;
    }
  }
  // 自定义提供商的模型**只以 slug/model 出现**，绝不列出裸名：这是防静默遮蔽的结构保证——
  // 用户建一个名叫 claude-sonnet-5 的提供商，也不会让 /v1/models 里出现第二条同名裸条目去顶掉内置池。
  for (const row of store.channelList()) {
    if (row.kind === "builtin") continue;
    for (const e of compatModelEntries(row)) {
      const id = `${row.id}/${e.client}`;
      if (seen.has(id.toLowerCase())) continue;
      seen.set(id.toLowerCase(), {
        id,
        object: "model",
        created: 0,
        owned_by: row.id,
        sources: [row.id],
        name: String((e.entry && e.entry.name) || e.client),
        rate: e.entry && e.entry.rate != null ? Number(e.entry.rate) : null,
        capabilities: (e.entry && e.entry.capabilities) || {},
        contextLength: Number((e.entry && e.entry.contextLength) || 0),
        maxOutputTokens: Number((e.entry && e.entry.maxOutputTokens) || 0),
        upstream: e.upstream,
      });
    }
  }
  return [...seen.values()];
}

/** 模型 → 渠道归属：**只算内置渠道**（ADAPTERS 静态表）。
 *  提供商的归属判定走 provider.parseModelRef() 的 slug/ 前缀，或 allowBareProviderModel 的兜底，
 *  两者都在此函数之外——把提供商掺进来就等于让一个裸名可能同时属于内置池和某个中转站，
 *  那时"谁赢"就必须靠优先级配置回答，而这里刻意不给它那个可能。 */
function modelOwners(model) {
  const id = String(model || "").toLowerCase();
  const owners = [];
  for (const [channel, ad] of Object.entries(ADAPTERS)) {
    if (ad.models().some((m) => String(m).toLowerCase() === id)) owners.push(channel);
  }
  return owners;
}

module.exports = {
  get,
  ADAPTERS,
  mergedModels,
  modelOwners,
  httpJson,
  refreshTokenLocked,
  // 提供商管理面要拿一份「尚未落库的表单值」建临时适配器做连通性探测，故导出工厂本身
  makeOpenaiCompat,
  // 测试窥视口（下划线前缀 = 非公共契约）：cline 错误分类的纯函数，dev-cline-test 直测
  _clineErrorStatus: clineErrorStatus,
  _pickClineModels: pickClineModels,
  // autoclaw 窥视口：签名公式与路由解析纯函数，dev-autoclaw-test 直测
  _autoclawSign: autoclawSign,
  _autoclawResolveRoute: autoclawResolveRoute,
  // qoder 窥视口：错误分类/id 派生/信封体/双层解包/标签状态机纯函数，dev-qoder-test 直测
  _qoderClassify: qoderClassify,
  _qoderIds: qoderIds,
  _qoderBody: qoderBody,
  _qoderUnpack: qoderUnpack,
  _qoderMachineId: qoderMachineId,
  _TagSplitter: TagSplitter,
};
