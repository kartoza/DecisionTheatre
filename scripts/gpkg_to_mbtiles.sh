#!/usr/bin/env bash
set -euo pipefail

# ============================================================
# GeoPackage → Vector MBTiles conversion pipeline
# ============================================================
#
# USAGE
# -----
# ./gpkg_to_mbtiles.sh input1.gpkg [input2.gpkg ...] [--fix-geometry] [--no-edit]
#
# Examples (run from the project root):
#   ./scripts/gpkg_to_mbtiles.sh datasources/basemap/context_source_data.gpkg
#   ./scripts/gpkg_to_mbtiles.sh datasources/basemap/context_source_data.gpkg datasources/catchments/catchments.gpkg
#   ./scripts/gpkg_to_mbtiles.sh datasources/basemap/context_source_data.gpkg datasources/catchments/catchments.gpkg --fix-geometry
#
# ARGUMENTS
# ---------
# input.gpkg        One or more GeoPackage files. Each is scanned for
#                    feature layers; if the same layer name exists in more
#                    than one file, the earliest file on the command line
#                    wins and the rest are skipped with a warning.
# --fix-geometry     Optional: run ogr2ogr -makevalid on any source file
#                    that has NULL geometries (or on all of them if passed
#                    explicitly). Legacy trailing "true"/"false" is also
#                    accepted for backward compatibility.
# --no-edit          Skip opening layer-treatment.csv for editing (also
#                    skipped automatically when stdin/stdout aren't a tty,
#                    e.g. in CI) -- builds with whatever it already says.
# --tileset NAME     Only build layers whose treatment "tileset" column is
#                    NAME (blank counts as "context"). Skips everything
#                    else entirely -- with resume already in place per
#                    layer, this is for rebuilding one tileset (e.g. just
#                    "catchments") on its own schedule, without touching
#                    the other one's already-built output at all.
#
# PER-LAYER TREATMENT
# --------------------
# How each layer is generalised (zoom bands, tolerance, algorithm, edge
# matching, tiny-polygon handling) is read from layer-treatment.csv next
# to this script. Before building, any layer found in the input
# GeoPackages but missing from that table is appended with defaults, then
# (unless --no-edit or non-interactive) $VISUAL/$EDITOR opens on it and
# the build waits for you to save and close before starting. See the
# comment block at the top of layer-treatment.csv for what each column
# does.
#
# OUTPUT
# ------
# Stages output in .cache/context.mbtiles during processing,
# then moves to data/mbtiles/context.mbtiles on completion.
#
# WHAT THIS SCRIPT DOES
# ---------------------
# 1. Verifies required dependencies (GDAL, tippecanoe, sqlite3)
# 2. Detects all feature layers from gpkg_contents, across every input file
# 3. Loads layer-treatment.csv, appends defaults for any new layer, and
#    (interactively) lets you edit it before continuing
# 4. Checks for NULL geometries
# 5. Optionally fixes geometries using ogr2ogr -makevalid
# 6. Exports each layer to GeoJSONSeq
# 7. Builds ONE MBTiles PER LAYER, generalised band and unsimplified band
#    tiled separately and tile-joined back together where the table calls
#    for both
# 8. Merges every layer using tile-join
#
# ============================================================


# -----------------------------
# LOGGING
# -----------------------------
info()  { echo "ℹ️  $1"; }
warn()  { echo "⚠️  $1"; }
error() { echo "❌ $1" >&2; exit 1; }


# -----------------------------
# DEPENDENCY CHECK (OS-AWARE)
# -----------------------------
install_deps() {
  if command -v apt >/dev/null 2>&1; then
    sudo apt update
    sudo apt install -y gdal-bin sqlite3 tippecanoe
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y gdal sqlite tippecanoe
  elif command -v pacman >/dev/null 2>&1; then
    sudo pacman -Sy --noconfirm gdal sqlite tippecanoe
  elif command -v nix-env >/dev/null 2>&1; then
    nix-env -iA nixpkgs.gdal nixpkgs.sqlite nixpkgs.tippecanoe
  elif command -v brew >/dev/null 2>&1; then
    brew install gdal sqlite tippecanoe
  else
    warn "Could not detect package manager."
    warn "Please install manually: gdal sqlite tippecanoe"
  fi
}

