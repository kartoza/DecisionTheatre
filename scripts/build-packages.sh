#!/usr/bin/env bash
set -euo pipefail

# Build release packages for Decision Theatre.
#
# Usage:
#   ./scripts/build-packages.sh [--platform linux|windows|darwin|flatpak|snap|all] [--arch amd64|arm64] [--version VERSION]
#
# Produces dist/ artefacts:
#   Linux:   .tar.gz, .deb, .rpm  (native build, requires nfpm for deb/rpm)
#   Flatpak: .flatpak             (requires flatpak-builder)
#   Snap:    .snap                (requires snapcraft)
#   Windows: .zip with .exe       (cross-compile via mingw-w64, or native on Windows)
#   macOS:   .tar.gz (or .dmg if on macOS with hdiutil)
#
# Prerequisites (available in nix develop):
#   - go, gcc, pkg-config          (always)
#   - nfpm                         (linux deb/rpm)
#   - flatpak-builder              (flatpak)
#   - snapcraft                    (snap)
#   - x86_64-w64-mingw32-gcc / CXX (windows cross-compile from linux)
#   - zip                          (windows .zip)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
PLATFORM="all"
ARCH="amd64"
VERSION=""

# Parse args
while [[ $# -gt 0 ]]; do
    case "$1" in
        --platform) PLATFORM="$2"; shift 2 ;;
        --arch)     ARCH="$2";     shift 2 ;;
        --version)  VERSION="$2";  shift 2 ;;
        *)          echo "Unknown arg: $1" >&2; exit 1 ;;
    esac
done

VERSION="${VERSION:-$(cd "$PROJECT_ROOT" && git describe --tags --always --dirty 2>/dev/null || echo "dev")}"
DIST_DIR="$PROJECT_ROOT/dist"
BINARY_NAME="decision-theatre"
LDFLAGS="-s -w -X main.version=${VERSION}"

mkdir -p "$DIST_DIR"

# -------------------------------------------------------
# Helper: setup webkit2gtk pkg-config compatibility
# webview_go hardcodes webkit2gtk-4.0 but nixpkgs ships 4.1
# -------------------------------------------------------
setup_webkit_compat() {
    if [ -n "${WEBKIT_COMPAT_SETUP:-}" ]; then
        return 0
    fi

    # Check if we need the compatibility shim (nix environment)
    if pkg-config --exists webkit2gtk-4.0 2>/dev/null; then
        return 0
    fi

    if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
        echo "WARNING: Neither webkit2gtk-4.0 nor webkit2gtk-4.1 found" >&2
        return 0
    fi

    echo "==> Setting up webkit2gtk-4.0 compatibility shim..."
    local compat_dir="$DIST_DIR/.webkit-compat"
    mkdir -p "$compat_dir/pkgconfig" "$compat_dir/lib"

    # Get the webkit2gtk-4.1 pc file location
    local pc_file=$(pkg-config --variable=pcfiledir webkit2gtk-4.1)/webkit2gtk-4.1.pc
    if [ -f "$pc_file" ]; then
        sed 's/webkit2gtk-4.1/webkit2gtk-4.0/g; s/Name: webkit2gtk-4.1/Name: webkit2gtk-4.0/' \
            "$pc_file" > "$compat_dir/pkgconfig/webkit2gtk-4.0.pc"
        sed -i "s|-lwebkit2gtk-4.1|-lwebkit2gtk-4.0|g" "$compat_dir/pkgconfig/webkit2gtk-4.0.pc"
    fi

    # Find and symlink the library
    local lib_path=$(pkg-config --variable=libdir webkit2gtk-4.1)
    if [ -f "$lib_path/libwebkit2gtk-4.1.so" ]; then
        ln -sf "$lib_path/libwebkit2gtk-4.1.so" "$compat_dir/lib/libwebkit2gtk-4.0.so"
    fi

    export PKG_CONFIG_PATH="$compat_dir/pkgconfig:${PKG_CONFIG_PATH:-}"
    export CGO_LDFLAGS="-L$compat_dir/lib ${CGO_LDFLAGS:-}"
    export LD_LIBRARY_PATH="$compat_dir/lib:${LD_LIBRARY_PATH:-}"
    export WEBKIT_COMPAT_SETUP=1
}

