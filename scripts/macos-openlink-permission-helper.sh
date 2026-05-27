#!/usr/bin/env bash
set -euo pipefail

APP_NAME="OpenLink"
BUNDLE_ID="com.raywonder.openlink"

usage() {
    cat <<'EOF'
OpenLink macOS permission helper

Usage:
  openlink-macos-permission-helper.sh --open
  openlink-macos-permission-helper.sh --status
  openlink-macos-permission-helper.sh --reset-stale

What this can do:
  - Open the exact macOS Privacy panes for Accessibility and Input Monitoring.
  - Report whether the current OpenLink process is trusted for Accessibility.
  - Reset stale Accessibility/Input Monitoring entries so macOS can prompt again.

What macOS does not allow:
  - A normal app or shell script cannot silently grant Accessibility, Input
    Monitoring, or Screen Recording permission. The user, an admin via MDM/PPPC,
    or a trusted support workflow must approve those protected settings.
EOF
}

open_panes() {
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" || true
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent" || true
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" || true
    cat <<EOF
Opened macOS Privacy settings for ${APP_NAME}.

Enable ${APP_NAME} in:
  1. Accessibility
  2. Input Monitoring
  3. Screen Recording, if screen sharing is needed

If the remote user cannot complete this, an admin can deploy a PPPC/MDM profile
for bundle id ${BUNDLE_ID}, or use this helper with --reset-stale and then ask
the user to approve the macOS prompt.
EOF
}

status() {
    osascript <<'EOF' || true
tell application "System Events"
    set appNames to name of every application process
    if appNames contains "OpenLink" then
        return "OpenLink is running. Check System Settings > Privacy & Security > Accessibility and Input Monitoring for approval state."
    else
        return "OpenLink is not currently visible to System Events. Launch OpenLink, then check Privacy & Security settings."
    end if
end tell
EOF
}

reset_stale() {
    echo "Resetting stale macOS TCC entries for ${BUNDLE_ID}. This does not grant permission; it allows macOS to prompt again."
    tccutil reset Accessibility "${BUNDLE_ID}" || true
    tccutil reset ListenEvent "${BUNDLE_ID}" || true
    tccutil reset ScreenCapture "${BUNDLE_ID}" || true
    open_panes
}

case "${1:---help}" in
    --open)
        open_panes
        ;;
    --status)
        status
        ;;
    --reset-stale)
        reset_stale
        ;;
    --help|-h)
        usage
        ;;
    *)
        usage
        exit 2
        ;;
esac
