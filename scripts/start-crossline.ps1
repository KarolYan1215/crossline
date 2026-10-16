<#
  Starts the built Crossline web app and worker. Safe to run repeatedly.

  Each process runs inside keep-running.ps1, which restarts it a few seconds after it exits. The scheduled
  task re-runs this script every fifteen minutes as the fallback for those loops: a loop that is still
  alive is left alone, one that is gone is started again.
#>
param([string]$RepoRoot)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot is not reliably populated while param defaults are evaluated in Windows PowerShell.
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
# The resident app is served from its own build directory, so `pnpm build`/`pnpm verify` (which write `.next`) can run while it is up
# without replacing the files it is serving. `pnpm build:prod` writes this one.
$env:CROSSLINE_NEXT_DIR = '.next-prod'
$buildId = Join-Path $repo 'apps\web\.next-prod\BUILD_ID'
if (-not (Test-Path -LiteralPath $buildId)) { throw 'Production build missing. Run pnpm build:prod first.' }
$logDir = Join-Path $repo 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-PortListening([int]$Port) {
  try { return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop) }
  catch { return $false }
}

# Each process runs under its own keep-running.ps1 loop, which restarts it seconds after it exits and records why in
# data\logs\restarts.log. This script only makes sure each loop exists, so the timer is the fallback for the loop itself.
function Test-KeeperAlive([string]$Name) {
  $lock = Join-Path $repo "data\$Name.keeper.lock"
  if (-not (Test-Path -LiteralPath $lock)) { return $false }
  $held = (Get-Content -LiteralPath $lock -Raw).Trim() -as [int]
  if (-not $held) { return $false }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$held" -ErrorAction SilentlyContinue
  return $null -ne $process -and $process.CommandLine -match 'keep-running\.ps1'
}

function Start-Keeper([string]$Name) {
  Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -WorkingDirectory $repo `
    -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'keep-running.ps1'), '-Name', $Name, '-RepoRoot', $repo
}

# A free supervisor port does not prove the worker is dead (when Codex fails to start the worker keeps running without binding
# anything), so the worker's own heartbeat lock in data\worker.lock decides, read here the way the worker reads it: a live PID with
# a heartbeat younger than three tick intervals means it is running. A process started by hand, outside a keeper, is left alone until
# it stops; the next run of this script then puts it under a keeper.
function Test-WorkerAlive {
  $lock = Join-Path $repo 'data\worker.lock'
  if (-not (Test-Path -LiteralPath $lock)) { return $false }
  try {
    $held = Get-Content -LiteralPath $lock -Raw | ConvertFrom-Json
    $interval = 15
    if ($env:CROSSLINE_SYNC_INTERVAL_MINUTES -as [int]) { $interval = [int]$env:CROSSLINE_SYNC_INTERVAL_MINUTES }
    $age = (Get-Date).ToUniversalTime() - ([datetime]::Parse($held.heartbeatAt)).ToUniversalTime()
    $alive = $null -ne (Get-Process -Id ([int]$held.pid) -ErrorAction SilentlyContinue)
    return $alive -and $age.TotalMinutes -ge 0 -and $age.TotalMinutes -lt (3 * $interval)
  } catch { return $false }
}

$webKept = Test-KeeperAlive 'web'
$webWasUp = $webKept -or (Test-PortListening 3210)
if (-not $webWasUp) { Start-Keeper 'web' }

$workerKept = Test-KeeperAlive 'worker'
$workerWasUp = $workerKept -or (Test-WorkerAlive)
if (-not $workerWasUp) { Start-Keeper 'worker' }

Write-Output ([pscustomobject]@{
  WebAlreadyRunning    = $webWasUp
  WebStarted           = -not $webWasUp
  WorkerAlreadyRunning = $workerWasUp
  WorkerLaunched       = -not $workerWasUp
  LogDirectory         = $logDir
})
