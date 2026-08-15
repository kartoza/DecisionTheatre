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
    nix run .#validate-data          # or: make validate-data
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
| `mbtiles/africa.mbtiles` | `internal/tiles/mbtiles.go` | **Must be named `africa`** — see the warning below. |
| `mbtiles/style.json` | `internal/server/server.go` | Required — see the note below. |
| `metadata.csv` | `internal/api/metadata_cache.go` | Indicator display metadata. |
| `NPP_by_treecover.csv` | `internal/api/lookups.go` | Needs a `catchID` column. |
| `deltaSOC_bytcc_Mgha.csv` | `internal/api/lookups.go` | Needs a `catchID` column. |
| `herb_traits_ready.csv` | `internal/api/lookups.go` | Herbivore trait lookup. |

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

!!! danger "The tileset must be named `africa`"
    The tileset name is derived from the filename with `.mbtiles` stripped
    (`mbtiles.go`: `strings.TrimSuffix(entry.Name(), ".mbtiles")`). The server then
    hardcodes the name `africa` in three places — `WarmCache` (`server.go:117`),
    `handleTileJSON` (`server.go:383`) and `GetMetadata` (`server.go:394`) — and
    `/data/tiles.json` always advertises `/tiles/africa/{z}/{x}/{y}.pbf`.

    A file named `africa-002.mbtiles` therefore registers a tileset called `africa-002`
    that nothing ever requests, and **the map renders blank**. Rename it:

    ```bash
    mv data/mbtiles/africa-002.mbtiles data/mbtiles/africa.mbtiles
    ```

    Tile files are searched for in both `data/` and `data/mbtiles/`.

### GeoPackage structure

`datapack.gpkg` must contain:

| Object | Purpose |
|---|---|
| `catchments_lev12` | Catchment geometry, with `HYBAS_ID` and `HYBAS_ID_int` columns |
| `scenario_current` | Current-scenario attribute values, joined on `catchment_id_int` |
| `scenario_reference` | Reference-scenario attribute values |
| `rtree_catchments_lev12_geom` | Spatial index; without it, viewport queries degrade to full scans |

Optional, enabling whisker bounds in charts:
`scenario_current_lower`, `scenario_current_upper`,
`scenario_reference_lower`, `scenario_reference_upper`.

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

## Data pipeline inputs

These are consumed by `scripts/build-geopackage.sh` to produce `datapack.gpkg`. They are
**not read at runtime** and do not need to be shipped in a distributed data pack — they
account for roughly 2 GB.

| Path | Role |
|---|---|
| `catchments.gpkg` | Source catchment geometry |
| `current.csv`, `current_lower.csv`, `current_upper.csv` | Current-scenario values and bounds |
| `reference.csv`, `reference_lower.csv`, `reference_upper.csv` | Reference-scenario values and bounds |

Keeping them alongside the runtime data is reasonable on a workstation that rebuilds the
GeoPackage. Omit them when packaging for distribution — see
[Data Preparation](../developer-guide/data-preparation.md).

## What should not be in the data directory

The validator reports these as warnings. None of them break the application; they inflate
the directory and confuse its purpose.

| Path | Why it does not belong |
|---|---|
| `R scripts/` | Source code, not data. It belongs in version control alongside the rest of the analysis code, not in a directory that is deliberately untracked and shipped to users. |
| `R scripts/.Rhistory` | A personal R console history file. It records one developer's interactive session and should simply be deleted. |
| `R scripts/OldFiles/` | Superseded scripts. Version control is the place for history. |
| `R scripts/GrazingIntensity_calcs/Screenshot ….jpg` | A screenshot committed alongside calculation inputs. |
| `mbtiles/uow_tiles.json` | Legacy tile descriptor. The server only ever reads `mbtiles/style.json`. |
| `mbtiles/style-catchments-cropped.json` | An alternate style that nothing loads. Keep it only if it is being actively worked on. |
| `old_data/` | Superseded data. Remove rather than ship. |

!!! note "Why this matters"
    The data directory is untracked by design and is distributed to users as a data pack.
    Anything placed here is shipped, is not under review, and has no history. Source code
    and working files kept here are invisible to CI, to code review and to `git log`.

## Directory layout at a glance

```
data/
├── datapack.gpkg                  # REQUIRED — hardcoded filename
├── metadata.csv                   # REQUIRED — indicator metadata, keyed on ColumnName
├── NPP_by_treecover.csv           # REQUIRED — lookup, needs catchID
├── deltaSOC_bytcc_Mgha.csv        # REQUIRED — lookup, needs catchID
├── herb_traits_ready.csv          # REQUIRED — herbivore traits
├── mbtiles/
│   ├── africa.mbtiles             # REQUIRED — must be named "africa"
│   └── style.json                 # map style, served via /data/style.json
├── sites/                         # runtime: site JSON (desktop runtime)
├── images/                        # runtime: site thumbnails
├── walkthroughs/*.json            # optional: demo sites for the guided tours
├── demo/                          # optional: tour assets
│
├── catchments.gpkg                # pipeline input — not read at runtime
├── current*.csv                   # pipeline input — not read at runtime
├── reference*.csv                 # pipeline input — not read at runtime
│
└── R scripts/                     # DOES NOT BELONG — move to version control
```

## Related

- [Validating the Data Directory](validating-data.md) — the automated checks
- [Data Setup](../advanced/install-a-data-pack.md) — installing a data pack as an end user
- [Data Preparation](../developer-guide/data-preparation.md) — building a data pack
- [Datapack Format](../developer-guide/datapack-format.md) — the distributable archive format
