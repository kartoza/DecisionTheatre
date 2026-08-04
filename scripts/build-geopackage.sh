#!/usr/bin/env bash
#
# Build the datapack geopackage from input files.
#
# Inputs (in data/ directory):
#   - catchments.gpkg  : Geopackage with catchment geometries
#   - current.csv      : Current scenario attribute data
#   - current_lower.csv: Current scenario lower-bound attribute data
#   - current_upper.csv: Current scenario upper-bound attribute data
#   - reference.csv    : Reference scenario attribute data
#   - reference_lower.csv: Reference scenario lower-bound attribute data
#   - reference_upper.csv: Reference scenario upper-bound attribute data
#   - medata.csv       : Column metadata
#
# Output:
#   - data/datapack.gpkg : Combined geopackage with all data
#

set -e

DATA_DIR="${1:-./data}"
OUTPUT="$DATA_DIR/datapack.gpkg"

echo "Building datapack from $DATA_DIR..."

# Check inputs exist
for f in catchments.gpkg current.csv current_lower.csv current_upper.csv reference.csv reference_lower.csv reference_upper.csv; do
    if [ ! -f "$DATA_DIR/$f" ]; then
        echo "Error: Missing $DATA_DIR/$f"
        exit 1
    fi
done

# Remove existing output
rm -f "$OUTPUT"

# Copy the catchments geopackage as the base
echo "Copying catchments.gpkg as base..."
cp "$DATA_DIR/catchments.gpkg" "$OUTPUT"

# Import CSV files as tables using ogr2ogr
echo "Importing current.csv..."
ogr2ogr -f GPKG -update "$OUTPUT" \
    -nln "scenario_current_raw" \
    "$DATA_DIR/current.csv"

echo "Importing reference.csv..."
ogr2ogr -f GPKG -update "$OUTPUT" \
    -nln "scenario_reference_raw" \
    "$DATA_DIR/reference.csv"

echo "Importing current_lower.csv..."
ogr2ogr -f GPKG -update "$OUTPUT" \
    -nln "scenario_current_lower_raw" \
    "$DATA_DIR/current_lower.csv"

echo "Importing current_upper.csv..."
ogr2ogr -f GPKG -update "$OUTPUT" \
    -nln "scenario_current_upper_raw" \
    "$DATA_DIR/current_upper.csv"

echo "Importing reference_lower.csv..."
ogr2ogr -f GPKG -update "$OUTPUT" \
    -nln "scenario_reference_lower_raw" \
    "$DATA_DIR/reference_lower.csv"

echo "Importing reference_upper.csv..."
ogr2ogr -f GPKG -update "$OUTPUT" \
    -nln "scenario_reference_upper_raw" \
    "$DATA_DIR/reference_upper.csv"

# Import metadata if it exists
if [ -f "$DATA_DIR/medata.csv" ]; then
    echo "Importing medata.csv..."
    ogr2ogr -f GPKG -update "$OUTPUT" \
        -nln "metadata" \
        "$DATA_DIR/medata.csv"
elif [ -f "$DATA_DIR/metadata.csv" ]; then
    echo "Importing metadata.csv..."
    ogr2ogr -f GPKG -update "$OUTPUT" \
        -nln "metadata" \
        "$DATA_DIR/metadata.csv"
fi

# Convert all data columns to REAL type and NA strings to NULL
# This ensures proper numeric handling for min/max and color scaling
echo "Converting columns to REAL type (NA -> NULL)..."
python3 - "$OUTPUT" <<'TYPEPY'
import sqlite3
import sys

gpkg_path = sys.argv[1]
conn = sqlite3.connect(gpkg_path)
cur = conn.cursor()

