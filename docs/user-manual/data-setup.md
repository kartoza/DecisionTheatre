# Data Setup

Landscape Decision Theatre separates the application (binary + docs) from the data. Data is distributed as a **data pack** — a single `.zip` file containing map tiles, styles, and optional scenario data.

## Installing a Data Pack

### Via the Application UI

On first launch (or when no data is loaded), the application shows a Setup Guide with a data pack installer:

1. Obtain a data pack `.zip` file from the project maintainers
2. Enter the full file path in the "Install Data Pack" field
3. Click **Install**
4. The application extracts the data pack and reloads automatically

The extracted data is stored in your user data directory:

| Platform | Path |
|----------|------|
| Linux | `~/.local/share/decision-theatre/datapacks/` |
| macOS | `~/Library/Application Support/decision-theatre/datapacks/` |
| Windows | `%LOCALAPPDATA%\decision-theatre\datapacks\` |

The application remembers the data pack location across restarts.

### Via Command-Line Flags

You can also point directly at an extracted data directory:

```bash
./decision-theatre --data-dir /path/to/data
```

## Data Pack Format

A data pack is a `.zip` archive with this structure:

```
decision-theatre-data-v1.0.0.zip
├── manifest.json
└── data/
    ├── mbtiles/
    │   ├── catchments.mbtiles # vector tile data (required)
    │   └── style.json         # MapBox style (required)
    └── *.geoparquet           # scenario data (optional)
```

### manifest.json

```json
{
  "format": "decision-theatre-datapack",
  "version": "1.0.0",
  "description": "UoW Catchments Data Pack",
  "created": "2026-01-29T00:00:00Z"
}
```

## Building a Data Pack

Data packs are built locally by project maintainers using:

```bash
make datapack
```

Or directly:

```bash
./scripts/package-data.sh [version]
```

This:

1. Validates `data/` directory
2. Generates a `manifest.json`
3. Creates `dist/decision-theatre-data-v{VERSION}.zip`
4. Generates a SHA256 checksum

### Prerequisites for Building

The source data must be prepared first:

1. Obtain `UoW_layers.gpkg` from the project maintainers
2. Convert to MBTiles using the included script:

```bash
nix develop
cd data/mbtiles
./gpkg_to_mbtiles.sh UoW_layers.gpkg catchments.mbtiles
```

3. Optionally add GeoParquet scenario files to `data/`
4. Run `make datapack`

## Required: Map Tiles (MBTiles)

The application needs a vector MBTiles file containing African catchment boundaries, country outlines, rivers, lakes, ecoregions, and populated places.

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

To enable scenario comparison, include GeoParquet files in the data pack's `data/` directory:

```
data/
  past.geoparquet
  present.geoparquet
  future.geoparquet
```

Each file should contain catchment geometries with attribute columns representing the factors available for comparison.

