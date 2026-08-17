#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# check-data.sh — check a Decision Theatre data directory.
#
# This is a thin wrapper. The checks themselves live in Go, in
# internal/datacheck, and run through `decision-theatre check-data`.
#
# They were previously reimplemented here in shell, which meant the project
# carried two descriptions of what a valid data directory looks like — and the
# shell one could quietly fall behind the code that actually reads the files.
# Now the checker opens the GeoPackage and the tilesets through the same
# packages the application loads with, and internal/datacheck/spec_test.go
# fails the build if the runtime starts reading something the spec does not
# describe.
#
# Usage:
#   ./scripts/check-data.sh [DATA_DIR] [--json]
#   nix run .#check-data -- [DATA_DIR]
#   make check-data
#
# DATA_DIR defaults to ./data.
#
# Exit codes:
#   0  no errors (warnings may still be present)
#   1  one or more errors — the application will not work correctly
#   2  the data directory could not be examined
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib-build.sh
. "$SCRIPT_DIR/lib-build.sh"

cd "$PROJECT_ROOT"
dt_resolve_binary "$PROJECT_ROOT" || exit 2

exec "$DT_RESOLVED_BIN" check-data "$@"
