# dtbench: is it measuring what it claims to measure?

Adversarial review of the benchmark methodology, with measurements. Branch
`bench/perf`.

The short answer: it was not, in four separate ways, and one of them pointed the
headline in the wrong direction. All four are fixed. Several weaknesses remain
and are listed at the end — where the tool cannot honestly support a claim, it
now says so rather than producing a number.

Everything below was measured against a live server with the real 3.45 GB
datapack, on this machine (16 cores, 92 GB). Nothing here is reasoned from the
source alone.

---

## 1. The worst one: a missing endpoint was a fast endpoint

An unrouted `/api/...` path on this server does not 404. It falls through to the
single-page-application handler and returns **200 OK with `Content-Type:
text/html`**. The existing guard — "a fast failure must not read as a win" — keys
on `status >= 400` and therefore never fired.

Measured against the 14 August baseline:

```
catchment-values-viewport   p50 0.11 ms    16 B    ← endpoint did not exist yet
catchment-values-viewport   p50 0.50 ms   725 B    ← today's main
```

The comparison reported that as a **+361% regression** and named it the biggest
regression in the run. So the tool's headline blamed the work that introduced an
endpoint for making it four times slower. That is the exact failure mode the
tool exists to prevent, aimed backwards.

**Fixed.** A scenario now declares the media type and minimum plausible size of a
genuine response (`Scenario.ContentType`, `Scenario.MinBytes`; the content type
is inferred from the path where it is obvious, and I verified the inference
against all fourteen original scenarios on the live server). A response failing
the check is recorded as **absent**, a third state beside working and broken.

The three-state distinction is load-bearing, not pedantry:

| state | meaning | verdict in a comparison |
|---|---|---|
| working | a genuine response | faster / slower / unchanged |
| **absent** | the route or capability is not on this build | `added` / `absent` — never a speed change |
| broken | present and failing | `broken` |

In a sweep, *absent* is the expected state of every revision predating a feature.
Reported as broken it looks like a regression somebody introduced; reported as
faster — which is what happened — it looks like the feature made things worse.

## 2. The background warm-up race, quantified

`/api/health` returns a constant and reads nothing. I measured it answering
**200 at t+0.20 s** after launch, which is the instant a sweep starts measuring.
At that moment the server is still running three startup goroutines. Its own log:

```
Tile cache warmed: 62 tiles for africa z0–5           (sub-second)
Loaded NPP_by_treecover.csv: 154394 catchments        (sub-second)
[perf] grid geometry cache scan+parse done in 4075ms
[perf] grid geometry cache built: 3 tiers in 12476ms
```

The zoomed-out choropleth does not merely run slowly during that window — it
blocks on the cache. Time series from a freshly launched server:

```
t+0.0s    choropleth-domain-aggregated   10358 ms
t+12.0s   choropleth-domain-aggregated    4306 ms
t+17.9s                                   4381 ms
t+23.9s                                   4556 ms
   ...    steady thereafter, 4.1–4.6 s
```

**A 2.4x penalty for the first ~12 seconds**, landing on whichever revision a
sweep measures first. A systematic bias with a consistent direction is the worst
kind, and warmup at the default of 3 requests does not cover it.

**Fixed.** `Execute` now settles before measuring (`settle.go`): it repeats the
*slowest-warming* request — deliberately the grid-aggregated choropleth, not a
cheap one — until two consecutive timings stop improving on the best seen, then
records how long it waited and whether it ever settled. A run that never settled
says so in its notes and in any comparison it appears in.

There is no readiness endpoint to ask instead. `/api/info`'s `tiles_loaded` and
`geo_loaded` are nil-checks on store pointers and are true the instant the
stores open; the only true signal is a line on stderr, which is unavailable for
production. Measuring until improvement stops is the only method that works for
any target.

## 3. Server-side caching: measured, not avoided

First request versus steady state, 20 iterations each, on an already-warm server:

