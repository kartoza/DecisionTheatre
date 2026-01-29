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

The MapBox GL Style JSON at `resources/mbtiles/uow_tiles.json` defines how each layer is rendered (colours, line widths, label placement). Edit this file to change the map's visual appearance.

## Scenario Data (GeoParquet)

Place GeoParquet files in the `data/` directory:

```
data/
  past.geoparquet
  present.geoparquet
  future.geoparquet
```

Each file should contain:

- A geometry column with catchment boundaries
- Attribute columns for each factor available for comparison

The server reads these files at startup and exposes the attribute names via the API.

## LLM Model (GGUF)

Download a GGUF-format model compatible with llama.cpp and pass it with `--model`:

```bash
./decision-theatre --model ./models/your-model.gguf
```

## Neural Network Model (GOB)

A trained Gorgonia model serialised with Go's `encoding/gob` can be placed in the data directory. The filename convention and loading logic are defined in `internal/nn/model.go`.
