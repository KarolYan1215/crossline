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
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`" -RepoRoot `"$repo`""

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
Write-Output "Crossline startup task installed (logon + every $WatchdogMinutes minutes)."
