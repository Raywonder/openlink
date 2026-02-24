#!/usr/bin/osascript

-- AppleScript to import .rslsync files to Resilio Sync
-- Usage: osascript import-rslsync.applescript /path/to/file.rslsync

on run argv
    if (count of argv) > 0 then
        set rslsyncFile to item 1 of argv

        -- Open the .rslsync file with Resilio Sync
        tell application "Finder"
            open POSIX file rslsyncFile using application file id "com.resilio.Sync"
        end tell

        -- Wait a moment for the import to process
        delay 2

        -- Bring Resilio Sync to front to confirm the import
        tell application "Resilio Sync"
            activate
        end tell

        return "Successfully imported: " & rslsyncFile
    else
        return "Error: No .rslsync file path provided"
    end if
end run