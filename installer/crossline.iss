; Crossline for Windows (docs/local-installer.md). Built by scripts/package-installer.ts, which stages the files and passes
; /DAppVersion=, /DStage= (the staged app folder), /DOutputDir= and /DIconFile=.
;
; Per-user, no administrator rights: the app goes to %LOCALAPPDATA%\Crossline\app and everything the person owns — data\,
; state\ (Codex login and memories), backups\, launcher.json — sits beside it, outside what an update or an uninstall replaces.

#ifndef AppVersion
  #error AppVersion is required
#endif
#ifndef Stage
  #error Stage is required
#endif

[Setup]
AppId={{6B0C7F2E-2B7A-4C55-9C1E-8E5C2F0A4D11}
AppName=Crossline
AppVersion={#AppVersion}
AppVerName=Crossline {#AppVersion}
AppPublisher=Crossline
DefaultDirName={localappdata}\Crossline\app
DisableDirPage=yes
DisableProgramGroupPage=yes
UsePreviousAppDir=no
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir={#OutputDir}
OutputBaseFilename=Crossline-Setup-{#AppVersion}
SetupIconFile={#IconFile}
UninstallDisplayIcon={app}\Crossline.exe
UninstallDisplayName=Crossline
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
CloseApplications=force
RestartApplications=no
SetupLogging=yes

[Languages]
Name: "zh"; MessagesFile: "{#LanguageFile}"

[Tasks]
Name: "desktopicon"; Description: "在桌面创建快捷方式"; Flags: unchecked

[InstallDelete]
; An update replaces the whole app folder: a file the new version no longer ships must not linger and be loaded.
Type: filesandordirs; Name: "{app}\apps"
Type: filesandordirs; Name: "{app}\packages"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\skills"
Type: filesandordirs; Name: "{app}\codex"

[Files]
; The workspace links are the launcher's to make (apps/launcher/src/links.ts); a stage that was run carries them as junctions,
; which would otherwise be packed as a second copy of every package.
Source: "{#Stage}\*"; DestDir: "{app}"; Excludes: "\node_modules\@crossline"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{userprograms}\Crossline"; Filename: "{app}\Crossline.exe"
Name: "{userdesktop}\Crossline"; Filename: "{app}\Crossline.exe"; Tasks: desktopicon

[Registry]
; Starting with Windows is the person's choice, made in the app (Settings → 开机自启, or the tray menu), off by default. Nothing is
; written here at install; the entry the app may have written is removed at uninstall.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "Crossline"; Flags: uninsdeletevalue

[Run]
Filename: "{app}\Crossline.exe"; Description: "现在启动 Crossline"; Flags: nowait postinstall skipifsilent
; An update runs silently from the tray, which has already quit: start the new version.
Filename: "{app}\Crossline.exe"; Flags: nowait; Check: WizardSilent

[UninstallRun]
; The tray owns a job object that ends the launcher, the web app, the worker and Codex with it.
Filename: "{sys}\taskkill.exe"; Parameters: "/IM Crossline.exe /T /F"; Flags: runhidden; RunOnceId: "StopCrossline"

[Code]
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  Root: String;
begin
  if CurUninstallStep = usPostUninstall then
  begin
    Root := ExpandConstant('{localappdata}\Crossline');
    // Only what this installed copy made. A checkout's resident app keeps codex-home\, auth\ and runtimes\ in the same folder on
    // the owner's machine, and they are not ours to delete.
    if (not UninstallSilent) and DirExists(Root + '\data') then
      if MsgBox('是否同时删除 Crossline 的数据？' #13#10 #13#10 +
                '这会删除本机的全部任务、里程碑、访谈记录、上传的文件，以及 Codex 的登录和记忆（' + Root + ' 下的 data、state、backups）。' #13#10 +
                '选「否」会保留它们，重新安装后可以继续使用。', mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      begin
        DelTree(Root + '\data', True, True, True);
        DelTree(Root + '\state', True, True, True);
        DelTree(Root + '\backups', True, True, True);
        DeleteFile(Root + '\launcher.json');
        RemoveDir(Root);
      end;
  end;
end;