| scenario | 1st | p50 of 2..20 | ratio |
|---|---|---|---|
| catchment-values-viewport | 22.18 ms | 0.49 ms | **44.9x** |
| tilejson | 4.89 ms | 0.76 ms | 6.5x |
| health | 0.65 ms | 0.11 ms | 6.0x (connection setup) |
| catchment-identify | 9.16 ms | 2.36 ms | 3.9x |
| tile-z8 | 0.25 ms | 0.16 ms | 1.6x |
| choropleth-viewport | 26.36 ms | 18.87 ms | 1.4x |
| catchments-bounds | 35.88 ms | 26.69 ms | 1.3x |
| choropleth-domain-aggregated | 4592 ms | 4347 ms | 1.1x |

**Decision: report the cache, do not defeat it.** For most of this suite a cache
hit is genuinely what a user gets, so suppressing it would measure a situation
that does not occur. What was dishonest was presenting the hit as the whole cost
while silently binning the evidence. Warmup timings are now kept (`WarmupMs`),
and `CacheSpeedup` is recorded; above 3x a comparison adds the caveat that the
figure is a cache-hit measurement. `catchment-values-viewport` at 45x is the
clearest example — its 0.49 ms p50 is not the cost of producing that response.

## 4. Statistics: the old method named 30 microseconds as the biggest win

The real comparison that prompted this (14 Aug vs 19 Aug, n=12, same machine and
datapack) produced:

```
3 faster, 7 slower, 4 unchanged
biggest win:        tile-z5 (-27%)              ← 0.11 ms → 0.08 ms
biggest regression: catchment-values-viewport (+361%)   ← artefact, see §1
```

**Eight of thirteen verdicts rested on absolute differences under one
millisecond.** A relative-only threshold has no floor beneath it, so below about
a millisecond it reports the scheduler and the loopback stack, confidently, in
both directions. For scale: within a single run one scenario's samples ranged
0.07–0.44 ms.

**Fixed.** A change must now pass three independent gates:

1. **Absolute** — exceed `practicalFloorMs = 1.0`. Justified by the scatter
   above, not chosen for roundness. The honest consequence: *this tool cannot
   measure a sub-millisecond improvement on a local target and no longer
   pretends to.*
2. **Relative** — exceed `NoiseFloor = 10%`, as before. A millisecond on a
   four-second query is real and irrelevant.
3. **Statistical** — survive a two-sided **Mann-Whitney rank-sum test** over the
   raw samples, which are now stored (`SamplesMs`) precisely so a test is
   possible. Rank-based because latency distributions are bounded below, skewed
   and outlier-prone; the test **declines to run below 8 samples a side**, which
   is the honest answer for the heavy scenarios at n=3.

Effect size is a **Hodges–Lehmann shift with a distribution-free interval**,
because at n=20 that interval is usually wide and a reader who sees it will not
over-read the point estimate.

P-values are corrected across the suite with **Holm**. With 15+ scenarios each
tested at p<0.05 there is roughly a coin flip on at least one false positive, and
a report that names a "biggest win" is by construction selecting the most extreme
of many results.

### Payload size is now a first-class verdict

This is the change most likely to alter what a reader concludes. A byte count is
**deterministic** — same request, same build, same number — so a change in it is
a fact, not an estimate, and needs no statistics.

It is also where the recent work actually shows up. Between those two builds the
timing verdicts were noise in both directions, while:

```
choropleth-viewport             179.2 KB  →   36.6 KB   (4.9x)
choropleth-domain-aggregated      5.5 MB  →    1.7 MB   (3.2x)
```

That is the vector-tile and columnar work landing exactly where it should. A
report leading with timing verdicts had the emphasis backwards for this dataset.

### The null test: the same server against itself

The strongest single validation available. I ran the suite twice against the
same unchanged server, n=20, minutes apart, and compared the two.

```
NEW METHOD:  0 faster, 0 slower, 35 unchanged
OLD METHOD:  5 faster, 3 slower, 22 unchanged
```

