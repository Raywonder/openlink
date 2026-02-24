#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/dist/native-macos"

mkdir -p "$OUT_DIR"

echo "[1/2] Building OpenLink native app (Swift package)..."
cd "$REPO_ROOT/OpenLink"
swift build -c release
cp -f ".build/release/OpenLink" "$OUT_DIR/OpenLink" || true

echo "[2/2] Building OpenLink native installer (Swift package)..."
cd "$REPO_ROOT/OpenLinkInstaller"
swift build -c release
cp -f ".build/release/OpenLinkInstaller" "$OUT_DIR/OpenLinkInstaller" || true

echo "Native macOS build outputs:"
ls -la "$OUT_DIR"