def convert_table_types(raw_table, target_table):
    """Convert a raw imported table to proper types: ID columns stay text, all others become REAL."""
    cur.execute(f"PRAGMA table_info({raw_table})")
    columns = [(row[1], row[2]) for row in cur.fetchall()]  # (name, type)

    # ID columns that should remain as-is
    id_columns = {'fid', 'ogc_fid', 'catchID', 'catchment_id', 'sp_current.catchID',
                  'sp_reference$catchID', 'sp_reference.catchID'}

    # Build column definitions and select expressions
    col_defs = []
    select_parts = []

    for col_name, col_type in columns:
        if col_name in id_columns:
            # Keep ID columns as their original type
            col_defs.append(f'"{col_name}" {col_type}')
            select_parts.append(f'"{col_name}"')
        else:
            # Convert data columns to REAL, with NA -> NULL
            col_defs.append(f'"{col_name}" REAL')
            # CASE expression: if value is 'NA' or empty, return NULL, else cast to REAL
            select_parts.append(f'CASE WHEN "{col_name}" = \'NA\' OR "{col_name}" = \'\' THEN NULL ELSE CAST("{col_name}" AS REAL) END as "{col_name}"')

    # Create new table with proper types
    cur.execute(f"DROP TABLE IF EXISTS {target_table}")
    cur.execute(f"CREATE TABLE {target_table} ({', '.join(col_defs)})")

    # Copy data with type conversion
    cur.execute(f"INSERT INTO {target_table} SELECT {', '.join(select_parts)} FROM {raw_table}")

    # Drop raw table and clean up gpkg_contents reference
    cur.execute(f"DROP TABLE {raw_table}")
    cur.execute(f"DELETE FROM gpkg_contents WHERE table_name = '{raw_table}'")
    cur.execute(f"DELETE FROM gpkg_geometry_columns WHERE table_name = '{raw_table}'")

    conn.commit()

    # Count non-null values in first data column to verify
    first_data_col = None
    for col_name, _ in columns:
        if col_name not in id_columns:
            first_data_col = col_name
            break

    if first_data_col:
        cur.execute(f'SELECT COUNT(*) FROM {target_table} WHERE "{first_data_col}" IS NOT NULL')
        count = cur.fetchone()[0]
        print(f"  {target_table}: Converted {len(columns)} columns, {count} rows with non-null data")

convert_table_types("scenario_current_raw", "scenario_current")
convert_table_types("scenario_reference_raw", "scenario_reference")
convert_table_types("scenario_current_lower_raw", "scenario_current_lower")
convert_table_types("scenario_current_upper_raw", "scenario_current_upper")
convert_table_types("scenario_reference_lower_raw", "scenario_reference_lower")
convert_table_types("scenario_reference_upper_raw", "scenario_reference_upper")

conn.close()
print("  Done converting column types")
TYPEPY

# Keep original CSV column names exactly as imported.
# No normalization or renaming is applied.

# Create index on catchID columns for fast joins
# First, convert catchID to integer for proper indexing
echo "Creating indexes..."

# Drop SpatiaLite triggers that use functions we don't have
sqlite3 "$OUTPUT" <<EOF
DROP TRIGGER IF EXISTS rtree_catchments_lev12_geom_insert;
DROP TRIGGER IF EXISTS rtree_catchments_lev12_geom_update1;
DROP TRIGGER IF EXISTS rtree_catchments_lev12_geom_update2;
DROP TRIGGER IF EXISTS rtree_catchments_lev12_geom_update3;
DROP TRIGGER IF EXISTS rtree_catchments_lev12_geom_update4;
DROP TRIGGER IF EXISTS rtree_catchments_lev12_geom_delete;
DROP TRIGGER IF EXISTS trigger_insert_feature_count_catchments_lev12;
DROP TRIGGER IF EXISTS trigger_delete_feature_count_catchments_lev12;
EOF

sqlite3 "$OUTPUT" <<EOF
-- Add an integer catchment_id_int column for proper indexing
ALTER TABLE scenario_current ADD COLUMN catchment_id_int INTEGER;
UPDATE scenario_current SET catchment_id_int = CAST(catchID AS INTEGER);
CREATE INDEX IF NOT EXISTS idx_current_catchment_id_int ON scenario_current(catchment_id_int);

ALTER TABLE scenario_reference ADD COLUMN catchment_id_int INTEGER;
UPDATE scenario_reference SET catchment_id_int = CAST(catchID AS INTEGER);
CREATE INDEX IF NOT EXISTS idx_reference_catchment_id_int ON scenario_reference(catchment_id_int);

