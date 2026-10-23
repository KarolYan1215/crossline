; 「Crossline 节点」 for Windows (docs/compute-node.md): the standalone compute node. Built by scripts/package-node.ts, which stages the
; files and passes /DAppVersion=, /DStage=, /DOutputDir=, /DIconFile= and /DLanguageFile=.
;
; Per-user, no administrator rights. The program goes to %LOCALAPPDATA%\Crossline Node\app; what it keeps (the pairing token, its Codex
; login, logs) sits beside it in %LOCALAPPDATA%\Crossline Node, outside what an update or an uninstall replaces unless the person asks.

#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef Stage
  #error Stage is required
#endif

[Setup]
AppId={{3E1F9A64-7C2B-4D8E-9A51-6F0B2C7D4E93}
AppName=Crossline 节点
AppVersion={#AppVersion}
AppVerName=Crossline 节点 {#AppVersion}
AppPublisher=Crossline
DefaultDirName={localappdata}\Crossline Node\app
DisableDirPage=yes
DisableProgramGroupPage=yes
UsePreviousAppDir=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename=Crossline-Node-Setup-{#AppVersion}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\node.exe
UninstallDisplayName=Crossline 节点
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "zh"; MessagesFile: "{#LanguageFile}"

[Tasks]
; The node is useful only while it runs: on by default, the person's to turn off here or later in Windows' startup apps.
Name: "autostart"; Description: "登录 Windows 时自动运行（电脑开着就替网页版干活）"
Name: "desktopicon"; Description: "在桌面创建快捷方式"; Flags: unchecked

[InstallDelete]
Type: filesandordirs; Name: "{app}\codex"

[Files]
Source: "{#Stage}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Crossline 节点"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\start.vbs"""; IconFilename: "{app}\node.exe"
Name: "{userdesktop}\Crossline 节点"; Filename: "{sys}\wscript.exe"; Parameters: """{app}\start.vbs"""; IconFilename: "{app}\node.exe"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "Crossline Node"; \
  ValueData: """{sys}\wscript.exe"" ""{app}\start.vbs"" --autostart"; Flags: uninsdeletevalue; Tasks: autostart

[Run]
; Start: the page opens for pairing and sign-in. A running copy was stopped before the files were replaced (PrepareToInstall below).
Filename: "{sys}\wscript.exe"; Parameters: """{app}\start.vbs"""; Description: "现在启动 Crossline 节点"; Flags: nowait postinstall skipifsilent

[Code]
// Every process running from the app folder (the node program and the Codex it started) is stopped before its files are replaced or
// removed: a running node.exe cannot be overwritten (DeleteFile error 5 on the first update, 2026-10-23).
procedure StopRunningCopy(const Folder: String);
var
  ResultCode: Integer;
begin
  Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
    '-NoProfile -NonInteractive -Command "$f = ''' + Folder + '''; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($f, [StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 800"',
    '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopRunningCopy(ExpandConstant('{app}'));
  Result := '';
end;

function InitializeUninstall(): Boolean;
begin
  StopRunningCopy(ExpandConstant('{app}'));
  Result := True;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Root: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Root := ExpandConstant('{localappdata}\Crossline Node');
    if (not UninstallSilent) and DirExists(Root + '\codex-home') then
      if MsgBox('是否同时删除这台电脑上的配对和 ChatGPT 登录？' #13#10 #13#10 +
                '选「是」会删除 ' + Root + ' 下的配对令牌、ChatGPT 登录和日志；网页版的数据不受影响。' #13#10 +
                '选「否」会保留它们，重新安装后不用再配对和登录。', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
        DelTree(Root, True, True, True);
  end;
end;
