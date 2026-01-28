# REQ-014: Offline Operation

| Field | Value |
|-------|-------|
| **Component** | Infrastructure |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a user, when I run the application on a machine with no internet connection, I should have full functionality including map display, data visualization, and AI features, with all assets served locally and no external network requests made. |
| **Importance** | Critical |

## Wireframe

```
Single Binary (all assets from nix store at build time):
┌────────────────────────────────────┐
│     decision-theatre binary        │
│  ┌──────────────────────────────┐  │
│  │ Embedded Assets (go:embed)  │  │
│  │  ├── index.html             │  │
│  │  ├── JS bundles (Vite)      │  │
│  │  ├── CSS (Chakra UI)        │  │
│  │  └── MapLibre GL JS         │  │
│  └──────────────────────────────┘  │
│  ┌──────────────────────────────┐  │
│  │ Go Server + API             │  │
│  │ MBTiles Reader              │  │
│  │ GeoParquet Reader           │  │
│  │ llama.cpp (CGO)             │  │
│  │ Gorgonia (Neural Network)   │  │
│  └──────────────────────────────┘  │
└────────────────────────────────────┘
     + data/ directory (MBTiles, Parquet)
```

## Implementation Details

- **Build-time guarantee**: `nix build` runs in a sandbox with no network access; if it succeeds, the output is provably self-contained
- **Frontend**: `buildNpmPackage` fetches npm deps into the nix store with a pinned `npmDepsHash`; Vite bundles everything into static JS/CSS files; no CDN links, no external fonts, no runtime network requests
- **Go embed**: `//go:embed static/*` bakes the Vite output into the Go binary; the embedded HTTP server serves it at `/`
- **Vector tiles**: Served from local MBTiles (SQLite) files at `/tiles/{name}/{z}/{x}/{y}.pbf`
- **Attribute data**: Loaded from local GeoParquet files into memory at startup
- **LLM inference**: llama.cpp linked via CGO; GGUF model loaded from disk
- **Neural network**: Gorgonia runs entirely in-process, no external calls
- **No telemetry, no analytics, no external requests of any kind**
- The only runtime input is the `data/` directory containing:
    - `.mbtiles` files for map tiles
    - `.parquet` / `.geoparquet` files for catchment attributes
    - (Optional) `.gguf` model file for LLM

### Key Files

- `flake.nix` - Hermetic nix build (sandboxed, no network)
- `internal/server/server.go` - Embed directive and static serving
- `frontend/vite.config.ts` - Bundle configuration (no external chunks)