ALTER TABLE scenario_current_lower ADD COLUMN catchment_id_int INTEGER;
UPDATE scenario_current_lower SET catchment_id_int = CAST(catchID AS INTEGER);
CREATE INDEX IF NOT EXISTS idx_current_lower_catchment_id_int ON scenario_current_lower(catchment_id_int);

ALTER TABLE scenario_current_upper ADD COLUMN catchment_id_int INTEGER;
UPDATE scenario_current_upper SET catchment_id_int = CAST(catchID AS INTEGER);
CREATE INDEX IF NOT EXISTS idx_current_upper_catchment_id_int ON scenario_current_upper(catchment_id_int);

ALTER TABLE scenario_reference_lower ADD COLUMN catchment_id_int INTEGER;
UPDATE scenario_reference_lower SET catchment_id_int = CAST(catchID AS INTEGER);
CREATE INDEX IF NOT EXISTS idx_reference_lower_catchment_id_int ON scenario_reference_lower(catchment_id_int);

ALTER TABLE scenario_reference_upper ADD COLUMN catchment_id_int INTEGER;
UPDATE scenario_reference_upper SET catchment_id_int = CAST(catchID AS INTEGER);
CREATE INDEX IF NOT EXISTS idx_reference_upper_catchment_id_int ON scenario_reference_upper(catchment_id_int);

-- Also create an integer index on HYBAS_ID in catchments_lev12
ALTER TABLE catchments_lev12 ADD COLUMN HYBAS_ID_int INTEGER;
UPDATE catchments_lev12 SET HYBAS_ID_int = CAST(HYBAS_ID AS INTEGER);
CREATE INDEX IF NOT EXISTS idx_catchments_hybas_int ON catchments_lev12(HYBAS_ID_int);
EOF

# Add pre-computed GeoJSON column for fast serving
# This avoids expensive WKB-to-GeoJSON conversion at runtime
echo "Computing GeoJSON geometries..."
python3 - "$OUTPUT" <<'PYEOF'
import sqlite3
import sys
import json

gpkg_path = sys.argv[1]
conn = sqlite3.connect(gpkg_path)
cur = conn.cursor()

# Add geojson column if it doesn't exist
try:
    cur.execute("ALTER TABLE catchments_lev12 ADD COLUMN geojson TEXT")
except sqlite3.OperationalError:
    pass  # Column already exists

# Get all catchments with geometry
cur.execute("SELECT fid, geom FROM catchments_lev12 WHERE geom IS NOT NULL")
rows = cur.fetchall()

print(f"Converting {len(rows)} geometries to GeoJSON...")

def gpb_to_geojson(gpb):
    """Convert GeoPackage Binary to GeoJSON dict."""
    if len(gpb) < 8:
        return None
    # Check magic
    if gpb[0:2] != b'GP':
        return None

    # Get envelope type from flags
    flags = gpb[3]
    envelope_type = (flags >> 1) & 0x07

    envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    envelope_size = envelope_sizes.get(envelope_type, 0)

    wkb_start = 8 + envelope_size
    if wkb_start >= len(gpb):
        return None

    wkb = gpb[wkb_start:]
    return wkb_to_geojson(wkb)

def wkb_to_geojson(wkb):
    """Convert WKB to GeoJSON dict."""
    if len(wkb) < 5:
        return None

    byte_order = wkb[0]
    big_endian = byte_order == 0

    if big_endian:
        geom_type = int.from_bytes(wkb[1:5], 'big')
    else:
        geom_type = int.from_bytes(wkb[1:5], 'little')

    base_type = geom_type & 0xFF

    if base_type == 3:  # Polygon
        return parse_polygon(wkb, big_endian)
    elif base_type == 6:  # MultiPolygon
        return parse_multipolygon(wkb, big_endian)
    return None

def read_float64(data, offset, big_endian):
    import struct
    fmt = '>d' if big_endian else '<d'
    return struct.unpack(fmt, data[offset:offset+8])[0]

