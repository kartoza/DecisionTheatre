# Benchmarking

`dtbench` measures the HTTP surface of a Decision Theatre server and compares one
measurement against another. It exists because performance claims in this project
used to be argued with numbers produced by hand — a `curl` here, a timing there,
against whatever happened to be running. That is fine for a single claim and
useless for a trend.

It answers three questions that hand measurement cannot:

- Is today's build faster than last week's, and by how much?
- Did the change that landed on Tuesday help, or did something else?
- Is production behaving the way the local build does?

It talks to a server only over HTTP and imports nothing from the application, so
it can point at a server it did not build — including production.

## Quick start

With a server running:

```bash
dtbench run --target http://127.0.0.1:8080 --label before
# ... make the change you want to measure, restart the server ...
dtbench run --target http://127.0.0.1:8080 --label after
dtbench report --pdf
```

The last line needs no arguments: with nothing else said, `report` compares the
two most recent stored runs and tells you which ones it chose.

Every run is saved as JSON under `./benchmarks/results`. Those files are the
point of the tool — a comparison against last month is only possible if last
month's file is still readable — so nothing deletes them but you.

## Exit status

| Code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Failure |
| `2` | Mistake in the command |
| `130` | Interrupted |

`stdout` carries data; everything said to a person goes to `stderr`. That means
`dtbench list --json | jq …` works without filtering out commentary.

---

## `dtbench run`

Measures one target and saves the result.

```bash
dtbench run --label before
dtbench run --target https://decision-theatre.example.org --label prod -n 50
dtbench run --heavy --heavy-n 3
```

| Option | Default | Purpose |
| --- | --- | --- |
| `--target` | `http://127.0.0.1:8080` | Base URL to measure |
| `--label` | — | What you will recognise this run by later |
| `-n` | `20` | Measured samples per scenario |
| `--warmup` | `3` | Discarded requests before measuring |
| `--heavy` | off | Include the expensive scenarios |
| `--heavy-n` | `3` | Samples for heavy scenarios |
| `--timeout` | `2m` | Per-request timeout |
| `--results` | `benchmarks/results` | Where to save |
| `--yes` | off | Answer the cost confirmation, for unattended use |

### Before it measures anything

`run` checks the target answers. This matters more than it sounds: a run against
a port with nothing listening used to complete, save a file, and report success —
and that file could then be chosen as a baseline, so a comparison could rest on a
run that never reached a server. It now refuses, and a run in which every scenario
failed is not saved at all.

A malformed URL is caught before measuring rather than after. `http//localhost`
— one missing colon — parses cleanly as a *relative* URL, so it is checked
explicitly and the corrected string is suggested.

### Heavy scenarios

Some scenarios are expensive enough that running them by default would be
antisocial. The full-domain statistics query returns about 14 MB per request.
They are excluded unless you pass `--heavy`.

!!! warning "`--heavy` against a shared server is a load test"
    Against production this transfers tens of megabytes per sample. `run` warns
    and asks before proceeding. Use `--yes` only when you mean it.

---

## `dtbench sweep`

Builds each revision in a range, measures it, and saves the results — so
"compare the versions" is a command rather than an afternoon.

```bash
dtbench sweep --from v0.4.0 --dry-run     # list what would be built, and stop
dtbench sweep --from v0.4.0 --data-dir ./data
```

| Option | Default | Purpose |
| --- | --- | --- |
| `--repo` | `.` | Checkout to take revisions from |
| `--from` | — | Revision to start after (exclusive) |
| `--to` | `HEAD` | Revision to end at (inclusive) |
| `--merges` | `true` | Only merge commits — one point per pull request |
| `--max` | `20` | Maximum revisions to build |
| `--every` | `1` | Build every Nth revision |
| `--data-dir` | `data` | Data directory each built server uses |
| `--port` | `8099` | Port each built server listens on, one at a time |
| `--dry-run` | off | List the revisions and stop |