# -------------------------------------------------------
# Helper: build the frontend + docs into embed dirs
# -------------------------------------------------------
ensure_frontend() {
    if [ ! -f "$PROJECT_ROOT/internal/server/static/index.html" ]; then
        echo "==> Building frontend..."
        make -C "$PROJECT_ROOT" build-frontend
    fi
    if [ ! -d "$PROJECT_ROOT/internal/server/docs_site" ] || [ -z "$(ls -A "$PROJECT_ROOT/internal/server/docs_site" 2>/dev/null)" ]; then
        echo "==> Building docs..."
        make -C "$PROJECT_ROOT" build-docs
    fi
}

# -------------------------------------------------------
# Linux native build
# -------------------------------------------------------
build_linux() {
    local arch="${1:-$ARCH}"
    echo "==> Building linux/${arch}..."
    ensure_frontend
    setup_webkit_compat

    CGO_ENABLED=1 GOOS=linux GOARCH="$arch" \
        go build -ldflags "$LDFLAGS" -o "$DIST_DIR/${BINARY_NAME}" "$PROJECT_ROOT"

    # tar.gz
    local tarball="${BINARY_NAME}-linux-${arch}-v${VERSION}.tar.gz"
    tar -czf "$DIST_DIR/$tarball" -C "$DIST_DIR" "$BINARY_NAME"
    echo "  -> $DIST_DIR/$tarball"

    # deb + rpm via nfpm (if available)
    if command -v nfpm &>/dev/null; then
        echo "==> Building .deb and .rpm via nfpm..."
        export VERSION GOARCH="$arch"
        (cd "$PROJECT_ROOT" && nfpm package --packager deb --target "$DIST_DIR/")
        (cd "$PROJECT_ROOT" && nfpm package --packager rpm --target "$DIST_DIR/")
    else
        echo "  (nfpm not found — skipping .deb/.rpm; install with: nix profile install nixpkgs#nfpm)"
    fi

    rm -f "$DIST_DIR/${BINARY_NAME}"
}

# -------------------------------------------------------
# Windows cross-compile
# -------------------------------------------------------
build_windows() {
    local arch="${1:-$ARCH}"
    echo "==> Building windows/${arch}..."
    ensure_frontend

    # Determine cross-compiler
    local cc cxx
    if [ "$arch" = "amd64" ]; then
        cc="x86_64-w64-mingw32-gcc"
        cxx="x86_64-w64-mingw32-g++"
    else
        cc="aarch64-w64-mingw32-gcc"
        cxx="aarch64-w64-mingw32-g++"
    fi

    if ! command -v "$cc" &>/dev/null; then
        echo "ERROR: $cc not found. Install mingw-w64 for Windows cross-compilation." >&2
        echo "  On NixOS / nix: nix-shell -p pkgsCross.mingwW64.stdenv.cc" >&2
        echo "  On Ubuntu:      sudo apt install gcc-mingw-w64-x86-64 g++-mingw-w64-x86-64" >&2
        return 1
    fi

    CGO_ENABLED=1 CC="$cc" CXX="$cxx" GOOS=windows GOARCH="$arch" \
        go build -ldflags "$LDFLAGS" -o "$DIST_DIR/${BINARY_NAME}.exe" "$PROJECT_ROOT"

    # Create zip
    local zipname="${BINARY_NAME}-windows-${arch}-v${VERSION}.zip"
    (cd "$DIST_DIR" && zip -j "$zipname" "${BINARY_NAME}.exe")
    echo "  -> $DIST_DIR/$zipname"

    # Build .msi via WiX Toolset (if wix CLI available)
    if command -v wix &>/dev/null; then
        echo "==> Building Windows .msi installer via WiX..."
        local msiname="${BINARY_NAME}-windows-${arch}-v${VERSION}.msi"
        wix build \
            -d Version="$VERSION" \
            -o "$DIST_DIR/$msiname" \
            "$PROJECT_ROOT/packaging/windows/product.wxs"
        echo "  -> $DIST_DIR/$msiname"
    else
        echo "  (wix CLI not found — skipping .msi; install WiX Toolset v4+ or build on Windows)"
    fi

    rm -f "$DIST_DIR/${BINARY_NAME}.exe"
}

