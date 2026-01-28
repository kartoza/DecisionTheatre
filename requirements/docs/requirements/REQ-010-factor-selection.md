# REQ-010: Factor Selection

| Field | Value |
|-------|-------|
| **Component** | Frontend |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a user, when I select a factor (attribute column) from the dropdown, I should see each catchment on the map colored according to that factor's value, with a color scale legend displayed. |
| **Importance** | Critical |

## Wireframe

```
Factor Selection:
┌──────────────────────────┐
│ [FACTOR] ℹ              │
│                          │
│ ┌──────────────────────┐ │
│ │ Soil Moisture      ▼ │ │
│ └──────────────────────┘ │
│ Showing soil moisture     │
│ values per catchment      │
├──────────────────────────┤
│ COLOR SCALE              │
│ ┌──────────────────────┐ │
│ │ Blue ──── Red        │ │
│ └──────────────────────┘ │
│ Low            High      │
└──────────────────────────┘
```

## Implementation Details

- The column list is fetched from `/api/columns` at startup
- Column names are displayed with underscores replaced by spaces and title-cased
- Selecting a factor triggers an immediate map update (no submit button)
- The color scale uses a diverging palette: blue (low) to red (high)
- MapLibre `interpolate` expressions drive the fill color
- A gradient legend bar is displayed below the factor selector
- The attribute name appears in a highlighted text below the selector
- Factor selection affects both left and right maps simultaneously

### Key Files

- `frontend/src/components/ControlPanel.tsx` - Factor selector UI
- `frontend/src/hooks/useApi.ts` - `useColumns()` hook
- `frontend/src/components/MapView.tsx` - Color expression generation