The old method's "findings" from comparing a server to itself:

```
scenario                                rel     abs ms
metadata-colors                        -41%    -0.040
columns                                -37%    -0.166
health                                 -35%    -0.028
scenarios                              -30%    -0.025
info                                   -10%    -0.008
catchment-identify                     +16%    +0.328
tilejson                               +19%    +0.138
tour-viphya-aggregate                  +26%    +0.073
```

**Eight verdicts, including a 41% "improvement", from changing nothing at all.**
Any report produced by the old method should be assumed to contain several of
these. The new method produces none.

## 4b. Measuring over loopback penalises every payload win

The bias that most directly attacks the conclusion this tool exists to support.
Tour documents, 14 August against today:

```
                 14 Aug bytes   today bytes    14 Aug p50   today p50
tour-shai-hills      168,496        12,131        0.17 ms     1.54 ms
tour-viphya          455,813        32,471        0.36 ms     3.36 ms
tour-munywana        374,228        33,129        0.35 ms     3.02 ms
TOTAL                999,721        78,194
```

The suite headlined this **"biggest regression: tour-viphya (+830%)"** — the
single best change of the week reported as the worst, and precisely the number a
client would quote back at us.

It is arithmetically true. Three milliseconds of gzip bought 423 KB. But
measured on the same machine as the server, the transfer that saving buys takes
no measurable time, so the change shows **all of its cost and none of its
benefit**. This is systematic: compression, vector tiles instead of GeoJSON, the
columnar endpoint, dropping a duplicated array — every payload-reducing change
in the range this tool is meant to assess has exactly this shape.

**Fixed, and deliberately not by modelling a bandwidth.** Modelling transfer at a
declared link speed would fix the arithmetic and introduce a fresh way to
flatter: pick a slow enough connection and any payload reduction becomes a
triumph, resting entirely on an assumption the reader cannot check.

The headline figure is instead the **crossover bandwidth** — the link speed at
which the trade breaks even. It is bytes saved divided by time added, so it
contains **no assumption at all**, and it hands the reader the comparison rather
than making it for them:

| tour | bytes saved | ms added | breaks even at |
|---|---:|---:|---|
| Shai Hills | 156,365 | 1.37 | **913 Mbps** |
| Viphya | 423,342 | 3.00 | ~1.1 Gbps |
| Munywana | 341,099 | 2.67 | ~1.0 Gbps |

"A win on any connection slower than gigabit" is checkable. "Saves 700 ms at
5 Mbps" is an assertion about somebody's broadband.

Such a change is now its own verdict, `Traded`, never `Slower`, and **a trade can
never be named the biggest regression**. Modelled times at three reference
bandwidths (5 Mbps, 25 Mbps, loopback) remain available for illustration, always
reported together so none can be selected after the fact, each carrying the
bandwidth it assumed.

Two related cases from the same data:

- **`catchment-values-viewport` returned 16 bytes on 14 August** — an empty body
  for an endpoint that did not exist. Now caught by the `MinBytes` floor and
  reported as absent (§1), not as a timing regression.
- **`choropleth-domain-aggregated` is 69% smaller and not one millisecond
  faster** (4290 → 4328 ms). The time is in the query, not the transfer, so no
  bandwidth makes this one a win. That is a genuine finding and the obvious next
  target: it is the most expensive request in the suite and the payload work has
  taken it as far as it can go.

## 5. Conditional requests: the honest answer is "not implemented"

The brief listed ETag/conditional requests as one of the largest wins available.
**It is not in this codebase.** Verified two ways:

- `grep -rniE 'etag|if-none-match|StatusNotModified'` over `internal/` outside
  `internal/bench` matches nothing but a `compress.go` line that avoids
  compressing a 304 some other layer might produce.
- Live headers on all 14 endpoints: **not one carries an `ETag`.**

