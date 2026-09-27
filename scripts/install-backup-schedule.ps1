<#
  Registers a daily Windows Scheduled Task that runs backup-crossline.ps1.

  Runs as the interactive user (not SYSTEM) because the backup's DPAPI encryption is scoped to
  CurrentUser — a different account, or SYSTEM, could not decrypt what this produces. StartWhenAvailable
  means a missed run (machine off or asleep at the trigger time) fires as soon as the user next logs on,
  rather than waiting a full day for the next scheduled time.
#>
param(
  [string]$RepoRoot,
  [int]$BackupHour = 3
)

$ErrorActionPreference = 'Stop'
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
$backupScript = Join-Path $repo 'scripts\backup-crossline.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$backupScript`" -RepoRoot `"$repo`""

$daily = New-ScheduledTaskTrigger -Daily -At (Get-Date -Hour $BackupHour -Minute 0 -Second 0)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName 'Crossline Backup' `
  -Description 'Daily encrypted backup of the Crossline ledger and auth database.' `
  -Action $action -Trigger $daily -Settings $settings -User $env:USERNAME -Force | Out-Null
Write-Output "Crossline daily backup task installed (runs at $($BackupHour):00, or on next logon if missed)."
