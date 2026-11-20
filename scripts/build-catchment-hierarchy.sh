#!/usr/bin/env bash
# SPDX-FileCopyrightText: 2026 Kartoza
# SPDX-License-Identifier: AGPL-3.0-only

#
# build-catchment-hierarchy.sh — build the multi-resolution catchment tables
# used for the low/mid-zoom choropleth: a lev12 -> parent crosswalk at every
# tier below, coarser catchment boundaries, and scenario data aggregated up
# to each one.
#
# GOLDEN RULE: this is additive only. It never touches catchments_lev12,
# scenario_current, scenario_reference or any whisker table -- site analysis
# and catchment selection are always done at lev12. These new tables exist
# purely so the choropleth can render something coarser than 147,837
# polygons when zoomed out; nothing here is read by the analysis code path.
#
# Inputs:
#   - DATA_DIR/datapack.gpkg (built by build-geopackage.sh -- run that first)
#   - SOURCE_DIR/catchments/hybas_af_lev01-12_v1c/ (fetched by
#     scripts/fetch-hydrobasins.sh) -- one shapefile per level, every tier
#     this script is configured to build (see LEVELS below) plus lev12
#
# How the crosswalk works:
#   HydroBASINS' Pfafstetter codes (PFAF_ID) are hierarchical by
#   construction: a lev12 catchment's parent at lev08 has a PFAF_ID that is
#   exactly the first 8 digits of the lev12 catchment's own PFAF_ID (any
#   other level: the same number of digits as that level's own number). This
#   was verified against all 147,837 catchments in the current data pack
#   with zero unmatched rows -- exact string-prefix matching, no spatial
#   join needed. catchments.gpkg itself doesn't carry PFAF_ID (it was
#   dropped when the study-area subset was clipped from the continental
#   HydroBASINS set), so PFAF_ID is read fresh from the lev12 shapefile here
#   and joined back in by HYBAS_ID.
#
#   Each tier's output label and its PFAF_ID prefix length are independent
#   settings (see LEVELS below) -- a label can be fed by a different
#   HydroBASINS level than its own number, if a past change repointed it.
#   Check LEVELS itself for which is currently true; don't assume the label
#   says.
#
# Output tables added to DATA_DIR/datapack.gpkg, one set per LEVELS entry:
#   - catchment_hierarchy   lev12 HYBAS_ID_int -> every tier's parent
#     HYBAS_ID_int, one column per tier (HYBAS_ID_int_levNN)
#   - catchments_levNN      HYBAS_ID, HYBAS_ID_int, geojson (no rtree --
#     a few hundred to tens of thousands of rows, not worth indexing)
#   - scenario_current_levNN, scenario_reference_levNN
#     SUB_AREA-weighted mean of every scenario_current/scenario_reference
#     column, grouped by parent -- the same NULL-safe weighted-average
#     formula internal/geodata/gpkg_store.go already uses for site summaries
#
# Usage: ./build-catchment-hierarchy.sh [DATA_DIR] [SOURCE_DIR]

set -e

DATA_DIR="${1:-./data}"
SOURCE_DIR="${2:-./datasources}"
OUTPUT="$DATA_DIR/datapack.gpkg"
HYBAS_DIR="$SOURCE_DIR/catchments/hybas_af_lev01-12_v1c"

if [ ! -f "$OUTPUT" ]; then
    echo "Error: $OUTPUT not found — run 'make geopackage' first"
    exit 1
fi
for lev in 06 07 08 09 10 12; do
    f="$HYBAS_DIR/hybas_af_lev${lev}_v1c.shp"
    if [ ! -f "$f" ]; then
        echo "Error: missing $f — run 'make fetch-hydrobasins' first"
        exit 1
    fi
done

echo "Building catchment hierarchy in $OUTPUT from $HYBAS_DIR..."

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

python3 - "$OUTPUT" "$HYBAS_DIR" "$WORKDIR" "$SOURCE_DIR/catchments/catchments-levels.gpkg" <<'PY'
import json
import sqlite3
import sys

from osgeo import ogr

ogr.UseExceptions()

output_path, hybas_dir, workdir, levels_gpkg = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]

# (output label, PFAF_ID prefix length). The label drives table/column/layer
# names (catchments_lev04, scenario_current_lev04, ...) and is independent of
# the prefix length -- see the header comment's note on this. Each tier here
# is fed by the HydroBASINS level two numbers finer than its own label (04 <-
# level 6, 05 <- level 7, ...): shifted up so lev04's z0-4 band keeps a denser
# 2,442 polygons rather than level 4's native 189, while every successive
# tier still has strictly more polygons than the last -- HydroBASINS' prefix
# hierarchy means a coarser level's basin always subdivides into one or more
# basins at the next-finer level, never fewer, regardless of which two levels
# are compared. lev08's z9 tier is the extreme end of this trade-off: at
# level 10 it carries 135,469 polygons, ~92% of the full 147,837-catchment
# set, because growth between consecutive HydroBASINS levels compounds fast
# in this geography.
LEVELS = [("04", 6), ("05", 7), ("06", 8), ("07", 9), ("08", 10)]


