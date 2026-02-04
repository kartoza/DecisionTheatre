# GeoArrow Rendering Architecture

This document describes the architecture for rendering large geospatial datasets using GeoArrow and deck.gl, which provides efficient choropleth visualization with optional 3D extrusion.

## Overview

The rendering architecture separates concerns between:

1. **Base map layers** (MBTiles) - Static contextual layers rendered by MapLibre GL JS
2. **Thematic choropleth layer** (GeoArrow) - Dynamic data visualization rendered by deck.gl

This separation allows the base map to render efficiently from vector tiles while the choropleth layer can be dynamically styled based on selected indicators without re-fetching tile data.

## Architecture Diagram

```mermaid
graph TB
    subgraph Data Files
        GPKG[UoW_layers.gpkg<br/>Catchment Geometries]
        CSV1[current.csv<br/>Scenario Data]
        CSV2[reference.csv<br/>Scenario Data]
    end

    subgraph Conversion Script
        SCRIPT[csv_to_geoarrow.py]
    end

    subgraph GeoArrow Files
        GA1[current.geoarrow<br/>~210MB]
        GA2[reference.geoarrow<br/>~210MB]
    end

    subgraph Go Backend
        SRV[HTTP Server]
        SRV --> TILES[/tiles/ MBTiles]
        SRV --> STYLE[/data/style.json]
        SRV --> GEOARROW[/data/*.geoarrow]
        SRV --> API[/api/scenario/]
    end

    subgraph Frontend
        ML[MapLibre GL JS]
        DECK[deck.gl MapboxOverlay]
        PARQUET[parquet-wasm]
        ARROW[apache-arrow]
        GEOARROWLAYER[@geoarrow/deck.gl-layers]
    end

    GPKG --> SCRIPT
    CSV1 --> SCRIPT
    CSV2 --> SCRIPT
    SCRIPT --> GA1
    SCRIPT --> GA2

    TILES --> ML
    STYLE --> ML
    GEOARROW --> PARQUET
    PARQUET --> ARROW
    ARROW --> GEOARROWLAYER
    GEOARROWLAYER --> DECK
    API --> DECK
    ML --> |interleaved| DECK
```

## Layer Stack

The map renders layers in the following order (bottom to top):

```
┌─────────────────────────────────────────────────────┐
│  deck.gl Overlay (GeoArrowSolidPolygonLayer)        │  ← Choropleth fill
├─────────────────────────────────────────────────────┤
│  MapLibre: Catchment Outlines (catchments_lev12)    │  ← Orange outlines
├─────────────────────────────────────────────────────┤
│  MapLibre: Rivers, Lakes, Populated Places          │  ← Reference features
├─────────────────────────────────────────────────────┤
│  MapLibre: Ecoregions                               │  ← Background context
├─────────────────────────────────────────────────────┤
│  MapLibre: Country Boundaries                       │  ← Base layer
└─────────────────────────────────────────────────────┘
```

## Data Pipeline

### 1. GeoArrow File Generation

The `scripts/csv_to_geoarrow.py` script joins catchment geometries with scenario data:

```python
# Read catchment polygons from GeoPackage
catchments = gpd.read_file(gpkg_path, layer="catchments_lev12")

# Read scenario CSV data
current_df = pd.read_csv("data/current.csv")

# Join on catchment ID (HYBAS_ID = catchID)
current_gdf = catchments.merge(current_df, on="catchID", how="inner")

# Write as GeoParquet (GeoArrow encoding)
current_gdf.to_parquet("data/current.geoarrow", compression="snappy")
```

**Key fields:**

| Field | Description |
|-------|-------------|
| `catchID` | Unique catchment identifier (HYBAS_ID) |
| `geometry` | MultiPolygon geometry in WGS84 |
| `herbs_*` | ~460 indicator columns |

### 2. Backend Serving

The Go backend serves GeoArrow files via a dedicated endpoint:

```go
// internal/server/server.go
s.router.HandleFunc("/data/{scenario}.geoarrow", s.handleGeoArrowFile).Methods("GET")
```

The endpoint validates the scenario name and serves the file with appropriate headers:

- `Content-Type: application/octet-stream`
- `Cache-Control: public, max-age=86400`
- `Access-Control-Allow-Origin: *`

### 3. Frontend Loading

The frontend uses `parquet-wasm` to read GeoParquet files in the browser:

