#!/usr/bin/env python3
"""Measure and stress a running Decision Theatre instance.

Point it at a server, and it does three things in order:

  probe    one request per scenario, to find out which of them actually work
  latency  repeated sequential requests, to measure what one user waits
  load     concurrent requests, to find where the server stops coping

Every run is written to a SQLite database, and the report compares the run just
taken against the whole history rather than against one nominated baseline.

    ./scripts/dtbench.py run    --target http://127.0.0.1:8080
    ./scripts/dtbench.py report
    ./scripts/dtbench.py list

Standard library only. The flake pins this project's dependencies and a
benchmark is not worth moving them for.

WHAT THIS TOOL REFUSES TO DO
----------------------------
Report a broken thing as a fast thing. An endpoint that 404s, or returns the
SPA's HTML because the route does not exist, answers in about a millisecond;
measured naively it is the fastest thing in the suite. Every scenario declares a
minimum plausible size and an expected content type, and anything failing those
is recorded as broken and excluded from comparison.

Report noise as a change. Timing has jitter, and a percentage change computed on
a sub-millisecond endpoint will happily read 27%. A difference is only reported
when it is larger than the historical spread of that scenario.

Compare unlike things. A run taken from the same machine as the server measures
the contention between the load generator and the server; a run taken from
elsewhere measures the server. Both are useful, neither is the other, and the
report keeps them apart.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import socket
import sqlite3
import ssl
import statistics
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

# --------------------------------------------------------------------------
# Scenarios
#
# Ported from the Go suite, which earned these through use: each one is here
# because a regression in it would cost a user something, and each carries the
# reason so a future reader does not have to guess.
#
# min_bytes is the anti-flattery guard. A 200 that is too small is a broken
# scenario, not a quick one.
# --------------------------------------------------------------------------

# Query-string bboxes are lower-case; the POST bodies below use camelCase. Two
# conventions in one API, so these are written out rather than shared.
FULL_DOMAIN = {"minx": "-17.5", "miny": "-34.8", "maxx": "51.4", "maxy": "15.1"}
CLOSE_IN = {"minx": "25", "miny": "-26", "maxx": "26", "maxy": "-25"}

JSON_CT = "application/json"


@dataclass
class Scenario:
    name: str
    path: str
    group: str
    why: str
    min_bytes: int = 1
    method: str = "GET"
    query: dict | None = None
    body: str | None = None
    content_type: str | None = JSON_CT
    # Heavy scenarios are the ones that cost the server real work. They are what
    # the load phase uses, because those are what a crawler would find.
    heavy: bool = False


SCENARIOS: list[Scenario] = [
    Scenario("health", "/api/health", "Baseline", min_bytes=8,
             why="Round trip with no work behind it. Everything else is this plus the work."),
    Scenario("info", "/api/info", "Baseline", min_bytes=50,
             why="Also reports the build that answered, which is what lets a result be attributed."),

    Scenario("metadata-colors", "/api/metadata/colors", "Metadata", min_bytes=100,
             why="Served from an in-memory cache. A regression means the cache stopped working."),
    Scenario("columns", "/api/columns", "Metadata", min_bytes=200,
             why="The attribute list the whole interface is built from, fetched on first paint."),
    Scenario("scenarios", "/api/scenarios", "Metadata", min_bytes=8,
             why="Small, and on the critical path for the scenario switcher."),
    Scenario("metadata-targetranges", "/api/metadata/targetranges", "Metadata", min_bytes=100,
             why="Target_min and Target_max. Now decides the scale a dial draws against."),

    Scenario("choropleth-viewport", "/api/choropleth", "Choropleth", min_bytes=1000,
             query={**CLOSE_IN, "scenario": "current", "attribute": "NPP_gm2", "zoom": "9"},
             why="The request a pan or zoom produces. This is what 'the map feels slow' means."),
    Scenario("choropleth-domain-aggregated", "/api/choropleth", "Choropleth", min_bytes=10000,
             query={**FULL_DOMAIN, "scenario": "current", "attribute": "NPP_gm2", "zoom": "4"},
             why="Continental view, served from the zoom-tier grid aggregation."),
    Scenario("catchment-values-viewport", "/api/catchment-values", "Choropleth", min_bytes=100,
             query={**CLOSE_IN, "scenario": "current", "attribute": "NPP_gm2"},
             why="Values for the vector-tile join: geometry from tiles, only numbers over HTTP."),

    Scenario("choropleth-full-domain-values", "/api/choropleth", "Statistics",
             min_bytes=10000, heavy=True,
             query={**FULL_DOMAIN, "scenario": "current", "attribute": "NPP_gm2",
                    "zoom": "0", "valuesOnly": "1"},
             why="Every catchment, no aggregation. The most expensive request the API serves."),
    Scenario("precalculate-full", "/api/precalculate/full", "Statistics",
             min_bytes=1000, heavy=True,
             why="Full-domain averages for every column. Cached, but the first caller pays for it."),
    Scenario("catchments-bounds", "/api/catchments/bounds", "Statistics", min_bytes=40,
             why="The extent of the dataset, asked for once before the map can frame itself."),
    Scenario("catchment-identify", "/api/catchment/1121879850", "Statistics", min_bytes=100,
             why="One catchment's full record, which is what a click on the map produces."),
    Scenario("catchment-geometry", "/api/catchments/geometry/1121879850", "Statistics",
             min_bytes=100,
             why="One catchment's geometry, fetched when selecting while building a site."),
    Scenario("catchments-in-bbox-geometry", "/api/catchments/in-bbox", "Statistics",
             method="POST", min_bytes=1000, heavy=True,
             body='{"minX":25,"minY":-26,"maxX":26,"maxY":-25}',
             why="Catchments in the viewport with geometry, drawn while you drag a box."),
    Scenario("catchments-in-bbox-ids", "/api/catchments/in-bbox", "Statistics",
             method="POST", min_bytes=100,
             body='{"minX":25,"minY":-26,"maxX":26,"maxY":-25,"includeGeometry":false}',
             why="The same query asking only for ids. The gap between the two is geometry's cost."),

    Scenario("tile-z8", "/tiles/africa/8/145/151.pbf", "Tiles", min_bytes=1000,
             content_type="application/x-protobuf",
             why="A vector tile at the zoom where catchment geometry starts being tiled."),
    Scenario("tile-z5", "/tiles/africa/5/18/18.pbf", "Tiles", min_bytes=500,
             content_type="application/x-protobuf",
             why="A low-zoom basemap tile, served from the pre-warmed cache."),
    Scenario("tilejson", "/data/tiles.json", "Tiles", min_bytes=100,
             why="Declares which layers are tiled and at what zooms."),
    Scenario("tilesets", "/api/tilesets", "Tiles", min_bytes=5,
             why="The list of tilesets, asked for before the map can decide what to render."),
    Scenario("style-json", "/data/style.json", "Tiles", min_bytes=200,
             why="The MapLibre style document. Nothing renders until this returns."),

    Scenario("index", "/", "Static", min_bytes=200, content_type="text/html",
             why="The page itself. If this is slow nothing else matters."),
]


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

@dataclass
class Sample:
    ms: float
    status: int
    nbytes: int
    ok: bool
    error: str = ""


def request(target: str, sc: Scenario, timeout: float = 30.0) -> Sample:
    """One request, timed from before connect to after the body is read.

    The body is read fully and its size checked. Timing only the headers would
    make a streamed 100 MB response look like a fast one, which is the opposite
    of what is being measured.
    """
    url = target.rstrip("/") + sc.path
    if sc.query:
        url += "?" + urllib.parse.urlencode(sc.query)

    data = sc.body.encode() if sc.body else None
    req = urllib.request.Request(url, data=data, method=sc.method)
    req.add_header("User-Agent", "dtbench")
    if data:
        req.add_header("Content-Type", JSON_CT)

    ctx = ssl.create_default_context()
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            payload = resp.read()
            elapsed = (time.perf_counter() - started) * 1000.0
            ctype = (resp.headers.get("Content-Type") or "").split(";")[0].strip()
            return _validate(sc, elapsed, resp.status, payload, ctype)
    except urllib.error.HTTPError as e:
        elapsed = (time.perf_counter() - started) * 1000.0
        body = b""
        try:
            body = e.read()
        except Exception:
            pass
        return Sample(elapsed, e.code, len(body), False, f"HTTP {e.code}")
    except Exception as e:  # timeouts, resets, refusals
        elapsed = (time.perf_counter() - started) * 1000.0
        return Sample(elapsed, 0, 0, False, type(e).__name__)


def _validate(sc: Scenario, ms: float, status: int, payload: bytes, ctype: str) -> Sample:
    """A 200 is not the same as a working endpoint.

    Unrouted /api paths fall through to the single-page app, which answers 200
    with HTML in about a millisecond. Without these checks that reads as the
    fastest endpoint in the suite.
    """
    n = len(payload)
    if status != 200:
        return Sample(ms, status, n, False, f"HTTP {status}")
    if sc.content_type and ctype and ctype != sc.content_type:
        return Sample(ms, status, n, False, f"content-type {ctype}, want {sc.content_type}")
    if n < sc.min_bytes:
        return Sample(ms, status, n, False, f"{n} bytes, want >= {sc.min_bytes}")
    return Sample(ms, status, n, True)


# --------------------------------------------------------------------------
# Statistics
# --------------------------------------------------------------------------

def pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    if len(s) == 1:
        return s[0]
    k = (len(s) - 1) * (p / 100.0)
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


@dataclass
class Measured:
    name: str
    group: str
    ok: bool
    error: str = ""
    samples: int = 0
    p50: float = 0.0
    p95: float = 0.0
    p99: float = 0.0
    best: float = 0.0
    worst: float = 0.0
    stdev: float = 0.0
    nbytes: int = 0


def summarise(sc: Scenario, samples: list[Sample]) -> Measured:
    good = [s for s in samples if s.ok]
    if not good:
        why = samples[0].error if samples else "no samples"
        return Measured(sc.name, sc.group, False, why, len(samples))
    ms = [s.ms for s in good]
    return Measured(
        sc.name, sc.group, True, "" if len(good) == len(samples) else
        f"{len(samples) - len(good)} of {len(samples)} failed",
        len(good),
        pct(ms, 50), pct(ms, 95), pct(ms, 99),
        min(ms), max(ms),
        statistics.stdev(ms) if len(ms) > 1 else 0.0,
        good[0].nbytes,
    )


# --------------------------------------------------------------------------
# Load
# --------------------------------------------------------------------------

@dataclass
class LoadResult:
    concurrency: int
    seconds: float
    requests: int
    errors: int
    rps: float
    p50: float
    p95: float
    p99: float
    # The number that actually answers "is it still up": how long a trivial
    # health check waited while the heavy work was in flight.
    health_p50: float = 0.0
    health_p95: float = 0.0
    health_worst: float = 0.0
    health_errors: int = 0


def apply_load(target: str, scenarios: list[Scenario], concurrency: int,
               seconds: float) -> LoadResult:
    """Hammer the heavy scenarios while asking whether the server is still alive.

    A throughput figure on its own does not say whether the site stayed up. What
    says that is whether /api/health still answered promptly while the expensive
    work was saturating the machine, so a health prober runs alongside the load
    and is reported separately.
    """
    stop = threading.Event()
    lat: list[float] = []
    errors = [0]
    lock = threading.Lock()

    def worker() -> None:
        i = 0
        while not stop.is_set():
            sc = scenarios[i % len(scenarios)]
            i += 1
            s = request(target, sc, timeout=60)
            with lock:
                lat.append(s.ms)
                if not s.ok:
                    errors[0] += 1

    health_lat: list[float] = []
    health_err = [0]
    health_sc = next(s for s in SCENARIOS if s.name == "health")

    def prober() -> None:
        while not stop.is_set():
            s = request(target, health_sc, timeout=10)
            with lock:
                health_lat.append(s.ms)
                if not s.ok:
                    health_err[0] += 1
            time.sleep(0.25)

    started = time.perf_counter()
    with ThreadPoolExecutor(max_workers=concurrency + 1) as pool:
        pool.submit(prober)
        for _ in range(concurrency):
            pool.submit(worker)
        time.sleep(seconds)
        stop.set()
    elapsed = time.perf_counter() - started

    return LoadResult(
        concurrency, elapsed, len(lat), errors[0],
        len(lat) / elapsed if elapsed else 0.0,
        pct(lat, 50), pct(lat, 95), pct(lat, 99),
        pct(health_lat, 50), pct(health_lat, 95),
        max(health_lat) if health_lat else 0.0,
        health_err[0],
    )


# --------------------------------------------------------------------------
# Storage
# --------------------------------------------------------------------------

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY,
  started_at    TEXT NOT NULL,
  target        TEXT NOT NULL,
  label         TEXT,
  server_version TEXT,
  -- Whether the load came from the same machine as the server. A co-located run
  -- measures the contention between generator and server, not the server, so it
  -- is never compared against a remote one.
  colocated     INTEGER NOT NULL,
  host          TEXT,
  cpus          INTEGER,
  samples       INTEGER NOT NULL,
  notes         TEXT
);
CREATE TABLE IF NOT EXISTS measurements (
  run_id   INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  grp      TEXT NOT NULL,
  ok       INTEGER NOT NULL,
  error    TEXT,
  samples  INTEGER NOT NULL,
  p50      REAL, p95 REAL, p99 REAL,
  best     REAL, worst REAL, stdev REAL,
  bytes    INTEGER
);
CREATE TABLE IF NOT EXISTS load_results (
  run_id      INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  concurrency INTEGER NOT NULL,
  seconds     REAL, requests INTEGER, errors INTEGER, rps REAL,
  p50 REAL, p95 REAL, p99 REAL,
  health_p50 REAL, health_p95 REAL, health_worst REAL, health_errors INTEGER
);
CREATE INDEX IF NOT EXISTS measurements_name ON measurements(name);
"""


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def is_colocated(target: str) -> bool:
    host = urllib.parse.urlparse(target).hostname or ""
    if host in ("127.0.0.1", "localhost", "::1", "0.0.0.0"):
        return True
    try:
        return socket.gethostbyname(host) == socket.gethostbyname(socket.gethostname())
    except Exception:
        return False


