# Decision Theatre - Specification

## Overview

Decision Theatre is a desktop application for comparing and analyzing environmental scenarios across geographical catchments. It provides an intuitive interface for exploring data, creating sites, and managing projects.

## Application Architecture

### Backend (Go)

- **Server**: HTTP server built with Gorilla Mux, embedded static files
- **Data Storage**:
  - GeoPackage (SQLite with spatial extensions) for catchment data
  - MBTiles for vector tiles
  - JSON files for projects and sites

### Frontend (React + TypeScript)

- **UI Framework**: Chakra UI
- **Mapping**: MapLibre GL JS
- **Animations**: Framer Motion, Matter.js (physics)
- **Build**: Vite

---

## Core Features

### 1. Explore Mode

Users can explore catchment data without creating a project:
- Dual-map comparison with slider
- Scenario selection (Reference, Current, Future)
- Attribute/indicator visualization
- Choropleth coloring with PRISM color scale
- Identify tool for querying catchment attributes
- Zone statistics for visible area

### 2. Project Management

Projects save the user's exploration state for later retrieval:
- **Create**: From explore mode with current settings
- **Clone**: Duplicate existing projects
- **Delete**: Remove projects (with confirmation)
- **Open**: Restore saved state and continue working

Project data includes:
- Title and description
- Thumbnail image (auto-cropped to 16:9)
- Pane states (scenarios and attributes)
- Layout mode (single/quad)
- Map extent (center, zoom)

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
- API dissolves selected catchments into boundary
- Result is a MultiPolygon covering selected area

### Site Data Model
```typescript
interface Site {
  id: string;
  name: string;
  description: string;
  thumbnail: string | null;
  geometry: GeoJSON.Geometry;
  boundingBox: BoundingBox;
  area: number; // km²
  creationMethod: 'shapefile' | 'geojson' | 'drawn' | 'catchments';
  catchmentIds: string[]; // if created from catchments
  createdAt: string;
  updatedAt: string;
}
```

---

## User Interface

### Navigation Pages
- **Landing**: Welcome screen with options
- **About**: Information about the application
- **Projects**: Grid view of saved projects
- **Create Project**: Form for new project with thumbnail
- **Create Site**: Multi-step site creation wizard
- **Map**: Main exploration/analysis view

### Map View
- Dual synchronized maps (left/right comparison)
- Draggable slider for A/B comparison
- 3D mode with pitch controls
- Identify mode for feature inspection
- Choropleth layers with attribute values
- Catchment outlines at high zoom

### Control Panel (Slide-out)
- Scenario 1 selector (left map)
- Scenario 2 selector (right map)
- Attribute/factor selector
- Color scale legend
- Zone statistics
- Identify results table
- Create Site / Create Project buttons (in explore mode)

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

### Projects
- `GET /api/projects` - List all projects
- `POST /api/projects` - Create project
- `GET /api/projects/{id}` - Get project
- `PUT /api/projects/{id}` - Update project
- `DELETE /api/projects/{id}` - Delete project

### Sites
- `GET /api/sites` - List all sites
- `POST /api/sites` - Create site
- `GET /api/sites/{id}` - Get site
- `PUT /api/sites/{id}` - Update site
- `DELETE /api/sites/{id}` - Delete site
- `POST /api/sites/dissolve-catchments` - Merge catchments into boundary

---

## Data Storage

### File Locations
- `data/projects/` - Project JSON files
- `data/sites/` - Site JSON files
- `data/images/` - Thumbnails (project and site)
- `data/datapack.gpkg` - Catchment geometries and scenario data

### GeoPackage Tables
- `catchments_lev12` - Catchment polygons with HYBAS_ID
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
- Lazy loading of Arrow/Parquet files
