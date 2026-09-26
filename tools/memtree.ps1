# 共享采样器：给定根 PID，递归遍历其进程树，按 --type 归类，输出 JSON 行
# 用法: powershell -File memtree.ps1 -RootPid 1234 -Label node-electron -Sample 1
# 内存口径：Get-Process.PrivateMemorySize64（不走 WorkingSet，避免共享页失真）
param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [string]$Label = "run",
  [int]$Sample = 1
)
$ErrorActionPreference = 'SilentlyContinue'

# AgentHub.exe 加入枚举：Task 7 Step 3 采的是打包版（release\win-unpacked\AgentHub.exe）的进程树，
# 打包后所有子进程都改名 AgentHub.exe，只认 electron/node 会让 n 恒等于 1。老口径不受影响。
$all = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe' OR Name='node.exe' OR Name='AgentHub.exe'")
$cmdOf = @{}
foreach ($p in $all) { $cmdOf[[string]$p.ProcessId] = [string]$p.CommandLine }

# 递归收集后代 PID
$pids = @($RootPid)
$frontier = @($RootPid)
while ($frontier.Count -gt 0) {
  $next = @()
  foreach ($f in $frontier) {
    foreach ($k in $all) {
      if ([int]$k.ParentProcessId -eq [int]$f) {
        $kid = [int]$k.ProcessId
        if ($pids -notcontains $kid) { $pids += $kid; $next += $kid }
      }
    }
  }
  $frontier = $next
}

function Get-Kind($pid_, $cmdline) {
  if ($cmdline -match '--type=([a-z\-]+)') {
    $t = $Matches[1]
    if ($t -eq 'gpu-process') { return 'gpu' }
    if ($t -eq 'renderer') { return 'renderer' }
    if ($t -eq 'utility') {
      if ($cmdline -match '--utility-sub-type=([a-z\-\.]+)') { return "utility-$($Matches[1])" }
      return 'utility'
    }
    return $t
  }
  return 'main'
}

$totPriv = 0.0
$totWs = 0.0
$n = 0
foreach ($id in $pids) {
  $gp = Get-Process -Id $id
  if ($null -eq $gp) { continue }
  $priv = [math]::Round($gp.PrivateMemorySize64 / 1MB, 2)
  $ws = [math]::Round($gp.WorkingSet64 / 1MB, 2)
  $kind = Get-Kind $id $cmdOf[[string]$id]
  $totPriv += $priv; $totWs += $ws; $n += 1
  $obj = [ordered]@{ label = $Label; sample = $Sample; kind = $kind; pid = $id; priv = $priv; ws = $ws }
  Write-Output (ConvertTo-Json -InputObject $obj -Compress)
}
$sum = [ordered]@{ label = $Label; sample = $Sample; kind = 'TOTAL'; pid = 0; n = $n; priv = [math]::Round($totPriv, 2); ws = [math]::Round($totWs, 2) }
Write-Output (ConvertTo-Json -InputObject $sum -Compress)
