# Decision Theatre - Specification

## Overview

Decision Theatre is a desktop application for comparing and analyzing environmental scenarios across geographical catchments. It provides an intuitive interface for exploring data and creating sites (geographical areas) for analysis.

## Run Modes

One binary, two ways to run it. The server is the same in both cases; the difference is
only whether a window is opened onto it.

| Mode | Flag | What happens |
|---|---|---|
| Desktop | *(default)* | The HTTP server starts in-process and an embedded GTK/WebKit WebView window navigates to it. Closing the window shuts the server down. |
| Server | `--headless` | The HTTP server runs with no window, for a browser on this or another machine to connect to. Shuts down on SIGINT/SIGTERM. |

The port is chosen by walking forward from `--port` (default 8080) until a free one is
found, so a second instance never fails to start.

### Launch entry points

Every way of starting the application — `make run`, `make serve`, `nix run`,
`nix run .#serve`, the editor mappings, and `scripts/run-app.sh` directly — routes through
**`scripts/run-app.sh`**. That script is the single definition of launch policy: run mode,
flags, and data directory resolution. The entry points differ only in where the binary
comes from:

- `nix run` sets `DT_MODE` and `DT_BIN` to a reproducible store build, so the script
  skips every build step and only applies launch policy.
- `make run` leaves `DT_BIN` unset, so the script rebuilds whatever is stale (via the
  shared `scripts/lib-build.sh`) before launching.

Per-machine settings live in a gitignored `.dt-env` read by the script, so no entry point
needs its own copy of them.

### Data directory resolution

Resolved once, in `main.go`, so every launch path and a packaged install all agree:

1. the `--data-dir` flag, if given
2. the data pack path recorded in saved settings, if a pack has been installed
3. `./data` in the working directory, **if it already exists**
4. the per-user data directory (`config.DataStoreDir()/data`)

Step 3 tests for existence rather than defaulting unconditionally: on Windows, double-
clicking the executable sets the working directory to the executable's own folder, and an
unconditional `./data` default previously created an empty `data` folder there on every
startup.

## Application Architecture

### Backend (Go)

- **Server**: HTTP server built with Gorilla Mux, embedded static files
- **Data Storage**:
  - GeoPackage (SQLite with spatial extensions) for catchment data
  - MBTiles for vector tiles
  - JSON files for sites

### Frontend (React + TypeScript)

- **UI Framework**: Chakra UI
- **Mapping**: MapLibre GL JS
- **Animations**: Framer Motion, Matter.js (physics)
- **Build**: Vite

---

## Core Features

### 1. Explore Mode

Users can explore catchment data:
- Dual-map comparison with slider
- Scenario selection (Reference, Current, Future)
- Attribute/indicator visualization
- Choropleth coloring with PRISM color scale
- Identify tool for querying catchment attributes
- Zone statistics for visible area

### 2. Site Management

Sites are geographical areas that save the user's boundary and exploration state:

**Workflow:**
1. User explores map
2. Clicks "Create Site" button in sidebar
3. Chooses one of 4 boundary definition methods
4. Provides title, description, and optional thumbnail image
5. Site is saved and can be opened later

**Site data includes:**
- Title and description
- Thumbnail image (auto-generated from map or user-uploaded, stored as base64)
- Site boundary geometry
- Bounding box and area
- Creation method
- Pane states (scenarios and attributes)
- Layout mode (single/grid)
- Map extent (center, zoom)

**Site Gallery (CRUD Operations):**
- **Create**: New sites via the "Create New Site" button
- **Read**: Sites displayed in a grid view with thumbnails
- **Update**: Edit button on each site card opens the site details form
- **Delete**: Delete button with confirmation dialog
- **Clone**: Copy existing site configuration for quick reuse

**When Opening a Site:**
- Map zooms to site bounds with 10% padding
- Site title displayed in header breadcrumb with edit button
- Site boundary displayed with glowing neon effect overlay

**Site Boundary Editing:**
- Pencil icon next to site title enables boundary edit mode
- When active:
  - All polygon vertices displayed as glowing cyan circles
  - Vertices are draggable to reshape the boundary
  - Real-time boundary updates as vertices are moved
  - Edit mode banner shown at top of map
  - Tools panel for adding/removing catchments from boundary

