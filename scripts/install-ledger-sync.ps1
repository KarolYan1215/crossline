<#
  Registers a Windows Scheduled Task that runs scripts/ledger-sync.ts every hour (docs/ledger-sync.md): the owner's ledger here and
  on the hosted server are compared by the person's latest own action and the newer side is copied over the other. Runs as the
  interactive user because the SSH key and the resident app are this user's; StartWhenAvailable fires a missed run at the next logon.

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-ledger-sync.ps1 [-IntervalMinutes 60]
#>
param(
  [string]$RepoRoot,
  [int]$IntervalMinutes = 60
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source
$logDir = Join-Path $repo 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'ledger-sync.log'
# A cmd line so stdout and stderr land in one log the person can read after a silent run, hosted by `conhost --headless` as
# install-startup.ps1 does: run directly, cmd.exe opened a console window on top of whatever the person was doing every interval
# (2026-10-20, every 15 minutes).
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -WorkingDirectory $repo `
  -Argument "--headless cmd.exe /c `"`"$pnpm`" exec tsx scripts\ledger-sync.ts >> `"$log`" 2>&1`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName 'Crossline Ledger Sync' `
  -Description 'Keeps the Crossline ledger the same on this machine and on the hosted server (newer side wins).' `
  -Action $action -Trigger $trigger -Settings $settings -User $env:USERNAME -Force | Out-Null
Write-Output "Crossline ledger sync task installed (every $IntervalMinutes min; log: $log)."
