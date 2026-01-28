# REQ-017: Test Automation

| Field | Value |
|-------|-------|
| **Component** | Infrastructure |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a developer, when I run the test suite, I should see comprehensive automated tests covering backend Go code and frontend React components, with coverage reporting. |
| **Importance** | High |

## Wireframe

```
Test Hierarchy:
┌────────────────────────────────────┐
│ make test-all                      │
├────────────────────────────────────┤
│ Backend (Go):                      │
│   ├── internal/tiles/         ✓   │
│   ├── internal/geodata/       ✓   │
│   ├── internal/api/           ✓   │
│   └── internal/nn/            ✓   │
├────────────────────────────────────┤
│ Frontend (React/TypeScript):       │
│   ├── App component           ✓   │
│   ├── Type definitions        ✓   │
│   └── Hook tests              ✓   │
└────────────────────────────────────┘
```

## Implementation Details

- **Go tests**: `go test -v -race -coverprofile=coverage.out ./...`
  - Race detection enabled
  - Coverage output in standard Go format
  - Unit tests for: MBTiles store, GeoParquet store, API handlers, Neural network
  - Test fixtures created in temporary directories (`t.TempDir()`)
  - Table-driven tests for edge cases
- **React tests**: Vitest with React Testing Library
  - jsdom environment for DOM simulation
  - Component rendering tests
  - Type definition tests
  - API hook tests
- **Make targets**:
  - `make test` - Go tests only
  - `make test-frontend` - React tests only
  - `make test-all` - Both
  - `make check` - Format, lint, and test

### Key Files

- `internal/tiles/mbtiles_test.go`
- `internal/geodata/geoparquet_test.go`
- `internal/api/handler_test.go`
- `internal/nn/model_test.go`
- `frontend/src/test/` - Frontend tests