ensure_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    warn "$1 not found — attempting install"
    install_deps
  }
}

ensure_cmd ogr2ogr
ensure_cmd sqlite3
ensure_cmd tippecanoe
ensure_cmd tile-join

info "GDAL version: $(ogrinfo --version)"


# -----------------------------
# INPUT ARGUMENTS
# -----------------------------
FIX_GEOMETRY=false
NO_EDIT=false
TILESET_FILTER=""
INPUT_GPKGS=()

while [[ $# -gt 0 ]]; do
  arg="$1"
  case "$arg" in
    --fix-geometry) FIX_GEOMETRY=true; shift ;;
    --no-edit) NO_EDIT=true; shift ;;
    --tileset) TILESET_FILTER="$2"; shift 2 ;;
    true|false)
      if [[ -f "$arg" ]]; then
        INPUT_GPKGS+=("$arg")
      else
        FIX_GEOMETRY="$arg"
      fi
      shift
      ;;
    *) INPUT_GPKGS+=("$arg"); shift ;;
  esac
done

[[ ${#INPUT_GPKGS[@]} -eq 0 ]] && error "Usage: $0 input1.gpkg [input2.gpkg ...] [--fix-geometry]"

for f in "${INPUT_GPKGS[@]}"; do
  [[ -f "$f" ]] || error "GeoPackage not found: $f"
done

# Output paths - stage in .cache/, final destination in data/mbtiles.
# A layer's treatment "tileset" column can route it to its own standalone
# tileset (e.g. "catchments") instead of the default combined "context"
# one, so there can be more than one staging/final pair per run -- see
# the MERGE MBTILES section.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DATA_MBTILES_DIR="$PROJECT_ROOT/data/mbtiles"
CACHE_DIR="$PROJECT_ROOT/.cache"
mkdir -p "$CACHE_DIR"


# -----------------------------
# PER-LAYER TREATMENT (see layer-treatment.csv)
# -----------------------------
TREATMENT_CSV="$PROJECT_ROOT/datasources/mbtiles-config/layer-treatment.csv"
[[ -f "$TREATMENT_CSV" ]] || error "Treatment table not found: $TREATMENT_CSV"

declare -A T_MINZOOM T_SIMPLIFIED_END T_MAXZOOM T_GENERALISE T_VISVALINGAM T_TOLERANCE T_PRESERVE_SHARED_NODES T_MERGE_TINY_POLYGONS T_TILESET
CSV_LAYER_ORDER=()

load_treatment_csv() {
  T_MINZOOM=(); T_SIMPLIFIED_END=(); T_MAXZOOM=(); T_GENERALISE=()
  T_VISVALINGAM=(); T_TOLERANCE=(); T_PRESERVE_SHARED_NODES=(); T_MERGE_TINY_POLYGONS=()
  T_TILESET=()
  CSV_LAYER_ORDER=()

  local line header_skipped=false
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* ]] && continue
    if [[ "$header_skipped" == false ]]; then
      header_skipped=true
      continue
    fi
    IFS=',' read -r layer minz send maxz gen vv tol psn mtp tileset <<< "$line"
    [[ -z "$layer" ]] && continue
    CSV_LAYER_ORDER+=("$layer")
    T_MINZOOM[$layer]="$minz"
    T_SIMPLIFIED_END[$layer]="$send"
    T_MAXZOOM[$layer]="$maxz"
    T_GENERALISE[$layer]="$gen"
    T_VISVALINGAM[$layer]="$vv"
    T_TOLERANCE[$layer]="$tol"
    T_PRESERVE_SHARED_NODES[$layer]="$psn"
    T_MERGE_TINY_POLYGONS[$layer]="$mtp"
    T_TILESET[$layer]="$tileset"
  done < "$TREATMENT_CSV"
}

layer_in_csv() {
  local target="$1" existing
  for existing in "${CSV_LAYER_ORDER[@]}"; do
    [[ "$existing" == "$target" ]] && return 0
  done
  return 1
}

append_missing_layers() {
  local layer
  for layer in "${MAP_LAYERS[@]}"; do
    if ! layer_in_csv "$layer"; then
      warn "'$layer' not in $(basename "$TREATMENT_CSV") — appending defaults (z6-z15, generalised, merged into the combined tileset)"
      echo "$layer,6,14,15,true,true,10,true,false," >> "$TREATMENT_CSV"
    fi
  done
}

validate_treatment() {
  local layer minz send maxz gen errs=0
  for layer in "${CSV_LAYER_ORDER[@]}"; do
    minz="${T_MINZOOM[$layer]}"; send="${T_SIMPLIFIED_END[$layer]}"
    maxz="${T_MAXZOOM[$layer]}"; gen="${T_GENERALISE[$layer]}"

    if ! [[ "$minz" =~ ^[0-9]+$ && "$maxz" =~ ^[0-9]+$ ]]; then
      warn "$layer: minzoom/maxzoom must be integers (got '$minz'/'$maxz')"
      errs=$((errs + 1)); continue
    fi
    if (( minz > maxz )); then
      warn "$layer: minzoom ($minz) is greater than maxzoom ($maxz)"
      errs=$((errs + 1))
    fi
    if [[ "$gen" != true && "$gen" != false ]]; then
      warn "$layer: generalise must be true or false (got '$gen')"
      errs=$((errs + 1))
    elif [[ "$gen" == true ]] && ! [[ "$send" =~ ^[0-9]+$ ]]; then
      warn "$layer: simplified_end must be an integer when generalise=true (got '$send')"
      errs=$((errs + 1))
    fi
    local field name val
    for field in "T_VISVALINGAM:visvalingam" "T_PRESERVE_SHARED_NODES:preserve_shared_nodes" "T_MERGE_TINY_POLYGONS:merge_tiny_polygons"; do
      name="${field#*:}"
      case "$name" in
        visvalingam) val="${T_VISVALINGAM[$layer]}" ;;
        preserve_shared_nodes) val="${T_PRESERVE_SHARED_NODES[$layer]}" ;;
        merge_tiny_polygons) val="${T_MERGE_TINY_POLYGONS[$layer]}" ;;
      esac
      [[ "$val" == true || "$val" == false ]] || {
        warn "$layer: $name must be true or false (got '$val')"
        errs=$((errs + 1))
      }
    done
  done
  if [[ "$errs" -gt 0 ]]; then
    error "$errs problem(s) in $TREATMENT_CSV — fix and re-run"
  fi
}

