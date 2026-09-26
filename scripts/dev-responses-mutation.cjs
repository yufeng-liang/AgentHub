// ⑤ 闸的变异自证：逐条把保护拆掉，确认对应断言真的会红（跑完即恢复）
// 用法：node scripts/dev-responses-mutation.cjs
"use strict";
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const OUT = path.join(__dirname, "..", "electron", "backend", "proxy", "protocols", "responses-out.cjs");
const raw = fs.readFileSync(OUT, "utf8");

const MUTATIONS = [
  {
    name: "endOk 不发 response.completed",
    from: 'write(ev("response.completed", { type: "response.completed"',
    to: 'if (false) write(ev("response.completed", { type: "response.completed"',
    expect: /response\.completed/,
  },
  {
    name: "reasoning item 去掉 encrypted_content 键",
    from: 'if (this.kind === "reasoning") return { type: "reasoning", id: this.id, summary: [], encrypted_content: null };',
    to: 'if (this.kind === "reasoning") return { type: "reasoning", id: this.id, summary: [] };',
    expect: /encrypted_content/,
  },
  {
    name: "writeHead 立刻落盘（取消 deferredOpen）",
    from: '      deferred.push(ev("response.created", { type: "response.created"',
    to: '      ensureHead();\n      write(ev("response.created", { type: "response.created"',
    expect: /只有一个 response\.created/,
  },
  {
    name: "tool_calls 的 id 不再透传（call_id 断链）",
    from: '      if (tc.id) it.call_id = String(tc.id);',
    to: '      if (tc.id && !tc.id) it.call_id = String(tc.id);',
    expect: /call_id 与上游一致/,
  },
  {
    name: "截断时改发 response.incomplete",
    from: 'write(ev("response.completed", { type: "response.completed", response: responsePayload("completed"), sequence_number: seq++ }));',
    to: 'write(ev(finishReason === "length" ? "response.incomplete" : "response.completed", { type: finishReason === "length" ? "response.incomplete" : "response.completed", response: responsePayload("completed"), sequence_number: seq++ }));',
    expect: /也发 completed/,
  },
];

let bad = 0;
for (const m of MUTATIONS) {
  if (!raw.includes(m.from)) {
    console.log(`✗ [${m.name}] 变异锚点在源码里找不到（锚点已过期）`);
    bad++;
    continue;
  }
  fs.writeFileSync(OUT, raw.replace(m.from, m.to));
  let out = "";
  let threw = false;
  try {
    out = execFileSync(process.execPath, [path.join(__dirname, "dev-responses-test.cjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    out = String((e && (e.stdout || "")) + (e && (e.stderr || "")));
    threw = true;
  } finally {
    fs.writeFileSync(OUT, raw);
  }
  const failed = [...out.matchAll(/✗ (.+?) →/g)].map((x) => x[1]);
  const caught = failed.some((f) => m.expect.test(f));
  console.log(`${caught ? "✓" : "✗"} [${m.name}] 变红 ${failed.length} 条${failed.length ? "：" + failed.slice(0, 3).join(" / ") : ""}`);
  if (!caught) bad++;
  if (!threw && failed.length === 0) console.log("   （注意：闸整体仍绿，说明这条保护没有判据）");
}
console.log(`\n${MUTATIONS.length - bad}/${MUTATIONS.length} 条变异被抓到`);
process.exit(bad ? 1 : 0);
