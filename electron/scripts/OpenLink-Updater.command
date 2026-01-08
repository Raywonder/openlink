#!/bin/bash
#
# OpenLink Standalone Updater
# Fallback update tool when in-app updates fail
#
# Usage: ./openlink-updater.sh
# Or double-click the .command file on macOS
#

set -e

UPDATE_URL="https://raywonderis.me/uploads/website_specific/apps/openlink"
APP_NAME="OpenLink"
TEMP_DIR="/tmp/openlink-update"

echo "========================================="
echo "  OpenLink Standalone Updater"
echo "========================================="
echo ""

# Detect platform
if [[ "$OSTYPE" == "darwin"* ]]; then
    PLATFORM="mac"
    LATEST_FILE="latest-mac.yml"
    echo "Platform: macOS"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    PLATFORM="linux"
    LATEST_FILE="latest-linux.yml"
    echo "Platform: Linux"
else
    echo "Unsupported platform: $OSTYPE"
    exit 1
fi

# Get current version
CURRENT_VERSION="unknown"
if [[ "$PLATFORM" == "mac" ]]; then
    if [[ -d "/Applications/$APP_NAME.app" ]]; then
        CURRENT_VERSION=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "/Applications/$APP_NAME.app/Contents/Info.plist" 2>/dev/null || echo "unknown")
    fi
elif [[ "$PLATFORM" == "linux" ]]; then
    CURRENT_VERSION=$(dpkg-query -W -f='${Version}' openlink 2>/dev/null || echo "unknown")
fi
echo "Current version: $CURRENT_VERSION"

# Check for latest version
echo ""
echo "Checking for updates..."
LATEST_INFO=$(curl -sL "$UPDATE_URL/$LATEST_FILE")

if [[ -z "$LATEST_INFO" ]]; then
    echo "Error: Could not fetch update information"
    exit 1
fi

LATEST_VERSION=$(echo "$LATEST_INFO" | grep "^version:" | cut -d' ' -f2 | tr -d "'" | tr -d '"')
echo "Latest version: $LATEST_VERSION"

# Compare versions
if [[ "$CURRENT_VERSION" == "$LATEST_VERSION" ]]; then
    echo ""
    echo "You are already running the latest version!"
    exit 0
fi

echo ""
echo "Update available: $CURRENT_VERSION -> $LATEST_VERSION"
echo ""
read -p "Do you want to install the update? (y/n) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Update cancelled."
    exit 0
fi

# Create temp directory
mkdir -p "$TEMP_DIR"
cd "$TEMP_DIR"

# Download and install
if [[ "$PLATFORM" == "mac" ]]; then
    # Get DMG filename
    DMG_FILE=$(echo "$LATEST_INFO" | grep "url:.*\.dmg" | head -1 | sed 's/.*url: *//' | tr -d "'" | tr -d '"')

    if [[ -z "$DMG_FILE" ]]; then
        echo "Error: Could not find DMG file in update info"
        exit 1
    fi

    echo ""
    echo "Downloading $DMG_FILE..."
    curl -L -# -o "$DMG_FILE" "$UPDATE_URL/$DMG_FILE"

    echo ""
    echo "Killing existing OpenLink processes..."
    pkill -f "OpenLink" 2>/dev/null || true
    sleep 2

    echo ""
    echo "Mounting DMG..."
    hdiutil attach "$DMG_FILE" -nobrowse -quiet

    # Find mounted volume
    VOLUME=$(ls /Volumes | grep -i "$APP_NAME" | head -1)
    if [[ -z "$VOLUME" ]]; then
        echo "Error: Could not find mounted volume"
        exit 1
    fi

    echo "Installing from /Volumes/$VOLUME..."
    rm -rf "/Applications/$APP_NAME.app"
    cp -R "/Volumes/$VOLUME/$APP_NAME.app" /Applications/
    xattr -dr com.apple.quarantine "/Applications/$APP_NAME.app" 2>/dev/null || true

    echo "Unmounting..."
    hdiutil detach "/Volumes/$VOLUME" -quiet

    echo ""
    echo "Cleaning up..."
    rm -rf "$TEMP_DIR"

    echo ""
    echo "========================================="
    echo "  Update complete!"
    echo "  Installed: $LATEST_VERSION"
    echo "========================================="
    echo ""
    read -p "Start OpenLink now? (y/n) " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        open -a "$APP_NAME"
    fi

elif [[ "$PLATFORM" == "linux" ]]; then
    # Get AppImage or deb filename
    APPIMAGE_FILE=$(echo "$LATEST_INFO" | grep "url:.*\.AppImage" | head -1 | sed 's/.*url: *//' | tr -d "'" | tr -d '"')

    echo ""
    echo "Downloading $APPIMAGE_FILE..."
    curl -L -# -o "$APPIMAGE_FILE" "$UPDATE_URL/$APPIMAGE_FILE"

    echo ""
    echo "Killing existing OpenLink processes..."
    pkill -f "OpenLink" 2>/dev/null || true
    sleep 2

    # Make executable and move
    chmod +x "$APPIMAGE_FILE"

    # Check if running as root for system-wide install
    if [[ $EUID -eq 0 ]]; then
        mv "$APPIMAGE_FILE" /usr/local/bin/openlink
        echo "Installed to /usr/local/bin/openlink"
    else
        INSTALL_DIR="$HOME/.local/bin"
        mkdir -p "$INSTALL_DIR"
        mv "$APPIMAGE_FILE" "$INSTALL_DIR/openlink"
        echo "Installed to $INSTALL_DIR/openlink"
    fi

    echo ""
    echo "Cleaning up..."
    rm -rf "$TEMP_DIR"

    echo ""
    echo "========================================="
    echo "  Update complete!"
    echo "  Installed: $LATEST_VERSION"
    echo "========================================="
fi

echo ""
echo "Done!"
