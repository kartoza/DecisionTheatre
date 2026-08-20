# API Guide

Landscape Decision Theatre exposes a REST API on the same port as the web UI. Application
endpoints are prefixed with `/api/`; tiles, fonts, static data and the documentation site
are served from their own prefixes.

<figure markdown>
  ![Route map showing every registered HTTP route grouped by path prefix](../assets/diagrams/generated/api-routes.svg)
  <figcaption class="gen">
    parsed from
    <code>internal/api/handler.go</code> and <code>internal/server/server.go</code>.
    Add or remove a route and this redraws on the next docs build.
  </figcaption>
</figure>

!!! danger "Unauthenticated by design — review before exposing"
    No endpoint requires authentication, and several are destructive
    (`POST /api/datapack/install` removes the data directory before extracting). The
    server currently binds all interfaces, and `deployments/nginx.conf` proxies every path
    without a denylist.

    Do not expose this API to an untrusted network until the hardening tickets are
    resolved: *Unauthenticated datapack install destroys the data directory*,
    *handleFileDialog opens a native OS modal in response to an HTTP request*,
    *HTTP server binds 0.0.0.0 while the code claims it binds localhost*,
    *No request body size limits on any JSON handler*.

!!! note "Compression"
    JSON responses over 1 KB are gzipped when the client offers `Accept-Encoding: gzip`.
    See *Response compression* in `internal/server/compress.go` for the level and why.

## Server Information

### `GET /api/health`

Liveness check. Returns `200` with a minimal JSON body.

### `GET /api/info`

Returns the current server status and available features. The frontend uses this on
startup to decide whether to show the Setup Guide.

**Response:**

```json
{
  "version": "0.2.0",
  "tiles_loaded": true,
  "geo_loaded": true
}
```

| Field | Type | Description |
|-------|------|-------------|
| `version` | string | Application version |
| `tiles_loaded` | boolean | Whether MBTiles data was found and opened |
| `geo_loaded` | boolean | Whether GeoPackage scenario data is available |

## Tilesets

### `GET /api/tilesets`

Returns the list of available tileset names.

### `GET /api/tilesets/{name}/metadata`

Returns the MBTiles metadata for one tileset as JSON.

**Response:**

```json
{
  "name": "africa",
  "format": "pbf",
  "minzoom": "2",
  "maxzoom": "15",
  "bounds": "-17.5,-34.8,63.5,37.4",
  "center": "22.977,1.258,4"
}
```

## Metadata and Columns

### `GET /api/columns`

The authoritative list of attribute columns present in the GeoPackage. Sourced from the
data, not from `metadata.csv`.

### `GET /api/scenarios`

Returns the available scenario names.

### `GET /api/metadata/{key}`

Fifteen routes, each returning one lookup map parsed from `metadata.csv`, keyed by column
name:

| Route | Contents |
|---|---|
| `colors` | Preferred display colour per column |
| `details` | Human-readable descriptions |
| `variabletypes` | Highest-level grouping per column |
| `inputs` | User-input flags |
| `targetinputs` | Target-input flags |
| `targetranges` | Acceptable target ranges |
| `canmap` | `MapthisYN` — eligible for map/dial/table view |
| `cangraph` | `graphthisYN` — eligible for chart view |
| `axislabels` | Y-axis labels |
| `xaxislabels` | X-axis tick labels |
| `units` | Display units |
| `charttypes` | `typeofgraph` — line, boxplot, dial |
| `groupingvariables` | Grouping variable per column |
| `groupingvalues` | Values available per grouping variable |
| `dial0middle` | Whether the dial centres on zero |

