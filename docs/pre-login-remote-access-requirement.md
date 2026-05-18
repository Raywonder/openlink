# Pre-Login Remote Access Requirement

OpenLink desktop apps can reconnect after user login through normal launch-at-login/start-at-login behavior.

Controlling a machine at the Windows logon screen or macOS login window is a separate privileged-host feature. A normal tray app or menu-bar app cannot reliably control the secure desktop or loginwindow before the user session exists.

Windows needs:

- A signed Windows Service installed with elevated privileges.
- Secure-desktop input and display capture handling.
- Explicit policy for credential-screen access.
- Network readiness detection before accepting remote control.

macOS needs:

- A signed and notarized privileged helper or LaunchDaemon.
- Accessibility, Screen Recording, and Input Monitoring permissions that work before login where Apple allows it.
- Loginwindow-safe networking and session handoff into the user app after login.

Until that privileged helper/service exists, this build supports reconnecting after the user session starts. Pre-login control remains a release gate for managed-machine support.

