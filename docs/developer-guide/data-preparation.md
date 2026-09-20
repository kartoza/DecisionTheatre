# Application Data Preparation

This guide covers how to prepare the data files that Decision Theatre consumes.


<figure markdown>
  ![Source data flowing through to a distributable data pack](../assets/diagrams/generated/data-prep-pipeline.svg)
  <figcaption class="static">
    Validate before shipping: <code>nix run .#check-data</code>.
  </figcaption>
</figure>

## Vector Map Tiles (MBTiles)

!!! note "This is a separate pipeline from the datapack"
    `datasources/basemap/context_source_data.gpkg` and `datasources/catchments/catchments.gpkg` (see [Full workflow](#full-workflow)) are different source files, even though both once contained a layer named `catchments_lev12`. This pipeline produces the generalised, zoom-dependent geometry rendered as vector tiles (`data/mbtiles/context.mbtiles`); the datapack pipeline copies `catchments.gpkg` verbatim so the full-resolution polygons ship in `datapack.gpkg` (pruned — see [Scenario Data](#scenario-data-geopackage-datapack) below) and standalone as `data/catchments.gpkg`. Keep the two `catchments_lev12` sources in sync manually -- there is no automated check that they agree.

### Source Data

The map data comes from **three** GeoPackage files, all passed to the conversion script together:

`datasources/basemap/context_source_data.gpkg` (the former `UoW_layers.gpkg`, renamed and moved — "context" because the tileset covers whatever region the data pack does, not specifically Africa):

| Layer | Description |
|-------|-------------|
| `ne_african_countries` | Country boundaries from Natural Earth |
| `ne_10m_rivers` | Major river networks |
| `ne_10m_lakes` | Lake boundaries |
| `ecoregions` | Ecological region boundaries |
| `ne_10m_populated_places` | Cities and towns |
| `WDPA_Feb2026_Public` | Protected areas |
| `Africa_Roads_Primary-Tertiary` | Primary/tertiary road network |

`datasources/catchments/catchments.gpkg`:

| Layer | Description |
|-------|-------------|
| `catchments_lev12` | Level-12 catchment boundaries |

`datasources/catchments/catchments-levels.gpkg` (built by `scripts/build-catchment-hierarchy.sh` — see [Multi-Resolution Catchments](#multi-resolution-catchments) below):

| Layer | Description |
|-------|-------------|
| `catchments_lev04` | Level-4 basin boundaries (189 in the current study area) |
| `catchments_lev06` | Level-6 basin boundaries (2,442) |
| `catchments_lev08` | Level-8 basin boundaries (27,448) |

`catchments_lev12` was dropped from `context_source_data.gpkg` at some point during the rename/update (the file gained `WDPA_Feb2026_Public` and `Africa_Roads_Primary-Tertiary` but lost the catchments layer). Rather than re-merging it back into a single file by hand, the script accepts multiple input GeoPackages and pulls each layer from whichever one has it.

### Conversion Pipeline

The script `scripts/gpkg_to_mbtiles.sh` automates the full conversion. Pass every source file that contributes layers, run from the project root:

```bash
./scripts/gpkg_to_mbtiles.sh \
  datasources/basemap/context_source_data.gpkg \
  datasources/catchments/catchments.gpkg \
  datasources/catchments/catchments-levels.gpkg
```

`make mbtiles` (or `dt mbtiles`) runs this with those three sources by default — pass `ARGS="file1.gpkg file2.gpkg"` to override.

If the same layer name exists in more than one input, the earliest file on the command line wins and the rest are skipped with a warning -- so list files in priority order.

The script stages output in `.cache/` during processing, then moves the final `context.mbtiles` to `data/mbtiles/` on completion.

**Pipeline stages:**

1. **Layer discovery** -- queries `gpkg_contents` for all feature layers, across every input file given
2. **Load/edit per-layer treatment** -- see below
3. **Geometry validation** -- checks for NULL geometries; optionally repairs with `ogr2ogr -makevalid` (only the source file(s) that need it)
4. **GeoJSONSeq export** -- converts each layer to newline-delimited GeoJSON using `ogr2ogr`
5. **Per-layer tile generation** -- runs `tippecanoe` for each layer according to its treatment, tiling the generalised and unsimplified bands separately and `tile-join`-ing them back together where a layer has both
6. **Merge** -- combines all per-layer MBTiles into a single file using `tile-join`

### Per-Layer Treatment

How each layer is generalised is configured in `datasources/mbtiles-config/layer-treatment.csv`, not hardcoded in the script. Every layer has four zoom bands, in order:

| Band | Treatment |
|---|---|
| below `minzoom` | hidden -- no tiles |
| `minzoom` … `simplified_end` | generalised -- `tolerance`/`visvalingam`/`preserve_shared_nodes`/`merge_tiny_polygons` (below) apply |
| `simplified_end+1` … `maxzoom` | unsimplified -- full detail, no line simplification at all |
| above `maxzoom` | hidden -- no tiles |

Columns:

| Column | Meaning |
|---|---|
| `layer` | must match a source-layer name discovered from the input GeoPackages |
| `minzoom` / `maxzoom` | overall visible zoom range |
| `simplified_end` | last zoom in the generalised band (ignored if `generalise=false`) |
| `generalise` | `false` skips the generalised band entirely -- the whole `minzoom..maxzoom` range is built at full detail. Use this for a layer you never want simplified |
| `visvalingam` | Visvalingam's area-based simplification instead of tippecanoe's default Douglas-Peucker; tends to preserve overall shape better at heavy generalisation |
| `tolerance` | tippecanoe's `--simplification` scale for the generalised band (~10 is heavy, ~1 is close to none) |
| `preserve_shared_nodes` | keeps neighbouring polygons edge-matched as they generalise (`--no-simplification-of-shared-nodes`) -- this, not the algorithm choice, is what stops adjacent catchments drifting apart into slivers/gaps at low zoom |
| `merge_tiny_polygons` | `false` (the default) keeps small polygons separate rather than coalescing them into representative squares at low zoom (`--no-tiny-polygon-reduction`) |
| `tileset` | blank merges the layer into the combined `context.mbtiles` (the default); a name (e.g. `catchments`) ships it as its own standalone `data/mbtiles/<name>.mbtiles` instead -- see "Standalone Tilesets and Overzoom" below |

**A layer found in the source GeoPackages but missing from the table is appended with defaults** (`6,14,15,true,true,10,true,false,` -- merged into the combined tileset) the moment the build runs, so the table stays a complete, accurate list of what's actually being tiled -- you never have to remember to add a row for a new layer by hand.

Before every interactive build, the table opens as a real spreadsheet in LibreOffice Calc and the build waits for you to save and close the window -- proper columns and a familiar UI beat hand-aligning commas in a text editor. It round-trips through `.ods` only for the edit session; the tracked file stays plain CSV (`soffice --headless --convert-to ods/csv`, done under a private `-env:UserInstallation` profile so it can't collide with an already-running LibreOffice session on your desktop). Falls back to `$VISUAL`/`$EDITOR`/`nano` if LibreOffice isn't on `PATH`. Pass `--no-edit`, or run non-interactively (no tty -- e.g. CI, or `dt mbtiles-server`'s own auto-build path), to skip straight to building with whatever the table already says.

Waiting for "closed" is done by polling for Calc's own `.~lock.layer-treatment.ods#` file next to the document rather than trusting the process to block, which it doesn't reliably do when another LibreOffice window is already open under the same profile.

Two tippecanoe invocations happen per layer only when a layer genuinely has both a generalised and an unsimplified band (`minzoom <= simplified_end < maxzoom`) -- tippecanoe has no single-invocation way to change tolerance partway through a zoom range, so each band is tiled separately and `tile-join`ed back into one per-layer file before the final merge. `tile-join` prints `Warning: mismatched maxzooms: ... vs previous ...` when it does this -- expected, since the two fragments genuinely do have different max/minzoom by design, not a sign anything went wrong.

### Standalone Tilesets and Overzoom

Once a layer's geometry is fully unsimplified at some zoom, tiling it *again* at every deeper zoom adds nothing: the vertices are already all there, and MapLibre GL already knows how to reuse a source's deepest real tile and scale it up for any zoom past the source's declared `maxzoom` ("overzoom"). Tiling several more identical-fidelity zoom levels just burns build time and disk for tiles that show nothing a client-side overzoom of the shallower one wouldn't.

The catch: MapLibre's overzoom is a property of a vector *source* (one TileJSON, one declared `maxzoom`), not of an individual layer bundled inside a combined tileset. The `context.mbtiles` tileset bundles all the basemap layers together behind one TileJSON, so its single `maxzoom` (15) applies to every layer in it -- there's no way to tell MapLibre "stop asking for real tiles of *this one layer* at z12 but keep asking for the others up to z15" while they all share that one TileJSON.

That's what the `tileset` column is for. `catchments_lev04`, `catchments_lev06`, `catchments_lev08` and `catchments_lev12` all ship in `data/mbtiles/catchments.mbtiles`, with its own TileJSON declaring `maxzoom: 12` (`internal/server/server.go`'s `handleCatchmentsTileJSON`) -- their treatment rows are zoom-gated to non-overlapping bands (z2-5, z6-8, z9-10, z11-24 respectively; see [Multi-Resolution Catchments](#multi-resolution-catchments)) rather than each spanning the same full range. MapLibre requests real tiles up to whichever level is current and overzooms beyond that entirely on its own; the app can still navigate to z15 as usual. The frontend's `fetchCatchmentTileset` (`frontend/src/lib/choroplethTiles.ts`) fetches this tileset's own TileJSON at `/data/catchments-tiles.json` rather than the combined one.

Splitting a layer out this way touches more than the treatment table -- it needs a matching TileJSON handler in `internal/server/server.go`, a source in `style.json` pointing at that handler's URL, and (to avoid `dt check-data` flagging it as dead weight) an entry in `internal/datacheck/spec.go`. Reach for `tileset` only when a layer's own top zoom is meaningfully lower than the rest of the bundle's, the way catchments' is now.

## Multi-Resolution Catchments

147,837 lev12 catchment polygons don't need to render at z3. `scripts/build-catchment-hierarchy.sh` builds three coarser HydroBASINS levels — real drainage-basin boundaries, not an arbitrary grid — plus scenario data aggregated up to each one, so both the `catchments.mbtiles` tileset above and the live choropleth (`internal/geodata/gpkg_store.go`'s `QueryCatchments`) can render something proportionate to the zoom level.

<figure markdown>
  ![HydroBASINS levels feed a lev12-to-parent crosswalk, aggregated scenario tables, and the zoom-gated choropleth query](../assets/diagrams/generated/multires-catchments.svg)
  <figcaption class="static">
    GOLDEN RULE: site analysis and catchment selection always read lev12. These tables exist only for this rendering path.
  </figcaption>
</figure>

### Source

```bash
dt fetch-hydrobasins          # or: make fetch-hydrobasins
```

Downloads `hybas_af_lev01-12_v1c.zip` from [HydroSHEDS](https://www.hydrosheds.org/products/hydrobasins) into `datasources/catchments/hybas_af_lev01-12_v1c/` — one shapefile per level, 01 through 12. Skips the download if already present; pass `ARGS="--force"` to re-fetch, or `ARGS="<region>"` for a region other than Africa. By downloading you agree to HydroSHEDS's license terms (see their Technical Documentation) — the script cannot accept that on your behalf.

### The crosswalk

HydroBASINS' Pfafstetter codes (`PFAF_ID`) are hierarchical by construction: a lev12 catchment's parent at lev08 has a `PFAF_ID` that is exactly the first 8 digits of the lev12 catchment's own `PFAF_ID` (lev06: first 6; lev04: first 4). This was verified against all 147,837 catchments in the current study area with zero unmatched rows — exact string-prefix matching, no spatial join needed. `catchments.gpkg` itself doesn't carry `PFAF_ID` (it was dropped when the study-area subset was clipped from the continental HydroBASINS set), so `PFAF_ID` is read fresh from the lev12 shapefile and joined back in by `HYBAS_ID`.

### Building it

```bash
dt geopackage              # datapack.gpkg must exist first
dt fetch-hydrobasins
dt catchment-hierarchy     # or: make catchment-hierarchy
```

`scripts/build-catchment-hierarchy.sh` adds to `data/datapack.gpkg`:

| Table | Contents |
|-------|----------|
| `catchment_hierarchy` | lev12 `HYBAS_ID_int` → lev04/06/08 parent `HYBAS_ID_int` |
| `catchments_lev04` / `_lev06` / `_lev08` | `HYBAS_ID_int`, `HYBAS_ID`, `geojson` — no raw `geom`, no rtree (a few hundred to tens of thousands of rows isn't worth indexing) |
| `scenario_current_lev04/06/08`, `scenario_reference_lev04/06/08` | Every `scenario_current`/`scenario_reference` column, `SUB_AREA`-weighted mean grouped by parent — the same NULL-safe weighted-average formula `internal/geodata/gpkg_store.go` already uses for site summaries. Point estimates only; whisker bounds are not aggregated. |

It also (re)writes `datasources/catchments/catchments-levels.gpkg` — proper OGR-readable geometry (not the `geojson`-text tables above), for `gpkg_to_mbtiles.sh` to tile. Filtered in Python rather than an `ogr2ogr -where "HYBAS_ID IN (...)"`, because that list is tens of thousands of ids long and blows past the OS argument-length limit.

All of this is additive — analysis and site selection keep reading `scenario_current`/`scenario_reference`/`catchments_lev12` exactly as before. A datapack built before this step, or where it hasn't been run, simply lacks the tables; `QueryCatchments` checks for them once at startup and falls back to its pre-existing grid-aggregated choropleth if they're absent.

### Zoom tiers

| Level | Zoom band | Basins (current study area) |
|-------|-----------|------|
| lev04 | z2–z5 | 189 |
| lev06 | z6–z8 | 2,442 |
| lev08 | z9–z10 | 27,448 |
| lev12 | z11+ | 147,837 |

The same bands drive both `datasources/mbtiles-config/layer-treatment.csv`'s four `catchments_levNN` rows and `internal/geodata/gpkg_store.go`'s `basinLevelForZoom` — kept in sync by `TestBasinLevelForZoomMatchesTilesetZoomBands` (`internal/geodata/basin_levels_test.go`), which is the reminder to update both if either changes.

### Required Tools

- `ogr2ogr` (GDAL)
- `tippecanoe`
- `sqlite3`

All are available in the Nix dev shell (`nix develop`).

### Map Style

The MapBox GL Style JSON at `data/mbtiles/style.json` defines how each layer is rendered (colours, line widths, label placement). Edit this file to change the map's visual appearance. `datasources/mbtiles-config/style.json` is the source copy edited during map-tile development.

### Browsing the Tiles (Testbed)

```bash
dt mbtiles-server
```

Serves `data/mbtiles/context.mbtiles` through [`mbtileserver`](https://github.com/consbio/mbtileserver) and a MapLibre GL preview page styled with `datasources/mbtiles-config/style.json`, so you can pan/zoom the actual tileset with the real style and toggle individual layers on/off. If the tiles don't exist yet, it prompts to run `dt mbtiles` first (or pass `--yes` to build them automatically).

Open the printed URL (`http://localhost:7900` by default; override with `--port`) in a browser. Ctrl+C stops both the tile server and the preview.

Implementation note: `mbtileserver` sends no CORS headers, so the preview page and the tile service are served from one origin via `scripts/mbtiles_proxy.py`, a small reverse proxy in front of `mbtileserver`. This also relies on `mbtileserver` naming the tileset `context` (from the required `context.mbtiles` filename) to route `/services/context`.

**Watching a build in progress:** `gpkg_to_mbtiles.sh` writes each layer's MBTiles to `.cache/mbtiles-layers/<layer>.mbtiles` as soon as that layer finishes tiling (printing a `preview with: dt mbtiles-server --layer <layer>` hint), well before the full merge into `context.mbtiles` completes. Run

```bash
dt mbtiles-server --layer catchments_lev12
```

in a second terminal while `dt mbtiles` is still running elsewhere to inspect one layer as soon as it's ready, styled the same way (style rules for other source-layers simply don't draw against a single-layer tileset).

### Checking What's Actually In a Tileset

```bash
dt mbtiles-check                          # data/mbtiles/context.mbtiles
dt mbtiles-check --layer catchments_lev12 # .cache/mbtiles-layers/catchments_lev12.mbtiles
```

Reads the tippecanoe/tile-join metadata to list every layer with its zoom range and attribute fields, then spot-checks each layer by decoding a handful of randomly sampled real tiles at that layer's own minzoom and confirming the layer actually shows up with features -- metadata can claim a layer exists even if it ended up empty. `--samples N` controls how many tiles are sampled per layer (default 10); exits non-zero if any layer isn't confirmed.

Tile content is decoded by `scripts/mvt_layers.py`, a small hand-rolled MVT/protobuf reader, rather than `tippecanoe-decode`: that tool looks for a literal `tiles` table and silently returns nothing against the deduplicated `map`+`images` schema that `tile-join` produces (`tiles` there is a view, not a table).

### Catchment Outlines Style

`datasources/mbtiles-config/style-catchments-outline.json` extends `style.json` with one added layer -- a red outline drawn from `catchments_lev12`, on top of the fills but below roads/rivers/labels -- for checking catchment boundaries (e.g. edge-matching between neighbours after generalisation) without switching away from the real style. Regenerate it after editing `style.json` rather than hand-maintaining a second copy:

```bash
jq '
  .name = "UoW Tiles + Catchment Outlines" |
  .layers = (
    .layers[0:20] +
    [{
      "id": "Catchment Outlines", "type": "line", "source": "UoW Tiles",
      "source-layer": "catchments_lev12", "minzoom": 8,
      "layout": {"visibility": "visible", "line-join": "round"},
      "paint": {"line-color": "rgba(230, 60, 60, 1)", "line-width": {"stops": [[8, 0.5], [12, 1], [15, 1.5]]}}
    }] +
    .layers[20:]
  )
' datasources/mbtiles-config/style.json > datasources/mbtiles-config/style-catchments-outline.json
```

(the `20` is the index of the last Protected Areas layer as of this writing -- check with `jq -r '.layers[] | .id' datasources/mbtiles-config/style.json` if `style.json`'s layer order has changed.) View it with:

```bash
dt mbtiles-server --style datasources/mbtiles-config/style-catchments-outline.json
```

## Fetching Data from Google Drive

The script `scripts/fetch-data.sh` downloads all files from a shared Google Drive folder (including subfolders) directly into the `data/` directory, preserving the folder structure. Run this before `dt geopackage` to pull the latest source files in one step.

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
dt fetch-data FOLDER=<folder-id-or-url>

# Or directly
./scripts/fetch-data.sh <folder-id-or-url> [data-dir]
```

Both a bare folder ID and a full URL are accepted:

```bash
# Bare folder ID
dt fetch-data FOLDER=1ABCdef_ghiJKLmnopQRSTuvwXYZ

# Full shareable URL
dt fetch-data FOLDER="https://drive.google.com/drive/folders/1ABCdef_ghiJKLmnopQRSTuvwXYZ"

# Custom destination directory
./scripts/fetch-data.sh 1ABCdef_ghiJKLmnopQRSTuvwXYZ /path/to/data
```

### What the script does

1. Extracts the folder ID from the argument (whether a bare ID or URL).
2. Checks that rclone is installed and the `gdrive` remote exists.
3. Copies all files from the Drive folder and any subfolders into `data/` using `rclone copy`, preserving the subfolder structure -- the Drive folder mirrors the old flat layout, mixing shipped content with build inputs.
4. Skips files that are already up-to-date (same size and modification time).
5. Retries automatically on transient network errors.
6. Moves the build inputs it's likely to contain (`catchments.gpkg`, the scenario CSVs, `R scripts/`) out of `data/` into `datasources/`, so a re-run of this script can't undo the `data/` vs `datasources/` separation. Anything not matched here is shipped content and stays put.
7. Prints a summary of all files in `data/` with their sizes when complete.

### Using a different remote name

If your rclone Google Drive remote is not called `gdrive`, set the `RCLONE_REMOTE` environment variable:

```bash
RCLONE_REMOTE=my-drive ./scripts/fetch-data.sh 1ABCdef_ghiJKLmnopQRSTuvwXYZ
```

### Full workflow

```bash
# 1. Download the CSV source files from Google Drive
dt fetch-data FOLDER=1ABCdef_ghiJKLmnopQRSTuvwXYZ

# 2. Build the GeoPackage datapack
dt geopackage

# 3. Optional: multi-resolution catchments for the low/mid-zoom choropleth
dt fetch-hydrobasins
dt catchment-hierarchy

# 4. Launch the application
dt app
```

---

## Scenario Data (GeoPackage Datapack)

The application uses a GeoPackage file (`datapack.gpkg`) containing catchment geometries and scenario data. This is built from raw input files using the `scripts/build-geopackage.sh` script.

### Input Files

Place the following files in `datasources/` (not `data/` -- `data/` is exactly what a data pack ships, and none of these are read at runtime):

#### Geometry

| File | Required | Description |
|------|----------|-------------|
| `datasources/catchments/catchments.gpkg` | **Yes** | GeoPackage containing catchment polygon geometries in a layer named `catchments_lev12`. Each feature must have a `HYBAS_ID` attribute that matches the `catchID` column in the scenario CSVs. Also copied verbatim to `data/catchments.gpkg` -- shipped in the pack for standalone GIS use, since `datapack.gpkg`'s own copy is pruned (see below). |

#### Scenario CSVs

All scenario CSVs must have a `catchID` column that cross-references `HYBAS_ID` in `catchments.gpkg`. All other columns are per-catchment indicator values stored as `REAL` in the database (`NA` becomes `NULL`).

| File | Required | Description |
|------|----------|-------------|
| `datasources/scenarios/current.csv` | **Yes** | Per-catchment indicator values for the **current** scenario. |
| `datasources/scenarios/reference.csv` | **Yes** | Per-catchment indicator values for the **reference** (historical baseline) scenario. |
| `datasources/scenarios/current_lower.csv` | **Yes** | Lower-bound uncertainty values for the current scenario. Displayed as the lower whisker in boxplot charts. |
| `datasources/scenarios/current_upper.csv` | **Yes** | Upper-bound uncertainty values for the current scenario. Displayed as the upper whisker in boxplot charts. |
| `datasources/scenarios/reference_lower.csv` | **Yes** | Lower-bound uncertainty values for the reference scenario. |
| `datasources/scenarios/reference_upper.csv` | **Yes** | Upper-bound uncertainty values for the reference scenario. |

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
dt geopackage

# Or directly
./scripts/build-geopackage.sh ./data ./datasources
```

This script performs the following steps:

1. **Standalone copy** — Copies `datasources/catchments/catchments.gpkg` to `data/catchments.gpkg`, unmodified, for standalone GIS use
2. **Base setup** — Copies the same source as the base for `datapack.gpkg`
3. **CSV import** — Imports scenario CSVs as raw tables using `ogr2ogr`
4. **Type conversion** — Converts data columns to REAL type, converting `NA` strings to NULL
5. **Column normalization** — Normalizes column names across tables (replaces dashes, spaces with dots)
6. **Indexing** — Creates integer indexes on catchment IDs for fast joins
7. **GeoJSON precomputation** — Converts geometries to GeoJSON for fast API serving
8. **Domain min/max** — Computes global min/max for each attribute across both scenarios
9. **Pruning** — Drops `catchments_lev12`'s raw `geom` column and nine unused static covariates (`MAR`, `MAT`, `ecorgns`, `Elev_m`, `SandPerc`, `pH`, `TRI`, `propTrans`, `propRef`, `propFor`) — nothing in `internal/geodata/gpkg_store.go` reads them; every geometry read goes through the precomputed `geojson`/`geojson_simplified` columns instead, and they live on in `data/catchments.gpkg` from step 1. ~191 MB saved on the reference datapack; `VACUUM` reclaims the space.

### Output GeoPackage Schema

The output `datapack.gpkg` contains these tables (plus the [multi-resolution catchment tables](#multi-resolution-catchments) if `dt catchment-hierarchy` has been run):

| Table | Description |
|-------|-------------|
| `catchments_lev12` | `HYBAS_ID`, `SUB_AREA`, `lat`, `long`, and precomputed `geojson`/`geojson_simplified` — no raw `geom` or the nine static covariates, pruned in step 9 above (they live on in `data/catchments.gpkg`) |
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
