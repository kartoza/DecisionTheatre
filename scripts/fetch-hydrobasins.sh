#!/usr/bin/env bash
#
# fetch-hydrobasins.sh — Download a HydroBASINS region from HydroSHEDS.
#
# Usage:
#   ./scripts/fetch-hydrobasins.sh [region] [dest-dir]
#
# Arguments:
#   [region]    HydroBASINS region code. Defaults to "af" (Africa) --
#               the only region this project currently uses. See
#               https://www.hydrosheds.org/products/hydrobasins for the
#               full list (af, ar, as, au, eu, gr, na, sa, si).
#   [dest-dir]  Destination directory. Defaults to
#               ./datasources/catchments relative to the repository root.
#
# What it does:
#   Downloads the "standard" (non-lake), all-levels bundle for the given
#   region -- hybas_<region>_lev01-12_v1c.zip, one shapefile per level
#   01-12 -- and unzips it into <dest-dir>/hybas_<region>_lev01-12_v1c/.
#   Skips the download entirely if that directory already has content;
#   pass --force to re-fetch anyway.
#
# Requirements:
#   curl, unzip, ogrinfo (all provided by the Nix dev shell)
#
# License note:
#   By downloading this data you agree to HydroSHEDS's license terms --
#   see the Technical Documentation linked from the product page. This
#   script does not, and cannot, accept that agreement on your behalf.
#
# Examples:
#   ./scripts/fetch-hydrobasins.sh
#   ./scripts/fetch-hydrobasins.sh af
#   ./scripts/fetch-hydrobasins.sh af /path/to/custom/datasources/catchments
#

set -euo pipefail

# ── Helpers ──────────────────────────────────────────────────────────────────

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
RESET='\033[0m'

info()  { echo -e "${GREEN}[INFO]${RESET}  $*"; }
warn()  { echo -e "${YELLOW}[WARN]${RESET}  $*"; }
error() { echo -e "${RED}[ERROR]${RESET} $*" >&2; }
die()   { error "$*"; exit 1; }

usage() {
    sed -n '3,32p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
}

# ── Argument parsing ──────────────────────────────────────────────────────────

FORCE=false
ARGS=()
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=true ;;
        -h|--help) usage ;;
        *) ARGS+=("$arg") ;;
    esac
done

REGION="${ARGS[0]:-af}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEST_DIR="${ARGS[1]:-$PROJECT_ROOT/datasources/catchments}"

BUNDLE="hybas_${REGION}_lev01-12_v1c"
URL="https://data.hydrosheds.org/file/hydrobasins/standard/${BUNDLE}.zip"
TARGET_DIR="$DEST_DIR/$BUNDLE"

# ── Pre-flight ─────────────────────────────────────────────────────────────────

for cmd in curl unzip ogrinfo; do
    command -v "$cmd" >/dev/null 2>&1 || die "$cmd not found — run this inside 'nix develop'"
done

if [[ -d "$TARGET_DIR" ]] && [[ -n "$(find "$TARGET_DIR" -maxdepth 1 -name '*.shp' -print -quit 2>/dev/null)" ]]; then
    if [[ "$FORCE" != true ]]; then
        info "Already present: $TARGET_DIR"
        info "Pass --force to re-download anyway."
        exit 0
    fi
    warn "Re-downloading over existing $TARGET_DIR (--force)"
fi

# ── Download ──────────────────────────────────────────────────────────────────

mkdir -p "$DEST_DIR"
TMP_ZIP="$(mktemp --suffix=.zip)"
trap 'rm -f "$TMP_ZIP"' EXIT

info "Downloading ${BOLD}${URL}${RESET}"
info "By downloading, you agree to HydroSHEDS's license terms (see the Technical Documentation on hydrosheds.org)."
if ! curl -f -L --progress-bar -o "$TMP_ZIP" "$URL"; then
    die "Download failed. Check the region code and your network connection."
fi

SIZE=$(stat -c%s "$TMP_ZIP" 2>/dev/null || stat -f%z "$TMP_ZIP")
[[ "$SIZE" -gt 0 ]] || die "Downloaded file is empty."
info "Downloaded $(( SIZE / 1024 / 1024 )) MiB"

# ── Unpack ────────────────────────────────────────────────────────────────────

rm -rf "$TARGET_DIR"
mkdir -p "$TARGET_DIR"
info "Unpacking into $TARGET_DIR ..."
unzip -q "$TMP_ZIP" -d "$TARGET_DIR"

# The zip may or may not nest its contents under a directory of its own --
# flatten it if so, so shapefiles always end up directly in TARGET_DIR.
NESTED=$(find "$TARGET_DIR" -mindepth 1 -maxdepth 1 -type d -print -quit)
if [[ -n "$NESTED" ]] && [[ -z "$(find "$TARGET_DIR" -maxdepth 1 -name '*.shp' -print -quit)" ]]; then
    shopt -s dotglob
    mv "$NESTED"/* "$TARGET_DIR/"
    rmdir "$NESTED"
    shopt -u dotglob
fi

# ── Verify ────────────────────────────────────────────────────────────────────

LEV12="$TARGET_DIR/${BUNDLE/lev01-12/lev12}.shp"
if [[ ! -f "$LEV12" ]]; then
    die "Expected $LEV12 after unpacking, but it's not there — the bundle layout may have changed."
fi
if ! ogrinfo -so "$LEV12" >/dev/null 2>&1; then
    die "$LEV12 does not open as a valid shapefile."
fi

COUNT=$(ogrinfo -so "$LEV12" "$(basename "$LEV12" .shp)" 2>/dev/null | grep -oE 'Feature Count: [0-9]+' | grep -oE '[0-9]+')
info "Verified: level 12 has ${COUNT:-?} features"
info "Done. See datasources/mbtiles-config/ and scripts/gpkg_to_mbtiles.sh for how these feed the multi-resolution catchments tileset."
