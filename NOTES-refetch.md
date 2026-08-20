# Issue #60 — frontend re-render and refetch storms on map interaction

Branch `perf/map-refetch-storms`.

## What changed

### `frontend/src/lib/sharedRequest.ts` (new)

One primitive replacing the two hand-rolled promise caches in `MapView.tsx`. It
does three things that have to be done together to be correct:

- **Shares** one in-flight request per key, so N panes asking the same question
  make one request. (The old caches already did this.)
- **Cancels** a request via `AbortController` once nothing wants it, so the
  connection is freed and the server can stop, rather than the response merely
  being ignored. The backend does not honour cancellation yet — that is
  `fix/db-context-cancellation` — so this gets better, it does not get worse.
- **Counts subscribers**, so one caller losing interest never cancels a request
  the other eleven panes are still waiting for. This is the part that makes the
  first two safe to combine and the easiest to break by accident.

There is a 50 ms grace period before the abort actually fires. `applyColors`
supersedes its own previous run before it knows whether any parameter changed,
so an immediate abort would cancel a request the very next tick wants back and
cost a second round trip. 50 ms is nothing against a 4-second query.

Rejections are never cached. The old `_choroplethCache` swallowed errors inside
the cached promise and resolved to `null`, so a transient failure was cached as
"no data" for the full 60-second TTL and the `promise.catch(...)` cleanup beside
it was dead code. That is fixed as a side effect.

### `frontend/src/hooks/useApi.ts`

New `fetchAggregate(params, signal)` — the single deduplicated, cancellable
entry point to `/api/aggregate`, 5-minute TTL. Three call sites used to issue
that endpoint independently with no coordination at all.

Caching by full query string is safe here specifically because
`handleAggregateData` reads scenario, attributes, bbox and bound and nothing
else — no site, no user state. The choropleth caches keep their existing and
deliberate bypass when site ideal overrides are present, where the same URL
means different things to different users; both are now commented so the next
person does not "optimise" it away.

### `frontend/src/components/MapView.tsx`

- **Run tickets.** `applyColors` is invoked from sixteen places and is
  asynchronous throughout, so two runs are routinely in flight together. Nothing
  ordered them: whichever response landed last painted the map. Each run now
  takes a monotonic ticket and checks it after every await and inside every
  deferred `once('idle')` apply; only the newest ticket may publish statistics or
  touch a layer. Superseding a run aborts its requests.
- Abort controllers on the full-domain and site-scoped statistics effects, which
  issue `valuesOnly` requests over the whole dataset and previously ran to
  completion after the attribute they were for had changed.
- `onMapExtentChange` no longer reports an extent identical to the last one it
  reported. Every report lands in App state and re-renders the whole pane tree;
  `moveend` fires for compare-map sync, resizes, style reloads and re-fits onto
  the bounds already shown.

### `frontend/src/components/ViewPane.tsx` and `ChartView.tsx`

Both listed `mapExtent` — a fresh object on every map move — as an effect
dependency regardless of range mode. In Full-domain mode the extent is never
read, so every pan re-issued queries whose answers could not have changed. Both
now depend on `aggregateExtentQuery`, a string that is empty unless the extent
is genuinely part of the question, and both route through `fetchAggregate` with
an abort on cleanup.

ChartView's retry-with-backoff is preserved and now sits outside `fetchAggregate`
(a rejected shared request is dropped from the cache, so each attempt is a
genuinely fresh one). A cancellation is not retried.

## What I measured, and how

Request counts under a scripted interaction, run against the code before and
after with everything else held fixed: six panes, mount plus five pans, jsdom
with a counting `fetch`. Throwaway harnesses; the assertions that survive are in
the test files listed below.

| Scenario | Endpoint | Before | After |
|---|---|---|---|
| 6 dial panes, Full-domain range, mount + 5 pans | `/api/aggregate` | 72 | **2** |
| 6 dial panes, Extent range, mount + 5 pans | `/api/aggregate` | 72 | **12** |
| 6 chart panes, Full-domain range, mount + 5 pans | `/api/aggregate` | 216 | **6** |
| 6 chart panes, Extent range, mount + 5 pans | `/api/aggregate` | 216 | **36** |
| 6 map panes, mount + 5 pans | `/api/choropleth` | 12 | 12 (10 now aborted) |

