#!/usr/bin/env bash
set -euo pipefail

# Build a distributable data pack from the local data/ directory.
# Usage: ./scripts/package-data.sh [version]
#
# Compresses the entire data/ folder into a zip archive, excluding:
#   - data/sites/   (user-saved site JSON files — not distributable)
#   - data/.~lock.* (LibreOffice/spreadsheet lock files)
#
# The resulting archive can be installed via the Decision Theatre setup guide
# or by extracting it next to the application binary.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/data"

VERSION="${1:-$(cd "$PROJECT_ROOT" && git describe --tags --always --dirty 2>/dev/null || echo "dev")}"
DIST_DIR="$PROJECT_ROOT/dist"
PACK_NAME="decision-theatre-data-v${VERSION}"
WORK_DIR="$(mktemp -d)"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

echo "Building data pack: $PACK_NAME"
echo ""

# -------------------------------------------------------
# Step 1: Validate
# -------------------------------------------------------
if [ ! -d "$DATA_DIR" ]; then
    echo "ERROR: data/ directory not found at $DATA_DIR" >&2
    exit 1
fi

# -------------------------------------------------------
# Step 2: Copy data/ excluding sites/ and lock files
# -------------------------------------------------------
PACK_DIR="$WORK_DIR/$PACK_NAME"
mkdir -p "$PACK_DIR"

echo "==> Copying data/ (excluding sites/)..."

# tar pipe: archive data/ on the source side with exclusions, extract on dest side.
# This is portable and avoids requiring rsync.
tar -C "$PROJECT_ROOT" \
    --exclude='data/sites' \
    --exclude='data/.~lock.*' \
    -cf - data \
  | tar -C "$PACK_DIR" -xf -

echo "    $(find "$PACK_DIR/data" -type f | wc -l) files copied"

# -------------------------------------------------------
# Step 3: Generate manifest
# -------------------------------------------------------
echo "==> Writing manifest..."

MBTILES_LIST=$(
    find "$PACK_DIR/data/mbtiles" -maxdepth 1 -name "*.mbtiles" -printf '%f\n' 2>/dev/null \
    | sort \
    | jq -R -s 'split("\n") | map(select(length > 0))' \
    || echo "[]"
)

GPKG_EXISTS="false"
[ -f "$PACK_DIR/data/datapack.gpkg" ] && GPKG_EXISTS="true"

cat > "$PACK_DIR/manifest.json" <<EOF
{
  "format": "decision-theatre-datapack",
  "version": "$VERSION",
  "description": "Decision Theatre Data Pack — catchment scenario data and map tiles",
  "created": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "contents": {
    "mbtiles": $MBTILES_LIST,
    "geopackage": $GPKG_EXISTS
  }
}
EOF

# -------------------------------------------------------
# Step 4: Create zip and checksum
# -------------------------------------------------------
echo "==> Creating zip archive..."
mkdir -p "$DIST_DIR"
(cd "$WORK_DIR" && zip -r "$DIST_DIR/$PACK_NAME.zip" "$PACK_NAME")

echo "==> Generating checksum..."
(cd "$DIST_DIR" && sha256sum "$PACK_NAME.zip" > "$PACK_NAME.zip.sha256")

echo ""
echo "Data pack created:"
echo "  $DIST_DIR/$PACK_NAME.zip ($(du -h "$DIST_DIR/$PACK_NAME.zip" | cut -f1))"
echo "  $DIST_DIR/$PACK_NAME.zip.sha256"

"$SCRIPT_DIR/update-download-config.sh" --datapack "$DIST_DIR/$PACK_NAME.zip"
