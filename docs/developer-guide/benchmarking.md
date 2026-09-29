# Benchmarking

`scripts/dtbench.py` measures a running Decision Theatre server, stresses it,
and compares the result against every measurement taken before it.

It exists because performance claims in this project used to be argued with
numbers produced by hand — a `curl` here, a timing there, against whatever
happened to be running. That is fine for a single claim and useless for a
trend.

It is standard-library Python with no dependencies, and it talks to the server
only over HTTP. It imports nothing from the application, so it can point at a
server it did not build, including production.

## Quick start

From the development shell, with a server running (`dt run`):

```bash
dt benchmark                # measure, record, compare, and open the report
dt benchmark-quick          # the same without the load phase
dt benchmark-list           # what has been measured so far
dt benchmark-report         # rebuild and open the report for a run
dt benchmark-regressions    # where in the history something changed, and which commit
```

The same three ways as everything else in this project — `dt benchmark`,
`make benchmark`, and:

```bash
nix run .#benchmark -- --quick --target https://your-instance
```

All three run `scripts/benchmark.sh`, which runs `scripts/dtbench.py`. The
Python program has no dependencies and can always be called directly, which is
what you want on a server that has neither nix nor this repository:

```bash
scp scripts/dtbench.py scripts/dtbench_pdf.py server:
python3 dtbench.py run --target http://localhost:8080 --label "in-place"
```

`dt benchmark` writes a PDF to `benchmarks/reports/` and opens it. Pass
`--no-open` to skip that, which is what CI wants.

!!! warning "The load phase saturates the server on purpose"
    `dt benchmark` finishes by pushing the server past what it can serve. That
    is the point of it, and on a server with load shedding configured it will
    cause real users to be refused while it runs. Use `dt benchmark-quick`
    against anything anyone is using.

## Measuring production

```bash
dt benchmark --target https://africanlandscapefutures.wits.ac.za
```

The load phase is **skipped automatically** for a target that is not on this
machine, because the obvious thing to type is the production URL and the load
phase would take the site down for real users while it ran. `--stress-remote`
opts back in, with that understood.

The probe and latency phases still run. Those are a few hundred ordinary
requests — what a visitor does — but `--samples` is worth lowering against a
live site: the default of 20 means twenty fetches of a 14 MB response.

Two things to know before reading the numbers.

**Remote and local runs are never compared with each other.** Every run records
whether it was co-located with the server, and the history is filtered to match.
The difference between the two is mostly network, and reading that as a
performance change is how a benchmark starts producing confident nonsense.

**Rate limits apply to the benchmark too.** A production instance limits `/api`
to 10 requests a second (see
[Capacity and Overload](../administrator-guide/capacity-and-overload.md)). Past
the burst allowance the tool is measuring the rate limiter rather than the
server, and the run records `429`s as broken scenarios. That is the limiter
working, not the benchmark failing.

A real run against production, for scale — every figure includes about 800 ms
of round trip from a European connection:

| Endpoint | p50 | Size |
| --- | --- | --- |
| `health` | 797 ms | 16 B |
| `choropleth-domain-aggregated` | 11.8 s | 5.8 MB |
| `choropleth-full-domain-values` | 14.9 s | 14.4 MB |

## Which commit was this?

Every run records the commit the **server** was built from, as the server
itself reports it at `/api/info`. Not the commit this tool was run from.

That distinction is the whole reason the field can be trusted. Point the
benchmark at production and the local checkout has no relationship to what is
running at the other end, so recording `git rev-parse HEAD` would attach a
plausible sha to somebody else's numbers — and a wrong answer here is worse
than an empty one, because it survives into a bisect and sends someone to a
commit that never contained the change.

The build stamps it (`scripts/commit.sh`, `-X main.commit`, or `self.rev` under
nix) and the server reports it. A build made without the stamp reports
`unknown`, and the tool records that as-is rather than filling it in. A build
made from a dirty tree is recorded with a `-dirty` suffix, because a
measurement taken against uncommitted work cannot be reproduced from the sha
alone.

## What it measures

Three phases, in order.

**Probe** — one request to each of 22 endpoints, checking that it answers, with
the right content type, and with a plausible amount of data in it. A run where
things are broken says so at the top rather than burying it.

**Latency** — repeated sequential samples of each endpoint, reported as
medians. This is the "is this build slower than the last one" number.

**Load** — concurrent clients at rising levels, with a health probe running
alongside so the report can distinguish "the server is slow" from "the server
is gone".

### The size guard

Every scenario declares a minimum plausible response size. Without it, a `404`
body or an empty JSON array records as the fastest endpoint in the suite and
the report reads as a performance win. A broken server must never look like a
fast one — that is the failure this kind of tool is most prone to, because the
numbers all look excellent.

## Reading the report

Each endpoint is compared against the median of its history, not against one
nominated baseline. A single baseline invites picking a flattering one, and
cannot tell a real regression from an unlucky afternoon.

```
choropleth-domain-aggregated     p50   4709.0 ms   unchanged   [median of 5: 4680.1 ms]
```

Runs with fewer than three prior samples say `not enough to judge` rather than
inventing a comparison.

### The load table and the verdict

```
  Under load
      conc      rps     p95 ms  errors  health p95
         4      0.9     8367.8       0         5.6
        32      5.7    10220.2      48        43.7

  VERDICT: load did not make it worse — latency held at 1.2x from 4 to 32
           concurrent, refusing the excess.
           But the work itself is slow: 10.2 s at p95.
```

The verdict is the part worth understanding, because it has been wrong twice
and both mistakes looked entirely reasonable at the time.

