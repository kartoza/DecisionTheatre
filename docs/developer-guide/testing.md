# Running Tests and Testing Framework

## Go Tests

### Running

```bash
# All tests with race detection and coverage
make test

# Or directly:
go test -v -race -coverprofile=coverage.out ./...
```

### Framework

Go tests use the standard `testing` package. Test files are colocated with source files:

```
internal/api/handler_test.go
internal/geodata/geoparquet_test.go
internal/nn/model_test.go
internal/tiles/mbtiles_test.go
```

### Coverage

After running tests, a `coverage.out` file is generated. View it with:

```bash
go tool cover -html=coverage.out
```

## Frontend Tests

### Running

```bash
# Single run
make test-frontend

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
  setup.ts          # Test environment setup
  App.test.tsx      # Application component tests
  types.test.ts     # Type validation tests
```

## Running All Tests

```bash
make test-all
```

## CI Integration

Tests run automatically on every push and pull request via GitHub Actions:

- `test-go` job: `go test -race -coverprofile=coverage.out ./...`
- `test-frontend` job: `cd frontend && npm test`
- `nix-build` job: Full Nix build verification (runs after tests pass)

## Nix-Based Testing

```bash
# Run all checks (tests + build verification)
nix flake check
```

This runs Go tests and frontend tests inside isolated Nix build environments with pinned dependencies.
