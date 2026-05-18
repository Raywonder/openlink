# OpenLink Release Build And Install Notes

## Local Verification Installs

- Windows builds should update the local installed app and relaunch it during verification:
  - `OPENLINK_INSTALL_LOCAL=1`
  - `OPENLINK_LAUNCH_LOCAL=1`
- macOS builds should replace `/Applications/OpenLink.app` and launch it during verification:
  - `OPENLINK_INSTALL_LOCAL=1`
  - `OPENLINK_LAUNCH_LOCAL=1`
- Unsigned macOS builds may be launched for local smoke testing only.

## Final Release Rule

- Final macOS release artifacts must be signed with the OpenLink macOS signing identity/profile.
- Final server download paths should receive only final artifacts:
  - signed macOS `.app` or packaged installer/archive
  - final Windows installer/publish output
- Do not upload unsigned macOS smoke-test builds or intermediate Windows debug binaries to public download paths.
# Build Testing Notes

Each release handoff must include concrete testing steps for keyboard users, mouse or pointer users, and non-keyboard assistive-technology users. Include expected notifications, tray/status-menu actions, and status text so a tester can verify the build without reading source code.
