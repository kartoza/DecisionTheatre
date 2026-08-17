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

VERSION="${VERSION:-$("$SCRIPT_DIR/version.sh")}"

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

# Translates a host path under $PROJECT_ROOT/dist to its path inside the
# deployments-app container, where dist/ is bind-mounted at /app/dist (see
# deployments/docker-compose.yaml). Fails if the path is outside dist/, e.g.
# a custom --dest, since the container can't see it.
container_path() {
    local host_path="$1"
    case "$host_path" in
        "$PROJECT_ROOT/dist"/*)
            printf '/app/dist/%s' "${host_path#"$PROJECT_ROOT"/dist/}"
            ;;
        *)
            return 1
            ;;
    esac
}

UPDATE_ARGS=()
CONTAINER_UPDATE_ARGS=()

if [ "$PLATFORM" = "linux" ] || [ "$PLATFORM" = "all" ]; then
    build_target export-linux-amd64
    UPDATE_ARGS+=(--executable-linux "$DEST/decision-theatre")
    if container_dest="$(container_path "$DEST/decision-theatre")"; then
        CONTAINER_UPDATE_ARGS+=(--executable-linux "$container_dest")
    fi
fi

if [ "$PLATFORM" = "windows" ] || [ "$PLATFORM" = "all" ]; then
    build_target export-windows-amd64
    UPDATE_ARGS+=(--executable-windows "$DEST/decision-theatre.exe")
    if container_dest="$(container_path "$DEST/decision-theatre.exe")"; then
        CONTAINER_UPDATE_ARGS+=(--executable-windows "$container_dest")
    fi
fi

"$SCRIPT_DIR/update-download-config.sh" "${UPDATE_ARGS[@]}"

# If the deployments-app container is running, it serves the downloads page
# from its own settings.json (a separate named volume, not the host's), so
# the update above never reaches it. Mirror the `make datapack` behaviour and
# update it too, provided the artefacts landed under dist/ where the
# container can see them.
APP_CID=""
if command -v docker >/dev/null 2>&1 && [ -d "$PROJECT_ROOT/deployments" ]; then
    APP_CID="$(cd "$PROJECT_ROOT/deployments" && docker compose ps -q app 2>/dev/null || true)"
fi

if [ -n "$APP_CID" ] && [ "$(docker inspect -f '{{.State.Running}}' "$APP_CID" 2>/dev/null)" = "true" ]; then
    if [ "${#CONTAINER_UPDATE_ARGS[@]}" -gt 0 ]; then
        echo "==> Updating downloads config inside the running deployments-app container..."
        docker exec "$APP_CID" /app/scripts/update-download-config.sh "${CONTAINER_UPDATE_ARGS[@]}"
    else
        echo "NOTE: deployments-app container is running but --dest is outside dist/, so its downloads config was not updated." >&2
    fi
fi

echo ""
echo "Executables in $DEST:"
ls -lh "$DEST"