def src_lev(digits):
    return f"{digits:02d}"


def read_pfaf(path):
    ds = ogr.Open(path)
    lyr = ds.GetLayer()
    return {int(f.GetField("HYBAS_ID")): str(int(f.GetField("PFAF_ID"))) for f in lyr}


def valid_geom(geom):
    # A real minority of HydroBASINS basins (91 of 2,442 at lev04, e.g.
    # HYBAS_ID 1060003780 -- a 152-part MultiPolygon with a ring
    # self-intersection) are topologically invalid in the source shapefile.
    # Left unrepaired, tippecanoe's --no-simplification-of-shared-nodes
    # cannot reliably match a shared edge against an invalid, heavily
    # fragmented neighbour -- confirmed by isolating exactly this basin pair
    # into a 2-feature tippecanoe run and finding the shared boundary still
    # diverged after simplification. MakeValid() repairs self-intersections
    # (typically via GEOS) before the geometry ever reaches tippecanoe.
    if not geom.IsValid():
        geom = geom.MakeValid()
    return geom


def read_geoms(path):
    ds = ogr.Open(path)
    lyr = ds.GetLayer()
    out = {}
    for f in lyr:
        hid = int(f.GetField("HYBAS_ID"))
        geom = valid_geom(f.GetGeometryRef())
        out[hid] = geom.ExportToJson()
    return out


print("  Reading PFAF_ID from lev12 source shapefile...")
pfaf12 = read_pfaf(f"{hybas_dir}/hybas_af_lev12_v1c.shp")

level_prefix_index = {}
for lev, digits in LEVELS:
    print(f"  Reading PFAF_ID from lev{src_lev(digits)} source shapefile (-> lev{lev})...")
    pfaf_lev = read_pfaf(f"{hybas_dir}/hybas_af_lev{src_lev(digits)}_v1c.shp")
    by_prefix = {p: hid for hid, p in pfaf_lev.items()}
    level_prefix_index[lev] = (digits, by_prefix)

conn = sqlite3.connect(output_path)
cur = conn.cursor()

cur.execute("SELECT HYBAS_ID_int FROM catchments_lev12")
our_ids = [r[0] for r in cur.fetchall()]

print(f"  Building crosswalk for {len(our_ids)} lev12 catchments...")
rows = []
missing = 0
for hid12 in our_ids:
    pfaf = pfaf12.get(hid12)
    if pfaf is None:
        missing += 1
        continue
    row = [hid12]
    ok = True
    for lev, digits in LEVELS:
        _, by_prefix = level_prefix_index[lev]
        parent = by_prefix.get(pfaf[:digits])
        if parent is None:
            ok = False
            break
        row.append(parent)
    if ok:
        rows.append(row)
    else:
        missing += 1

if missing:
    print(f"  WARNING: {missing} lev12 catchments could not be matched to a parent at every level")
print(f"  Crosswalk: {len(rows)} matched")

cur.execute("DROP TABLE IF EXISTS catchment_hierarchy")
level_columns = ", ".join(f"HYBAS_ID_int_lev{lev} INTEGER" for lev, _ in LEVELS)
cur.execute(
    f"""CREATE TABLE catchment_hierarchy (
        HYBAS_ID_int_lev12 INTEGER PRIMARY KEY,
        {level_columns}
    )"""
)
placeholders = ", ".join(["?"] * (1 + len(LEVELS)))
cur.executemany(f"INSERT INTO catchment_hierarchy VALUES ({placeholders})", rows)
for lev, _ in LEVELS:
    cur.execute(f"CREATE INDEX idx_hierarchy_lev{lev} ON catchment_hierarchy(HYBAS_ID_int_lev{lev})")
conn.commit()

referenced = {lev: set(row[i + 1] for row in rows) for i, (lev, _) in enumerate(LEVELS)}

for lev, digits in LEVELS:
    print(f"  Building catchments_lev{lev} geometry table...")
    geoms = read_geoms(f"{hybas_dir}/hybas_af_lev{src_lev(digits)}_v1c.shp")
    cur.execute(f"DROP TABLE IF EXISTS catchments_lev{lev}")
    cur.execute(
        f"""CREATE TABLE catchments_lev{lev} (
            HYBAS_ID_int INTEGER PRIMARY KEY,
            HYBAS_ID REAL,
            geojson TEXT
        )"""
    )
    ins = [
        (hid, float(hid), json.dumps(json.loads(g), separators=(",", ":")))
        for hid, g in geoms.items()
        if hid in referenced[lev]
    ]
    cur.executemany(f"INSERT INTO catchments_lev{lev} VALUES (?,?,?)", ins)
    conn.commit()
    print(f"    {len(ins)} basins")

conn.close()

