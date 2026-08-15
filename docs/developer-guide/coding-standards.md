# Coding Standards

## Go

<figure markdown>
  ![The gates a change passes through before reaching main](../assets/diagrams/generated/quality-gates.svg)
  <figcaption class="static">
    Two gates are not fully closed yet — see the notes below.
  </figcaption>
</figure>


### Formatting

All Go code must be formatted with `gofmt`. Run:

```bash
make fmt
```

### Linting

We use [golangci-lint](https://golangci-lint.run/) with default settings and a 5-minute timeout:

```bash
make lint
# or directly:
golangci-lint run --timeout 5m
```

!!! warning "Expected to change"
    There is no `.golangci.yml`, and CI pins the linter to `version: latest`, so the
    active rule set varies with the release date rather than with a committed
    configuration. Nothing verifies formatting either — `make fmt` rewrites files but is
    manual, and CI does not check `gofmt -l`.

    Ticket: *golangci-lint runs on defaults and there is no gofmt gate*.

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
