# Testing Handoff Rule

Every build or release handoff must explain what to test and how to test it.

Include:

- The feature or workflow being tested.
- Keyboard steps, including shortcuts and focus order where relevant.
- Mouse or pointer steps for non-keyboard users.
- Screen reader or spoken-feedback expectations when the workflow is accessibility-sensitive.
- Expected status text, notifications, tray/status-menu actions, and failure states.
- Any platform-specific differences between Windows, macOS, iOS, or server builds.

For OpenLink machine access, always test:

- Launch-at-login/start-at-login behavior after a reboot.
- Minimized tray or status-menu startup.
- Auto-reconnect for trusted machines.
- Online and offline notifications.
- Connection strength announcement before connecting.
- Elapsed connection time while connected.
- Disconnect User, Swap Control, microphone audio, system audio, and auto-mute policy actions from the tray/status menu.

