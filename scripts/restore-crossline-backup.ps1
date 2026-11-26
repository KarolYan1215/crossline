<#
  Decrypts a Crossline backup and rebuilds working databases from it — the main ledger, and (if the
  backup carries one — stage six) `auth.db`, Better Auth's own SQLite file.

  Decrypting and unzipping only proves the file is readable. The drill this script performs is the
  one that matters: rebuild a real SQLite ledger from the snapshot and read every table back out, and
  separately read `auth.db`'s own tables back out through a fresh connection.

  The live ledger and the live `auth.db` are never touched. Every rebuild lands on a new file under
  -OutputDirectory, and replacing data\crossline.db or data\auth.db with it stays a deliberate manual act.
#>
param(
  [Parameter(Mandatory = $true)][string]$BackupPath,
  [string]$OutputDirectory,
  [string]$RepoRoot
)

$ErrorActionPreference = 'Stop'
# $PSScriptRoot is not reliably populated while param defaults are evaluated in Windows PowerShell,
# so the repo root is resolved here rather than in the param block.
if ([string]::IsNullOrWhiteSpace($RepoRoot)) { $RepoRoot = Split-Path -Parent $PSScriptRoot }
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
  $OutputDirectory = Join-Path $repo 'restored'
}
$source = (Resolve-Path -LiteralPath $BackupPath).Path
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$OutputDirectory = (Resolve-Path -LiteralPath $OutputDirectory).Path

Add-Type -AssemblyName System.Security
$plainBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
  [System.IO.File]::ReadAllBytes($source),
  [System.Text.Encoding]::UTF8.GetBytes('Crossline backup v1'),
  [System.Security.Cryptography.DataProtectionScope]::CurrentUser
)
$zip = Join-Path $OutputDirectory 'crossline-restored.zip'
[System.IO.File]::WriteAllBytes($zip, $plainBytes)
Expand-Archive -LiteralPath $zip -DestinationPath $OutputDirectory -Force
Remove-Item -LiteralPath $zip -Force

# A backup since 2026-11-25 carries one crossline-<workspace>.json per workspace, plus crossline.db (SQLite's online
# backup of the whole ledger), auth.db, backup-info.json and the materials/sources/portrait folders. Older ones carry a
# single crossline-<time>.json and auth-<time>.db. Every snapshot is rebuilt and read back.
$snapshots = @(Get-ChildItem -LiteralPath $OutputDirectory -Filter 'crossline-*.json' | Sort-Object Name)
if ($snapshots.Count -eq 0) { throw 'Backup contained no crossline-*.json snapshot.' }
# Present only for a backup taken after a real login had completed — `backup-crossline.ps1` skips it
# entirely on a fresh install with no `auth.db` yet, which is not itself a restore failure.
$authDb = Get-ChildItem -LiteralPath $OutputDirectory -Filter 'auth*.db' -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notlike 'auth-restored-*' } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$info = Join-Path $OutputDirectory 'backup-info.json'
$backupInfo = if (Test-Path -LiteralPath $info) { Get-Content -LiteralPath $info -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }
$ledgerCopy = Join-Path $OutputDirectory 'crossline.db'

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$restored = @()
foreach ($json in $snapshots) {
  $name = $json.BaseName -replace '^crossline-', ''
  $targetDb = Join-Path $OutputDirectory "crossline-restored-$name-$stamp.db"
  # pnpm writes its banner to stderr. Under `$ErrorActionPreference = 'Stop'`, PowerShell 5.1 turns a
  # native command's stderr line into a terminating NativeCommandError whenever stderr is redirected —
  # which is exactly what happens under a scheduled task or any non-interactive host. The script then
  # died before it could read $LASTEXITCODE, so the backup worked by hand and silently never ran
  # unattended. The exit code is the authority here, so stderr must not be allowed to pre-empt it.
  $restoreOutput = & { $ErrorActionPreference = 'Continue'; & pnpm --dir $repo restore -- $json.FullName $targetDb 2>&1 }
  if ($LASTEXITCODE -ne 0) { throw "Restore verification failed for $($json.Name); the backup did not rebuild a readable ledger." }
  $text = ($restoreOutput | ForEach-Object { "$_" }) -join "`n"
  $completed = if ($text -match '(?s)\{\s*"status": "restore\.completed".*?\n\}') { $Matches[0] | ConvertFrom-Json } else { $null }
  $restored += [pscustomobject]@{ Snapshot = $json.Name; Database = $targetDb; WorkspaceId = $completed.workspaceId
    Events = $completed.counts.events; WorkOrders = $completed.counts.workOrders; Milestones = $completed.counts.milestones
    Rows = $completed.counts.rows }
  # The backup script goes to the trouble of shredding its plaintext temp file; leaving the decrypted
  # snapshot behind here would quietly undo that. The rebuilt database is the artifact worth keeping.
  Remove-Item -LiteralPath $json.FullName -Force
}

$authDbTarget = $null
$authDbCounts = $null
if ($null -ne $authDb) {
  $authDbTarget = Join-Path $OutputDirectory "auth-restored-$stamp.db"
  Copy-Item -LiteralPath $authDb.FullName -Destination $authDbTarget
  # Reading every table back out through better-sqlite3, the same drill the ledger restore does above —
  # decrypting and unzipping only proves the file is readable, not that a working database comes out of it.
  $countsOutput = & { $ErrorActionPreference = 'Continue'; & pnpm --dir $repo exec tsx scripts/read-auth-db-counts.ts $authDbTarget }
  if ($LASTEXITCODE -ne 0) { throw 'auth.db restore read-back failed.' }
  $authDbCounts = ($countsOutput | Select-Object -Last 1) | ConvertFrom-Json
  Remove-Item -LiteralPath $authDb.FullName -Force
}

Write-Output ([pscustomobject]@{
  SnapshotPlaintextRemoved = $true
  TakenFrom           = if ($backupInfo) { $backupInfo.dataDirectory } else { $null }
  TakenAt             = if ($backupInfo) { $backupInfo.takenAt } else { $null }
  Restored            = $restored
  LedgerCopy          = if (Test-Path -LiteralPath $ledgerCopy) { $ledgerCopy } else { $null }
  Verified            = $true
  LiveLedgerUntouched = $true
  AuthDbRestored      = $null -ne $authDbTarget
  AuthDbPath          = $authDbTarget
  AuthDbCounts        = $authDbCounts
})
