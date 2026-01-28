# REQ-007: Catchment Vector Data

| Field | Value |
|-------|-------|
| **Component** | Data |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a user, when I view the map, I should see approximately 150,000 catchment polygons covering Africa, each individually identifiable for attribute-based styling. |
| **Importance** | Critical |

## Wireframe

```
Africa Map with Catchments:
    ┌──────────────┐
    │  ╱╲  ╱╲     │
    │ ╱  ╲╱  ╲    │
    │╱ C1 ╲ C2 ╲  │  C = catchment polygon
    │╲    ╱╲    ╱  │
    │ ╲  ╱  ╲  ╱   │
    │  ╲╱ C3 ╲╱    │
    │  ╱╲    ╱╲    │
    │ ╱  ╲  ╱  ╲   │
    └──────────────┘
    ~150,000 catchments
```

## Implementation Details

- Catchment geometries stored in a dedicated MBTiles file (`catchments.mbtiles`)
- Each catchment has a unique identifier (catchment_id) used to join with attribute data
- Vector tiles contain a `catchments` source layer with polygon geometries
- Catchments are rendered as filled polygons with semi-transparent outlines
- The data-driven fill color is controlled by MapLibre style expressions
- At low zoom levels, catchment detail is simplified for performance
- At high zoom levels, full geometry detail is displayed
- The MBTiles file should cover zoom levels 0-14 for smooth interaction

### Key Files

- `data/catchments.mbtiles` - Catchment vector tile data (user-provided)
- `frontend/src/components/MapView.tsx` - Catchment layer styling
