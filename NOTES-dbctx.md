# Issue #38 — `context.Context` on database calls

Branch `fix/db-context-cancellation`. Go backend only: `internal/geodata/`,
`internal/api/`. Nothing in `internal/server/` needed changing — it only
constructs the store.

## What changed

**`internal/geodata/gpkg_store.go`** — every method that touches SQLite now
takes a `context.Context` as its first parameter and uses `QueryContext` /
`QueryRowContext`. (There are no writes: the geopackage is opened `mode=ro`,
so no `ExecContext` was needed.) That is 15 `Query` and 6 `QueryRow` call
sites across 20 exported methods and 5 unexported helpers.

**`internal/geodata/cancel.go`** (new) — `IsCancellation(ctx, err)`. It takes
the context as well as the error on purpose: `database/sql` reports
`context.Canceled` when the context is already done, but when SQLite is
interrupted *mid-statement* go-sqlite3 reports its own `SQLITE_INTERRUPT`
("interrupted"), which has no relation to `context.Canceled`. Consulting the
context alongside the error covers both without importing the driver's error
type into every caller. `context.DeadlineExceeded` is deliberately **not**
treated as a cancellation — a query that blew a timeout is a real failure
worth reporting.

**`internal/api/cancel.go`** (new) — `respondStoreError` /
`respondCancelled` / `clientGone`, plus `StatusClientClosedRequest` (499). A
cancelled request logs at `[cancelled]`, never as an error, and writes no body.
The 499 is not for the client (it has gone); it is so the outcome lands
somewhere other than the 200 or 500 bucket in logs, tests and any future
metrics middleware.

**`internal/api/handler.go`** — `r.Context()` threaded to every store call;
error paths routed through `respondStoreError`.

**Row-iteration correctness.** Threading a context without checking
`rows.Err()` would have *created* a new swallowed error: a cancelled scan ends
the `rows.Next()` loop early, so the caller would receive a partial result
reported as a complete one — a choropleth with holes in it, or a statistics
panel silently summarising a subset. I added `rows.Err()` checks to the ten
loops that lacked them (`loadColumns`, `resolveScenarioIDColumn`,
`GetScenarioData`, `GetComparisonData`, `queryCatchmentsDetailed`,
`QueryCatchmentValueArrays`, `fetchCatchmentGridRows`, `DissolveCatchments`,
`GetCatchmentsByBBox`, `GetCatchmentIDsByBBox`). This does also surface
genuine mid-scan database errors that were previously truncating results
silently — an improvement, but flagging it because it is a behaviour change
beyond the strict scope of the issue.

## What I deliberately did *not* cancel

1. **The grid geometry cache build** (`ensureGridGeometryCache` →
   `buildGridGeometryCache`). ~150k polygon unions per tier, built once and
   then serving every aggregated choropleth for the life of the process. It
   runs on `context.Background()`. It is guarded by a `sync.Once`, so if one
   request's cancellation tore the build down nothing would ever restart it and
   the aggregated path would stay broken for the rest of the process's uptime —
   one impatient user, permanent degradation for everyone.

   What *is* cancellable is the **wait**: `queryCatchmentsGridAggregated` now
   selects on `ctx.Done()` alongside the per-tier ready channel, so a request
   that has been abandoned stops holding a goroutine while the build carries on
   for everybody else. Covered by
   `TestGivingUpOnTheGridCacheDoesNotCancelTheBuild`.

2. **`handlePrecalculateFull`** — `context.WithoutCancel(r.Context())`.
   Full-domain averages for every column across the whole dataset, cached for
   the process lifetime and served to every pane of every later quad-view load.
   One user reloading impatiently must not throw that away and leave the next
   arrival to start from nothing. Covered by
   `TestPrecalculateFullSurvivesTheRequestThatTriggeredIt`.

3. **`populateSiteCatchmentDetailsDeferred`** and **`doSiteExtraction`** —
   `context.Background()`. Both run in goroutines started by handlers that
   respond (201 / 202) and return immediately, so the request context is
   already cancelled by the time the goroutine gets going. Threading it there
   would have aborted the work on *every* request, not only on a disconnect.
   The client polls `GET /sites/{id}/indicators` for the result, so the work
   has to outlive the request that asked for it.

4. **`NewGpkgStore`** (`PingContext`, `loadColumns`) — `context.Background()`.
   Startup work, run once at boot and again on a background goroutine when a
   datapack is installed. There is no request whose cancellation should abandon
   it, so this is `Background()` rather than `TODO()`. `NewGpkgStore`'s
   signature is unchanged; I judged adding a context parameter there to be
   churn across `internal/server/state.go` and three test files for no
   behavioural gain, but it would be a reasonable follow-up if store opening
   ever needs to abort on shutdown.

There is no `context.TODO()` anywhere in the change — every call site reaches
either a real request context or a deliberately-documented background one.

## Distinguishing cancellation from failure at each layer

