param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$BackupDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups')
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath $RepoRoot).Path
New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$json = Join-Path $BackupDirectory "crossline-$stamp.json"
$zip = Join-Path $BackupDirectory "crossline-$stamp.zip"
$encrypted = Join-Path $BackupDirectory "crossline-$stamp.crossline"

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
  Compress-Archive -LiteralPath $json -DestinationPath $zip -CompressionLevel Optimal

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
  Write-Output ([pscustomobject]@{ Backup = $encrypted; Sha256 = $sourceHash; Verified = $true })
} finally {
  Remove-Item -LiteralPath $json, $zip -Force -ErrorAction SilentlyContinue
}
