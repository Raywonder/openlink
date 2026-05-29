# OpenLink Stable Remote Desktop Parity

This checklist keeps OpenLink aligned with the mature remote-desktop behavior expected from RustDesk-class clients while the native Windows and macOS apps remain the only supported desktop clients.

## Must Stay In Every Stable Build

- Bidirectional audio: remote system audio to the viewer, and microphone audio back to the host when enabled.
- Keyboard access: all remote-session actions must be reachable without a mouse.
- Control menu hotkey: all platforms use `Ctrl+Alt+\`. Do not add separate platform-specific menu shortcut groups.
- Control menu actions: disconnect, audio mute/unmute, microphone mute/unmute, screen-reader options, machine details, file transfer, permissions, and safe restart actions.
- Remote input: keyboard, pointer, scroll, and text entry should be forwarded only when the host has allowed input.
- Screen-reader support: remote screen-reader output should be relayed when available; local TTS fallback should be available when the remote reader is unavailable.
- Windows screen-reader bridge: ship the NVDA controller DLLs for supported architectures and keep their license/readme with the binary payload.
- macOS screen-reader bridge: use VoiceOver when it is enabled; when it is not enabled, use local TTS fallback for remote announcements.
- Trust and permission model: host can ask every time, always allow a trusted machine, or deny a machine.
- macOS signing: release builds must package real `.app` bundles and sign them with the configured OpenLink macOS signing identity/profile. Raw Swift executables are build intermediates only.
- iOS companion role: the iOS companion app manages machines remotely, receives or displays confirmation codes for managed-machine connections, and approves or denies managed access when the desktop app is not in front. Native desktop apps keep the same machine-management, confirmation, drop-in, disconnect, swap-control, and audio controls built in.
- Stability guard: a client disconnecting immediately after creating a session must not crash the signaling server.
- Backend fallback: primary Node signaling stays first, normal relay stays second, and Cloudflare Durable Object edge rendezvous can be enabled as an optional `cloudflare-edge` fallback for presence/control routing. Generated user links remain HTTPS-only; raw WebSocket URLs stay hidden.

## Current Source Anchors

- WebRTC media, menu, TTS, and keyboard behavior: `remote-desktop/webrtc-client.js`
- Legacy web UI control menu: `remote-desktop/ui/app.js`
- Signaling server crash guards: `servers/`, `src/`, and the deployed server copy
- Optional Cloudflare edge rendezvous backend: `servers/cloudflare/`
- Native macOS input/control service: `OpenLink/Sources/RemoteControlManager.swift`
- Native Windows client: `apps/windows/OpenLink.Windows/`

## Native-Only Rule

Do not reintroduce Electron as a desktop shell. RustDesk source can be used as implementation research for capture, input, codec, NAT, and session-stability patterns, but OpenLink code must keep license-compatible implementations and attribution where required.
