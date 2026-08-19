# NOTES — `fix/no-empty-success-on-db-error` (issues #63, #140)

Backend half only: `internal/geodata/` and `internal/api/`. Nothing in
`frontend/`, `.github/`, `.golangci.yml`, `Makefile`, `docs/`, `internal/bench/`
or `CHANGELOG.md` was touched.

## The defect

`GetCatchmentIndicatorsByIDs` built one `?` placeholder per catchment id and
issued a single `IN (…)`. Past `SQLITE_MAX_VARIABLE_NUMBER` (32,766, confirmed
against the linked driver — 32,766 prepares, 32,767 fails with "too many SQL
variables") the statement cannot be prepared, so the query errored.

The error was then logged and converted into an empty result with a `nil`
error, which reached the client as `HTTP 200` and `[]` — indistinguishable from
a site whose catchments genuinely have no data. That is #63. #140 is the same
thing at continent scale: the whole-of-Africa site (147,837 catchments) drew an
empty table, an empty chart and a dial with no needle.

## What changed

### Failures propagate

- `GetCatchmentIndicatorsByIDs` — the two `log-and-return-empty` paths (id
  column resolution, query) now return the error. The per-row
  `if err := rows.Scan(...); err != nil { continue }` also returns: a row that
  cannot be scanned is a data fault, and skipping it silently shrinks the
  answer.
- `ComputeWhiskerBounds` — signature is now `(WhiskerBounds, error)`. It had no
  error return at all, so all four whisker table queries failed silently to
  `null`. Its result is **persisted onto the site**, so a swallowed failure did
  not blank one chart; it cached the blank for every later reader.
- `GetCatchmentAttributes` (the identify popup) — now returns an error.
  Previously a failed read produced an empty map, which the handler answered
  with `404 catchment not found`: a false statement about the user's data in
  place of a true one about the server. A catchment the datapack has no row for
  is still reported as absent, with no error — the two are now distinguishable.
- `GetCatchmentAOIFractions` — a site geometry that fails to parse used to
  `return result, nil`, leaving every AOI fraction at its 1.0 default so the
  weighted numbers came out silently wrong. It now errors, and the four
  `ApplyAOIFractions` call sites in `internal/api` propagate rather than
  `log.Printf("Warning: …")` and carry on. (One of the four already did.)
- `GetCatchmentsByIDs`, `DissolveCatchments` — per-row scan errors returned
  instead of `continue`d. A dropped catchment here does not announce itself; it
  just makes a dissolved site boundary quietly smaller than the user selected.
- `buildGridGeometryCache` — see below.

### Grid geometry cache

`buildGridGeometryCache` never checked `rows.Err()`. A read that failed part-way
dissolved, cached and published whatever it had, closed every tier's readiness
channel, and — because a `sync.Once` guarded the build — could never be retried.
Every aggregated choropleth for the life of the process would then have drawn a
continent with holes in it and reported success.

- `rows.Err()` and per-row scan errors are now checked, and a failed build
  publishes **nothing**: a partial cache is worse than none, because the
  aggregated path silently omits cells it has no geometry for.
- `sync.Once` is replaced by `gridGeometryBuilding` / `gridGeometryErr` under
  the existing mutex. A failed build leaves `building` false, so the next
  request starts a fresh attempt with a fresh set of readiness channels. Each
  attempt owns and closes its own channels, so a retry cannot double-close and
  cannot leave an earlier waiter hanging.
- `queryCatchmentsGridAggregated` checks the recorded error after the readiness
  channel releases it. The channel is also closed on failure, so being released
  is no longer proof there is geometry to draw.

### Server-side aggregation (the architectural half)

Chunking alone was explicitly not the fix: at 32,766 catchments the response is
already 1.16 GB, so Africa would have become ~5 GB.

New `AggregateCatchmentIndicators` computes, **in SQL**,

    sum(area × aoiFraction × value) / sum(area × aoiFraction)

per indicator per scenario. Each statement returns exactly **one row of sums**
no matter how many catchments it covers — nothing per-catchment crosses the SQL
boundary. The denominator is per attribute, counting only catchments that
actually have a value for it, matching both `computeAOIWeightedAttributeValue`
(frontend) and `computeAreaWeightedIndicators` (server); a catchment missing one
indicator must not drag that indicator's mean toward zero.

`ComputeWhiskerBounds` was rewritten onto the same helper, so a whisker bound
and the value it brackets are now computed by the same code.

New endpoint: `GET|POST /api/sites/{id}/summary` → `CatchmentAggregate`
(`catchmentCount`, `matchedCount`, `totalAreaKm2`, `reference`, `current`).
Registered for both runtimes, and added to `sharedRoutes` in the route-gating
test.

New `GetCatchmentAreasByIDs` returns id + area + AOI fraction and nothing else —
tens of bytes per catchment instead of ~25 KB. `/whiskers` and `?slim=true` use
it, which is what makes them work for a continent-sized site **without any
frontend change**.

### The query plan is the whole performance story

Getting the aggregate into SQL was not sufficient, and I initially reported
`/whiskers` as working at continent scale when it did not. It took **391 s** and
then failed to write the response. Measured against the real datapack
(147,837 catchments, 502 indicator columns, six tables of 147,837 rows each):

| plan | one whisker table |
| --- | --- |
| weights inline in a `VALUES` clause | **5m 56s** |
| same, all columns in one batch | 5m 59s |
| weights in a TEMP table keyed by `INTEGER PRIMARY KEY` | **9.9s** |

Same arithmetic, same answers, 36× apart. The difference is which way round
SQLite runs the join:

- With the weights inline, SQLite scans the `VALUES` list and looks each
  catchment up through the scenario table's id index — **one random row fetch
  per catchment**, into a table of 505-column rows, repeated for every batch.
- With the weights in a TEMP table whose key is the rowid, it scans the scenario
  table **once, sequentially**, and probes the (small, in-memory) weight table
  per row.

Two things about this were not obvious and are worth recording:

- **Column batching was never the cost.** Raising `aggregateColumnChunkSize`
  from 500 to 900 so 502 columns fit in one statement changed nothing under the
  inline plan (5m56s → 5m59s): the second pass hit a warm page cache. It does
  matter under the materialised plan, where each batch is a full CPU-bound scan.
- **I got this wrong once in this branch.** My first materialised implementation
  stored both id spellings in ordinary indexed columns. That is enough to lift
  the bind-variable ceiling but *not* enough to get the plan: with a plain index
  rather than an `INTEGER PRIMARY KEY`, SQLite went back to `SCAN w, SEARCH s`
  and a dense whisker table took over 200 s again. The schema is load-bearing.

So the plan is now pinned rather than hoped for: the weight table is keyed by
`cid INTEGER PRIMARY KEY`, the join is written `CROSS JOIN` (SQLite's documented
way to fix loop order, with no effect on results), and a table whose id column
is not an integer falls back to the inline plan rather than risking a worse one.
`TestMaterialisedAggregateScansTheScenarioTable` asserts the plan directly with
`EXPLAIN QUERY PLAN`, because nothing else in the suite would notice it
changing — both plans return identical numbers.

The four whisker tables are aggregated concurrently, each with its own weight
set and connection. Sharing one materialised set would mean sharing the one
connection its TEMP table lives on, and so running the tables in sequence. The
work is CPU-bound, not I/O-bound (measured: `read_bytes` flat, one core
saturated), so on a 16-core host four tables at once cost about what one does:
33.1s serial → 10.9s concurrent.

### Measured, whole-of-Africa site (147,837 catchments)

Reproduce with a real datapack (no hard-coded paths; skipped without one):

    DT_DATAPACK_DIR=/path/to/data go test ./internal/geodata/ ./internal/api/ -run TestRealDatapack -v -timeout 30m

Over HTTP, browser runtime, 147,837 ids posted in the body:

| | before | after |
| --- | --- | --- |
| `POST /sites/{id}/whiskers` | **391 s**, then `i/o timeout` writing the response | **13.2 s**, 104,358 bytes of real bounds |
| `POST /sites/{id}/summary` | (did not exist; `/catchments` returned `[]`) | **13.6 s**, 52,406 bytes |
| `POST /sites/{id}/catchments` | 200 with `[]` (3 bytes) | **413** in 60 ms |
| small site (11 catchments), whiskers | 82 ms | **42 ms** |

Where the time goes now, per request: about 3-7 s reading catchment areas and
about 10 s aggregating four whisker tables concurrently. The library-level
figures are `ComputeWhiskerBounds` 10.9 s and `AggregateCatchmentIndicators`
5.8 s.

The small-site case got faster too, because 502 columns now fit in one
statement instead of two.

Correctness is checked, not assumed: `TestRealDatapackWholeContinent` compares
one attribute's aggregate against an independent SQL query written the obvious
way, with no chunking, weight table or column batching in it. It matches to
better than 1 part in 10⁹ (`lowTC_prop` = 0.6191613751348248).

### Two more things measurement found

**The area lookup became the bottleneck, and had the same shape.** With the
aggregates fixed, `GetCatchmentAreasByIDs` was 30 s of a 38 s request — 80% of
it, not the 40% I first wrote. It was doing the same thing the aggregates had
been doing: batched `IN` lookups, one random row fetch per catchment, into
`catchments_lev12`, whose rows also carry a geometry blob. Scanning that table
once against a materialised id set takes 3 s instead. Same technique, same
`CROSS JOIN`, same threshold.

**A REAL column nearly made the whole thing unreachable.** `HYBAS_ID` is a REAL
column, so the same catchment id legitimately appears as `1121879850`,
`1121879850.0` and — once a float64 has been through a generic string
conversion — `1.12187985e+09`. `parseNumericIDs` accepted only the first two,
and the fast plans key on an integer column, so a single exponent-spelled id in
the list silently sent the entire request back to the slow plan. It cost 30 s
instead of 3 s and logged nothing beyond a warning I had only just added. Ids
are now parsed in any integral spelling (`parseCatchmentID`), with a test for
each; genuinely fractional values are still rejected.

## Bounding — what a 147,837-catchment site returns

| Request | Answer |
| --- | --- |
| `POST /sites/{id}/summary` | The intended answer. ~52 KB, 13.6 s over HTTP, at any catchment count. |
| `POST /sites/{id}/whiskers` | Works at this size: 13.2 s, 104 KB of real bounds. |
| `POST /sites/{id}/catchments?slim=true` | id + area + fraction, ~50 bytes each (~7 MB for Africa). Not capped: it is bounded by the id list the client itself sent. |
| `POST /sites/{id}/catchments` (full) | **413** above `MaxDetailCatchments`, with the limit in the message and a pointer to the summary. |

`MaxDetailCatchments = 5000`, now set from measurement rather than estimate.
Every record carries all 502 indicators for both scenarios:

| catchments | body | query | encode |
| --- | --- | --- | --- |
| 100 | 2.6 MB | 0.2 s | 0.1 s |
| 1,000 | 17.9 MB | 0.4 s | 0.5 s |
| 5,000 | **151.6 MB** | 1.9 s | 4.8 s |

which puts Africa at something over 4 GB. 5,000 is where that curve is left:
152 MB and about seven seconds is already far more than a client should be
asked to hold, and it is three orders of magnitude above any site drawn around
a real place. It is a ceiling, not a target.

The old endpoint keeps working, bounded and erroring honestly, for callers that
have not moved to `/summary`.

## Swallowed-error instances found

Fixed:

| Location | Was |
| --- | --- |
| `gpkg_store.go` `GetCatchmentIndicatorsByIDs` — id column resolve | log + empty result, nil error |
| `gpkg_store.go` `GetCatchmentIndicatorsByIDs` — scenario query | log + empty result, nil error |
| `gpkg_store.go` `GetCatchmentIndicatorsByIDs` — row scan | `continue` |
| `gpkg_store.go` `GetCatchmentIndicatorsByIDs` — area query | log + result with no catchments at all |
| `gpkg_store.go` `ComputeWhiskerBounds` — resolve, query, `rows.Err` | no error return; nil maps → JSON `null` |
| `gpkg_store.go` `GetCatchmentAttributes` — both id spellings | `continue`; empty map → handler said 404 |
| `gpkg_store.go` `GetCatchmentAOIFractions` — geometry parse | `return result, nil` |
| `gpkg_store.go` `GetCatchmentsByIDs` — row scan | `continue` |
| `gpkg_store.go` `DissolveCatchments` — row scan, JSON unmarshal | `continue` |
| `gpkg_store.go` `buildGridGeometryCache` — row scan, missing `rows.Err` | partial cache published, all tiers marked ready, never retried |
| `handler.go` × 3 `ApplyAOIFractions` | `log.Printf("Warning: …")` and carry on with wrong weights |

Found and deliberately **not** changed:

- `queryCatchmentsDetailed`, `QueryCatchmentValueArrays`, `fetchCatchmentGridRows`
  — each does `log.Printf("Warning: failed to scan row"); continue`, but each
  checks `rows.Err()` afterwards, so a genuine database failure is already
  reported. What is skipped is a per-row type mismatch, and the code comments
  say `HYBAS_ID` is text in some datapacks and integer in others: turning that
  into a hard failure could break a deployment that works today by taking one
  odd row and blanking the whole choropleth. Worth revisiting with a real
  datapack in hand; not worth guessing at.
- `loadColumns` (`log.Printf("Warning: could not load columns")` in
  `NewGpkgStore`), `loadMetadataCache`, `LoadLookupTables` — startup CSV/schema
  loads with documented degraded behaviour, loaded asynchronously and
  deliberately non-fatal. Different question from a per-request query error.
- `handler.go` `domainRangeFor` — falls back to a 0..0 domain on error. It is a
  colour-scale detail, and its caller has no error path; left alone.
- `handler.go` — whisker-bound caching failure (`siteStore.Update`) is still a
  warning: the answer was already computed and returned correctly, only the
  cache write failed.

## Tests

`go test ./...` was green before any change and is green after. New tests, all
standard-library only (no `go.mod`/`go.sum`/`vendorHash` movement):

`internal/geodata/aggregate_test.go`
- `TestCatchmentIDChunkSizeRespectsSQLiteVariableLimit` — pins 32,766 against
  the linked driver, so a future SQLite lowering the limit fails here rather
  than in production at some site size nobody tried.
- `TestGetCatchmentIndicatorsByIDsReportsQueryFailure`
- `TestGetCatchmentIndicatorsByIDsReportsAnAbsentScenarioTable`
- `TestAggregateCatchmentIndicatorsReportsQueryFailure`
- `TestComputeWhiskerBoundsReportsQueryFailure`
- `TestComputeWhiskerBoundsTreatsAbsentTablesAsNoWhiskers` — absence stays
  distinguishable from failure.
- `TestAggregateCatchmentIndicatorsWeightsByArea` / `…AppliesAOIFraction`
- `TestAggregateCatchmentIndicatorsHandlesMoreIDsThanSQLiteVariables` and
  `TestGetCatchmentAreasByIDsHandlesMoreIDsThanSQLiteVariables` — 37,766 ids.
- `TestGetCatchmentIndicatorsByIDsRefusesUnboundedRequest`
- `TestGridGeometryCacheFailureIsReportedNotDrawnAsEmpty`
- `TestApplyAOIFractionsReportsUnreadableSiteGeometry`
- `TestBothAggregatePlansAgree` — there are now two query plans for the same
  arithmetic, and the fast one is 36× faster, which is exactly the kind of win
  that tempts one into not checking it computes the same number. It does.
- `TestMaterialisedAggregateScansTheScenarioTable` — asserts the plan itself
  with `EXPLAIN QUERY PLAN`. Both plans return identical results, so this is
  the only thing standing between the fast one and a silent return to a
  six-minute request.

`internal/geodata/real_datapack_test.go` — the measurements, skipped unless
`DT_DATAPACK_DIR` points at a real datapack (no hard-coded paths). These are
where every number quoted in the constants' comments comes from, and they can
be re-derived by running them:
- `TestRealDatapackWholeContinent` — 147,837 catchments, timings plus a
  cross-check of the arithmetic against an independent SQL aggregate.
- `TestRealDatapackSmallSite` — guards the plan nearly every real site takes;
  fails if 11 catchments ever take more than 5 s.
- `TestRealDatapackDetailResponseSize` — the basis for `MaxDetailCatchments`.

`internal/api/site_summary_test.go` — the same from the client's end, over the
real router, browser runtime, site in the body:
- `TestSiteCatchmentsFailureIsNotAnEmptySuccess`
- `TestSiteWhiskersFailureIsNotAnEmptySuccess`
- `TestSiteSummaryFailureIsNotAnEmptySuccess`
- `TestSiteCatchmentsRefusesUnboundedResponse` (413, limit named)
- `TestContinentSizedSiteIsAnswerable` (40,000 ids: summary, whiskers, slim)
- `TestSiteSummaryIsAreaWeighted`

The failure tests were checked against the old behaviour: with the three
swallows and the grid-cache check reverted in place, `…ReportsQueryFailure`,
`…ReportsAnAbsentScenarioTable`, `TestGridGeometryCacheFailureIsReportedNotDrawnAsEmpty`
and `TestSiteCatchmentsFailureIsNotAnEmptySuccess` all fail. They are not
vacuous.

Error injection is done by doctoring the synthetic datapack before the store
opens it (the store opens read-only and immutable). Note that SQLite resolves an
unrecognised double-quoted name as a string literal rather than rejecting it, so
a renamed column surfaces as a scan failure, not a prepare failure — both paths
are covered, the second by dropping the table.

Clean: `gofmt`, `go vet ./...`, `go test ./...`, `go test -race` on both
packages, and `golangci-lint run` on both packages (0 issues).

## Not vouched for

- **`MaxDetailCatchments = 5000` is a judgement call.** It is derived from a
  measured ~35 KB per catchment and a refusal to serve gigabyte bodies, but I
  have no census of real site sizes. If a site between 5,000 and 32,766
  catchments exists and is in use, this turns a slow-but-working request into a
  413. The right answer is for every caller to move to `/summary`; until then
  this number is the one thing here most likely to need adjusting.
- **Concurrency and the connection pool.** Each table's aggregation now holds
  one pooled connection for its TEMP table, so a `/whiskers` request at
  continent scale holds four of the sixteen. Four such requests at once will
  saturate the pool and a fifth will queue. That is backpressure rather than
  deadlock — nothing holding a connection reaches for a second one, which is
  why `resolveScenarioIDColumn` and `tableExists` now take the querier as a
  parameter — but it is untested under real concurrent load. Small sites do not
  materialise and so do not hold connections, which is the common case.
- **13 s is better, not good.** `/whiskers` and `/summary` at 147,837
  catchments complete reliably now instead of timing out, but thirteen seconds
  is still a long request, and the browser runtime does not cache the result
  (only the desktop build persists it onto the site). If that is not
  acceptable, the honest options are to bound the endpoints the way
  `/catchments` is bounded, or to compute once and cache server-side; both are
  decisions above my level.
- **The remaining time is roughly half area lookup, half aggregation.** The
  aggregation is a full scan of four 147,837-row, 505-column tables and is
  close to the floor for that shape. The area lookup could in principle be
  avoided entirely for sites whose AOI fractions are all 1, by weighting
  directly from `catchments_lev12.SUB_AREA` inside the aggregate, but that
  turns a two-table join into a three-table one and I have not measured it.
- **AOI fraction convention.** `newCatchmentWeights` treats a fraction outside
  `(0, 1]` as 1, which is what `ComputeWhiskerBounds` has always done and keeps
  whisker numbers identical. The frontend's `normalizeAOIFraction` clamps to
  `[0, 1]` instead, so a catchment with a genuine 0 fraction is excluded there
  and included here. `aoiFraction` is `omitempty` on the wire, so 0 means
  "unset" far more often than it means "no overlap", which is why I chose the
  server's existing rule — but the two conventions disagreeing at all is worth
  a follow-up.
- **`AggregateCatchmentIndicators` does not compute an `ideal` scenario.**
  `CatchmentIndicators` has an `Ideal` map and the frontend dial accepts an
  `ideal` scenario, but ideal values are per-site edits held outside the
  datapack, so there is no table to aggregate. A caller switching the dial to
  "ideal" against `/summary` gets nothing. Whoever moves the frontend over needs
  to know this.
- **`GetCatchmentAOIFractions` is still unbounded in memory** — it fetches every
  catchment's full geometry to intersect. It is now chunked so it cannot fail on
  the variable limit, but a continent-sized site with a drawn boundary would
  still try to hold 147,837 geometries at once. The Africa site is
  `creationMethod: "catchments"`, which skips this path entirely, so it is not
  on the #140 route — but it is a real ceiling that has simply moved rather than
  gone.
- **The datapack was read, never written.** All measurement opened it
  `mode=ro`; the TEMP tables live in the connection's temp store, not in the
  datapack file.
- `internal/server/static/index.html` and `internal/server/docs_site/index.html`
  are gitignored build scaffolding created to make `go build` work here; they
  are not in the commit.
