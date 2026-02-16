#!/usr/bin/env bash
set -euo pipefail

# Build a data pack zip from local data/ directory.
# Usage: ./scripts/package-data.sh [version]
#
# The data pack bundles:
#   - Parquet files (converted from CSVs via csv2parquet.py)
#   - MBTiles catchment map tiles (from data/mbtiles/)
#   - Tile style JSON
#
# The resulting zip can be installed into Decision Theatre via the UI
# or by extracting it and pointing --data-dir at it.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION="${1:-$(cd "$PROJECT_ROOT" && git describe --tags --always --dirty 2>/dev/null || echo "dev")}"
DIST_DIR="$PROJECT_ROOT/dist"
PACK_NAME="decision-theatre-data-v${VERSION}"
WORK_DIR="$(mktemp -d)"

cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT

echo "Building data pack: $PACK_NAME"
echo ""

# -------------------------------------------------------
# Step 1: Convert CSVs to Parquet (if CSVs exist)
# -------------------------------------------------------
CSV_COUNT=$(find "$PROJECT_ROOT/data" -maxdepth 1 -name '*.csv' 2>/dev/null | wc -l)
PARQUET_COUNT=$(find "$PROJECT_ROOT/data" -maxdepth 1 -name '*.parquet' 2>/dev/null | wc -l)

if [ "$CSV_COUNT" -gt 0 ]; then
    echo "==> Converting $CSV_COUNT CSV file(s) to Parquet..."
    python3 "$SCRIPT_DIR/csv2parquet.py" --data-dir "$PROJECT_ROOT/data"
    echo ""
elif [ "$PARQUET_COUNT" -gt 0 ]; then
    echo "==> Found $PARQUET_COUNT existing Parquet file(s) (no CSVs to convert)"
else
    echo "WARNING: No CSV or Parquet files found in data/" >&2
fi

# -------------------------------------------------------
# Step 2: Validate required resources
# -------------------------------------------------------
if [ ! -d "$PROJECT_ROOT/data/mbtiles" ]; then
    echo "ERROR: data/mbtiles directory not found" >&2
    exit 1
fi

if [ ! -f "$PROJECT_ROOT/data/mbtiles/catchments.mbtiles" ]; then
    echo "ERROR: data/mbtiles/catchments.mbtiles not found" >&2
    exit 1
fi

# -------------------------------------------------------
# Step 3: Assemble pack
# -------------------------------------------------------
PACK_DIR="$WORK_DIR/$PACK_NAME"
mkdir -p "$PACK_DIR/data/mbtiles"

# Copy Parquet files
PARQUET_FILES=("$PROJECT_ROOT/data/"*.parquet)
if [ -e "${PARQUET_FILES[0]}" ]; then
    echo "==> Bundling Parquet files..."
    cp "$PROJECT_ROOT/data/"*.parquet "$PACK_DIR/data/"
    for f in "$PACK_DIR/data/"*.parquet; do
        echo "    $(basename "$f") ($(du -h "$f" | cut -f1))"
    done
else
    echo "WARNING: No Parquet files to bundle" >&2
fi

# Copy mbtiles and style JSON (exclude build scripts and source gpkg)
echo "==> Bundling MBTiles and styles..."
cp "$PROJECT_ROOT/data/mbtiles/catchments.mbtiles" "$PACK_DIR/data/mbtiles/"
echo "    catchments.mbtiles ($(du -h "$PACK_DIR/data/mbtiles/catchments.mbtiles" | cut -f1))"

if [ -f "$PROJECT_ROOT/data/mbtiles/style.json" ]; then
    cp "$PROJECT_ROOT/data/mbtiles/style.json" "$PACK_DIR/data/mbtiles/"
    echo "    style.json"
fi

if [ -f "$PROJECT_ROOT/data/mbtiles/uow_tiles.json" ]; then
    cp "$PROJECT_ROOT/data/mbtiles/uow_tiles.json" "$PACK_DIR/data/mbtiles/"
    echo "    uow_tiles.json"
fi

# -------------------------------------------------------
# Step 4: Generate manifest
# -------------------------------------------------------
echo "==> Writing manifest..."
PARQUET_LIST=$(cd "$PACK_DIR/data" 2>/dev/null && ls *.parquet 2>/dev/null | jq -R -s 'split("\n") | map(select(length > 0))' || echo "[]")
MBTILES_LIST=$(cd "$PACK_DIR/data/mbtiles" 2>/dev/null && ls *.mbtiles 2>/dev/null | jq -R -s 'split("\n") | map(select(length > 0))' || echo "[]")
cat > "$PACK_DIR/manifest.json" <<EOF
{
  "format": "decision-theatre-datapack",
  "version": "$VERSION",
  "description": "Decision Theatre Data Pack — catchment scenario data and map tiles",
  "created": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "contents": {
    "parquet": $PARQUET_LIST,
    "mbtiles": $MBTILES_LIST
  }
}
EOF

# -------------------------------------------------------
# Step 5: Create zip and checksum
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
