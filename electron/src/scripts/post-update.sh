#!/bin/bash
# OpenLink Post-Update Script
# Handles permission restoration and app restart after auto-update
# This script runs after the app update is installed

APP_NAME="OpenLink"
BUNDLE_ID="com.openlink.app"
APP_PATH="/Applications/${APP_NAME}.app"
LOG_FILE="$HOME/Library/Logs/${APP_NAME}/post-update.log"

# Ensure log directory exists
mkdir -p "$(dirname "$LOG_FILE")"

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"
}

log "=== Post-Update Script Started ==="

# Check if running on macOS
if [[ "$(uname)" != "Darwin" ]]; then
    log "Not running on macOS, exiting"
    exit 0
fi

# Function to check screen recording permission
check_screen_recording() {
    # Check TCC database for screen recording permission
    local result=$(sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
        "SELECT auth_value FROM access WHERE service='kTCCServiceScreenCapture' AND client='${BUNDLE_ID}';" 2>/dev/null)
    [[ "$result" == "2" ]] && return 0 || return 1
}

# Function to check accessibility permission
check_accessibility() {
    # Check TCC database for accessibility permission
    local result=$(sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
        "SELECT auth_value FROM access WHERE service='kTCCServiceAccessibility' AND client='${BUNDLE_ID}';" 2>/dev/null)
    [[ "$result" == "2" ]] && return 0 || return 1
}

# Function to attempt to fix permissions (requires admin privileges)
fix_permissions_with_tcc() {
    log "Attempting to fix permissions..."

    # This requires SIP to be disabled or running with root
    # On most systems, this won't work due to SIP
    if [[ $EUID -eq 0 ]]; then
        # Running as root, attempt to fix TCC
        sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
            "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version)
             VALUES ('kTCCServiceScreenCapture', '${BUNDLE_ID}', 0, 2, 0, 1);" 2>/dev/null

        sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
            "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version)
             VALUES ('kTCCServiceAccessibility', '${BUNDLE_ID}', 0, 2, 0, 1);" 2>/dev/null

        log "Permissions updated via TCC database"
        return 0
    else
        log "Not running as root, cannot modify TCC database directly"
        return 1
    fi
}

# Function to prompt user for permission via osascript
prompt_user_for_permission() {
    local permission_type="$1"
    local message="$2"
    local pref_pane="$3"

    osascript -e "
        tell application \"System Events\"
            activate
            display dialog \"${message}\" buttons {\"Open Settings\", \"Later\"} default button \"Open Settings\" with title \"${APP_NAME} Update\"
            if button returned of result is \"Open Settings\" then
                do shell script \"open '${pref_pane}'\"
            end if
        end tell
    " 2>/dev/null
}

# Check current permission status
log "Checking current permission status..."

SCREEN_OK=false
ACCESS_OK=false

if check_screen_recording; then
    log "Screen Recording: Granted"
    SCREEN_OK=true
else
    log "Screen Recording: Not Granted"
fi

if check_accessibility; then
    log "Accessibility: Granted"
    ACCESS_OK=true
else
    log "Accessibility: Not Granted"
fi

# If permissions are missing, try to fix or prompt user
if [[ "$SCREEN_OK" != "true" ]] || [[ "$ACCESS_OK" != "true" ]]; then
    log "Missing permissions detected after update"

    # Try to fix via TCC if possible
    if ! fix_permissions_with_tcc; then
        # Prompt user to grant permissions
        if [[ "$SCREEN_OK" != "true" ]]; then
            prompt_user_for_permission "screen" \
                "${APP_NAME} needs Screen Recording permission to share your screen. This permission may need to be re-granted after the update." \
                "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
        fi

        if [[ "$ACCESS_OK" != "true" ]]; then
            prompt_user_for_permission "accessibility" \
                "${APP_NAME} needs Accessibility permission for remote control. This permission may need to be re-granted after the update." \
                "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        fi
    fi
fi

# Remove quarantine attribute from app (prevents "damaged" warning)
log "Removing quarantine attribute..."
xattr -d com.apple.quarantine "$APP_PATH" 2>/dev/null || true
xattr -rd com.apple.quarantine "$APP_PATH" 2>/dev/null || true

# Clear code signing cache (forces re-evaluation)
log "Clearing code signing cache..."
/usr/bin/codesign --remove-signature "$APP_PATH" 2>/dev/null || true

# Wait a moment for system to settle
sleep 1

# Launch the updated app
log "Launching ${APP_NAME}..."
open -a "$APP_PATH" --args --updated

log "=== Post-Update Script Completed ==="
exit 0