# Also write a proper OGR-readable GeoPackage of the same basins (real
# geometry column, not the geojson-text table above) -- this is what
# gpkg_to_mbtiles.sh needs to tile them. Filtered in Python rather than an
# ogr2ogr -where "HYBAS_ID IN (...)" because that list is tens of thousands
# of ids long and blows past the OS argument-length limit.
import os

driver = ogr.GetDriverByName("GPKG")
if os.path.exists(levels_gpkg):
    driver.DeleteDataSource(levels_gpkg)
out_ds = driver.CreateDataSource(levels_gpkg)

for lev, digits in LEVELS:
    print(f"  Writing catchments_lev{lev} to catchments-levels.gpkg...")
    src_ds = ogr.Open(f"{hybas_dir}/hybas_af_lev{src_lev(digits)}_v1c.shp")
    src_lyr = src_ds.GetLayer()
    out_lyr = out_ds.CreateLayer(f"catchments_lev{lev}", src_lyr.GetSpatialRef(), ogr.wkbMultiPolygon)
    out_lyr.CreateField(ogr.FieldDefn("HYBAS_ID", ogr.OFTInteger64))
    out_defn = out_lyr.GetLayerDefn()
    n = 0
    for f in src_lyr:
        hid = int(f.GetField("HYBAS_ID"))
        if hid not in referenced[lev]:
            continue
        out_f = ogr.Feature(out_defn)
        out_f.SetField("HYBAS_ID", hid)
        geom = valid_geom(f.GetGeometryRef())
        if geom.GetGeometryType() != ogr.wkbMultiPolygon:
            geom = ogr.ForceToMultiPolygon(geom)
        out_f.SetGeometry(geom)
        out_lyr.CreateFeature(out_f)
        n += 1
    print(f"    {n} basins")

out_ds = None
print("  Crosswalk and geometry tables done.")
PY
echo "  $SOURCE_DIR/catchments/catchments-levels.gpkg ready — pass it to gpkg_to_mbtiles.sh alongside the other sources."

echo "Aggregating scenario data to each level (SUB_AREA-weighted mean)..."

# Built in Python rather than piping PRAGMA table_info through awk/printf:
# column names here come straight from metadata.csv (species common names --
# "Thomson's Gazelle", "Red-fronted Gazelle", etc.) and a text pipeline
# splitting on a fixed separator is one stray delimiter away from quietly
# mis-aligning a row. sqlite3's own column-name values never need that kind
# of parsing — quote_ident below is the only escaping SQL identifiers
# actually require (doubling an embedded double quote).
python3 - "$OUTPUT" <<'PY'
import sqlite3
import sys

output_path = sys.argv[1]

EXCLUDED_COLUMNS = {"fid", "catchID", "catchment_id_int"}
LEVELS = ["04", "05", "06", "07", "08"]


def quote_ident(name):
    return '"' + name.replace('"', '""') + '"'


conn = sqlite3.connect(output_path)
cur = conn.cursor()

cur.execute("PRAGMA table_info(scenario_current)")
columns = [row[1] for row in cur.fetchall() if row[1] not in EXCLUDED_COLUMNS]

for scenario in ("current", "reference"):
    for lev in LEVELS:
        print(f"  scenario_{scenario}_lev{lev}...")

        select_expr = ",\n       ".join(
            f'SUM(CASE WHEN s.{quote_ident(col)} IS NOT NULL THEN s.{quote_ident(col)} * c.SUB_AREA END) '
            f'/ NULLIF(SUM(CASE WHEN s.{quote_ident(col)} IS NOT NULL THEN c.SUB_AREA END), 0) AS {quote_ident(col)}'
            for col in columns
        )

        cur.execute(f"DROP TABLE IF EXISTS scenario_{scenario}_lev{lev}")
        cur.execute(f"""
            CREATE TABLE scenario_{scenario}_lev{lev} AS
            SELECT h.HYBAS_ID_int_lev{lev} AS catchment_id_int,
                   {select_expr}
            FROM scenario_{scenario} s
            JOIN catchments_lev12 c ON c.HYBAS_ID_int = s.catchment_id_int
            JOIN catchment_hierarchy h ON h.HYBAS_ID_int_lev12 = c.HYBAS_ID_int
            GROUP BY h.HYBAS_ID_int_lev{lev}
        """)
        cur.execute(
            f"CREATE INDEX idx_{scenario}_lev{lev}_catchment_id_int "
            f"ON scenario_{scenario}_lev{lev}(catchment_id_int)"
        )
        conn.commit()

conn.close()
PY

echo "Reclaiming space (VACUUM)..."
sqlite3 "$OUTPUT" "VACUUM;"

echo ""
echo "Done. New tables in $OUTPUT:"
sqlite3 "$OUTPUT" "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%_lev04' OR name LIKE '%_lev05' OR name LIKE '%_lev06' OR name LIKE '%_lev07' OR name LIKE '%_lev08' OR name = 'catchment_hierarchy') ORDER BY name;"
