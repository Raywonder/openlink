# OpenLink iOS Companion Machine Management

The iOS companion app is the mobile control surface for managed machines. It should not replace the native desktop controls; Windows and macOS keep machine management built in.

## Companion Responsibilities

- Show the user's managed machines and their online state.
- Discover owned/paired machines on trusted local networks and merge them with backend-registered machines.
- Show each machine's trusted domains, generated connection URLs, current signal server, last session, and connection health.
- Receive or display confirmation codes when a connection to a managed machine requires approval.
- Approve or deny managed-machine connection requests.
- Trigger safe actions for a managed machine: connect, drop-in connect when allowed, disconnect user, swap control, mute microphone audio, and mute system audio.
- Lock or unlock access to owned machines without rotating credentials or changing ownership.
- Receive notification alerts when owned machines connect, disconnect, request approval, or change audio/remote-control state.
- Generate share/status URLs for a selected machine using the approved OpenLink domains and the user's entitlements.
- Monitor/listen to remote audio from an owned machine when audio monitoring is explicitly allowed by that machine's policy.
- Keep confirmation codes ephemeral. Do not store codes in normal logs, analytics, screenshots, or support exports.

## Explicit Non-Goals For The First TestFlight Build

- Do not provide direct screen control, keyboard control, or pointer control from iOS.
- Do not expose advanced/custom signal-server settings unless the account has purchased or been granted custom server access.
- Do not allow audio monitoring unless the target machine is owned by the signed-in user and has audio monitoring enabled.
- Do not log private audio, confirmation codes, tokens, or generated one-time connection secrets.

## Desktop Responsibilities

- Keep the same managed-machine actions built in on Windows and macOS.
- Advertise `managedMachineConfirmation`, `companionConfirmationSupported`, and `companionPlatform` in connection policy payloads.
- Hide settings/tabs during active sessions and keep action controls available from the tray or status-menu shortcut path.
- Publish machine details that the companion can safely show: machine id, display name, platform, owner/account id, online state, health, approved domains, last connection time, active session state, and enabled policy flags.
- Publish audio-monitoring capability separately from full remote-control capability.

## TestFlight V1 Feature Set

- Sign in and load owned machines.
- Pair/discover machines on the local network.
- View machine cards with online state, domains, connection URL actions, and health.
- Receive push/local alerts for owned-machine connection events.
- Approve, deny, lock, unlock, drop in, disconnect, and toggle audio policies.
- Listen-only audio monitor mode for owned machines where system audio monitoring is enabled.
- Diagnostics export with safe metadata only.

## Signing Requirement

OpenLink macOS releases must be packaged as `.app` bundles and signed with the configured OpenLink macOS signing identity/profile. The raw Swift package binaries are intermediates for local development only.

The iOS companion must be distributed through TestFlight using the Apple Distribution profile for the OpenLink companion bundle identifier. App Store Connect API credentials must stay in local keychain/env storage and must not be committed.
