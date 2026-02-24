# OpenLink Layout Standard

This repo follows a simple split:

- `apps/` : desktop/mobile client apps grouped by OS.
- `servers/` : backend services (API, signal, relay, server-side workers).

## Required folders

- `apps/macos/mac-app/`
- `apps/windows/windows-app/`
- `servers/api/`
- `servers/signal/`
- `servers/windows/` (only when Windows runs server roles outside app process)

## Rule of thumb

- If a component ships as a user app, put it under `apps/<os>/...`.
- If a component runs headless/server-side, put it under `servers/...`.
- If Windows server logic is embedded directly into the Windows app, keep it under `apps/windows/windows-app/` and document it in that app's README.