- **geodata**: cancellations are returned, never logged. The two places that
  logged unconditionally (`GetCatchmentIndicatorsByIDs`'s scenario query,
  `ComputeWhiskerBounds`'s per-table query) now suppress the log for a
  cancellation.
- **api**: `respondStoreError` maps a cancellation to 499 with no body and an
  info-level log.
- **The two store methods with no error return** (`GetCatchmentAttributes`,
  `ComputeWhiskerBounds`) come back empty for a cancellation exactly as they do
  for a failure, so the handlers consult `clientGone(r)` instead. Without that,
  `/catchment/{id}` would answer 404 "catchment not found" to a user who simply
  clicked elsewhere, and `/sites/{id}/whiskers` would persist empty whisker
  bounds into the site — poisoning the cache for every later reader.

## Tests

`internal/geodata/cancellation_test.go` (internal test — needs the pool):

- `TestCancelledRequestStopsQueuedQuery` — the one that proves work actually
  stops. It holds every connection in the pool (the state every extra request
  lands in once the server is busy, which is exactly when abandoned work is
  most expensive), starts a query, cancels it, and requires it to return with a
  cancellation within 10s. Verified to fail before the change: with `db.Query`
  the call waits on the pool forever and the test times out.
- `TestEveryQueryHonoursCancellation` — table over 12 entry points, each run
  twice: live context must succeed (so the cancelled case cannot pass for the
  wrong reason), pre-cancelled context must report a cancellation. Verified to
  fail before the change.
- `TestGivingUpOnTheGridCacheDoesNotCancelTheBuild`.
- `TestIsCancellation` — including the driver-interrupt and
  deadline-exceeded cases.

`internal/api/cancellation_test.go`:

- `TestAbandonedRequestsAreNotReportedAsSuccessOrFailure` — five endpoints,
  each asserted to return 499 with no body when the client has gone, and 200
  when it has not.
- `TestAbandonedIdentifyIsNotReportedAsNotFound`.
- `TestPrecalculateFullSurvivesTheRequestThatTriggeredIt`.

`go test ./...`, `go vet ./...` and `gofmt -l` are clean, before and after.
`go test -race ./internal/geodata/ ./internal/api/` also passes. No module
dependency added, so `go.mod`, `go.sum` and the flake's `vendorHash` are
untouched.

### On the test I did not write

The brief suggested an `httptest` server where the client cancels mid-query. I
could not make that deterministic: the synthetic datapack
(`internal/gpkgtest`) is two catchments, so every query finishes in
microseconds and "did the server stop early?" becomes a race. Building a
datapack large enough to be slow would add seconds to the suite for a weaker
assertion. The pool-saturation test above is the same scenario made
deterministic — a request queued behind busy connections is precisely the case
the issue is about — and the api-level tests prove the request context reaches
the store. An end-to-end version would still be worth having if the project
ever gains a fixture with a realistically-sized geopackage.

## Found but out of scope

- **`internal/tiles/mbtiles.go` has the same problem.** `GetTile` and
  `GetMetadata` use `db.QueryRow` / `db.Query` with no context, and the tile
  store is hit far more often than the geopackage — several tile requests per
  pan, per pane. It was outside the territory I was given, so I left it, but it
  is the obvious companion fix and the change is mechanical now that the
  pattern exists.
- **`handlePrecalculateFull` has no singleflight.** Concurrent first-requests
  (quad-view: four panes on a cold start) each run the full computation and
  each write the cache. Correct, but four times the work. Making it detached
  from cancellation slightly increases the exposure, since none of the four now
  bails out early. A `sync.Once` or `golang.org/x/sync/singleflight` would fix
  it; the former needs no new dependency.
- **`buildGridGeometryCache` does not check `rows.Err()`** on its scan loop, so
  a genuine mid-scan database error would publish a *partial* geometry cache
  and mark every tier ready. It runs on a background context so cancellation
  cannot trigger it, and it is an instance of the swallowed-error pattern I was
  told to leave alone — but it is the most consequential one I saw, because the
  bad cache then persists for the life of the process.
- **`ComputeWhiskerBounds` and `GetCatchmentAttributes` cannot report errors**
  at all. That is the tracked swallowed-error issue; I worked around it in the
  handlers rather than changing the signatures.
- **`/sites/{id}/whiskers` writes to the site store on a GET** to cache the
  computed bounds. Not related to this issue, but a GET with a side effect is
  worth knowing about.

## What I would not vouch for

- **The exact error shape a mid-flight SQLite interrupt produces.**
  `IsCancellation` handles both the `context.Canceled` and the driver-specific
  "interrupted" shapes, and `TestIsCancellation` covers both, but I could not
  exercise a real mid-statement interrupt against a multi-second query — the
  synthetic datapack is too small. My reading of `database/sql` is that
  `Rows.Err()` prefers the stored context error over the driver's, which makes
  the context check belt-and-braces rather than load-bearing. If a real
  4-second query on the production datapack turns out to surface a bare
  `interrupted` error to a client somewhere, that is where to look.
- **Whether 499 is the right response code for this codebase.** Nothing reads
  it today. If there is an existing access-log or metrics convention I have not
  seen, it should follow that instead.
- **Behaviour under a real datapack.** Everything here was exercised against
  `internal/gpkgtest`'s two-catchment synthetic pack; I had no multi-gigabyte
  `datapack.gpkg` to run against. The paths that only appear at scale —
  the aggregated grid render, whisker bounds over the
  `scenario_*_lower/upper` tables — are covered by signature threading and
  compilation, not by execution. `GetScenarioData`, `GetComparisonData`,
  `GetScenarioBoundAverages` and `ComputeWhiskerBounds` are absent from the
  cancellation table test for the same reason: the synthetic schema has no
  `catchment_id` column and no bound tables.
- **`internal/api/site_shapefile_test.go`** is an integration test gated on a
  real data directory. It compiles against the new signatures but I could not
  run it.
