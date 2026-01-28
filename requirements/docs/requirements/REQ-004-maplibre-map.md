# REQ-004: MapLibre Map Display

| Field | Value |
|-------|-------|
| **Component** | Frontend |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a user, when I load the page, I should see a full-screen interactive map centered on Africa displaying vector tile basemap data and catchment boundaries. |
| **Importance** | Critical |

## Wireframe

```
┌──────────────────────────────────────┐
│ [Header]                             │
├──────────────────────────────────────┤
│                                      │
│     ┌─────────────────────────┐      │
│     │     AFRICA MAP          │      │
│     │   ┌───┐                 │      │
│     │   │cat│  Catchments     │      │
│     │   └───┘  colored by    │      │
│     │          attribute      │      │
│     │                         │      │
│     │  center: [20, 0]       │      │
│     │  zoom: 3               │      │
│     └─────────────────────────┘      │
│                                      │
│  [Navigation Controls]               │
└──────────────────────────────────────┘
```

## Implementation Details

- MapLibre GL JS v4 for WebGL-accelerated map rendering
- Vector tile sources from the local MBTiles server at `/tiles/{name}/{z}/{x}/{y}.pbf`
- Two tile sources: `basemap` (land, water, boundaries, roads, labels) and `catchments`
- Dark map style matching the application theme
- Map layers: background, water, landuse, boundaries, roads, catchments-fill, catchments-outline, place-labels
- Navigation controls (zoom, rotate) positioned bottom-left
- Initial view: center `[20, 0]` (Africa), zoom `3`
- Catchment fill colors driven by data attributes via MapLibre expressions

### Key Files

- `frontend/src/components/MapView.tsx` - Map component
