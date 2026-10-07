param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$BackupDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups'),
  # Matches `apps/web/lib/auth.ts`'s own default (`CROSSLINE_DATA_DIR`, else `<repo>/data`) — both
  # databases live side by side, so one data directory locates both.
  [string]$DataDirectory,
  # How many encrypted backups to keep; older ones are deleted after a new one verifies. 0 keeps everything.
  [int]$Keep = 0
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
if ([string]::IsNullOrWhiteSpace($DataDirectory)) {
  $DataDirectory = if ($env:CROSSLINE_DATA_DIR) { $env:CROSSLINE_DATA_DIR } else { Join-Path $repo 'data' }
}
New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$json = Join-Path $BackupDirectory "crossline-$stamp.json"
$authDbCopy = Join-Path $BackupDirectory "auth-$stamp.db"
$zip = Join-Path $BackupDirectory "crossline-$stamp.zip"
$encrypted = Join-Path $BackupDirectory "crossline-$stamp.crossline"
$codexMemory = Join-Path $BackupDirectory "codex-memory-$stamp"

function Get-Sha256Hex([byte[]]$Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '') }
  finally { $sha.Dispose() }
}

try {
  # pnpm writes its banner to stderr. Under `$ErrorActionPreference = 'Stop'`, PowerShell 5.1 turns a
  # native command's stderr line into a terminating NativeCommandError whenever stderr is redirected —
  # which is exactly what happens under a scheduled task or any non-interactive host. The script then
  # died before it could read $LASTEXITCODE, so the backup worked by hand and silently never ran
  # unattended. The exit code is the authority here, so stderr must not be allowed to pre-empt it.
  & { $ErrorActionPreference = 'Continue'; & pnpm --dir $repo export -- $json }
  if ($LASTEXITCODE -ne 0) { throw 'Crossline JSON export failed.' }

  # `auth.db` (Better Auth's own SQLite file — user/session/account/verification) has no export/import
  # concept of its own, unlike the main ledger; a backup that carries only the ledger restores real
  # workspace data with no way back into any account. Missing entirely on a fresh install that has never
  # completed a real login, which is not a backup failure.
  $authDbSource = Join-Path $DataDirectory 'auth.db'
  $authDbIncluded = $false
  if (Test-Path -LiteralPath $authDbSource) {
    & { $ErrorActionPreference = 'Continue'; & pnpm --dir $repo exec tsx scripts/checkpoint-auth-db.ts $authDbSource $authDbCopy }
    if ($LASTEXITCODE -ne 0) { throw 'auth.db checkpoint failed.' }
    $authDbIncluded = $true
  }

  # What Codex remembers across runs lives in its own CODEX_HOME, outside the ledger (see scripts/copy-codex-memory.ts). Not its
  # login token. A machine where the assistant has never run has none, which is not a backup failure.
  & { $ErrorActionPreference = 'Continue'; & pnpm --dir $repo exec tsx scripts/copy-codex-memory.ts $codexMemory }
  if ($LASTEXITCODE -ne 0) { throw 'Codex memory copy failed.' }

  $toArchive = @($json)
  if ($authDbIncluded) { $toArchive += $authDbCopy }
  if (Test-Path -LiteralPath $codexMemory) { $toArchive += $codexMemory }
  Compress-Archive -LiteralPath $toArchive -DestinationPath $zip -CompressionLevel Optimal

  Add-Type -AssemblyName System.Security
  $plainBytes = [System.IO.File]::ReadAllBytes($zip)
  $protectedBytes = [System.Security.Cryptography.ProtectedData]::Protect(
    $plainBytes,
    [System.Text.Encoding]::UTF8.GetBytes('Crossline backup v1'),
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  [System.IO.File]::WriteAllBytes($encrypted, $protectedBytes)
  $verifiedBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
    [System.IO.File]::ReadAllBytes($encrypted),
    [System.Text.Encoding]::UTF8.GetBytes('Crossline backup v1'),
    [System.Security.Cryptography.DataProtectionScope]::CurrentUser
  )
  $sourceHash = Get-Sha256Hex $plainBytes
  $verifyHash = Get-Sha256Hex $verifiedBytes
  if ($sourceHash -ne $verifyHash) { throw 'Encrypted backup verification failed.' }
  if ($Keep -gt 0) {
    Get-ChildItem -LiteralPath $BackupDirectory -Filter 'crossline-*.crossline' | Sort-Object Name -Descending |
      Select-Object -Skip $Keep | Remove-Item -Force -ErrorAction SilentlyContinue
  }
  Write-Output ([pscustomobject]@{ Backup = $encrypted; Sha256 = $sourceHash; Verified = $true })
} finally {
  Remove-Item -LiteralPath $json, $zip -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $authDbCopy) { Remove-Item -LiteralPath $authDbCopy -Force -ErrorAction SilentlyContinue }
  if (Test-Path -LiteralPath $codexMemory) { Remove-Item -LiteralPath $codexMemory -Recurse -Force -ErrorAction SilentlyContinue }
}