### 3. Site Creation

Sites define geographical areas for analysis. Four creation methods:

#### 3.1 Shapefile Upload
- Upload a `.zip` containing `.shp`, `.shx`, `.dbf` files
- Parsed client-side using shpjs library
- Geometry extracted and displayed on map

#### 3.2 GeoJSON Upload
- Upload `.geojson` or `.json` files
- Supports FeatureCollection, Feature, and raw Geometry
- Multiple features merged into GeometryCollection

#### 3.3 Interactive Drawing
- Click on map to add polygon vertices
- Minimum 3 points required
- Undo last point, clear all points
- Bright chunky outline for visibility
- Polygon automatically closed on confirm

#### 3.4 Catchment Selection
- Click catchments to select/deselect
- Visual highlight for selected catchments
- Geometries from GeoPackage (full resolution, not tiles)
- API dissolves selected catchments into boundary
- Result is a MultiPolygon covering selected area

### Site Data Model
```typescript
interface Site {
  id: string;
  title: string;
  description: string;
  thumbnail: string | null;
  createdAt: string;
  updatedAt: string;

  // Map state
  paneStates?: PaneStates;
  layoutMode?: string;
  focusedPane?: number;
  mapExtent?: MapExtent;

  // Site boundary
  geometry?: GeoJSON.Geometry;
  boundingBox?: BoundingBox;
  area?: number; // km²
  creationMethod?: 'shapefile' | 'geojson' | 'drawn' | 'catchments';
  catchmentIds?: string[]; // if created from catchments;

  // Site indicators (aggregated from catchments)
  indicators?: SiteIndicators;
}

// View mode for each visualization pane
type ViewMode = 'map' | 'chart' | 'dial';

// Range mode for dial chart min/max values
type RangeMode = 'domain' | 'extent' | 'site';
```

---

## User Interface

### Navigation Pages
- **Landing**: Welcome screen with options
- **About**: Information about the application
- **Sites**: Grid view of saved sites
- **Create Site**: 3-step site creation wizard (Method → Boundary → Details)
- **Map**: Main exploration/analysis view

### Map View
- Dual synchronized maps (left/right comparison)
- Draggable slider for A/B comparison (starts at left edge, drag right to reveal left scenario)
- 3D mode with pitch controls
- Identify mode for feature inspection
- Choropleth layers with attribute values
- Catchment outlines at high zoom

### Visualization Modes

Each pane supports three visualization modes, cycled via toolbar button:

#### 4.1 Choropleth Map (Default)
- Geographical display with catchment polygons
- Color intensity based on attribute values
- Dual-scenario comparison with slider
- Zone statistics for visible area

#### 4.2 Line Chart
- Time-series style visualization
- Three series: Reference, Current, Target
- Animated data reveal on view change
- Staggered dot animations

#### 4.3 Dial Chart (Gauge)
- Half-circle gauge visualization
- Shows aggregate values across entire site
- Three needles:
  - **Reference** (orange, dashed): Ecological baseline
  - **Current** (blue, solid primary): Current observed state
  - **Target** (green, dashed): User-defined target
- Gradient arc from green (low) to red (high)
- Animated needle movement with elastic easing
- Center value display with unit

**Range Mode Options** (toggle inside dial chart):
- **Full (Domain)**: Min/max from entire dataset across all catchments
- **Extent**: Min/max from currently visible map area
- **Site**: Min/max from site's aggregated indicator values
- Range mode toggle positioned in top-right of chart
- Re-animates when range, factor, or scenario changes

### Control Panel (Slide-out)
- Scenario 1 selector (left map)
- Scenario 2 selector (right map)
- Attribute/factor selector
- Color scale mode toggle (Rainbow / Metadata) in COLOR SCALE section
- Color scale legend
- Zone statistics
- Identify results table with horizontal bar visualization
  - Each row shows values for both scenarios
  - Left column has bars growing from left edge
  - Right column has bars growing from right edge
  - Bar lengths are proportional (larger value = 100%, smaller value = percentage)
  - Bars use scenario colors at low opacity