# -------------------------------------------------------
# macOS build (native only — CGO cross-compile not viable)
# -------------------------------------------------------
build_darwin() {
    local arch="${1:-$ARCH}"
    echo "==> Building darwin/${arch}..."
    ensure_frontend

    if [ "$(uname -s)" != "Darwin" ]; then
        echo "WARNING: macOS builds require running on macOS (CGO + webview). Skipping." >&2
        return 0
    fi

    CGO_ENABLED=1 GOOS=darwin GOARCH="$arch" \
        go build -ldflags "$LDFLAGS" -o "$DIST_DIR/${BINARY_NAME}" "$PROJECT_ROOT"

    # Use create-dmg.sh if available, otherwise tar.gz
    if command -v hdiutil &>/dev/null && [ -f "$PROJECT_ROOT/packaging/macos/create-dmg.sh" ]; then
        (cd "$DIST_DIR" && bash "$PROJECT_ROOT/packaging/macos/create-dmg.sh" "${BINARY_NAME}" "$VERSION" "$arch")
    else
        local tarball="${BINARY_NAME}-darwin-${arch}-v${VERSION}.tar.gz"
        tar -czf "$DIST_DIR/$tarball" -C "$DIST_DIR" "$BINARY_NAME"
        echo "  -> $DIST_DIR/$tarball"
    fi

    rm -f "$DIST_DIR/${BINARY_NAME}"
}

# -------------------------------------------------------
# Flatpak build
# -------------------------------------------------------
build_flatpak() {
    local arch="${1:-$ARCH}"
    echo "==> Building Flatpak..."
    ensure_frontend
    setup_webkit_compat

    if ! command -v flatpak-builder &>/dev/null; then
        echo "WARNING: flatpak-builder not found. Install with: sudo apt install flatpak-builder" >&2
        echo "  On Fedora: sudo dnf install flatpak-builder" >&2
        return 1
    fi

    local manifest="$PROJECT_ROOT/packaging/flatpak/org.kartoza.DecisionTheatre.yml"
    local runtime sdk runtime_version
    runtime="$(awk -F': *' '/^runtime:/{print $2}' "$manifest" | tr -d "'\"")"
    sdk="$(awk -F': *' '/^sdk:/{print $2}' "$manifest" | tr -d "'\"")"
    runtime_version="$(awk -F': *' '/^runtime-version:/{print $2}' "$manifest" | tr -d "'\"")"

    if ! flatpak info "${runtime}//${runtime_version}" >/dev/null 2>&1 || ! flatpak info "${sdk}//${runtime_version}" >/dev/null 2>&1; then
        echo "ERROR: Required Flatpak runtime/sdk not installed: ${runtime} ${runtime_version}, ${sdk} ${runtime_version}" >&2
        echo "Install them with:" >&2
        echo "  flatpak remote-add --if-not-exists flathub https://flathub.org/repo/flathub.flatpakrepo" >&2
        echo "  flatpak install -y flathub ${runtime}//${runtime_version} ${sdk}//${runtime_version}" >&2
        return 1
    fi

    # First build the Linux binary
    CGO_ENABLED=1 GOOS=linux GOARCH="$arch" \
        go build -ldflags "$LDFLAGS" -o "$DIST_DIR/${BINARY_NAME}" "$PROJECT_ROOT"

    # Prepare flatpak build directory
    local flatpak_build="$DIST_DIR/flatpak-build"
    local flatpak_repo="$DIST_DIR/flatpak-repo"
    rm -rf "$flatpak_build" "$flatpak_repo"
    mkdir -p "$flatpak_build"

    # Copy binary and desktop file to flatpak source location
    cp "$DIST_DIR/${BINARY_NAME}" "$PROJECT_ROOT/packaging/flatpak/"
    cp "$PROJECT_ROOT/packaging/decision-theatre.desktop" "$PROJECT_ROOT/packaging/flatpak/"

    # Build the flatpak
    if ! flatpak-builder --force-clean --repo="$flatpak_repo" \
        "$flatpak_build" "$manifest"; then
        echo "ERROR: flatpak-builder failed; skipping Flatpak bundle generation." >&2
        rm -f "$PROJECT_ROOT/packaging/flatpak/${BINARY_NAME}"
        rm -f "$PROJECT_ROOT/packaging/flatpak/decision-theatre.desktop"
        rm -rf "$flatpak_build" "$flatpak_repo"
        rm -f "$DIST_DIR/${BINARY_NAME}"
        return 1
    fi

    # Create the single-file bundle
    local flatpak_name="${BINARY_NAME}-v${VERSION}-${arch}.flatpak"
    flatpak build-bundle "$flatpak_repo" "$DIST_DIR/$flatpak_name" org.kartoza.DecisionTheatre
    echo "  -> $DIST_DIR/$flatpak_name"

    # Cleanup
    rm -f "$PROJECT_ROOT/packaging/flatpak/${BINARY_NAME}"
    rm -f "$PROJECT_ROOT/packaging/flatpak/decision-theatre.desktop"
    rm -rf "$flatpak_build" "$flatpak_repo"
    rm -f "$DIST_DIR/${BINARY_NAME}"
}

