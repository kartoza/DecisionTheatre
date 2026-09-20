#!/usr/bin/env bash
#
# build-catchment-hierarchy.sh — build the multi-resolution catchment tables
# used for the low/mid-zoom choropleth: a lev12 -> lev04/06/08 parent
# crosswalk, coarser catchment boundaries, and scenario data aggregated up
# to each level.
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
#     scripts/fetch-hydrobasins.sh) -- levels 04, 06, 08 and 12 shapefiles
#
# How the crosswalk works:
#   HydroBASINS' Pfafstetter codes (PFAF_ID) are hierarchical by
#   construction: a lev12 catchment's parent at lev08 has a PFAF_ID that is
#   exactly the first 8 digits of the lev12 catchment's own PFAF_ID (lev06:
#   first 6; lev04: first 4). This was verified against all 147,837
#   catchments in the current data pack with zero unmatched rows -- exact
#   string-prefix matching, no spatial join needed. catchments.gpkg itself
#   doesn't carry PFAF_ID (it was dropped when the study-area subset was
#   clipped from the continental HydroBASINS set), so PFAF_ID is read fresh
#   from the lev12 shapefile here and joined back in by HYBAS_ID.
#
# Output tables added to DATA_DIR/datapack.gpkg:
#   - catchment_hierarchy      lev12 HYBAS_ID_int -> lev04/06/08 parent HYBAS_ID_int
#   - catchments_lev04/06/08   HYBAS_ID, HYBAS_ID_int, geojson (no rtree --
#     a few hundred to tens of thousands of rows, not worth indexing)
#   - scenario_current_lev04/06/08, scenario_reference_lev04/06/08
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
for lev in 04 06 08 12; do
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

LEVELS = [("04", 4), ("06", 6), ("08", 8)]


def read_pfaf(path):
    ds = ogr.Open(path)
    lyr = ds.GetLayer()
    return {int(f.GetField("HYBAS_ID")): str(int(f.GetField("PFAF_ID"))) for f in lyr}


def read_geoms(path):
    ds = ogr.Open(path)
    lyr = ds.GetLayer()
    out = {}
    for f in lyr:
        hid = int(f.GetField("HYBAS_ID"))
        geom = f.GetGeometryRef()
        out[hid] = geom.ExportToJson()
    return out


print("  Reading PFAF_ID from lev12 source shapefile...")
pfaf12 = read_pfaf(f"{hybas_dir}/hybas_af_lev12_v1c.shp")

level_prefix_index = {}
for lev, digits in LEVELS:
    print(f"  Reading PFAF_ID from lev{lev} source shapefile...")
    pfaf_lev = read_pfaf(f"{hybas_dir}/hybas_af_lev{lev}_v1c.shp")
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
cur.execute(
    """CREATE TABLE catchment_hierarchy (
        HYBAS_ID_int_lev12 INTEGER PRIMARY KEY,
        HYBAS_ID_int_lev04 INTEGER,
        HYBAS_ID_int_lev06 INTEGER,
        HYBAS_ID_int_lev08 INTEGER
    )"""
)
cur.executemany("INSERT INTO catchment_hierarchy VALUES (?,?,?,?)", rows)
cur.execute("CREATE INDEX idx_hierarchy_lev04 ON catchment_hierarchy(HYBAS_ID_int_lev04)")
cur.execute("CREATE INDEX idx_hierarchy_lev06 ON catchment_hierarchy(HYBAS_ID_int_lev06)")
cur.execute("CREATE INDEX idx_hierarchy_lev08 ON catchment_hierarchy(HYBAS_ID_int_lev08)")
conn.commit()

referenced = {lev: set(row[i + 1] for row in rows) for i, (lev, _) in enumerate(LEVELS)}

for lev, _ in LEVELS:
    print(f"  Building catchments_lev{lev} geometry table...")
    geoms = read_geoms(f"{hybas_dir}/hybas_af_lev{lev}_v1c.shp")
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

for lev, _ in LEVELS:
    print(f"  Writing catchments_lev{lev} to catchments-levels.gpkg...")
    src_ds = ogr.Open(f"{hybas_dir}/hybas_af_lev{lev}_v1c.shp")
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
        geom = f.GetGeometryRef()
        if geom.GetGeometryType() == ogr.wkbPolygon:
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

# Column list: every scenario_current column except the ID columns, same
# exclusion set build-geopackage.sh's own type-conversion step uses.
COLUMNS=$(sqlite3 "$OUTPUT" "PRAGMA table_info(scenario_current)" | \
    awk -F'|' '{print $2}' | \
    grep -v -E '^(fid|catchID|catchment_id_int)$')

for scenario in current reference; do
    for lev in 04 06 08; do
        echo "  scenario_${scenario}_lev${lev}..."

        SELECT_EXPR=$(echo "$COLUMNS" | while IFS= read -r col; do
            [ -n "$col" ] || continue
            printf 'SUM(CASE WHEN s."%s" IS NOT NULL THEN s."%s" * c.SUB_AREA END) / NULLIF(SUM(CASE WHEN s."%s" IS NOT NULL THEN c.SUB_AREA END), 0) AS "%s"\n' \
                "$col" "$col" "$col" "$col"
        done | paste -sd',')

        sqlite3 "$OUTPUT" <<SQL
DROP TABLE IF EXISTS scenario_${scenario}_lev${lev};
CREATE TABLE scenario_${scenario}_lev${lev} AS
SELECT h.HYBAS_ID_int_lev${lev} AS catchment_id_int,
       $SELECT_EXPR
FROM scenario_${scenario} s
JOIN catchments_lev12 c ON c.HYBAS_ID_int = s.catchment_id_int
JOIN catchment_hierarchy h ON h.HYBAS_ID_int_lev12 = c.HYBAS_ID_int
GROUP BY h.HYBAS_ID_int_lev${lev};
CREATE INDEX idx_${scenario}_lev${lev}_catchment_id_int ON scenario_${scenario}_lev${lev}(catchment_id_int);
SQL
    done
done

echo "Reclaiming space (VACUUM)..."
sqlite3 "$OUTPUT" "VACUUM;"

echo ""
echo "Done. New tables in $OUTPUT:"
sqlite3 "$OUTPUT" "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%_lev04' OR name LIKE '%_lev06' OR name LIKE '%_lev08' OR name = 'catchment_hierarchy') ORDER BY name;"
