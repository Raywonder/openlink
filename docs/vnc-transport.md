# OpenLink VNC Transport

OpenLink's preferred desktop transport is RFB (VNC) carried inside the existing authenticated OpenLink session. It replaces any legacy RustDesk integration without exposing a raw VNC listener to the public Internet.

## Routing

1. The public OpenLink domain remains the rendezvous and authentication entry point.
2. When both peers are on the approved Tailscale/Headscale fabric, OpenLink opens the RFB byte stream over a direct WebRTC data channel.
3. Public peers use the same WebRTC path through the configured TURN/relay route when direct ICE connectivity is unavailable.
4. The existing OpenLink-native framebuffer path remains a compatibility fallback during migration.

Clients advertise this policy as:

```json
{
  "preferredDesktopTransport": "rfb-over-webrtc",
  "desktopTransports": ["rfb-over-webrtc", "openlink-native"],
  "vncExposure": "session-tunnel-only"
}
```

## Security requirements

- Never publish TCP 5900 or a platform VNC password through DNS or the public proxy.
- Bind any local VNC server to loopback or an app-owned local socket.
- Authorize the RFB tunnel with the existing OpenLink session identity, device trust, approval, and revocation rules.
- Use one ephemeral tunnel credential per connection; do not reuse the user's OS password.
- Clipboard, file transfer, keyboard, pointer, audio, agent presence, and accessibility channels remain separately permissioned.
- Keep VoiceLink audio independent so VNC reconnects do not interrupt conversation.

## Implementation sequence

1. Add an app-owned loopback RFB host adapter on Windows and macOS.
2. Add an RFB-over-WebRTC data-channel adapter with bounded buffering and backpressure.
3. Negotiate `rfb-over-webrtc`; fall back to `openlink-native` when either peer lacks it.
4. Add latency, frame-drop, reconnect, clipboard, keyboard, screen-reader, and multi-monitor tests.
5. Remove remaining RustDesk packaging scripts only after Windows-to-Mac and Mac-to-Windows release tests pass.

## Agent and voice coexistence

An OpenLink session may request an approved agent participant. Agent presence, text control requests, and voice state use OpenLink signaling and VoiceLink audio, not the RFB stream. This lets Clawdia remain conversational while a remote-control task continues and allows the same behavior on tailnet-only or authorized public sessions.
