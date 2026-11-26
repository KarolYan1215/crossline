@echo off
rem The same as install-personal.ps1, for where PowerShell cannot be started (a process created through WMI from a Claude desktop
rem session: powershell.exe answers "Access is denied" there, cmd.exe does not). Usage: install-personal.cmd <Crossline-Personal-x.y.z.exe>
setlocal
if "%~1"=="" (echo usage: install-personal.cmd ^<setup exe^> & exit /b 2)
set "ROOT=%LOCALAPPDATA%\Crossline"
rem The backup folder's stamp, yyyyMMdd-HHmmss. A second argument is used only in that shape: callers built it from the
rem DATE variable, which is locale-shaped, and left before-personal-<weekday>022611-091748 behind (2026-11-23). Otherwise the
rem installed app's own node.exe prints the local time; random digits only when there is no node.exe.
set "STAMP=%~2"
echo(%STAMP%| findstr /r /x "[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]-[0-9][0-9][0-9][0-9][0-9][0-9]" >nul || set "STAMP="
if "%STAMP%"=="" if exist "%ROOT%\app\node.exe" (
  "%ROOT%\app\node.exe" -e "const d=new Date(Date.now()-new Date().getTimezoneOffset()*60000).toISOString();process.stdout.write(d.slice(0,10).replace(/-/g,'')+'-'+d.slice(11,19).replace(/:/g,''))" > "%TEMP%\crossline-stamp.txt" 2>nul
  set /p STAMP=<"%TEMP%\crossline-stamp.txt"
  del "%TEMP%\crossline-stamp.txt" 2>nul
)
if "%STAMP%"=="" set "STAMP=r%RANDOM%%RANDOM%"
if not exist "%ROOT%" mkdir "%ROOT%"
rem 1. Stop the installed tray; its job object ends the launcher, web, worker and Codex.
taskkill /IM Crossline.exe /T /F >nul 2>&1
timeout /t 3 /nobreak >nul
rem 2. data\ aside, without logs (older backups are left for the person to prune).
if exist "%ROOT%\data" (
  robocopy "%ROOT%\data" "%ROOT%\backups\before-personal-%STAMP%" /E /XD logs /R:1 /W:1 /NFL /NDL /NJH /NJS /NP >nul
  if errorlevel 8 (echo BACKUP_FAILED & exit /b 1)
  echo backed up data to %ROOT%\backups\before-personal-%STAMP%
)
rem 3. Install silently with a desktop shortcut; the installer starts the new tray.
"%~1" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /TASKS="desktopicon" /LOG="%ROOT%\setup-%STAMP%.log"
if errorlevel 1 (echo SETUP_FAILED %errorlevel% & exit /b 1)
echo installed
