#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# GeoPackage → Vector MBTiles conversion pipeline
#
# This script:
# 1. Detects all feature layers using gpkg_contents
# 2. Checks for NULL geometries
# 3. Optionally fixes geometries using ogr2ogr -makevalid
# 4. Exports each layer to GeoJSONSeq
# 5. Builds ONE MBTiles PER LAYER (correct zoom handling)
# 6. Merges them using tile-join
# ============================================================

# -----------------------------
# INPUT ARGUMENTS
# -----------------------------
INPUT_GPKG="${1:-}"
OUTPUT_MBTILES="${2:-output.mbtiles}"
FIX_GEOMETRY="${3:-false}"

[[ -z "$INPUT_GPKG" ]] && {
  echo "Usage: $0 input.gpkg [output.mbtiles] [fix_geometry:false]"
  exit 1
}
[[ ! -f "$INPUT_GPKG" ]] && {
  echo "GeoPackage not found: $INPUT_GPKG"
  exit 1
}

# -----------------------------
# USER CONFIGURATION (ZOOMS)
# -----------------------------
declare -A LAYER_ZOOMS=(
  ["ne_african_countries"]="2 10"
  ["ne_10m_rivers"]="6 15"
  ["ne_10m_lakes"]="6 15"
  ["ecoregions"]="2 8"
  ["catchments_lev12"]="8 15"
  ["ne_10m_populated_places"]="6 15"
)

DEFAULT_ZOOMS="6 15"

# -----------------------------
# LOGGING
# -----------------------------
info() { echo "ℹ️  $1"; }
warn() { echo "⚠️  $1"; }
error() {
  echo "❌ $1" >&2
  exit 1
}

# -----------------------------
# DEPENDENCIES
# -----------------------------
#sudo apt install -y gdal-bin tippecanoe sqlite3
info "GDAL: $(ogrinfo --version)"

# -----------------------------
# WORKDIR
# -----------------------------
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

VALIDATED_GPKG="$WORKDIR/validated.gpkg"
GEOJSON_DIR="$WORKDIR/geojson"
MBTILES_DIR="$WORKDIR/mbtiles"

mkdir -p "$GEOJSON_DIR" "$MBTILES_DIR"

# -----------------------------
# LAYER DISCOVERY
# -----------------------------
info "Detecting layers..."

MAP_LAYERS=$(sqlite3 -batch -noheader "$INPUT_GPKG" \
  "SELECT table_name FROM gpkg_contents WHERE data_type='features';")

[[ -z "$MAP_LAYERS" ]] && error "No feature layers found"

while read -r L; do echo "  - $L"; done <<<"$MAP_LAYERS"

# -----------------------------
# NULL GEOMETRY CHECK
# -----------------------------
FIX_REQUIRED=false
info "Checking for NULL geometries..."

while read -r LAYER; do
  NULL_COUNT=$(ogrinfo "$INPUT_GPKG" \
    -sql "SELECT COUNT(*) FROM \"$LAYER\" WHERE geometry IS NULL" \
    2>/dev/null | grep -Eo '[0-9]+' | tail -n1 || echo "0")

  if [[ "$NULL_COUNT" -gt 0 ]]; then
    warn "Layer '$LAYER' has $NULL_COUNT NULL geometries"
    FIX_REQUIRED=true
  else
    info "Layer '$LAYER' OK"
  fi
done <<<"$MAP_LAYERS"

# -----------------------------
# GEOMETRY FIX
# -----------------------------
if [[ "$FIX_GEOMETRY" == "true" ]] || [[ "$FIX_REQUIRED" == true ]]; then
  info "Fixing geometries..."
  ogr2ogr -f GPKG "$VALIDATED_GPKG" "$INPUT_GPKG" -makevalid
else
  cp "$INPUT_GPKG" "$VALIDATED_GPKG"
fi

# -----------------------------
# GEOMETRY COLUMN
# -----------------------------
get_geometry_column() {
  sqlite3 -batch -noheader "$1" \
    "SELECT column_name FROM gpkg_geometry_columns WHERE table_name='$2' LIMIT 1;"
}

# -----------------------------
# EXPORT TO GEOJSONSEQ
# -----------------------------
info "Exporting layers to GeoJSONSeq..."

while read -r LAYER; do
  OUT="$GEOJSON_DIR/$LAYER.jsonseq"
  GEOM_COL=$(get_geometry_column "$VALIDATED_GPKG" "$LAYER")

  if [[ -n "$GEOM_COL" ]]; then
    ogr2ogr -f GeoJSONSeq "$OUT" "$VALIDATED_GPKG" "$LAYER" \
      -nlt PROMOTE_TO_MULTI \
      -where "\"$GEOM_COL\" IS NOT NULL" ||
      ogr2ogr -f GeoJSONSeq "$OUT" "$VALIDATED_GPKG" "$LAYER" -nlt PROMOTE_TO_MULTI
  else
    ogr2ogr -f GeoJSONSeq "$OUT" "$VALIDATED_GPKG" "$LAYER" -nlt PROMOTE_TO_MULTI
  fi
done <<<"$MAP_LAYERS"

# -----------------------------
# BUILD PER-LAYER MBTILES (THE FIX)
# -----------------------------
info "Building per-layer MBTiles..."

while read -r LAYER; do
  IN="$GEOJSON_DIR/$LAYER.jsonseq"
  OUT="$MBTILES_DIR/$LAYER.mbtiles"

  if [[ -n "${LAYER_ZOOMS[$LAYER]+x}" ]]; then
    read MINZ MAXZ <<<"${LAYER_ZOOMS[$LAYER]}"
  else
    read MINZ MAXZ <<<"$DEFAULT_ZOOMS"
  fi

  info "  → $LAYER (z$MINZ–z$MAXZ)"

  tippecanoe \
    -o "$OUT" \
    --force \
    --read-parallel \
    --layer="$LAYER" \
    --minimum-zoom="$MINZ" \
    --maximum-zoom="$MAXZ" \
    --simplification=10 \
    --simplification-at-maximum-zoom=0.2 \
    --no-tiny-polygon-reduction \
    --drop-densest-as-needed \
    "$IN"

done <<<"$MAP_LAYERS"

# -----------------------------
# MERGE MBTILES
# -----------------------------
info "Merging layers into final MBTiles..."

tile-join \
  -o "$OUTPUT_MBTILES" \
  --force \
  "$MBTILES_DIR"/*.mbtiles

info "✅ Done — MBTiles written to: $OUTPUT_MBTILES"
