# The Data Directory

Decision Theatre reads all of its content from a **data directory**, passed with
`--data-dir` and defaulting to `./data`. This page describes exactly what the application
looks for there, cross-referenced to the code that reads it, so an administrator can tell
what is required, what is optional, and what does not belong.

Every path below was verified against the Go source. Where a filename is hardcoded, that
is stated — those files cannot be renamed.

!!! tip "Check before you run"
    Rather than working through this page by hand, run the validator:

    ```bash
    nix run .#check-data          # or: dt check-data
    ```

    See [Validating the Data Directory](validating-data.md).

## Required for the application to work

<figure markdown>
  ![Every path the application dereferences inside the data directory, grouped by whether it is required, written at runtime, or optional](../assets/diagrams/generated/data-requirements.svg)
  <figcaption class="gen">
    extracted from every
    <code>filepath.Join(dataDir, …)</code> in the Go source, so this cannot fall behind
    the code that reads these files.
  </figcaption>
</figure>

| Path | Read by | Notes |
|---|---|---|
| `datapack.gpkg` | `internal/geodata/gpkg_store.go` | **Filename is hardcoded.** No other name is discovered. |
| `mbtiles/context.mbtiles` | `internal/tiles/mbtiles.go` | **Must be named `context`** — see the warning below. |
| `mbtiles/catchments.mbtiles` | `internal/tiles/mbtiles.go` | Optional. If present, must be named `catchments` — see the warning below. |
| `mbtiles/style.json` | `internal/server/server.go` | Required — see the note below. |
| `metadata.csv` | `internal/api/metadata_cache.go` | Indicator display metadata. |
| `NPP_by_treecover.csv` | `internal/api/lookups.go` | Needs a `catchID` column. |
| `deltaSOC_bytcc_Mgha.csv` | `internal/api/lookups.go` | Needs a `catchID` column. |
| `herb_traits_ready.csv` | `internal/api/lookups.go` | Herbivore trait lookup. |