- Create Site button (in explore mode)

---

## API Endpoints

### Health & Info
- `GET /health` - Server health check
- `GET /info` - Server version and status

### Tiles
- `GET /tiles/{name}/{z}/{x}/{y}.pbf` - Vector tiles
- `GET /data/style.json` - MapBox style
- `GET /data/tiles.json` - TileJSON metadata

### Fonts
- `GET /fonts/{fontstack}/{range}.pbf` - Glyph proxy (fetched from CDN once, then served locally). The MapTiler key is supplied at run time (`--maptiler-key`, `DT_MAPTILER_API_KEY`, or `maptiler_key` in `settings.json`) and attached here, server-side; it never reaches the client and no key is compiled in. With no key configured the route answers `200` with an empty body and the map draws without labels.

### Data
- `GET /api/scenarios` - Available scenarios
- `GET /api/columns` - Available attributes (from the GeoPackage)
- `GET /api/metadata/{key}` - 15 routes returning lookup maps parsed from `metadata.csv`:
  `colors`, `details`, `variabletypes`, `inputs`, `targetinputs`, `targetranges`,
  `canmap`, `cangraph`, `axislabels`, `xaxislabels`, `units`, `charttypes`,
  `groupingvariables`, `groupingvalues`, `dial0middle`
- `GET /api/choropleth` - GeoJSON for viewport (`valuesOnly=1` returns every catchment's raw value)
- `GET /api/catchment-values` - catchment ids and values for a viewport, no geometry; the
  join payload for the vector-tile choropleth, which sources geometry from
  `catchments_lev12` in the tile pipeline and applies values as MapLibre feature state
- `GET /api/scenario/{scenario}/{attribute}` - Attribute values for all catchments
- `GET /api/catchment/{id}` - Catchment details
- `GET /api/aggregate` - Area-weighted aggregates for an extent
- `GET /api/precalculate/full` - Precomputed full-domain means (cached server-side)
- `GET /api/compare` - Scenario comparison data

### Tilesets
- `GET /api/tilesets` - Available tileset names
- `GET /api/tilesets/{name}/metadata` - MBTiles metadata for one tileset

### Sites

A user's own sites live in their browser, not on the server — that is the design
brief, and the client honours it: in browser runtime it reads and writes the
`dt-sites` localStorage key with no fallthrough to the API. The CRUD below therefore
exists **only in the desktop build**, where the browser is a WebView with no
persistent storage of its own. In server mode these routes are absent from the route
table entirely rather than answering 403, so no handler code is reachable.

- `GET /api/sites` - List all sites *(desktop only)*
- `POST /api/sites` - Create site *(desktop only)*
- `GET /api/sites/{id}` - Get site *(desktop only)*
- `PUT|PATCH /api/sites/{id}` - Update site *(desktop only)*
- `DELETE /api/sites/{id}` - Delete site *(desktop only)*
- `POST /api/sites/dissolve-catchments` - Merge catchments into boundary

`dissolve-catchments` is not gated: it computes in, returns a result, and persists
nothing.

### Site Indicators
- `GET /api/sites/{id}/indicators` - Aggregated indicator values
- `POST /api/sites/{id}/indicators` - Extract indicators from constituent catchments
- `PATCH /api/sites/{id}/indicators` - Update user-set values, triggering recalculation
- `POST /api/sites/{id}/indicators/reset` - Reset ideal values to current *(desktop only)*
- `GET|POST /api/sites/{id}/catchments` - Per-catchment breakdown with AOI fractions
- `GET|POST /api/sites/{id}/whiskers` - Whisker (upper/lower bound) values

### Boundary Editing

Both write to a stored site, so both are desktop only. The browser build does the
same work locally against its own copy in localStorage.

- `POST /api/sites/{id}/boundary/union/{catchmentId}` - Add a catchment to the boundary *(desktop only)*
- `POST /api/sites/{id}/boundary/difference/{catchmentId}` - Remove a catchment *(desktop only)*

### Catchments
- `GET /api/catchments/bounds` - Bounding box of the catchment dataset
- `GET /api/catchments/geometry/{id}` - Get full catchment geometry from GeoPackage
- `POST /api/catchments/in-bbox` - Catchments intersecting a bounding box

### Data Pack and Downloads
- `GET /api/datapack/status` - Install state and progress
- `POST /api/datapack/install` - Install from a local archive path (**destructive**, desktop runtime only)
- `GET /api/datapack/download-info` - Metadata for the configured downloadable archive
- `GET /api/datapack/download` - Stream the archive
- `GET /api/executables/info` - Per-platform executable availability
- `GET /api/executables/download/{platform}` - Stream a platform executable
- `POST /api/dialog/open-file` - Open a native file dialog *(desktop only)*

### Static Content
- `/data/images/` - Site thumbnails
- `/data/walkthroughs/` - Read-only demo site JSON
- `/data/demo/` - Guided tour assets
- `/docs/` - Embedded documentation site
- `/` - SPA fallback

---

## Data Storage

### File Locations
- `data/sites/` - Site JSON files
- `data/images/` - Site thumbnails
- `data/datapack.gpkg` - Catchment geometries and scenario data

### GeoPackage Tables
- `catchments_lev12` - Catchment polygons with HYBAS_ID and geojson column
- `scenario_current` - Current scenario attributes
- `scenario_reference` - Reference scenario attributes
- `domain_minima` - Minimum values per attribute
- `domain_maxima` - Maximum values per attribute
- `rtree_catchments_lev12_geom` - Spatial index

### Data Contract and Tooling

What a valid data directory contains is declared once, in
`internal/datacheck/spec.go`: every file and GeoPackage table the runtime reads, whether
it is required, the source location that reads it, and what breaks without it.

Two subcommands of the application consume that declaration:

| Command | Purpose |
|---|---|
| `decision-theatre check-data [DIR]` | Validate a data directory and render a report. Exit `0` clean, `1` errors, `2` unreadable. `--json` for tooling. |
| `decision-theatre pack-data [DIR]` | Run the check, then assemble the runtime files into a distributable zip. Refuses on errors unless `--force`. |

They are subcommands rather than separate tools so that they open the data through the
same packages the running application uses — `internal/geodata` for the GeoPackage,
`internal/tiles.NewMBTilesStore` for the tilesets. What the checker can read, the
application can read.

`internal/datacheck/spec_test.go` reads the runtime packages back and fails the build if
the code references a table or a data file the spec does not describe, so the contract
cannot silently fall behind the code.

#### File roles

Every entry in a data directory is classified into one of four roles, which determines
whether it belongs in a data pack:

| Role | Examples | Packed |
|---|---|---|
| Runtime | `datapack.gpkg`, `mbtiles/`, `metadata.csv`, lookups, `walkthroughs/`, `demo/` | Yes |
| Build input | `catchments.gpkg`, `current*.csv`, `reference*.csv` | No — inputs to `scripts/build-geopackage.sh` |
| User data | `sites/`, `images/` | No — belongs to the installation |
| Extraneous | anything else | No — reported as a warning |

#### Data pack manifest

A pack carries `manifest.json` both inside the archive and beside it, recording the
format, version, packaging timestamp, the tool that built it, the checker's verdict at
build time, a per-file SHA-256 inventory, and an explanation of everything excluded. The
installer reads `format`, `version`, `description` and `created`, and ignores the rest, so
packs remain readable by older builds.

---

## Visual Design

### Color Palette
- **Brand**: `#2bb0ed` (Cyan blue)
- **Accent**: `#4caf50` (Green)
- **Reference**: `#e65100` (Orange)
- **Current**: `#2bb0ed` (Blue)
- **Future**: `#4caf50` (Green)

### Site Creation Colors
- **Primary**: `#00FFFF` (Cyan)
- **Secondary**: `#FF00FF` (Magenta)
- **Accent**: `#FFFF00` (Yellow)
- **Glow**: `#00FF88` (Electric Green)

### PRISM Color Scale
8-color spectrum for choropleth:
```
Violet → Indigo → Blue → Cyan → Green → Yellow → Orange → Red
```

---

## Animations

### Framer Motion
- Page transitions (fade, slide)
- Pane switching (staggered scale)
- Button hover effects
- Modal/overlay animations

### Matter.js Physics
- Polygon drop animation for site creation
- Gravity-based settling
- Bounce and friction physics
- "Thunk" effect when settled

---

## Performance Considerations

- GeoJSON caching with 300ms debounce
- One shared, cancellable request per distinct question (`frontend/src/lib/sharedRequest.ts`):
  every pane asking the same thing at the same moment produces one request, and a
  request the user's next interaction has made pointless is aborted rather than
  merely ignored. Applies to `/api/choropleth`, `/api/catchment-values` and
  `/api/aggregate`. Requests carrying site ideal overrides are deliberately
  excluded — the URL is not the whole of the question for those.
- Choropleth responses are applied in request order: a run superseded by a later
  one never paints, so an out-of-order completion cannot leave the map showing a
  viewport, scenario or attribute the user has left
- Aggregate fetches are scoped to the range mode, so panning does not re-request
  full-domain values that cannot have changed
- Viewport-limited choropleth queries (max 2000 features)
- Pre-computed geojson column in GeoPackage
- R-tree spatial index for fast bbox queries
- Efficient SQLite queries via GeoPackage

---

## Security Considerations

### SQL Injection Prevention
- Attribute names are validated against an allowlist of known columns before use in queries
- The `isValidColumn()` method in `GpkgStore` checks against `s.columns` to prevent injection

### Input Validation
- Site titles and descriptions are trimmed before storage
- File uploads are validated for type and size
- Zip files are checked for zip slip vulnerabilities during extraction (both the `.zip`
  and `.7z` extractors)

### Network exposure

- **The server binds loopback by default.** `config.DefaultBindAddress` is
  `127.0.0.1`, and the zero value of `Config.BindAddress` resolves to it, so a caller
  that forgets the field does not publish to the network. `--bind 0.0.0.0` is explicit
  and is what the container deployment passes, where nginx in front of it controls
  access.

### Desktop-only routes

Two routes are registered only when `Config.DesktopMode` is true — that is, only when
the process owns a desktop session and has opened the WebView window. In server mode
they are absent rather than present-and-refusing, so there is nothing for a remote
caller to probe:

- `POST /api/dialog/open-file` — calls a native file picker on the machine's desktop
  and blocks until a human answers it.
- `POST /api/datapack/install` — replaces the contents of the data directory with
  whatever it finds at a filesystem path. That path can only come from the file dialog
  above, so on a hosted deployment there was no legitimate way to use it.

### Path confinement

Thumbnail paths are validated on write and on read. `saveThumbnail` writes only into
the images directory; `validThumbnailPath` rejects anything that escapes it, and
`resolveThumbnailFile` confines the resolved path, so a site cannot be made to delete a
file elsewhere on disk when it is removed.

### Request limits

Every JSON handler reads through a body size limit rather than decoding directly from
`r.Body`.

### Known gaps (tracked, not yet implemented)

Stated here so the specification describes the system as it is, not as intended. Each
has a corresponding issue.

- **No authentication on any endpoint.** The API is unauthenticated, and
  `deployments/nginx.conf` proxies every path without a denylist. The desktop-only
  gating above removes the two routes that made this acute, but it is not
  authentication.
- **No `context.Context` on database calls**, so a client disconnect does not cancel
  the work it started.

Attribute names are validated by `isValidColumn()` before interpolation, but SQL is
assembled with `fmt.Sprintf` throughout `gpkg_store.go`; the pattern is safe by
convention rather than by construction.

---

## Code Organization

### Backend Packages (`internal/`)
- **api**: HTTP handlers for REST endpoints
- **config**: Application configuration and settings persistence
- **geodata**: GeoPackage data access
- **httputil**: Shared HTTP response utilities
- **server**: HTTP server setup and routing
- **sites**: Site CRUD operations and JSON persistence
- **tiles**: MBTiles vector tile serving

### Frontend Structure (`frontend/src/`)
- **components/**: React UI components
- **hooks/**: Custom React hooks (API, map sync)
- **types/**: TypeScript interfaces and storage utilities
- **styles/**: Chakra UI theme configuration
