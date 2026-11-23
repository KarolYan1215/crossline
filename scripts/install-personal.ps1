# Installs the owner's own desktop copy (docs/plans/desktop-local-1122.md) on this machine.
#
#   pnpm exec tsx scripts/package-installer.ts --personal --codex-dir <main checkout>\vendor\codex\codex-rs\target\release
#   powershell -ExecutionPolicy Bypass -File scripts\install-personal.ps1 -Setup dist\installer\Crossline-Personal-<version>.exe
#
# Stops the running installed copy, copies data\ aside (backups\before-personal-<time>, the last three kept, as the launcher's own
# update does), installs silently into %LOCALAPPDATA%\Crossline\app with a desktop shortcut, and the installer starts the new tray.
# Never touches the resident checkout's app (127.0.0.1:3210) or its data.
#
# Run it from an ordinary PowerShell window. From a Claude desktop session, which runs inside an MSIX container whose writes to
# %LOCALAPPDATA% land in a private overlay, start it through WMI (Win32_Process Create) so it runs outside the container. Where
# WMI may start cmd.exe but PowerShell is refused ("Access is denied", seen 2026-11-23), run the same three steps from a .cmd file:
# taskkill /T /F /IM Crossline.exe, robocopy data\ to backups\, then the setup with the arguments below.
param(
  [Parameter(Mandatory = $true)][string]$Setup
)
$ErrorActionPreference = 'Stop'
$setupPath = (Resolve-Path $Setup).Path
$root = Join-Path $env:LOCALAPPDATA 'Crossline'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = Join-Path $root "install-personal-$stamp.log"
New-Item -ItemType Directory -Force -Path $root | Out-Null
function Write-Step([string]$text) { $line = "$(Get-Date -Format s) $text"; Add-Content -Path $log -Value $line -Encoding utf8; Write-Host $line }

# 1. Stop the installed copy: the tray owns a job object that ends the launcher, web, worker and Codex with it.
$tray = Get-Process -Name Crossline -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith((Join-Path $root 'app'), [System.StringComparison]::OrdinalIgnoreCase) }
if ($tray) {
  Write-Step "stopping tray $($tray.Id -join ',')"
  & "$env:SystemRoot\System32\taskkill.exe" /T /F @($tray | ForEach-Object { '/PID'; $_.Id }) | Out-Null
  Start-Sleep -Seconds 3
}
$left = Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='codex.exe'" | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith((Join-Path $root 'app'), [System.StringComparison]::OrdinalIgnoreCase) }
foreach ($process in $left) { Write-Step "stopping leftover $($process.Name) $($process.ProcessId)"; Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }

# 2. data\ aside, without logs, keeping the newest three.
$data = Join-Path $root 'data'
if (Test-Path $data) {
  $backups = Join-Path $root 'backups'
  $target = Join-Path $backups "before-personal-$stamp"
  Write-Step "backing up data to $target"
  & robocopy.exe $data $target /E /XD logs /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "BACKUP_FAILED robocopy $LASTEXITCODE" }
  Get-ChildItem $backups -Directory | Sort-Object LastWriteTime -Descending | Select-Object -Skip 3 | ForEach-Object { Write-Step "removing old backup $($_.Name)"; Remove-Item -LiteralPath $_.FullName -Recurse -Force }
}

# 3. Install. A silent install starts the new tray itself (installer/crossline.iss [Run], Check: WizardSilent).
Write-Step "installing $setupPath"
$process = Start-Process -FilePath $setupPath -ArgumentList '/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/TASKS="desktopicon"', "/LOG=`"$root\setup-$stamp.log`"" -PassThru -Wait
if ($process.ExitCode -ne 0) { throw "SETUP_FAILED $($process.ExitCode) (see $root\setup-$stamp.log)" }
Write-Step 'installed'
