# Coding Standards

## Go

<figure markdown>
  ![The gates a change passes through before reaching main](../assets/diagrams/generated/quality-gates.svg)
  <figcaption class="static">
    The formatting gate is closed as of the linter configuration work; the
    diagram still shows it open. See the notes below.
  </figcaption>
</figure>


### Formatting

All Go code is formatted with `gofmt -s`, and CI rejects anything that is not.

```bash
dt fmt          # format everything in place
dt fmt-check    # report anything unformatted; change nothing
```

Both are the same script, `scripts/gofmt-check.sh`, which is also what the `lint-go`
job runs as its first step. There is deliberately only one implementation: if the gate
and the formatter were two commands they would eventually disagree about `-s`, about
which files are vendored, or about both, and the disagreement would only ever be
discovered by a red build.

The check runs in about a second — it needs no cgo, no webkit and no linter binary —
so it is the first thing CI asks and the cheapest thing to run before a push. The
`gofmt` pre-commit hook (`dt hooks`) formats staged files with the same flags.

### Linting

[golangci-lint](https://golangci-lint.run/) runs against the committed
`.golangci.yml`:

```bash
dt lint
# apply what can be applied automatically:
dt lint -- --fix
# or directly:
golangci-lint run --timeout 5m
```

The version is pinned in `.github/workflows/ci.yml` to the one the development shell
provides, so `dt lint` and CI apply the same rules to the same code.

#### What is enabled, and why

`.golangci.yml` is commented linter by linter — every entry names the class of defect
it catches *in this codebase*, because a rule nobody can justify is a rule that gets
`//nolint`-ed the first time it is inconvenient. Beyond the standard set (`errcheck`,
`govet`, `ineffassign`, `staticcheck`, `unused`) the configuration aims at four
things this project has actually been bitten by:

| Concern | Linters |
|---|---|
| An error checked and then discarded, so the caller is told it worked | `nilerr`, `nilnesserr`, `nilnil` |
| Handles and connections that are opened and never closed | `sqlclosecheck`, `bodyclose` |
| Code that is wrong with no runtime symptom | `gocheckcompilerdirectives`, `musttag`, `canonicalheader`, `recvcheck`, `fatcontext`, `durationcheck`, `reassign`, `exhaustive` |
| Suppressions and test hygiene | `nolintlint`, `usetesting` |

Two rules about the file itself:

- **The tree runs clean.** Every enabled linter passes on `main` today. Nothing is
  hidden behind a path exclusion, so a finding in your build is a finding in your
  change.
- **What is *not* enabled is written down too.** The bottom of `.golangci.yml` lists
  the linters that are worth having, the exact debt that blocks each one, and the
  ones considered and declined with the reason. Enabling one is meant to be a
  deliberate act with a known cost, not a discovery.

!!! note "Adding a linter"
    Measure first — `golangci-lint run` with it enabled, over the whole tree — and
    either clear what it finds in the same change or leave it in the list at the
    bottom of the file. Note that golangci-lint truncates its own output by default
    (`max-same-issues: 3`); `.golangci.yml` turns that off, so what you see is
    everything.

### Conventions

- Follow [Effective Go](https://go.dev/doc/effective_go) guidelines
- Use `internal/` packages for non-exported code
- Prefer returning errors over panicking
- Use `context.Context` for cancellation where appropriate
- Use channels and goroutines for concurrent operations
- Exported functions must have doc comments

### Package Structure

```
internal/
  api/       # HTTP handlers, metadata cache, ecological recalculation
  config/    # Platform config/data dirs, settings.json
  geodata/   # GeoPackage data access, choropleth, grid aggregation
  httputil/  # JSON response helpers
  server/    # HTTP server setup, routing, embeds, datapack install
  sites/     # Site CRUD, thumbnails, bounding boxes
  tiles/     # MBTiles reading and tile cache
```

`internal/webview_go/` is a vendored copy whose `replace` directive is commented out in
`go.mod`; nothing imports it and it is slated for removal.

## TypeScript / React

### Type Safety

All frontend code is TypeScript with strict mode. The CI runs `tsc --noEmit` to verify type correctness:

```bash
cd frontend && npx tsc --noEmit
```

### Component Style

- Functional components with hooks
- Chakra UI for all layout and styling (no raw CSS except the theme)
- Custom hooks in `hooks/` for data fetching
- Types in `types/index.ts`

### Naming

- Components: `PascalCase` (e.g., `MapView.tsx`)
- Hooks: `camelCase` prefixed with `use` (e.g., `useApi.ts`)
- Types: `PascalCase` (e.g., `ComparisonState`)
- Files match their default export name

## General Principles

- **DRY** -- avoid duplicate logic; use shared modules
- **Async by default** -- use Go channels/goroutines and React hooks for asynchronous operations
- **Offline-first** -- never assume network availability
- **Minimal dependencies** -- only add libraries that provide substantial value
- **Test what matters** -- focus tests on business logic and data processing, not UI layout