def server_version(target: str) -> str:
    s = request(target, next(x for x in SCENARIOS if x.name == "info"))
    if not s.ok:
        return "unknown"
    try:
        url = target.rstrip("/") + "/api/info"
        with urllib.request.urlopen(url, timeout=10) as r:
            return str(json.loads(r.read()).get("version", "unknown"))
    except Exception:
        return "unknown"


# --------------------------------------------------------------------------
# Commands
# --------------------------------------------------------------------------

def cmd_run(args: argparse.Namespace) -> int:
    target = args.target.rstrip("/")
    conn = connect(Path(args.db))

    print(f"target      {target}")
    colocated = is_colocated(target)
    print(f"colocated   {colocated}"
          + ("   (measures generator-vs-server contention, not capacity)" if colocated else ""))
    version = server_version(target)
    print(f"server      {version}")
    print()

    # 1. Probe. One request each, so a broken scenario is named before anything
    #    is measured over it.
    print("probe")
    working: list[Scenario] = []
    for sc in SCENARIOS:
        s = request(target, sc)
        if s.ok:
            working.append(sc)
            print(f"  ok      {sc.name:32} {s.ms:8.1f} ms  {s.nbytes:>9,} B")
        else:
            print(f"  BROKEN  {sc.name:32} {s.error}")
    print()

    if not working:
        print("nothing responded; is the server running?")
        return 1

    # 2. Latency, sequential.
    print(f"latency   {args.samples} samples each")
    measured: list[Measured] = []
    for sc in working:
        samples = [request(target, sc) for _ in range(args.samples)]
        m = summarise(sc, samples)
        measured.append(m)
        print(f"  {m.name:32} p50 {m.p50:8.1f}  p95 {m.p95:8.1f}  p99 {m.p99:8.1f} ms")
    print()

    # 3. Load, ramping. Heavy scenarios only: those are what a crawler finds and
    #    what actually threatens the box.
    heavy = [sc for sc in working if sc.heavy] or working[:3]
    print(f"load      {', '.join(s.name for s in heavy)}")
    print(f"{'conc':>6} {'rps':>8} {'p95 ms':>10} {'errors':>7} "
          f"{'health p95':>11} {'health max':>11}")
    loads: list[LoadResult] = []
    for c in args.concurrency:
        lr = apply_load(target, heavy, c, args.duration)
        loads.append(lr)
        flag = ""
        if lr.health_errors:
            flag = "  HEALTH FAILING"
        elif lr.health_p95 > 1000:
            flag = "  health degraded"
        print(f"{c:>6} {lr.rps:>8.1f} {lr.p95:>10.1f} {lr.errors:>7} "
              f"{lr.health_p95:>11.1f} {lr.health_worst:>11.1f}{flag}")
    print()

    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cur = conn.execute(
        "INSERT INTO runs (started_at, target, label, server_version, colocated,"
        " host, cpus, samples, notes) VALUES (?,?,?,?,?,?,?,?,?)",
        (started, target, args.label, version, int(colocated), platform.node(),
         os.cpu_count() or 0, args.samples, args.notes))
    run_id = cur.lastrowid
    conn.executemany(
        "INSERT INTO measurements (run_id,name,grp,ok,error,samples,p50,p95,p99,"
        "best,worst,stdev,bytes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(run_id, m.name, m.group, int(m.ok), m.error, m.samples, m.p50, m.p95,
          m.p99, m.best, m.worst, m.stdev, m.nbytes) for m in measured])
    conn.executemany(
        "INSERT INTO load_results (run_id,concurrency,seconds,requests,errors,rps,"
        "p50,p95,p99,health_p50,health_p95,health_worst,health_errors)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [(run_id, l.concurrency, l.seconds, l.requests, l.errors, l.rps, l.p50,
          l.p95, l.p99, l.health_p50, l.health_p95, l.health_worst,
          l.health_errors) for l in loads])
    conn.commit()
    print(f"recorded as run {run_id} in {args.db}")

    if not args.no_report:
        print()
        report(conn, run_id)
    return 0


