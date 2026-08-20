# Developer Quick Start (Ubuntu)

## 1. Install Nix

```bash
sh <(curl -L https://nixos.org/nix/install) --daemon
```

After installation, open a new terminal or run:

```bash
. /nix/var/nix/profiles/default/etc/profile.d/nix-daemon.sh
```

## 2. Enable Flakes

```bash
mkdir -p ~/.config/nix
echo "experimental-features = nix-command flakes" >> ~/.config/nix/nix.conf
```

If running the Nix daemon, restart it:

```bash
sudo systemctl restart nix-daemon
```

## 3. Enter the Development Shell

```bash
cd DecisionTheatre
nix develop
```

This provides all tools: Go, Node.js, GCC, GDAL, tippecanoe, MkDocs, golangci-lint, air, and more. Nothing else to install.

### One task, three spellings

Every task has the same name whichever way you reach it — `dt <task>` in a terminal,
`make <task>`, `<leader>p<key>` in neovim, and `nix run .#<task>` for the ones that must
work without the shell:

```bash
dt                      # the command table
dt run                  # == make run == <leader>pr
dt doctor               # is this checkout healthy?
dt check-flake          # is flake.nix in step with the manifests?
dt run --port 9090      # extra flags reach the tool
dt                      # the command table
```

`dt` reads its task list from the Makefile, so it cannot offer a task that does not exist
or miss one that was just added, and a typo suggests the closest real names.

`dt` is an executable in `devbin/`, which both `.envrc` and the development shell put on
`PATH` — so it works whether you enter through direnv, `nix develop`, or neither. If you
have just pulled a change to `.envrc`, run `direnv allow` once.

### The command table

On entry the shell prints a table of every command, grouped by what you are trying to do —
run the app, live development, build, test, diagnose, flake lock step, data pack,
documentation, release. Type **`dt`** at any time to bring it back, or name a group for the
detail:

```bash
dt              # the overview
dt flake        # detail for one group
dt diagnose     # ditto
dt help test    # a name that is both a task and a group
```

Where a word names both a task and a group — `run`, `build`, `test`, `docs`, `release` —
the task wins, because `dt test` should run the tests. `dt help <name>` always means help.

