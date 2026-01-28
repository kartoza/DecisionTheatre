# REQ-002: React Frontend

| Field | Value |
|-------|-------|
| **Component** | Frontend |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a developer, when I build the application, I should have a modern React-based single-page application that is compiled and embedded into the Go binary. |
| **Importance** | Critical |

## Wireframe

```
┌──────────────────────────────────────────────┐
│ [Header Bar]                                 │
├──────────────────────────────────────────────┤
│                                              │
│  ┌────────────────────────┐  ┌────────────┐ │
│  │                        │  │  Control   │ │
│  │     Map View           │  │  Panel     │ │
│  │  (MapLibre GL JS)      │  │            │ │
│  │                        │  │  Scenarios │ │
│  │                        │  │  Factors   │ │
│  └────────────────────────┘  └────────────┘ │
└──────────────────────────────────────────────┘
```

## Implementation Details

- React 18 with TypeScript for type safety
- Vite as the build tool for fast development and optimized production builds
- The production build output is copied to `internal/server/static/` for Go embedding
- Component architecture: App, Header, MapView, ControlPanel
- Custom hooks for API data fetching (`useApi.ts`)
- All dependencies bundled locally - no CDN or external requests
- Code splitting via Vite's `manualChunks` for optimal loading

### Key Files

- `frontend/package.json` - Dependencies and scripts
- `frontend/src/main.tsx` - Application entry point
- `frontend/src/App.tsx` - Root component
- `frontend/vite.config.ts` - Build configuration
