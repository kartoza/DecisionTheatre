# REQ-009: Scenario Selection Panel

| Field | Value |
|-------|-------|
| **Component** | Frontend |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a user, when I click the settings button, I should see a slide-out panel on the right side of the screen that pushes the map to the left, containing controls to select two scenarios for comparison. |
| **Importance** | Critical |

## Wireframe

```
Panel Closed:                    Panel Open:
┌──────────────────┐⚙          ┌───────────────┐┌──────────┐
│                  │            │               ││ Scenario │
│   Full Map       │            │  Map (pushed) ││ Compare  │
│                  │            │               ││          │
│                  │            │               ││ [Left ▼] │
│                  │            │               ││ [Right▼] │
│                  │            │               ││ [Factor▼]│
└──────────────────┘            └───────────────┘└──────────┘
         ←── Panel slides in from right ──→
```

## Implementation Details

- Panel slides in from the right using Chakra UI's `<Slide>` component
- When open, the map container receives `margin-right` to push left (not overlay)
- Panel width: 100% on mobile, 400px on tablet, 440px on desktop
- Toggle button in the header bar (gear icon)
- Panel contains three selection controls:
  1. Left scenario selector (Past / Present / Ideal Future)
  2. Right scenario selector (Past / Present / Ideal Future)
  3. Factor/attribute selector (populated from geoparquet columns)
- Each selector shows its scenario description below the dropdown
- Visual badges distinguish LEFT (orange) and RIGHT (blue) sides
- Smooth CSS transition on map resize (0.3s cubic-bezier)
- Panel scrolls vertically if content exceeds viewport

### Key Files

- `frontend/src/components/ControlPanel.tsx` - Panel implementation
- `frontend/src/App.tsx` - Panel state management
