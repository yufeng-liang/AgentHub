// 通用系统提示词策略（借鉴 workbuddy2api-panel 的 prompt.mode 体系）：
// 在出站分发前，对「已规范化的 OpenAI 形态 body.messages」施加统一的 system 策略，渠道无关。
// 默认 passthrough（完全不改，保持本项目既有行为）；custom / append 为用户显式开启的增强。
//
//   - passthrough：原样透传客户端 system/developer（现状，默认）
//   - custom    ：删除全部 system/developer，头部插入单条网关 system（text 空则用内置默认提示词）
//   - append    ：保留开头连续的 system/developer 块，在其后插入一条网关 system；其余消息逐字不动
//
// 另提供 degradeMessages：内容审核拦截（HTTP 400/502 + blocked by security policy 等文案）时的
// 降级形态——剥掉全部 system/developer，只留一条最中性的 system 重试一次。客户端（Claude Code /
// Codex 等）注入的 system 指纹是上游内容审核误报的主因，降级后多数可放行；仍被拦则是消息内容本身
// 触发审核，如实报错。此举与 AutoClaw 出站的 normalizeSystemPrompt（白名单闸门）叠加、互不冲突。
"use strict";

// 内置默认提示词（custom/append 未配置 promptText 时使用）；刻意简短中性、不含任何产品名/harness 身份。
const DEFAULT_PROMPT =
  "You are a helpful, professional coding and writing assistant. " +
  "Follow the user's instructions directly, keep answers concise, and use the provided tools as listed.";

// 降级重试用的最中性 system：越短越不可能撞审核指纹。
const NEUTRAL_PROMPT = "You are a helpful assistant.";

function isSystem(m) {
  return m && (m.role === "system" || m.role === "developer");
}

function dropSystem(messages) {
  return messages.filter((m) => !isSystem(m));
}

/** 就地施加 prompt 模式；非法/passthrough 一律原样返回。返回 body。 */
function applyPromptMode(body, mode, text) {
  const messages = body && Array.isArray(body.messages) ? body.messages : null;
  if (!messages) return body;
  const m = String(mode || "passthrough");
  if (m !== "custom" && m !== "append") return body; // passthrough 及未知值 = 不改
  const sys = String(text || "").trim() || DEFAULT_PROMPT;
  if (m === "custom") {
    body.messages = [{ role: "system", content: sys }, ...dropSystem(messages)];
    return body;
  }
  // append：找到开头连续 system/developer 块的结束下标，在其后插入网关 system（既有消息逐字不动）
  let i = 0;
  while (i < messages.length && isSystem(messages[i])) i += 1;
  messages.splice(i, 0, { role: "system", content: sys });
  return body;
}

/** 内容审核降级：剥掉全部 system/developer，头部只留一条中性 system。就地改写，返回 body。 */
function degradeMessages(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : null;
  if (!messages) return body;
  body.messages = [{ role: "system", content: NEUTRAL_PROMPT }, ...dropSystem(messages)];
  return body;
}

module.exports = { DEFAULT_PROMPT, NEUTRAL_PROMPT, applyPromptMode, degradeMessages };
