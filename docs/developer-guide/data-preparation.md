# Application Data Preparation

This guide covers how to prepare the data files that Decision Theatre consumes.


<figure markdown>
  ![Source data flowing through to a distributable data pack](../assets/diagrams/generated/data-prep-pipeline.svg)
  <figcaption class="static">
    Validate before shipping: <code>nix run .#check-data</code>.
  </figcaption>
</figure>

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
./gpkg_to_mbtiles.sh UoW_layers.gpkg
```

The script stages output in `resources/mbtiles/` during processing, then moves the final `africa.mbtiles` to `data/mbtiles/` on completion.

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

## Fetching Data from Google Drive

The script `scripts/fetch-data.sh` downloads all files from a shared Google Drive folder (including subfolders) directly into the `data/` directory, preserving the folder structure. Run this before `make geopackage` to pull the latest source files in one step.

### Installation: rclone

The script requires [rclone](https://rclone.org), a command-line tool for cloud storage. Install it once on your machine:

=== "Linux / macOS"

    ```bash
    sudo curl https://rclone.org/install.sh | sudo bash
    ```

=== "macOS (Homebrew)"

    ```bash
    brew install rclone
    ```

=== "Windows"

    Download the installer from [rclone.org/downloads](https://rclone.org/downloads/) and add `rclone.exe` to your `PATH`.

### One-time Google Drive configuration

rclone needs a named **remote** that points to your Google Drive account. Create one called `gdrive` by running:

```bash
rclone config
```

Follow the interactive prompts:

1. Press `n` for **New remote**.
2. Name it `gdrive`.
3. Choose **Google Drive** **24** as the storage type.
4. Leave the client ID and secret blank (uses rclone's defaults).
5. Choose scope `drive.readonly` **2** if you only need to download, or `drive` for full access.
6. Follow the browser OAuth flow to authorise rclone with your Google account.
7. Accept the default for all remaining options and confirm.

Verify the remote works:

```bash
rclone lsd gdrive:
```

!!! note "Service account authentication"
    For automated or CI environments, use a Google service account instead of OAuth.
    Pass `--drive-service-account-file /path/to/key.json` to rclone, or add it to your
    remote configuration during `rclone config`.

### Finding the folder ID

Open the Google Drive folder in your browser. The folder ID is the last segment of the URL:

```
https://drive.google.com/drive/folders/1ABCdef_ghiJKLmnopQRSTuvwXYZ
                                        ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                        this is the folder ID
```

The folder must be shared with the Google account you authenticated with rclone, or set to **Anyone with the link**.

### Usage

```bash
# Using Make (recommended)
make fetch-data FOLDER=<folder-id-or-url>

# Or directly
./scripts/fetch-data.sh <folder-id-or-url> [data-dir]
```

Both a bare folder ID and a full URL are accepted:

```bash
# Bare folder ID
make fetch-data FOLDER=1ABCdef_ghiJKLmnopQRSTuvwXYZ

# Full shareable URL
make fetch-data FOLDER="https://drive.google.com/drive/folders/1ABCdef_ghiJKLmnopQRSTuvwXYZ"

# Custom destination directory
./scripts/fetch-data.sh 1ABCdef_ghiJKLmnopQRSTuvwXYZ /path/to/data
```

### What the script does

1. Extracts the folder ID from the argument (whether a bare ID or URL).
2. Checks that rclone is installed and the `gdrive` remote exists.
3. Copies all files from the Drive folder and any subfolders into `data/` using `rclone copy`, preserving the subfolder structure.
4. Skips files that are already up-to-date (same size and modification time).
5. Retries automatically on transient network errors.
6. Prints a summary of all files in `data/` with their sizes when complete.

### Using a different remote name

If your rclone Google Drive remote is not called `gdrive`, set the `RCLONE_REMOTE` environment variable:

```bash
RCLONE_REMOTE=my-drive ./scripts/fetch-data.sh 1ABCdef_ghiJKLmnopQRSTuvwXYZ
```

### Full workflow

```bash
# 1. Download the CSV source files from Google Drive
make fetch-data FOLDER=1ABCdef_ghiJKLmnopQRSTuvwXYZ

# 2. Build the GeoPackage datapack
make geopackage

# 3. Launch the application
make app
```

---

## Scenario Data (GeoPackage Datapack)

The application uses a GeoPackage file (`datapack.gpkg`) containing catchment geometries and scenario data. This is built from raw input files using the `scripts/build-geopackage.sh` script.

### Input Files

Place the following files in the `data/` directory:

#### Geometry

| File | Required | Description |
|------|----------|-------------|
| `catchments.gpkg` | **Yes** | GeoPackage containing catchment polygon geometries in a layer named `catchments_lev12`. Each feature must have a `HYBAS_ID` attribute that matches the `catchID` column in the scenario CSVs. |

#### Scenario CSVs

All scenario CSVs must have a `catchID` column that cross-references `HYBAS_ID` in `catchments.gpkg`. All other columns are per-catchment indicator values stored as `REAL` in the database (`NA` becomes `NULL`).

| File | Required | Description |
|------|----------|-------------|
| `current.csv` | **Yes** | Per-catchment indicator values for the **current** scenario. |
| `reference.csv` | **Yes** | Per-catchment indicator values for the **reference** (historical baseline) scenario. |
| `current_lower.csv` | **Yes** | Lower-bound uncertainty values for the current scenario. Displayed as the lower whisker in boxplot charts. |
| `current_upper.csv` | **Yes** | Upper-bound uncertainty values for the current scenario. Displayed as the upper whisker in boxplot charts. |
| `reference_lower.csv` | **Yes** | Lower-bound uncertainty values for the reference scenario. |
| `reference_upper.csv` | **Yes** | Upper-bound uncertainty values for the reference scenario. |

#### Metadata

| File | Required | Description |
|------|----------|-------------|
| `metadata.csv` | **Yes** | Human-readable labels, units, chart types, map colours, and user-input flags for each indicator column. Without it the app still runs but uses raw column names with no colour coding or chart type detection. See the [Datapack Format](datapack-format.md#metadatacsv-column-reference) page for a full column-by-column reference. |

#### Ecological Lookup Tables

These files support the cascading recalculation workflow triggered when a user adjusts a target indicator. All three are optional — if absent the application falls back to proportional scaling.

| File | Required | Description |
|------|----------|-------------|
| `NPP_by_treecover.csv` | **Yes** | Per-catchment net primary productivity (g/m²) indexed by `catchID`, with one column per tree-cover class bin (`X0_5` through `X80_100`). Used to recalculate NPP when the user adjusts tree-cover targets. |
| `deltaSOC_bytcc_Mgha.csv` | **Yes** | Per-catchment change in soil organic carbon (ΔSOCc, Mg/ha) by tree-cover class. Same structure as `NPP_by_treecover.csv`. Used to recalculate soil carbon when tree-cover proportions change. |
| `herb_traits_ready.csv` | **Yes** | Per-species herbivore trait table indexed by `Common_name`. Columns include `Body_mass`, `Diet`, `HFT_BII`, `Prop_Grass`, `DMI_kg_indiv_yr`, and `CH4_kg_indiv_yr`. Species names must match the suffixes used in the `herbs_sp_*` and `herbs_fg_*` indicator columns in the scenario CSVs. |

See the [Datapack Format](datapack-format.md#ecological-lookup-tables) page for the full column specifications of each lookup file.

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
