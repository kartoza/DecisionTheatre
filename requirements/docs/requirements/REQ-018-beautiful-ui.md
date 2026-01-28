# REQ-018: Beautiful User Interface

| Field | Value |
|-------|-------|
| **Component** | Frontend |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a user, when I open the application, I should be presented with an eye-wateringly beautiful, modern interface with polished styling, smooth animations, and a cohesive dark theme. |
| **Importance** | High |

## Wireframe

```
Visual Design Elements:
┌──────────────────────────────────────────────┐
│ ┌────────────────────────────────────────┐   │
│ │  Decision Theatre    v0.1 [T][L][N] ⚙ │   │
│ │  gradient text ─────► blue-to-orange   │   │
│ └────────────────────────────────────────┘   │
│ ┌─────────────────────┬──────────────────┐   │
│ │                     │ ╔══════════════╗ │   │
│ │  Dark map with      │ ║ Glassmorphic ║ │   │
│ │  vibrant choropleth │ ║ scenario     ║ │   │
│ │  colors             │ ║ badges       ║ │   │
│ │  ────────           │ ║              ║ │   │
│ │  Glowing slider     │ ║ Gradient     ║ │   │
│ │  handle with        │ ║ color scale  ║ │   │
│ │  drop shadow        │ ║ bar          ║ │   │
│ │                     │ ╚══════════════╝ │   │
│ └─────────────────────┴──────────────────┘   │
└──────────────────────────────────────────────┘
```

## Implementation Details

- **Dark theme**: `gray.800` / `gray.900` background, white text, high contrast
- **Brand gradient**: Header title uses `bgGradient="linear(to-r, brand.400, accent.400)"`
- **Color palette**: Custom brand (blue) and accent (orange) color scales
- **Map styling**: Dark basemap (`#1a1a2e` background) with muted land colors and bright data choropleth
- **Glassmorphic elements**: Scenario labels with `backdrop-filter: blur(8px)` and semi-transparent backgrounds
- **Smooth transitions**:
  - Panel slide: 0.3s cubic-bezier ease
  - Border color hover effects on control cards
  - Focus states with colored box-shadows
- **Typography**: Inter font family, tight letter-spacing for headings
- **Slider design**: White circular handle with drop shadow, 40px diameter
- **Color scale**: Diverging blue-to-red gradient bar with label endpoints
- **Status badges**: Green/gray pills for system status (Tiles, LLM, NN)
- **Spacing**: Consistent 4/6 unit spacing rhythm

### Key Files

- `frontend/src/styles/theme.ts` - Theme definition
- `frontend/src/components/Header.tsx` - Gradient text, badge pills
- `frontend/src/components/ControlPanel.tsx` - Card styling, badges
- `frontend/src/components/MapView.tsx` - Dark map style, slider design
