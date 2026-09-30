# Overlay-first painting on main: before and after — 2026-09-30

Backport of the overlay-ordering fix from the multires branch (see
`feat/datasources-reorg-multires-catchments` and its
`benchmarks/map-load-multires-2026-09-30.md`) onto `main`, which still uses
the legacy data layout: a single `africa.mbtiles` tileset. The multires layer
scheme is deliberately **not** part of this branch — only the painting-order
fix, so it can deploy to production against the existing data.

A caveat on the measurement data: the local `data_mainbranch/` copy used for
these runs carries **no catchment layer at all**, so locally the choropleth
rendered via `/api/choropleth` GeoJSON at every zoom. The **production**
tileset does carry `catchments_lev12` at z8–15 (verified against the live
`/data/tiles.json`), so in production the tile path already serves zoom ≥ 8
and the GeoJSON path only covers z3–8. The ordering findings below apply to
both paths identically — the gates being measured sit above the path choice —
but the volume of GeoJSON traffic in these runs overstates production's.

## The problem

Three gates in `MapView.tsx` all keyed the choropleth on "every basemap tile
has streamed in":

- `applyColors` bailed until both maps had fired MapLibre's `load` event,
  which waits for the first *visually complete* render — basemap tiles
  included;
- both render paths deferred `applyChoroplethLayer` behind
  `map.loaded() ? apply() : map.once('idle', apply)`, and `idle` fires only
  once every tile of every source is in.

Net effect: the basemap always painted first and the choropleth followed —
on a slow link, many seconds later — even when its data was long since ready.

## The change

- A `style.load` listener on each map triggers the first paint the moment the
  style document is in (style-ready is the real precondition for
  addSource/addLayer), and the `applyColors` guard accepts a style-loaded map
  with `load` kept only as the fallback signal.
- Both render paths defer through `whenStyleReady()` (`isStyleLoaded` /
  `styledata`) instead of `loaded()`/`idle`, so the overlay applies as soon
  as its data arrives and the basemap fills in beneath it.

Not backported (multires-only): the per-band tile rendering, the
`/api/catchment-values` `zoom` parameter, and the zoom floor yielding to tile
bands — all of them need the multires tilesets that the legacy data layout
does not carry.

## Measurement

`scripts/map-load-timeline.mjs` (headless Chromium over CDP; boots the app
into the explore-mode map, records the full network waterfall including
worker tile fetches, screenshots every 2 s, then clicks zoom-in once per
second) against a local `--headless` server on `data_mainbranch/`. Four
runs: plain and throttled (800 kbit/s from the last zoom click), before and
after. Local numbers — production latencies are larger, the *ordering* is
the point.

| Run | Basemap tiles start | First choropleth request | First user interaction (zoom click) |
|---|---|---|---|
| Before, plain | 5,434 ms | 16,351 ms | 16,295 ms |
| Before, throttled | 5,896 ms | 15,581 ms | 15,543 ms |
| **After, plain** | 6,085 ms | **9,664 ms** | 17,951 ms |
| **After, throttled (warm)** | 3,575 ms | **3,888 ms** | 12,549 ms |

The before-runs tell one story: the choropleth was never requested until the
first user interaction — the initial viewport sat basemap-only for the whole
opening 15+ seconds because `applyColors` could not run until both maps'
`load` events and nothing re-invoked it afterwards. The after-runs tell the
other: the choropleth request fires at style-ready — 6.7 s earlier cold,
11.7 s earlier warm, ~300 ms after basemap tiles begin on the warm run — and
the initial view renders the full grid-aggregated choropleth with no
interaction at all (verified in the harness screenshots: at 8 s the after-run
shows the complete choropleth; the before-run at the same moment shows
landcover only). More choropleth requests also complete instead of aborting
(14/20 and 18/20 vs 10/18 in both before-runs), because fetches start earlier
and are superseded less often.

## Test coverage

The full frontend suite passes (416 tests), plus a new structural guard in
`choroplethRenderPath.test.ts` asserting the render path defers on
style-readiness and never on `idle`.

# Round two: server and fetch-economy fixes — 2026-09-30

Profiling the refreshed **production datapack** (147,835 catchments, 1.9 GB
GeoPackage) with dtbench (run 14) and the browser harness surfaced three
fixable bottlenecks; all three are now in this branch. dtbench run 15 and
browser runs on the same datapack measure the outcome.

## 1. Aggregated choropleth: 3,985 ms → 96 ms p50 (41×)

Every low-zoom request re-ran the same full-table scan (147k rows) to
rebuild rows that are static for the life of the datapack. The full-domain
row set is now cached per scenario+attribute (`getFullDomainGridRows`:
shared in-flight builds, LRU-bounded ~30 MB, failed builds not cached) and
each request filters it in memory. Side effect visible in the browser runs:
zoom-step fetches now complete instead of being perpetually superseded, so
the choropleth actually updates while zooming — previously, in the default
dual-map configuration at production latency, an 8-step zoom delivered
nothing to the map at all.

## 2. Boot stats: 2 × 14.4 MB / 4,097 ms → 2 × 105 B / 195 ms

The "Full" range statistics were derived client-side from a valuesOnly
download of every catchment's raw value, per scenario, at every boot. New
`GET /api/stats/full` computes the identical plain min/max/mean/count in one
aggregate scan (dtbench `stats-full`: 194.5 ms p50, 105 bytes). The client
prefers it and falls back to the legacy download for servers that predate
the endpoint (detected by content type — an old server's SPA catch-all
answers unknown /api paths with HTML 200, not 404).

## 3. Single-map mode no longer downloads the unpainted scenario

`applyColors` fetched both scenarios even with the compare map off, purely
to feed right-scenario extent statistics that every consumer null-guards.
The right scenario is now fetched only when a compare map exists. Measured:
every choropleth phase exactly halves (low-zoom pan 4,437 → 2,215 KiB; zoom
6,116 → 3,058 KiB; values 12 → 6 requests).

## Browser totals on the production datapack (dual-map)

| Phase | Before fixes | After |
|---|---|---|
| Initial load | 7,270 KiB (95 req) | **4,850 KiB** — the 2.5 MiB stats pair became 0.5 KiB |
| Pan, low zoom | 2,164 KiB, ~3.4 s server time per pair | same bytes, **~0.1 s** server time, no longer aborted |
| Pan, high zoom | 6 KiB | 6 KiB (3 KiB single-map) |

What remains is the GeoJSON transfer itself in the z3–8 band (~1–1.4 MiB
gzipped per pane per viewport) — inherent to the geometry-per-viewport API
and retired for every zoom by the multires branch.
