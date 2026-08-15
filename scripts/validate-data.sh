#!/usr/bin/env bash
#
# validate-data.sh — check a Decision Theatre data directory for compliance and
# correctness before the application is run against it.
#
# Every check below corresponds to something the Go runtime actually reads. Where
# a filename or table name is hardcoded in the source, the check cites it.
#
# Usage:
#   ./scripts/validate-data.sh [DATA_DIR]
#   nix run .#validate-data -- [DATA_DIR]
#   make validate-data
#
# DATA_DIR defaults to ./data.
#
# Exit codes:
#   0  no errors (warnings may still be present)
#   1  one or more errors — the application will not work correctly
#   2  the data directory does not exist, or a required tool is missing
#
set -euo pipefail

DATA_DIR="${1:-./data}"
ERRORS=0
WARNINGS=0

# Colours, disabled when not writing to a terminal.
if [ -t 1 ]; then
	RED=$'\033[0;31m'; YEL=$'\033[0;33m'; GRN=$'\033[0;32m'; BLU=$'\033[0;34m'; DIM=$'\033[2m'; RST=$'\033[0m'
else
	RED=''; YEL=''; GRN=''; BLU=''; DIM=''; RST=''
fi

err() { printf '%s  ERROR%s  %s\n' "$RED" "$RST" "$1"; ERRORS=$((ERRORS + 1)); }
warn() { printf '%s   WARN%s  %s\n' "$YEL" "$RST" "$1"; WARNINGS=$((WARNINGS + 1)); }
ok() { printf '%s     OK%s  %s\n' "$GRN" "$RST" "$1"; }
note() { printf '%s          %s%s\n' "$DIM" "$1" "$RST"; }
section() { printf '\n%s== %s ==%s\n' "$BLU" "$1" "$RST"; }

require_tool() {
	command -v "$1" >/dev/null 2>&1 || {
		printf '%sMissing required tool: %s%s\n' "$RED" "$1" "$RST" >&2
		printf 'Run inside "nix develop", or use "nix run .#validate-data".\n' >&2
		exit 2
	}
}

require_tool sqlite3
require_tool python3

if [ ! -d "$DATA_DIR" ]; then
	printf '%sData directory not found: %s%s\n' "$RED" "$DATA_DIR" "$RST" >&2
	exit 2
fi

DATA_DIR="$(cd "$DATA_DIR" && pwd)"
printf 'Validating data directory: %s\n' "$DATA_DIR"

# Reads a CSV header and prints its column names, one per line. Uses the csv
# module so quoted headers with embedded commas are handled correctly.
csv_header() {
	python3 -c '
import csv, sys
with open(sys.argv[1], newline="", encoding="utf-8-sig", errors="replace") as fh:
    row = next(csv.reader(fh), [])
print("\n".join(c.strip().strip("\"") for c in row))
' "$1"
}

# Capture the header before matching. Piping straight into `grep -q` makes grep
# exit on first match, which SIGPIPEs python and — under `set -o pipefail` —
# fails the whole script.
has_column() {
	local hdr
	hdr="$(csv_header "$1")" || return 1
	grep -qxF "$2" <<<"$hdr"
}

# ---------------------------------------------------------------------------
section "GeoPackage (internal/geodata/gpkg_store.go)"
# ---------------------------------------------------------------------------

GPKG="$DATA_DIR/datapack.gpkg"
if [ ! -f "$GPKG" ]; then
	err "datapack.gpkg is missing. The filename is hardcoded in gpkg_store.go; no other name is discovered."
else
	if ! sqlite3 -readonly "$GPKG" "SELECT 1;" >/dev/null 2>&1; then
		err "datapack.gpkg is not a readable SQLite database."
	else
		ok "datapack.gpkg opens as SQLite"
		GPKG_TABLES="$(sqlite3 -readonly "$GPKG" "SELECT name FROM sqlite_master WHERE type='table';" 2>/dev/null || true)"

		for t in catchments_lev12 scenario_current scenario_reference; do
			if grep -qxF "$t" <<<"$GPKG_TABLES"; then
				ok "table $t present"
			else
				err "table $t is missing from datapack.gpkg"
			fi
		done

		for t in scenario_current_lower scenario_current_upper scenario_reference_lower scenario_reference_upper; do
			grep -qxF "$t" <<<"$GPKG_TABLES" || warn "optional table $t is missing — whisker bounds will be unavailable"
		done

		if grep -qxF "rtree_catchments_lev12_geom" <<<"$GPKG_TABLES"; then
			ok "spatial index rtree_catchments_lev12_geom present"
		else
			err "spatial index rtree_catchments_lev12_geom is missing — viewport queries will fall back to full scans"
		fi

		if grep -qxF "catchments_lev12" <<<"$GPKG_TABLES"; then
			CATCHMENT_COUNT="$(sqlite3 -readonly "$GPKG" "SELECT COUNT(*) FROM catchments_lev12;" 2>/dev/null || echo 0)"
			if [ "$CATCHMENT_COUNT" -gt 0 ]; then
				ok "catchments_lev12 holds $CATCHMENT_COUNT catchments"
			else
				err "catchments_lev12 is empty"
			fi

			for col in HYBAS_ID HYBAS_ID_int; do
				if sqlite3 -readonly "$GPKG" "SELECT \"$col\" FROM catchments_lev12 LIMIT 1;" >/dev/null 2>&1; then
					ok "catchments_lev12.$col present"
				else
					err "catchments_lev12.$col is missing — joins to scenario tables will fail"
				fi
			done
		fi

		if grep -qxF "scenario_current" <<<"$GPKG_TABLES"; then
			if sqlite3 -readonly "$GPKG" "SELECT catchment_id_int FROM scenario_current LIMIT 1;" >/dev/null 2>&1; then
				ok "scenario_current.catchment_id_int present (join key)"
			else
				err "scenario_current.catchment_id_int is missing — the catchment join key"
			fi
		fi
	fi
