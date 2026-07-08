#!/usr/bin/env bash
set -euo pipefail

# Build Linux/Windows executables via deployments/Dockerfile.cross and wire
# the result into the downloads page.
#
# Thin wrapper: the Dockerfile.cross export targets just place files in the
# output directory, so unlike the other build-*.sh scripts (which produce
# and configure the download in one place) this one also has to call
# update-download-config.sh itself after the docker build completes.
# See "Building Executables in Docker" in docs/developer-guide/releasing.md.
#
# Usage:
#   ./scripts/build-cross-docker.sh [--platform linux|windows|all] [--version VERSION] [--dest DIR]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

PLATFORM="all"
VERSION=""
DEST="$PROJECT_ROOT/dist/cross"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --platform) PLATFORM="$2"; shift 2 ;;
        --version)  VERSION="$2";  shift 2 ;;
        --dest)     DEST="$2";     shift 2 ;;
        -h|--help)
            echo "Usage: $0 [--platform linux|windows|all] [--version VERSION] [--dest DIR]"
            exit 0
            ;;
        *)
            echo "Unknown arg: $1" >&2
            exit 1
            ;;
    esac
done

require_cmd() {
    command -v "$1" >/dev/null 2>&1 || { echo "Error: required command not found: $1" >&2; exit 1; }
}
require_cmd docker

case "$PLATFORM" in
    linux|windows|all) ;;
    *)
        echo "Unknown platform: $PLATFORM (use linux, windows, or all)" >&2
        exit 1
        ;;
esac

VERSION="${VERSION:-$(cd "$PROJECT_ROOT" && git describe --tags --always --dirty 2>/dev/null || echo "dev")}"

mkdir -p "$DEST"

build_target() {
    local target="$1"
    echo "==> Building $target (version $VERSION)..."
    DOCKER_BUILDKIT=1 docker build \
        -f "$PROJECT_ROOT/deployments/Dockerfile.cross" \
        --target "$target" \
        --output "type=local,dest=$DEST" \
        --build-arg VERSION="$VERSION" \
        "$PROJECT_ROOT"
}

UPDATE_ARGS=()

if [ "$PLATFORM" = "linux" ] || [ "$PLATFORM" = "all" ]; then
    build_target export-linux-amd64
    UPDATE_ARGS+=(--executable-linux "$DEST/decision-theatre")
fi

if [ "$PLATFORM" = "windows" ] || [ "$PLATFORM" = "all" ]; then
    build_target export-windows-amd64
    UPDATE_ARGS+=(--executable-windows "$DEST/decision-theatre.exe")
fi

"$SCRIPT_DIR/update-download-config.sh" "${UPDATE_ARGS[@]}"

echo ""
echo "Executables in $DEST:"
ls -lh "$DEST"