def report(conn: sqlite3.Connection, run_id: int | None = None) -> int:
    """Compare a run against everything that came before it.

    Not against one nominated baseline: a single previous run can be an outlier,
    and a comparison against it reports that outlier's noise as this run's news.
    The history's own spread is what decides whether a difference is a difference.
    """
    if run_id is None:
        row = conn.execute("SELECT id FROM runs ORDER BY id DESC LIMIT 1").fetchone()
        if not row:
            print("no runs recorded yet")
            return 1
        run_id = row["id"]

    run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if not run:
        print(f"no run {run_id}")
        return 1

    print(f"run {run_id}   {run['started_at']}   {run['target']}"
          + (f"   [{run['label']}]" if run["label"] else ""))
    print(f"server {run['server_version']}   {run['host']}   {run['cpus']} cpus   "
          f"{'co-located' if run['colocated'] else 'remote'}")
    print()

    # Only comparable history: same target kind. A co-located run and a remote
    # one are not measuring the same thing.
    hist = conn.execute(
        "SELECT m.name, m.p50 FROM measurements m JOIN runs r ON r.id = m.run_id"
        " WHERE r.id != ? AND r.colocated = ? AND m.ok = 1",
        (run_id, run["colocated"])).fetchall()
    by_name: dict[str, list[float]] = {}
    for h in hist:
        by_name.setdefault(h["name"], []).append(h["p50"])

    rows = conn.execute(
        "SELECT * FROM measurements WHERE run_id = ? ORDER BY grp, name",
        (run_id,)).fetchall()

    n_hist = len({h["name"] for h in hist})
    if not n_hist:
        print("no comparable history yet — this run becomes the first point")
    else:
        runs_back = conn.execute(
            "SELECT COUNT(*) c FROM runs WHERE id != ? AND colocated = ?",
            (run_id, run["colocated"])).fetchone()["c"]
        print(f"compared against {runs_back} earlier run(s)")
    print()

    group = None
    for r in rows:
        if r["grp"] != group:
            group = r["grp"]
            print(f"  {group}")
        if not r["ok"]:
            print(f"    BROKEN  {r['name']:32} {r['error']}")
            continue

        past = by_name.get(r["name"], [])
        verdict = ""
        if len(past) >= 2:
            med = statistics.median(past)
            spread = statistics.stdev(past)
            # The threshold is the history's own spread, with a floor: on a
            # sub-millisecond endpoint the stdev can be smaller than the clock's
            # resolution, and everything would look like news.
            noise = max(spread * 2, med * 0.10, 0.5)
            delta = r["p50"] - med
            if abs(delta) <= noise:
                verdict = "unchanged"
            elif delta < 0:
                verdict = f"FASTER by {-delta:.1f} ms ({-delta / med * 100:.0f}%)"
            else:
                verdict = f"SLOWER by {delta:.1f} ms ({delta / med * 100:.0f}%)"
            verdict += f"   [median of {len(past)}: {med:.1f} ms]"
        elif past:
            verdict = f"only {len(past)} earlier sample, not enough to judge"
        else:
            verdict = "first run"

        print(f"    {r['name']:32} p50 {r['p50']:8.1f} ms   {verdict}")
    print()

    loads = conn.execute(
        "SELECT * FROM load_results WHERE run_id = ? ORDER BY concurrency",
        (run_id,)).fetchall()
    if loads:
        print("  Under load")
        print(f"    {'conc':>6} {'rps':>8} {'p95 ms':>10} {'errors':>7} {'health p95':>11}")
        for l in loads:
            note = ""
            if l["health_errors"]:
                note = "   health check FAILED — the site was down for other users"
            elif l["health_p95"] > 1000:
                note = "   health check degraded past a second"
            print(f"    {l['concurrency']:>6} {l['rps']:>8.1f} {l['p95']:>10.1f} "
                  f"{l['errors']:>7} {l['health_p95']:>11.1f}{note}")
        print()
        _verdict(loads)


