#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# mbtiles-check.sh — which layers are actually in an mbtiles file?
#
# Reads the metadata tippecanoe/tile-join wrote (layer ids, zoom ranges,
# attribute fields) and then spot-checks each layer against real tile
# content: metadata can claim a layer exists even if something upstream
# quietly produced zero features for it, so this also decodes a handful of
# sampled tiles per layer and confirms the layer's name actually shows up
# with at least one feature.
#
# Usage:
#   ./scripts/mbtiles-check.sh [FILE]              # default: data/mbtiles/context.mbtiles
#   ./scripts/mbtiles-check.sh --layer NAME         # checks .cache/mbtiles-layers/NAME.mbtiles
#   ./scripts/mbtiles-check.sh [FILE] --samples N   # tiles sampled per layer (default: 10)
#
# Exit codes:
#   0  every declared layer was confirmed present in a real tile
#   1  at least one layer is missing or declared-but-empty
#   2  the file could not be examined
# =============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# shellcheck source=lib-ui.sh
. "$SCRIPT_DIR/lib-ui.sh"

cd "$PROJECT_ROOT"

FILE=""
LAYER=""
SAMPLES=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --layer) LAYER="$2"; shift 2 ;;
    --samples) SAMPLES="$2"; shift 2 ;;
    -h|--help)
      sed -n '4,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) FILE="$1"; shift ;;
  esac
done

if [[ -n "$LAYER" ]]; then
  FILE=".cache/mbtiles-layers/$LAYER.mbtiles"
elif [[ -z "$FILE" ]]; then
  FILE="data/mbtiles/context.mbtiles"
fi

for cmd in sqlite3 jq python3; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "❌ $cmd not found — run this inside 'nix develop'" >&2; exit 2; }
done

if [[ ! -f "$FILE" ]]; then
  echo "❌ Not found: $FILE" >&2
  exit 2
fi

SIZE_HUMAN=$(du -h "$FILE" | cut -f1)
ui_title "mbtiles-check — $FILE" "$SIZE_HUMAN"

META() { sqlite3 "$FILE" "SELECT value FROM metadata WHERE name='$1';" 2>/dev/null; }

ui_group "TILESET"
ui_ok "zoom range" "z$(META minzoom)–z$(META maxzoom)"
ui_ok "bounds" "$(META bounds)"
ui_ok "center" "$(META center)"

ui_blank

ui_group "LAYERS"

LAYERS_JSON=$(META json)
if [[ -z "$LAYERS_JSON" ]]; then
  ui_err "metadata" "no 'json' metadata field — can't enumerate layers"
else
  while IFS=$'\t' read -r ID MINZ MAXZ NFIELDS; do
    FOUND=""
    for _ in $(seq 1 "$SAMPLES"); do
      read -r COL ROW < <(sqlite3 "$FILE" \
        "SELECT tile_column, tile_row FROM map WHERE zoom_level=$MINZ ORDER BY RANDOM() LIMIT 1;" | tr '|' ' ')
      [[ -z "${COL:-}" ]] && break
      HIT=$(python3 "$SCRIPT_DIR/mvt_layers.py" "$FILE" "$MINZ" "$COL" "$ROW" | awk -F'\t' -v l="$ID" '$1==l{print $2}')
      if [[ -n "$HIT" ]]; then
        FOUND="$HIT features in sample tile z$MINZ/$COL/$ROW"
        break
      fi
    done

    if [[ -n "$FOUND" ]]; then
      ui_ok "$ID" "z$MINZ–z$MAXZ · $NFIELDS fields" "confirmed: $FOUND"
    else
      ui_err "$ID" "z$MINZ–z$MAXZ · $NFIELDS fields" "not found in $SAMPLES sampled tiles at z$MINZ"
    fi
  done < <(echo "$LAYERS_JSON" | jq -r '.vector_layers[] | [.id, .minzoom, .maxzoom, (.fields | length)] | @tsv')
fi

ui_summary "A layer marked 'not found' may just be sparse at its minzoom — rerun with a higher --samples before assuming it's broken."
