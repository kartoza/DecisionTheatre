# dtbench — QA notes

Branch `bench/qa`, worktree `DecisionTheatre-wt/bench-qa`. Nothing pushed; nothing
outside this worktree touched.

`dtbench` had no tests. It now has **144 test functions** across seven files, plus
a manual end-to-end verification recorded below.

    internal/bench/result_test.go        24   percentiles, storage, identity
    internal/bench/run_test.go           26   the HTTP runner, over httptest
    internal/bench/compare_test.go       30   verdicts, caveats, warnings
    internal/bench/report_test.go        22   rendering, escaping, formatting
    internal/bench/scenario_test.go      10   the suite and URL construction
    internal/bench/brand_test.go          6   palette drift and branding
    internal/bench/contenttype_test.go    6   SPECIFICATION — four of these fail
    cmd/dtbench/main_test.go             20   the four commands

Standard library only. No new module, so `go.mod`, `go.sum` and the flake's
`vendorHash` are untouched. No test touches the network, the datapack, the live
server or the wall clock.

## Status of the suite

**On `bench/integration`, everything passes.** `go build ./...`, `go vet ./...`,
`gofmt -l` and `go test ./...` are clean across the repository, over three
consecutive runs and under `-race`.

The QA suite is 50 test functions in eight files:

    internal/bench/result_test.go        24   percentiles, storage, identity
    internal/bench/run_test.go           26   the HTTP runner, over httptest
    internal/bench/compare_test.go       32   verdicts, caveats, warnings
    internal/bench/report_qa_test.go     22   rendering, escaping, formatting
    internal/bench/scenario_test.go      10   the suite and URL construction
    internal/bench/brand_test.go          6   palette drift and branding
    internal/bench/contenttype_test.go    6   absence detection
    cmd/dtbench/main_qa_test.go          22   the four commands

alongside the suites ux, perf and design brought, for 203 test functions in the
two packages in total.

Standard library only. No new module, so `go.mod`, `go.sum` and the flake's
`vendorHash` are untouched. No test depends on the network, the datapack, a live
server or the wall clock.

### The four tests that used to fail here

Earlier in this work `contenttype_test.go` failed by design — it was written as
the specification for absence detection, before the behaviour existed, so the
acceptance criteria would not be written by the same hand as the fix. Perf has
implemented it and all four now pass. The file is now the regression guard, and
the deviation from my brief is closed.

--- FAIL: TestAnAPIEndpointAnsweringHTMLIsNotRecordedAsAFastSuccess      (11 subtests)
    --- FAIL: TestATileEndpointAnsweringHTMLIsNotRecordedAsAFastSuccess      (2 subtests)
    --- FAIL: TestAnEndpointThatDidNotExistInTheBaselineIsNotReportedAsARegression
    --- FAIL: TestAResponseLabelledJSONWhoseBodyIsNotJSONIsNotRecordedAsASuccess

This is deliberate and it is the one deviation from my brief, which asked for a
green `go test ./...`. The coordinator's later instruction was explicit: write the
failing test, do not implement the fix, because the performance specialist owns
`run.go` and `scenario.go` and two people editing them will collide. The four
tests are the acceptance criteria for that work. They live in their own file,
`internal/bench/contenttype_test.go`, with the whole problem written at the top,
so they are easy to find and easy to run in isolation:

    go test ./internal/bench/ -run 'AnsweringHTML|DidNotExist|WhoseBodyIsNotJSON'

Everything else in the package is green, so a `-run` filter or deleting that one
file gives a clean suite at any point.

---

## Bugs found

### 1. Reports and PDFs came out with no typeface at all — FIXED

**Severity: high.** Every report and every PDF the tool has ever produced was
rendered in the browser's default serif, with the string `ZgotmplZ` sitting in its
stylesheet.

`html/template`'s CSS value filter rejects any interpolated value containing a
quote and substitutes the sentinel `ZgotmplZ`. The brand font stacks contain the
quotes a `font-family` requires:

    FontSans: "Nunito, 'Helvetica Neue', Arial, sans-serif"
    FontMono: "'JetBrains Mono', monospace"

so the rendered stylesheet read:

    --sans:ZgotmplZ; --mono:ZgotmplZ;

