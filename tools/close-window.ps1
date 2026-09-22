# Posts WM_CLOSE (0x0010) to the visible top-level window of ONE given PID.
# Rationale: synthetic SetCursorPos/mouse_event clicks on the native title bar proved
# unreliable on this machine (focus theft). WM_CLOSE is the exact message the user's X click sends.
# ASCII only: PowerShell 5.1 mis-decodes BOM-less UTF-8.
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File close-window.ps1 -ProcId 1234
param(
  [Parameter(Mandatory = $true)][int]$ProcId,
  [string]$TitleMatch = 'AgentHub'
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class Win32CloseProbe {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
}
"@

$script:TargetPid = $ProcId
$script:Match = $TitleMatch
$script:Found = @()

$cb = [Win32CloseProbe+EnumWindowsProc] {
  param($h, $l)
  $owner = [uint32]0
  [void][Win32CloseProbe]::GetWindowThreadProcessId($h, [ref]$owner)
  if ([int]$owner -ne [int]$script:TargetPid) { return $true }
  if (-not [Win32CloseProbe]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 256
  [void][Win32CloseProbe]::GetWindowTextW($h, $sb, 256)
  $cn = New-Object System.Text.StringBuilder 256
  [void][Win32CloseProbe]::GetClassNameW($h, $cn, 256)
  $title = $sb.ToString()
  if ($title -notlike "*$($script:Match)*") { return $true }
  $ok = [Win32CloseProbe]::PostMessageW($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  $script:Found += [ordered]@{
    hwnd      = $h.ToInt64()
    className = $cn.ToString()
    title     = $title
    posted    = [bool]$ok
  }
  return $true
}

[void][Win32CloseProbe]::EnumWindows($cb, [IntPtr]::Zero)

foreach ($r in $script:Found) {
  $r.kind = 'wm-close-posted'
  Write-Output (ConvertTo-Json -InputObject $r -Compress)
}
if ($script:Found.Count -eq 0) {
  Write-Output (ConvertTo-Json -InputObject ([ordered]@{ kind = 'error'; msg = 'no-visible-window-for-pid'; pid = $ProcId }) -Compress)
  exit 2
}
if ($script:Found.Count -gt 1) {
  Write-Output (ConvertTo-Json -InputObject ([ordered]@{ kind = 'warn'; msg = 'more-than-one-visible-window'; count = $script:Found.Count }) -Compress)
  exit 3
}