def parse_polygon(wkb, big_endian):
    offset = 5
    if big_endian:
        num_rings = int.from_bytes(wkb[offset:offset+4], 'big')
    else:
        num_rings = int.from_bytes(wkb[offset:offset+4], 'little')
    offset += 4

    rings = []
    for _ in range(num_rings):
        if big_endian:
            num_points = int.from_bytes(wkb[offset:offset+4], 'big')
        else:
            num_points = int.from_bytes(wkb[offset:offset+4], 'little')
        offset += 4

        ring = []
        for _ in range(num_points):
            x = read_float64(wkb, offset, big_endian)
            y = read_float64(wkb, offset + 8, big_endian)
            offset += 16
            ring.append([x, y])
        rings.append(ring)

    return {"type": "Polygon", "coordinates": rings}

def parse_multipolygon(wkb, big_endian):
    offset = 5
    if big_endian:
        num_polygons = int.from_bytes(wkb[offset:offset+4], 'big')
    else:
        num_polygons = int.from_bytes(wkb[offset:offset+4], 'little')
    offset += 4

    polygons = []
    for _ in range(num_polygons):
        # Skip byte order and type for inner polygon
        offset += 5

        if big_endian:
            num_rings = int.from_bytes(wkb[offset:offset+4], 'big')
        else:
            num_rings = int.from_bytes(wkb[offset:offset+4], 'little')
        offset += 4

        rings = []
        for _ in range(num_rings):
            if big_endian:
                num_points = int.from_bytes(wkb[offset:offset+4], 'big')
            else:
                num_points = int.from_bytes(wkb[offset:offset+4], 'little')
            offset += 4

            ring = []
            for _ in range(num_points):
                x = read_float64(wkb, offset, big_endian)
                y = read_float64(wkb, offset + 8, big_endian)
                offset += 16
                ring.append([x, y])
            rings.append(ring)
        polygons.append(rings)

    return {"type": "MultiPolygon", "coordinates": polygons}

# Process in batches
batch_size = 1000
updates = []
for i, (fid, geom) in enumerate(rows):
    if geom:
        geojson = gpb_to_geojson(geom)
        if geojson:
            updates.append((json.dumps(geojson, separators=(',', ':')), fid))

    if len(updates) >= batch_size:
        cur.executemany("UPDATE catchments_lev12 SET geojson = ? WHERE fid = ?", updates)
        conn.commit()
        print(f"  Processed {i+1}/{len(rows)}...")
        updates = []

# Final batch
if updates:
    cur.executemany("UPDATE catchments_lev12 SET geojson = ? WHERE fid = ?", updates)
    conn.commit()

print(f"Done converting {len(rows)} geometries.")

# Restore the triggers (commented out - they use SpatiaLite functions we don't have)
# But since we're not modifying geometry, we don't need them for our use case
# for trig_name, trig_sql in saved_triggers.items():
#     if trig_sql:
#         try:
#             cur.execute(trig_sql)
#         except Exception as e:
#             print(f"Warning: could not restore trigger {trig_name}: {e}")
# conn.commit()

conn.close()
PYEOF

# Add pre-computed simplified GeoJSON column for the low-zoom grid-aggregated
# choropleth (see buildGridGeometryCache in internal/geodata/gpkg_store.go).
# Uses GEOS's topology-preserving simplifier (via ogr2ogr -simplify -makevalid)
# rather than plain Douglas-Peucker: it guarantees each simplified polygon
# stays valid (no self-intersections), which naive per-vertex simplification
# doesn't - an invalid polygon fails the polyclip union done at server start
# and leaves a gap in the choropleth for that grid cell.
echo "Computing simplified GeoJSON geometries for grid aggregation..."
SIMPLIFIED_GEOJSON=$(mktemp --suffix=.geojson)
trap 'rm -f "$SIMPLIFIED_GEOJSON"' EXIT
rm -f "$SIMPLIFIED_GEOJSON"
ogr2ogr -f GeoJSON "$SIMPLIFIED_GEOJSON" "$OUTPUT" catchments_lev12 \
    -simplify 0.001 -makevalid -select HYBAS_ID_int