# How long a user will wait for real work before the site is useless to them,
# whatever the health check says.
USABLE_P95_MS = 3000.0


def _verdict(loads: list[sqlite3.Row]) -> None:
    """Judge the server, not just its health check.

    This has been wrong twice, in opposite directions, and both mistakes are
    worth keeping written down because both are easy to make again.

    The first version looked only at the health probe and reported "stayed
    responsive" for a server whose real work had reached 18.5 s at p95. Health
    was fine because health is free. It says nothing about whether real work is
    getting done, and a server can answer it in 2 ms while being unusable.

    The second version fixed that and then read every slow-with-no-errors
    result as unbounded queueing. That is right under overload and nonsense
    below it: with one client there is no queue to be in, so a slow response
    just means the endpoint is slow. It duly accused a server of queueing at a
    concurrency of one.

    So the question is not "is it slow" but "does load make it slower". A
    server that queues hands overload back as latency, and its p95 climbs in
    step with the number of clients. A server that is merely slow has a flat
    p95: the work costs what it costs, and adding clients does not change it.
    Telling those apart needs at least two load levels, and honesty about the
    fact when there is only one.
    """
    worst = max(loads, key=lambda l: l["p95"])
    lightest = min(loads, key=lambda l: l["concurrency"])
    heaviest = max(loads, key=lambda l: l["concurrency"])

    health_failed = any(l["health_errors"] for l in loads)
    health_slow = any(l["health_p95"] > 1000 for l in loads)
    work_slow = worst["p95"] > USABLE_P95_MS
    sheds = any(l["errors"] for l in loads)

    # Health first: if the cheapest possible request is failing or slow, what
    # the expensive ones did is beside the point.
    if health_failed:
        print("  VERDICT: the server stopped answering. It was down for everyone.")
        return
    if health_slow:
        print("  VERDICT: even the health check degraded past a second. "
              "Cheap requests were queued behind expensive ones.")
        return

    # How much did latency grow as clients were added? This is the measurement
    # that separates queueing from slowness, and it needs two points to exist.
    single_level = lightest["concurrency"] == heaviest["concurrency"]
    if not single_level and lightest["p95"] > 0:
        latency_growth = heaviest["p95"] / lightest["p95"]
        load_growth = heaviest["concurrency"] / lightest["concurrency"]
        # Queueing is latency rising roughly in proportion to the load. Half of
        # proportional is the threshold: a perfectly bounded server holds at
        # 1.0, a perfectly unbounded one tracks the load exactly, and anything
        # climbing at even half that rate has no ceiling worth the name.
        queues = latency_growth > max(2.0, load_growth * 0.5)
    else:
        latency_growth = 1.0
        queues = False

    if single_level:
        # One load level cannot answer the question. Say what was measured and
        # decline to draw the conclusion, rather than guessing at it.
        if work_slow:
            print(f"  VERDICT: work took {worst['p95'] / 1000:.1f} s at p95 with "
                  f"{worst['concurrency']} concurrent. Health stayed fast.")
            print("           Only one load level was measured, so this cannot "
                  "tell a slow endpoint from a queue. Run more than one "
                  "concurrency to find out.")
        else:
            print(f"  VERDICT: the server served everything offered within "
                  f"{worst['p95']:.0f} ms at p95, at {worst['concurrency']} "
                  f"concurrent. Only one load level was measured.")
        return

    if queues and not sheds:
        print(f"  VERDICT: the server queued instead of shedding. Latency grew "
              f"{latency_growth:.1f}x between {lightest['concurrency']} and "
              f"{heaviest['concurrency']} concurrent clients, reaching "
              f"{heaviest['p95'] / 1000:.1f} s at p95, and no request was ever "
              f"refused.")
        print("           Unbounded queueing turns overload into latency. A "
              "refused request tells the client to back off; a slow one does not.")
        return
    if queues and sheds:
        print(f"  VERDICT: the server shed some load but still queued behind it "
              f"— latency grew {latency_growth:.1f}x up to "
              f"{heaviest['p95'] / 1000:.1f} s at p95. The limit is too "
              f"generous for what this hardware can actually serve.")
        return
    if work_slow:
        # Flat latency under rising load. The limit is doing its job; the work
        # underneath it is expensive. This is a real finding and a different
        # one, and it points at the handler rather than at the concurrency.
        print(f"  VERDICT: load did not make it worse — latency held at "
              f"{latency_growth:.1f}x from {lightest['concurrency']} to "
              f"{heaviest['concurrency']} concurrent"
              f"{', refusing the excess' if sheds else ''}.")
        print(f"           But the work itself is slow: {worst['p95'] / 1000:.1f} s "
              f"at p95. That is the cost of the request, not of the load, so "
              f"look at the handler rather than the limits.")
        return
    if sheds:
        print("  VERDICT: the server shed excess load and stayed fast for what it "
              "accepted. This is the behaviour wanted under overload.")
        return
    print(f"  VERDICT: the server served everything offered within "
          f"{worst['p95']:.0f} ms at p95. It was not saturated by this test.")


