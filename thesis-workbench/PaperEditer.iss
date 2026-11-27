; Inno Setup 6.3+; all persistent user data is outside {app}.
#ifndef BuildVersion
#define BuildVersion "0.1.0"
#endif
[Setup]
AppId={{7E84565E-6319-4A9B-913D-461C693B8ED1}
AppName=PaperEditer
AppVersion={#BuildVersion}
DefaultDirName={localappdata}\Programs\PaperEditer
DefaultGroupName=PaperEditer
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=dist
OutputBaseFilename=PaperEditer-Setup-x64
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
CloseApplications=no
AppMutex=PaperEditerReleaseService
UninstallDisplayIcon={app}\PaperEditer.exe
[Files]
Source: "dist\PaperEditer\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"
Name: "autostart"; Description: "Start the background service when I sign in"; GroupDescription: "Startup:"; Flags: unchecked
[Icons]
Name: "{group}\PaperEditer"; Filename: "{app}\PaperEditer.exe"; WorkingDir: "{app}"
Name: "{userdesktop}\PaperEditer"; Filename: "{app}\PaperEditer.exe"; WorkingDir: "{app}"; Tasks: desktopicon
Name: "{userstartup}\PaperEditer"; Filename: "{app}\PaperEditer.exe"; Parameters: "--background"; WorkingDir: "{app}"; Tasks: autostart
[Run]
Filename: "{app}\PaperEditer.exe"; Description: "Open PaperEditer"; Flags: nowait postinstall skipifsilent