and every `font-family: var(--sans)` in the document resolved to nothing. The
colours were unaffected — hex values pass the filter — which is why it was
invisible: the report looked branded, just in the wrong type.

Found by `TestTheBrandReachesTheRenderedReport`, which also asserts that
`ZgotmplZ` never appears anywhere in the output.

**Fix:** `internal/bench/brand.go` — `FontSans` and `FontMono` typed as
`template.CSS` instead of `string`, an `html/template` import, and two conversions
in `BrandFromFile`. Five lines. **`report.html.tmpl` is untouched**, which is
deliberate: the visual designer is editing that file and a template change would
have collided. The values are safe to mark as CSS — `DefaultBrand`'s are
compile-time constants and `BrandFromFile` reads a repository asset.

### 2. `dtbench list` panics on a results file with a short commit — FIXED

**Severity: medium.** `cmdList` sliced `r.Commit[:8]` with no length check, while
the rest of the package uses a guarded helper.

    runtime error: slice bounds out of range [:8] with length 3

A results file is data read off disk. One file with a short revision string took
down the whole listing and with it any chance of finding the other results.
Found by `TestListSurvivesAResultsFileWithAShortCommit`.

**Fix:** `cmd/dtbench/main.go` — a local length-checked `shortCommit`, mirroring
the one already in `result.go`.

Related and **not fixed**: `cmdSweep` has the same unguarded `r.Commit[:8]`. It is
safe today because those revisions come from `git rev-list`, which always returns
full SHAs. Left alone to keep the diff small.

### 3. `truncate` cut through the middle of a UTF-8 rune — FIXED

**Severity: low.** `truncate` counted and sliced bytes. `dtbench sweep` truncates
every commit title to 62 characters, and commit titles routinely carry accented
names, typographic dashes and the occasional emoji, so a cut could land inside a
rune and print a replacement character:

    truncate("feat: 🎉 ship the dial", 9) = "feat: \xf0\x9f…"   // invalid UTF-8

Found by `TestTruncateCutsOnRuneBoundariesNotByteBoundaries`.

**Fix:** `cmd/dtbench/main.go` — count and cut in runes.

### 4. An endpoint that does not exist is recorded as a fast, healthy sample — NOT FIXED

**Severity: high. This is the one that makes the numbers untrustworthy.**

Reported by the coordinator against the 14 August build; I confirmed it is still
true of the build running right now:

    $ curl -D - http://127.0.0.1:8080/api/does-not-exist
    HTTP/1.1 200 OK
    Content-Length: 2703
    Content-Type: text/html; charset=utf-8

Decision Theatre serves a single-page application, and any path the API router
does not claim falls through to the SPA handler. So a missing endpoint is not a
404 — it is a fast, small, entirely successful-looking 200, and dtbench records it
as a healthy sample.

The existing guard, "a scenario that starts failing must be called broken rather
than fast", cannot catch this, because the status is 200. The consequence is worse
than a missing number: measured against a build from before an endpoint was
written, the endpoint appears to have existed all along **and to have been several
times faster before it was implemented**.

Not fixed here — the fix belongs in `scenario.go`/`run.go`, which the performance
specialist owns. `internal/bench/contenttype_test.go` is the specification. It
deliberately takes its scenarios from the real `Scenarios()` suite and asserts only
on observable outcomes, so the implementation is free to add a field to `Scenario`,
infer the expectation from the path, or do something else entirely. One design note
for whoever implements it, in the file and repeated here: validating the body of
every measured request adds work inside the thing being timed, and for the 14 MB
scenario that is not a rounding error — validate on the warmup request, which is
discarded anyway, and check only the cheap headers on measured requests.

Two related cases in that file **pass today** and are recorded as regression
guards, so a content-type change cannot lose them: a proxy's HTML error page
(carries a 5xx, already rejected on status) and a body shorter than its declared
`Content-Length` (surfaces as an unexpected EOF).

### 5. `--warmup 0` silently makes three warmup requests — NOT FIXED

**Severity: low.** `applyDefaults` promotes both `0` and any negative value to `3`,
so warmup cannot be switched off. That matters to anyone measuring cold-cache
behaviour, where the warmup is the thing being measured. In `run.go`, so left to
the performance specialist. Recorded by
`TestWarmupCannotCurrentlyBeSwitchedOff`, which is written to fail loudly with an
instruction once the behaviour changes.

