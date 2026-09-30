# Map load: basemap → overlay gap, before and after multires catchment rendering

Measured with `scripts/map-load-timeline.mjs`: a zero-dependency harness that
drives headless Chromium over the DevTools protocol against a running server,
boots the app straight into the explore-mode map, records every network request
(including MapLibre's web-worker tile fetches), and clicks the zoom-in control
once per second to walk the camera from the continental view into catchment
zoom range — the same journey a user makes opening a site.

Reproduce with:

```sh
./bin/decision-theatre --headless --port 8123 --data-dir ./data &
node scripts/map-load-timeline.mjs http://127.0.0.1:8123/ ./out 60 9
```

Environment for both runs: local server (`--headless`, port 8123), the
`data/` datapack with multires catchment tiles (`catchments_lev04/06/08/12`,
tileset minzoom 2), headless Chromium with SwiftShader WebGL, same machine as
the server — so these numbers measure the pipeline, not the network.

## Baseline — 2026-09-30, commit e52d87d (frontend renders lev12 tiles only)

Below zoom 11 the choropleth renders via `/api/choropleth` GeoJSON; the
vector-tile path only engages at z≥11.

| Request class                                                   | Count                    | Payload                                         | Latency             |
| --------------------------------------------------------------- | ------------------------ | ----------------------------------------------- | ------------------- |
| `/api/choropleth` GeoJSON (z3.6–z10.6, one pair per zoom step)  | 16 (12 aborted mid-zoom) | **4,908 KiB each** (~9.6 MiB per viewport pair) | 1,120–1,340 ms each |
| `/api/choropleth?valuesOnly=1` full-domain pair (startup stats) | 2                        | 1,329 KiB each                                  | 4,771 / 4,826 ms    |
| `/api/catchment-values` (z≥11 tile path)                        | 2                        | ~1 KiB                                          | **10 ms**           |
| Catchment vector tiles `/tiles/catchments/` (z≥11)              | 12                       | 12 KiB total                                    | ~24 ms each         |
| Context/basemap vector tiles                                    | 114                      | 1,554 KiB                                       | p50 24 ms           |

Key numbers:

- **Every zoom step below z11 refetched an identical 4,908 KiB GeoJSON payload
  per scenario pane.** The URL embeds the raw float bbox and zoom
  (`zoom=3.583002288363015`), so neither the browser HTTP cache, the client's
  60 s memo, nor the server's `max-age=300` ever hit — 0 % cache reuse.
- The moment the camera crossed into z≥11 the tile path took over: values in
  10 ms, tiles in ~24 ms — roughly **two orders of magnitude** less latency
  and three orders less payload than the GeoJSON path serving the zooms below.
- On the production deployment the same aggregated GeoJSON request measured
  7,453 ms p50 (dtbench run 13, `choropleth-domain-aggregated`).

Secondary observations from the same runs (not addressed by this change):

- No basemap tile is requested until ~3.2 s: the satellite style is tried
  first, fails ("quota used up / no provider"), and the fallback style swap
  gates all tile loading.
- Empty `/tiles/context/` tiles 404 without the `Access-Control-Allow-Origin`
  header that 200s carry, so the cross-origin parallelism hosts
  (`localhost:8124-8126`) log them as fetch errors on every load.
- Overlay application defers on `map.once('idle')` while any basemap tile is
  still streaming (MapView.tsx), which on a slow link delays the choropleth
  well past its own data being ready.

## After — multires tile rendering, same run parameters, 2026-09-30

The frontend now renders `catchments_lev04/06/08/12` per zoom band from the
tiles (overzooming lev12 past z12), `/api/catchment-values` serves
level-matched aggregate values via its new `zoom` parameter, and the GeoJSON
path remains only as a fallback for datapacks without multires tiles.

| Request class                                                   | Count | Payload        | Latency                                |
| --------------------------------------------------------------- | ----- | -------------- | -------------------------------------- |
| `/api/choropleth` GeoJSON (render path)                         | **0** | —              | —                                      |
| `/api/choropleth?valuesOnly=1` full-domain pair (startup stats) | 2     | 1,329 KiB each | 6.6 s (cold start, precalc contention) |
| `/api/catchment-values?zoom=2` (lev04 pair)                     | 2     | 2 KiB each     | 62 ms                                  |
| `/api/catchment-values?zoom=6` (lev06 pair)                     | 2     | 27 KiB each    | 317 ms                                 |
| `/api/catchment-values?zoom=9` (lev08 pair, 26,682 basins)      | 2     | ~242 KiB each  | ~1.5 s (cold)                          |
| `/api/catchment-values?zoom=11` (lev12 viewport pair)           | 2     | ~0.5 KiB each  | ~28 ms                                 |
| Catchment vector tiles (now from z2 up)                         | 118   | 763 KiB total  | p50 55 ms                              |

Verified visually from the harness screenshots: the choropleth renders across
the whole zoom journey — coarse HydroBASINS lobes at z6–10, per-catchment
detail from z11 and through the overzoom range — with the compare swiper
showing distinct values per side, and the `[perf]` feature-state logs confirm
the band joins (2,411 → 26,682 → 10 ids set as the camera descends, previous
band cleared each time).

### Comparison

|                                                            | Baseline                                                                                        | After                                                                                                                                          |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload per zoom step below z11 (pair of panes)            | 9,816 KiB, refetched every step, 0 % cache hits                                                 | 4–484 KiB **once per band** — repeat visits to a band are served from the request memo / HTTP cache (stable URLs: canonical zoom + fixed bbox) |
| Total choropleth-render bytes over the 9-step zoom journey | 19,635 KiB (+ 12 aborted multi-MiB fetches)                                                     | 542 KiB values + 763 KiB tiles (tiles cached and reused thereafter)                                                                            |
| Render-path latency per viewport change                    | 1.1–1.3 s fetch (7.4 s p50 on the production server) + main-thread GeoJSON parse + tessellation | 28–317 ms warm; geometry already tessellated in the tile cache                                                                                 |
| Zoom range on the tile path                                | z ≥ 11 only                                                                                     | every zoom from z2 up                                                                                                                          |

Remaining opportunities noted in the baseline (satellite-fallback stall before
any basemap tile, `once('idle')` gating of overlay application, CORS-less 404s
on empty context tiles) are unchanged by this work and still stand.

## Overlay-first painting — 2026-09-30, follow-up change

Desktop testing of the multires change surfaced the ordering problem the
baseline had already flagged: the choropleth waited for the basemap. Three
gates in `MapView.tsx` all keyed on "every basemap tile has streamed in":

- `applyColors` bailed until both maps had fired MapLibre's `load` event,
  which waits for the first _visually complete_ render — basemap tiles
  included;
- both render paths deferred `applyChoroplethLayer` behind
  `map.loaded() ? apply() : map.once('idle', apply)`, and `idle` fires only
  once every tile of every source is in;
- below `MIN_CATCHMENT_ZOOM` (3) the choropleth was removed outright, so the
  initial continental view (~z2.5) never drew catchments at all.

The change inverts the ordering — the catchments draw first, the basemap
fills in beneath them:

- a `style.load` listener on each map triggers the first paint the moment the
  style document is in (style-ready is the real precondition for
  addSource/addLayer), and the `applyColors` guard accepts a style-loaded map
  with `load` kept only as the fallback signal;
- both render paths now defer through `whenStyleReady()` (isStyleLoaded /
  `styledata`) instead of `loaded()`/`idle`;
- the zoom floor yields to the tile bands: any zoom a band covers renders,
  so the multires tileset draws from z2 up and `MIN_CATCHMENT_ZOOM` now only
  bounds the GeoJSON fallback for pre-multires datapacks.

Measured (same harness, 6-click run; headless-SwiftShader cold-start, so
absolute times are noisy but the ordering is the point): catchment values and
tiles are requested while the basemap is still streaming — basemap tiles ran
5.3 s → 21.9 s in this run, catchment values went out at 8.3 s and catchment
tiles at 8.8 s, painting long before the basemap settled, where previously the
first application waited for full basemap idle. The initial continental view,
previously choropleth-less by design, now renders the full lev04 basin
choropleth (verified in the harness screenshots at 10 s).
