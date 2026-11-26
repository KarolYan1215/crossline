<#
  Registers the daily Windows Scheduled Task that runs backup-crossline.ps1. The one place this task is defined;
  install-startup.ps1 calls it.

  Runs as the interactive user (not SYSTEM, not "whether logged on or not") because the backup's DPAPI encryption
  is scoped to CurrentUser — a different account, or a logon without the password, could not encrypt or decrypt
  it. StartWhenAvailable means a missed run (machine off or asleep at the trigger time) fires as soon as possible
  rather than waiting a full day.

  The task passes no data directory: backup-crossline.ps1 finds the installed app's %LOCALAPPDATA%\Crossline\data
  itself, so reinstalling or upgrading the app cannot leave the task pointing somewhere else. Under
  `conhost --headless` (no window) Task Scheduler's "Last Result" is always 0; the record that counts is
  backup.log in the backup directory, and a failure also shows a Windows notification.
#>
param(
  [string]$RepoRoot,
  [int]$BackupHour = 3,
  [int]$Keep = 14
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$backupScript = Join-Path $repo 'scripts\backup-crossline.ps1'
$hidden = '--headless powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass'
$action = New-ScheduledTaskAction -Execute 'conhost.exe' `
  -Argument "$hidden -File `"$backupScript`" -RepoRoot `"$repo`" -Keep $Keep"

$daily = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour $BackupHour -Minute 0 -Second 0)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName 'Crossline Backup' `
  -Description "Daily encrypted backup of the installed Crossline ledger, login database, files and Codex memory; keeps the last $Keep. Results in backups\backup.log." `
  -Action $action -Trigger $daily -Settings $settings -User $env:USERNAME -Force | Out-Null
Write-Output "Crossline daily backup task installed (runs at $($BackupHour):00, or as soon as possible if missed; keeps $Keep)."
