#define MyAppName "OpenLink"
#define MyAppVersion "1.7.27"
#define MyAppPublisher "Devine Creations"
#define MyAppExeName "OpenLink.exe"
#define SourceDir "..\\dist\\native-windows\\OpenLink"
#define OutputDir "..\\dist\\openlink"

[Setup]
AppId={{3ED80FA8-4E7A-4F1D-A2A8-3A773E8C5A70}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputDir={#OutputDir}
OutputBaseFilename=OpenLink-Inno-Setup
Compression=lzma
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#MyAppExeName}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce

[Files]
Source: "{#SourceDir}\\*"; DestDir: "{app}"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\\remote-desktop\\*"; DestDir: "{app}\\resources\\local-server"; Flags: recursesubdirs createallsubdirs ignoreversion
Source: "..\\packaging\\local-server-entitlement.json"; DestDir: "{app}\\resources\\local-server"; DestName: "entitlement.json"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "{cm:LaunchProgram,{#MyAppName}}"; Flags: nowait postinstall skipifsilent
