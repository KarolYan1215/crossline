<#
  Registers the Windows Scheduled Task that keeps Crossline resident.

  Two triggers, because one is not enough: at logon to bring it up, and a repeating one so a crashed
  web app or worker comes back without waiting for the next sign-in. The machine this targets stays
  on around the clock, so "it restarts at logon" would mean "it never restarts".
#>
param(
  [string]$RepoRoot,
  [int]$WatchdogMinutes = 15
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$launcher = Join-Path $repo 'scripts\start-crossline.ps1'
# `conhost --headless` hosts PowerShell with no window at all. Run directly, powershell.exe opened a console every
# 15 minutes on top of whatever the person was doing (`-WindowStyle Hidden` still flashes one, and a Windows Terminal
# default host ignores it). The task must stay an interactive-logon one: notifications and the screen-activity reader
# need the person's desktop session.
$hidden = "--headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass"
$action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "$hidden -File `"$launcher`" -RepoRoot `"$repo`""

$atLogon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
# 3650 days rather than TimeSpan::MaxValue: older Task Scheduler builds reject the latter, and ten
# years of repetition is indistinguishable from forever for this purpose.
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes $WatchdogMinutes) `
  -RepetitionDuration (New-TimeSpan -Days 3650)

# IgnoreNew so a slow launcher run cannot stack copies of itself; the launcher is idempotent anyway.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 0)

Register-ScheduledTask -TaskName 'Crossline' `
  -Description 'Keeps the local Crossline PWA and worker running, and restarts them if they stop.' `
  -Action $action -Trigger @($atLogon, $watchdog) -Settings $settings -User $env:USERNAME -Force | Out-Null
# The daily encrypted backup has its own registration script, so the task is defined in one place.
& (Join-Path $PSScriptRoot 'install-backup-schedule.ps1') -RepoRoot $repo
Write-Output "Crossline startup task installed (logon + every $WatchdogMinutes minutes), and the daily backup."
