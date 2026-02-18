#!/usr/bin/env bash
set -euo pipefail

# Build a Windows MSI installer for Decision Theatre.
# On Linux, this cross-compiles the Windows binary using mingw-w64,
# then builds the MSI using WiX.
# Usage:
#   ./scripts/build-windows-installer.sh [--skip-frontend] [--skip-docs] [--version VERSION] [--arch amd64]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SKIP_FRONTEND=0
SKIP_DOCS=0
VERSION=""
ARCH=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --skip-frontend) SKIP_FRONTEND=1; shift ;;
        --skip-docs)     SKIP_DOCS=1; shift ;;
        --version)       VERSION="$2"; shift 2 ;;
        --arch)          ARCH="$2"; shift 2 ;;
        -h|--help)
            echo "Usage: $0 [--skip-frontend] [--skip-docs] [--version VERSION] [--arch amd64]"
            exit 0
            ;;
        *)
            echo "Unknown arg: $1" >&2
            exit 1
            ;;
    esac
done

cd "$PROJECT_ROOT"

require_cmd() {
    local cmd="$1"
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Error: required command not found: $cmd" >&2
        exit 1
    fi
}

resolve_windows_arch() {
    local requested="${1:-}"
    if [ -n "$requested" ]; then
        case "$requested" in
            amd64) printf "%s" "$requested" ;;
            *)
                echo "Error: unsupported arch '$requested' (use amd64)" >&2
                exit 1
                ;;
        esac
        return 0
    fi

    case "$(go env GOARCH)" in
        amd64) echo "amd64" ;;
        *)
            echo "Error: could not determine Windows architecture (supported: amd64)" >&2
            exit 1
            ;;
    esac
}

sanitize_filename_version() {
    local raw="$1"
    raw="${raw#v}"
    raw="$(echo "$raw" | sed 's/[^0-9A-Za-z._-]/./g')"
    [ -n "$raw" ] || raw="0.0.0"
    printf "%s" "$raw"
}

to_msi_version() {
    local raw="$1"
    raw="${raw#v}"

    local major=0
    local minor=0
    local patch=0

    if [[ "$raw" =~ ^([0-9]+)(\.([0-9]+))?(\.([0-9]+))? ]]; then
        major="${BASH_REMATCH[1]}"
        if [ -n "${BASH_REMATCH[3]:-}" ]; then
            minor="${BASH_REMATCH[3]}"
        fi
        if [ -n "${BASH_REMATCH[5]:-}" ]; then
            patch="${BASH_REMATCH[5]}"
        fi
    fi

    # MSI ProductVersion fields are limited to 0-65535.
    if [ "$major" -gt 65535 ]; then major=65535; fi
    if [ "$minor" -gt 65535 ]; then minor=65535; fi
    if [ "$patch" -gt 65535 ]; then patch=65535; fi

    printf "%s.%s.%s" "$major" "$minor" "$patch"
}

resolve_wix_cmd() {
    if command -v wix >/dev/null 2>&1; then
        command -v wix
        return 0
    fi

    local local_wix="$PROJECT_ROOT/.tools/wix/wix"
    if [ -x "$local_wix" ]; then
        printf "%s" "$local_wix"
        return 0
    fi

    if command -v dotnet >/dev/null 2>&1; then
        echo "==> Installing local WiX CLI into .tools/wix ..."
        mkdir -p "$PROJECT_ROOT/.tools/wix"
        dotnet tool install --tool-path "$PROJECT_ROOT/.tools/wix" wix >/dev/null
        if [ -x "$local_wix" ]; then
            printf "%s" "$local_wix"
            return 0
        fi
    fi

    echo "Error: WiX CLI not found. Install with: dotnet tool install --global wix" >&2
    exit 1
}

require_cmd go
require_cmd make

DETECTED_ARCH="$(resolve_windows_arch "$ARCH")"
if [ "$DETECTED_ARCH" != "amd64" ]; then
    echo "Error: only amd64 is supported for Windows MSI packaging" >&2
    exit 1
fi

require_cmd x86_64-w64-mingw32-gcc

WIX_CMD="$(resolve_wix_cmd)"

# Prevent host-machine absolute source paths from being embedded in the binary
# (e.g. in panic stack traces). Keep any existing GOFLAGS and append -trimpath.
if [[ " ${GOFLAGS:-} " != *" -trimpath "* ]]; then
    export GOFLAGS="${GOFLAGS:-} -trimpath"
fi

if [ "$SKIP_FRONTEND" -eq 0 ]; then
    echo "==> Building frontend..."
    make -C "$PROJECT_ROOT" build-frontend
fi

if [ "$SKIP_DOCS" -eq 0 ]; then
    echo "==> Building docs..."
    make -C "$PROJECT_ROOT" build-docs
fi

RAW_VERSION="${VERSION:-$(git -C "$PROJECT_ROOT" describe --tags --always --dirty 2>/dev/null || echo "dev")}" 
FILE_VERSION="$(sanitize_filename_version "$RAW_VERSION")"
MSI_VERSION="$(to_msi_version "$RAW_VERSION")"

DIST_DIR="$PROJECT_ROOT/dist"
BIN_DIR="$PROJECT_ROOT/bin"
WINDOWS_EXE="$BIN_DIR/decision-theatre.exe"
MSI_FILE="$DIST_DIR/decision-theatre_${FILE_VERSION}_windows_${DETECTED_ARCH}.msi"

mkdir -p "$DIST_DIR" "$BIN_DIR"

echo "==> Building Windows binary..."
CGO_ENABLED=1 \
GOOS=windows \
GOARCH=amd64 \
CC=x86_64-w64-mingw32-gcc \
CXX=x86_64-w64-mingw32-g++ \
go build -ldflags "-s -w -X main.version=$RAW_VERSION" -o "$WINDOWS_EXE" .

# product.wxs currently references dist\decision-theatre.exe.
cp "$WINDOWS_EXE" "$DIST_DIR/decision-theatre.exe"

echo "==> Building MSI package with WiX..."
"$WIX_CMD" build "$PROJECT_ROOT/packaging/windows/product.wxs" \
    -d Version="$MSI_VERSION" \
    -o "$MSI_FILE"

echo ""
echo "Windows MSI package build complete: $MSI_FILE"
