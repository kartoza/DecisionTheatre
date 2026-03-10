# Decision Theatre - Specification

## Overview

Decision Theatre is a desktop application for comparing and analyzing environmental scenarios across geographical catchments. It provides an intuitive interface for exploring data and creating sites (geographical areas) for analysis.

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
- Layout mode (single/quad)
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
- Draggable slider for A/B comparison
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

**Range Mode Options** (for dial chart min/max):
- **Full (Domain)**: Min/max from entire dataset across all catchments
- **Extent**: Min/max from currently visible map area
- **Site**: Min/max from site's aggregated indicator values

### Control Panel (Slide-out)
- Scenario 1 selector (left map)
- Scenario 2 selector (right map)
- Attribute/factor selector
- Color scale mode toggle (Rainbow / Metadata)
- Dial range mode toggle (Full / Extent / Site)
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

### Data
- `GET /api/scenarios` - Available scenarios
- `GET /api/columns` - Available attributes
- `GET /api/choropleth` - GeoJSON for viewport
- `GET /api/catchment/{id}` - Catchment details

### Sites
- `GET /api/sites` - List all sites
- `POST /api/sites` - Create site
- `GET /api/sites/{id}` - Get site
- `PUT /api/sites/{id}` - Update site
- `DELETE /api/sites/{id}` - Delete site
- `POST /api/sites/dissolve-catchments` - Merge catchments into boundary

### Catchments
- `GET /api/catchments/geometry/{id}` - Get full catchment geometry from GeoPackage

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
- Zip files are checked for zip slip vulnerabilities during extraction

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