Each revision is a full build in a throwaway worktree, so a sweep is slow. Start
with `--dry-run`, which prints the list and the estimated cost before anything is
built. Ctrl-C stops between revisions and keeps what is already done.

!!! note "Swept revisions have no frontend"
    Revisions are built with placeholder frontend assets, because building the
    real frontend for every revision would multiply an already slow operation.
    The API is measured faithfully; anything that needs the actual interface —
    including any browser-side measurement — is meaningless against a swept
    build, which serves a 16-byte index page.

---

## `dtbench report`

Renders a Kartoza-branded HTML report, and optionally a PDF, from two results.

```bash
dtbench report --pdf                              # the two most recent runs
dtbench report --baseline before --current after  # by label
dtbench report --baseline last-3 --current last   # by position
```

`--baseline` and `--current` each accept **a label, a filename, a path, or a
position** — `first`, `last`, `last-1`, `last-2` and so on, where `last` is the
newest. Given neither, the two most recent runs are compared and the report
records which ones they were.

| Option | Default | Purpose |
| --- | --- | --- |
| `--baseline` | `last-1` | Run to compare against |
| `--current` | `last` | Run to report on |
| `--out` | `benchmark-report.html` | HTML output path |
| `--pdf` | off | Also print to PDF with a headless browser |
| `--title`, `--subtitle` | derived | Override the cover text |
| `--mark` | the Kartoza symbol | Brand mark for the cover |
| `--repo` | `.` | Checkout to read merged pull requests from |
| `--no-changes` | off | Omit the attribution section |

### What landed between the builds

The report ends with the pull requests merged between the two builds and the
issues they reference, each linked, so a difference can be attributed to work
rather than guessed at.

This reads **git and nothing else** — no network, no token, no `gh` — so a report
rendered on a laptop with no credentials produces the same list as one rendered
in CI. Integration merges within a branch are excluded, because counting them
would list the same work twice and attribute a change to a merge that did not
introduce it. Each entry shows the merged work's own subject rather than
`Merge pull request #130 from …`, and issues attach to the pull request whose own
commits referenced them.

The range comes from the revision each run recorded: the commit a sweep built,
or the hash in the `git describe` version a server reports over `/api/info`.

!!! warning "It narrows the search for a cause; it does not establish one"
    Several pull requests in a range can move the same scenario, in opposite
    directions. The section says this on the page, because a list of changes next
    to a list of numbers invites being read as causation.

    A build reporting its version as `dev` cannot be attributed to a commit. The
    report then prints why rather than rendering an empty list, since an empty
    section reads as "nothing merged".

The PDF is printed with headless Chromium. If no browser is available the HTML is
still written and the command says so rather than failing — the HTML is the
artefact, the PDF is a convenience.

!!! note "The report embeds its own typefaces"
    Both faces are embedded as data URIs and the embedded alias leads the font
    stack. This is not decoration: on a host with no matching font installed,
    Chromium resolves the first family in a stack, finds nothing, and abandons
    the chain — producing a fully laid out PDF containing **no text at all**.

---

## `dtbench list`

Shows what has been stored.

```bash
dtbench list
dtbench list --json | jq -r '.[].path'
```

The names in the first column are what `--baseline` and `--current` accept,
alongside labels and positions.

---

## How to read a result

### It refuses to flatter

The most likely failure of a benchmark suite is not inaccuracy, it is
**flattery**: a number that looks like a win and is not. Those numbers get
quoted, so the tool is built to withhold them.

Running the suite twice against **an unchanged server** is the test that matters.
An earlier version of this tool reported *5 faster, 3 slower* from that — the
largest fake improvement being 41%, resting on 0.04 ms. It now reports nothing
changed, because a difference must pass three independent gates:

1. **An absolute floor.** A change smaller than 1 ms is not reported, whatever
   its percentage. Below about a millisecond, a relative threshold measures the
   scheduler.
