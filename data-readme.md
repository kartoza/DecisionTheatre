# The `data/` Directory

`data/` is **untracked by design** — it holds large binary and tabular content that is
distributed separately as a data pack, not through version control. This file is tracked
so the directory's expected contents are documented even though the contents themselves
are not.

**Full documentation:
[Administrator Guide → The Data Directory](https://kartoza.github.io/DecisionTheatre/administrator-guide/data-directory/)**
(also available offline in the running application at `/docs/administrator-guide/data-directory/`,
and in source at [`docs/administrator-guide/data-directory.md`](docs/administrator-guide/data-directory.md)).

## Check it before you run

```bash
nix run .#validate-data          # or: make validate-data
```

Exit `0` = no errors, `1` = the application will not work correctly, `2` = directory or
tooling missing. See
[Validating the Data Directory](docs/administrator-guide/validating-data.md).

## Summary

Required — the application will not work without these:

| Path | Notes |
|---|---|
| `datapack.gpkg` | Filename hardcoded in `internal/geodata/gpkg_store.go` |
| `mbtiles/africa.mbtiles` | **Must be named `africa`** — the name is hardcoded in `internal/server/server.go` |
| `mbtiles/style.json` | Required. A fallback to the resources directory exists but is being removed — it substitutes another dataset's cartography |
| `metadata.csv` | Keyed on `ColumnName`, matched exactly against GeoPackage columns |
| `NPP_by_treecover.csv`, `deltaSOC_bytcc_Mgha.csv`, `herb_traits_ready.csv` | Lookup tables for ecological recalculation |

Written at runtime: `sites/`, `images/`.
Optional: `walkthroughs/`, `demo/`.
Pipeline inputs, not read at runtime: `catchments.gpkg`, `current*.csv`, `reference*.csv`.

Two faults are common enough to call out here:

- **A tileset not named `africa`** (e.g. `africa-002.mbtiles`) registers under that name,
  is never requested, and the map renders blank.
- **`metadata.csv` exported from R** may have `make.names()` dots where the GeoPackage has
  spaces (`Obligate.grazer` vs `Obligate grazer`). Affected indicators vanish from the UI
  with no error logged.

Both are detected by `validate-data`.

## What does not belong here

Source code, personal history files (`.Rhistory`), superseded directories and screenshots.
Anything placed in `data/` is shipped to users, is not under review, and has no history.
The full list, with reasons, is in the
[Administrator Guide](docs/administrator-guide/data-directory.md#what-should-not-be-in-the-data-directory).