```
choropleth-viewport   Cache-Control: public, max-age=300     ETag: (none)
tile-z8               Cache-Control: public, max-age=86400   ETag: (none)
tilejson              Cache-Control: public, max-age=3600    ETag: (none)
```

So endpoints tell clients to cache for up to a day but give them no way to
revalidate: a client holding a stale copy must refetch all 35 KB.

I added two `Conditional` scenarios anyway — `tile-z8-revalidate` and
`choropleth-viewport-revalidate` — which currently report **absent** with the
reason. This is deliberate. Leaving the win unmeasured is how a missing feature
stays missing; a scenario that reports "unsupported on this build" every run is a
dated, machine-checked statement that the win is still on the table, and it
starts producing a number the day someone sets a header. **The implementation
refuses to time a 200 as though it were a 304**, so it cannot silently start
reporting a saving that does not exist.

## 6. Sweep fairness

**The build shim.** `webkitCompatEnv` looked for `scripts/webkit-compat.sh`
*inside the revision being built*. That script only entered the repository on
2026-08-17 — after the work a sweep is meant to demonstrate began. Every older
revision therefore failed to build and was skipped, and a sweep asked to cover
the week would have measured its last two days and reported that as the whole
story. Now resolved from the tool's own checkout first, which is correct rather
than expedient: the shim compensates for what is installed on this machine
today, nothing about it is revision-specific. (Credit: found by the coordinator;
verified by building `f382258` with the current shim.)

**Port identity — I hit this myself.** The server does not fail when its port is
taken. It logs `Port 8098 in use, using port 8102 instead` and listens
elsewhere. My first cold-start probe measured a *leftover server from an earlier
session* for three minutes and produced entirely plausible, entirely wrong
numbers — I only caught it because the payload sizes disagreed with the live
server by the gzip ratio. In a sweep this failure is silent and total: every
revision measured against the same foreign process, every result identical, a
flat line that reads as "nothing changed". `startServer` now refuses to proceed
if the log shows a relocation.

**Coverage accounting.** When fewer revisions are measured than requested, the
shortfall is now written *into every stored result*, not merely printed — the
stored file is what a report is built from weeks later, and the numbers look
identical either way.

**Go version** is now recorded per run: two revisions compiled by different
toolchains are not a clean comparison of their source.

## 7. Ordering — I did not randomise, and that is deliberate

The brief suggested randomising scenario order. **The intuitive answer is the
wrong one here**, so the option exists but defaults off.

Scenarios do interfere — a 4-second, 1.8 MB query leaves the page cache, the
SQLite cache and the Go heap in a state the next scenario inherits. But this
tool's output is almost always a *difference between two runs*, and a bias
identical on both sides of a subtraction **cancels**. Randomising gives each run
a *different* bias, which does not cancel and instead inflates the variance of
every comparison. Fixed order is therefore correct for comparing.

`Options.Shuffle` (with a recorded seed) exists to answer the separate question
"does order matter here at all" by running both ways and looking. Turning it on
for one side of a comparison and not the other would be worse than either.

## 8. Coverage: the four tours, and three unmeasured view modes

Every original scenario was the map path or metadata. The application has four
view modes — map, chart, dial, table — and **three were unmeasured**, which are
precisely the three consuming the per-catchment breakdown, the data the recent
work changed most.

All four guided tours are now measured, not one, because they span four orders
of magnitude and the recent work traded per-request cost against payload size —
exactly the shape of change that does not scale uniformly.

First measurements (n=3, warm, wire bytes):

| tour | catchments | document | choropleth | catchments (table) | whiskers (dial) | aggregate (chart) |
|---|---:|---|---|---|---|---|
| Shai Hills | 2 | 1.40 ms / 11.8 KB | 1.08 ms | 6.41 ms | 16.02 ms | 0.44 ms |
| Viphya | 7 | 3.80 ms / 31.7 KB | 2.71 ms | 19.18 ms | 43.62 ms | 0.46 ms |
| Munywana | 11 | 3.40 ms / 32.4 KB | 4.00 ms | 16.54 ms | 32.76 ms | 0.46 ms |
| Africa | 147,837 | 80.11 ms / 456 KB | *heavy* | *heavy* | *heavy* | *heavy* |

