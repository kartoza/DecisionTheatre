# Development Environment

Decision Theatre is developed inside a Nix flake. The flake pins every tool the project
needs — Go, Node, the documentation toolchain, the geospatial utilities, the packaging
tools — so a checkout builds identically on any machine without installing anything
system-wide.

If you take one thing from this page: **work inside `nix develop`**. Every command below
assumes you are in that shell.

<figure markdown>
  ![The development loop from nix develop to a built binary](../assets/diagrams/generated/dev-workflow.svg)
  <figcaption class="static">
    The development loop.
  </figcaption>
</figure>

## Prerequisites

Nix with flakes enabled. That is the only requirement.

```bash
# Install Nix (multi-user)
sh <(curl -L https://nixos.org/nix/install) --daemon

# Enable flakes
mkdir -p ~/.config/nix
echo "experimental-features = nix-command flakes" >> ~/.config/nix/nix.conf
```

!!! tip "direnv makes this automatic"
    With [direnv](https://direnv.net/) installed, the committed `.envrc` enters the shell
    for you whenever you `cd` into the project:

    ```bash
    direnv allow
    ```

## Entering the shell

```bash
nix develop
```

The first entry downloads and builds the toolchain, which takes a while. Subsequent
entries are instant.

### What the shell provides

| Area | Tools |
|---|---|
| **Go** | `go`, `gopls`, `golangci-lint`, `delve`, `go-tools`, `gomodifytags`, `gotests`, `impl`, `air` |
| **Frontend** | `nodejs_22` |
| **Documentation** | `mkdocs`, `mkdocs-material`, `mkdocs-minify-plugin` (as `mkdocsEnv`) |
| **Geospatial** | `tippecanoe`, `gdal`, `sqlite` |
| **Packaging** | `nfpm`, `zip`, `gnumake`, `gcc`, `pkg-config` |
| **Desktop runtime** | `webkitgtk_4_1`, `gtk3` |
| **Nix** | `nil`, `nixpkgs-fmt`, `nixfmt-rfc-style` |
| **Security** | `trivy` |
| **General** | `git`, `gh`, `ripgrep`, `fd`, `eza`, `bat`, `fzf`, `tree`, `jq`, `yq` |

`GOPATH` is set to `$PWD/.go`, so the Go module cache stays inside the project rather than
in your home directory.

## Running the application

```bash
nix run                                   # build and launch the desktop app
nix run . -- --headless                   # no window; browse to localhost:8080
nix run . -- --data-dir /path/to/data     # point at a specific data directory
```

`nix run` builds from the current checkout, including uncommitted work — though note that
Nix only sees files git knows about, so a brand-new file must be `git add`ed before the
flake can build it.

## `nix run` commands

| Command | What it does |
|---|---|
| `nix run` | Build and launch the desktop application |
| `nix run .#validate-data` | Check a data directory for compliance and correctness |
| `nix run .#validate-data -- /srv/data` | Check a specific directory |

`validate-data` carries its own `sqlite3` and `python3`, so it runs on a machine with
nothing else installed — useful as a deployment gate:

```bash
nix run .#validate-data -- /srv/decision-theatre/data || exit 1
```

See [Validating the Data Directory](../administrator-guide/validating-data.md).

!!! note "The convention asks for more of these"
    The project convention is for the flake to expose `nix run .#foo` commands covering
    build, docs, format and test. Only the two above exist today; everything else runs
    through `make`. Adding them is worthwhile — each should wrap a script under `scripts/`
    rather than embed shell in `flake.nix`, per the project's "no code in nix files" rule.

## `nix build` targets

| Command | Produces |
|---|---|
| `nix build` | The full application at `./result/bin/decision-theatre` |
| `nix build .#decision-theatre` | The same, named explicitly |
| `nix build .#frontend` | The built SPA only |
| `nix build .#docs` | This documentation site only |
| `nix build .#validate-data` | The data validator as a standalone binary |

```bash
nix build && ./result/bin/decision-theatre --version
```

That last line is exactly what CI runs to prove the artefact works.

## `nix flake check`

```bash
nix flake check
```

This runs the `go-tests` and `frontend-tests` checks in isolated build environments.

!!! bug "This does not currently pass"
    `checks.frontend-tests` has an empty `npmDepsHash`, which is not a valid fixed-output
    hash, and `checks.go-tests` omits the webkit build inputs that the package itself
    needs. Use `make test-all` until this is fixed.

    Ticket: *flake.nix embeds code inline and nix flake check cannot pass*.

## Everyday commands

These run inside `nix develop`.

### Live development

```bash
make dev-all          # backend and frontend together, with reload
make dev-backend      # Go server only, via air
make dev-frontend     # Vite dev server only
make dev              # build the backend once and run it on port 8080
```

`make dev-all` is the usual choice: the Vite dev server proxies `/api`, `/tiles`, `/data`
and `/docs` to the Go server, so the frontend hot-reloads while the backend restarts on
change.

### Building

```bash
make build            # frontend, then docs, then the backend binary
make build-frontend   # npm ci && vite build → internal/server/static/
make build-docs       # mkdocs build → internal/server/docs_site/
make build-backend    # go build (assumes the embed targets exist)
make app              # frontend + docs only
```

!!! warning "Build order matters"
    `internal/server/static/` and `internal/server/docs_site/` are `//go:embed` targets
    produced by the frontend and docs builds. They are not committed, so on a clean
    checkout `go build`, `go vet` and `go test` all fail until you have run
    `make build-frontend` and `make build-docs` at least once.

### Testing

```bash
make test             # go test -race -coverprofile=coverage.out ./...
make test-frontend    # vitest run
make test-all         # both
```

See [Testing](testing.md) for what is and is not covered.

### Formatting and linting

```bash
make fmt              # gofmt -w
make lint             # golangci-lint run --timeout 5m
make check            # fmt, lint, then test
```

Frontend type checking:

```bash
cd frontend && npx tsc --noEmit
```

!!! warning "Frontend lint does not run"
    `npm run lint` cannot start — ESLint is installed but no configuration file exists.
    See [Coding Standards](coding-standards.md).

### Documentation

```bash
make docs             # build the site into internal/server/docs_site/
make docs-serve       # live-reloading preview on localhost:8000
mkdocs serve          # the same, directly
```

The docs build generates its diagrams from the codebase — see
[the diagram pipeline](#diagrams-and-provenance) below.

### Data

```bash
make fetch-data FOLDER=<drive-id>   # pull source data
make geopackage                     # build datapack.gpkg from source CSVs
make datapack                       # package data/ into a distributable archive
make list-datapack                  # inspect a built pack
make validate-data                  # check the data directory
```

See [Data Preparation](data-preparation.md).

### Packaging and release

```bash
make packages           # all platforms buildable from here
make packages-linux     # .tar.gz, .deb, .rpm
make packages-windows   # .zip, .msi (via mingw-w64 and WiX)
make packages-darwin    # .dmg — macOS only
make packages-flatpak
make packages-snap
make release            # full release build
```

See [Preparing a Release](releasing.md).

## Continuous integration

<figure markdown>
  ![CI jobs and the dependencies between them](../assets/diagrams/generated/ci-pipeline.svg)
  <figcaption class="gen">
    The CI pipeline, read from the workflow definition.
  </figcaption>
</figure>

`.github/workflows/ci.yml` runs on every push and pull request to `main`:

| Job | Runs |
|---|---|
| `secrets-scan` | TruffleHog (verified only) and Gitleaks |
| `file-checks` | Large-file and unwanted-file scan |
| `lint-go` | `golangci-lint` |
| `lint-frontend` | `npx tsc --noEmit` only |
| `test-go` | `go test -race -coverprofile=coverage.out ./...` |
| `test-frontend` | `npm test` |
| `nix-build` | `nix build`, then `--version`, gated on the four jobs above |
| `security` | Trivy filesystem scan, failing on CRITICAL and HIGH |

`.github/workflows/release.yml` runs on a `v*` tag: a five-platform build matrix, then
parallel packaging jobs, then a published GitHub Release.

!!! bug "`file-checks` fails on every run"
    It scans with `find . -name "*.env"`, which matches the tracked `frontend/.env`, so it
    exits non-zero on every push and pull request.

To reproduce CI locally:

```bash
make check          # fmt, lint, test
nix build && ./result/bin/decision-theatre --version
trivy fs --severity CRITICAL,HIGH .
```

## Diagrams and provenance

The documentation illustrations come from two places, and each figure is marked so you can
tell which at a glance.

- <span class="prov-icon gen"></span> **Generated** — redrawn from the codebase on every
  docs build by `docs/hooks/generate_diagrams.py`. It parses the real source, so it cannot
  describe something the project no longer does. Change the code and the diagram follows.
- <span class="prov-icon static"></span> **Hand-authored** — a workflow or concept drawn
  deliberately in `docs/hooks/diagrams_concept.py`, using the same brand library so the
  whole set reads as one piece of work.
{ .prov-legend }

### How generation works

| File | Role |
|---|---|
| `docs/hooks/generate_diagrams.py` | MkDocs `on_pre_build` hook; orchestrates everything |
| `docs/hooks/svglib.py` | Brand-aware SVG primitives — boxes, lanes, arrows, bars, matrices |
| `docs/hooks/diagrams_state.py` | Generators that parse real project files |
| `docs/hooks/diagrams_concept.py` | Hand-authored workflow and concept diagrams |
| `docs/assets/css/kartoza-palette.json` | The palette both the diagrams and the site CSS read |

Output lands in `docs/assets/diagrams/generated/`, which is gitignored — the diagrams are
build artefacts, not source.

There is no runtime dependency beyond the Python standard library, which keeps the docs
build reproducible under Nix.

!!! warning "Restart `mkdocs serve` after editing a hook"
    A running server holds the old hook module in memory and will regenerate stale
    diagrams over your changes. Your edits will appear to do nothing until you restart.

!!! note "Why the generators never write unchanged files"
    The hook writes into `docs/`, which is exactly what `mkdocs serve` watches. An
    unconditional write would retrigger the build, which would write again — an endless
    reload loop. The hook therefore compares content and skips identical files. This works
    only because diagram output is deterministic: **do not introduce timestamps or
    randomness into a generator.**

### Adding a generated diagram

1. Write a function in `diagrams_state.py` taking `(root: Path, palette: dict)` and
   returning an SVG string, or `None` when its source is unavailable.
2. Register it in that module's `ALL` dict.
3. Reference it from a page with `class="gen"` on the caption.

Return `None` rather than raising when a source file is missing: the Nix docs derivation
may be given a narrower source tree than a working checkout, and a missing diagram should
degrade rather than fail the build.

## Nix maintenance

```bash
nix flake update                 # update all inputs
nix flake lock --update-input nixpkgs
nixpkgs-fmt flake.nix            # format
nil diagnostics flake.nix        # lint
```

`flake.lock` is committed and treated as sacred — lockfile updates belong in their own
pull request, never mixed with functional change.

!!! warning "Nix only sees tracked files"
    In a git repository, a flake build copies only files git knows about. A new file must
    be `git add`ed — even without committing — before `nix build` or `nix run` can see it.
    The symptom is a confusing "file not found" from inside the build sandbox.

## Editor integration

`gopls`, `nil` and the TypeScript language server are all in the shell, so an editor
launched from inside `nix develop` picks them up with no further configuration.

The project also ships `.exrc` and `.nvim.lua` for Neovim users.
