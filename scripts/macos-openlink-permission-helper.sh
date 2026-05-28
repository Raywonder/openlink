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
  openlink-macos-permission-helper.sh --karabiner-status
  openlink-macos-permission-helper.sh --karabiner-install
  openlink-macos-permission-helper.sh --karabiner-open
  openlink-macos-permission-helper.sh --reset-stale

What this can do:
  - Open the exact macOS Privacy panes for Accessibility, Input Monitoring,
    Screen Recording, Screen & System Audio Recording, and Remote Desktop.
  - Check whether Karabiner-Elements and its virtual HID driver are available
    as an optional keyboard reliability assist.
  - Install Karabiner-Elements through Homebrew when Homebrew is available, or
    open the official Karabiner download page when it is not.
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

karabiner_status() {
    local cli="/Library/Application Support/org.pqrs/Karabiner-Elements/bin/karabiner_cli"
    local virtual_hid_client="/Library/Application Support/org.pqrs/Karabiner-DriverKit-VirtualHIDDevice/Applications/Karabiner-DriverKit-VirtualHIDDeviceClient.app/Contents/MacOS/Karabiner-DriverKit-VirtualHIDDeviceClient"
    if [[ -x "${cli}" ]]; then
        echo "Karabiner-Elements CLI: installed"
        "${cli}" --version || true
    else
        echo "Karabiner-Elements CLI: not installed"
    fi

    if [[ -x "${virtual_hid_client}" ]]; then
        echo "Karabiner virtual HID client: installed"
    else
        echo "Karabiner virtual HID client: not found"
    fi

    echo
    echo "Karabiner virtual HID driver extension:"
    systemextensionsctl list 2>/dev/null | grep -i "org.pqrs.Karabiner-DriverKit-VirtualHIDDevice\|Karabiner" || echo "No Karabiner virtual HID extension was reported by systemextensionsctl."

    cat <<'EOF'

OpenLink note:
  OpenLink reports Karabiner virtual HID readiness during keyboard handshakes
  when the driver and CLI are available. It does not grant OpenLink
  Accessibility, Input Monitoring, Screen Recording, Remote Desktop, or System
  Audio access.
EOF
}

karabiner_install() {
    if [[ -x "/Library/Application Support/org.pqrs/Karabiner-Elements/bin/karabiner_cli" ]]; then
        echo "Karabiner-Elements CLI is already installed."
        karabiner_status
        karabiner_open
        return 0
    fi

    local brew=""
    if [[ -x "/opt/homebrew/bin/brew" ]]; then
        brew="/opt/homebrew/bin/brew"
    elif [[ -x "/usr/local/bin/brew" ]]; then
        brew="/usr/local/bin/brew"
    elif command -v brew >/dev/null 2>&1; then
        brew="$(command -v brew)"
    fi

    if [[ -n "${brew}" ]]; then
        echo "Installing Karabiner-Elements with Homebrew cask..."
        "${brew}" install --cask karabiner-elements
        echo
        echo "Karabiner-Elements installed. macOS may still require Driver Extension approval in Privacy & Security."
        karabiner_status
        karabiner_open
        return 0
    fi

    echo "Homebrew was not found. Opening the official Karabiner-Elements download page."
    open "https://karabiner-elements.pqrs.org/" || true
    return 1
}

karabiner_open() {
    open -b org.pqrs.Karabiner-Elements || open "/Applications/Karabiner-Elements.app" || open "/Applications" || true
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
    --karabiner-status)
        karabiner_status
        ;;
    --karabiner-install)
        karabiner_install
        ;;
    --karabiner-open)
        karabiner_open
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
