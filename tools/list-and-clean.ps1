# ASCII only (PowerShell 5.1 mis-decodes BOM-less UTF-8).
# List AgentHub instances (pid/ppid/path). With -KillTemp <temp-userdata-path>, stop ONLY the
# instances whose command line contains that exact temp userData path (substring -like match).
# NEVER kill by process name alone.
# KILL-GUARD NOTE (phase-1 incident): an empty -KillTemp MUST mean "list only, kill nothing".
# In PowerShell, `$p -ne ''` is TRUE when $p is $null ($null and '' are different values), so the
# old guard `if ($p -ne '')` passed on null/empty and `-like '*'` matched EVERY instance -- one
# run killed all running AgentHub.exe processes. The guard below short-circuits on null/empty/
# whitespace ($KillTemp -and $KillTemp.Trim() -ne ''), so an empty parameter can never enter the
# kill branch. Do not "simplify" it back to a single -ne comparison.
param([string]$KillTemp = '')
$procs = Get-CimInstance Win32_Process -Filter "Name='AgentHub.exe'"
foreach ($p in $procs) {
  Write-Output ("pid=" + $p.ProcessId + " ppid=" + $p.ParentProcessId + " exe=" + $p.ExecutablePath)
}
Write-Output ("count=" + ($procs | Measure-Object).Count)
if ($KillTemp -and $KillTemp.Trim() -ne '') {
  $like = '*' + $KillTemp + '*'
  $targets = $procs | Where-Object { $_.CommandLine -like $like }
  foreach ($t in $targets) {
    Write-Output ("killing " + $t.ProcessId)
    Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
  }
  if (($targets | Measure-Object).Count -eq 0) { Write-Output 'no-match-for-temp' }
}
$l = Get-NetTCPConnection -LocalPort 9527 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($l) { Write-Output ('9527 LISTEN pid=' + $l.OwningProcess) } else { Write-Output '9527 not listening' }
$l2 = Get-NetTCPConnection -LocalPort 9528 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($l2) { Write-Output ('9528 LISTEN pid=' + $l2.OwningProcess) } else { Write-Output '9528 not listening' }
