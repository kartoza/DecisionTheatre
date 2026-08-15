# Validating the Data Directory

`validate-data` checks a data directory against what the application actually reads, and
reports anything that would stop it working — or that is present but shouldn't be.

Run it after assembling a data pack, after receiving one from a colleague, and before
deploying to a server.

## Running it

=== "Nix"

    ```bash
    nix run .#validate-data              # validates ./data
    nix run .#validate-data -- /srv/dt/data
    ```

    The Nix app carries its own `sqlite3`, `python3` and coreutils, so it works on a
    machine with nothing else installed.

=== "Make"

    ```bash
    make validate-data
    make validate-data DATA_DIR=/srv/dt/data
    ```

=== "Directly"

    ```bash
    ./scripts/validate-data.sh
    ./scripts/validate-data.sh /srv/dt/data
    ```

    Requires `sqlite3` and `python3` on `PATH` — both are in the `nix develop` shell.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No errors. Warnings may still be present; the application should run. |
| `1` | One or more errors. The application will not work correctly against this directory. |
| `2` | The data directory does not exist, or a required tool is missing. |

This makes it usable as a deployment gate:

```bash
nix run .#validate-data -- /srv/dt/data || exit 1
```

## What it checks

<figure markdown>
  ![The groups of checks validate-data performs and its exit codes](../assets/diagrams/generated/validation-flow.svg)
  <figcaption class="static">
    Exit status makes the tool usable as a deployment gate.
  </figcaption>
</figure>


### GeoPackage

- `datapack.gpkg` exists and opens as SQLite
- `catchments_lev12`, `scenario_current` and `scenario_reference` tables are present
- the `rtree_catchments_lev12_geom` spatial index exists
- `catchments_lev12` is non-empty and has `HYBAS_ID` and `HYBAS_ID_int`
- `scenario_current.catchment_id_int` exists — the join key
- the optional `_lower` / `_upper` scenario tables are reported if missing

### Map tiles

- at least one `.mbtiles` file exists in `data/` or `data/mbtiles/`
- each is a readable MBTiles archive with a `tiles` table
- **a tileset named exactly `africa` exists.** This is the check that most often fails.
  The tileset name comes from the filename, and the server hardcodes `africa`; anything
  else yields a blank map. The validator prints the exact `mv` command to fix it.
- `mbtiles/style.json` is valid JSON and declares sources

### Indicator metadata

- `metadata.csv` exists and has a `ColumnName` column
- the commonly-needed columns (`MapthisYN`, `graphthisYN`, `Units`, `axis label`,
  `typeofgraph`) are present
- **every `ColumnName` is cross-checked against the real columns in `scenario_current`**,
  in both directions

The cross-check is the most valuable thing the tool does. A metadata row that names a
column which doesn't exist is silently ignored at runtime, so the indicator disappears
from the UI with no error anywhere.

!!! example "The dot-versus-space fault"
    When a mismatch is found, the validator re-compares with `.` normalised to ` `. If
    that recovers the missing names, it says so explicitly:

    ```
    ERROR  344 metadata.csv column(s) do not match the GeoPackage, but 344 of them
           match once '.' is treated as ' '
           This is R's make.names() rewriting spaces to dots on export. Those
           indicators will render with raw column names, no colour, no units and no
           chart-type detection, and will not appear in the map or chart selectors
           at all — the lookup is an exact string match on ColumnName.
    ```

    Without this check the symptom is simply "most of the indicators are missing from the
    dropdowns", with nothing in the logs.

### Lookup tables

- `NPP_by_treecover.csv` and `deltaSOC_bytcc_Mgha.csv` exist and have a `catchID` column
- `herb_traits_ready.csv` exists and has a `Species` column

Missing lookups do not stop the application, but ecological recalculation falls back to
defaults, so target editing produces wrong numbers.

### Runtime directories and demo content

- `sites/` and `images/` exist and are writable
- `walkthroughs/` and `demo/` exist
- each walkthrough JSON is valid and its `id` field matches its filename

### Content that does not belong

Reported as warnings, with an explanation for each — source code, personal history files,
superseded directories, and styles the server never loads. See
[The Data Directory](data-directory.md#what-should-not-be-in-the-data-directory).

Pipeline inputs (`catchments.gpkg`, `current*.csv`, `reference*.csv`) are reported
neutrally with their total size, since they are legitimate on a build machine but should
be left out of a distributed pack.

## Example output

```
Validating data directory: /home/user/DecisionTheatre/data

== GeoPackage (internal/geodata/gpkg_store.go) ==
     OK  datapack.gpkg opens as SQLite
     OK  table catchments_lev12 present
     OK  spatial index rtree_catchments_lev12_geom present
     OK  catchments_lev12 holds 147837 catchments

== Map tiles (internal/tiles/mbtiles.go, internal/server/server.go) ==
          tileset "africa-002" found: mbtiles/africa-002.mbtiles
  ERROR  no tileset named "africa" — the map will be blank
          Fix: mv "mbtiles/africa-002.mbtiles" "mbtiles/africa.mbtiles"

== Files not read at runtime ==
          Build inputs present (7 files, 2.0G). Consumed by scripts/build-geopackage.sh
          to produce datapack.gpkg; not read at runtime and safe to omit.
   WARN  "R scripts/" contains source code, not data

1 error(s), 4 warning(s). The application will not work correctly against this data directory.
```

## Extending the checks

The checks live in `scripts/validate-data.sh`, not in `flake.nix` — the Nix app is a thin
wrapper that supplies dependencies, so the same logic runs identically from Nix, from
`make`, and from a plain shell.

When adding a check, cite the source file that reads the thing being checked, as the
existing sections do. That is what keeps this tool honest as the code changes: a check
with no corresponding read in the codebase is a check that has outlived its purpose.