# -------------------------------------------------------
# Snap build
# -------------------------------------------------------
build_snap() {
    local arch="${1:-$ARCH}"
    echo "==> Building Snap..."
    ensure_frontend
    setup_webkit_compat

    if ! command -v snapcraft &>/dev/null; then
        echo "WARNING: snapcraft not found. Install with: sudo snap install snapcraft --classic" >&2
        return 1
    fi

    # First build the Linux binary
    CGO_ENABLED=1 GOOS=linux GOARCH="$arch" \
        go build -ldflags "$LDFLAGS" -o "$DIST_DIR/${BINARY_NAME}" "$PROJECT_ROOT"

    # Copy binary to snap source location
    cp "$DIST_DIR/${BINARY_NAME}" "$PROJECT_ROOT/packaging/snap/"

    # Update version in snapcraft.yaml
    local snapcraft_file="$PROJECT_ROOT/packaging/snap/snapcraft.yaml"
    sed -i "s/^version:.*/version: '${VERSION}'/" "$snapcraft_file"

    # Build the snap
    (cd "$PROJECT_ROOT/packaging/snap" && snapcraft --destructive-mode)

    # Move the snap to dist
    local snap_file=$(ls "$PROJECT_ROOT/packaging/snap/"*.snap 2>/dev/null | head -1)
    if [ -n "$snap_file" ]; then
        mv "$snap_file" "$DIST_DIR/"
        echo "  -> $DIST_DIR/$(basename "$snap_file")"
    fi

    # Cleanup
    rm -f "$PROJECT_ROOT/packaging/snap/${BINARY_NAME}"
    rm -f "$DIST_DIR/${BINARY_NAME}"

    # Restore version line
    sed -i "s/^version:.*/version: git/" "$snapcraft_file"
}

# -------------------------------------------------------
# Checksums
# -------------------------------------------------------
generate_checksums() {
    echo "==> Generating checksums..."
    (cd "$DIST_DIR" && sha256sum *.tar.gz *.zip *.deb *.rpm *.msi *.dmg *.flatpak *.snap 2>/dev/null > "checksums-v${VERSION}.sha256" || true)
    echo "  -> $DIST_DIR/checksums-v${VERSION}.sha256"
}

# -------------------------------------------------------
# Main dispatch
# -------------------------------------------------------
case "$PLATFORM" in
    linux)   build_linux "$ARCH" ;;
    windows) build_windows "$ARCH" ;;
    darwin)  build_darwin "$ARCH" ;;
    flatpak) build_flatpak "$ARCH" ;;
    snap)    build_snap "$ARCH" ;;
    all)
        build_linux "$ARCH"
        build_windows "$ARCH" || true
        build_darwin "$ARCH" || true
        build_flatpak "$ARCH" || true
        build_snap "$ARCH" || true
        generate_checksums
        ;;
    *)
        echo "Unknown platform: $PLATFORM (use linux, windows, darwin, flatpak, snap, or all)" >&2
        exit 1
        ;;
esac

echo ""
echo "Packages in $DIST_DIR:"
ls -lh "$DIST_DIR/"*v${VERSION}* 2>/dev/null || ls -lh "$DIST_DIR/"*.{tar.gz,zip,deb,rpm,flatpak,snap,dmg,msi} 2>/dev/null || echo "  (none)"