# -----------------------------
# RESUME SUPPORT
# -----------------------------
# A layer's built .mbtiles is only trusted to skip rebuilding if its
# treatment hasn't changed since it was built AND the file itself is
# intact. That second check matters as much as the first: a build killed
# mid-write (out of disk, Ctrl-C, crash) leaves a truncated/corrupt
# .mbtiles behind, and a disk-full failure in particular is likely to
# have happened *while* writing exactly the layer being resumed.
layer_fingerprint() {
  local layer="$1"
  printf '%s' "${T_MINZOOM[$layer]}|${T_SIMPLIFIED_END[$layer]}|${T_MAXZOOM[$layer]}|${T_GENERALISE[$layer]}|${T_VISVALINGAM[$layer]}|${T_TOLERANCE[$layer]}|${T_PRESERVE_SHARED_NODES[$layer]}|${T_MERGE_TINY_POLYGONS[$layer]}" \
    | sha256sum | cut -d' ' -f1
}

layer_is_up_to_date() {
  local layer="$1" out="$2" fp_file="$3"
  [[ -f "$out" && -f "$fp_file" ]] || return 1
  [[ "$(cat "$fp_file")" == "$(layer_fingerprint "$layer")" ]] || return 1
  [[ "$(sqlite3 "$out" 'PRAGMA integrity_check(1);' 2>&1)" == "ok" ]]
}

