param(
  [string]$RepoRoot = (Split-Path -Parent $PSScriptRoot),
  [string]$BackupDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) 'backups'),
  # The data directory holding crossline.db and auth.db. Left empty, it is found (see Resolve-DataDirectory):
  # CROSSLINE_DATA_DIR, else the installed app's %LOCALAPPDATA%\Crossline\data, else <repo>\data.
  [string]$DataDirectory,
  # How many encrypted backups to keep; older ones are deleted after a new one verifies. 0 keeps everything.
  [int]$Keep = 0
)

# What went wrong before 2026-11-25, and why this script is shaped the way it is:
#   - The scheduled task ran `pnpm export` against <repo>\data, the development ledger, while the person's real ledger
#     is the installed app's. And `export` refuses a ledger with two workspaces, which the development ledger has had
#     since 2026-10-10: from that night on no backup was written.
#   - The task runs under `conhost --headless` (no window), which always exits 0 whatever PowerShell returns, so Task
#     Scheduler showed "0" every night. The exit code is still set, but the record that counts is backup.log in the
#     backup directory, and a Windows notification on failure.

$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $BackupDirectory | Out-Null
$logPath = Join-Path $BackupDirectory 'backup.log'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$staging = Join-Path $BackupDirectory "staging-$stamp"
$zip = Join-Path $BackupDirectory "crossline-$stamp.zip"
$encrypted = Join-Path $BackupDirectory "crossline-$stamp.crossline"

function Write-BackupLog([string]$Line) {
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') $Line" -Encoding UTF8
}

# One Windows notification through the WinRT API already on the machine (the same route apps/worker/src/notify.ts takes).
# Best effort: a notification that cannot be shown must not hide the failure it reports.
function Show-FailureToast([string]$Body) {
  try {
    [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
    [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
    $escape = { param($t) [System.Security.SecurityElement]::Escape($t) }
    $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
    $doc.LoadXml("<toast><visual><binding template=`"ToastGeneric`"><text>Crossline 备份失败</text><text>$(& $escape $Body)</text></binding></visual></toast>")
    $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)
    [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show($toast)
  } catch { Write-BackupLog "通知未能显示：$($_.Exception.Message)" }
}

function Resolve-DataDirectory([string]$Repo) {
  if (-not [string]::IsNullOrWhiteSpace($DataDirectory)) { return $DataDirectory }
  if ($env:CROSSLINE_DATA_DIR) { return $env:CROSSLINE_DATA_DIR }
  # The installed app (installer/crossline.iss) is the one this machine runs; its location does not move between
  # versions, so finding it here keeps the scheduled task's arguments from drifting away from the real ledger again.
  $installed = Join-Path $env:LOCALAPPDATA 'Crossline\data'
  if (Test-Path -LiteralPath (Join-Path $installed 'crossline.db')) { return $installed }
  return (Join-Path $Repo 'data')
}

# Runs a native command with stderr allowed: under 'Stop', PowerShell 5.1 turns a native command's stderr line into a
# terminating error whenever stderr is redirected (every non-interactive host), before $LASTEXITCODE can be read.
function Invoke-Native([string]$What, [scriptblock]$Command) {
  $output = & { $ErrorActionPreference = 'Continue'; & $Command 2>&1 }
  if ($LASTEXITCODE -ne 0) {
    $detail = ($output | ForEach-Object { "$_" } | Where-Object { $_ -match '"code"|Error|error' } | Select-Object -Last 1)
    throw "$What 失败（退出码 $LASTEXITCODE）$(if ($detail) { "：$detail" })"
  }
  return $output
}

function Get-Sha256Hex([byte[]]$Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '') }
  finally { $sha.Dispose() }
}

$failure = $null
$result = $null
$data = $null
try {
  $repo = (Resolve-Path -LiteralPath $RepoRoot).Path
  $data = Resolve-DataDirectory $repo
  if (-not (Test-Path -LiteralPath $data)) { throw "数据目录不存在：$data" }
  $data = (Resolve-Path -LiteralPath $data).Path
  New-Item -ItemType Directory -Force -Path $staging | Out-Null

  # Both databases by SQLite's online backup and one JSON snapshot per workspace (scripts/snapshot-ledger.ts).
  $snapshotOutput = Invoke-Native '账本快照' { pnpm --dir $repo exec tsx scripts/snapshot-ledger.ts $data $staging }
  $snapshot = ($snapshotOutput | ForEach-Object { "$_" } | Where-Object { $_ -like '*snapshot.completed*' } | Select-Object -Last 1) | ConvertFrom-Json

  # What Codex remembers across runs (scripts/copy-codex-memory.ts), never its login token. The installed app keeps
  # its Codex home under state\ beside data\.
  $codexHome = Join-Path (Split-Path -Parent $data) 'state\codex-home'
  if (Test-Path -LiteralPath $codexHome) { $env:CROSSLINE_CODEX_HOME = $codexHome }
  Invoke-Native 'Codex 记忆复制' { pnpm --dir $repo exec tsx scripts/copy-codex-memory.ts (Join-Path $staging 'codex-memory') } | Out-Null

  # The person's files the ledger points at. Not secrets\, launcher-secrets.json or push-vapid.json: a backup is a
  # file that travels, and keys do not belong in one.
  foreach ($folder in @('materials', 'sources', 'portrait')) {
    $from = Join-Path $data $folder
    if (-not (Test-Path -LiteralPath $from)) { continue }
    & robocopy.exe $from (Join-Path $staging $folder) /E /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "复制 $folder 失败（robocopy $LASTEXITCODE）" }
  }
  @{ dataDirectory = $data; takenAt = (Get-Date).ToString('o'); computer = $env:COMPUTERNAME; workspaces = $snapshot.workspaces; auth = $snapshot.auth } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $staging 'backup-info.json') -Encoding UTF8

  # Not Compress-Archive: in Windows PowerShell 5.1 it names entries with backslashes, which other unzip tools read as
  # file names rather than folders.
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  [System.IO.Compression.ZipFile]::CreateFromDirectory($staging, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)

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
  if ($sourceHash -ne (Get-Sha256Hex $verifiedBytes)) { throw '加密后解密校验不一致。' }
  if ($Keep -gt 0) {
    Get-ChildItem -LiteralPath $BackupDirectory -Filter 'crossline-*.crossline' | Sort-Object Name -Descending |
      Select-Object -Skip $Keep | Remove-Item -Force -ErrorAction SilentlyContinue
  }
  $result = [pscustomobject]@{ Backup = $encrypted; Sha256 = $sourceHash; Verified = $true; DataDirectory = $data
    Workspaces = @($snapshot.workspaces).Count; Bytes = $protectedBytes.Length }
} catch {
  $failure = $_
} finally {
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
  if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($failure) {
  Remove-Item -LiteralPath $encrypted -Force -ErrorAction SilentlyContinue
  $message = $failure.Exception.Message -replace '\s+', ' '
  Write-BackupLog "失败 数据目录=$data 原因=$message"
  Show-FailureToast "$message 记录在 $logPath"
  Write-Error "Crossline backup failed: $message" -ErrorAction Continue
  exit 1
}
Write-BackupLog "成功 $($result.Backup) 数据目录=$data 工作区=$($result.Workspaces) 字节=$($result.Bytes) sha256=$($result.Sha256)"
Write-Output $result
exit 0
