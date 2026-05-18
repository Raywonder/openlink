# OpenLink iOS Companion Machine Management

The iOS companion app is the mobile control surface for managed machines. It should not replace the native desktop controls; Windows and macOS keep machine management built in.

## Companion Responsibilities

- Show the user's managed machines and their online state.
- Receive or display confirmation codes when a connection to a managed machine requires approval.
- Approve or deny managed-machine connection requests.
- Trigger safe actions for a managed machine: connect, drop-in connect when allowed, disconnect user, swap control, mute microphone audio, and mute system audio.
- Keep confirmation codes ephemeral. Do not store codes in normal logs, analytics, screenshots, or support exports.

## Desktop Responsibilities

- Keep the same managed-machine actions built in on Windows and macOS.
- Advertise `managedMachineConfirmation`, `companionConfirmationSupported`, and `companionPlatform` in connection policy payloads.
- Hide settings/tabs during active sessions and keep action controls available from the tray or status-menu shortcut path.

## Signing Requirement

OpenLink macOS releases must be packaged as `.app` bundles and signed with the configured OpenLink macOS signing identity/profile. The raw Swift package binaries are intermediates for local development only.