# Fragments/journals from a build of this layer that didn't finish
# cleanly. Removed before a rebuild so tippecanoe --force never has to
# contend with a half-written file, and so a stale one can't be mistaken
# for a finished layer on a future run.
clean_layer_leftovers() {
  local layer="$1" out="$2"
  rm -f \
    "$out" "$out-journal" "$out-wal" "$out-shm" \
    "$MBTILES_DIR/.$layer.generalised.mbtiles" "$MBTILES_DIR/.$layer.generalised.mbtiles-journal" \
    "$MBTILES_DIR/.$layer.unsimplified.mbtiles" "$MBTILES_DIR/.$layer.unsimplified.mbtiles-journal"
}

find_soffice() {
  command -v soffice 2>/dev/null || command -v libreoffice 2>/dev/null || true
}

# Edits the treatment table as a real spreadsheet: converts the CSV to
# .ods, opens it in Calc, waits for the window to close, then converts
# back. Runs under its own -env:UserInstallation profile so it can never
# collide with (or accidentally control) an already-running LibreOffice
# session on the user's desktop.
#
# Waiting for "closed" is done by polling for the presence of Calc's own
# `.~lock.<file>#` lock file next to the document, rather than trusting
# the soffice process to block until the window closes -- it often
# doesn't when another instance under the same profile is already
# running. If the process dies (crash, kill -9) before the lock file is
# cleaned up, that still counts as "closed" rather than hanging forever.
#
# Returns 1 (falls back to a text editor) if anything about this doesn't
# work out, rather than leaving the build stuck.
edit_with_libreoffice() {
  local soffice_bin="$1"
  local profile="$WORKDIR/lo-profile"
  local ods="$WORKDIR/layer-treatment.ods"
  local lock="$WORKDIR/.~lock.layer-treatment.ods#"
  local exported_dir="$WORKDIR/lo-exported"

  "$soffice_bin" --headless "-env:UserInstallation=file://$profile" \
    --convert-to ods --outdir "$WORKDIR" "$TREATMENT_CSV" >/dev/null 2>&1
  if [[ ! -f "$ods" ]]; then
    warn "LibreOffice couldn't convert the treatment table to .ods — falling back to a text editor"
    return 1
  fi

  rm -f "$lock" # stale lock from a previous crashed session, if any

  info "Opening layer-treatment.csv in LibreOffice Calc — save and close the window to start the build..."
  "$soffice_bin" --calc "-env:UserInstallation=file://$profile" "$ods" >/dev/null 2>&1 &
  local pid=$!

  local waited=0
  while [[ ! -f "$lock" ]] && (( waited < 60 )); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
    waited=$((waited + 1))
  done

  if [[ ! -f "$lock" ]]; then
    warn "LibreOffice didn't open within 30s — falling back to a text editor"
    kill "$pid" 2>/dev/null || true
    return 1
  fi

  while [[ -f "$lock" ]] && kill -0 "$pid" 2>/dev/null; do
    sleep 1
  done
  rm -f "$lock"

  mkdir -p "$exported_dir"
  "$soffice_bin" --headless "-env:UserInstallation=file://$profile" \
    --convert-to csv --outdir "$exported_dir" "$ods" >/dev/null 2>&1
  local exported="$exported_dir/layer-treatment.csv"
  if [[ ! -f "$exported" ]]; then
    error "LibreOffice closed but couldn't export the edited table back to CSV — nothing was changed"
  fi

  cp "$exported" "$TREATMENT_CSV"
}