def cmd_report(args: argparse.Namespace) -> int:
    return report(connect(Path(args.db)), args.run)


def cmd_list(args: argparse.Namespace) -> int:
    conn = connect(Path(args.db))
    rows = conn.execute(
        "SELECT r.*, (SELECT COUNT(*) FROM measurements m WHERE m.run_id = r.id"
        " AND m.ok = 0) broken FROM runs r ORDER BY r.id DESC LIMIT ?",
        (args.limit,)).fetchall()
    if not rows:
        print("no runs recorded yet")
        return 0
    print(f"{'id':>4}  {'when':19}  {'server':10}  {'where':10}  {'label':12}  broken")
    for r in rows:
        print(f"{r['id']:>4}  {r['started_at'][:19]:19}  {r['server_version'][:10]:10}  "
              f"{'local' if r['colocated'] else 'remote':10}  "
              f"{(r['label'] or '')[:12]:12}  {r['broken']}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--db", default="benchmarks/dtbench.sqlite",
                    help="SQLite database of runs (default: %(default)s)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="measure and stress a target")
    r.add_argument("--target", default="http://127.0.0.1:8080")
    r.add_argument("--label", default=None, help="a name for this run")
    r.add_argument("--notes", default=None)
    r.add_argument("--samples", type=int, default=20,
                   help="sequential samples per scenario (default: %(default)s)")
    r.add_argument("--concurrency", type=int, nargs="+", default=[1, 4, 16, 64],
                   help="load levels to ramp through (default: %(default)s)")
    r.add_argument("--duration", type=float, default=10.0,
                   help="seconds at each load level (default: %(default)s)")
    r.add_argument("--no-report", action="store_true")
    r.set_defaults(func=cmd_run)

    p = sub.add_parser("report", help="compare a run against the history")
    p.add_argument("--run", type=int, default=None, help="run id (default: latest)")
    p.set_defaults(func=cmd_report)

    l = sub.add_parser("list", help="list recorded runs")
    l.add_argument("--limit", type=int, default=20)
    l.set_defaults(func=cmd_list)

    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
