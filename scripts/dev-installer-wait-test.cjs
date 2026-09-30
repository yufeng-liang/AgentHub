// 静态结构闸：build/installer.nsh 的解锁等待不许退回旧写法。
//
// 分工说清楚，别让绿勾骗人：
//   本闸只看结构（宏在不在、强杀是否仍在等待之前、等待是否按时间设了上下限）；
//   行为与时延判据在 tools/installer-wait-probe.cjs（真编译真跑，双向变异对照）。
//   静态绿 ≠ 行为对，两条都要跑。
//
// 两个方向都可能有回退，所以两组判据：
//   太慢——退回历史上的 Sleep 2000 + Sleep 500。这个宏一次安装要跑好几遍，本机对照
//         「宏整个空掉」的包实测多花 5.6~6.3 秒；且锁超过 2.5 秒才放时照样撞上
//         "Failed to uninstall old application files.: 2"。
//   太快——「先探锁、没锁就不杀」。实测不可信：同一把独占句柄下，同样的四行内联在
//         Section 里判「锁着」、放进宏里判「没锁」并 0ms 放行，随后 Rename 失败。
//   上限也不能按迭代次数算：每轮迭代含两次 taskkill 进程创建 ≈0.7 秒，写成
//         「30 次 × Sleep 200」实测最坏等了 10.8 秒，比盲等还久。
//
// 用法：node scripts/dev-installer-wait-test.cjs
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const NSH = path.join(REPO, 'build', 'installer.nsh');

function macroBody(text) {
  const m = text.match(/!macro\s+customCheckAppRunning\b([\s\S]*?)!macroend/);
  return m ? m[1] : null;
}

function judge(body) {
  const sleepTotal = [...body.matchAll(/^\s*Sleep\s+(\d+)/gm)].reduce((s, m) => s + Number(m[1]), 0);
  const tKill = body.search(/taskkill\b/);
  const tProbe = body.search(/FileOpen\b/);
  return {
    '强杀仍是 /F /T 两轮（v1.20.1 的教训）': (body.match(/taskkill\s+\/F\s+\/T\s+\/IM/g) || []).length >= 2,
    '强杀在等待之前（不许「探到锁才杀」，那是漏杀老路）': tKill >= 0 && (tProbe < 0 || tKill < tProbe),
    '全新安装（主程序不存在）整段跳过': /IfFileExists[^\n]*\b0\s+\w+/.test(body),
    '等待按时间设限（GetTickCount + 两个 IntCmp 阈值：放开下限与总上限）':
      /GetTickCount/.test(body) && (body.match(/IntCmp\s+\$\w+\s+\d{3,}/g) || []).length >= 2,
    '没有固定盲等（Sleep 毫秒合计 ≤ 600）': sleepTotal <= 600,
  };
}

// 变异 A：历史上真用过的固定盲等
const MUTANT_SLEEP = `!macro customCheckAppRunning
  IfFileExists "$INSTDIR\\x.exe" 0 Done
  nsExec::Exec \`taskkill /F /T /IM "x.exe"\`
  Pop $0
  Sleep 2000
  nsExec::Exec \`taskkill /F /T /IM "x.exe"\`
  Pop $0
  Sleep 500
  Done:
!macroend
`;

// 变异 B：先探锁、没锁就不杀（实测会假阴性放行）
const MUTANT_PROBE_FIRST = `!macro customCheckAppRunning
  Push $R6
  IfFileExists "$INSTDIR\\x.exe" 0 Done
  ClearErrors
  FileOpen $R6 "$INSTDIR\\x.exe" a
  IfErrors 0 Free
  nsExec::Exec \`taskkill /F /T /IM "x.exe"\`
  Pop $0
  nsExec::Exec \`taskkill /F /T /IM "x.exe"\`
  Pop $0
  Free:
    FileClose $R6
  Done:
    Pop $R6
!macroend
`;

let fail = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'RED '} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fail++;
}

const body = macroBody(fs.readFileSync(NSH, 'utf8'));
check('build/installer.nsh 里 customCheckAppRunning 宏存在', body != null);
if (body) for (const [k, v] of Object.entries(judge(body))) check(k, v);

const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'));
check(
  'package.json build.nsis.include 仍指向 build/installer.nsh',
  !!(pkg.build && pkg.build.nsis) && /installer\.nsh$/.test(pkg.build.nsis.include || ''),
  pkg.build && pkg.build.nsis ? String(pkg.build.nsis.include) : '没有 nsis 配置',
);

// 变异对照：每份变异必须被它「该中」的那条判据抓红。全都红说明判据不区分东西，
// 一个都不红说明判据空转。
function mutantReport(label, text, mustFailPrefix) {
  const res = judge(macroBody(text));
  const key = Object.keys(res).find((k) => k.startsWith(mustFailPrefix));
  const failed = Object.entries(res)
    .filter(([, v]) => !v)
    .map(([k]) => k.split('（')[0]);
  check(`对照 ${label} → 抓红于「${mustFailPrefix}…」`, !!key && res[key] === false, failed.join(' / ') || '一条都没红（判据空转）');
}

mutantReport('A 退回 Sleep 2000+500', MUTANT_SLEEP, '没有固定盲等');
mutantReport('B 先探锁才决定杀不杀', MUTANT_PROBE_FIRST, '强杀在等待之前');

console.log(
  fail ? `\nRED: ${fail} 项不成立` : '\nGREEN: 结构判据全过（时延与锁场景判据请另跑 tools/installer-wait-probe.cjs）',
);
process.exit(fail ? 1 : 0);
