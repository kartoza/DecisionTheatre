# API Guide

Landscape Decision Theatre exposes a REST API on the same port as the web UI. All endpoints are prefixed with `/api/` or serve tiles.

## Server Information

### `GET /api/info`

Returns the current server status and available features.

**Response:**

```json
{
  "version": "0.1.0",
  "tiles_loaded": true,
  "geo_loaded": true,
  "scenarios": ["reference", "current", "future"],
  "attributes": ["rainfall", "temperature", "land_cover"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Application version |
| `tiles_loaded` | boolean | Whether MBTiles data was found and opened |
| `geo_loaded` | boolean | Whether GeoParquet scenario data is available |
| `scenarios` | string[] | List of available scenario names |
| `attributes` | string[] | List of available catchment attributes |

## Projects

### `GET /api/projects`

Returns a list of all projects, sorted by creation date (newest first).

**Response:**

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "title": "Catchment Analysis Q1",
    "description": "Analysis of rainfall patterns",
    "thumbnail": "/images/projects/550e8400-e29b-41d4-a716-446655440000.jpg",
    "createdAt": "2026-02-03T10:15:30Z",
    "updatedAt": "2026-02-03T14:22:15Z"
  }
]
```

### `GET /api/projects/{id}`

Returns a single project by ID.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | path | Project UUID |

**Response:** Project object (see above)

### `POST /api/projects`

Creates a new project.

**Request Body:**

```json
{
  "title": "My New Project",
  "description": "Optional description",
  "thumbnail": "data:image/jpeg;base64,/9j/4AAQ..."
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Project title |
| `description` | string | No | Project description |
| `thumbnail` | string | No | Base64-encoded image data URI |

**Response:** Created project object with generated ID

### `PUT /api/projects/{id}`

Updates an existing project.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | path | Project UUID |

**Request Body:** Same as POST

**Response:** Updated project object

### `DELETE /api/projects/{id}`

Deletes a project and its associated thumbnail image.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `id` | path | Project UUID |

**Response:** `204 No Content` on success

## Scenario Data

### `GET /api/scenarios/{scenario}/{attribute}`

Returns attribute values for all catchments in a scenario.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `scenario` | path | Scenario name (`reference`, `current`, `future`) |
| `attribute` | path | Attribute name to retrieve |

**Response:**

```json
{
  "1234567890": 45.2,
  "1234567891": 62.8,
  "1234567892": 31.5
}
```

Returns a map of catchment IDs (HYBAS_ID) to attribute values.

## Vector Tiles

### `GET /tiles/{z}/{x}/{y}.pbf`

Serves Mapbox Vector Tiles from the loaded MBTiles file.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `z` | path | Zoom level |
| `x` | path | Tile column |
| `y` | path | Tile row |

**Response:** Protocol Buffer (application/x-protobuf) with gzip encoding.

Returns `404` if the tile does not exist.

### `GET /tiles/metadata`

Returns the MBTiles metadata as JSON.

**Response:**

```json
{
  "name": "catchments",
  "format": "pbf",
  "minzoom": "2",
  "maxzoom": "15",
  "bounds": "-25.3,-46.9,63.5,37.5",
  "center": "19.1,-4.7,6"
}
```

## Map Style

### `GET /styles/uow_tiles.json`

Returns the MapBox GL Style JSON used to render the vector tiles.

## Images

### `GET /images/{path}`

Serves uploaded images (project thumbnails).

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `path` | path | Image file path relative to `data/images/` |

## Static Assets

All other routes serve the embedded React SPA. The server implements SPA routing by returning `index.html` for any path not matching the above patterns.
