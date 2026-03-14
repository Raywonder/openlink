# Windows Debug Report

Generated from:
- `%AppData%\OpenLink\logs\main.log`
- Run date: March 14, 2026

## Pull/Build Status

- Repo pull status: `Already up to date` on `main`.
- Windows build status: completed via `scripts/build-windows-openlink.bat`.
- Electron builder outputs observed:
  - `dist/openlink/OpenLink Setup 1.7.15.exe` (NSIS)
  - `dist/openlink/OpenLink 1.7.15.exe` (portable)

## Primary Errors Found in Log

Repeated startup error:
- `Splash update check failed: Error: ERR_FAILED (-2) loading 'file:///C:\Program Files\OpenLink\resources\app.asar\src\ui\splash-screen.html'`

Observed timestamps:
- `2026-01-06 19:59:20.025`
- `2026-01-06 20:07:22.021`
- `2026-01-06 20:10:38.695`
- `2026-01-07 18:27:11.668`
- `2026-01-07 18:30:32.477`

Related event:
- `Startup recovery: Starting in safe mode after crash` (`2026-01-07 18:27:11.147`)

## Network/SSH Notes

No direct SSH/Headscale/Tailscale failure entries were detected in this log slice.

Validated current access endpoints:
- Windows host Tailnet IP: `100.64.0.5`
- Host SSH: `100.64.0.5:22`
- WSL SSH via portproxy: `100.64.0.5:2222`

## Build Script Update

`scripts/build-windows-openlink.bat` now:
- Builds Electron Windows artifacts first (`npm run build:win`).
- Detects Inno Setup compiler (`ISCC.exe`) in standard install paths.
- Compiles `scripts/openlink-windows-installer.iss` when available.
- Produces `dist/openlink/OpenLink-Inno-Setup.exe` when Inno compile succeeds.
