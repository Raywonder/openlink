# Windows Secure Desktop Host

OpenLink must use a privileged, service-mode desktop host for Windows UAC, lock, and sign-in screens. The normal WPF process and its `SendInput` receiver cover only the interactive user desktop.

## Transport design

1. Install a signed OpenLink-managed Windows service with explicit administrator consent.
2. Run a pinned, source-auditable RFB host in service mode. UltraVNC is the initial compatibility target because its service mode is designed to remain active across UAC and Winlogon desktop changes.
3. Configure the RFB listener as loopback-only. Never expose TCP 5900, its HTTP viewer, or a VNC password on LAN, tailnet, DNS, or a public proxy.
4. Tunnel RFB bytes through the authenticated OpenLink WebRTC data channel. Device trust, attended approval, unattended authorization, and revocation remain OpenLink decisions.
5. Generate an ephemeral RFB credential for each service start or OpenLink session. Never reuse a Windows, Microsoft-account, RIM, or OpenLink account password.
6. Keep the ordinary native input receiver as the low-latency path on the normal desktop. Switch to the service RFB path when the desktop changes to Winlogon or the secure desktop, then return without disconnecting audio or the agent channel.

## Packaging and licensing

- Pin an exact upstream revision and verify release signatures/hashes before packaging.
- UltraVNC is GPL software. Any distributed build must retain its license and corresponding-source offer and must not be represented as proprietary OpenLink code.
- Do not download or replace the privileged host silently. Installation, repair, and removal require an explicit administrator action.
- OpenLink must verify the service binary and configuration before starting a secure-desktop tunnel.

## Required accessibility behavior

- Announce when control moves between the normal desktop and a secure desktop without reading credential-field contents.
- Forward Tab, Shift+Tab, arrows, Enter, Escape, function keys, modifier chords, and pointer input.
- Preserve NVDA/Narrator speech on the normal desktop. On Winlogon or UAC, use the screen reader that Windows permits on that desktop and never relay hidden password text.
- Provide a local emergency-release chord that the remote side cannot suppress.

## Release gates

- Fresh boot to Windows sign-in screen, connect, and sign in.
- Lock an active session, reconnect, and unlock.
- Open a UAC consent prompt and complete or cancel it with keyboard navigation.
- Verify the RFB port rejects non-loopback connections.
- Verify session revocation immediately closes the RFB tunnel.
- Verify service restart and Windows Update restart recover without duplicating machines or sessions.
- Verify NVDA and Narrator announcements contain no credential values.

