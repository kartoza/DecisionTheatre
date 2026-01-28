# REQ-005: Map Swiper Comparison

| Field | Value |
|-------|-------|
| **Component** | Frontend |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a user, when I drag the swiper handle horizontally across the map, I should see the left scenario on the left side and the right scenario on the right side, allowing direct visual comparison. |
| **Importance** | Critical |

## Wireframe

```
┌─────────────────────────────────────────┐
│ [Past]          │ ◀──►  │      [Present]│
│                 │       │               │
│  Left map       │ SLIDER│  Right map    │
│  (Scenario 1)   │       │  (Scenario 2) │
│                 │       │               │
│  Catchments     │       │  Catchments   │
│  colored by     │       │  colored by   │
│  left values    │       │  right values │
│                 │       │               │
└─────────────────────────────────────────┘
       ◀── drag slider left/right ──►
```

## Implementation Details

- Two MapLibre GL instances rendered in overlapping containers
- A CSS clip region on the right map container creates the swiper effect
- The slider is a pointer-event-driven draggable element positioned between the two maps
- Pointer capture ensures smooth dragging even when the cursor leaves the slider
- The two maps are synchronized: when one moves, the other follows (center, zoom, bearing, pitch)
- Scenario labels are displayed in the top-left and top-right corners with colored borders
- The slider handle is a circular white element with a left/right arrow icon
- The slider position updates the CSS `width` property of the clip container

### Interaction Flow

1. User grabs the slider handle
2. `pointerdown` event triggers drag mode
3. `pointermove` updates slider position and clip width
4. `pointerup` ends drag mode
5. Both maps resize to fill their new visible areas

### Key Files

- `frontend/src/components/MapView.tsx` - Swiper implementation
