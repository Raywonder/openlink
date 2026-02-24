#!/usr/bin/env bash

# Resilio Sync Auto Import Script for OpenLink
# This script monitors for .rslsync files and automatically imports them
# It also ensures the OpenLink folder is synced

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENLINK_DIR="${OPENLINK_DIR:-$SCRIPT_DIR}"
WATCH_DIRS=(
    "$HOME/Downloads"
    "$HOME/Desktop"
    "$OPENLINK_DIR"
)

LOG_FILE="$HOME/Library/Logs/resilio-auto-sync.log"

# Function to log messages
log_message() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG_FILE"
}

# Function to import .rslsync file
import_rslsync() {
    local file="$1"
    log_message "Found .rslsync file: $file"

    # Open the .rslsync file with Resilio Sync
    open -a "Resilio Sync" "$file"

    log_message "Imported $file to Resilio Sync"

    # Optionally move the file to a processed folder
    processed_dir="$HOME/Documents/Resilio_Processed"
    mkdir -p "$processed_dir"
    mv "$file" "$processed_dir/$(basename "$file").imported.$(date +%s)"
    log_message "Moved $file to processed folder"
}

# Function to check if OpenLink folder is already synced
check_openlink_sync() {
    # Check if OpenLink folder exists in Resilio Sync folders
    # This is a simplified check - you may need to parse Resilio's config
    if [ -d "$OPENLINK_DIR/.sync" ]; then
        log_message "OpenLink folder is already synced"
        return 0
    else
        log_message "OpenLink folder is not synced yet"
        return 1
    fi
}

# Main monitoring loop
log_message "Starting Resilio Sync auto-import monitor"

# Check OpenLink sync status on startup
if ! check_openlink_sync; then
    log_message "Please add OpenLink folder to Resilio Sync manually or via .rslsync file"
fi

# Monitor for .rslsync files
while true; do
    for dir in "${WATCH_DIRS[@]}"; do
        if [ -d "$dir" ]; then
            # Find all .rslsync files in the directory
            find "$dir" -maxdepth 1 -name "*.rslsync" -type f 2>/dev/null | while read -r file; do
                import_rslsync "$file"
            done
        fi
    done

    # Wait 10 seconds before next check
    sleep 10
done