python3 - "$OUTPUT" "$SIMPLIFIED_GEOJSON" <<'PYEOF'
import sqlite3
import sys
import json

gpkg_path, geojson_path = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(gpkg_path)
cur = conn.cursor()

try:
    cur.execute("ALTER TABLE catchments_lev12 ADD COLUMN geojson_simplified TEXT")
except sqlite3.OperationalError:
    pass  # Column already exists

with open(geojson_path) as f:
    simplified = json.load(f)

batch_size = 1000
updates = []
for i, feature in enumerate(simplified["features"]):
    hybas_id = feature["properties"]["HYBAS_ID_int"]
    geometry = feature["geometry"]
    if geometry is None:
        continue
    updates.append((json.dumps(geometry, separators=(",", ":")), hybas_id))

    if len(updates) >= batch_size:
        cur.executemany(
            "UPDATE catchments_lev12 SET geojson_simplified = ? WHERE HYBAS_ID_int = ?",
            updates)
        conn.commit()
        print(f"  Processed {i+1}/{len(simplified['features'])}...")
        updates = []

if updates:
    cur.executemany(
        "UPDATE catchments_lev12 SET geojson_simplified = ? WHERE HYBAS_ID_int = ?",
        updates)
    conn.commit()

print(f"Done computing simplified geometries for {len(simplified['features'])} catchments.")
conn.close()
PYEOF
rm -f "$SIMPLIFIED_GEOJSON"
trap - EXIT

# Create domain_minima and domain_maxima tables
# These store the min/max values across both scenarios for consistent color scaling
# Use a single SQL query that computes all min/max in ONE pass through the data
echo "Computing domain minima and maxima tables..."

# Get column names (excluding ID columns)
COLUMNS=$(sqlite3 "$OUTPUT" "PRAGMA table_info(scenario_current)" | \
    awk -F'|' '{print $2}' | \
    grep -v -E '^(fid|catchment_id|catchment_id_int|ogc_fid)$')

NUM_COLS=$(echo "$COLUMNS" | wc -l)
echo "  Computing min/max for $NUM_COLS attribute columns in a single pass..."

# Build SQL fragments while preserving full column names (including spaces).
# This avoids shell word-splitting bugs when headers contain spaces.
COL_DEFS=$(echo "$COLUMNS" | while IFS= read -r col; do
    [ -n "$col" ] || continue
    echo "\"$col\" REAL"
done | paste -sd',')

# Build MIN/MAX expressions (columns are already REAL type with NULL for NA values)
MIN_SELECT=$(echo "$COLUMNS" | while IFS= read -r col; do
    [ -n "$col" ] || continue
    echo "MIN(\"$col\") as \"$col\""
done | paste -sd',')

MAX_SELECT=$(echo "$COLUMNS" | while IFS= read -r col; do
    [ -n "$col" ] || continue
    echo "MAX(\"$col\") as \"$col\""
done | paste -sd',')

# Create tables and compute in single queries
sqlite3 "$OUTPUT" <<SQLDOMAIN
DROP TABLE IF EXISTS domain_minima;
DROP TABLE IF EXISTS domain_maxima;
CREATE TABLE domain_minima ($COL_DEFS);
CREATE TABLE domain_maxima ($COL_DEFS);

-- Compute minima across both tables in one query (columns are REAL, NA already NULL)
INSERT INTO domain_minima
SELECT $MIN_SELECT
FROM (
    SELECT * FROM scenario_current
    UNION ALL
    SELECT * FROM scenario_reference
);

-- Compute maxima across both tables in one query (columns are REAL, NA already NULL)
INSERT INTO domain_maxima
SELECT $MAX_SELECT
FROM (
    SELECT * FROM scenario_current
    UNION ALL
    SELECT * FROM scenario_reference
);
SQLDOMAIN

echo "  Created domain_minima and domain_maxima tables with $NUM_COLS columns"

# Check the result
echo ""
echo "Created $OUTPUT"
echo "Layers:"
ogrinfo "$OUTPUT" 2>/dev/null | grep -E "^\d+:" || ogrinfo "$OUTPUT"

echo ""
echo "Done!"