### 6. Two partly-failing runs get a clean timing verdict — NOT FIXED

**Severity: medium.** The broken check fires only when the current run has errors
and the baseline has none. An endpoint failing 50% of the time in *both* runs falls
through to a plain speed comparison with no caveat at all — and the requests that
fail are often the slow ones, so the surviving median flatters whichever side is
sicker. Recorded by
`TestBothRunsPartlyFailingIsCurrentlyReportedAsACleanTimingComparison`.

### 7. `WritePDF` reports success for a PDF containing no text — NOT FIXED

**Severity: medium.** Its only check is that the file exists:

    if _, err := os.Stat(pdfPath); err != nil { ... }

During my end-to-end run this produced a 19 KB, two-page, correctly branded,
**entirely wordless** PDF, and the tool printed `wrote benchmarks/qa-report.pdf`.
The cause was environmental — this sandbox has no `/etc/fonts`, so headless
Chromium had no fonts and drew no glyphs — and I proved it by supplying a
`FONTCONFIG_FILE` and re-rendering, after which the same command produced a
six-page, 148 KB PDF with fonts embedded and 458 lines of extractable text.

The environment is not dtbench's fault. Reporting success is. A check that the
output contains an embedded font resource, or simply a plausible size floor, would
have caught it. As it stands the failure mode is handing a client a beautiful,
empty document.

### 8. The noise floor is too loose for the cheap scenarios to survive it

**Severity: medium, and it is a judgement call rather than a defect.** See the
control run below: two measurements of the *same build* against the *same server*
produced *3 faster, 2 slower*, with a headline "biggest win: info (-37%)". At
sub-millisecond medians, run-to-run variation comfortably exceeds 10%, so the
tool will confidently report fabricated wins for `health`, `info`,
`metadata-colors`, `scenarios`, `tile-z5` and `tile-z8`. The overlap caveat fired
on `info` but not on `health`, which was reported as a clean 36% win with no
hedging at all.

The `NoiseFloor` comment argues correctly that 10% is deliberately blunt. It is
not blunt enough for scenarios whose absolute times are tens of microseconds. A
floor expressed in absolute milliseconds as well as a percentage — "unchanged
unless it moved by 10% *and* by more than a millisecond" — would fix it without
weakening the guard on the scenarios that matter.

### 9. Smaller findings, not fixed

- **A failed write is discovered after the whole suite has run.** `--results` into
  a read-only directory runs all fourteen scenarios (about 90 seconds) and *then*
  fails with `create results directory: permission denied`. A sweep would lose
  half an hour. Check writability before measuring.
- **A garbage target produces a plausible-looking file.** `--target 'not a url at
  all'` parses as a relative URL, so every request fails, the suite completes, the
  process **exits 0**, and a results file is saved that `dtbench list` shows
  identically to a real run. The console output is honest ("no successful samples"
  fourteen times) but nothing in the saved file or the exit code is.
- **`choropleth-domain-aggregated` is 4.4 s and 1.7 MB but is not marked `Heavy`.**
  A default `dtbench run` therefore takes about 90 seconds and pulls 34 MB, most
  of it from that one scenario. It is not the 14 MB monster, but it is not a
  light request either.
- **`humanBytes` and `orDefault` are implemented twice**, in `report.go` and in
  `cmd/dtbench/main.go`. `TestCommandLineSizesReadTheSameWayTheReportsDo` pins
  them together so a run summary cannot start disagreeing with the report
  generated from it, but the duplication should go.
- **`ReportOptions.MarkPath` is injected as raw, unescaped HTML** — correct today,
  since it is a repository SVG, and covered by
  `TestTheBrandMarkIsEmbeddedAsRawMarkupByDesign` so the assumption is written
  down. Anyone who later points `--mark` at something untrusted is injecting
  markup into the report.

---

## What the tests cover

**Percentiles.** One sample, two samples, all-identical samples, odd and even
counts, a hundred samples, no samples, ranks outside 0–100, and that `Summarise`
does not sort its caller's slice in place.