maybe_edit_treatment() {
  if [[ "$NO_EDIT" == true ]]; then
    info "Skipping treatment-table edit (--no-edit)"
    return
  fi
  if [[ ! -t 0 || ! -t 1 ]]; then
    info "Non-interactive shell — using $(basename "$TREATMENT_CSV") as-is"
    return
  fi

  local soffice_bin
  soffice_bin=$(find_soffice)
  if [[ -n "$soffice_bin" ]] && edit_with_libreoffice "$soffice_bin"; then
    load_treatment_csv
    return
  fi

  local editor="${VISUAL:-${EDITOR:-nano}}"
  info "Opening $TREATMENT_CSV in '$editor' — save and close to start the build..."
  "$editor" "$TREATMENT_CSV"
  load_treatment_csv
}


# -----------------------------
# WORKDIR
# -----------------------------
WORKDIR="$(mktemp -d)"
# A staging file directly under $CACHE_DIR (.cache/*.mbtiles, never
# .cache/mbtiles-layers/*.mbtiles) is only ever a finished, complete file
# for the instant between tile-join producing it and the mv below
# renaming it into data/mbtiles/ -- if the script dies in that window (or
# before it, from a previous run) it is a stale partial file, never a
# real result, so it's always safe to remove on exit. A no-op once the mv
# has already happened. There can be more than one, one per tileset
# produced this run (see MERGE MBTILES).
trap 'rm -rf "$WORKDIR"; rm -f "$CACHE_DIR"/*.mbtiles' EXIT

