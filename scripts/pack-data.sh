#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# pack-data.sh — check the data directory, then build a distributable pack.
#
# A thin wrapper: the packing lives in Go, in internal/datacheck, and runs
# through `decision-theatre pack-data`. That way the pack is assembled from the
# same inventory the checker classifies, so it cannot include a file the
# checker calls extraneous or omit one the application needs.
#
# The pack is refused if the check reports errors. Pass --force to override.
#
# Usage:
#   ./scripts/pack-data.sh [VERSION] [-- extra flags]
#   nix run .#pack-data -- [DATA_DIR]
#   make pack-data
#
# Exit codes:
#   0  the pack was built
#   1  the check failed and --force was not given
#   2  the directory could not be examined, or the pack could not be written
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib-build.sh
. "$SCRIPT_DIR/lib-build.sh"

cd "$PROJECT_ROOT"

# A bare first argument is the version label, which is how the Makefile and the
# release scripts have always called this script.
VERSION_ARG=()
if [ $# -gt 0 ] && [[ "$1" != -* ]]; then
    VERSION_ARG=(--pack-version "$1")
    shift
fi

if [ ${#VERSION_ARG[@]} -eq 0 ]; then
    VERSION_ARG=(--pack-version "$("$SCRIPT_DIR/version.sh")")
fi

dt_resolve_binary "$PROJECT_ROOT" || exit 2

"$DT_RESOLVED_BIN" pack-data "${VERSION_ARG[@]}" "$@"

# Point the in-app downloads page at the pack just built. Kept here rather than
# in the Go tool because it edits the developer's own settings.json, which is a
# convenience of the local build, not a property of the pack.
PACK_VERSION="${VERSION_ARG[1]}"
PACK_PATH="$PROJECT_ROOT/dist/decision-theatre-data-v${PACK_VERSION}.zip"
if [ -f "$PACK_PATH" ]; then
    "$SCRIPT_DIR/update-download-config.sh" --datapack "$PACK_PATH"
fi
