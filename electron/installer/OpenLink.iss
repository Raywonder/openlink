#define MyAppName "OpenLink"
#define MyAppPublisher "Devine Creations"
#define MyAppURL "https://openlink.devinecreations.com/"
#define MyAppExeName "OpenLink.exe"
#define MyAppAssocName MyAppName + " Session Link"
#define MyAppAssocExt ".openlink"
#define MyAppAssocKey StringChange(MyAppAssocName, " ", "") + MyAppAssocExt
#ifndef MyAppVersion
  #define MyAppVersion "1.7.15"
#endif
#ifndef SourceDir
  #define SourceDir "..\\..\\dist\\openlink\\win-unpacked"
#endif
#ifndef OutputDir
  #define OutputDir "userdocs:Downloads"
#endif

[Setup]
AppId={{4D1F08B3-3F9C-4E48-A973-E8F52965F9E8}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
UninstallDisplayIcon={app}\{#MyAppExeName}
WizardStyle=modern dynamic
Compression=lzma2
SolidCompression=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
PrivilegesRequired=admin
ChangesAssociations=yes
DisableProgramGroupPage=yes
OutputDir={#OutputDir}
OutputBaseFilename=OpenLink Setup {#MyAppVersion}
SetupIconFile=..\assets\icon.ico
CloseApplications=yes
CloseApplicationsFilter=OpenLink.exe
RestartApplications=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked
Name: "launchapp"; Description: "Launch OpenLink after setup"; Flags: unchecked

[Files]
Source: "{#SourceDir}\\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\\{#MyAppName}"; Filename: "{app}\\{#MyAppExeName}"
Name: "{autodesktop}\\{#MyAppName}"; Filename: "{app}\\{#MyAppExeName}"; Tasks: desktopicon

[Registry]
Root: HKCR; Subkey: "{#MyAppAssocExt}\\OpenWithProgids"; ValueType: string; ValueName: "{#MyAppAssocKey}"; ValueData: ""; Flags: uninsdeletevalue
Root: HKCR; Subkey: "{#MyAppAssocKey}"; ValueType: string; ValueName: ""; ValueData: "{#MyAppAssocName}"; Flags: uninsdeletekey
Root: HKCR; Subkey: "{#MyAppAssocKey}\\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\\{#MyAppExeName},0"
Root: HKCR; Subkey: "{#MyAppAssocKey}\\shell\\open\\command"; ValueType: string; ValueName: ""; ValueData: """{app}\\{#MyAppExeName}"" ""%1"""

[Run]
Filename: "{app}\\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#StringChange(MyAppName, '&', '&&')}}"; Flags: nowait postinstall skipifsilent runasoriginaluser; Tasks: launchapp

[Code]
function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  NeedsRestart := False;
  Result := '';
end;
