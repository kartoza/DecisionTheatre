# Application Data Preparation

This guide covers how to prepare the data files that Decision Theatre consumes.

## Vector Map Tiles (MBTiles)

### Source Data

The map data originates from a GeoPackage file (`UoW_layers.gpkg`) containing:

| Layer | Description |
|-------|-------------|
| `ne_african_countries` | Country boundaries from Natural Earth |
| `ne_10m_rivers` | Major river networks |
| `ne_10m_lakes` | Lake boundaries |
| `ecoregions` | Ecological region boundaries |
| `catchments_lev12` | Level-12 catchment boundaries |
| `ne_10m_populated_places` | Cities and towns |

### Conversion Pipeline

The script `data/mbtiles/gpkg_to_mbtiles.sh` automates the full conversion:

```bash
cd data/mbtiles
./gpkg_to_mbtiles.sh UoW_layers.gpkg catchments.mbtiles
```

**Pipeline stages:**

1. **Layer discovery** -- queries `gpkg_contents` for all feature layers
2. **Geometry validation** -- checks for NULL geometries; optionally repairs with `ogr2ogr -makevalid`
3. **GeoJSONSeq export** -- converts each layer to newline-delimited GeoJSON using `ogr2ogr`
4. **Per-layer tile generation** -- runs `tippecanoe` for each layer with configured zoom ranges
5. **Merge** -- combines all per-layer MBTiles into a single file using `tile-join`

### Zoom Configuration

Each layer has configured minimum and maximum zoom levels:

| Layer | Min Zoom | Max Zoom |
|-------|----------|----------|
| `ne_african_countries` | 2 | 10 |
| `ne_10m_rivers` | 6 | 15 |
| `ne_10m_lakes` | 6 | 15 |
| `ecoregions` | 2 | 8 |
| `catchments_lev12` | 8 | 15 |
| `ne_10m_populated_places` | 6 | 15 |

Layers not in this table default to zoom 6--15.

### Required Tools

- `ogr2ogr` (GDAL)
- `tippecanoe`
- `sqlite3`

All are available in the Nix dev shell (`nix develop`).

### Map Style

The MapBox GL Style JSON at `data/mbtiles/style.json` defines how each layer is rendered (colours, line widths, label placement). Edit this file to change the map's visual appearance.

## Scenario Data (GeoPackage Datapack)

The application uses a GeoPackage file (`datapack.gpkg`) containing catchment geometries and scenario data. This is built from raw input files using the `scripts/build-geopackage.sh` script.

### Input Files

Place the following files in the `data/` directory:

| File | Description |
|------|-------------|
| `catchments.gpkg` | GeoPackage containing catchment geometries in the `catchments_lev12` layer |
| `current.csv` | Current scenario — per-catchment metrics |
| `reference.csv` | Reference scenario — per-catchment metrics |
| `metadata.csv` | (Optional) Describes each column in the scenario data |

All CSVs must have a `catchID` column that cross-references the `HYBAS_ID` in the catchment geometries.

### Building the Datapack

```bash
# Using Make (recommended)
make geopackage

# Or directly
./scripts/build-geopackage.sh ./data
```

This script performs the following steps:

1. **Base setup** — Copies `catchments.gpkg` as the base for the output file
2. **CSV import** — Imports scenario CSVs as raw tables using `ogr2ogr`
3. **Type conversion** — Converts data columns to REAL type, converting `NA` strings to NULL
4. **Column normalization** — Normalizes column names across tables (replaces dashes, spaces with dots)
5. **Indexing** — Creates integer indexes on catchment IDs for fast joins
6. **GeoJSON precomputation** — Converts geometries to GeoJSON for fast API serving
7. **Domain min/max** — Computes global min/max for each attribute across both scenarios

### Output GeoPackage Schema

The output `datapack.gpkg` contains these tables:

| Table | Description |
|-------|-------------|
| `catchments_lev12` | Catchment polygons with `HYBAS_ID`, `geom`, and precomputed `geojson` |
| `scenario_current` | Current scenario data with normalized column names |
| `scenario_reference` | Reference scenario data with normalized column names |
| `domain_minima` | Global minimum values for each attribute across both scenarios |
| `domain_maxima` | Global maximum values for each attribute across both scenarios |
| `metadata` | (If provided) Column descriptions from the metadata CSV |

#### Scenario Tables Schema

Both `scenario_current` and `scenario_reference` tables have:

- `catchment_id` (TEXT) — The catchment identifier (normalized from `catchID`)
- `catchment_id_int` (INTEGER) — Integer version for indexed joins
- All attribute columns as REAL type (NULL for missing/NA values)

#### Domain Tables Schema

The `domain_minima` and `domain_maxima` tables each contain one row with:

- All attribute columns from the scenario tables
- Each column contains the global min (or max) value computed across both scenarios
- These are used for consistent color scaling across scenario comparisons

### Column Normalization

The build script normalizes column names to ensure consistency between tables:

- `catchID` → `catchment_id`
- Dashes (`-`), spaces, apostrophes → dots (`.`)
- Multiple consecutive dots → single dot
- Duplicate ID columns (e.g., `sp_current.catchID`) are dropped

### Required Tools

- `ogr2ogr` (GDAL)
- `sqlite3`
- `python3`

All are available in the Nix dev shell (`nix develop`).

## Legacy: CSV to Parquet

For historical reference, there was a previous approach using Parquet files:

```bash
make csv2parquet
```

This converted CSVs to Parquet using PyArrow. The current GeoPackage-based approach is preferred as it consolidates all data into a single file with proper spatial indexing.
