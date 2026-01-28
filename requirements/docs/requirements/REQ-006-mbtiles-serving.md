# REQ-006: MBTiles Vector Tile Serving

| Field | Value |
|-------|-------|
| **Component** | Backend / Data |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a user, when the map loads, I should see background map data (land, water, boundaries, roads, labels) served from a local MBTiles database with no internet access required. |
| **Importance** | Critical |

## Wireframe

```
Request Flow:
Browser ──GET /tiles/basemap/3/4/3.pbf──► Go Server
                                           │
                                     ┌─────▼─────┐
                                     │  MBTiles   │
                                     │  SQLite DB │
                                     │            │
                                     │ tiles table│
                                     └─────┬─────┘
                                           │
Browser ◄──gzip protobuf tile data────────┘
```

## Implementation Details

- MBTiles files (SQLite databases) placed in the `data/` directory are auto-discovered at startup
- The store opens all `.mbtiles` files and indexes them by filename (minus extension)
- Tiles are served at `/tiles/{name}/{z}/{x}/{y}.pbf`
- TMS y-coordinate flipping is handled automatically: `tmsY = (1 << z) - 1 - y`
- Tile data is returned with `Content-Type: application/x-protobuf` and `Content-Encoding: gzip`
- Cache-Control headers set for 24-hour browser caching
- Metadata endpoint available at `/api/tilesets/{name}/metadata`
- Thread-safe access with `sync.RWMutex`
- Expected tilesets: `basemap` (OpenMapTiles-style) and `catchments` (150K African catchments)

### Key Files

- `internal/tiles/mbtiles.go` - MBTiles store implementation
- `internal/tiles/mbtiles_test.go` - Unit tests