The first version judged the server by its health check, and reported "stayed
responsive" for an instance whose real work had reached 18.5 seconds at p95.
Health answered in 2 ms throughout — health checks are cheap, and say nothing
about whether real work is getting done.

The second version judged by latency alone, and read any slow result with no
errors as unbounded queueing. That is right under overload and wrong below it:
with one client there is no queue to be in. It duly accused a server of
queueing at a concurrency of one.

So the question it actually asks is **does load make it slower**, which needs
at least two load levels to answer:

| What it sees                             | What it means                                          |
| ---------------------------------------- | ------------------------------------------------------ |
| Health failing                            | Down for everyone                                       |
| Health slow                               | Cheap requests queued behind expensive ones             |
| Latency tracks concurrency, no refusals   | Unbounded queueing — overload handed back as latency    |
| Latency flat, some refusals               | The limits are working                                  |
| Latency flat but high                     | The endpoint is expensive — look at the handler         |
| Fast and flat                             | Not saturated; the test did not push hard enough        |

Errors are not automatically a failure and their absence is not automatically a
pass. A server past its capacity has two honest options — refuse quickly or
serve slowly — and refusing is the better one, because the client learns
immediately and can back off. See
[Capacity and Overload](../administrator-guide/capacity-and-overload.md).

## Finding where something changed

```bash
dt benchmark-regressions
```

This is the bisect. It walks the recorded history for each endpoint, looks for
a point where the measurement moved to a new level **and stayed there**, and
names the commit the new level first appeared in:

```
  choropleth-domain-aggregated
    SLOWER    1240.5 ->   4680.1 ms (+277%)
    first seen in run 14, 2026-08-22T09:14:02, nightly
    commit 7fb8f6b3a1
    git show 7fb8f6b3a1
```

It searches runs already recorded rather than rebuilding each revision. A
`git bisect` over this would mean a full build and a server start per
candidate, several minutes each, to arrive at an answer already sitting in the
database — every row names its commit.

Two things it deliberately will not do.

**Report a spike as a step.** The halves either side of a candidate split are
compared by median, so one pathological run — a laptop that began a backup
mid-benchmark — cannot invent a change. A step also needs at least four runs,
two on each side: with one measurement either side, any difference between them
is as likely to be jitter as news.

**Blame a commit for the machine.** When several unrelated endpoints move by a
similar proportion at the same run, that is reported separately and without a
commit, as a systemic change. The first report drawn from real history
announced step changes on `/api/health`, `/api/info`, the index page and a tile
read, all at once, all 4 ms down to 1 ms — four "regressions" whose actual
cause was that the host had been busy earlier. Pinning that on a commit is how
an innocent change gets reverted.

## The database

Runs go to `benchmarks/dtbench.sqlite`: `runs`, `measurements`, `load_results`.
It is git-ignored on purpose. A measurement is only comparable against others
from the same hardware, and a shared database would invite comparing a laptop
against the server and reading the difference as a regression.

It is plain SQLite, so anything else can read it:

```bash
sqlite3 benchmarks/dtbench.sqlite \
  "SELECT r.label, m.p50 FROM measurements m JOIN runs r ON r.id = m.run_id
   WHERE m.scenario = 'choropleth-domain-aggregated' ORDER BY r.id"
```

### Co-located runs

Each run records whether the tool ran on the same machine as the server, and it
refuses to compare a co-located run against a remote one. The difference
between them is mostly network, and reading that as a performance change is
how a benchmark starts producing confident nonsense.

## The report

`--pdf` writes one; `--open` opens it. Four pages:

1. What was measured — target, server version, commit — and the verdict
2. Every endpoint against the median of its history
3. Trend charts, one per interesting endpoint, labelled by commit
4. Step changes, with the commit each first appeared in

It is drawn by `scripts/dtbench_pdf.py`, a few hundred lines of standard
library that writes the PDF format directly. That is not enthusiasm for
implementing file formats: the benchmark's most useful property is that it can
be copied onto a server and run there, and that stops being true the moment it
needs something installed. It uses the base-14 fonts, which every reader has
and none of which need embedding.

The report is a rendering of the same analysis the terminal prints, using the
same words for the verdict. Anything the PDF said that the terminal did not
would be a place for the two to drift apart, and the one nobody reads would be
the one that goes wrong.

## Options

```
run          --target --label --notes --samples --concurrency --duration
             --no-report --pdf [PATH] --open
report       --run --pdf [PATH] --open
regressions  --remote --slower-only
list         --limit
```

`--concurrency` takes several levels: `--concurrency 8 32 64`. At least two are
needed for the verdict to distinguish queueing from slowness.

## Testing the tool

```bash
python3 scripts/test_dtbench.py
```

The measuring fails loudly when it breaks. The verdict is the part that has
been wrong while looking plausible, so it is the part with tests — including
one for each of the two mistakes above, so neither comes back.

## History

This replaces a Go implementation (`internal/bench`, `cmd/dtbench`, about
12,000 lines) that produced branded HTML and PDF reports. The scenario list and
the size guard were carried over — that was the part with the thinking in it.

What went is the report generation. What arrived is the load phase: the Go
suite deliberately put concurrency out of scope on the grounds that saturation
is a different question needing a different tool, which was a fair call, and
this is that tool.

`bench-sweep`, which built each revision in a range and measured it, went with
it. `dt benchmark-regressions` answers the question it was usually asked —
where did this get slower — from measurements already recorded, without
rebuilding anything. Where a genuine sweep is wanted, runs are labelled and
stored, so the shell equivalent is a loop over `git checkout`, build, and
`dtbench.py run --label "$rev"`.