**The runner, over `httptest`.** Warmup issued and excluded (the fixture makes the
warmup requests slow, so a leak shows up as a maximum far above the measured
range); a failing warmup not counted as an error; every-request-404 recorded with
no timings at all; partial failure counted with `Samples + Errors` accounting for
every attempt; timeouts; a server that closes the connection mid-body; a cancelled
context; gzip **wire** bytes rather than the decompressed size, with an assertion
that the fixture actually compressed so the test cannot pass vacuously; ETag and
Cache-Control captured; a varying response size recorded as a range; the `-1`
sentinel never escaping; TTFB never exceeding the total; heavy scenarios skipped
with a reason and capped when included; POST bodies and content types; trailing
slashes; unparseable targets refused before measuring; and whole-suite provenance.

**Comparison.** The noise floor from both sides, exactly on it and just inside it;
relative and absolute changes agreeing in sign; `Speedup` refusing to divide by
zero; broken, partly-broken, recovered, skipped, added and removed scenarios; two
runs with nothing in common; two empty runs; a run with zero scenarios; the
overlap caveat firing and, equally, *not* firing when distributions separate
cleanly; the bytes-changed-without-time caveat; all four warnings, plus the
assertion that two comparable runs produce **no** warnings; delta ordering; and
the headline naming the true extremes.

**The report.** Renders as a complete document; carries the Kartoza triplet; names
broken scenarios; the lede refusing to lead with a win when something is broken;
caveats and warnings surviving into the markup; **the numbers in the HTML matching
the numbers in the comparison**, checked delta by delta; every scenario getting a
row including ungrouped ones; an empty comparison still rendering something true;
bar widths inside 0–100 and inside their style attribute; the brand mark present
and a missing one not fatal; and number formatting — precision, multiples versus
percentages, byte units, verdict labels, placeholders for skipped and unsampled
scenarios.

**Escaping.** A `<script>` payload injected through the scenario name, group, why,
label, target, host, title, subtitle and a warning, asserted absent as markup and
**present as escaped text** — escaping is not the same as dropping the row. Then
the same again through a real save/load cycle, so escaping that works on a
hand-built comparison but not on one that came off disk would still fail.

**Storage.** Round trip compared by re-encoding, so a field added later is covered
without touching the test; a reloaded run compared with itself producing no
change and no warnings; the temporary file not left behind; a missing directory
created; a read-only one refused with a comprehensible message; a newer schema
refused by name and number; an older schema still loading; corrupt files named
and skipped without hiding the rest; non-JSON files in the results directory
ignored; and filenames that sort by time and cannot escape the directory.

**Branding.** `TestBrandMatchesSourceOfTruth` — the drift test that `brand.go`'s
own comment promised existed and which did not. It reads
`docs/assets/css/kartoza-palette.json` and reports field by field which colour
has drifted.

**The commands.** `report` refusing to run without both sides and pointing at
`dtbench list`; naming a file it cannot read; writing the HTML it was asked for;
failing comprehensibly into a missing directory; refusing a newer schema; two
runs with nothing in common; a run with zero scenarios. `list` on an empty
directory, a populated one, a corrupt file, and a short commit. `run` refusing a
bad target without leaving a file behind, and saving an honest result against an
unreachable one.

## What I deliberately did not cover

- **`sweep.go` is untested.** It builds each revision in a git worktree, starts a
  server and measures it: minutes per revision, a real checkout, a real build and
  a real port. There is no way to test it that respects "no network, no wall
  clock, no live server", and a test that shells out to `git` and `go build` would
  be slower than the rest of the suite by three orders of magnitude. The
  pure-function parts — `applyDefaults`, and `Revisions`'s argument construction —
  could be tested by extracting them; that is a refactor of the performance
  specialist's file and I have not made it. **This is the largest gap in the
  suite and the reason for the caveat in my verdict.**
- **`WritePDF` is not unit-tested.** It shells out to a browser. It is covered by
  the end-to-end run below instead, which is how the wordless-PDF finding was
  made.
- **No golden-file test of the report HTML.** The visual designer is actively
  changing the template; a byte-exact golden file would fail on every commit of
  theirs and would be deleted within a day. The tests assert on content and
  invariants instead.
- **No concurrency or load testing.** The tool measures latency one request at a
  time, by design, and does not claim to answer a throughput question.

---

