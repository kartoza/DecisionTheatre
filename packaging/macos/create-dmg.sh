#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Kartoza
# SPDX-License-Identifier: AGPL-3.0-only

set -euo pipefail

# Creates a macOS .app bundle and .dmg from a pre-built binary.
# Usage: ./packaging/macos/create-dmg.sh <binary-path> <version> <arch>

BINARY="$1"
VERSION="$2"
ARCH="${3:-arm64}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="Decision Theatre"
APP_DIR="${APP_NAME}.app"
DMG_NAME="decision-theatre-darwin-${ARCH}.dmg"

# Create .app bundle structure
rm -rf "$APP_DIR"
mkdir -p "${APP_DIR}/Contents/MacOS"
mkdir -p "${APP_DIR}/Contents/Resources"

# Copy binary
cp "$BINARY" "${APP_DIR}/Contents/MacOS/decision-theatre"
chmod +x "${APP_DIR}/Contents/MacOS/decision-theatre"

# Copy Info.plist with version substitution
sed "s/\${VERSION}/${VERSION}/g" "${SCRIPT_DIR}/Info.plist" > "${APP_DIR}/Contents/Info.plist"

# Create DMG
hdiutil create -volname "${APP_NAME}" \
    -srcfolder "${APP_DIR}" \
    -ov -format UDZO \
    "${DMG_NAME}"

echo "Created: ${DMG_NAME}"
