# Checking the Data Directory

`check-data` examines a data directory against what the application actually reads, and
reports anything that would stop it working — or that is present but shouldn't be.

Run it after assembling a data pack, after receiving one from a colleague, and before
deploying to a server.

!!! info "Renamed from `validate-data`"
    The tool was called `validate-data` and was written in shell. It is now a subcommand
    of the application itself. Every old invocation still works: `make validate-data`,
    `nix run .#validate-data` and `./scripts/validate-data.sh`'s successor
    `./scripts/check-data.sh` all reach the same code.

## Why it lives in the application

The checks used to be a shell reimplementation of the runtime's expectations, which meant
the project held two descriptions of a valid data directory — and the shell one could
fall behind without anyone noticing.

`check-data` is now part of the binary. It opens the GeoPackage with the same connection
settings `internal/geodata` uses, and loads the tilesets through
`internal/tiles.NewMBTilesStore` — the very function the server calls. What the checker
can read, the application can read.

The remaining expectations — table names, required columns, which files matter — are
declared once in `internal/datacheck/spec.go`, and `internal/datacheck/spec_test.go`
reads the runtime packages back and **fails the build** if the code starts referencing a
table or a data file the spec does not describe. Drift becomes a failing test rather than
a silently wrong report.

## Running it

=== "Nix"

    ```bash
    nix run .#check-data                 # checks ./data
    nix run .#check-data -- /srv/dt/data
    ```

    The Nix app is the application binary, so it needs nothing else installed.

=== "Make"

    ```bash
    make check-data
    make check-data DATA_DIR=/srv/dt/data
    ```

=== "Directly"

    ```bash
    ./scripts/check-data.sh
    ./scripts/check-data.sh /srv/dt/data

    # or, if you already have a binary
    ./bin/decision-theatre check-data /srv/dt/data
    ```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | No errors. Warnings may still be present; the application should run. |
| `1` | One or more errors. The application will not work correctly against this directory. |
| `2` | The data directory does not exist or could not be examined. |

This makes it usable as a deployment gate:

```bash
nix run .#check-data -- /srv/dt/data || exit 1
```

!!! warning "Do not gate on `make check-data`"
    GNU `make` reports its own exit status `2` whenever a recipe fails, so it collapses
    "the data has errors" and "the directory is unreadable" into one code. Use
    `nix run .#check-data`, `./scripts/check-data.sh` or the binary directly when the
    distinction matters.

For a machine-readable result, `--json` emits the whole report — findings, severities and
the classified inventory — as JSON:

```bash
decision-theatre check-data --json ./data | jq '.errors, .ok'
```

## What it checks

<figure markdown>
  ![The groups of checks check-data performs and its exit codes](../assets/diagrams/generated/validation-flow.svg)
  <figcaption class="static">
    Exit status makes the tool usable as a deployment gate.
  </figcaption>
</figure>

### GeoPackage

- `datapack.gpkg` exists and opens read-only as SQLite
- `catchments_lev12`, `scenario_current` and `scenario_reference` are present and non-empty
- the `rtree_catchments_lev12_geom` spatial index exists
- `catchments_lev12` has `HYBAS_ID` and `HYBAS_ID_int`
- `scenario_current` and `scenario_reference` have `catchment_id_int` — the join key
- the optional `_lower` / `_upper` whisker tables are reported when missing

Each table is reported with its row and column counts, so a truncated import is visible
at a glance rather than only failing later.

### Map tiles

- the tilesets are opened through the server's own loader
- **a tileset named exactly `africa` exists.** This is the check that most often fails.
  The tileset name comes from the filename and the server hardcodes `africa`; anything
  else yields a blank map, and the report says which names it found instead.
- each tileset's zoom range and format are reported
- any tileset the server never requests is flagged as dead weight in a pack

### Indicator metadata

- `metadata.csv` parses, and has the `ColumnName` column without which the entire file is
  discarded
- **every `ColumnName` is cross-checked against the real columns in `scenario_current`**
- columns present in the data with no metadata row are counted, since they render with
  raw names and no units
- repeated `ColumnName` values are reported, because the last row silently wins

