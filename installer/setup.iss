; Session Control for ChatGPT - per-user installer
#define MyAppName "Session Control for ChatGPT"
#define MyAppVersion "0.2.0"
#define MyAppPublisher "Alex Gradov"
#define MyAppExeName "extension"

[Setup]
AppId={{D9F0DB02-6D40-4BC5-813C-4CE884D38C61}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\{#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\artifacts
OutputBaseFilename=Session-Control-for-ChatGPT-Setup-v{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayIcon={app}\extension\icons\icon128.png

[Files]
Source: "..\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\PRIVACY.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\Session Control for ChatGPT\Папка расширения"; Filename: "{app}\extension"
Name: "{autoprograms}\Session Control for ChatGPT\Инструкция"; Filename: "{app}\README.md"
Name: "{autoprograms}\Session Control for ChatGPT\Удалить"; Filename: "{uninstallexe}"

[Run]
Filename: "{app}\extension"; Description: "Открыть папку расширения"; Flags: postinstall shellexec nowait skipifsilent
Filename: "{code:GetChromePath}"; Parameters: "chrome://extensions"; Description: "Открыть страницу расширений Chrome"; Flags: postinstall nowait skipifsilent; Check: ChromeFound

[Code]
var
  ChromePath: string;

function ResolveChromePath: string;
var
  Candidate: string;
begin
  if RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe', '', Candidate) and FileExists(Candidate) then
  begin
    Result := Candidate;
    Exit;
  end;

  if RegQueryStringValue(HKLM, 'Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe', '', Candidate) and FileExists(Candidate) then
  begin
    Result := Candidate;
    Exit;
  end;

  Candidate := ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe');
  if FileExists(Candidate) then
  begin
    Result := Candidate;
    Exit;
  end;

  Candidate := ExpandConstant('{pf}\Google\Chrome\Application\chrome.exe');
  if FileExists(Candidate) then
  begin
    Result := Candidate;
    Exit;
  end;

  Result := '';
end;

function GetChromePath(Param: string): string;
begin
  Result := ChromePath;
end;

function ChromeFound: Boolean;
begin
  Result := ChromePath <> '';
end;

procedure InitializeWizard;
begin
  ChromePath := ResolveChromePath;
end;