## End-to-end verification

Live server on `http://127.0.0.1:8080`, version `0.4.0-211-g7fb8f6b`, real
3.45 GB datapack. `--heavy` was not used at any point.

    cd /home/timlinux/dev/go/DecisionTheatre-wt/bench-qa
    eval "$(./scripts/webkit-compat.sh)"
    go build -o /tmp/dtbench-qa ./cmd/dtbench

    /tmp/dtbench-qa run --target http://127.0.0.1:8080 --label qa-before \
        -n 20 --warmup 3 --results benchmarks/results
    # saved benchmarks/results/20260819-053859-qa-before.json

    /tmp/dtbench-qa run --target http://127.0.0.1:8080 --label qa-after \
        -n 20 --warmup 3 --results benchmarks/results
    # saved benchmarks/results/20260819-054051-qa-after.json

    export FONTCONFIG_FILE=/tmp/fc/fonts.conf     # see finding 7
    /tmp/dtbench-qa report \
        --baseline benchmarks/results/20260819-053859-qa-before.json \
        --current  benchmarks/results/20260819-054051-qa-after.json \
        --out benchmarks/qa-report.html --pdf \
        --title "dtbench QA verification" \
        --subtitle "Same build, same server, twice — a control run"
    # wrote benchmarks/qa-report.html
    # wrote benchmarks/qa-report.pdf
    #
    # 3 faster, 2 slower, 9 unchanged
    # biggest win:        info (-37%)
    # biggest regression: tilejson (+12%)

I ran the *same build against the same server twice on purpose*. Every scenario
should have come back unchanged. Five did not.

**Artefacts** (left in place, untracked, not committed):

    benchmarks/results/20260819-053859-qa-before.json
    benchmarks/results/20260819-054051-qa-after.json
    benchmarks/qa-report.html                     21,502 bytes
    benchmarks/qa-report.pdf                     148,222 bytes

**PDF verification:**

    $ pdfinfo benchmarks/qa-report.pdf
    Title:       dtbench QA verification
    Pages:       6
    Page size:   594.96 x 841.92 pts (A4)
    File size:   148222 bytes
    $ pdffonts benchmarks/qa-report.pdf | tail -n +3 | wc -l
    14                      # fonts embedded (0 before the fix in finding 7's environment)
    $ pdftotext benchmarks/qa-report.pdf - | wc -l
    458                     # real, extractable text

Six pages, not zero bytes, fonts embedded, text extractable. I rendered pages 1
and 2 to PNG and read them: the cover carries the Kartoza mark, the title, both
run identities, the target and the generation time; page 2 carries the scenario
table with numbers, bars, verdicts and the overlap caveat on `info` in amber. The
`--sans` custom property now reads `Nunito, 'Helvetica Neue', Arial, sans-serif`
rather than `ZgotmplZ`, confirming finding 1 is fixed in the real artefact.

Before the fontconfig workaround the identical command produced a **2-page,
19,178-byte PDF with no embedded fonts and zero extractable text** — laid out and
branded, and completely wordless — while reporting success. That is finding 7.

**What the control run reported** (same build, same server, twice):

    health                     0.16 ms → 0.10 ms   -36%   faster      << noise
    info                       0.13 ms → 0.08 ms   -37%   faster      << noise
    metadata-colors            0.14 ms → 0.09 ms          faster      << noise
    choropleth-viewport          22 ms →   24 ms          slower      << noise
    tilejson                   0.83 ms → 0.93 ms   +12%   slower      << noise
    columns, scenarios, catchment-values-viewport,
    catchment-identify, catchments-bounds, tile-z5,
    tile-z8, choropleth-domain-aggregated              no change      correct
    choropleth-full-domain-values                         skipped     correct

The expensive scenarios — `choropleth-domain-aggregated` at 4.4 s,
`catchments-bounds` at 26 ms, `choropleth-viewport` at 22 ms — behaved. The cheap
ones did not, and the tool did not hedge about them.

## Trying to break it

Every case below produced a comprehensible message. **No panics, no crashes, and
no silently wrong report** in any of them.