fi

# ---------------------------------------------------------------------------
section "Map tiles (internal/tiles/mbtiles.go, internal/server/server.go)"
# ---------------------------------------------------------------------------

# The tileset name is the filename with .mbtiles stripped. server.go hardcodes
# the name "africa" in WarmCache, handleTileJSON and GetMetadata, so a tileset
# under any other name is registered but never referenced.
mapfile -t MBTILES < <(find "$DATA_DIR" -maxdepth 2 -name '*.mbtiles' -type f 2>/dev/null | sort)

if [ "${#MBTILES[@]}" -eq 0 ]; then
	err "no .mbtiles file found in $DATA_DIR or $DATA_DIR/mbtiles — the map will not render"
else
	FOUND_AFRICA=0
	for f in "${MBTILES[@]}"; do
		name="$(basename "$f" .mbtiles)"
		if [ "$name" = "africa" ]; then
			FOUND_AFRICA=1
			ok "tileset \"africa\" found: ${f#"$DATA_DIR"/}"
		else
			note "tileset \"$name\" found: ${f#"$DATA_DIR"/}"
		fi

		if ! sqlite3 -readonly "$f" "SELECT 1 FROM tiles LIMIT 1;" >/dev/null 2>&1; then
			err "${f#"$DATA_DIR"/} is not a readable MBTiles archive (no 'tiles' table)"
		fi
	done

	if [ "$FOUND_AFRICA" -eq 0 ]; then
		err "no tileset named \"africa\" — the map will be blank"
		note "The tileset name is derived from the filename (mbtiles.go: strings.TrimSuffix(entry.Name(), \".mbtiles\"))."
		note "server.go hardcodes \"africa\" in WarmCache (:117), handleTileJSON (:383) and GetMetadata (:394),"
		note "and /data/tiles.json always emits /tiles/africa/{z}/{x}/{y}.pbf."
		for f in "${MBTILES[@]}"; do
			note "Fix: mv \"${f#"$DATA_DIR"/}\" \"$(dirname "${f#"$DATA_DIR"/}")/africa.mbtiles\""
			break
		done
	fi
fi

STYLE="$DATA_DIR/mbtiles/style.json"
if [ ! -f "$STYLE" ]; then
	# The style is dataset-specific: its layers name the source-layers of this
	# tileset. There is no generic default that would render correctly, so a
	# data pack without one is incomplete.
	err "mbtiles/style.json is missing — the map cannot be styled"
	note "The server currently falls back to the resources directory, but that style belongs to a"
	note "different dataset and would resolve no layers against this tileset. That fallback is being removed."
elif ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$STYLE" 2>/dev/null; then
	err "mbtiles/style.json is not valid JSON"
else
	ok "mbtiles/style.json is valid JSON"
	python3 - "$STYLE" <<'PY' || true
import json, sys
style = json.load(open(sys.argv[1]))
if not style.get("sources"):
    print("   WARN  style.json declares no sources")
for name, src in (style.get("sources") or {}).items():
    url = src.get("url") or ""
    if url and "/data/tiles.json" not in url:
        print(f"   WARN  style.json source {name!r} points at {url!r};"
              " the server rewrites sources to /data/tiles.json, so this value is ignored")
PY
fi

# ---------------------------------------------------------------------------
section "Indicator metadata (internal/api/metadata_cache.go)"
# ---------------------------------------------------------------------------

META="$DATA_DIR/metadata.csv"
if [ ! -f "$META" ]; then
	err "metadata.csv is missing — the UI will fall back to raw column names with no colours, chart types or targets"
elif ! has_column "$META" "ColumnName"; then
	err "metadata.csv has no ColumnName column — it is the primary key for every lookup"
else
	ok "metadata.csv present with a ColumnName column"
	for col in MapthisYN graphthisYN Units "axis label" typeofgraph; do
		has_column "$META" "$col" || warn "metadata.csv is missing the \"$col\" column — the related UI behaviour will be unavailable"
	done

	# Cross-check metadata.csv against the columns that actually exist in the
	# GeoPackage. A column named in one but not the other is silently ignored.
	if [ -f "$GPKG" ] && sqlite3 -readonly "$GPKG" "SELECT 1 FROM scenario_current LIMIT 1;" >/dev/null 2>&1; then
		sqlite3 -readonly "$GPKG" "PRAGMA table_info(scenario_current);" 2>/dev/null | cut -d'|' -f2 | sort -u >/tmp/.dt_gpkg_cols.$$
		python3 -c '
import csv, sys
with open(sys.argv[1], newline="", encoding="utf-8-sig", errors="replace") as fh:
    r = csv.DictReader(fh)
    key = next((f for f in (r.fieldnames or []) if f.strip().strip("\"") == "ColumnName"), None)
    for row in r:
        v = (row.get(key) or "").strip()
        if v:
            print(v)
' "$META" | sort -u >/tmp/.dt_meta_cols.$$

		MISSING_IN_GPKG="$(comm -23 /tmp/.dt_meta_cols.$$ /tmp/.dt_gpkg_cols.$$)"
		MISSING_IN_META="$(comm -13 /tmp/.dt_meta_cols.$$ /tmp/.dt_gpkg_cols.$$)"

		if [ -n "$MISSING_IN_GPKG" ]; then
			COUNT="$(wc -l <<<"$MISSING_IN_GPKG")"

			# A very common export fault: R's make.names() rewrites spaces (and
			# other non-syntactic characters) to dots, so metadata.csv ends up
			# with "Obligate.grazer" where the GeoPackage has "Obligate grazer".
			# Detect it specifically rather than reporting hundreds of misses.
			sed 's/\./ /g' /tmp/.dt_meta_cols.$$ | sort -u >/tmp/.dt_meta_norm.$$
			sed 's/\./ /g' /tmp/.dt_gpkg_cols.$$ | sort -u >/tmp/.dt_gpkg_norm.$$
			NORM_MATCHED="$(comm -12 /tmp/.dt_meta_norm.$$ /tmp/.dt_gpkg_norm.$$ | wc -l)"
			EXACT_MATCHED="$(comm -12 /tmp/.dt_meta_cols.$$ /tmp/.dt_gpkg_cols.$$ | wc -l)"
			RECOVERED=$((NORM_MATCHED - EXACT_MATCHED))
			rm -f /tmp/.dt_meta_norm.$$ /tmp/.dt_gpkg_norm.$$

			if [ "$RECOVERED" -gt 0 ]; then
				err "$COUNT metadata.csv column(s) do not match the GeoPackage, but $RECOVERED of them match once '.' is treated as ' '"
				note "This is R's make.names() rewriting spaces to dots on export. Those indicators will render"
				note "with raw column names, no colour, no units and no chart-type detection, and will not appear"
				note "in the map or chart selectors at all — the lookup is an exact string match on ColumnName."
				note "Fix: re-export metadata.csv preserving the original column names, e.g. in R use"
				note "  write.csv(x, \"metadata.csv\", row.names = FALSE)  with  check.names = FALSE  on read,"
				note "or repair in place:  sed -i '1!s/\\./ /g' metadata.csv   (ColumnName field only — verify first)."
			else
				warn "$COUNT column(s) in metadata.csv do not exist in scenario_current — they will never appear in the UI"
			fi

			head -5 <<<"$MISSING_IN_GPKG" | while read -r c; do note "metadata-only: $c"; done
			[ "$COUNT" -gt 5 ] && note "... and $((COUNT - 5)) more"
		else
			ok "every metadata.csv ColumnName exists in scenario_current"
		fi

		if [ -n "$MISSING_IN_META" ]; then
			COUNT="$(wc -l <<<"$MISSING_IN_META")"
			warn "$COUNT column(s) in scenario_current are absent from metadata.csv — they will render with raw names and no styling"
			head -5 <<<"$MISSING_IN_META" | while read -r c; do note "data-only: $c"; done
			[ "$COUNT" -gt 5 ] && note "... and $((COUNT - 5)) more"
		fi

		rm -f /tmp/.dt_gpkg_cols.$$ /tmp/.dt_meta_cols.$$
	fi
fi

# ---------------------------------------------------------------------------
section "Lookup tables (internal/api/lookups.go)"
# ---------------------------------------------------------------------------

for pair in "NPP_by_treecover.csv:catchID" "deltaSOC_bytcc_Mgha.csv:catchID" "herb_traits_ready.csv:Species"; do
	file="${pair%%:*}"
	col="${pair##*:}"
	path="$DATA_DIR/$file"
	if [ ! -f "$path" ]; then
		err "$file is missing — ecological recalculation will fall back to defaults"
	elif ! has_column "$path" "$col"; then
		err "$file has no \"$col\" column"
	else
		ok "$file present with a $col column"
	fi
done

# ---------------------------------------------------------------------------
section "Runtime directories (internal/sites, internal/server)"
# ---------------------------------------------------------------------------

for d in sites images; do
	if [ -d "$DATA_DIR/$d" ]; then
		ok "$d/ present"
	else
		warn "$d/ is missing — it will be created on first write, but check directory permissions"
	fi
done

for d in walkthroughs demo; do
	if [ -d "$DATA_DIR/$d" ]; then
		ok "$d/ present"
	else
		warn "$d/ is missing — the guided tours will not be available"
	fi
done

# Walkthrough JSON files are addressed by ID; the filename, the "id" field and
# the WALKTHROUGH_SITE_IDS constant in the frontend must all agree.
if [ -d "$DATA_DIR/walkthroughs" ]; then
	for f in "$DATA_DIR"/walkthroughs/*.json; do
		[ -e "$f" ] || continue
		base="$(basename "$f" .json)"
		if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$f" 2>/dev/null; then
			err "walkthroughs/$base.json is not valid JSON"
			continue
		fi
		id="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$f")"
		if [ "$id" != "$base" ]; then
			err "walkthroughs/$base.json has id=\"$id\"; the filename and the id field must match"
		fi
	done
	ok "walkthrough JSON files checked"
fi

# ---------------------------------------------------------------------------
section "Files not read at runtime"
# ---------------------------------------------------------------------------

# Build inputs consumed by scripts/build-geopackage.sh to produce datapack.gpkg.
# Legitimate to keep, but they are large and are not needed to run the app.
BUILD_INPUTS=(current.csv current_lower.csv current_upper.csv
	reference.csv reference_lower.csv reference_upper.csv catchments.gpkg)
BUILD_TOTAL=0
BUILD_PRESENT=()
for f in "${BUILD_INPUTS[@]}"; do
	if [ -f "$DATA_DIR/$f" ]; then
		BUILD_PRESENT+=("$f")
		sz=$(stat -c%s "$DATA_DIR/$f" 2>/dev/null || echo 0)
		BUILD_TOTAL=$((BUILD_TOTAL + sz))
	fi
done
if [ "${#BUILD_PRESENT[@]}" -gt 0 ]; then
	note "$(printf 'Build inputs present (%d files, %s). Consumed by scripts/build-geopackage.sh to produce\n' \
		"${#BUILD_PRESENT[@]}" "$(numfmt --to=iec "$BUILD_TOTAL" 2>/dev/null || echo "$BUILD_TOTAL bytes")")"
	note "datapack.gpkg; not read at runtime and safe to omit from a distributed data pack."
fi

# Anything the runtime never opens and the build pipeline never consumes.
if [ -d "$DATA_DIR/R scripts" ]; then
	warn "\"R scripts/\" contains source code, not data — it belongs in version control, not the data directory"
	if [ -f "$DATA_DIR/R scripts/.Rhistory" ]; then
		warn "\"R scripts/.Rhistory\" is a personal R console history file and should be deleted"
	fi
fi

for stray in "$DATA_DIR"/*.Rhistory "$DATA_DIR"/.DS_Store "$DATA_DIR"/Thumbs.db; do
	[ -e "$stray" ] && warn "stray file: ${stray#"$DATA_DIR"/}"
done

for stale_dir in old_data old backup bak "Old Files" OldFiles; do
	if [ -d "$DATA_DIR/$stale_dir" ]; then
		warn "$stale_dir/ is present — superseded files should be removed rather than shipped"
	fi
done

# Extra styles beyond the one the server reads.
for s in "$DATA_DIR"/mbtiles/*.json; do
	[ -e "$s" ] || continue
	b="$(basename "$s")"
	[ "$b" = "style.json" ] && continue
	note "mbtiles/$b is not read by the server; only mbtiles/style.json is"
done

# ---------------------------------------------------------------------------
printf '\n'
if [ "$ERRORS" -gt 0 ]; then
	printf '%s%d error(s), %d warning(s).%s The application will not work correctly against this data directory.\n' \
		"$RED" "$ERRORS" "$WARNINGS" "$RST"
	exit 1
elif [ "$WARNINGS" -gt 0 ]; then
	printf '%sNo errors, %d warning(s).%s The application should run.\n' "$YEL" "$WARNINGS" "$RST"
	exit 0
else
	printf '%sAll checks passed.%s\n' "$GRN" "$RST"
	exit 0
fi
