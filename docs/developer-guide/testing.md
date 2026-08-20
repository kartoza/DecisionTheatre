# Running Tests and Testing Framework

## Go Tests

<figure markdown>
  ![Source lines per package, shaded by whether tests exist](../assets/diagrams/generated/test-coverage.svg)
  <figcaption class="gen">
    Counted from the source tree, so it updates as tests are added.
  </figcaption>
</figure>


### Running

```bash
# All tests with race detection and coverage
dt test

# Or directly:
go test -v -race -coverprofile=coverage.out ./...
```

!!! note "Build the frontend first"
    `internal/server/static/` is a build artefact produced from `frontend/dist/` and is
    not committed. Until it exists, the `//go:embed all:static` directive fails and
    `go build`, `go vet` and `go test` all fail on a clean checkout. Run
    `dt build-frontend` (or a full `dt build`) first.

### Framework

Go tests use the standard `testing` package. Test files are colocated with source files.
The current set is:

```
internal/api/handler_test.go                    # health, info, empty-store endpoints
internal/api/recalculate_r_validation_test.go   # validates the workflow cascade against R output
internal/api/site_shapefile_test.go             # shapefile/GeoJSON site creation
internal/tiles/mbtiles_test.go                  # tileset construction, lookup, error paths
```

### Coverage

Two of the eight first-party packages have tests today.

| Package | Lines | Tests |
|---|---:|---|
| `internal/api` | 3,038 | 11 |
| `internal/tiles` | 269 | 10 |
| `internal/geodata` | 2,688 | **none** |
| `internal/server` | 1,236 | **none** |
| `internal/sites` | 466 | **none** |
| `internal/config` | 129 | **none** |
| `internal/httputil` | 21 | **none** |
| `main` | 196 | **none** |

!!! warning "Expected to change"
    `internal/geodata` holds the geometry and aggregation logic — RDP simplification, ring
    containment, point-in-ring, signed area, grid aggregation — all pure functions and all
    untested. `internal/server` includes the zip-slip guards and the datapack install state
    machine; `internal/sites` includes the path handling.

    Ticket: *internal/geodata has zero tests despite 2,688 lines of geometry logic*.

After running tests, a `coverage.out` file is generated. View it with:

```bash
go tool cover -html=coverage.out
```

There is no coverage threshold enforced in CI.

## Frontend Tests

### Running

```bash
# Single run
dt test-frontend

# Or directly:
cd frontend && npx vitest run

# Watch mode (re-runs on file changes)
cd frontend && npx vitest
```

### Framework

Frontend tests use:

- [Vitest](https://vitest.dev/) -- test runner (Vite-native, compatible with Jest API)
- [@testing-library/react](https://testing-library.com/docs/react-testing-library/intro/) -- component testing
- [@testing-library/jest-dom](https://github.com/testing-library/jest-dom) -- DOM assertions
- [jsdom](https://github.com/jsdom/jsdom) -- browser environment simulation

Test files are in `frontend/src/test/`:

```
frontend/src/test/
  setup.ts          # Stubs window.URL.createObjectURL for maplibre-gl
  App.test.tsx      # Smoke test: renders App, asserts the title is present
  runtime.test.ts   # getAppRuntime() / isGoWebViewRuntime() branching
  types.test.ts     # SCENARIOS shape and colour format
```

That is 8 test cases across 76 lines. The API layer (`useApi.ts`), the AOI-weighted
aggregation in `utils/indicators.ts`, `lib/ttlCache.ts`, `lib/mapBounds.ts` and all 27
components are untested. `utils/indicators.ts` and `lib/ttlCache.ts` are pure,
dependency-free functions with documented edge cases and are the cheapest place to start.

There is no coverage reporter configured.

## Type Checking and Linting

```bash
cd frontend && npx tsc --noEmit
```

This passes cleanly under `strict`, `noUnusedLocals` and `noUnusedParameters`.

!!! warning "Frontend lint does not currently run"
    `package.json` defines a `lint` script and ESLint is installed, but no ESLint
    configuration file exists in the repository, so `npm run lint` cannot start. CI runs
    only `tsc --noEmit`.

    Ticket: *Frontend lint has never run — no eslint config exists*.

## Running All Tests

```bash
dt test-all
```

## CI Integration

<figure markdown>
  ![CI jobs and the dependencies between them](../assets/diagrams/generated/ci-pipeline.svg)
  <figcaption class="gen">
    Parsed from <code>.github/workflows/ci.yml</code>, including the <code>needs</code> graph.
  </figcaption>
</figure>


Tests run on every push and pull request to `main` via `.github/workflows/ci.yml`:

| Job | Runs |
|---|---|
| `secrets-scan` | TruffleHog (verified only) and Gitleaks |
| `file-checks` | Large-file and unwanted-file scan |
| `lint-go` | `gofmt -s -l` via `scripts/gofmt-check.sh`, then `golangci-lint` against the committed `.golangci.yml` |
| `lint-frontend` | `npx tsc --noEmit` only |
| `test-go` | `go test -race -coverprofile=coverage.out ./...` |
| `test-frontend` | `npm test` |
| `nix-build` | `nix build` then `--version`, after the four jobs above pass |
| `security` | Trivy filesystem scan, failing on CRITICAL/HIGH |

!!! bug "`file-checks` currently fails on every run"
    The job scans with `find . -name "*.env"`, which matches the tracked `frontend/.env`,
    so it exits non-zero on every push and pull request.
    Ticket: *CI file-checks job fails on every push because frontend/.env is tracked*.

!!! warning "No pre-commit hooks"
    Secret scanning, formatting and linting run only in CI. There is no
    `.pre-commit-config.yaml`, so nothing gates a commit locally.
    Ticket: *No pre-commit hooks — secret scanning is CI-only*.

## Nix-Based Testing

```bash
nix flake check
```

!!! bug "`nix flake check` cannot currently pass"
    The `frontend-tests` check has an empty `npmDepsHash`, which is not a valid
    fixed-output hash, and the `go-tests` check omits the webkit build inputs the package
    itself requires.
    Ticket: *flake.nix embeds code inline and nix flake check cannot pass*.

`nix build` does work, and is what the `nix-build` CI job verifies.
