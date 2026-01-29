# API Guide

Decision Theatre exposes a REST API on the same port as the web UI. All endpoints are prefixed with `/api/` or serve tiles.

## Server Information

### `GET /api/info`

Returns the current server status and available features.

**Response:**

```json
{
  "version": "0.1.0",
  "tiles_loaded": true,
  "geo_loaded": true,
  "llm_available": false,
  "nn_available": false,
  "scenarios": ["past", "present", "future"],
  "attributes": ["rainfall", "temperature", "land_cover"]
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Application version |
| `tiles_loaded` | boolean | Whether MBTiles data was found and opened |
| `geo_loaded` | boolean | Whether GeoParquet scenario data is available |
| `llm_available` | boolean | Whether an LLM model is loaded |
| `nn_available` | boolean | Whether a neural network model is loaded |
| `scenarios` | string[] | List of available scenario names |
| `attributes` | string[] | List of available catchment attributes |

## Scenario Data

### `GET /api/scenarios/{scenario}/{attribute}`

Returns GeoJSON FeatureCollection with catchment geometries coloured by the specified attribute.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `scenario` | path | Scenario name (e.g., `past`, `present`, `future`) |
| `attribute` | path | Attribute name to colour by |

**Response:** GeoJSON FeatureCollection

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

## LLM Chat

### `POST /api/chat`

Sends a message to the embedded LLM (when available).

**Request:**

```json
{
  "message": "What factors affect catchment health?"
}
```

**Response:**

```json
{
  "response": "Several factors influence catchment health..."
}
```

Returns `503 Service Unavailable` if no LLM model is loaded.

## Static Assets

All other routes serve the embedded React SPA. The server implements SPA routing by returning `index.html` for any path not matching the above patterns.
