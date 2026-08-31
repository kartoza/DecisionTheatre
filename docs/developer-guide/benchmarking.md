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
dt bench                    # measure, stress, record, and compare
dt bench-quick              # the same without the load phase
dt bench-list               # what has been measured so far
dt bench-report             # print the comparison for a run again
```

Or directly, which is what you want against anything not on this machine:

```bash
python3 scripts/dtbench.py run --target https://your-instance --label "before-cache"
```

!!! warning "The load phase saturates the server on purpose"
    `dt bench` finishes by pushing the server past what it can serve. That is
    the point of it, and on a server with load shedding configured it will
    cause real users to be refused while it runs. Use `dt bench-quick` against
    anything anyone is using.

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

## Options

```
run     --target --label --notes --samples --concurrency --duration --no-report
report  --run
list    --limit
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

One capability was lost with it: `bench-sweep`, which built each revision in a
range and measured it. Nothing here replaces that. Runs are labelled and stored,
so the shell equivalent is a loop over `git checkout`, build, and
`dtbench.py run --label "$rev"`.
