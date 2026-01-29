# Data Setup

Decision Theatre requires map tile data and optionally scenario data files.

## Required: Map Tiles (MBTiles)

The application needs a vector MBTiles file at `resources/mbtiles/catchments.mbtiles` containing African catchment boundaries, country outlines, rivers, lakes, ecoregions, and populated places.

### Obtaining the Source GeoPackage

Contact the project maintainers to obtain `UoW_layers.gpkg`. This file contains all the vector layers used in the application.

### Converting to MBTiles

Use the included conversion script. This requires `gdal`, `tippecanoe`, and `sqlite3` (all available in the Nix devShell):

```bash
# Enter the development shell
nix develop

# Run the conversion
cd resources/mbtiles
./gpkg_to_mbtiles.sh UoW_layers.gpkg catchments.mbtiles
```

The script:

1. Discovers all feature layers in the GeoPackage
2. Checks for and optionally fixes NULL geometries
3. Exports each layer to GeoJSONSeq
4. Builds per-layer MBTiles with appropriate zoom ranges
5. Merges all layers into a single MBTiles file

The output is approximately 8 GB.

### Layer Zoom Ranges

| Layer | Min Zoom | Max Zoom |
|-------|----------|----------|
| `ne_african_countries` | 2 | 10 |
| `ne_10m_rivers` | 6 | 15 |
| `ne_10m_lakes` | 6 | 15 |
| `ecoregions` | 2 | 8 |
| `catchments_lev12` | 8 | 15 |
| `ne_10m_populated_places` | 6 | 15 |

## Optional: Scenario Data (GeoParquet)

To enable scenario comparison, place GeoParquet files in the `data/` directory:

```
data/
  past.geoparquet
  present.geoparquet
  future.geoparquet
```

Each file should contain catchment geometries with attribute columns representing the factors available for comparison.

## Optional: LLM Model (GGUF)

To enable the AI chat feature, download a GGUF model file and pass its path at startup:

```bash
./decision-theatre --model ./models/your-model.gguf
```

## Optional: Neural Network Model

A trained Gorgonia model file (`.gob`) can be placed in the data directory for catchment prediction features.

## Directory Structure

```
DecisionTheatre/
  resources/
    mbtiles/
      catchments.mbtiles    # vector tile data (required)
      uow_tiles.json        # MapBox style (included)
      gpkg_to_mbtiles.sh    # conversion script (included)
      UoW_layers.gpkg       # source GeoPackage (obtain separately)
  data/
    *.geoparquet            # scenario data (optional)
```