| Case | Result |
|---|---|
| `--target http://127.0.0.1:8080///` | Correct. Trailing slashes trimmed, `/api/health` requested, no doubled path. |
| `--target 'http://[::1'` | `error: target "http://[::1" is not a URL: ... missing ']' in host`, exit 1, no file written. |
| `--target '127.0.0.1:8080'` (no scheme) | `error: ... first path segment in URL cannot contain colon`, exit 1. |
| `--target 'not a url at all'` | Runs, every scenario "no successful samples", saves a file, **exits 0**. Honest on screen, not in the file or the exit code — finding 9. |
| Target returning HTML instead of JSON | 5xx HTML rejected on status. **200 + `text/html` accepted as a healthy sample** — finding 4. |
| `--results` into a directory that does not exist | Created, including intermediate components. |
| `--results` into a read-only directory | `error: create results directory: ... permission denied`, exit 1 — but only after the whole suite ran, finding 9. |
| `list` on a missing directory | `unreadable: read results directory: ...` then `no results in ... yet`. Slightly redundant; comprehensible. |
| `list` with one corrupt file among good ones | Corrupt file reported, the rest still listed. |
| `list` with a short commit in a file | **Was a panic. Fixed** — finding 2. |
| `report` on a corrupt file | `error: parse .../corrupt.json: unexpected end of JSON input` — names the file. |
| `report` on a newer schema | Refused, with the schema numbers in the message. |
| `report` with two runs sharing no scenarios | Renders. Says "Of 0 scenarios measured", summary reads `0 faster, 0 slower, 0 unchanged`. |
| `report` on a run with zero scenarios | Renders without crashing. |
| `report --out` into a missing directory | `error: write report: ...`, exit 1. |
| `report --pdf` with no browser on PATH | `note: no PDF written (no chromium or chrome on PATH)`, HTML still written, exit 0. Correct — the HTML is the artefact. |
| `--heavy` against a remote target | Warns about ~45 MB and calls it a load test before starting. |
| Unknown subcommand | Usage printed, exit 2. |

---

## Integration pass — reconciling against ux, perf and design

All four branches are merged into `bench/integration`. Twenty tests failed there,
all but one of them mine, asserting behaviour my teammates deliberately changed.
None have been deleted and none weakened into vacuity: each was rewritten to
assert the substance it was guarding, against whatever mechanism now provides it.
`go build`, `go vet`, `gofmt` and `go test ./...` are clean across the repository,
including three consecutive runs and a `-race` run to check the statistical
fixtures are not flaky.

### Two bugs found during the pass, both fixed

**A nil-callback segfault in `runScenario`.** `internal/bench/run.go` dereferenced
`opts.Log` at three call sites without a nil check. `applyDefaults` installs a
no-op, so the CLI never hit it, but any caller building `Options` directly did —
and absence detection made one of those sites reachable for the first time:

    panic: runtime error: invalid memory address or nil pointer dereference
    bench.runScenario(...) internal/bench/run.go:474

The crash mattered beyond itself. A panic aborts the whole test binary, so the
six failures that came after it in the run were invisible. The coordinator's
count of fourteen was really twenty. Fixed with an `Options.logf` helper that
tolerates an unset callback.

**The CLI told users a flag was ignored when it was obeyed.** Ux, working around
perf's warmup bug, made `dtbench run --warmup 0` print:

    warning: --warmup 0 is not honoured by the measurement code; 3 warmup
             requests will still be made.

Perf then fixed the promotion, so by the time the branches met, the warning was
false. A tool that tells a user their flag was ignored when it was obeyed is
worse than one that says nothing. Removed, and pinned by
`TestAskingForNoWarmupIsHonouredAndNotContradicted`.

### The warm-up warning: perf's bug, not my test's

The coordinator asked me to decide, and it is perf's. The warning states a
specific fact — "at least one of these runs began measuring before its target had
finished starting up" — but it fires on `Run.Settled` being false, and false is
also the zero value. A schema-1 run, a run whose settle probe could not reach the
target, and a run measured with settling disabled are all indistinguishable from
a run that genuinely started early. Absence of evidence is being reported as
evidence.

It is not cosmetic: every historical run in anybody's results directory now
carries this warning *in addition to* the schema-version warning immediately
above it in `Compare`, which already explains that case correctly. Two warnings,
one invented, on every comparison against history — and a warning that appears on
everything is a warning nobody reads.