Also shipped, but **never opened by the running server** — see [Shipped but not read](#shipped-but-not-read) below:

| Path | Notes |
|---|---|
| `catchments.gpkg` | Standalone catchment geometry + covariates, for GIS tools (QGIS, GDAL). `datapack.gpkg`'s own copy is pruned to just what the server reads. |

!!! warning "The style belongs to the data pack, not the application"
    The server currently falls back to `<resources-dir>/mbtiles/style.json` when the data
    directory has no style. **Do not rely on this** — it is being removed.

    The style is dataset-specific: its layers name the source-layers of one particular
    tileset (`ne_african_countries`, `ecoregions`, `WDPA_Feb2026_Public` and others).
    Falling back therefore substitutes a different dataset's cartography for the one you
    installed; against a tileset with different layer names every layer resolves to
    nothing and the map renders blank, with no error logged.

    Treat `mbtiles/style.json` as required. A data pack without one is incomplete.

    Ticket: *Remove the --resources-dir flag and the style.json fallback*.

!!! danger "Tileset names are hardcoded: `context` (required) and `catchments` (optional)"
    The tileset name is derived from the filename with `.mbtiles` stripped
    (`mbtiles.go`: `strings.TrimSuffix(entry.Name(), ".mbtiles")`). `internal/server/server.go`
    hardcodes both names: `context` in `WarmCache` and `handleTileJSON`, `catchments` in the
    second `WarmCache` call and `handleCatchmentsTileJSON` — and `/data/tiles.json` /
    `/data/catchments-tiles.json` advertise `/tiles/context/{z}/{x}/{y}.pbf` and
    `/tiles/catchments/{z}/{x}/{y}.pbf` respectively. `internal/datacheck/spec.go`'s
    `RequiredTilesetName`/`OptionalTilesetName` constants, and a test that pins each to a
    literal string still present in `server.go`, keep this from silently drifting.

    A file named `context-002.mbtiles` therefore registers a tileset called `context-002`
    that nothing ever requests, and **the map renders blank**. Rename it:

    ```bash
    mv data/mbtiles/context-002.mbtiles data/mbtiles/context.mbtiles
    ```

    `catchments.mbtiles` is optional: `scripts/gpkg_to_mbtiles.sh` ships
    `catchments_lev04`/`_lev06`/`_lev08`/`_lev12` as their own tileset (rather than folded
    into `context.mbtiles`), zoom-gated to non-overlapping bands so `catchments_lev12` can
    stop tiling once fully unsimplified and let MapLibre overzoom the rest — one TileJSON's
    maxzoom applies to every layer bundled into it, so a layer that wants to do this can't
    share a tileset with layers that tile deeper. Its absence is not an error: the
    choropleth's `fetchCatchmentTileset` falls back to its GeoJSON path.

    Tile files are searched for in both `data/` and `data/mbtiles/`.

### GeoPackage structure

`datapack.gpkg` must contain:

| Object | Purpose |
|---|---|
| `catchments_lev12` | Catchment geometry (as precomputed `geojson`/`geojson_simplified`, not a raw `geom` column — see below), with `HYBAS_ID` and `HYBAS_ID_int` columns |
| `scenario_current` | Current-scenario attribute values, joined on `catchment_id_int` |
| `scenario_reference` | Reference-scenario attribute values |
| `rtree_catchments_lev12_geom` | Spatial index; without it, viewport queries degrade to full scans |

Optional, enabling whisker bounds in charts:
`scenario_current_lower`, `scenario_current_upper`,
`scenario_reference_lower`, `scenario_reference_upper`.

!!! note "`catchments_lev12` has no raw `geom` column"
    `scripts/build-geopackage.sh` prunes it: nothing in `internal/geodata/gpkg_store.go`
    reads it directly, every geometry read goes through the precomputed `geojson` columns
    instead. The full geometry, plus columns pruned here for the same reason (`MAR`, `MAT`,
    `ecorgns`, `Elev_m`, `SandPerc`, `pH`, `TRI`, `propTrans`, `propRef`, `propFor`), lives
    on in the standalone `catchments.gpkg` shipped alongside `datapack.gpkg` — see
    [Shipped but not read](#shipped-but-not-read).

### Shipped but not read

`catchments.gpkg` ships in the data pack but the running server never opens it —
`internal/datacheck/spec.go` classifies it `RoleDataPackExtra` rather than `RoleRuntime` to
make that distinction explicit in `check-data`'s report. It exists for loading directly into
QGIS, GDAL or another GIS tool without the multi-gigabyte `datapack.gpkg`: full-resolution
catchment geometry plus the static covariates pruned from `datapack.gpkg`'s own copy. Its
absence is not an error — the application works without it — but `pack-data` includes it
whenever it is present in `data/`.

### Multi-resolution catchment tables (optional)

If `scripts/build-catchment-hierarchy.sh` has been run, `datapack.gpkg` also contains
`catchment_hierarchy`, `catchments_lev04`/`_lev06`/`_lev08`, and
`scenario_current`/`scenario_reference` aggregated to each of those levels
(`scenario_current_lev04`, and so on). These back the low/mid-zoom choropleth
(`internal/geodata/gpkg_store.go`'s `QueryCatchments`) — **never analysis or site
selection**, which always read `catchments_lev12`/`scenario_current`/`scenario_reference`
regardless of whether these tables exist. A datapack without them simply renders the
low-zoom choropleth with the older grid-aggregation fallback instead. See
[Data Preparation → Multi-Resolution Catchments](../developer-guide/data-preparation.md#multi-resolution-catchments).

### `metadata.csv` and column-name matching

`metadata.csv` is keyed on **`ColumnName`**, and the lookup is an exact string match
against the column names in the GeoPackage scenario tables. A row whose `ColumnName` does
not match a real column is silently ignored, and the corresponding indicator will:

- render with its raw column name,
- have no colour, units or axis label,
- have no chart-type detection, and
- **not appear in the map or chart selectors at all**, because the `MapthisYN` and
  `graphthisYN` lookups miss.

!!! danger "Watch for dots where the data has spaces"
    If `metadata.csv` is exported from R without care, `make.names()` rewrites spaces to
    dots — so the CSV says `Obligate.grazer` where the GeoPackage says `Obligate grazer`.
    The names look correct to a human and match nothing at runtime.

    This is not hypothetical: in the data directory as currently supplied, **344 of 503
    metadata rows fail to match for exactly this reason**, and only 159 resolve. The
    validator detects and reports this case specifically.

    When exporting from R, read with `check.names = FALSE` and write with
    `write.csv(x, "metadata.csv", row.names = FALSE)`.

For the full column-by-column reference, see
[Datapack Format](../developer-guide/datapack-format.md#metadatacsv-column-reference).

## Runtime directories

These are written to while the application runs. They are created on demand, but their
parent must be writable.

| Path | Purpose |
|---|---|
| `sites/` | Site JSON files (desktop runtime only; the browser runtime uses local storage) |
| `images/` | Site thumbnails, served at `/data/images/` |

## Optional content

| Path | Purpose |
|---|---|
| `walkthroughs/*.json` | Read-only demo sites backing the guided tours, served at `/data/walkthroughs/` |
| `demo/` | Assets used by the tours, e.g. `Munywana_dissolved_fixed.zip` |

Each walkthrough file's name must equal the `id` field inside it, and both must match an
entry in `frontend/src/constants/walkthroughSites.ts`. All three are checked by the
validator.

## Data pipeline inputs live in `datasources/`, not here

Build inputs — the source catchment geometry, the scenario CSVs, the basemap source
GeoPackage, the HydroBASINS download, the R analysis pipeline — live in a sibling directory,
`datasources/`, not in the data directory this page describes. `scripts/build-geopackage.sh`
and `scripts/build-catchment-hierarchy.sh` read from there and write into `data/`.

This split is deliberate: the data directory is exactly what a data pack ships, and none of
these are read at runtime. If one turns up inside `data/` anyway — a stray `current.csv`,
say — `check-data` reports it as extraneous, not as a recognized build input; it doesn't
belong there any more. See [Data Preparation](../developer-guide/data-preparation.md) for
what lives in `datasources/` and how it feeds the pipeline.

## What should not be in the data directory

The validator reports these as warnings. None of them break the application; they inflate
the directory and confuse its purpose.

| Path | Why it does not belong |
|---|---|
| `R scripts/` (or any source code) | Analysis pipeline source belongs in `datasources/r-analysis/`, under version control — not in a directory that is deliberately untracked and shipped to users. |
| `current.csv`, `catchments.gpkg`, or other build inputs | These belong in `datasources/`, not `data/` — see [Data pipeline inputs](#data-pipeline-inputs-live-in-datasources-not-here) above. |
| `mbtiles/*.json` other than `style.json` | Stray style/descriptor files. The server only ever reads `mbtiles/style.json`. |
| `data-old/`, `old_data/`, or similar | Superseded data. Remove rather than ship. |

!!! note "Why this matters"
    The data directory is untracked by design and is distributed to users as a data pack.
    Anything placed here is shipped, is not under review, and has no history. Source code
    and working files kept here are invisible to CI, to code review and to `git log`.

## Directory layout at a glance

```
data/                               # the data pack — exactly what pack-data zips
├── datapack.gpkg                  # REQUIRED — hardcoded filename, pruned to what the server reads
├── catchments.gpkg                # shipped, never read — full geometry + covariates for GIS use
├── metadata.csv                   # REQUIRED — indicator metadata, keyed on ColumnName
├── NPP_by_treecover.csv           # REQUIRED — lookup, needs catchID
├── deltaSOC_bytcc_Mgha.csv        # REQUIRED — lookup, needs catchID
├── herb_traits_ready.csv          # REQUIRED — herbivore traits
├── mbtiles/
│   ├── context.mbtiles            # REQUIRED — must be named "context"
│   ├── catchments.mbtiles         # optional — must be named "catchments" if present
│   └── style.json                 # map style, served via /data/style.json
├── sites/                         # runtime: site JSON (desktop runtime)
├── images/                        # runtime: site thumbnails
├── walkthroughs/*.json            # optional: demo sites for the guided tours
└── demo/                          # optional: tour assets

datasources/                        # pipeline inputs — never shipped, not part of the data pack
├── catchments/
│   ├── catchments.gpkg             # source catchment geometry
│   └── hybas_af_lev01-12_v1c/      # HydroBASINS download (dt fetch-hydrobasins)
├── scenarios/*.csv                 # current/reference values and bounds
├── basemap/context_source_data.gpkg
├── mbtiles-config/                 # layer-treatment.csv, style.json
├── r-analysis/                     # the R ecological model — source code, not data
└── qgis/                           # DecisionTheatre.qgz
```

## Related

- [Validating the Data Directory](validating-data.md) — the automated checks
- [Data Setup](../advanced/install-a-data-pack.md) — installing a data pack as an end user
- [Data Preparation](../developer-guide/data-preparation.md) — building a data pack
- [Datapack Format](../developer-guide/datapack-format.md) — the distributable archive format
