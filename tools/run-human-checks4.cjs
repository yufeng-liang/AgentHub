// 第四段：修正模型列表截断后，重做一次「无窗期真补全」，跑完把窗口留在销毁态交给 computer-use 验托盘
// 注意：本脚本附着到 run-human-checks3 已拉起的实例（COPY 目录由 argv 传入），自身不 spawn；
// 卫生三件套仍照走（防将来有人在这里补 spawn 时忘了隔离）。
"use strict";
const hy = require("./probe-hygiene.cjs")("run-human-checks4");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const fc = require("../scripts/dev-first-paint-check.cjs");
const sleep = fc.sleep;

const COPY = process.argv[2];
const PORT = 9528;
const PS = "powershell.exe";
const out = (l, o) => console.log(JSON.stringify({ label: l, ...(o || {}) }));
function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 32 << 20 });
  return { status: r.status, stdout: (r.stdout || "").trim(), stderr: (r.stderr || "").trim() };
}
function tree(rootPid) {
  const q = `$ps = Get-CimInstance Win32_Process -Filter "Name='AgentHub.exe'" | Where-Object { $_.ProcessId -eq ${rootPid} -or $_.ParentProcessId -eq ${rootPid} }; $t=0;$n=0; foreach($p in $ps){ try{ $o=Get-Process -Id $p.ProcessId -ErrorAction Stop; $t+=$o.PrivateMemorySize64;$n++ }catch{} }; "$n $((' {0:N2}' -f ($t/1MB)))"`;
  const m = /(\d+)\s+([\d.,\s]+)/.exec(sh(PS, ["-NoProfile", "-Command", q]).stdout || "");
  return m ? { n: Number(m[1]), privMb: Number(m[2].replace(/[\s,]/g, "")) } : { n: -1, privMb: -1 };
}
function http(method, url, headers, body, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const t0 = Date.now();
    const req = require("node:http").request({ hostname: u.hostname, port: u.port, path: u.pathname, method, headers, timeout: timeoutMs }, (res) => {
      let s = ""; res.on("data", (d) => (s += d)); res.on("end", () => resolve({ status: res.statusCode, ms: Date.now() - t0, full: s }));
    });
    req.on("error", (e) => resolve({ error: e.message, ms: Date.now() - t0 }));
    req.on("timeout", () => req.destroy(new Error("client timeout")));
    if (body) req.write(body);
    req.end();
  });
}
const redact = (s) => String(s).replace(/sk-[A-Za-z0-9]{20,}/g, "<gateway-key>").replace(/[A-Za-z0-9+/=_-]{40,}/g, "<redacted-long>");

async function main() {
  const pid = Number((sh(PS, ["-NoProfile", "-Command",
    `Get-CimInstance Win32_Process -Filter "Name='AgentHub.exe'" | Where-Object { $_.CommandLine -like '*${COPY}*' } | Select-Object -First 1 -ExpandProperty ProcessId`]).stdout || "").trim());
  if (!pid) throw new Error("验证实例不在");
  const key = fs.readFileSync(path.join(COPY, "gateway-key.txt"), "utf8").trim();
  out("start", { pid, ...tree(pid) });

  // 有窗基线 → WM_CLOSE → 无窗
  const before = tree(pid);
  if (before.n >= 4) {
    const closed = sh(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(__dirname, "close-window.ps1"), "-ProcId", String(pid)]);
    out("wm-close", { status: closed.status, posted: /"posted":\s*true/.test(closed.stdout) });
    await sleep(9000);
  } else {
    out("wm-close", { skipped: "已经是无窗态 n=" + before.n });
  }
  const after = tree(pid);
  out("windowless", Object.assign({}, after, { from: before.privMb, savedMb: +(before.privMb - after.privMb).toFixed(2), procDrop: before.n - after.n }));

  const models = await http("GET", `http://127.0.0.1:${PORT}/v1/models`, { authorization: "Bearer " + key });
  let list = [];
  try { list = JSON.parse(models.full).data || []; } catch (e) { out("models-parse-fail", { head: redact((models.full || "").slice(0, 120)) }); }
  const ids = list.map((d) => d.id);
  out("models", { status: models.status, ms: models.ms, count: ids.length, owners: [...new Set(list.map((d) => d.owned_by))].slice(0, 8) });
  if (!ids.length) throw new Error("模型列表空，无法打补全");
  // 每个渠道取一个代表模型试到 200 为止（最多 4 次，省额度）
  const seen = new Set();
  const cands = [];
  for (const d of list) {
    const o = d.owned_by || "?";
    if (seen.has(o)) continue;
    seen.add(o);
    cands.push(d.id);
  }
  const ordered = [...cands.filter((m) => /doubao|deepseek|glm|kimi|qwen/i.test(m)), ...cands.filter((m) => !/doubao|deepseek|glm|kimi|qwen/i.test(m))].slice(0, 4);
  let comp = null, pick = null, tries = [];
  for (const m of ordered) {
    pick = m;
    comp = await http("POST", `http://127.0.0.1:${PORT}/v1/chat/completions`,
      { authorization: "Bearer " + key, "content-type": "application/json" },
      JSON.stringify({ model: m, messages: [{ role: "user", content: "只回一个词：hi" }], stream: false, max_tokens: 20 }));
    let p = null; try { p = JSON.parse(comp.full || "{}"); } catch (e) { /* ignore */ }
    const ok = !!(p && p.choices && p.choices[0] && p.choices[0].message);
    tries.push({ model: m, status: comp.status, ms: comp.ms, ok, err: p && p.error ? String(p.error.message).slice(0, 40) : null });
    if (ok) { comp.parsed = p; break; }
  }
  out("attempts", tries);
  comp.full = comp.full || "";

  const parsed = comp.parsed || null;
  const msg = parsed && parsed.choices && parsed.choices[0] ? parsed.choices[0].message : null;
  out("completion-windowless", {
    status: comp.status, ms: comp.ms, model: pick,
    hasContent: !!(msg && msg.content != null),
    contentPreview: msg ? redact(String(msg.content)).slice(0, 40) : null,
    usage: parsed ? JSON.stringify(parsed.usage || {}) : null,
    error: parsed && parsed.error ? JSON.stringify(parsed.error).slice(0, 220) : null,
    bodyHead: redact(String(comp.full || comp.error || "").slice(0, 220)),
  });
  out("healthz-still", await http("GET", `http://127.0.0.1:${PORT}/healthz`, {}).then((r) => ({ status: r.status, body: redact((r.full || "").slice(0, 60)) })));
  out("main-alive-windowless", { pid, alive: fc.pidAlive(pid), ...tree(pid) });
  out("WINDOW-KEPT-DESTROYED-FOR-TRAY-TEST", { pid, port: Number(fs.readFileSync(path.join(COPY, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]), userData: COPY });
}
main().catch((e) => { console.error("FAILED:", String(e && e.message ? e.message : e).slice(0, 240)); process.exit(1); });
