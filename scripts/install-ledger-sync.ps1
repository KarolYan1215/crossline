<#
  NOT PART OF NORMAL SETUP ANY MORE (2026-10-22, docs/device-mode.md). The hosted site is the one primary ledger; this computer is a
  device of that account and sends only what it reads on itself. The scheduled whole-ledger copy made both sides' workers run the same
  backplans, step plans and assistant runs on one quota, and then overwrote one side's results. The owner's 「Crossline Ledger Sync」
  task was disabled on 2026-10-22. scripts/ledger-sync.ts stays for a one-off move, run by hand.

  Registers a Windows Scheduled Task that runs scripts/ledger-sync.ts every hour (docs/ledger-sync.md). Refuses unless -IKnowThisSpendsTwice
  is given, so it is never reinstalled by habit.

    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-ledger-sync.ps1 -IKnowThisSpendsTwice [-IntervalMinutes 60]
#>
param(
  [string]$RepoRoot,
  [int]$IntervalMinutes = 60,
  [switch]$IKnowThisSpendsTwice
)

$ErrorActionPreference = 'Stop'
if (-not $IKnowThisSpendsTwice) {
  Write-Error 'The scheduled whole-ledger sync is retired (docs/device-mode.md): link this computer as a device instead (http://127.0.0.1:3210/device). For a one-off move run: pnpm exec tsx scripts\ledger-sync.ts --direction to-server|to-local'
  exit 1
}
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
