# Issue #76 — Twelve WebGL contexts are created in quad view and never released

Branch: `perf/webgl-context-budget`. Worktree: `DecisionTheatre-wt/webgl`.
Nothing pushed; no PR opened.

## What the code did before

**Two maps per `MapView`, unconditionally.** One `useEffect` built the whole map
surface — DOM chrome, slider, labels — and inside it constructed `leftMap` and
`rightMap` with identical options
(`frontend/src/components/MapView.tsx:2842` and `:2863` on `main`). Neither
creation consulted compare mode. The only teardown was that effect's cleanup, so
both instances lived exactly as long as the component.

**A one-way mount latch in the pane.** `ViewPane` set
`const [hasShownMap, setHasShownMap] = useState(viewMode === 'map')`
(`frontend/src/components/ViewPane.tsx:136` on `main`) and only ever set it to
`true`. The map layer was hidden with `opacity={viewMode === 'map' ? 1 : 0}`
while `{hasShownMap && mapMountReady && <MapView …>}` stayed mounted
(`:544`–`:548`). So a pane that had shown a map once held its contexts for the
rest of the session no matter what it displayed afterwards.

**Quad view renders all six panes.** `ContentArea.tsx:324`,
`visibleIndices = paneStates.map((_, index) => index)`. In single-pane mode only
the focused pane is rendered, so non-focused panes already released everything —
the problem was specific to quad view. I did not change `ContentArea`: six panes
showing six maps legitimately need six contexts.

**Why the latch existed.** The comment at `ViewPane.tsx:133`–`135` says it: a
pane that starts in chart/dial/table mode should not pay for map initialisation,
which "was the main cause of slow quad-view transitions". That intent is about
*never-shown* panes. It is one-way because nothing was ever designed to release;
the cost being avoided on the way back in is a full MapLibre init plus tile
fetch, with the pane's spinner over it.

**What a teardown breaks, and what carries state.** `hooks/useMapSync.ts` is the
cross-pane registry: every left map registers, moves broadcast to the others, and
a newly registered map is jumped to `registry[0]`'s view. That covers a recreate
*while another pane still has a map*. It does not cover the last map going away —
the view lived only in the live instances. A recreated map would have opened at
the constructor's `center: [20, 0], zoom: 3`, because the effect that fits to
site bounds keys on `siteBounds` and does not re-run on a remount. That is the
"visible jump" the issue names, and it is the part that had to be solved before
anything could be released.

## What I changed

### 1. The compare map is created on entering compare mode (`MapView.tsx`)

`createRightMap()` / `destroyRightMap()` are defined inside the map-init effect
(they need its `rightContainer`, `syncMaps`, `resizeAndRefresh`, `signalReady`)
and exposed through `ensureRightMapRef` / `destroyRightMapRef`. A small effect
declared immediately after the init effect drives them from `isSwiperEnabled`.
The init effect calls `createRightMap()` itself when compare mode is already on,
so a re-run of that effect restores the pair.

The new instance opens on the left map's *current* view, so revealing the split
shows the same place the user is looking at. It re-reads the basemap choice
rather than reusing the style captured at init — a latent bug fixed in passing:
the old code would have handed a stale style object to a map created after a
satellite toggle.

Ordering is load-bearing and commented in the source: React runs every changed
effect's cleanup before any effect body, so effects that list `isSwiperEnabled`
detach their listeners from a live instance before this one removes it; and
effect bodies run in declaration order, so the same effects see the new instance
on the way back in. That is why the lifecycle effect sits directly after the
init effect and why `isSwiperEnabled` was added to the dependency lists of the
identify-highlight effect and the three boundary-edit effects.

Making the right map optional meant relaxing fourteen `if (!leftMap || !rightMap)`
guards that would otherwise have disabled *left*-map work too — the choropleth,
the boundary, the identify highlight and boundary editing all bail out early on
a null right map. Two techniques kept that diff small:

- `mapsReady.current.right` now initialises to `true` and means "the right map,
  *if any*, has loaded". Every existing `mapsReady.current.right` check stays
  correct unchanged.
- The per-map helpers that already existed (`removeChoroplethLayers`,
  `removeSiteBoundary`, `updateSiteBoundarySource`, `addSiteBoundaryWhenReady`)
  now take `maplibregl.Map | null` and no-op on absence, so their left/right
  call pairs are untouched.