for f in "$CACHE_DIR"/*.mbtiles; do
  [[ -e "$f" ]] || continue
  warn "Removing stale staging file from an earlier interrupted run: $f"
  rm -f "$f"
done

GEOJSON_DIR="$WORKDIR/geojson"

# Per-layer MBTiles are written to a persistent (not mktemp) directory,
# one file per layer, so each one becomes inspectable via
# `dt mbtiles-server --layer <name>` the moment its tippecanoe run
# finishes -- without waiting for the rest of the layers or the final
# tile-join merge. Already covered by the blanket *.mbtiles gitignore
# rule.
MBTILES_DIR="$CACHE_DIR/mbtiles-layers"
mkdir -p "$GEOJSON_DIR" "$MBTILES_DIR"


# -----------------------------
# LAYER DISCOVERY (across all input files)
# -----------------------------
info "Detecting layers..."

declare -A LAYER_SRC
MAP_LAYERS=()

for f in "${INPUT_GPKGS[@]}"; do
  LAYERS_IN_FILE=$(sqlite3 -batch -noheader "$f" \
    "SELECT table_name FROM gpkg_contents WHERE data_type='features';")

  while read -r L; do
    [[ -z "$L" ]] && continue
    if [[ -n "${LAYER_SRC[$L]+x}" ]]; then
      warn "Layer '$L' found in both '${LAYER_SRC[$L]}' and '$f' — using '${LAYER_SRC[$L]}'"
      continue
    fi
    LAYER_SRC[$L]="$f"
    MAP_LAYERS+=("$L")
    info "  - $L (from $(basename "$f"))"
  done <<< "$LAYERS_IN_FILE"
done

[[ ${#MAP_LAYERS[@]} -eq 0 ]] && error "No feature layers found"


# -----------------------------
# DROP ORPHANED PER-LAYER FILES
# -----------------------------
# Remove any leftover file for a layer that isn't part of this run's
# discovered layers (e.g. from a previous run with a different input
# set) -- otherwise it would go stale and still get swept into today's
# tile-join merge below. Layers that ARE still discovered are left
# alone here; the build loop decides per-layer whether an existing file
# is still valid to resume from or needs rebuilding.
for f in "$MBTILES_DIR"/*.mbtiles; do
  [[ -e "$f" ]] || continue
  base="$(basename "$f" .mbtiles)"
  [[ "$base" == .* ]] && continue # in-progress fragment from a crashed run, handled per-layer below
  found=false
  for l in "${MAP_LAYERS[@]}"; do
    [[ "$l" == "$base" ]] && { found=true; break; }
  done
  if [[ "$found" == false ]]; then
    warn "Removing orphaned layer file (not in this run's inputs): $base"
    rm -f "$f" "$MBTILES_DIR/.$base.fingerprint"
  fi
done


# -----------------------------
# LOAD / EDIT PER-LAYER TREATMENT
# -----------------------------
load_treatment_csv
append_missing_layers
load_treatment_csv
maybe_edit_treatment
validate_treatment

# --tileset restricts everything from here on (NULL check, export, build,
# merge) to one tileset's layers. Done after append_missing_layers so the
# table still gains a row for every discovered layer regardless of which
# tileset this particular run is building.
if [[ -n "$TILESET_FILTER" ]]; then
  FILTERED_LAYERS=()
  for LAYER in "${MAP_LAYERS[@]}"; do
    TS="${T_TILESET[$LAYER]:-}"
    [[ -z "$TS" ]] && TS="context"
    [[ "$TS" == "$TILESET_FILTER" ]] && FILTERED_LAYERS+=("$LAYER")
  done
  [[ ${#FILTERED_LAYERS[@]} -eq 0 ]] && error "No layers in $(basename "$TREATMENT_CSV") have tileset '$TILESET_FILTER'"
  MAP_LAYERS=("${FILTERED_LAYERS[@]}")
  info "Restricting this run to tileset '$TILESET_FILTER': ${MAP_LAYERS[*]}"
fi

# A standalone tileset only benefits from stopping early if it actually
# stops early: MapLibre overzooms it past its declared maxzoom regardless
# of how deep the app navigates, so a wide unsimplified band here is
# almost always wasted build time and disk rather than a deliberate
# choice -- one extra full-detail zoom for headroom is normal, several is
# usually a treatment-table value worth double-checking.
for LAYER in "${MAP_LAYERS[@]}"; do
  TS="${T_TILESET[$LAYER]:-}"
  [[ -z "$TS" ]] && continue
  [[ "${T_GENERALISE[$LAYER]}" == true ]] || continue
  SPAN=$(( ${T_MAXZOOM[$LAYER]} - ${T_SIMPLIFIED_END[$LAYER]} ))
  if (( SPAN > 2 )); then
    warn "$LAYER: standalone tileset '$TS' tiles $SPAN full-detail zoom levels (z$((${T_SIMPLIFIED_END[$LAYER]} + 1))-z${T_MAXZOOM[$LAYER]}) -- since MapLibre overzooms a standalone tileset automatically, this is likely far more than needed. Consider lowering maxzoom to simplified_end+1 or +2."
  fi
done

# Decided once per layer up front (an integrity check against a
# multi-GB file isn't free) and reused by both the GeoJSON export step
# and the tippecanoe build step below, so a resumed run does neither for
# a layer that's already done.
declare -A RESUMABLE
for LAYER in "${MAP_LAYERS[@]}"; do
  if layer_is_up_to_date "$LAYER" "$MBTILES_DIR/$LAYER.mbtiles" "$MBTILES_DIR/.$LAYER.fingerprint"; then
    RESUMABLE[$LAYER]=true
    info "'$LAYER' unchanged and intact — resuming (skips re-export and re-tiling)"
  else
    RESUMABLE[$LAYER]=false
  fi
done


# -----------------------------
# NULL GEOMETRY CHECK
# -----------------------------
declare -A FIX_REQUIRED_FOR
info "Checking for NULL geometries..."

for LAYER in "${MAP_LAYERS[@]}"; do
  SRC="${LAYER_SRC[$LAYER]}"
  NULL_COUNT=$(ogrinfo "$SRC" \
    -sql "SELECT COUNT(*) FROM \"$LAYER\" WHERE geometry IS NULL" \
    2>/dev/null | grep -Eo '[0-9]+' | tail -n1 || echo "0")

  if [[ "$NULL_COUNT" -gt 0 ]]; then
    warn "Layer '$LAYER' has $NULL_COUNT NULL geometries"
    FIX_REQUIRED_FOR[$SRC]=true
  else
    info "Layer '$LAYER' OK"
  fi
done


# -----------------------------
# GEOMETRY FIX (per unique source file)
# -----------------------------
declare -A VALIDATED_SRC

for f in "${INPUT_GPKGS[@]}"; do
  if [[ "$FIX_GEOMETRY" == "true" ]] || [[ "${FIX_REQUIRED_FOR[$f]:-false}" == "true" ]]; then
    info "Fixing geometries in $(basename "$f")..."
    VF="$WORKDIR/validated_$(basename "$f")"
    ogr2ogr -f GPKG "$VF" "$f" -makevalid
    VALIDATED_SRC[$f]="$VF"
  else
    VALIDATED_SRC[$f]="$f"
  fi
done


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

for LAYER in "${MAP_LAYERS[@]}"; do
  [[ "${RESUMABLE[$LAYER]}" == true ]] && continue

  SRC="${VALIDATED_SRC[${LAYER_SRC[$LAYER]}]}"
  OUT="$GEOJSON_DIR/$LAYER.jsonseq"
  GEOM_COL=$(get_geometry_column "$SRC" "$LAYER")

  if [[ -n "$GEOM_COL" ]]; then
    ogr2ogr -f GeoJSONSeq "$OUT" "$SRC" "$LAYER" \
      -nlt PROMOTE_TO_MULTI \
      -where "\"$GEOM_COL\" IS NOT NULL" || \
    ogr2ogr -f GeoJSONSeq "$OUT" "$SRC" "$LAYER" -nlt PROMOTE_TO_MULTI
  else
    ogr2ogr -f GeoJSONSeq "$OUT" "$SRC" "$LAYER" -nlt PROMOTE_TO_MULTI
  fi
done


# -----------------------------
# BUILD PER-LAYER MBTILES
# -----------------------------
info "Building per-layer MBTiles..."

for LAYER in "${MAP_LAYERS[@]}"; do
  IN="$GEOJSON_DIR/$LAYER.jsonseq"
  OUT="$MBTILES_DIR/$LAYER.mbtiles"
  FP_FILE="$MBTILES_DIR/.$LAYER.fingerprint"

  if [[ "${RESUMABLE[$LAYER]}" == true ]]; then
    info "  → $LAYER — unchanged and valid, skipping (resume)"
    info "  ✓ $LAYER ready — preview with: dt mbtiles-server --layer $LAYER"
    continue
  fi

  clean_layer_leftovers "$LAYER" "$OUT"

  MINZ="${T_MINZOOM[$LAYER]}"
  SEND="${T_SIMPLIFIED_END[$LAYER]}"
  MAXZ="${T_MAXZOOM[$LAYER]}"
  GEN="${T_GENERALISE[$LAYER]}"
  VV="${T_VISVALINGAM[$LAYER]}"
  TOL="${T_TOLERANCE[$LAYER]}"
  PSN="${T_PRESERVE_SHARED_NODES[$LAYER]}"
  MTP="${T_MERGE_TINY_POLYGONS[$LAYER]}"

  COMMON=(--force --read-parallel --layer="$LAYER")
  [[ "$MTP" != true ]] && COMMON+=(--no-tiny-polygon-reduction)

  SIMP=(--simplification="$TOL")
  [[ "$VV" == true ]] && SIMP+=(--visvalingam)
  [[ "$PSN" == true ]] && SIMP+=(--no-simplification-of-shared-nodes)

  if [[ "$GEN" != true ]] || (( SEND < MINZ )); then
    # Whole range unsimplified.
    info "  → $LAYER (z$MINZ–z$MAXZ, unsimplified)"
    tippecanoe -o "$OUT" "${COMMON[@]}" \
      --minimum-zoom="$MINZ" --maximum-zoom="$MAXZ" \
      --no-line-simplification \
      "$IN"

  elif (( SEND >= MAXZ )); then
    # Whole range generalised, no unsimplified band at the top.
    info "  → $LAYER (z$MINZ–z$MAXZ, generalised)"
    tippecanoe -o "$OUT" "${COMMON[@]}" \
      --minimum-zoom="$MINZ" --maximum-zoom="$MAXZ" \
      "${SIMP[@]}" \
      "$IN"

  else
    # Two bands: generalised up to simplified_end, unsimplified above it.
    # tippecanoe has no single-invocation way to switch tolerance
    # partway through a zoom range, so this tiles each band separately
    # and tile-joins them back into one per-layer file.
    info "  → $LAYER (z$MINZ–z$SEND generalised, z$((SEND + 1))–z$MAXZ unsimplified)"

    GEN_OUT="$MBTILES_DIR/.${LAYER}.generalised.mbtiles"
    RAW_OUT="$MBTILES_DIR/.${LAYER}.unsimplified.mbtiles"

    tippecanoe -o "$GEN_OUT" "${COMMON[@]}" \
      --minimum-zoom="$MINZ" --maximum-zoom="$SEND" \
      "${SIMP[@]}" \
      "$IN"

    tippecanoe -o "$RAW_OUT" "${COMMON[@]}" \
      --minimum-zoom="$((SEND + 1))" --maximum-zoom="$MAXZ" \
      --no-line-simplification \
      "$IN"

    tile-join -o "$OUT" --force "$GEN_OUT" "$RAW_OUT"
    rm -f "$GEN_OUT" "$RAW_OUT"
  fi

  layer_fingerprint "$LAYER" > "$FP_FILE"
  info "  ✓ $LAYER ready — preview with: dt mbtiles-server --layer $LAYER"

done


# -----------------------------
# MERGE MBTILES (grouped by tileset)
# -----------------------------
# Layers with a blank "tileset" column merge into the combined "context"
# tileset, same as always. A layer with a non-blank tileset (e.g.
# catchments_lev12 -> "catchments") ships as its own separate tileset
# instead -- see internal/server/server.go's handleCatchmentsTileJSON for
# why: MapLibre can only overzoom a tileset past its own declared
# maxzoom, and one TileJSON's maxzoom covers every layer bundled into it,
# so a layer that wants to stop tiling early and rely on overzoom needs
# to not be sharing a tileset with layers that tile deeper.
info "Merging layers into final MBTiles..."

declare -A TILESET_LAYERS
for LAYER in "${MAP_LAYERS[@]}"; do
  TS="${T_TILESET[$LAYER]:-}"
  [[ -z "$TS" ]] && TS="context"
  TILESET_LAYERS[$TS]="${TILESET_LAYERS[$TS]:-}${TILESET_LAYERS[$TS]:+ }$LAYER"
done

for TS in "${!TILESET_LAYERS[@]}"; do
  STAGE="$CACHE_DIR/$TS.mbtiles"
  DEST="$DATA_MBTILES_DIR/$TS.mbtiles"
  TS_FILES=()
  for LAYER in ${TILESET_LAYERS[$TS]}; do
    TS_FILES+=("$MBTILES_DIR/$LAYER.mbtiles")
  done

  info "  → $TS (${TILESET_LAYERS[$TS]})"
  tile-join -o "$STAGE" --force "${TS_FILES[@]}"

  mkdir -p "$DATA_MBTILES_DIR"
  mv "$STAGE" "$DEST"
  info "✅ '$TS' written to: $DEST"
done