See [Datapack Format](datapack-format.md#metadatacsv-column-reference) for column
semantics, and [Architecture](architecture.md#factor-selection-metadatacsv-to-chart-view)
for how these drive the selectors.

## Scenario and Catchment Data

### `GET /api/scenario/{scenario}/{attribute}`

Returns attribute values for all catchments in a scenario.

| Parameter | Type | Description |
|-----------|------|-------------|
| `scenario` | path | `reference`, `current` or `future` |
| `attribute` | path | Attribute column name |

Returns a map of catchment IDs (HYBAS_ID) to values:

```json
{ "1121879850": 45.2, "1121881430": 62.8 }
```

### `GET /api/catchment/{id}`

Returns all attribute values for one catchment across all loaded scenarios. Returns `404`
if the ID is not found.

### `GET /api/choropleth`

<<<<<<< HEAD
The main map data endpoint. Returns a GeoJSON `FeatureCollection` of catchment polygons
with the requested attribute in each feature's properties — unless `valuesOnly=1`, which
returns the columnar shape described below.
=======
Returns a GeoJSON `FeatureCollection` of catchment polygons with the requested attribute
in each feature's properties. Used below the zoom range covered by the catchment vector
tiles, where the server returns grid-aggregated cells rather than catchments; above it the
map uses `/api/catchment-values` against the tiled geometry instead.
>>>>>>> origin/main

| Query parameter | Description |
|---|---|
| `scenario` | `reference`, `current` or `future`. With `valuesOnly=1`, a comma-separated list of up to three of them |
| `attribute` | Attribute column name |
| `minx`, `miny`, `maxx`, `maxy` | Viewport bounding box |
| `zoom` | Current map zoom; selects the server-side aggregation tier. Ignored when `valuesOnly=1` |
| `siteId` | Optional; applies site-specific ideal overrides to the `future` scenario |
| `valuesOnly` | `1` bypasses zoom aggregation and returns every catchment's raw value, columnar |

#### `valuesOnly=1`

For statistics, not for rendering: no zoom aggregation, no feature limit, every catchment
in the bounding box with a value. There is no geometry, so the response is not a
`FeatureCollection` — it is parallel arrays, discriminated by `"type": "CatchmentValues"`.

```json
{
  "type": "CatchmentValues",
  "attribute": "NPP_gm2",
  "scenarios": ["current"],
  "ids": [1121879850, 1121879851],
  "values": [1234.5678901234, 2.5],
  "domain_min": 0,
  "domain_max": 9999
}
```

Naming several scenarios returns `series` in place of `values`, one array per scenario,
all aligned to the single `ids` array:

```json
{
  "type": "CatchmentValues",
  "attribute": "NPP_gm2",
  "scenarios": ["current", "reference"],
  "ids": [1121879850, 1121879851],
  "series": {
    "current": [1234.5678901234, 2.5],
    "reference": [987.65432109876, null]
  },
  "domain_min": 0,
  "domain_max": 9999
}
```

- A `null` in a series means that scenario has no value for that catchment. The scenarios'
  NULL sets need not agree, and one shared `ids` array has to be able to say so.
- `domain_min`/`domain_max` are reported for the first scenario named. They are
  scenario-dependent, and a multi-scenario response has no single answer; callers of this
  endpoint compute their own min/max from the values.
- An unrecognised scenario name is a `400`. The `FeatureCollection` path is lenient here
  and reads `scenario_current`; this path takes a caller-supplied list, so it says no.

Asking for both scenarios of a comparison in one request is the intended use: they always
want the same extent and attribute, and the response is dominated by the `ids` column,
which one request sends once where two sent it twice.

### `GET /api/catchment-values`

The values half of the vector-tile choropleth: every catchment's value for one attribute
within a viewport, with **no geometry at all**. Geometry comes from the tile pipeline and
is reused across attributes, so this is the only thing a pan or an indicator change has to
move over the wire. The response is two index-aligned arrays rather than one object per
catchment, which at these sizes is roughly an order of magnitude smaller than the
equivalent `FeatureCollection` scaffolding.

| Query parameter | Description |
|---|---|
| `scenario` | `reference`, `current` or `future` |
| `attribute` | Attribute column name |
| `minx`, `miny`, `maxx`, `maxy` | Viewport bounding box |
| `siteId` | Optional; applies site-specific ideal overrides (`future` only) |

```json
{
  "scenario": "current",
  "attribute": "rainfall_mm",
  "ids": [1120000010, 1120000011],
  "values": [812.4, 903.1],
  "domain_min": 0,
  "domain_max": 2400
}
```

The `domain_min`/`domain_max` are resolved exactly as `/api/choropleth` resolves them, so
the colour scale does not shift when the map crosses between the two transports.

### `GET /api/aggregate`

Area-weighted aggregate values for the requested extent and columns.

### `GET /api/precalculate/full`

Precomputed full-domain area-weighted means for all attributes, for reference and current.
Cached server-side after the first computation.

### `GET /api/compare`

Comparison data between two scenarios.

### `GET /api/catchments/bounds`

Returns the bounding box of the catchment dataset.

### `GET /api/catchments/geometry/{id}`

Returns the geometry for a single catchment.

### `POST /api/catchments/in-bbox`

Returns catchments intersecting a bounding box.

**Request body:**

```json
{ "minX": 30.0, "minY": -26.0, "maxX": 32.0, "maxY": -24.0, "limit": 500 }
```

## Sites

A **site** is a saved study area: a boundary, its view layout, and its indicator values.
In the WebView runtime these are JSON files under `data/sites/`; in the browser runtime
they live in `localStorage` and these endpoints are largely bypassed.

### `GET /api/sites`

Returns all sites, sorted by creation date, newest first.

```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "title": "Munywana Conservancy",
    "description": "Catchments across the conservancy",
    "thumbnail": "/data/images/550e8400-e29b-41d4-a716-446655440000.jpg",
    "createdAt": "2026-02-03T10:15:30Z",
    "updatedAt": "2026-02-03T14:22:15Z"
  }
]
```

### `GET /api/sites/{id}`

Returns a single site. `404` if not found.

### `POST /api/sites`

Creates a site.

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `title` | string | Yes | Site title |
| `description` | string | No | Site description |
| `geometry` | GeoJSON | Yes | Site boundary |
| `creationMethod` | string | Yes | `shapefile`, `geojson`, `drawn` or `catchments` |
| `catchmentIds` | string[] | No | Present when created from catchment selection |
| `thumbnail` | string | No | Base64 data URI, saved to `data/images/` |

### `PUT` / `PATCH /api/sites/{id}`

Updates a site. Accepts the same fields as `POST`.

!!! danger "Input validation gap"
    A `thumbnail` value that is not a `data:image` URI is currently stored verbatim and
    is later joined onto the data directory and deleted when the site is deleted.
    Ticket: *Thumbnail path traversal allows arbitrary file deletion*.

### `DELETE /api/sites/{id}`

Deletes a site and its thumbnail. `204 No Content` on success.

### `POST /api/sites/dissolve-catchments`

Dissolves a set of catchments into a single boundary. This is the correct pattern for
deriving geometry from the study area — the client sends identifiers and receives geometry.

**Request body:**

```json
{ "catchmentIds": ["1121879850", "1121881430"] }
```

**Response:**

```json
{ "geometry": { "type": "MultiPolygon", "coordinates": [] }, "boundingBox": {}, "area": 0 }
```

!!! bug "`area` is always zero"
    The `area` field is currently hardcoded to `0` upstream in `DissolveCatchments` and
    has never returned a real value. Do not rely on it.
    Ticket: *Dissolved catchment area is always reported as zero*.

## Site Indicators

### `GET /api/sites/{id}/indicators`

Returns the site's aggregated indicator values.

### `POST /api/sites/{id}/indicators`

Extracts indicators for the site from its constituent catchments. In the browser runtime
the request body carries the site object, since the server has no stored copy.

### `PATCH /api/sites/{id}/indicators`

Updates user-set indicator values (ideal values and their bounds) and triggers ecological
recalculation.

!!! warning "Expected to change"
    This handler currently reads, mutates and writes the site with no per-site lock, so
    two concurrent updates lose one of the results.
    Ticket: *Concurrent indicator saves lose updates, and site writes are not atomic*.

### `POST /api/sites/{id}/indicators/reset`

Resets ideal values back to current.

### `GET` / `POST /api/sites/{id}/catchments`

Returns the per-catchment breakdown for a site, including `areaKm2` and `aoiFraction`.
`POST` accepts a site body for browser-runtime sites the server has never stored.

### `GET` / `POST /api/sites/{id}/whiskers`

Returns whisker (upper/lower bound) values for the site.

## Boundary Editing

### `POST /api/sites/{id}/boundary/union/{catchmentId}`

Adds a catchment to the site boundary and returns the updated geometry.

### `POST /api/sites/{id}/boundary/difference/{catchmentId}`

Removes a catchment from the site boundary and returns the updated geometry.

Both return:

```json
{ "geometry": {}, "boundingBox": {}, "area": 0.0 }
```

## Data Pack Management

### `GET /api/datapack/status`

Returns the current install state — idle, installing (with progress), or failed.

### `POST /api/datapack/install`

Installs a data pack from a local archive path.

!!! danger "Destructive and unauthenticated"
    This handler accepts an arbitrary filesystem path, validates only the `.zip`/`.7z`
    suffix, and recursively deletes the data directory before extracting. It must not be
    reachable from an untrusted network.
    Ticket: *Unauthenticated datapack install destroys the data directory*.

### `POST /api/dialog/open-file`

Opens a native file-picker dialog on the host and returns the chosen path. Intended for
the desktop runtime only.

!!! danger "Desktop-only endpoint, currently always registered"
    In server mode this opens a window on the host's desktop and blocks a request
    goroutine until a human responds.
    Ticket: *handleFileDialog opens a native OS modal in response to an HTTP request*.

## Browser Downloads

These endpoints serve the distributable datapack archive and platform executables for
direct browser download. They are only relevant in **browser runtime** (server deployment);
the desktop app installs the data pack via the setup guide from a local file.

All paths are configured in `settings.json`. See
[Server Deployment — Enabling Browser Downloads](server-deployment.md#3-enabling-browser-downloads-executables-and-data-pack)
for full setup instructions.

### `GET /api/datapack/download-info`

Returns metadata about the configured downloadable archive. The frontend uses this
endpoint on page load to decide whether to show the download button.

**Response when an archive is configured:**

```json
{
  "available": true,
  "filename": "decision-theatre-data-v1.0.0.7z",
  "size_bytes": 9876543210
}
```

**Response when no archive is configured:**

```json
{
  "available": false
}
```

| Field | Type | Description |
|-------|------|-------------|
| `available` | boolean | `true` if `data_pack_download_path` is set and the file exists |
| `filename` | string | Base filename of the archive (omitted when `available` is `false`) |
| `size_bytes` | integer | File size in bytes (omitted when `available` is `false`) |

---

### `GET /api/datapack/download`

Streams the configured archive file to the client as an attachment.

**Response headers:**

| Header | Value |
|--------|-------|
| `Content-Disposition` | `attachment; filename="<archive-filename>"` |
| `Content-Type` | `application/octet-stream` |
| `Content-Length` | File size in bytes |

**Error responses:**

| Status | Condition |
|--------|-----------|
| `404 Not Found` | `data_pack_download_path` is not configured or the file does not exist |
| `500 Internal Server Error` | The file exists but cannot be opened |

---

### `GET /api/executables/info`

Returns availability metadata for each platform executable. The frontend uses this on the
Download page to decide which platform cards to show as downloadable.

**Response:**

```json
{
  "windows": { "available": true,  "filename": "decision-theatre-v1.0.0-windows.exe",          "size_bytes": 45678901 },
  "linux":   { "available": true,  "filename": "decision-theatre-linux-amd64-v1.0.0.tar.gz",   "size_bytes": 23456789 },
  "macos":   { "available": false }
}
```

Each platform object:

| Field | Type | Description |
|-------|------|-------------|
| `available` | boolean | `true` if the path is set in `settings.json` and the file exists |
| `filename` | string | Base filename (omitted when `available` is `false`) |
| `size_bytes` | integer | File size in bytes (omitted when `available` is `false`) |

---

### `GET /api/executables/download/{platform}`

Streams the executable for the requested platform as a file attachment.

**Path parameters:**

| Parameter | Values | Description |
|-----------|--------|-------------|
| `platform` | `windows`, `linux`, `macos` | Target platform |

**Response headers:**

| Header | Value |
|--------|-------|
| `Content-Disposition` | `attachment; filename="<filename>"` |
| `Content-Type` | `application/octet-stream` |
| `Content-Length` | File size in bytes |

**Error responses:**

| Status | Condition |
|--------|-----------|
| `400 Bad Request` | `platform` is not one of `windows`, `linux`, `macos` |
| `404 Not Found` | Path not configured in `settings.json` or file does not exist |
| `500 Internal Server Error` | File exists but cannot be opened |

---

## Vector Tiles

### `GET /tiles/{name}/{z}/{x}/{y}.pbf`

Serves Mapbox Vector Tiles from the named MBTiles tileset.

| Parameter | Type | Description |
|-----------|------|-------------|
| `name` | path | Tileset name, e.g. `africa` |
| `z` | path | Zoom level |
| `x` | path | Tile column |
| `y` | path | Tile row |

**Response:** Protocol Buffer (`application/x-protobuf`) with `Content-Encoding: gzip`
and `Access-Control-Allow-Origin: *`. Returns `404` if the tile does not exist.

Up to three auxiliary listeners on the following ports serve this same route, to work
around per-origin connection limits in grid view. See
[Architecture](architecture.md#auxiliary-tile-servers).

## Style, TileJSON and Fonts

### `GET /data/style.json`

Returns the MapLibre GL style used to render the vector tiles, read from
`data/mbtiles/style.json` (currently falling back to the resources directory — a fallback
that is being removed) with tile URLs
rewritten to match the running host and port.

### `GET /data/tiles.json`

Returns TileJSON for the loaded tileset.

### `GET /fonts/{fontstack}/{range}.pbf`

Proxies MapLibre font glyphs, fetching from the upstream CDN once and serving locally
thereafter. This avoids repeated external requests from each map instance in grid view.

## Static Data

| Prefix | Serves from | Contents |
|---|---|---|
| `/data/images/` | `data/images/` | Site thumbnails |
| `/data/walkthroughs/` | `data/walkthroughs/` | Read-only demo site JSON |
| `/data/demo/` | `data/demo/` | Demo assets used by the guided tours |
| `/docs/` | embedded | This documentation site |

## Static Assets

All other routes serve the embedded React SPA. The server implements SPA routing by
returning `index.html` for any path not matching the above patterns.
