<#
  Starts the built Crossline web app and worker. Safe to run repeatedly.

  The scheduled task re-runs this on a timer, so this script is also the watchdog: whatever is still
  healthy is left alone, whatever died is started again. That is the whole restart mechanism — the
  launcher exits as soon as it has spawned its children, so Task Scheduler's own restart settings
  would never fire.
#>
param([string]$RepoRoot)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot is not reliably populated while param defaults are evaluated in Windows PowerShell.
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$buildId = Join-Path $repo 'apps\web\.next\BUILD_ID'
if (-not (Test-Path -LiteralPath $buildId)) { throw 'Production build missing. Run pnpm build first.' }
$logDir = Join-Path $repo 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source

function Test-PortListening([int]$Port) {
  try { return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop) }
  catch { return $false }
}

$webWasUp = Test-PortListening 3210
if (-not $webWasUp) {
  Start-Process -FilePath $pnpm -ArgumentList '--dir', $repo, '--filter', '@crossline/web', 'start' `
    -WorkingDirectory $repo -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'web.log') -RedirectStandardError (Join-Path $logDir 'web.err.log')
}

# The worker is launched unconditionally because a free supervisor port does not prove it is dead:
# when Codex fails to start the worker keeps running without binding anything. It guards itself with
# the heartbeat lock in data\worker.lock and a redundant copy exits immediately with
# `worker.already_running` rather than opening a second SQLite writer.
Start-Process -FilePath $pnpm -ArgumentList '--dir', $repo, 'worker:start' `
  -WorkingDirectory $repo -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logDir 'worker.log') -RedirectStandardError (Join-Path $logDir 'worker.err.log')

Write-Output ([pscustomobject]@{
  WebAlreadyRunning = $webWasUp
  WebStarted        = -not $webWasUp
  WorkerLaunched    = $true
  LogDirectory      = $logDir
})
