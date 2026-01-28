# REQ-011: Dynamic Map Update

| Field | Value |
|-------|-------|
| **Component** | Frontend |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a user, when I change any of the three controls (left scenario, right scenario, or factor), I should see the map update immediately to reflect the new selection. |
| **Importance** | Critical |

## Wireframe

```
State Change Flow:

User changes control
        │
        ▼
┌─────────────────┐
│ React setState() │
│ comparison = {   │
│   left: "past",  │
│   right: "future"│
│   attr: "rain"   │
│ }                │
└────────┬────────┘
         │
    ┌────▼────┐
    │ useEffect │──► Update labels
    │ in MapView│──► Update layer styles
    │           │──► Fetch new data (if needed)
    └──────────┘
```

## Implementation Details

- React state management via `useState` in the App component
- State changes propagate to MapView and ControlPanel via props
- `useEffect` in MapView watches the `comparison` prop for changes
- On change:
  1. Left/right labels are updated with scenario name and color
  2. Catchment fill colors are updated via `setPaintProperty`
  3. If data fetching is needed, the comparison API is called
- No debouncing needed as changes are discrete (dropdown selections)
- Error states are handled gracefully (layer may not exist yet if tiles aren't loaded)
- The map does not re-center or re-zoom on state changes

### Key Files

- `frontend/src/App.tsx` - State management
- `frontend/src/components/MapView.tsx` - Effect-based map updates
- `frontend/src/hooks/useApi.ts` - Data fetching hooks