The fix is small and the data is already there: `SettleSeconds` is zero exactly
when no probe ran, so the condition wants to be "settling was attempted and did
not converge" rather than "Settled is not true". Left to perf, whose file it is,
and pinned both ways meanwhile by
`TestARunThatCarriesNoSettleEvidenceIsCurrentlyAccusedOfNotSettling` and
`TestARunThatGenuinelyDidNotSettleIsWarnedAbout`.

### Correction: the both-sides-failure gap is still open

The coordinator read the new caveat on
`TestBothRunsPartlyFailingIsCurrentlyReportedAsACleanTimingComparison` as perf
having fixed it. It has not. That caveat is the generic "raw samples were not
recorded" note, which my synthetic fixture triggered by carrying no samples — a
different sentence about a different thing. `compare.go` still reads:

    if cur.Errors > 0 && base.Errors == 0 {

so a scenario failing half its requests in *both* runs still gets an ordinary
speed comparison, and the requests that fail are often the slow ones. The test
now supplies raw samples so the significance test runs, which makes the point
sharper: the tool has a great deal to say about the timing and nothing at all to
say about the fact that half the traffic failed. Still open, still perf's or
whoever owns `delta()`.

### One failure was not mine

`TestSubMillisecondDifferencesAreNotVerdicts` in `report_test.go` fails without
any of my changes — I confirmed by stashing them. Its precondition asserts that
`Compare` still calls a 0.08 → 0.11 ms change "slower" so that the report layer
can decline to stand behind it. Perf's `PracticalFloorMs` now catches it at the
comparison layer, so the verdict arrives already softened. Both layers are worth
keeping, so the precondition now accepts either and the assertion that matters —
the report never presents thirty microseconds as a regression — is untouched.

### The vacuity audit

The coordinator was right that capturing only stdout broke these tests, and asked
whether anything else was passing vacuously for the same reason. I checked every
assertion in `cmd/dtbench` that reads captured output: all seven are positive
(`if !strings.Contains(...)`), so against an empty string they fail loudly rather
than passing quietly. There were no negative assertions — the form that would
have gone silent — anywhere in the suite. The helper is renamed `captureOutput`,
since `captureStdout` no longer describes what it does.

### Review of the three rewrites

All three were the right call.

- **The unreachable-target run must not be saved.** Ux is right and I was wrong.
  I had argued the failure should be "on the record"; a run measuring nothing that
  then appears in `list` and can be chosen as a baseline is worse than losing the
  invocation. I added one assertion: the refusal must name the target it could not
  reach, so the user is not left guessing between target, port and server.
- **The schema test against a live `httptest` server.** Necessarily so, since the
  old version depended on a run against a closed port being saved.
- **The URL-validation message.** Correct; I removed a dead variable.

### How each group was reconciled

*Perf changed the statistics.* The overlap and clean-separation tests now carry
real samples through `withSamples`/`samplesAround`, so they exercise the rank-sum
test rather than the summary-only fallback a synthetic `Stats` triggers. The
overlap guarantee got *stronger* and the test says so: an overlapping pair used to
earn a hedged "faster", and now earns no confident verdict at all. The
clean-separation test had to restate "not hedged" — a significant result now
carries a sentence quantifying the shift, its interval and the corrected p-value,
which is evidence rather than doubt, so the test forbids language of doubt
specifically and requires the evidence to be present.

*Wording moved, substance did not.* The payload, list and summary tests now
assert the facts a sentence has to carry — the magnitude, both figures, the
scenario name, the reason for a blank — rather than the phrasing. The caveat
test now takes whatever caveat `Compare` produced and asserts that text reaches
the rendered HTML, entity-decoded first, which is both wording-agnostic and a
stronger check than the phrase it replaced. It also confirmed the design's move
of caveats into an endnotes section keyed by scenario name: still present, still
attached to the right row.

*Ux changed how runs are chosen.* My fixtures gave every run the same
`StartedAt`, which was never realistic — runs are sequential — and ux's resolver
correctly rejects a pair with the same timestamp and target as one run compared
with itself. Fixtures now get distinct times. The "refuses without both sides"
test was the one real contradiction: ux decided no arguments means the two most
recent runs, which is the better design, so the guarantee is restated rather than
the decision overruled. What it asserts now is that every unsatisfiable
invocation ends in guidance, and that the convenience path says out loud which
two runs it picked.

*My own specification.* `contenttype_test.go` was written to fail, as the
acceptance criteria for absence detection. Perf implemented it and it passes, so
the file is now what it was always going to become — the regression guard. One
assertion changed shape: I had required `Errors == iterations`, and perf records
these as *absent* rather than failed. That distinction is perf's and it is right —
an endpoint that predates a feature has not failed, and marking it broken puts a
fault against a revision whose only crime is being old. The test now requires the
scenario to be accounted for and explained, which is the thing that actually
matters, and no longer dictates which of the two mechanisms does it.

### Smaller notes for whoever picks these up

- `chooseRuns` treats timestamp-plus-target as run identity. Filenames have
  one-second resolution, so two runs saved in the same second against the same
  target are already indistinguishable to it. Unlikely, not impossible.
- There is no flag to control settling, so every `dtbench run` pays the settle
  probe. It converges quickly against a fast target, but a target that will not
  answer the probe costs the full timeout with no way to opt out.
- The zero value of `Options` now performs no warmup. That is a deliberate
  consequence of making `--warmup 0` expressible, but it means the safe default
  lives only on the CLI flag, and a programmatic caller gets the unsafe one.
  `TestTheCommandLineDefaultsToDiscardingWarmupRequests` guards the flag.

## Verdict

**Yes, with two named exceptions and one standing caution.** This is a change of
position: at the end of the first pass I said not yet, for three reasons. Two of
them are now fixed, by other people, properly.

- **The SPA fallback is closed.** Perf's absence detection is a better answer
  than the one I specified. An endpoint that does not exist is recorded as
  *absent* with a reason, not as an error and certainly not as a fast success, so
  a comparison spanning the addition of an endpoint no longer contains a
  fabricated regression. The whole specification file passes.
- **The noise floor is fixed, and then some.** I asked for an absolute floor
  alongside the relative one. Perf added that and a Mann-Whitney rank-sum test
  with a Holm correction across the suite, which is more than I asked for and
  addresses something I had not raised: a report that names a "biggest win" is
  picking the most extreme of fifteen results, and that needs correcting for.
  The control run that embarrassed the tool in the first pass — same build, same
  server, three wins and two regressions — could not produce those verdicts now.
  Every one of them was sub-millisecond and none would clear the first gate.
- **The PDF path still reports success it has not earned.** `WritePDF` checks
  only that the file exists. It produced a branded, laid-out, entirely wordless
  six-page document in my first end-to-end run and said `wrote ...pdf`. Nobody
  has picked this up. It is the artefact that goes to a client and it is the one
  thing the tool cannot tell is broken.

The two open exceptions:

1. **Both-runs-partly-failing still gets a clean timing verdict** (above). An
   endpoint failing half its requests in both runs is reported as an ordinary
   speed comparison with nothing said about the failures.
2. **The warm-up warning fires on absence of evidence** (above), putting an
   invented warning on every comparison against a historical run.

Neither is severe on its own. Both are small fixes. Neither would produce a wrong
number — the first withholds a caveat, the second adds a false one — so they are
credibility problems rather than correctness problems, which in a tool whose only
product is credibility is not nothing.

The standing caution is unchanged and is now the largest thing I cannot vouch
for: **`sweep.go` is still untested.** It builds each revision in a git worktree,
starts a server and measures it — minutes per revision, a real checkout, a real
build, a real port — and there is no way to test it that respects "no network, no
wall clock, no live server". It is also the command that would produce a
multi-release trend chart, which is the most persuasive artefact this tool can
make. Nothing in 203 tests gives any confidence in it.

So: the numbers for the expensive scenarios can go in front of a client, with the
report's own caveats left in. The sub-millisecond scenarios should be read as a
smoke test that the endpoint still answers — not because the tool handles them
badly any more, but because it now correctly declines to say anything about them,
and a reader needs to understand that "no change" there means "not measurable
from here" rather than "identical".

---

Made with 💗 by [Kartoza](https://kartoza.com) ·
[Donate!](https://github.com/sponsors/kartoza) ·
[GitHub](https://github.com/kartoza/DecisionTheatre)
