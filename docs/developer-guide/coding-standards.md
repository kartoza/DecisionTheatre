# Coding Standards

## Go

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
  api/       # HTTP handlers (thin layer, delegates to domain packages)
  config/    # Configuration structs
  geodata/   # GeoParquet loading and processing
  llm/       # LLM integration (with stub for builds without model)
  models/    # Shared data models
  nn/        # Neural network inference (with stub)
  server/    # HTTP server setup, static file serving
  tiles/     # MBTiles reading
```

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
