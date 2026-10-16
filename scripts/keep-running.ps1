<#
  Keeps one resident process (the web app or the worker) running: starts it, waits for it to exit, writes the exit to
  data\logs\restarts.log and starts it again a few seconds later.

  The 15-minute watchdog (start-crossline.ps1 on a timer) was the only restart, so a crash left the app down for up to fifteen
  minutes — the web died with 0xC0000409 at 02:38 and 19:32 on 2026-10-15 and nothing printed why. The watchdog stays as the
  fallback for this loop itself; the loop holds data\<name>.keeper.lock so the watchdog never starts a second one.
#>
param(
  [Parameter(Mandatory)][ValidateSet('web', 'worker')][string]$Name,
  [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$logDir = Join-Path $repo 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$env:CROSSLINE_NEXT_DIR = '.next-prod'
$arguments = if ($Name -eq 'web') { @('--dir', $repo, '--filter', '@crossline/web', 'start') } else { @('--dir', $repo, 'worker:start') }
Set-Content -LiteralPath (Join-Path $repo "data\$Name.keeper.lock") -Value $PID -Encoding ascii

# Start-Process truncates its redirect files, so the run that just ended keeps its log under a timestamp (the last five).
function Save-PreviousLogs {
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  foreach ($suffix in @('log', 'err.log')) {
    $current = Join-Path $logDir "$Name.$suffix"
    if ((Test-Path -LiteralPath $current) -and (Get-Item -LiteralPath $current).Length -gt 0) {
      try { Move-Item -LiteralPath $current -Destination (Join-Path $logDir "$Name.$stamp.$suffix") -Force } catch { }
    }
    Get-ChildItem -LiteralPath $logDir -Filter "$Name.*.$suffix" | Where-Object { $_.Name -match "^$Name\.\d{8}-\d{6}\.$([regex]::Escape($suffix))$" } |
      Sort-Object Name -Descending | Select-Object -Skip 5 | Remove-Item -Force
  }
}

$quickExits = 0
while ($true) {
  Save-PreviousLogs
  $started = Get-Date
  $child = Start-Process -FilePath $pnpm -ArgumentList $arguments -WorkingDirectory $repo -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir "$Name.log") -RedirectStandardError (Join-Path $logDir "$Name.err.log")
  $null = $child.Handle  # without holding the handle, Windows PowerShell reports no ExitCode after the process ends
  $child.WaitForExit()
  $code = $child.ExitCode
  $ranMinutes = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)
  Add-Content -LiteralPath (Join-Path $logDir 'restarts.log') -Encoding utf8 `
    -Value ("{0} {1} exited code={2} (0x{3:X8}) after {4} min" -f (Get-Date -Format 's'), $Name, $code, $code, $ranMinutes)
  # A process that keeps dying at once (a broken build, a held port) is retried more slowly, up to a minute apart.
  if ($ranMinutes -lt 1) { $quickExits++ } else { $quickExits = 0 }
  Start-Sleep -Seconds ([math]::Min(60, 5 * [math]::Pow(2, [math]::Min($quickExits, 4))))
}
