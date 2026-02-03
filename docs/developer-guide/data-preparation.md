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

The script `resources/mbtiles/gpkg_to_mbtiles.sh` automates the full conversion:

```bash
cd resources/mbtiles
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

The MapBox GL Style JSON at `resources/mbtiles/style.json` defines how each layer is rendered (colours, line widths, label placement). Edit this file to change the map's visual appearance.

## Scenario Data (CSV to Parquet)

Raw scenario data is delivered as CSV files:

| File | Description |
|------|-------------|
| `data/current.csv` | Current scenario — per-catchment metrics |
| `data/reference.csv` | Reference scenario — per-catchment metrics  |
| `data/metadata.csv` | Describes each column in the current and reference data|

All CSVs share a `catchID` column that cross-references catchment polygons in the MBTiles map.

### Converting CSV to Parquet

Convert CSVs to Parquet for efficient storage and fast columnar reads:

```bash
make csv2parquet
```

This runs `scripts/csv2parquet.py` which uses PyArrow to produce snappy-compressed Parquet files alongside the source CSVs in `data/`. The CSV files are gitignored; only the conversion tooling is tracked.

### Building a Data Pack

To bundle the Parquet files and MBTiles into a distributable zip:

```bash
make datapack
```

This automatically converts any CSVs to Parquet first, then assembles:

```
decision-theatre-data-v{VERSION}/
  data/
    current.parquet
    reference.parquet
    metadata.parquet
  resources/
    mbtiles/
      catchments.mbtiles
      style.json
  manifest.json
```

The resulting zip can be extracted on another host and used with `--data-dir` and `--resources-dir`.

### GeoParquet (future)

Place GeoParquet files in the `data/` directory for spatial scenario data with embedded geometry. The server reads these at startup and exposes attribute names via the API.
