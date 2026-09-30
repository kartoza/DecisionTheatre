# Overlay-first painting on main: before and after — 2026-09-30

Backport of the overlay-ordering fix from the multires branch (see
`feat/datasources-reorg-multires-catchments` and its
`benchmarks/map-load-multires-2026-09-30.md`) onto `main`, which still
uses the legacy data layout: a single `africa.mbtiles` whose tileset carries
**no catchment layer**, so the choropleth renders via `/api/choropleth`
GeoJSON at every zoom. The multires layer scheme is deliberately **not** part
of this branch — only the painting-order fix, so it can deploy to production
against the existing data.

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