2. **A relative floor.** At least 10%.
3. **A significance test.** A Mann-Whitney rank-sum test over the raw samples,
   Holm-corrected across the suite. With fewer than eight samples a side it
   refuses to answer rather than answering badly.

A consequence worth knowing: this is conservative, and a genuine improvement
below roughly 15–20% may be reported as unchanged. Raise `-n` when a claim
matters.

### States other than faster and slower

| State | Meaning |
| --- | --- |
| **faster** / **slower** | Passed all three gates |
| **unchanged** | Inside the noise |
| **absent** | The endpoint does not exist on that build |
| **broken** | It exists and stopped working |
| **not run** | Skipped, e.g. a heavy scenario without `--heavy` |

**Absent** deserves particular attention. An unrouted `/api/…` path returns
`200 OK` with `text/html`, because it falls through to the single-page
application. Measured naively, an endpoint that did not exist yet looks like a
fast success — so a newly added endpoint appears to have existed all along *and
to have been faster before it was written*. Scenarios declare the content type
and minimum size they expect, and a response failing those is recorded as absent,
never as fast.

### Payload changes are not timing changes

Compression trades CPU for bytes. Measured over loopback that is pure cost, so a
change that made the application dramatically faster for real users can present
as a large regression. The tool reports the trade explicitly and computes the
**crossover bandwidth** — bytes saved divided by time added — which contains no
assumption about anyone's connection. A change breaking even at 913 Mbps is a
win on any link slower than a gigabit.

Payload verdicts are kept separate from timing verdicts, and a payload trade can
never be reported as the headline regression.

### What it cannot tell you

- **Sub-millisecond scenarios cannot be compared locally.** They are liveness
  checks, not evidence.
- **Remote runs measure the network.** Production sits behind a round-trip floor
  of a couple of hundred milliseconds; "did our code get faster" is not
  answerable from them.
- **Lifetime-cached endpoints cannot be measured against a long-running server.**
  `/api/precalculate/full` takes about 26 seconds on the first call after a
  restart and under 2 ms thereafter. Against a server `dtbench` starts itself the
  warm-up captures this; against one that has been up for a while, nothing can,
  and the scenario says so rather than presenting the warm figure as the cost.
- **Concurrency and throughput are out of scope.** This measures latency — how
  long one user waits.

### Coverage

A scenario count measures effort; only the route table measures coverage. The
suite carries an inventory of every registered route and **derives** the figure
from the URLs the scenarios actually request, so it cannot drift into claiming
more than it does. Every run records it, and the report states it.

A route that cannot be measured meaningfully is recorded as unprobeable with a
written reason rather than quietly omitted.

---

## Settling

`/api/health` answers within a fraction of a second of startup, but the grid
geometry cache keeps building for around twelve seconds afterwards. The most
expensive query costs roughly 2.4× its steady-state figure during that window —
a bias that lands entirely on whichever revision a sweep happened to measure
first.

`dtbench` waits for the server to settle before measuring, and warns when it
cannot establish that a run was settled.

---

## Adding a scenario

Scenarios are declared in `internal/bench/scenario.go`, deliberately rather than
discovered. An automatically enumerated route list drifts into measuring whatever
is cheapest to call, and the interesting requests are the specific expensive
ones.

Each carries a `Why` explaining what it is evidence about, which is printed next
to the number — a reader who does not already know the codebase cannot otherwise
tell whether 400 ms is good.

!!! warning "Names are identifiers, not labels"
    A scenario's `Name` is the key used to line up one run against another.
    Renaming it silently orphans every stored result recorded under the old name.
    Adding a scenario is cheap and safe; renaming one is not.

## Where the results live

`benchmarks/results/*.json`, one file per run, schema-versioned so that a reader
tolerates files written by older versions. Each records what was measured, which
build answered, how many samples were taken, and from which machine — because a
number without its provenance is precisely the thing this tool replaces.
