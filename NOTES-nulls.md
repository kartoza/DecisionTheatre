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

per indicator per scenario. The weights go in as a `VALUES` CTE joined to the
scenario table, so each statement returns exactly **one row of sums** no matter
how many catchments it covers — nothing per-catchment crosses the SQL boundary.
The denominator is per attribute, counting only catchments that actually have a
value for it, matching both `computeAOIWeightedAttributeValue` (frontend) and
`computeAreaWeightedIndicators` (server); a catchment missing one indicator must
not drag that indicator's mean toward zero.

`ComputeWhiskerBounds` was rewritten onto the same helper, so a whisker bound
and the value it brackets are now computed by the same code.

New endpoint: `GET|POST /api/sites/{id}/summary` → `CatchmentAggregate`
(`catchmentCount`, `matchedCount`, `totalAreaKm2`, `reference`, `current`).
Registered for both runtimes, and added to `sharedRoutes` in the route-gating
test.

New `GetCatchmentAreasByIDs` returns id + area + AOI fraction and nothing else —
tens of bytes per catchment instead of ~35 KB. `/whiskers` and `?slim=true` now
use it, which is what makes them work for a continent-sized site **without any
frontend change**.

### Chunking

`catchmentIDChunkSize = 16000` (two bind variables per id in the widest form,
half of 32,766, rounded down) applied to every id-list query:
`GetCatchmentIndicatorsByIDs`, `GetCatchmentAreasByIDs`, `GetCatchmentsByIDs`,
`DissolveCatchments`, and the aggregate. `aggregateColumnChunkSize = 500` keeps
the aggregate's two-result-columns-per-attribute under SQLite's 2,000 column
limit (also confirmed empirically: 1,999 ok, 2,001 fails).

## Bounding — what a 147,837-catchment site returns

| Request | Answer |
| --- | --- |
| `POST /sites/{id}/summary` | The intended answer. Fixed size (a few KB) at any catchment count. |
| `POST /sites/{id}/whiskers` | Works at any size now — weights-only fetch. |
| `POST /sites/{id}/catchments?slim=true` | id + area + fraction, ~50 bytes each (~7 MB for Africa). Not capped: it is bounded by the id list the client itself sent. |
| `POST /sites/{id}/catchments` (full) | **413** above `MaxDetailCatchments`, with the limit in the message and a pointer to the summary. |

`MaxDetailCatchments = 5000`. The real datapack yields ~35 KB of JSON per
catchment (1.16 GB / 32,766 — every record carries every indicator for both
scenarios), so 5,000 is ~175 MB. That is still far more than any client should
be asked to parse, but it is comfortably above any site drawn around a real
place (Munywana is 11 catchments) while making a gigabyte-scale body
unreachable. **This number is a judgement call** — see "not vouched for".

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
- **The aggregate's SQL has not been run against the real datapack** — there is
  no `datapack.gpkg` in this checkout. The arithmetic is covered by tests on the
  synthetic pack, but the *plan* is not: whether SQLite uses an index for the
  `VALUES` CTE join, and how the 147,837-catchment case performs in wall-clock
  terms, is unmeasured. If it is slow, the shape to try is a covering index on
  the scenario tables' id column, not a change to the query.
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
- `internal/server/static/index.html` and `internal/server/docs_site/index.html`
  are gitignored build scaffolding created to make `go build` work here; they
  are not in the commit.
