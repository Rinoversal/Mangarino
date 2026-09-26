; Installer for Mangarino Hub, or Testarino Hub for the public test build (Inno Setup 6).
; Built by the "Hub EXE" workflow:
;   python tools/hub/installer/prepare.py <build>      (version details and pictures, in build\)
;   pyinstaller ... --onedir --name "Mangarino Hub" ... (the app, in dist\Mangarino Hub\)
;   ISCC /DAppVersion=<x.y.z.build> /DBuildDir=<repo>\build /DDistDir=<repo>\dist\Mangarino Hub /DOutDir=<repo>\dist mangarino-hub.iss
;
; Installs like other Windows programs: Windows asks once ("allow this app to make changes"),
; and setup then also lets phones and tablets on the home network (and Tailscale) through the
; firewall, so the app itself never has to ask. The installed app starts without any prompt.

#ifndef AppVersion
  #define AppVersion "0.0.0.0"
#endif
#ifndef BuildDir
  #define BuildDir "..\..\..\build"
#endif
#ifndef DistDir
  #define DistDir "..\..\..\dist\Mangarino Hub"
#endif
#ifndef OutDir
  #define OutDir "..\..\..\dist"
#endif
; The edition: pass /DBrand=Testarino (and its own /DAppGuid) for the public test build.
#ifndef Brand
  #define Brand "Mangarino"
#endif
#ifndef AppGuid
  #define AppGuid "7AF0DF96-AFB3-41E9-92E1-FE9D619F5AB6"
#endif
#define AppName Brand + " Hub"
#define AppExe AppName + ".exe"

[Setup]
AppId={{{#AppGuid}}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName}
AppPublisher={#Brand}
VersionInfoVersion={#AppVersion}
VersionInfoProductName={#AppName}
VersionInfoDescription={#AppName} Setup
DefaultDirName={autopf}\{#AppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=admin
UsedUserAreasWarning=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir={#OutDir}
OutputBaseFilename={#Brand}-Hub-Setup
SetupIconFile=..\mangarino-hub.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern
WizardImageFile={#BuildDir}\wizard.bmp,{#BuildDir}\wizard-2x.bmp
WizardSmallImageFile={#BuildDir}\wizard-small.bmp,{#BuildDir}\wizard-small-2x.bmp
Compression=lzma2/ultra64
SolidCompression=yes
CloseApplications=no
RestartApplications=no
ShowLanguageDialog=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Messages]
FinishedHeadingLabel={#AppName} is installed
FinishedLabelNoIcons=Open {#Brand} on your phone or tablet, tap PC, then tap this PC's name.
FinishedLabel=Open {#Brand} on your phone or tablet, tap PC, then tap this PC's name.

[Tasks]
Name: "autostart"; Description: "Start with Windows, in the tray, so your devices can always sync"; GroupDescription: "Syncing:"
Name: "desktopicon"; Description: "Put a shortcut on the desktop"; GroupDescription: "Shortcuts:"

[InstallDelete]
; The previous version's runtime files, so nothing stale is left behind after an update.
Type: filesandordirs; Name: "{app}\_internal"

[Files]
Source: "{#DistDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"; AppUserModelID: "{#Brand}.Hub"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: string; ValueName: "{#AppName}"; ValueData: """{app}\{#AppExe}"" --background"; Tasks: autostart
; Removed on uninstall even when it was switched on later, from the app's settings.
Root: HKCU; Subkey: "Software\Microsoft\Windows\CurrentVersion\Run"; ValueType: none; ValueName: "{#AppName}"; Flags: uninsdeletevalue

[Run]
; Let phones and tablets on the home network (and Tailscale) reach the app.
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#AppName}"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""{#AppName}"" dir=in action=allow program=""{app}\{#AppExe}"" enable=yes profile=any remoteip=localsubnet,100.64.0.0/10"; Flags: runhidden; StatusMsg: "Letting your devices reach {#AppName}..."
Filename: "{app}\{#AppExe}"; Description: "Open {#AppName} now"; Flags: nowait postinstall skipifsilent runasoriginaluser

[UninstallRun]
Filename: "{app}\{#AppExe}"; Parameters: "--quit"; Flags: runhidden waituntilterminated; RunOnceId: "QuitHub"
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""{#AppName}"""; Flags: runhidden; RunOnceId: "FirewallRule"

[Code]
// Earlier versions installed for one user only (under AppData). Remove that copy first, so there
// is one Mangarino Hub; its settings and paired devices are kept (they live in %APPDATA%).
function InitializeSetup(): Boolean;
var
  Uninstaller: String;
  ResultCode: Integer;
begin
  Result := True;
  if RegQueryStringValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{{#AppGuid}}_is1', 'UninstallString', Uninstaller) then
    Exec(RemoveQuotes(Uninstaller), '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// An update can't replace files that are in use: stop the running hub first.
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  Exe: String;
  ResultCode: Integer;
begin
  Result := '';
  Exe := ExpandConstant('{app}\{#AppExe}');
  if FileExists(Exe) then
    Exec(Exe, '--quit', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

// "Start with Windows" follows the choice made in setup, also when it was on before.
procedure CurStepChanged(CurStep: TSetupStep);
begin
  if (CurStep = ssPostInstall) and not WizardIsTaskSelected('autostart') then
    RegDeleteValue(HKEY_CURRENT_USER, 'Software\Microsoft\Windows\CurrentVersion\Run', '{#AppName}');
end;