The cross-check is the most valuable thing the tool does. A metadata row naming a column
that does not exist is ignored at runtime, so the indicator disappears from the UI with
nothing in the logs.

!!! example "The dot-versus-space fault"
    When names do not match, the checker re-compares them ignoring punctuation. If that
    recovers them, it says so and names the fix:

    ```
    INDICATOR METADATA  metadata.csv  102.1 KiB
      ✓ parsed         503 rows · 25 columns
      ✗ cross-check    344 row(s) name a column that does not exist in scenario_current
                       — those indicators never appear in the UI, and nothing is logged
      ·   herbs_diet_kgkm2_Obligate.grazer  did you mean "herbs_diet_kgkm2_Obligate grazer"?
      ·   fix          344 of the 344 differ from a real column by punctuation only
                       typically metadata.csv was exported from R, where make.names()
                       replaces spaces with dots; re-export with check.names = FALSE
    ```

    Without this check the symptom is simply "most of the indicators are missing from the
    dropdowns", with nothing anywhere to explain it.

    Note that the 344 examples count as **one** error, not 344: they are one mistake seen
    many times.

### Lookup tables

- `NPP_by_treecover.csv` and `deltaSOC_bytcc_Mgha.csv` exist and have a `catchID` column
- `herb_traits_ready.csv` exists and parses

Missing lookups do not stop the application, but ecological recalculation falls back to
proportional scaling, so target editing produces different numbers.

### Every file, classified

The report ends with an inventory that puts each top-level entry into one of four roles:

| Role | Meaning | In a data pack? |
|---|---|---|
| **Read by the app** | Opened at runtime | Yes |
| **Build inputs** | Consumed by `make geopackage` to produce `datapack.gpkg` | No |
| **User data** | `sites/` and `images/`, written by the application | No |
| **Extraneous** | Nothing in the project reads it | No |

This distinction matters: a developer's data directory legitimately holds a couple of
gigabytes of source CSVs that the application never opens. Those are build inputs, not
faults. Only genuinely unrecognised content — stray scripts, editor lock files, notes —
is reported as extraneous, and then only as a warning.

## Example output

```
  Decision Theatre — Data Directory Report
  /home/user/DecisionTheatre/data · 15.3 GiB · 52 files

  GEOPACKAGE  datapack.gpkg  3.2 GiB
    ✓ catchments_lev12             147 837 rows · 19 columns
    ✓ scenario_current             147 837 rows · 505 columns
    ✓ scenario_reference           147 837 rows · 505 columns
    ✓ rtree_catchments_lev12_geom  147 837 rows · 5 columns

  MAP TILES  mbtiles/  10.1 GiB
    ✓ africa                       zoom 2–15 · pbf
    ✓ style.json                   present — overrides the built-in style

  LOOKUP TABLES  *.csv
    ✓ NPP_by_treecover.csv         154 394 rows · 12 columns · 27.2 MiB
    ✓ deltaSOC_bytcc_Mgha.csv      147 837 rows · 11 columns · 27.8 MiB

  DIRECTORY CONTENTS
    ! R scripts                    not read by the application (directory, 31 files)
                                   it will be left out of a data pack

  INVENTORY
    READ BY THE APP  13.4 GiB · included in a data pack
      mbtiles/                     10.1 GiB, 4 files
      datapack.gpkg                3.2 GiB
      …

    BUILD INPUTS  1.9 GiB · inputs to 'make geopackage'; excluded from a data pack
      reference_upper.csv          429.7 MiB
      …

  no errors · 2 warnings
```

## Extending the checks

Add the expectation to `internal/datacheck/spec.go`, citing the source location that
reads it, then implement the check in `internal/datacheck/check.go` and cover it in
`check_test.go`. The tests build a real SQLite GeoPackage and MBTiles file in a temporary
directory, then break one thing at a time — so a new check is easy to test honestly.

A check whose `ReadBy` no longer points at real code is a check that has outlived its
purpose; `spec_test.go` will not catch that for you, so remove it deliberately.

See also [Building a Data Pack](../developer-guide/data-preparation.md).
