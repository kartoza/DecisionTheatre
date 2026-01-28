# REQ-015: Responsive Design

| Field | Value |
|-------|-------|
| **Component** | Frontend |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a user, when I access the application on any device (phone, tablet, desktop), I should have a usable and visually appealing interface that adapts to my screen size. |
| **Importance** | High |

## Wireframe

```
Desktop (1200px+):           Tablet (768px):          Mobile (<768px):
┌──────────┬──────┐          ┌──────────┬────┐        ┌──────────┐
│          │Panel │          │          │Pan │        │          │
│   Map    │400px │          │   Map    │400 │        │   Map    │
│          │      │          │          │    │        │          │
│          │      │          │          │    │        │ Panel is │
│          │      │          │          │    │        │ full-    │
└──────────┴──────┘          └──────────┴────┘        │ screen   │
                                                       │ overlay  │
                                                       └──────────┘
```

## Implementation Details

- Chakra UI responsive breakpoints: `base` (0px), `sm` (480px), `md` (768px), `lg` (992px)
- Control panel sizing:
  - Mobile (`base`): Full viewport width (100vw)
  - Tablet (`md`): 400px fixed width
  - Desktop (`lg`): 440px fixed width
- Map container adjusts margin-right based on panel state and breakpoint
- Header elements hide/show based on screen size (status badges hidden on mobile)
- Touch-friendly slider handle (40px diameter)
- Panel close button visible only on mobile
- MapLibre navigation controls work with touch events
- Font sizes and spacing scale appropriately

### Key Files

- `frontend/src/App.tsx` - Responsive layout
- `frontend/src/components/ControlPanel.tsx` - Responsive panel
- `frontend/src/components/Header.tsx` - Responsive header