Plus `tour-manifest` at 0.21 ms / 463 B — the banked win where rendering four
titles no longer requires downloading 4.8 MB of tour documents.

Two things I would not have predicted and that are worth someone's attention:

- **The dial view is the most expensive of the three**, 2–3x the table view for
  the same tour.
- **Viphya (7 catchments) is consistently slower than Munywana (11)** on both
  catchments and whiskers. Catchment count is not the cost driver; geometry
  complexity probably is.

**`/api/aggregate` is the largest unmeasured cost in the application.** Over the
full domain a *single* attribute takes **4.77 s** (200, 30 bytes returned). The
chart view issues **six of these in parallel per render, each with a 12-attribute
batch**. Over a tour's own extent it is 0.44 ms, so the cost is entirely driven
by extent. This endpoint was completely absent from the suite.

Request shapes are mirrored from the client, not guessed:
`POST /api/sites/{id}/catchments` with `{"runtime":"browser","site":{...}}` —
the GET form 404s for a walkthrough because the server holds no record of it,
and on an older build that 404 becomes a 200 HTML page. The `indicators` block
is stripped from the posted site because the handler short-circuits and echoes
cached bounds back when it is present, which would have measured a JSON round
trip and reported it as the cost of computing whisker bounds.

---

## Known weaknesses of the method

Listed because a tool used to argue that a week of work paid off should be
explicit about what it cannot show.

1. **Twenty samples cannot support a strong claim about a small effect.** Holm
   correction across ~37 scenarios makes this stricter still. Genuine
   improvements below roughly 15–20% may be reported as unchanged. This is a
   deliberate trade: a false "unchanged" costs a rerun, a false "faster" costs
   the tool's credibility. **If a claim matters, raise `-n` and rerun.**

2. **Sub-millisecond scenarios cannot be compared at all** on a local target.
   They remain useful as liveness checks — a metadata endpoint suddenly taking
   50 ms is worth knowing — but the tool will no longer call them faster or
   slower. Roughly a third of the suite is in this category locally.

3. **Remote targets measure the network.** Against production every cheap
   scenario landed within 1 ms of a 222 ms floor, 2,000–3,000x the local figure.
   `FloorMs` and `ServerMs()` let a reader subtract it, but subtracting 222 from
   223 leaves noise, not a measurement. **"How long does a user in Johannesburg
   wait" is answerable; "did our code get faster" is not, from a remote run.**

4. **Production reports its version as `dev`**, so its results cannot be
   attributed to a build and cannot participate in a version comparison until
   the container publishing work lands.

5. **Production is ~3x faster than local at the most expensive query** (1,736 ms
   vs 4,400 ms) *despite* the 222 ms floor working against it. Could be
   hardware, a warmed cache, a different datapack, or nginx caching in front.
   The tool cannot currently tell these apart and **should not be read as
   implying the comparison is like-for-like.**

6. **The machine is shared and the tool cannot fully detect it.** While writing
   this, a teammate's dtbench run was hitting the same server concurrently.
   `FloorDriftPercent` (floor measured before and after each run) catches gross
   cases and warns above 50%, but moderate contention will still pass as data.

7. **Settling is measured, not guaranteed.** It uses the slowest-warming known
   request. A future cache with a slower warm-up that this probe does not touch
   would reintroduce the bias silently.

8. **Only latency, never throughput.** One request at a time, by design. Nothing
   here says how the server behaves under concurrent load, and the chart view's
   six parallel aggregate calls are a real case the suite models as one.

9. **`MinBytes` floors are hand-set** and generously low. A payload that shrank
   below its floor for a legitimate reason would be misreported as absent. They
   are set well under current sizes, but they are a maintenance liability.