The table is rendered with [gum](https://github.com/charmbracelet/gum) as a grid of cards,
falling back to a plain layout wherever gum is unavailable. It lives in
`scripts/shell-help.sh` and is rendered by all three of the shell greeting, `dt`, and
`make help` (`make help GROUP=data` to filter), so they cannot list
different commands. Adding a command means adding one line to that file.

The shell setup itself — Go paths, `PATH`, shortcuts — lives in `scripts/dev-shell.sh`;
the flake's `shellHook` does nothing but source it, so the environment is ordinary
reviewable shell rather than a string embedded in Nix.

### Before you commit

```bash
dt hooks       # once per checkout — installs the pre-commit checks
dt doctor      # any time you want to know whether something is off
```

!!! important
    If you change a dependency — `go get`, `npm install`, or anything that touches
    `go.sum` or `frontend/package-lock.json` — run **`dt sync-flake`** and commit
    `flake.nix` together with `nix/manifest-lock.json`.

    A nix fixed-output hash that has fallen behind its manifest still builds on your
    machine, because the vendored output is already in your store and nothing revalidates
    it. It fails for everyone importing this flake. The pre-commit hook and the first CI
    job both check it; see
    [Keeping the Flake Importable](docs/developer-guide/flake-lock-step.md).

## 4. Run the Application

The application runs in one of two modes:

```bash
make run      # desktop app — a GTK/WebKit window onto the in-process server
make serve    # web server only — connect from a browser at localhost:8080
```

Either one builds whatever is stale (frontend, docs, Go binary) first.

Every way of starting the app calls **`scripts/run-app.sh`**, the single source of truth
for how it launches. They differ only in where the binary comes from and which mode is
selected:

| Command | Mode | Binary | Use when |
| --- | --- | --- | --- |
| `make run` | desktop | built locally, incrementally | everyday development |
| `make serve` | server | built locally, incrementally | testing the browser experience |
| `nix run` | desktop | reproducible nix store build | verifying a release, or a clean machine |
| `nix run .#serve` | server | reproducible nix store build | deploying |
| `<leader>pr` / `<leader>ps` in neovim | either | same as `make` | you are already in the editor |

Because the launch flags, the mode decision and the data directory resolution all live in
that one script, none of these can drift apart. Change the script and they all change
together.

Useful knobs (environment variables, or pass flags straight through):

```bash
make run ARGS="--port 9090"          # any flag, passed to the binary
DT_MODE=server make run              # same as make serve
DT_FORCE_BUILD=1 make run            # rebuild everything, ignore timestamps
DT_SKIP_BUILD=1 make run             # launch the existing binary as-is
DT_DATA_DIR=/srv/data make run       # override the data directory
./scripts/run-app.sh --help          # full list
```

For settings you want on every launch on your machine, copy `.dt-env.example` to
`.dt-env` (gitignored) and edit it. Every entry point reads that same file, so your
machine-specific choices apply to `make run`, `make serve` and `nix run` alike, without
any of them growing its own copy of the logic. Explicit environment variables and
command-line flags still override it.

```bash
cp .dt-env.example .dt-env
```

`.dt-env` is where the **MapTiler API key** belongs — it powers the satellite basemap
and the font-glyph proxy (`internal/config.MapTilerAPIKey`). Without it those features
fail upstream and the app falls back to the built-in basemap / unlabelled glyphs rather
than erroring, but you'll want your own key for a working satellite view:

```bash
# .dt-env
DT_MAPTILER_API_KEY=your-key-here
```

Get a free key at [maptiler.com](https://www.maptiler.com/). This is deliberately an
environment variable rather than a `--flag`: a flag's value is visible to anyone who can
run `ps` on the machine, which a key should not be — and unlike a flag, it is never
compiled into the binary either, so it cannot end up committed to source control.

### Where the data comes from

With no `--data-dir` and no `DT_DATA_DIR`, the application resolves its data directory in
this order:

1. the data pack path saved in settings, if one has been installed
2. **`./data` in the working directory, if it exists**
3. the per-user data directory (`~/.local/share/decision-theatre/data` on Linux)

Step 2 is what makes a fresh checkout work: run `make run` from the project root and it
picks up the repository's own `data/`. The directory is only used when it already exists,
so double-clicking a packaged executable never creates an empty `data` folder beside
itself.

## 5. Live Development (Hot Reload)

For the best development experience with hot-reload on both frontend and backend:

```bash
make dev-all
```

This starts two processes:

- **air** on port 8080 — watches Go files and auto-rebuilds/restarts the backend when you save
- **Vite** on port 5173 — provides instant HMR for React/TypeScript changes

Open **http://localhost:5173** in your browser. Edit `.tsx` files in neovim and see changes instantly. Edit `.go` files and the backend auto-rebuilds within ~1 second.

You can also run each process separately in different terminals:

```bash
make dev-backend     # Go backend with air hot-reload (port 8080)
make dev-frontend    # Vite dev server with HMR (port 5173)
```

The hot-reload stack is the one place that deliberately differs from `make run`: it serves
the frontend from Vite on port 5173 and runs the Go backend headless on 8080, rather than
embedding the frontend in the binary and opening a desktop window. Use `make run` whenever
you want to see what a user sees.

## 6. Run Tests

```bash
make test-all
```

## 7. Create a Release Build

Use the release script from the project root:

```bash
./scripts/create-new-release.sh
```

Optional flags:

```bash
./scripts/create-new-release.sh --version 0.1.0
./scripts/create-new-release.sh --version 0.1.0 --push
```

- `--version` sets the release version explicitly.
- `--push` also tags the repo and creates a GitHub release (requires `gh` CLI and push access).

By default, the script determines the version from `VERSION` (if present) or the latest git tag.

Artifacts are written to `dist/`, including:

- `decision-theatre-linux-amd64-v{VERSION}.tar.gz`
- `decision-theatre-v{VERSION}.deb`
- `decision-theatre-v{VERSION}.rpm`
- `checksums-v{VERSION}.sha256`

On Windows hosts, it automatically runs `scripts/build-windows-installer.sh`.

## 8. Serve the Documentation

```bash
make docs-serve
```

Then open http://127.0.0.1:8000 in your browser.

## 9. Prepare Application Data

The application requires two data files: map tiles (MBTiles) and scenario data (GeoPackage).

### Map Tiles

Convert a GeoPackage with vector layers to MBTiles:

```bash
cd resources/mbtiles
./gpkg_to_mbtiles.sh UoW_layers.gpkg
```

The output is automatically placed in `data/mbtiles/africa.mbtiles`.

### Scenario Datapack

Build the scenario datapack from catchment geometries and CSV data:

```bash
# Place input files in data/
# - catchments.gpkg (catchment geometries)
# - current.csv (current scenario metrics)
# - reference.csv (reference scenario metrics)
# - metadata.csv (optional column descriptions)

make geopackage
```

This creates `datapack.gpkg` with scenario tables, domain min/max for color scaling, and precomputed GeoJSON for fast API serving.

### Check the data directory

Before running the app against a data directory, check it:

```bash
make check-data                       # checks ./data
nix run .#check-data -- /path/to/data
decision-theatre check-data --json    # machine-readable, for CI gates
```

The report lists what each GeoPackage table holds, what the tilesets contain, whether
every `metadata.csv` row names a column that really exists, and classifies every file in
the directory as read-by-the-app, a build input, user data, or extraneous.

Exit `0` means no errors, `1` means the application will not work correctly, `2` means the
directory could not be examined — so it can gate a deployment.

The checks are a subcommand of the application itself (`internal/datacheck`), opening the
data through the same loaders the server uses. `internal/datacheck/spec_test.go` fails the
build if the runtime starts reading something the checker does not know about.

Two faults are common enough to be worth knowing about up front:

- **The tileset must be named `africa`.** The name comes from the filename, and
  `internal/server/server.go` hardcodes `africa`; a file called `africa-002.mbtiles`
  registers a tileset nothing requests, and the map renders blank.
- **`metadata.csv` exported from R** may carry `make.names()` dots where the GeoPackage has
  spaces (`Obligate.grazer` vs `Obligate grazer`). Affected indicators disappear from the
  UI with nothing logged. The checker detects this and names the exact fix.

### Build a data pack

```bash
make pack-data                   # check, then package into dist/
make pack-data ARGS="--force"    # package despite errors
```

The pack contains only the files the application actually reads — build inputs and saved
user data are excluded — and carries a manifest with the packaging date, a per-file
SHA-256 inventory, the checker's verdict, and an explanation of everything left out.

A pack is refused outright if the check reports errors, so a data pack that cannot be
loaded never reaches a user.

See [The Data Directory](docs/administrator-guide/data-directory.md),
[Checking the Data Directory](docs/administrator-guide/validating-data.md) and
[Data Pack Format](docs/developer-guide/datapack-format.md).

For detailed documentation on data formats and the GeoPackage schema, see the **Data Preparation** section in the developer documentation.

> **Note:** `data/` is untracked by design. [`data-readme.md`](data-readme.md) at the
> repository root is the tracked description of its expected contents.

## Further Reading

For architecture details, coding standards, testing, and release procedures, see the **Developer Guide** section in the documentation.
