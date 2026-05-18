#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/dist/native-macos"
SIGN_IDENTITY="${OPENLINK_MACOS_SIGN_IDENTITY:-}"
SIGN_KEYCHAIN="${OPENLINK_MACOS_KEYCHAIN:-}"
PROVISIONING_PROFILE="${OPENLINK_MACOS_PROVISIONING_PROFILE:-}"
ENTITLEMENTS="${OPENLINK_MACOS_ENTITLEMENTS:-$REPO_ROOT/packaging/macos-openlink.entitlements}"
INSTALL_LOCAL="${OPENLINK_INSTALL_LOCAL:-0}"
LAUNCH_LOCAL="${OPENLINK_LAUNCH_LOCAL:-0}"

mkdir -p "$OUT_DIR"

bundle_app() {
    local name="$1"
    local binary="$2"
    local plist="$3"
    local bundle="$OUT_DIR/$name.app"

    rm -rf "$bundle"
    mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"
    cp -f "$binary" "$bundle/Contents/MacOS/$name"
    chmod 755 "$bundle/Contents/MacOS/$name"
    cp -f "$plist" "$bundle/Contents/Info.plist"

    if [[ -n "$PROVISIONING_PROFILE" ]]; then
        cp -f "$PROVISIONING_PROFILE" "$bundle/Contents/embedded.provisionprofile"
    fi

    if [[ -n "$SIGN_IDENTITY" ]]; then
        local sign_args=(--force --timestamp --options runtime --sign "$SIGN_IDENTITY")
        if [[ -n "$SIGN_KEYCHAIN" ]]; then
            sign_args+=(--keychain "$SIGN_KEYCHAIN")
        fi
        if [[ -f "$ENTITLEMENTS" ]]; then
            sign_args+=(--entitlements "$ENTITLEMENTS")
        fi
        codesign "${sign_args[@]}" "$bundle"
        codesign --verify --deep --strict --verbose=2 "$bundle"
    else
        echo "Skipping codesign for $name.app because OPENLINK_MACOS_SIGN_IDENTITY is not set."
    fi
}

echo "[1/2] Building OpenLink native app (Swift package)..."
cd "$REPO_ROOT/OpenLink"
swift build -c release
cp -f ".build/release/OpenLink" "$OUT_DIR/OpenLink" || true
bundle_app "OpenLink" ".build/release/OpenLink" "$REPO_ROOT/OpenLink/Resources/Info.plist"

echo "[2/2] Building OpenLink native installer (Swift package)..."
cd "$REPO_ROOT/OpenLinkInstaller"
swift build -c release
cp -f ".build/release/OpenLinkInstaller" "$OUT_DIR/OpenLinkInstaller" || true
bundle_app "OpenLinkInstaller" ".build/release/OpenLinkInstaller" "$REPO_ROOT/OpenLinkInstaller/Resources/Info.plist"

if [[ "$INSTALL_LOCAL" == "1" ]]; then
    echo "Replacing local /Applications/OpenLink.app with built app..."
    osascript -e 'tell application "OpenLink" to quit' >/dev/null 2>&1 || true
    rm -rf "/Applications/OpenLink.app"
    cp -R "$OUT_DIR/OpenLink.app" "/Applications/OpenLink.app"
fi

if [[ "$LAUNCH_LOCAL" == "1" ]]; then
    echo "Launching local OpenLink.app..."
    open "/Applications/OpenLink.app"
fi

echo "Native macOS build outputs:"
ls -la "$OUT_DIR"