The three boundary-edit effects wired identical handlers to `leftMap` and
`rightMap` by hand. Those loop over the live instances now (`const maps =
rightMap ? [leftMap, rightMap] : [leftMap]`), which is fewer lines than the
duplicated pairs and is the only structural rewrite in the change.

### 2. The pane releases its maps (`ViewPane.tsx`)

`hasShownMap` becomes `mapMounted` and is two-way: set on entering map view,
cleared `MAP_RELEASE_DELAY_MS` (15 s) after leaving it, with the timer cancelled
if the pane comes back. `map → chart → map` inside 15 s is still free — no
reload, no spinner — which is what the latch was protecting. A pane parked on a
chart gives its contexts back.

The spinner reset moved out of a `setState` updater (it called `setMapReady`
inside `setHasShownMap`'s updater, which is impure) into its own effect keyed on
`mapMounted`. `onReady` fires once per MapView instance, so re-arming on unmount
is both correct and simpler than the previous "only on the first transition"
special case.

### 3. The view survives a teardown (`hooks/useMapSync.ts`)

The registry records the view on every broadcast and once more when a map
unregisters (its last chance, and it may be the only map left).
`getLastMapView()` returns it and the left map's constructor opens there.
Pitch is deliberately not restored — the 3D toggle owns pitch — but centre, zoom
and bearing are. Cross-pane sync is unchanged: a new map still jumps to
`registry[0]` when another pane has one.

### 4. Docs and changelog

`docs/developer-guide/architecture.md` — "Map Rendering Architecture" rewritten;
the "expected to change" note naming this ticket removed. `CHANGELOG.md` — entry
under `[Unreleased] → Performance`.

No version bump: the entry is under `[Unreleased]` and no release is being cut
here.

## The finding that changes the arithmetic

**The compare swiper defaults to ON.** `App.tsx:95`,
`const [isSwiperEnabled, setIsSwiperEnabled] = useState(true)` — passed down to
every pane; `MapView`'s own fallback (`useState(true)`, `MapView.tsx:950`) agrees.
With the swiper on and the slider docked left, the *right* map fills the pane and
the left one is clipped to zero width, so out of the box the user is looking at
the right map.

The issue's premise — "whether or not the user is comparing scenarios",
"creating `rightMap` lazily … roughly halves this" — assumed compare mode is
opt-in. It is opt-out. So lazy creation alone does **not** halve the default
configuration: it halves it for anyone who turns the swiper off, and the pane
release is what bounds the default. Flipping that default is a UX decision, not
mine to take, but it is the single highest-impact remaining lever on this budget
and worth a decision on the PR.

## Measurements

Not browser context counts — I cannot run a browser here. These are MapLibre
constructor calls counted with `maplibre-gl` mocked, rendering six real
`ViewPane`s in `layoutMode="quad"` under jsdom, and they are what decides how
many contexts the browser is asked for.
(`frontend/src/test/webglContextBudget.test.tsx`, `describe('quad view map
instance count')`.)

| quad view, six panes | before | after |
|---|---:|---:|
| all six on a map, compare off | 12 | **6** |
| all six on a map, compare on | 12 | 12 |
| two on a map, four on chart/dial/table (compare on) | 12 live | **4 live** |
| two on a map, four elsewhere (compare off) | 12 live | **2 live** |

"live" = constructed and not yet `remove()`d. The before column is the same test
file run against the unmodified components (via `git stash`), not an estimate.

The third row is the shape of the win in the default configuration: the count now
tracks what is on screen instead of ratcheting to twelve and staying there.

## Tests

New, all under `frontend/src/test/`:

- `webglContextBudget.test.tsx` — `maplibre-gl` replaced by a recording stub.
  One map when compare is off; a second only on entering compare mode;
  `remove()` on the compare instance when leaving, with the left instance
  untouched; both removed on unmount; plus the quad-view counts above.
- `paneMapLifecycle.test.tsx` — `MapView` stubbed. No map for a pane that has
  never shown one; the map unmounts after the grace period; it stays mounted if
  the pane returns to map view in time.
- `mapSyncView.test.ts` — the view round-trips through register → move →
  unregister; a map released without ever moving still records its view; a new
  map still syncs to a live one.

**Verified they fail against the unfixed code.** With the three source files
stashed and the tests in place: 9 failed, 5 passed of 14.

```
× map sync view memory > round-trips the view through a teardown and recreate
    → getLastMapView is not a function
× map sync view memory > records the view of a map that never moved before being released
    → getLastMapView is not a function
× ViewPane map mounting > unmounts the map once the pane has stopped showing one
    → expected <div data-testid="map-view"></div> to be null
× MapView WebGL instances > creates one map, not two, when compare mode is off
    → expected [ FakeMap, FakeMap ] to have a length of 1 but got 2
× MapView WebGL instances > creates the compare map only on entering compare mode
    → expected [ FakeMap, FakeMap ] to have a length of 1 but got 2
× MapView WebGL instances > releases the compare map on leaving compare mode
    → expected false to be true
× quad view map instance count > asks for one context per pane when compare mode is off
    → expected [ FakeMap, …(11) ] to have a length of 6 but got 12
× quad view map instance count > holds nothing for panes that have left map view
    → expected [ FakeMap, …(11) ] to have a length of 4 but got 12
× quad view map instance count > bottoms out at one context per displayed map
    → expected [ FakeMap, …(11) ] to have a length of 2 but got 12
```

The five that pass both ways are regression guards, and I am not claiming
otherwise: "releases both maps on unmount", "mounts no map for a pane that has
never shown one", "keeps the map mounted when the pane returns in time", "still
syncs a newly registered map to a live one", and the deliberate status-quo
assertion that compare mode costs two per pane.

Full suite: **16 files, 101 tests, all passing** (was 13 files, 87 tests).
`./node_modules/.bin/tsc --noEmit` clean. `./node_modules/.bin/eslint src/`
clean. No Go changes.

## What I could not verify, and what I am unsure about

- **The browser-side success criteria.** "A context counter shows at most the
  number of visible map panes" and "quad view on integrated graphics produces no
  context-loss warning" both need a real browser and a real GPU. The constructor
  counts above are a proxy for the first and say nothing about the second. Worth
  checking in the desktop app with `about:gpu` / the console before the issue is
  closed.
- **"No visible jump" is reasoned, not observed.** I can show the view value
  round-trips (`mapSyncView.test.ts`) and that the constructor consumes it. I
  cannot show the absence of a flash of the default view between construction
  and first paint. The restore is in the constructor rather than a post-hoc
  `jumpTo`, which is the safest place for it, but only a browser confirms it.
- **15 s is a judgement call**, not a measured optimum. It is long enough for a
  glance at a chart and short enough that a pane parked on a table releases
  within one interaction. Trivially tunable — one constant in `ViewPane.tsx`.
- **A brief pause in choropleth updates while the compare map loads.**
  `applyColors` waits for both maps, so for roughly the compare map's load time
  after entering compare mode a pan will not recolour. The compare map's `load`
  handler calls `applyColors`, so it self-corrects. Same semantics as the
  existing initial load; I judged narrowing it not worth touching more of the
  choropleth region, which another branch is editing.
- **Toggling compare while boundary-edit mode is active re-runs the edit
  effects**, which re-zooms to site bounds. During boundary editing the map is
  already at site bounds, so this should be invisible — but I have not watched
  it happen. The alternative was leaving a newly created compare map without
  edit handlers, which is worse.
- **A re-run of the map-init effect while compare mode is on** recreates the
  compare map without re-running the `isSwiperEnabled`-keyed effects, so those
  hold references to the old instance. This is a pre-existing staleness class —
  it is already true of `leftMap` — and the change does not widen it. Not fixed
  here.
- **`lastView` is module-global**, shared across panes and across sites by
  design (it is the same registry that already syncs panes to each other). A map
  created just after a site switch opens at the previous view until the
  `siteBounds` fit runs, which is the behaviour the app already had for a second
  pane.

## Merge note

`MapView.tsx` is being edited concurrently on another branch in the choropleth
source/paint region. My edits inside `applyColors` are three lines — the guard,
the `rightMap &&` on the right-side apply block, and the nullable signature of
`removeChoroplethLayers` — and everything else is in the lifecycle, boundary and
edit regions. Textual conflicts should be small; the semantic contract to
preserve is that `rightMapRef.current` may be null.