```typescript
import { readParquet } from 'parquet-wasm';
import { tableFromIPC } from 'apache-arrow';

async function loadGeoParquetData(scenario: string): Promise<Table | null> {
  const response = await fetch(`/data/${scenario}.geoarrow`);
  const arrayBuffer = await response.arrayBuffer();

  // Decode Parquet to Arrow IPC, then to JS Table
  const wasmTable = readParquet(new Uint8Array(arrayBuffer));
  const table = tableFromIPC(wasmTable.intoIPCStream());

  return table;
}
```

### 4. Choropleth Rendering

The `GeoArrowSolidPolygonLayer` renders polygons with data-driven styling:

```typescript
const layer = new GeoArrowSolidPolygonLayer({
  id: `choropleth-${scenario}`,
  data: table,
  getPolygon: table.getChild('geometry'),
  getFillColor: ({ index }) => {
    const catchId = catchIdColumn.get(index);
    return colorMap.get(catchId) || [0, 0, 0, 0];
  },
  getElevation: ({ index }) => {
    if (!extruded) return 0;
    const catchId = catchIdColumn.get(index);
    return elevationMap.get(catchId) || 0;
  },
  extruded: is3DMode,
  wireframe: is3DMode,
});
```

## 3D Extrusion Mode

When 3D mode is enabled:

1. Map pitch is set to 60 degrees
2. Catchment polygons are extruded based on indicator values
3. Maximum extrusion height is 100,000 meters (for visual impact at continental scale)
4. Wireframe outlines are shown for depth perception

```typescript
const toggle3DMode = useCallback(() => {
  setIs3DMode(prev => {
    const newMode = !prev;

    // Tilt map for 3D perspective
    leftMapRef.current?.easeTo({
      pitch: newMode ? 60 : 0,
      duration: 500
    });

    return newMode;
  });
}, []);
```

## Color Mapping

Colors are interpolated from a PRISM spectrum gradient:

| Position | Color | RGB |
|----------|-------|-----|
| 0.000 | Violet | (106, 13, 173) |
| 0.143 | Indigo | (75, 0, 130) |
| 0.286 | Blue | (0, 116, 217) |
| 0.429 | Cyan | (0, 188, 212) |
| 0.571 | Green | (46, 204, 64) |
| 0.714 | Yellow | (255, 220, 0) |
| 0.857 | Orange | (255, 133, 27) |
| 1.000 | Red | (232, 0, 63) |

Values are normalized to [0, 1] based on the min/max of the selected attribute.

## Performance Considerations

### Why GeoArrow?

1. **Columnar format** - Only read columns that are needed
2. **Binary encoding** - No JSON parsing overhead
3. **WebAssembly decoding** - Fast Parquet decompression via `parquet-wasm`
4. **Direct GPU upload** - deck.gl can use Arrow buffers directly
5. **Multi-threaded triangulation** - Polygon triangulation runs on web workers

### File Sizes

| File | Size | Features |
|------|------|----------|
| current.geoarrow | 210 MB | 147,837 catchments × 465 columns |
| reference.geoarrow | 204 MB | 147,837 catchments × 465 columns |

### Caching Strategy

- GeoArrow files are cached in browser memory after first load
- Color maps are rebuilt only when the attribute changes
- deck.gl handles efficient GPU buffer updates

## Dependencies

### npm packages

```json
{
  "deck.gl": "^9.x",
  "@deck.gl/core": "^9.x",
  "@deck.gl/layers": "^9.x",
  "@deck.gl/mapbox": "^9.x",
  "@geoarrow/deck.gl-layers": "^0.3.x",
  "apache-arrow": "^17.x",
  "parquet-wasm": "^0.6.x"
}
```

### Python packages (for data conversion)

```
geopandas
pandas
pyarrow
shapely
```

## References

- [GeoArrow Specification](https://geoarrow.org/)
- [GeoParquet Format](https://geoparquet.org/)
- [@geoarrow/deck.gl-layers](https://github.com/geoarrow/deck.gl-layers)
- [GeoArrow and GeoParquet in deck.gl](https://observablehq.com/@kylebarron/geoarrow-and-geoparquet-in-deck-gl) - Kyle Barron
- [deck.gl with MapLibre](https://deck.gl/docs/developer-guide/base-maps/using-with-maplibre)
- [parquet-wasm](https://github.com/kylebarron/parquet-wasm)

## Regenerating GeoArrow Files

To regenerate the GeoArrow files after updating source data:

```bash
nix develop --command python3 scripts/csv_to_geoarrow.py
```

This requires the catchment geometries in `resources/mbtiles/UoW_layers.gpkg` and scenario CSVs in `data/`.