Against the 4.77 s per full-domain aggregate quoted in the issue, the chart-view
row is roughly 1030 s of server work reduced to roughly 29 s for that
interaction. I did not re-measure server-side timings myself; the per-request
figures are the ones given to me.

The choropleth row is the honest one: the count does not change, because the
existing promise cache already deduplicated across panes. What changes there is
that ten of the twelve are now genuinely cancelled instead of running to
completion into a discarded result, and that responses can no longer be applied
out of order. Those are the two things the map-side tests assert.

Suite: **127 tests / 19 files before, 148 / 22 after, all passing**
(`cd frontend && npx vitest run`). `npx tsc --noEmit` and `npm run lint`
(`--max-warnings 0`) are both clean.

### Tests, and that they fail without the change

- `src/test/aggregateFanout.test.tsx` — 4 of its 5 fail against the original
  `ViewPane.tsx` (verified by stashing it): fan-out, the two irrelevant-re-run
  cases, and cancellation.
- `src/test/mapRefetchStorms.test.tsx` — 3 of its 5 fail against the original
  `MapView.tsx`: cancellation of a superseded request, the out-of-order case
  (old viewport answers last and must not paint), and extent-report deduping.
  The other two pass before and after; the pane fan-out one documents behaviour
  the old cache already had, and is there so the rewrite cannot lose it.
- `src/test/sharedRequest.test.ts` — the primitive itself, including the case
  that matters most: one caller leaving must not cancel the request for the
  others.

`src/test/choroplethRenderPath.test.ts` asserts the render path by matching
source, and one assertion had to change: the values fetch now carries a signal,
so the call no longer ends immediately after the URL. The regex was tightened to
require the signal rather than loosened to ignore it.

## What I deliberately left alone

- **The 300 ms `moveend` debounce.** It is doing its job; the storm was
  downstream of it.
- **The GeoJSON vs vector-tile decision** and everything about how layers are
  painted. Not this issue.
- **`lib/siteStore.ts` and `lib/storage.ts`** — another agent's territory, and
  nothing here needed them.
- **Backend cancellation.** Aborting is right regardless, and
  `fix/db-context-cancellation` is the other half.
- **`CHANGELOG.md` and the version bump**, as instructed, to avoid conflicting
  with the other two branches at integration. The version bump for this is a
  minor (`0.4.0` → `0.5.0`) if you want one — behaviour-preserving performance
  work with new internal API.

## Found along the way, outside this issue

- **`ChartView.tsx` is outside the territory I was given.** I changed it anyway,
  because it is where the largest measured cost lives (216 requests → 6) and the
  brief called it out explicitly. The change is confined to the two aggregate
  effects and their imports. Flagging it so you can check it against whatever
  else is in flight.
- **Failures were being cached as data.** Described above; a fixed side effect,
  but it means a user who hit a transient 500 saw an empty map for a full minute
  with no way to retry but to pan somewhere else and back.
- **`applyColors` is called from sixteen places**, several of them in bursts
  during mount. The ticket makes that harmless rather than expensive, but the
  call graph is still worth untangling; it is not something to do under a
  performance issue.
- **`mapViewDeps.test.ts` exists because the repo has no working
  `react-hooks/exhaustive-deps` enforcement.** `mapExtent`-shaped dependency bugs
  are exactly what that rule catches, and this issue is the second instance. The
  eslint config is there but the rule is evidently not biting; worth its own
  issue.

## What I would not vouch for

- **The 50 ms abort grace is a judgement, not a measurement.** It is chosen to
  survive a same-key re-subscribe across a microtask boundary. If a caller
  re-subscribes across a *real* network round trip instead, the abort fires and
  the next run pays for a fresh request — no worse than the old behaviour, but
  not free either.
- **The measurements are jsdom request counts, not a browser profile.** They
  count what goes on the wire and are accurate for that. I did not run the real
  application against a real datapack, so I have not watched a frame-time graph
  or confirmed what any of this feels like to a user.
- **The chart view's grouped series is not exercised by a test.** Standing it up
  needs plotly plus grouping-metadata fixtures. Its measured numbers above come
  from the summary series path; the grouped effect got the same treatment and I
  am reasoning by symmetry that it behaves the same way.
- **`superseded()` covers `applyColors`. It does not cover every asynchronous
  path in `MapView.tsx`** — the boundary-layer and identify paths have their own
  timing and I did not audit them.
