# dtbench — usability review and changes

Territory: `cmd/dtbench/main.go` and `internal/bench/report.go`. Nothing else was
edited. Where a fix needed a number or a field I do not own, it is listed under
[What I need from other people](#what-i-need-from-other-people) rather than
reached for.

---

## The worst thing I found

**A target that is not running produced a complete, saved, successful run.**

`dtbench run --target http://127.0.0.1:9999` connected to nothing, worked through
all fourteen scenarios, wrote a results file, printed `saved …`, and exited 0.
Nothing anywhere said "connection refused". The file then appears in `list`, is
selectable as a baseline, and produces a report full of "broken" verdicts whose
cause is invisible.

The same class of failure has a quieter entry point: `--target
http://127.0.0.1:8080` with one character missing — `http//127.0.0.1:8080` —
parses cleanly as a *relative URL*, is classified `remote`, and does exactly the
same thing.

### Before

```
$ dtbench run --target http://127.0.0.1:9999 --label deadport -n 2
Measuring http://127.0.0.1:9999
  [ 1/14] health
  [ 2/14] info
  ...
  [14/14] tilejson

deadport · 2026-08-19 05:17 against http://127.0.0.1:9999
  health                           no successful samples
  info                             no successful samples
  ... (12 more)
  choropleth-full-domain-values    skipped (heavy scenario; run with --heavy to include it)

note: The target did not report a version, so these results cannot be attributed to a build.

saved benchmarks/results/20260819-051752-deadport.json
$ echo $?
0
```

### After

```
$ dtbench run --target http://127.0.0.1:9999 --label deadport -n 2
error: nothing answered at http://127.0.0.1:9999, so there is nothing to measure. No results file was written.

  Get "http://127.0.0.1:9999/api/health": dial tcp 127.0.0.1:9999: connect: connection refused

Check that:
  - the server is running        (dt --headless --port 9999)
  - the port is the right one    (--target is http://127.0.0.1:9999)
  - the host is reachable        (curl -sS http://127.0.0.1:9999/api/health)
$ echo $?
1

$ dtbench run --target http//127.0.0.1:8080
error: --target "http//127.0.0.1:8080" is not a usable base URL: it needs a scheme and a host.
       Try: --target http://127.0.0.1:8080
$ echo $?
2
```

Three things changed: a reachability check before any measurement (`reachable`),
URL validation with a corrected suggestion (`checkTarget`), and a refusal to save
a run in which every attempted scenario failed. The last one is deliberate — that
file has no measurement in it, and its only future is to be picked as somebody's
baseline.

---

## Everything else I found, and what I did

### Errors that were raw Go errors

| Situation | Was | Now |
|---|---|---|
| `list` with no results directory | `unreadable: read results directory: open benchmarks/results: no such file or directory` **and** `no results in benchmarks/results yet` (contradictory, exit 0) | An empty state that explains the directory will be created, followed by the four commands that get you to a report |
| `report --baseline nope.json` | `read nope.json: open nope.json: no such file or directory` | Names what it tried, then lists every stored run with its label and describes the accepted forms |
| `sweep --from nosuchrev` | `list revisions nosuchrev..HEAD: exit status 128` (git's own stderr was swallowed) | Pre-validated with `git rev-parse`: `--from "nosuchrev" does not name a commit in .` plus the command that shows what does |
| `sweep --repo /not/a/repo` | same exit-128 message | `--repo /tmp is not a git checkout, so there are no revisions to sweep` |
| `sweep --data-dir /nope` | discovered on the first build, minutes in | Checked before anything is built |
| `report --out deep/dir/r.html` | `write report: open …: no such file or directory` | Parent directories are created |
| `run --iterations 5` | flag's error, then a full option dump, then nothing pointing at `-n` | One message: the error, `The option for that is -n.`, and where to find the rest |
| `dtbench compare` | usage dump, no suggestion | `"compare" is not a dtbench command. Did you mean `dtbench report`?` |
| `report --pdf` with no browser | `note: no PDF written (no chromium or chrome on PATH)` | Same, plus that the HTML is complete and printable, and how to fix it |

### Silent surprises

- **`-n 0` silently became 20.** `Options.applyDefaults` treats any value ≤ 0 as
  "use the default". Now rejected with `-n must be at least 1; got 0`. Same for
  `--every`, `--max`, `--heavy-n`, `--timeout`.
- **`--warmup 0` is impossible.** `applyDefaults` maps 0 → 3, so warmup can never
  be disabled. I cannot fix that in my territory; `run` now warns that the flag
  will not be honoured rather than quietly doing three requests you asked it not
  to do. See the asks below.
- **`--from HEAD~6` listed twenty revisions**, because `--merges` is on by default
  and merges drag whole branches in. The plan now explains that, and says
  explicitly when `--max` has trimmed the range (`the range holds 60 revisions,
  and the 20 most recent were kept`) so nobody measures a different range from
  the one they asked for.

### Cost, stated before it is paid

- **`sweep` started building immediately.** It printed the revision list, printed
  "Each one is a full build", and went. Now: the estimate is printed **above** the
  list (a wall of twenty commit subjects followed by "this takes an hour" is an
  hour disclosed after the reader stopped reading), and it asks for a yes.
  `--dry-run` and `--yes` both skip the prompt; `--yes` is required when stdin has
  no answer, because a prompt that reads EOF as consent is a decoration.
- **A sweep looked like a hang.** Every log line now carries elapsed time, and a
  projection appears after the first revision completes: `[  4m12s] about 56m left
  at this rate`. It is derived by recognising the `[i/n]` header the measurement
  code emits; if that format changes, the projection disappears and nothing else
  breaks.
- **`--heavy` warned only for remote targets and never waited.** It now states the
  arithmetic (`about 14 MB per request, 3 requests, roughly 42 MB`) for every
  target, and against a non-local target it requires a yes or `--yes`.

### Interruption

`signal.NotifyContext` cancels on the first signal and then keeps the handler
registered, so **the second Ctrl-C did nothing**. With a 120-second per-request
timeout that is a genuine dead end: no way out but another terminal.

- The first Ctrl-C now says what it is doing and that a second one will stop now.
- The second exits 130 immediately.
- An interrupted run still saves — that was already right and is worth keeping —
  but now exits **130** instead of 0, and says the result is partial. A partial
  measurement reported as success is a comparison somebody will make by accident.
- The partial run's own note ("Interrupted before the suite finished") now appears
  in the report, not just in the JSON.

### Command shape

Comparing two runs meant copying two 30-character filenames out of `list`.

```
dtbench report --pdf                              # the two most recent, and it says which
dtbench report --baseline before --current after  # by label
dtbench report --baseline last-3 --current last   # by position
dtbench report --baseline 7fb8f6b --current last  # by commit prefix or filename fragment
```

Ambiguous fragments list the candidates. `--baseline` resolving to the same run as
`--current` is refused. A `--current` older than the `--baseline` is allowed but
called out, because that is occasionally what you want and usually a slip.

`list` gained the LABEL column (the label is the human-meaningful part and was not
shown), a per-run count of scenarios that actually measured, and a footer naming
the two runs a bare `report` would pick. `list --json` prints the same data with
full paths for scripts.

### Terminal output and accessibility

- **No colour was added.** Meaning is carried by words: `error:`, `warning:`,
  `note:`, `not run`, `stopped working`. Output stays greppable, survives a pipe
  and a log file, and does not depend on distinguishing red from green.
- **stdout is data, stderr is everything else.** `run` prints the saved path to
  stdout and the progress and summary to stderr; `report` prints the written file
  paths to stdout. `dtbench run … | xargs dtbench report --current` works.
- **Exit statuses are documented** in `dtbench help`: 0 success, 1 failure, 2 a
  mistake in the command, 130 interrupted.
- `p50` and `p90` are gone from the terminal summary: `median 18 ms   9 in 10
  under 19 ms`.
- Durations use one formatter (`bench.FormatMs`), so the terminal no longer says
  `4308.99 ms` where the report says `4.31 s`. The duplicate `humanBytes` in
  `main.go` is deleted in favour of `bench.HumanBytes`.

---

## The report's words

### The lede

It was a paragraph that opened with a count of faster/slower/unchanged verdicts.
That presumes latency is the story. On the coordinator's real comparison — 14
August against today — it opened with `3 faster, 7 slower, 4 unchanged` and named
`tile-z5 (-27%)` as the biggest win, which is 0.03 ms. A reader came away thinking
the week had made things slower. The actual finding was in a column.

Reproduced with that data, the lede is now one sentence:

> One pass of the suite now moves 1.7 MB, down from 5.7 MB — 3.3× less. No time
> changed by more than this suite can separate from noise.

Twenty-four words. It picks its opening by what actually moved, in this priority:
both runs are the same build → something is broken → the sizes moved and the times
did not → the times moved → nothing moved. It is held to about thirty words and a
test fails if it goes over.

Everything that used to pad it out moved into two new structured fields the
designer can draw instead of set as prose: `Findings` (label / value / detail /
tone, sized for a card or a chart annotation) and `Method` (four short lines
replacing the two hard-coded paragraphs in the template).

### Honesty that had to survive the cut

**Two measurements of the same binary were reported as a week's progress.** Two
back-to-back runs against the same server produced "4 faster, 3 slower, 7
unchanged" and named a 28% win. Nothing said the builds were identical. This is
the comparison most likely to be run by mistake and the one whose output looks
most like a finding. It now takes the lede:

> Both runs measured build 0.4.0-211-g7fb8f6b, so every difference below is
> measurement noise rather than a change in the code.

**A 30-microsecond difference was a verdict.** `health` at 0.08 ms then 0.11 ms is
"38% slower" and is thirty microseconds. `report.go` now applies an absolute floor
of 1 ms to what it is willing to *say* — the change label reads `under 1 ms` and
the verdict reads `no change` — and recounts the headline so the cover cards and
the biggest-win/biggest-regression picks agree with the table. The comparison's
own verdict is untouched; this is a question of what may be said, not of what was
measured, and the override deletes itself the day an absolute floor lands in
`Compare`.

**Skipped scenarios were counted as "unchanged".** `Compare` files a skipped
scenario under `Unchanged`, so "12 unchanged" invited a reader to conclude twelve
things had been checked. They are now counted separately (`NotRun`,
`NotRunNames`), labelled `not run` in both the duration and verdict columns, and
excluded from the headline.

**The change column read as a loss.** `-28%` is read as a deficit by anyone not
told the convention, and this report is written for people who have not been told.
Direction is now spelled out: `28% faster`, `33% slower`, `53.0× faster`. The
existing multiple-versus-percentage threshold was already right and is kept.

**The verdict column repeated the change column.** It now answers only "does this
count?", which lets the pair carry more than either alone:

| Change | Verdict | Means |
|---|---|---|
| `6% slower` | `no change` | measured, and inside the noise |
| `under 1 ms` | `no change` | too small for this tool to resolve at all |
| `15% faster` | `faster` | a finding |
| `—` | `not run` | not evidence of anything |
| `first result` | `not in baseline` | the scenario is new |
| `—` | `not in this build` | the scenario is gone |

Every value fits on a bar or an axis without wrapping.

**Caveats were wallpaper.** The overlap caveat is a correct forty-word sentence
that appeared verbatim on six consecutive rows, where it is skipped exactly like
wallpaper. Rows now carry a short form — `spreads overlap`, `every request
failed`, `3 of 20 requests failed`, `size moved, time did not` — and the full
sentence is stated once above the table with the scenarios it affects named. The
long form is still available per row as `CaveatLong` for a tooltip or footnote.
The short forms are derived from the measurements, not by matching on the
comparison's wording, so rephrasing that sentence cannot silently empty them.

**`1.7 MB → 1.7 MB`.** The byte column showed a transition whenever the raw
integers differed, including when both rendered identically. Same bug in the
lede's totals sentence. Both now compare the rendered labels.

**Run notes never reached the reader.** "The target did not report a version",
"Interrupted before the suite finished" — written down at measurement time
precisely so a later reader would see them, and then left in the JSON. They now
appear as warnings in the report, attributed to baseline or current.

### Ordering

`Compare` sorts deltas alphabetically, which put Baseline before Choropleth before
Metadata for no reason a reader can see — and quietly contradicted `scenario.go`'s
own comment that "Order within a group is the order reported". The report now
restores the declared order: groundwork first, then what is built on it. Scenarios
no longer in the suite still appear, last, rather than being dropped.

---

## What I deliberately left alone

- **`NoiseFloor` at 10%, and the `overlapping` check.** Both are the performance
  specialist's, both are well reasoned, and the comment explaining why 10% is
  deliberately blunt is the best argument in the package. My 1 ms floor sits
  beside it rather than replacing it.
- **The `Verdict` enum and `Compare`'s verdicts.** The report softens what it will
  *say*; it does not rewrite what was measured. `d.Verdict` is unchanged and still
  says `slower` for the 30-microsecond case.
- **The `--merges` default.** It is the right default — one point per pull request
  is what people mean by "compare the versions" — and the surprise was that
  nothing explained the consequence. Explained rather than changed.
- **Colour.** Adding it would mean adding a TTY check, a `--no-color` flag and a
  `NO_COLOR` convention, for output that is already unambiguous in words. Not
  worth the surface.
- **`run` saving a partially-failed run.** Only the *all* failed case refuses. A
  run where three scenarios 404 is real evidence about those three scenarios.
- **A `--force`-style flag on `report`.** Overwriting an output file is not
  destructive in the way that matters; the input results are never touched.
- **Deleting or pruning results.** There is no `dtbench rm`, on purpose. Stored
  runs are the point of the tool and the brief says so; a delete command is a
  future support ticket about a comparison that is no longer possible.

---

## What I need from other people

### From the performance specialist

1. **`Options.applyDefaults` cannot express "no warmup".** `if o.Warmup < 0 { 0 }`
   then `if o.Warmup == 0 { 3 }` means 0 always becomes 3, so `--warmup 0` is a
   lie. Please make the sentinel `-1` for "not set", or take `*int`. Until then
   `run` prints a warning about its own flag, which is embarrassing for both of
   us.
2. **`ScenarioResult` needs the transport error, not only a count.** When every
   request fails I can report `Errors: 20` and the status counts, but not *why* —
   "connection refused" and "TLS handshake timeout" and "context deadline
   exceeded" are three different problems and three different next steps. A
   `LastError string` (or `ErrorSample string`) would let the message name the
   cause.
3. **An absolute floor in `Compare`.** I have `resolutionFloorMs = 1.0` in
   `report.go` as a framing override, with a comment saying it should be deleted
   when yours lands. When it does, `effectiveVerdict`, `belowResolution` and the
   headline recount in `report.go` all collapse. Please tell me the constant's
   name and I will delete mine in the same PR.
4. **The name for "absent on this build".** You are settling this for the
   content-type validation work. I currently render `Added` as
   `not in baseline` / `first result` and `Removed` as `not in this build`. If the
   new state is distinct from `Added`/`Removed`, send me the constant and I will
   give it its own two-to-four-word label. It needs to be short enough to sit on
   an axis.
5. **`Headline` has no field for scenarios that did not run.** I count them in
   `report.go` and pass `NotRun`/`NotRunNames` to the template. If you would
   rather own that count, add `Skipped int` to `Headline` and I will use it.
6. **A per-revision callback on `SweepOptions`.** I derive the sweep's ETA by
   regex-matching the `[i/n]` prefix of your `Log` lines, which is fragile by
   construction (it degrades to no ETA rather than breaking, but still). A
   `Progress func(done, total int, rev Revision)` alongside `Log` would make it
   honest.
7. **Minor:** `Revisions` applies `Max` internally, so to tell the user "the range
   holds 60, we kept 20" I call it twice — once with `Max` set to 1<<20. A
   returned total, or a `TotalInRange` field, would remove that.

### From the designer

The template is yours; these are fields I have populated that nothing renders yet.
Nothing regresses if you do not use them — the report is complete today — but the
prose cut assumed they would be drawn.

1. **`.Findings []reportFinding`** — `{Label, Value, Detail, Tone}`. `Value` is
   short enough for a chart label ("1.7 MB", "3.3× smaller", "53.0× faster");
   `Detail` for a caption ("was 5.7 MB", "choropleth-viewport · 179.0 KB → 36.0
   KB"); `Tone` is `good` / `bad` / `flat` / `warn`, matching the existing card
   classes. **The current headline cards are actively misleading on the real
   comparison**: they read `0 Faster · 0 Slower · 7 Unchanged` on the run where
   the payload dropped 5.7 MB → 1.7 MB. The size finding needs to be a card, and
   ideally the first one.
2. **`.Method []string`** — four short lines. Please replace the two hard-coded
   paragraphs under "How this was measured" with these; the numbers in them
   (`Iterations`, `Warmup`, the noise floor, the 1 ms floor) are computed and will
   stay correct as those change. `.Iterations`, `.Warmup` and `.NoiseFloorPercent`
   still exist so nothing breaks before you do.
3. **`.NotRun int` and `.NotRunNames string`** — a "Not run" card, styled like the
   existing `warn` cards. These are deliberately absent from `.Headline`, so
   without a card they are invisible on the cover.
4. **`.Deltas[].CaveatLong`** — the full explanation, for a tooltip or a footnote.
   `.Caveat` is now two to four words and is what should sit inline.
5. **`1 scenario(s) stopped working`** in the broken callout. There is a
   `countOf` helper in `report.go` if you would like the string computed instead;
   say the word and I will add it as a field.
6. **The `Change` and `Verdict` columns now say different things on purpose** (see
   the table above). Please keep both — collapsing them loses the distinction
   between "measured and inside the noise" and "too small to measure".

### From the QA engineer

- `internal/bench/report_test.go` and `cmd/dtbench/main_test.go` are new. The
  report tests are phrasing tests: each one encodes a sentence the report must not
  produce, taken from a comparison where it did. They are deliberately brittle
  about wording, which is the point — if someone rewords a label, the test should
  make them think about it rather than pass.
- Not covered, and worth your attention: the interrupt path (needs a subprocess
  and a signal), the confirmation prompts (need a controllable stdin), and
  `reachable` (needs a test server). All three are behaviours I changed and none
  is exercised.

---

## Still awkward, and outside what I could fix

- **The heavy scenario is invisible by default.** `choropleth-full-domain-values`
  — described in `scenario.go` as "the one most worth watching" — is skipped
  unless `--heavy` is passed, so the default report is silent about the API's most
  expensive request. That is the right default for production and the wrong one
  for a local before/after. A `--heavy` default that depends on `targetKind` would
  fix it, but the decision lives in `Options`.
- **Comparing a `--heavy` run with a non-`--heavy` run** produces `not run` and a
  correct caveat, but nothing warns at *selection* time. `Compare` builds the
  warnings and I did not want a second, divergent set in `main.go`. One more
  warning in `Compare` — "one run included heavy scenarios and the other did not"
  — would close it.
- **`Run.Filename()` collides** if two runs start in the same second with the same
  label. `Save` would overwrite silently. Unlikely, in `result.go`, not mine.
- **There is no way to resume a sweep.** Interrupting keeps what was measured, and
  the advice is to narrow `--from` by hand. A `--skip-measured` that consulted the
  results directory would be a real improvement and belongs in `sweep.go`.