10. **The crossover bandwidth is exact; anything downstream of it is not.**
    Bytes saved over time added is a fact, but it assumes the whole payload
    crosses the link once and ignores TCP slow start, request concurrency and
    client-side decompression cost. It is a good decision aid and a bad
    stopwatch.

11. **The heavy scenarios cannot be tested statistically** at n=3. Their verdicts
    fall back to the summary-statistics check, which is disclosed but weak — and
    they are the most expensive and arguably most interesting requests.

---

## What I need from other territories

**UX specialist (`report.go`, `cmd/dtbench/main.go`):**

- **`absent` needs its own wording, distinct from broken.** The CLI currently
  prints `no successful samples` for an absent scenario, which reads as a fault
  and is the wrong sentence for a capability a build simply does not have. I
  added a run-level note listing absent scenarios as a stopgap; the per-line
  wording is yours. `ScenarioResult.Absent` / `.AbsentReason` carry a
  ready-to-print sentence.
- New verdict `Absent`, and `BytesVerdict` (`smaller`/`larger`/`same`/`unknown`).
- `Delta.SignificanceNote()` returns a ready-made sentence describing what the
  test established, or why it could not run.
- Flags worth exposing: `--shuffle` (`Options.Shuffle`/`ShuffleSeed`),
  `--settle-timeout` (`Options.SettleTimeout`; negative skips), and
  `--webkit-compat` on sweep (`SweepOptions.WebkitCompat`).
- **Your three asks are landed:**
  - `ScenarioResult.LastError` — verbatim transport error from the last failed
    request.
  - `--warmup 0` now means zero. Negative selects the default. The flag default
    in `main.go` is already 3, so nothing changes unless a user asks for 0.
  - The absolute floor constant is **`PracticalFloorMs`** (= 1.0), exported. Your
    temporary 1 ms framing override in `report.go` can go.
- New verdict `Traded` and `Delta.Trade` (`.Describe()` gives a ready sentence,
  `.CrossoverMbps` the assumption-free number). `TimeToReceiveMs(serverMs, bytes,
  bw)` and `ReferenceBandwidths` are there if you want the illustrative figures —
  please print all three bandwidths together and label each, never one alone.
- **Suggested framing change**: for the current data, lead with payload size and
  treat timing as secondary. Bytes are exact; timings at this sample size mostly
  are not.

**Designer (`report.html.tmpl`):**

- `NoiseFloorPercent` is still exported and unchanged, but it is no longer the
  whole story — there is now an absolute floor and a significance test too.
  Describing the method as "changes under 10%" would now be inaccurate.
- New states to style: `absent` and `traded` verdicts, and a byte verdict
  independent of the timing verdict. `traded` should read as neither good nor
  bad — it is a trade whose direction depends on the reader's connection.

**QA engineer:**

- My tests are in `scenario_validation_test.go`, `stats_methodology_test.go` and
  `compare_verdict_test.go` — named after what I changed, to stay out of your
  way.
- The regression cases worth keeping forever are in `compare_verdict_test.go`:
  the 0.03 ms "biggest win" and the phantom +361% regression.

**Server-side (nobody's territory here, but worth raising):**

- **No ETag anywhere.** Endpoints advertise `max-age` up to a day with no way to
  revalidate. The scenarios to prove the win are already written and waiting.
- `/api/scenario/{scenario}/{attribute}` and `/api/compare` 404 with `no such
  column: catchment_id`. `GetScenarioData` hardcodes the id column while
  `resolveScenarioIDColumn` — which already handles this — sits unused beside it.
- `/api/aggregate` at 4.77 s per attribute over the full domain, x6 per chart
  render, is the largest unmeasured cost in the application.
- `GetDomainRange` runs two uncached SQLite queries on *every* choropleth and
  catchment-values request; `/data/tiles.json` re-reads the mbtiles metadata
  table every time.
