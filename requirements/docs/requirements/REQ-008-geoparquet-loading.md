# REQ-008: GeoParquet Data Loading

| Field | Value |
|-------|-------|
| **Component** | Backend / Data |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a developer, when the application starts, I should have three geoparquet files loaded into memory representing past, present, and ideal future scenarios, each containing identical attribute columns for all catchments. |
| **Importance** | Critical |

## Wireframe

```
Data Directory:
data/
├── past.parquet          ← Historical scenario
├── present.parquet       ← Current conditions
├── future.parquet        ← Ideal future scenario
│
└── Each file contains:
    ┌────────────────────────────────────────┐
    │ catchment_id │ soil_moisture │ rainfall │
    │ CAT001       │ 0.45          │ 120.5    │
    │ CAT002       │ 0.32          │ 95.2     │
    │ ...          │ ...           │ ...      │
    │ CAT150000    │ 0.58          │ 142.1    │
    └────────────────────────────────────────┘
    ~150,000 rows x N attribute columns
```

## Implementation Details

- Three geoparquet files with identical structure (same columns, same catchment IDs)
- Files are loaded into memory at startup for fast query response
- Supports both `.parquet` and `.geoparquet` file extensions
- Fallback: pre-processed `.json` files alongside parquet files
- The store provides APIs for:
  - Listing available scenarios
  - Listing available attribute columns
  - Getting data for a single scenario + attribute
  - Getting comparison data for two scenarios + attribute
- Thread-safe access via `sync.RWMutex`
- Expected file names: `past.parquet`, `present.parquet`, `future.parquet` (or `ideal_future.parquet`)

### Key Files

- `internal/geodata/geoparquet.go` - GeoParquet store
- `internal/geodata/geoparquet_test.go` - Unit tests
