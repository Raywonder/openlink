# OpenLink Windows Remote Debug

This file is for the Windows machine so Codex there can continue the OpenLink launch investigation locally.

## Current Problem

The latest `1.7.15` Windows installer is live, but OpenLink still does not show its UI after launch on the Windows PC.

The current working assumption is:
- the installer/update path is live and updated
- the remaining problem is Windows-local runtime behavior
- likely causes are renderer load failure, preload/runtime error, or machine-specific tray/startup behavior

## Current Live Files

- Installer:
  `https://raywonderis.me/uploads/website_specific/apps/openlink/OpenLink%20Setup%201.7.15.exe`
- Portable:
  `https://raywonderis.me/uploads/website_specific/apps/openlink/OpenLink%201.7.15.exe`
- Manifest:
  `https://raywonderis.me/uploads/website_specific/apps/openlink/latest.yml`

Current live Windows updater hash:

`ka5G+2OurW//4xo9gmxMzYtPpY/rSiuPVcX4HhB74aqNVjuiASLM48uO9RHnyDdBPyqSvWWqXwvlHwpE4JWKYg==`

## Code Already Changed

These fixes are already in the repo and deployed in the latest Windows package:

- safer off-screen window recovery
- first launch should not honor hidden startup
- stronger startup show/focus recovery after `did-finish-load`
- `did-fail-load` fallback that still surfaces the window
- timeout-based force show if the window is still invisible after startup
- global shortcut changed to:
  - Windows: `Alt+Win+\\`
  - macOS: `Cmd+Opt+\\`
- startup "OpenLink Ready" notification

Newly identified startup issue in repo:

- the splash updater flow in `electron/src/main.js` was incorrectly wired
- it created a splash window directly, then constructed `SplashUpdaterService` with the wrong arguments
- on Windows this could fail while loading `splash-screen.html` and interfere with normal startup
- the fix is now in:
  - `electron/src/main.js`
  - `electron/src/services/splash-updater-service.js`
- splash load failure is now treated as non-fatal and startup should continue to the main window

Main changed file:

- `electron/src/main.js`

Related changed files:

- `electron/src/ui/app.js`
- `electron/src/ui/index.html`
- `electron/src/ui/help.html`
- `remote-desktop/webrtc-client.js`
- `remote-desktop/ui/app.js`

Additional fixes now in the repo:

- screen reader settings are saved under `accessibilitySettings` instead of staying UI-only
- local TTS and remote screen reader are no longer forced to disable each other
- remote audio playback explicitly calls `play()` when audio arrives
- `remote-desktop/webrtc-client.js` now falls back to local speech when remote screen reader relay is off

## Inno Setup Build Path

Inno Setup is installed on the Windows PC here:

- `C:\Program Files (x86)\Inno Setup 6\ISCC.exe`

Examples are here:

- `C:\Program Files (x86)\Inno Setup 6\Examples`

Repo files added for the Windows-side installer build:

- `electron/installer/OpenLink.iss`
- `electron/scripts/build-win-inno.ps1`

Run this from `openlink/electron` on Windows:

```powershell
npm run build:win:inno
```

That script:

- builds a Windows unpacked app with `electron-builder --win dir`
- compiles the Inno Setup installer with `ISCC.exe`
- writes the final installer to `Downloads`

Expected output:

- `%USERPROFILE%\Downloads\OpenLink Setup 1.7.15.exe`

## First Things To Check On Windows

### 1. Confirm Process State

In PowerShell:

```powershell
Get-Process OpenLink -ErrorAction SilentlyContinue
```

If process exists but no window appears, the issue is likely hidden window state or renderer/UI failure.

### 2. Check OpenLink Logs

Look in:

- `%APPDATA%\OpenLink\logs`
- `%APPDATA%\openlink-config.json` if present
- `%APPDATA%\OpenLink\openlink-config.json` if present

Useful PowerShell:

```powershell
$paths = @(
  "$env:APPDATA\\OpenLink\\logs",
  "$env:APPDATA\\OpenLink",
  "$env:APPDATA"
)
$paths | ForEach-Object { Write-Host "`n--- $_"; if (Test-Path $_) { Get-ChildItem $_ -Force } }
```

Tail recent logs:

```powershell
Get-ChildItem "$env:APPDATA\\OpenLink\\logs" | Sort-Object LastWriteTime -Descending | Select-Object -First 3
Get-Content "<latest-log-file>" -Tail 200
```

Search for:

- `did-fail-load`
- `Forcing main window visible after did-finish-load`
- `Main window still hidden after startup timeout`
- preload errors
- uncaught exceptions
- missing module / missing file errors

### 3. Check Whether The Window Exists But Is Hidden

Test shortcut after launch:

- `Alt+Win+\\`

That should:
- bring OpenLink to front
- open the control menu

If the process exists and this shortcut does nothing, note that in the logs/results.

### 4. Compare Installer vs Portable

Run both:

- installer build
- portable build

If portable opens but installer does not, the problem is installer/runtime environment specific.

If neither opens, the problem is app runtime or renderer startup.

## Recommended Debug Commands On Windows

### Show recent OpenLink files

```powershell
Get-ChildItem "$env:LOCALAPPDATA\\Programs\\OpenLink" -Recurse -ErrorAction SilentlyContinue | Select-Object FullName,Length,LastWriteTime
```

### Check appdata state

```powershell
Get-ChildItem "$env:APPDATA\\OpenLink" -Recurse -ErrorAction SilentlyContinue | Select-Object FullName,Length,LastWriteTime
```

### Kill and relaunch cleanly

```powershell
Get-Process OpenLink -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process "$env:LOCALAPPDATA\\Programs\\OpenLink\\OpenLink.exe"
```

### Launch portable directly

```powershell
Start-Process "C:\path\to\OpenLink 1.7.15.exe"
```

## If Codex On Windows Needs SSH Enabled

From an elevated PowerShell on the Windows PC:

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic
New-NetFirewallRule -Name sshd -DisplayName "OpenSSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22

$u = $env:USERNAME
New-Item -ItemType Directory -Force -Path "C:\Users\$u\.ssh" | Out-Null
@'
ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAICcSLRrmaAMwigG1lc7Gesn6IN6CE05dgiqG8KOm5cr1 dom@mac
'@ | Add-Content "C:\Users\$u\.ssh\authorized_keys"

icacls "C:\Users\$u\.ssh" /inheritance:r /grant "$u:(OI)(CI)F"
icacls "C:\Users\$u\.ssh\authorized_keys" /inheritance:r /grant "$u:F"

tailscale set --ssh
```

Then provide the Windows username being used on `100.64.0.5`.

## What To Report Back

When continuing on Windows, report:

1. Whether `OpenLink.exe` is running.
2. Whether installer and portable behave the same.
3. The newest log lines around launch.
4. Any `did-fail-load`, preload, or module errors.
5. Whether `Alt+Win+\\` brings anything forward.
