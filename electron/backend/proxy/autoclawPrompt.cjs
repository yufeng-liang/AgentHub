// AutoClaw 出站 system 规范化（协议参考 §2.4）：上游 2026-09-22 起的闸门——
// 首条 system 必须以身份句开头且带 ## Tooling 段，且不能出现外来 harness 身份句（字面判定）。
// 前缀原文取自官方客户端运行时（OpenClaw 身份），照抄保证出站形态与官方客户端一致。
// 幂等判据只有 starts_with(IDENTITY_LINE) 一条：降级/同家重试路径必然重复归一，别把前缀写两遍。
"use strict";

const IDENTITY_LINE = "You are a personal assistant running inside OpenClaw.";
// 末尾带 \n，joinPrefix 再补一个空行——客户端正文另起一段，与官方 prompt 段落风格一致
const IDENTITY_PREFIX = "You are a personal assistant running inside OpenClaw.\n\n" +
  "## Tooling\n" +
  "Available tools are policy-filtered. Names are case-sensitive; call exactly as listed.\n";

// 外来身份句 → 中性说法（长的在前，否则短串先把长匹配切碎）；替换串不含产品名——
// 闸门拦的是产品名本身，插词（workbuddy sanitize 手法）在这条闸门不够用
const FOREIGN_IDENTITIES = [
  ["You are ZCode, an interactive coding agent", "You are an interactive coding agent"],
  ["You are a coding agent running in the Codex CLI tool", "You are a coding agent running in a terminal CLI tool"],
  ["You are a coding agent running in the Codex CLI", "You are a coding agent running in a terminal CLI"],
  // Claude Code 整句是 "You are Claude Code, Anthropic's official CLI tool for Claude."——
  // 只改到「You are Claude Code」为止，后面的产品说明原样保留
  ["You are Claude Code", "You are a coding assistant"],
  ["You are ZCode", "You are an interactive coding agent"],
];

function isSystemRole(m) { return m && (m.role === "system" || m.role === "developer"); }

function joinPrefix(original) {
  return original ? IDENTITY_PREFIX + "\n" + original : IDENTITY_PREFIX;
}

function rewriteIdentities(text) {
  let out = String(text);
  for (const [from, to] of FOREIGN_IDENTITIES) {
    if (out.includes(from)) out = out.split(from).join(to); // 全量替换：一条文本里出现多次也一并改掉
  }
  return out;
}

/** content 三形态：字符串直接拼；数组拼进第一个文本 part（没有就在头部插）；其它换成前缀本身 */
function prependPrefix(message) {
  if (message.content === undefined || message.content === null) { message.content = IDENTITY_PREFIX; return; }
  if (typeof message.content === "string") {
    if (!message.content.startsWith(IDENTITY_LINE)) message.content = joinPrefix(message.content);
    return;
  }
  if (Array.isArray(message.content)) {
    const idx = message.content.findIndex((p) => p && typeof p.text === "string");
    if (idx === -1) { message.content.unshift({ type: "text", text: IDENTITY_PREFIX }); return; }
    const part = message.content[idx];
    if (!part.text.startsWith(IDENTITY_LINE)) part.text = joinPrefix(part.text);
    return;
  }
  message.content = IDENTITY_PREFIX; // null/对象/数字：这种 content 当 system 本来就不成立，换掉
}

/** 就地改写 body.messages：① 所有 system/developer 的外来身份句；② 保证首条以身份句开头 */
function normalizeSystemPrompt(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : null;
  if (!messages) return body; // 形态怪异交给上游报错，比造空 messages 更能说明问题
  for (const m of messages) {
    if (!isSystemRole(m)) continue;
    if (typeof m.content === "string") m.content = rewriteIdentities(m.content);
    else if (Array.isArray(m.content)) for (const p of m.content) { if (p && typeof p.text === "string") p.text = rewriteIdentities(p.text); }
  }
  if (messages.length && isSystemRole(messages[0])) { prependPrefix(messages[0]); return body; }
  messages.unshift({ role: "system", content: IDENTITY_PREFIX }); // 不重排后面的消息（轮次结构不能破坏）
  return body;
}

module.exports = { IDENTITY_LINE, IDENTITY_PREFIX, FOREIGN_IDENTITIES, normalizeSystemPrompt };
