#!/usr/bin/env bash
set -euo pipefail

APP_NAME="OpenLink"
BUNDLE_ID="com.openlink.app"

usage() {
    cat <<'EOF'
OpenLink macOS permission helper

Usage:
  openlink-macos-permission-helper.sh --open
  openlink-macos-permission-helper.sh --status
  openlink-macos-permission-helper.sh --reset-stale

What this can do:
  - Open the exact macOS Privacy panes for Accessibility, Input Monitoring,
    Screen Recording, Screen & System Audio Recording, and Remote Desktop.
  - Report whether the current OpenLink process is trusted for Accessibility
    and show OpenLink-related TCC rows when readable.
  - Reset stale Accessibility/Input Monitoring/Screen Recording/Remote Desktop
    entries so macOS can prompt again.

What macOS does not allow:
  - A normal app or shell script cannot silently grant Accessibility, Input
    Monitoring, Screen Recording, Remote Desktop, or System Audio permission.
    The user, an admin via MDM/PPPC, or a trusted support workflow must approve
    those protected settings.
EOF
}

open_panes() {
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" || true
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent" || true
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" || true
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_RemoteDesktop" || true
    open "x-apple.systempreferences:com.apple.preference.security?Privacy_AudioCapture" || true
    cat <<EOF
Opened macOS Privacy settings for ${APP_NAME}.

Enable ${APP_NAME} in:
  1. Accessibility
  2. Input Monitoring
  3. Screen Recording / Screen & System Audio Recording
  4. Remote Desktop

If the remote user cannot complete this, an admin can deploy a PPPC/MDM profile
for bundle id ${BUNDLE_ID}, or use this helper with --reset-stale and then ask
the user to approve the macOS prompt.
EOF
}

status() {
    local user_db="${HOME}/Library/Application Support/com.apple.TCC/TCC.db"
    local system_db="/Library/Application Support/com.apple.TCC/TCC.db"
    osascript <<'EOF' || true
tell application "System Events"
    set appNames to name of every application process
    if appNames contains "OpenLink" then
        return "OpenLink is running. Check System Settings > Privacy & Security for Accessibility, Input Monitoring, Screen & System Audio Recording, and Remote Desktop."
    else
        return "OpenLink is not currently visible to System Events. Launch OpenLink, then check Privacy & Security settings."
    end if
end tell
EOF
    for db in "${user_db}" "${system_db}"; do
        if [[ -r "${db}" ]] && command -v sqlite3 >/dev/null 2>&1; then
            echo
            echo "Readable TCC rows in ${db}:"
            sqlite3 "${db}" "select service, client, auth_value from access where lower(client) like '%openlink%' order by service, client;" 2>/dev/null || true
        fi
    done
}

reset_stale() {
    echo "Resetting stale macOS TCC entries for ${BUNDLE_ID}. This does not grant permission; it allows macOS to prompt again."
    tccutil reset Accessibility "${BUNDLE_ID}" || true
    tccutil reset ListenEvent "${BUNDLE_ID}" || true
    tccutil reset ScreenCapture "${BUNDLE_ID}" || true
    tccutil reset AudioCapture "${BUNDLE_ID}" || true
    tccutil reset RemoteDesktop "${BUNDLE_ID}" || true
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
