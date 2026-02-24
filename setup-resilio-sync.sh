#!/usr/bin/env bash

# Setup script for Resilio Sync auto-import for OpenLink

echo "Setting up Resilio Sync auto-import for OpenLink..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPENLINK_DIR="${OPENLINK_DIR:-$SCRIPT_DIR}"

# Check if Resilio Sync is installed
if [ ! -d "/Applications/Resilio Sync.app" ]; then
    echo "Error: Resilio Sync is not installed!"
    echo "Please install Resilio Sync from: https://www.resilio.com/individuals/"
    exit 1
fi

# Check if Resilio Sync is running
if ! pgrep -x "Resilio Sync" > /dev/null; then
    echo "Starting Resilio Sync..."
    open -a "Resilio Sync"
    sleep 3
fi

# Load the LaunchAgent
echo "Loading LaunchAgent for auto-import monitoring..."
launchctl unload ~/Library/LaunchAgents/com.openlink.resilio-sync.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.openlink.resilio-sync.plist

# Create log directory if it doesn't exist
mkdir -p ~/Library/Logs

# Create a sample .rslsync file for the OpenLink folder
echo "Creating OpenLink sync configuration..."
cat > ~/Desktop/openlink-sync.rslsync.example << 'EOF'
{
    "folders": [
        {
            "path": "__OPENLINK_DIR__",
            "selective_sync": false
        }
    ]
}
EOF
sed -i.bak "s|__OPENLINK_DIR__|$OPENLINK_DIR|g" ~/Desktop/openlink-sync.rslsync.example
rm -f ~/Desktop/openlink-sync.rslsync.example.bak

echo ""
echo "Setup complete!"
echo ""
echo "Instructions:"
echo "1. The auto-import monitor is now running in the background"
echo "2. Any .rslsync files placed in Downloads, Desktop, or OpenLink folder will be auto-imported"
echo "3. A sample configuration has been created at: ~/Desktop/openlink-sync.rslsync.example"
echo ""
echo "To manually add the OpenLink folder to Resilio Sync:"
echo "  1. Open Resilio Sync"
echo "  2. Click '+' to add a folder"
echo "  3. Select 'Enter a key or link'"
echo "  4. Use the sync key from your local machine"
echo ""
echo "To check the monitor status:"
echo "  launchctl list | grep resilio"
echo ""
echo "To view logs:"
echo "  tail -f ~/Library/Logs/resilio-auto-sync.log"
echo ""
echo "To stop the monitor:"
echo "  launchctl unload ~/Library/LaunchAgents/com.openlink.resilio-sync.plist"
