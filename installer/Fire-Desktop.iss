; Setup für Fire Desktop (Inno Setup 6)
; Bauen über build-release.ps1 im Hauptordner, das setzt AppVersion und den Pfad zur .exe.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifndef SourceExe
  #define SourceExe "..\target\release\fire-desktop.exe"
#endif

[Setup]
; AppId nie ändern – daran erkennt Windows Updates derselben App
AppId={{7B6C2D14-3E0A-4C7E-9E0B-5C2F1A9D4E21}
AppName=Fire Desktop
AppVersion={#AppVersion}
AppVerName=Fire Desktop {#AppVersion}
AppPublisher=Fojadrachi
AppPublisherURL=https://github.com/fojadrachi/Fire-Desktop
AppUpdatesURL=https://github.com/fojadrachi/Fire-Desktop/releases
; Installation pro Nutzer, keine Adminrechte nötig
PrivilegesRequired=lowest
DefaultDirName={localappdata}\Programs\Fire Desktop
DisableDirPage=auto
DisableProgramGroupPage=yes
UsePreviousAppDir=yes
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
OutputDir=..\dist
OutputBaseFilename=Fire-Desktop-Setup-{#AppVersion}
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\Fire Desktop.exe
UninstallDisplayName=Fire Desktop
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
CloseApplications=force
RestartApplications=no
VersionInfoVersion={#AppVersion}
VersionInfoProductName=Fire Desktop

[Languages]
Name: "de"; MessagesFile: "compiler:Languages\German.isl"
Name: "en"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "{#SourceExe}"; DestDir: "{app}"; DestName: "Fire Desktop.exe"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Fire Desktop"; Filename: "{app}\Fire Desktop.exe"
Name: "{autodesktop}\Fire Desktop"; Filename: "{app}\Fire Desktop.exe"; Tasks: desktopicon

[Run]
; Alte Electron-Version (1.x) entfernen; Daten in %APPDATA%\Fire Desktop bleiben erhalten
Filename: "{localappdata}\Programs\fire-desktop\Uninstall Fire Desktop.exe"; Parameters: "/S"; Flags: runhidden skipifdoesntexist
; Auch nach einem stillen Update (aus der App heraus) wieder starten
Filename: "{app}\Fire Desktop.exe"; Description: "{cm:LaunchProgram,Fire Desktop}"; Flags: nowait postinstall

[UninstallRun]
Filename: "{cmd}"; Parameters: "/C taskkill /IM ""Fire Desktop.exe"" /F"; Flags: runhidden; RunOnceId: "KillApp"
