#!/usr/bin/env bash
set -euo pipefail

# Build the Go backend with webkit2gtk compatibility
# This script handles the webkit2gtk-4.0 vs 4.1 compatibility issue
# (webview_go expects 4.0 but many distros including nixpkgs ship 4.1)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"

# Version comes from scripts/version.sh so every build path agrees
VERSION=$("$SCRIPT_DIR/version.sh")
COMMIT=$("$SCRIPT_DIR/commit.sh")

# Check if webkit2gtk-4.0 already exists
if pkg-config --exists webkit2gtk-4.0 2>/dev/null; then
    echo "==> Using system webkit2gtk-4.0"
    mkdir -p bin
    CGO_ENABLED=1 go build -ldflags "-s -w -X main.version=$VERSION -X main.commit=$COMMIT" -o bin/decision-theatre .
    exit 0
fi

# Try to create compat shim from webkit2gtk-4.1
if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    echo "Error: Neither webkit2gtk-4.0 nor webkit2gtk-4.1 found"
    echo "Install libwebkit2gtk-4.1-dev (Debian/Ubuntu) or webkit2gtk4.1-devel (Fedora)"
    exit 1
fi

echo "==> Creating webkit2gtk-4.0 compatibility shim from 4.1..."

COMPAT_DIR="$PROJECT_ROOT/.webkit-compat"
mkdir -p "$COMPAT_DIR/pkgconfig" "$COMPAT_DIR/lib"

WEBKIT_PC_DIR=$(pkg-config --variable=pcfiledir webkit2gtk-4.1)
WEBKIT_PC="$WEBKIT_PC_DIR/webkit2gtk-4.1.pc"
WEBKIT_LIB_DIR=$(pkg-config --variable=libdir webkit2gtk-4.1)

# Create the .pc file for webkit2gtk-4.0
sed 's/webkit2gtk-4.1/webkit2gtk-4.0/g; s/Name: webkit2gtk-4.1/Name: webkit2gtk-4.0/' \
    "$WEBKIT_PC" > "$COMPAT_DIR/pkgconfig/webkit2gtk-4.0.pc"
sed -i 's|-lwebkit2gtk-4.1|-lwebkit2gtk-4.0|g' "$COMPAT_DIR/pkgconfig/webkit2gtk-4.0.pc"

# Create symlink for the library
if [ -f "$WEBKIT_LIB_DIR/libwebkit2gtk-4.1.so" ]; then
    ln -sf "$WEBKIT_LIB_DIR/libwebkit2gtk-4.1.so" "$COMPAT_DIR/lib/libwebkit2gtk-4.0.so"
fi

# Build with the compat paths
# Note: nix uses PKG_CONFIG_PATH_FOR_TARGET wrapper, so set both for portability
export PKG_CONFIG_PATH="$COMPAT_DIR/pkgconfig:${PKG_CONFIG_PATH:-}"
export PKG_CONFIG_PATH_FOR_TARGET="$COMPAT_DIR/pkgconfig:${PKG_CONFIG_PATH_FOR_TARGET:-}"
export CGO_LDFLAGS="-L$COMPAT_DIR/lib ${CGO_LDFLAGS:-}"

mkdir -p bin
CGO_ENABLED=1 go build -ldflags "-s -w -X main.version=$VERSION -X main.commit=$COMMIT" -o bin/decision-theatre .
