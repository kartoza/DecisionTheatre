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
import subprocess
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

# Its sibling in scripts/. Imported by path rather than by package so the two
# files can be copied onto a server together and run from anywhere, which is
# the property that makes this tool usable against production.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import dtbench_pdf as dtpdf  # noqa: E402

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
  -- The revision the measured server was built from, as the server itself
  -- reports it at /api/info. Not the revision this tool was run from: point it
  -- at production and those are different, and recording the local one would
  -- attribute production's numbers to whatever the operator had checked out.
  -- A wrong answer here is worse than an empty one, because it survives into a
  -- bisect and sends someone to a commit that never contained the change.
  commit_sha    TEXT,
  -- Where commit_sha came from: 'server' when the build stamped it, 'unstamped'
  -- when the server is too old or was built without ldflags. Kept because a
  -- report must be able to say "unknown" rather than imply a provenance the
  -- measurement does not have.
  commit_source TEXT,
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


# Columns added after the first databases were created. CREATE TABLE IF NOT
# EXISTS does nothing to a table that already exists, so a schema change needs
# this or every existing history has to be thrown away — and throwing away the
# history defeats the purpose of a tool whose whole job is comparing against it.
MIGRATIONS = [
    ("runs", "commit_sha", "TEXT"),
    ("runs", "commit_source", "TEXT"),
]


def connect(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    for table, column, decl in MIGRATIONS:
        have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if column not in have:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
    conn.commit()
    return conn


def is_colocated(target: str) -> bool:
    host = urllib.parse.urlparse(target).hostname or ""
    if host in ("127.0.0.1", "localhost", "::1", "0.0.0.0"):
        return True
    try:
        return socket.gethostbyname(host) == socket.gethostbyname(socket.gethostname())
    except Exception:
        return False


def server_identity(target: str) -> tuple[str, str, str]:
    """Ask the server what it is: (version, commit, source of that commit).

    The commit comes from the server rather than from `git rev-parse` here, and
    that distinction is the whole reason the field is trustworthy. This tool is
    designed to be pointed at a server it did not build — that is most of its
    value — and in that case the local checkout has no relationship to what is
    running at the other end. Recording HEAD would produce a plausible sha
    attached to somebody else's numbers.

    A server built without -X main.commit reports "unknown", and that is passed
    through as-is rather than filled in. See scripts/commit.sh.
    """
    try:
        url = target.rstrip("/") + "/api/info"
        with urllib.request.urlopen(url, timeout=10) as r:
            info = json.loads(r.read())
    except Exception:
        return "unknown", "", "unreachable"

    version = str(info.get("version", "unknown"))
    commit = str(info.get("commit", "") or "")
    if not commit or commit == "unknown":
        # Either an older server that predates the field, or a build with no
        # ldflags. Either way this run cannot be placed on the timeline, and
        # saying so is the only honest option.
        return version, "", "unstamped"
    return version, commit, "server"


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
    version, commit, commit_source = server_identity(target)
    print(f"server      {version}")
    if commit_source == "server":
        print(f"commit      {commit}"
              + ("   (built from a dirty tree; not reproducible from the sha alone)"
                 if commit.endswith("-dirty") else ""))
    else:
        print("commit      unknown   (this server does not report one; "
              "the run cannot be placed on the timeline)")
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
    #
    #    Not against a remote target unless someone said so out loud. The load
    #    phase saturates the server deliberately - that is the whole point of it
    #    - and the obvious thing to type is the production URL. On an instance
    #    with load shedding configured this refuses real users while it runs;
    #    without one it queues them behind the benchmark. Either way it is an
    #    outage caused by a measurement, and the flag has to be spelled out.
    #
    #    The probe and latency phases still run: those are a handful of ordinary
    #    requests, which is what any visitor does.
    if not colocated and not args.stress_remote:
        print("load      skipped: the target is not on this machine")
        print("          The load phase saturates the server on purpose, which "
              "against a live\n          instance means refusing or delaying "
              "real users. Pass --stress-remote\n          to do it anyway.")
        print()
        loads: list[LoadResult] = []
        return _record(conn, args, target, version, commit, commit_source,
                       colocated, measured, loads)

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

    return _record(conn, args, target, version, commit, commit_source,
                   colocated, measured, loads)


def _record(conn: sqlite3.Connection, args: argparse.Namespace, target: str,
            version: str, commit: str, commit_source: str, colocated: bool,
            measured: list[Measured], loads: list[LoadResult]) -> int:
    """Write the run and report on it. Shared by both exits from cmd_run."""
    started = datetime.now(timezone.utc).isoformat(timespec="seconds")
    cur = conn.execute(
        "INSERT INTO runs (started_at, target, label, server_version, commit_sha,"
        " commit_source, colocated, host, cpus, samples, notes)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (started, target, args.label, version, commit, commit_source,
         int(colocated), platform.node(), os.cpu_count() or 0, args.samples,
         args.notes))
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
    write_pdf(conn, run_id, args.pdf, args.open_it)
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
        print_verdict(loads)


# How long a user will wait for real work before the site is useless to them,
# whatever the health check says.
USABLE_P95_MS = 3000.0


def verdict_lines(loads: list[sqlite3.Row]) -> list[str]:
    """Judge the server, not just its health check.

    This has been wrong three times, and every one of them is worth keeping
    written down, because each looked entirely reasonable when it was written.

    The first version looked only at the health probe and reported "stayed
    responsive" for a server whose real work had reached 18.5 s at p95. Health
    answered in 2 ms throughout - health checks are cheap, and say nothing
    about whether real work is getting done.

    The second read any slow result with no errors as unbounded queueing. That
    is right under overload and nonsense below it: with one client there is no
    queue to be in. It accused a server of queueing at a concurrency of one.

    The third classified correctly and then said the opposite in words. Latency
    had grown 2.5x and the summary line opened "load did not make it worse". A
    verdict nobody can trust to mean what it says is worse than no verdict.

    WHAT IT ACTUALLY ASKS

    Not "is it slow" but "how does latency respond to load", which needs two
    load levels and a comparison against how much the load itself grew.

    A queue hands overload back as latency in direct proportion: eight times
    the clients, eight times the wait, because each arrival waits behind all
    the others. A server absorbing load with real parallelism shows latency
    growing far more slowly than the client count. So the discriminator is the
    ratio between the two growths, not the latency figure on its own.

    The other half of the judgement is whether anything was refused. A refusal
    is the only positive evidence that a ceiling exists. Without one, the most
    that can be said is that the ceiling was not reached - which is a different
    statement from "there is no ceiling", and the tool should not confuse them.
    """
    out: list[str] = []

    def say(s: str) -> None:
        out.append(s)

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
        say("the server stopped answering. It was down for everyone.")
        return out
    if health_slow:
        say("even the health check degraded past a second. "
            "Cheap requests were queued behind expensive ones.")
        return out

    single_level = lightest["concurrency"] == heaviest["concurrency"]
    if single_level:
        # One load level cannot answer the question. Say what was measured and
        # decline to draw the conclusion rather than guessing at it.
        if work_slow:
            say(f"work took {worst['p95'] / 1000:.1f} s at p95 with "
                f"{worst['concurrency']} concurrent. Health stayed fast.")
            say("    Only one load level was measured, so this cannot tell a "
                "slow endpoint from a queue. Run more than one concurrency to "
                "find out.")
        else:
            say(f"the server served everything offered within "
                f"{worst['p95']:.0f} ms at p95, at {worst['concurrency']} "
                f"concurrent. Only one load level was measured.")
        return out

    lo, hi = lightest["concurrency"], heaviest["concurrency"]
    load_growth = hi / lo
    latency_growth = (heaviest["p95"] / lightest["p95"]
                      if lightest["p95"] > 0 else 1.0)
    # How much of the added load came back as waiting. 1.0 is a pure queue;
    # near 0 is a server absorbing the work without anyone waiting longer.
    passthrough = (latency_growth - 1.0) / (load_growth - 1.0) if load_growth > 1 else 0.0

    grew = latency_growth > 1.3
    # Half of proportional. A perfectly bounded server holds near 1.0; a
    # perfectly unbounded one tracks the load exactly. Anything giving back
    # even half of what it is given has no ceiling worth the name.
    queues = passthrough >= 0.5

    growth = (f"latency grew {latency_growth:.1f}x while the client count grew "
              f"{load_growth:.0f}x, from {lo} to {hi}")

    if queues and not sheds:
        say(f"the server queued instead of shedding. {growth}, reaching "
            f"{heaviest['p95'] / 1000:.1f} s at p95, and no request was ever "
            f"refused.")
        say("    Unbounded queueing turns overload into latency. A refused "
            "request tells the client to back off; a slow one does not.")
        return out
    if queues and sheds:
        say(f"the server refused some requests but still queued behind the "
            f"rest - {growth}, up to {heaviest['p95'] / 1000:.1f} s at p95.")
        say("    The limit is too generous for what this hardware can serve.")
        return out

    if grew and not sheds:
        # Latency rose, but far less than the load did, so the server is
        # absorbing rather than queueing. Nothing was refused, which means the
        # ceiling was not found - not that there isn't one.
        say(f"the server absorbed the load rather than queueing behind it: "
            f"{growth}, reaching {heaviest['p95'] / 1000:.1f} s at p95.")
        say(f"    Nothing was refused, so this run found no ceiling - it does "
            f"not show there is none. Push past {hi} concurrent to find it.")
        if work_slow:
            say(f"    Separately, the work itself is slow at "
                f"{worst['p95'] / 1000:.1f} s. That is the cost of the request, "
                f"not of the load.")
        return out
    if grew and sheds:
        say(f"the server refused its excess and absorbed the rest: {growth}, "
            f"which is well short of proportional.")
        if work_slow:
            say(f"    The work itself is slow at {worst['p95'] / 1000:.1f} s at "
                f"p95. That is the cost of the request, not of the load, so "
                f"look at the handler rather than the limits.")
        return out

    if work_slow:
        # Flat latency under rising load. The limit is doing its job; the work
        # underneath it is expensive. A real finding, and a different one: it
        # points at the handler rather than at the concurrency.
        say(f"load did not make it worse - latency held at {latency_growth:.1f}x "
            f"from {lo} to {hi} concurrent"
            f"{', refusing the excess' if sheds else ''}.")
        say(f"    But the work itself is slow: {worst['p95'] / 1000:.1f} s at "
            f"p95. That is the cost of the request, not of the load, so look at "
            f"the handler rather than the limits.")
        return out
    if sheds:
        say("the server shed excess load and stayed fast for what it accepted. "
            "This is the behaviour wanted under overload.")
        return out
    say(f"the server served everything offered within {worst['p95']:.0f} ms "
        f"at p95. It was not saturated by this test.")
    return out


def print_verdict(loads: list[sqlite3.Row]) -> None:
    """The console rendering of verdict_lines.

    The PDF uses the same lines. One set of words with two renderings, rather
    than two sets that can drift - and the one nobody reads would be the one
    that goes wrong.
    """
    lines = verdict_lines(loads)
    if not lines:
        return
    print(f"  VERDICT: {lines[0]}")
    for extra in lines[1:]:
        print(f"       {extra}")


# --------------------------------------------------------------------------
# Finding where a change happened
#
# The comparison in report() answers "is this run different from the ones
# before it". This answers the more useful question: somewhere in the recorded
# history this endpoint got slower — where, and which commit was it?
#
# It is deliberately a search over recorded runs rather than a `git bisect`.
# Bisecting means building and starting the server at each candidate revision,
# and each of those builds is minutes; the history is already sitting in the
# database and every row already names its commit. If the answer is in there,
# there is no reason to rebuild anything to find it.
# --------------------------------------------------------------------------

@dataclass
class StepChange:
    """A point where a measurement moved to a new level and stayed there."""
    scenario: str
    index: int              # first run at the new level
    before: float           # median of the runs before it
    after: float            # median from it onwards
    run_id: int
    commit: str
    label: str
    started_at: str
    # Set when most of the suite moved at the same run in the same direction,
    # which points at the machine rather than at this endpoint's handler.
    systemic: bool = False

    @property
    def delta(self) -> float:
        return self.after - self.before

    @property
    def ratio(self) -> float:
        return self.after / self.before if self.before else 0.0

    @property
    def slower(self) -> bool:
        return self.after > self.before


# A step has to clear both of these to be reported. Percentage alone flags
# noise on a 2 ms endpoint; absolute alone never flags a 40% regression on a
# fast one. Requiring both is what keeps the list short enough to act on.
STEP_MIN_RATIO = 1.25

# The absolute floor was 1 ms, and the first report drawn from real history
# duly announced a step change on /api/health, /api/info, the index page and a
# tile fetch, all at the same run: 4 ms down to 1 ms. Every one of those is a
# round trip with nothing behind it, and what actually changed was that the
# machine had been busy during the earlier runs.
#
# 5 ms is the scale of jitter on a local HTTP round trip, and no change below
# it on an endpoint of this size is worth anyone's afternoon. A real
# regression on a fast endpoint - 2 ms to 20 ms - still clears it easily.
STEP_MIN_MS = 5.0

# How much of the suite has to move at once before a step is read as the
# environment rather than the code. A commit that slows down the health check,
# the index page, a tile read and a metadata lookup by the same proportion on
# the same run has almost certainly not touched all four: something changed
# under the whole process. Reporting that as four regressions sends someone
# looking through four unrelated handlers for one cause that is in none of
# them.
SYSTEMIC_FRACTION = 0.4
SYSTEMIC_MIN_COUNT = 3


def find_step_change(values: list[float]) -> tuple[int, float, float] | None:
    """The most convincing point at which a series moved to a new level.

    Every split of the series is scored by how far apart the two halves' medians
    are relative to the scatter within them, and the best-scoring split wins.
    Medians rather than means: one pathological run — a laptop that started a
    backup mid-benchmark — should not be able to invent a step, and with a mean
    it can.

    Returns None when there is no split worth reporting, which is the common
    case and the one to get right. A tool that finds a regression in every
    series is not a tool anybody keeps using.

    At least two runs are needed on each side. With one, "before" and "after"
    are single measurements and any difference between them is as likely to be
    jitter as news.
    """
    n = len(values)
    if n < 4:
        return None

    best = None
    best_score = 0.0
    for i in range(2, n - 1):
        before, after = values[:i], values[i:]
        mb, ma = statistics.median(before), statistics.median(after)
        if mb <= 0:
            continue
        # Scatter within the halves, floored so a series of identical values
        # does not divide by zero and score infinitely.
        spread = max(
            statistics.pstdev(before) if len(before) > 1 else 0.0,
            statistics.pstdev(after) if len(after) > 1 else 0.0,
            mb * 0.02, 0.2)
        score = abs(ma - mb) / spread
        if score > best_score:
            best_score, best = score, (i, mb, ma)

    if best is None:
        return None
    i, mb, ma = best
    ratio = ma / mb
    if abs(ma - mb) < STEP_MIN_MS:
        return None
    if ratio < STEP_MIN_RATIO and ratio > 1.0 / STEP_MIN_RATIO:
        return None
    # A step nobody could distinguish from the scatter is not a step.
    if best_score < 2.0:
        return None
    return best


def scenario_history(conn: sqlite3.Connection, scenario: str,
                     colocated: int) -> list[sqlite3.Row]:
    """Every good measurement of one scenario, oldest first.

    Restricted to one side of the co-located divide, for the same reason the
    report is: a run from the server's own machine and a run from across a
    network are not measuring the same quantity, and interleaving them
    manufactures a step change at every switch between them.
    """
    return conn.execute(
        "SELECT m.p50, m.p95, r.id run_id, r.commit_sha, r.label, r.started_at"
        "  FROM measurements m JOIN runs r ON r.id = m.run_id"
        " WHERE m.name = ? AND m.ok = 1 AND r.colocated = ?"
        " ORDER BY r.id", (scenario, colocated)).fetchall()


def find_regressions(conn: sqlite3.Connection, colocated: int,
                     slower_only: bool = False) -> list[StepChange]:
    """Every scenario whose history contains a step, worst first."""
    names = [r["name"] for r in conn.execute(
        "SELECT DISTINCT name FROM measurements WHERE ok = 1 ORDER BY name")]
    found: list[StepChange] = []
    for name in names:
        rows = scenario_history(conn, name, colocated)
        step = find_step_change([r["p50"] for r in rows])
        if not step:
            continue
        i, before, after = step
        at = rows[i]
        change = StepChange(name, i, before, after, at["run_id"],
                            at["commit_sha"] or "", at["label"] or "",
                            at["started_at"])
        found.append(change)

    mark_systemic(found)
    if slower_only:
        found = [c for c in found if c.slower]
    found.sort(key=lambda c: (c.systemic, -abs(c.ratio - 1.0)))
    return found


def mark_systemic(changes: list[StepChange]) -> None:
    """Flag the steps that moved together, because those are the environment.

    Judged on the run they first appear at and the direction they went. A code
    change that genuinely slowed four unrelated endpoints is possible and would
    be flagged as systemic here — but the check is still worth having, because
    that case is rare and the machine-got-busy case is not, and both want the
    same first question asked: what changed underneath all of them?
    """
    if len(changes) < SYSTEMIC_MIN_COUNT:
        return
    counts: dict[tuple[int, bool], int] = {}
    for c in changes:
        key = (c.run_id, c.slower)
        counts[key] = counts.get(key, 0) + 1

    threshold = max(SYSTEMIC_MIN_COUNT, int(len(changes) * SYSTEMIC_FRACTION))
    for c in changes:
        if counts[(c.run_id, c.slower)] >= threshold:
            c.systemic = True


def cmd_regressions(args: argparse.Namespace) -> int:
    conn = connect(Path(args.db))
    colocated = 0 if args.remote else 1
    changes = find_regressions(conn, colocated, slower_only=args.slower_only)

    where = "remote" if args.remote else "co-located"
    if not changes:
        runs = conn.execute("SELECT COUNT(*) c FROM runs WHERE colocated = ?",
                            (colocated,)).fetchone()["c"]
        if runs < 4:
            print(f"only {runs} {where} run(s) recorded; at least 4 are needed "
                  "before a step can be told from scatter")
        else:
            print(f"no step changes found across {runs} {where} runs")
        return 0

    real = [c for c in changes if not c.systemic]
    systemic = [c for c in changes if c.systemic]

    print(f"step changes across the {where} history\n")
    for c in real:
        arrow = "SLOWER" if c.slower else "faster"
        print(f"  {c.scenario}")
        print(f"    {arrow:7} {c.before:8.1f} -> {c.after:8.1f} ms "
              f"({(c.ratio - 1.0) * 100:+.0f}%)")
        print(f"    first seen in run {c.run_id}, {c.started_at[:19]}"
              + (f", {c.label}" if c.label else ""))
        print(f"    commit {c.commit or 'unknown (server did not report one)'}")
        if c.commit and not c.commit.endswith("-dirty"):
            print(f"    git show {c.commit}")
        print()

    if systemic:
        # Reported, but separately and without commit attribution, because
        # attributing a whole-machine effect to a commit is how someone ends up
        # reverting an innocent change.
        run_id = systemic[0].run_id
        print(f"  {len(systemic)} endpoints moved together at run {run_id}:")
        for c in systemic:
            print(f"    {c.scenario:34} {c.before:8.1f} -> {c.after:8.1f} ms "
                  f"({(c.ratio - 1.0) * 100:+.0f}%)")
        print("\n    Unrelated endpoints changing by the same proportion on the "
              "same run is\n    the signature of the machine, not of a commit. "
              "Look at what the host was\n    doing before looking at the code.")
        print()
    return 0


def resolve_pdf_path(arg: str | None, run_id: int) -> Path | None:
    """Where the PDF goes, given whatever --pdf was passed.

    --pdf with no value means "somewhere sensible"; --pdf with a path means
    there. A bare default keeps reports from piling up in whatever directory
    the tool happened to be run from.
    """
    if arg is None:
        return None
    if arg == "":
        return Path("benchmarks/reports") / f"dtbench-run-{run_id}.pdf"
    return Path(arg)


def write_pdf(conn: sqlite3.Connection, run_id: int, arg: str | None,
              open_it: bool) -> None:
    path = resolve_pdf_path(arg, run_id)
    if path is None:
        return
    out = build_pdf(conn, run_id, path)
    print(f"\nreport written to {out}")
    if open_it:
        open_file(out)


def cmd_report(args: argparse.Namespace) -> int:
    conn = connect(Path(args.db))
    run_id = args.run
    if run_id is None:
        row = conn.execute("SELECT id FROM runs ORDER BY id DESC LIMIT 1").fetchone()
        if not row:
            print("no runs recorded yet")
            return 1
        run_id = row["id"]
    rc = report(conn, run_id)
    write_pdf(conn, run_id, args.pdf, args.open_it)
    return rc or 0


def cmd_list(args: argparse.Namespace) -> int:
    conn = connect(Path(args.db))
    rows = conn.execute(
        "SELECT r.*, (SELECT COUNT(*) FROM measurements m WHERE m.run_id = r.id"
        " AND m.ok = 0) broken FROM runs r ORDER BY r.id DESC LIMIT ?",
        (args.limit,)).fetchall()
    if not rows:
        print("no runs recorded yet")
        return 0
    print(f"{'id':>4}  {'when':19}  {'commit':17}  {'where':6}  "
          f"{'label':16}  broken")
    for r in rows:
        # The commit is what makes a row findable again months later, so it
        # earns a column even though it costs the label some width.
        commit = r["commit_sha"] or "-"
        print(f"{r['id']:>4}  {r['started_at'][:19]:19}  {commit[:17]:17}  "
              f"{'local' if r['colocated'] else 'remote':6}  "
              f"{(r['label'] or '')[:16]:16}  {r['broken']}")
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
    r.add_argument("--stress-remote", action="store_true",
                   help="run the load phase against a target that is not on "
                        "this machine. It saturates the server on purpose.")
    r.add_argument("--pdf", nargs="?", const="", default=None, metavar="PATH",
                   help="write a PDF report (default: benchmarks/reports/)")
    r.add_argument("--open", action="store_true", dest="open_it",
                   help="open the PDF when it is written")
    r.set_defaults(func=cmd_run)

    p = sub.add_parser("report", help="compare a run against the history")
    p.add_argument("--run", type=int, default=None, help="run id (default: latest)")
    p.add_argument("--pdf", nargs="?", const="", default=None, metavar="PATH",
                   help="write a PDF report (default: benchmarks/reports/)")
    p.add_argument("--open", action="store_true", dest="open_it",
                   help="open the PDF when it is written")
    p.set_defaults(func=cmd_report)

    g = sub.add_parser(
        "regressions",
        help="find where in the recorded history a measurement changed level")
    g.add_argument("--remote", action="store_true",
                   help="search runs taken across the network, not co-located ones")
    g.add_argument("--slower-only", action="store_true",
                   help="report only the changes for the worse")
    g.set_defaults(func=cmd_regressions)

    l = sub.add_parser("list", help="list recorded runs")
    l.add_argument("--limit", type=int, default=20)
    l.set_defaults(func=cmd_list)

    args = ap.parse_args()
    return args.func(args)




# --------------------------------------------------------------------------
# PDF report
#
# Same numbers as the console output and the same words for the verdict — the
# report is a rendering of the analysis, not a second opinion. Anything the PDF
# said that the terminal did not would be a place for the two to drift apart,
# and the one nobody reads would be the one that goes wrong.
# --------------------------------------------------------------------------

PAGE_MARGIN = 46.0
FOOTER_Y = 800.0


def _footer(pdf, page_no: int, subtitle: str) -> None:
    pdf.line(PAGE_MARGIN, FOOTER_Y - 12, 549, FOOTER_Y - 12, width=0.4,
             color=dtpdf.FAINT)
    pdf.text(PAGE_MARGIN, FOOTER_Y, subtitle, size=7, color=dtpdf.MUTED)
    pdf.text(549, FOOTER_Y, f"page {page_no}", size=7, color=dtpdf.MUTED,
             align="right")
    pdf.text(297, FOOTER_Y + 12, "Made with love by Kartoza  |  kartoza.com  |  "
             "github.com/kartoza/DecisionTheatre", size=6.5,
             color=dtpdf.MUTED, align="center")


def _heading(pdf, y: float, text: str) -> float:
    """A heading with a rule under it.

    text() takes y as the top of the line, not the baseline, so the rule has to
    clear the full point size. At y + 6 it drew straight through the middle of
    the words.
    """
    size = 12.0
    pdf.text(PAGE_MARGIN, y, text, size=size, font=dtpdf.HELVETICA_BOLD,
             color=dtpdf.INK)
    rule = y + size + 3
    pdf.line(PAGE_MARGIN, rule, 549, rule, width=0.7, color=dtpdf.INK)
    return rule + 14


def _kv(pdf, y: float, key: str, value: str, colour=dtpdf.INK) -> float:
    pdf.text(PAGE_MARGIN, y, key, size=8, color=dtpdf.MUTED)
    pdf.text(PAGE_MARGIN + 92, y, value, size=8, font=dtpdf.COURIER, color=colour)
    return y + 12


def _wrap(text: str, width: float, size: float, font=None) -> list[str]:
    """Greedy wrap using the real font metrics, so nothing runs off the page."""
    font = font or dtpdf.HELVETICA
    words, lines, cur = text.split(), [], ""
    for w in words:
        trial = f"{cur} {w}".strip()
        if dtpdf.text_width(trial, size, font) > width and cur:
            lines.append(cur)
            cur = w
        else:
            cur = trial
    if cur:
        lines.append(cur)
    return lines


def build_pdf(conn: sqlite3.Connection, run_id: int, path: Path) -> Path:
    """Render one run, with its history, to a PDF."""
    run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    if not run:
        raise SystemExit(f"no run {run_id}")

    pdf = dtpdf.PDF()
    colocated = run["colocated"]
    subtitle = (f"run {run_id}  |  {run['started_at'][:19]}  |  "
                f"{run['target']}")

    # ---------------- page 1: what was measured, and the verdict ----------
    pdf.add_page()
    pdf.text(PAGE_MARGIN, 56, "Decision Theatre", size=20,
             font=dtpdf.HELVETICA_BOLD, color=dtpdf.INK)
    pdf.text(PAGE_MARGIN, 74, "Benchmark report", size=12, color=dtpdf.MUTED)

    y = _heading(pdf, 108, "What was measured")
    commit = run["commit_sha"] or ""
    if commit:
        commit_note = commit + ("   built from a dirty tree" if
                                commit.endswith("-dirty") else "")
        commit_colour = dtpdf.WARN if commit.endswith("-dirty") else dtpdf.INK
    else:
        commit_note = "unknown - this server does not report one"
        commit_colour = dtpdf.WARN
    y = _kv(pdf, y, "target", run["target"])
    y = _kv(pdf, y, "server version", run["server_version"] or "unknown")
    y = _kv(pdf, y, "commit", commit_note, commit_colour)
    y = _kv(pdf, y, "run from", f"{run['host']}  {run['cpus']} cpus")
    y = _kv(pdf, y, "measured", "from the server's own machine" if colocated
            else "across the network")
    if run["label"]:
        y = _kv(pdf, y, "label", run["label"])
    if run["notes"]:
        y = _kv(pdf, y, "notes", run["notes"])

    if colocated:
        y += 6
        for line in _wrap(
                "Co-located: the load generator and the server shared a machine, "
                "so these numbers include the contention between them. Comparable "
                "with other co-located runs and with nothing else.",
                460, 7.5):
            pdf.text(PAGE_MARGIN, y, line, size=7.5, color=dtpdf.MUTED)
            y += 10

    # The verdict, in a box, because it is the one thing on the page somebody
    # skimming has to see.
    loads = conn.execute(
        "SELECT * FROM load_results WHERE run_id = ? ORDER BY concurrency",
        (run_id,)).fetchall()
    y += 14
    if loads:
        lines: list[str] = []
        for raw in verdict_lines(loads):
            lines.extend(_wrap(raw.strip(), 440, 8.5))
        box_h = 20 + len(lines) * 11
        pdf.rect(PAGE_MARGIN, y, 503, box_h, fill=dtpdf.BAND)
        pdf.rect(PAGE_MARGIN, y, 3.5, box_h, fill=dtpdf.ACCENT)
        pdf.text(PAGE_MARGIN + 14, y + 14, "VERDICT", size=8,
                 font=dtpdf.HELVETICA_BOLD, color=dtpdf.ACCENT)
        ly = y + 28
        for line in lines:
            pdf.text(PAGE_MARGIN + 14, ly, line, size=8.5, color=dtpdf.INK)
            ly += 11
        y += box_h + 24

        y = _heading(pdf, y, "Under load")
        cols = [(PAGE_MARGIN, "clients", "left"), (150, "req/s", "right"),
                (230, "p95 ms", "right"), (310, "refused", "right"),
                (400, "health p95", "right"), (500, "health max", "right")]
        for x, label, align in cols:
            pdf.text(x, y, label, size=7.5, font=dtpdf.HELVETICA_BOLD,
                     color=dtpdf.MUTED, align=align)
        y += 11
        pdf.line(PAGE_MARGIN, y, 549, y, width=0.4, color=dtpdf.FAINT)
        y += 12
        for l in loads:
            health_colour = dtpdf.INK
            if l["health_errors"]:
                health_colour = dtpdf.BAD
            elif l["health_p95"] > 1000:
                health_colour = dtpdf.WARN
            pdf.text(PAGE_MARGIN, y, str(l["concurrency"]), size=8.5,
                     font=dtpdf.COURIER)
            pdf.text(150, y, f"{l['rps']:.1f}", size=8.5, font=dtpdf.COURIER,
                     align="right")
            pdf.text(230, y, f"{l['p95']:.0f}", size=8.5, font=dtpdf.COURIER,
                     align="right")
            pdf.text(310, y, str(l["errors"]), size=8.5, font=dtpdf.COURIER,
                     align="right")
            pdf.text(400, y, f"{l['health_p95']:.1f}", size=8.5,
                     font=dtpdf.COURIER, color=health_colour, align="right")
            pdf.text(500, y, f"{l['health_worst']:.1f}", size=8.5,
                     font=dtpdf.COURIER, color=health_colour, align="right")
            y += 12
        y += 6
        for line in _wrap(
                "Refused requests are not failures. A server past its capacity "
                "can refuse quickly or serve slowly, and refusing is the better "
                "of the two: the client learns immediately and can back off.",
                480, 7.5):
            pdf.text(PAGE_MARGIN, y, line, size=7.5, color=dtpdf.MUTED)
            y += 10
    else:
        # A page that simply omits the load section leaves the reader wondering
        # whether it was skipped or whether the server passed.
        y = _heading(pdf, y, "Under load")
        for line in _wrap(
                "Not measured. The load phase saturates the server on purpose, "
                "which against an instance that is not on this machine means "
                "refusing or delaying real users, so it is opt-in for a remote "
                "target. Re-run with --stress-remote to include it."
                if not colocated else
                "Not measured in this run.", 480, 8):
            pdf.text(PAGE_MARGIN, y, line, size=8, color=dtpdf.MUTED)
            y += 11
    _footer(pdf, 1, subtitle)

    # ---------------- page 2: this run against its history ----------------
    hist = conn.execute(
        "SELECT m.name, m.p50 FROM measurements m JOIN runs r ON r.id = m.run_id"
        " WHERE r.id != ? AND r.colocated = ? AND m.ok = 1",
        (run_id, colocated)).fetchall()
    by_name: dict[str, list[float]] = {}
    for h in hist:
        by_name.setdefault(h["name"], []).append(h["p50"])

    rows = conn.execute(
        "SELECT * FROM measurements WHERE run_id = ? ORDER BY grp, name",
        (run_id,)).fetchall()

    pdf.add_page()
    y = _heading(pdf, 56, "Latency, against the whole history")
    n_runs = conn.execute("SELECT COUNT(*) c FROM runs WHERE id != ?"
                          " AND colocated = ?", (run_id, colocated)).fetchone()["c"]
    for line in _wrap(
            f"Each endpoint compared against the median of {n_runs} earlier "
            "run(s), not against one nominated baseline: a single previous run "
            "can be an outlier, and comparing against it reports that outlier's "
            "noise as this run's news. A difference is only called a difference "
            "when it exceeds the history's own spread.", 480, 7.5):
        pdf.text(PAGE_MARGIN, y, line, size=7.5, color=dtpdf.MUTED)
        y += 10
    y += 8

    for x, label, align in [(PAGE_MARGIN, "endpoint", "left"),
                            (300, "p50 ms", "right"), (360, "p95 ms", "right"),
                            (430, "median", "right"), (549, "change", "right")]:
        pdf.text(x, y, label, size=7.5, font=dtpdf.HELVETICA_BOLD,
                 color=dtpdf.MUTED, align=align)
    y += 11
    pdf.line(PAGE_MARGIN, y, 549, y, width=0.4, color=dtpdf.FAINT)
    y += 13

    group = None
    for r in rows:
        if y > 770:
            _footer(pdf, 2, subtitle)
            pdf.add_page()
            y = _heading(pdf, 56, "Latency, continued")
        if r["grp"] != group:
            group = r["grp"]
            pdf.text(PAGE_MARGIN, y, group, size=8,
                     font=dtpdf.HELVETICA_BOLD, color=dtpdf.ACCENT)
            y += 13
        if not r["ok"]:
            pdf.text(PAGE_MARGIN + 8, y, r["name"], size=8, color=dtpdf.BAD)
            pdf.text(549, y, f"BROKEN: {r['error']}", size=7.5,
                     color=dtpdf.BAD, align="right")
            y += 11
            continue

        past = by_name.get(r["name"], [])
        change, colour, median_text = "first run", dtpdf.MUTED, ""
        if len(past) >= 2:
            med = statistics.median(past)
            noise = max(statistics.stdev(past) * 2, med * 0.10, 0.5)
            delta = r["p50"] - med
            median_text = f"{med:.1f}"
            if abs(delta) <= noise:
                change, colour = "unchanged", dtpdf.MUTED
            elif delta < 0:
                change = f"faster {-delta / med * 100:.0f}%"
                colour = dtpdf.GOOD
            else:
                change = f"SLOWER {delta / med * 100:.0f}%"
                colour = dtpdf.BAD
        elif past:
            change = "1 sample, cannot judge"

        pdf.text(PAGE_MARGIN + 8, y, r["name"], size=8, color=dtpdf.INK)
        pdf.text(300, y, f"{r['p50']:.1f}", size=8, font=dtpdf.COURIER,
                 align="right")
        pdf.text(360, y, f"{r['p95']:.1f}", size=8, font=dtpdf.COURIER,
                 align="right")
        pdf.text(430, y, median_text, size=8, font=dtpdf.COURIER,
                 color=dtpdf.MUTED, align="right")
        pdf.text(549, y, change, size=8, color=colour, align="right")
        y += 11
    _footer(pdf, 2, subtitle)

    # ---------------- page 3: trends, and where things changed ------------
    steps = find_regressions(conn, colocated)
    by_scenario = {c.scenario: c for c in steps}

    # Chart the endpoints worth charting: anything with a detected step first,
    # then the slowest. A chart per endpoint would be 22 pages nobody reads.
    charted = [c.scenario for c in steps][:4]
    for r in sorted(rows, key=lambda r: -(r["p50"] or 0)):
        if len(charted) >= 6:
            break
        if r["ok"] and r["name"] not in charted:
            charted.append(r["name"])

    pdf.add_page()
    y = _heading(pdf, 56, "Trends")
    for line in _wrap(
            "Every recorded run for each endpoint, oldest on the left. The "
            "vertical axis starts at zero: a chart scaled to its own data turns "
            "a 3% wobble into a mountain range, which is how a benchmark ends up "
            "arguing for work that does not need doing.", 480, 7.5):
        pdf.text(PAGE_MARGIN, y, line, size=7.5, color=dtpdf.MUTED)
        y += 10
    y += 10

    for name in charted:
        h = scenario_history(conn, name, colocated)
        if len(h) < 2:
            continue
        if y > 640:
            _footer(pdf, 3, subtitle)
            pdf.add_page()
            y = _heading(pdf, 56, "Trends, continued")
        values = [row["p50"] for row in h]
        labels = [(row["commit_sha"] or f"run {row['run_id']}")[:7] for row in h]
        step = by_scenario.get(name)
        markers = [None] * len(values)
        title = f"{name}   p50 ms"
        if step:
            markers[step.index] = dtpdf.BAD if step.slower else dtpdf.GOOD
            title += (f"   step {'up' if step.slower else 'down'} at "
                      f"{labels[step.index]}")
            if step.systemic:
                title += "  (moved with the rest of the suite)"
        dtpdf.line_chart(pdf, PAGE_MARGIN, y, 503, 150, values, labels, title,
                         markers=markers)
        y += 172
    _footer(pdf, 3, subtitle)

    # ---------------- page 4: step changes --------------------------------
    pdf.add_page()
    y = _heading(pdf, 56, "Where things changed")
    if not steps:
        for line in _wrap(
                "No step changes detected. A step needs at least four runs on "
                "one side of the co-located divide, and has to move the median "
                "by more than a quarter and by more than the scatter within the "
                "runs either side of it. Short of that, a difference cannot be "
                "told from noise, and reporting it anyway would send somebody "
                "looking for a cause that does not exist.", 480, 8):
            pdf.text(PAGE_MARGIN, y, line, size=8, color=dtpdf.MUTED)
            y += 11
    else:
        for line in _wrap(
                "Points where a measurement moved to a new level and stayed "
                "there, with the commit the new level first appeared in. This is "
                "the search a bisect would perform, done against runs already "
                "recorded rather than by rebuilding each revision.", 480, 7.5):
            pdf.text(PAGE_MARGIN, y, line, size=7.5, color=dtpdf.MUTED)
            y += 10
        y += 10
        for c in [x for x in steps if not x.systemic]:
            if y > 740:
                _footer(pdf, 4, subtitle)
                pdf.add_page()
                y = _heading(pdf, 56, "Where things changed, continued")
            colour = dtpdf.BAD if c.slower else dtpdf.GOOD
            pdf.text(PAGE_MARGIN, y, c.scenario, size=9,
                     font=dtpdf.HELVETICA_BOLD, color=dtpdf.INK)
            pdf.text(549, y, f"{'SLOWER' if c.slower else 'faster'} "
                     f"{(c.ratio - 1) * 100:+.0f}%", size=9, color=colour,
                     align="right")
            y += 12
            pdf.text(PAGE_MARGIN + 8, y,
                     f"{c.before:.1f} ms  ->  {c.after:.1f} ms", size=8,
                     font=dtpdf.COURIER, color=dtpdf.INK)
            y += 11
            pdf.text(PAGE_MARGIN + 8, y,
                     f"first seen in run {c.run_id}, {c.started_at[:19]}"
                     + (f", {c.label}" if c.label else ""), size=7.5,
                     color=dtpdf.MUTED)
            y += 10
            pdf.text(PAGE_MARGIN + 8, y,
                     f"commit {c.commit or 'unknown - server did not report one'}",
                     size=7.5, font=dtpdf.COURIER,
                     color=dtpdf.INK if c.commit else dtpdf.WARN)
            y += 18

        systemic = [x for x in steps if x.systemic]
        if systemic:
            if y > 640:
                _footer(pdf, 4, subtitle)
                pdf.add_page()
                y = 56
            y += 8
            y = _heading(pdf, y, "Moved together - probably the machine")
            for line in _wrap(
                    f"{len(systemic)} unrelated endpoints changed by a similar "
                    f"proportion at run {systemic[0].run_id}. That is the "
                    "signature of something under the whole process - a busy "
                    "host, a different machine, a changed dataset - rather than "
                    "of a commit. They are listed without commit attribution on "
                    "purpose: pinning a whole-machine effect on a commit is how "
                    "an innocent change gets reverted.", 480, 7.5):
                pdf.text(PAGE_MARGIN, y, line, size=7.5, color=dtpdf.MUTED)
                y += 10
            y += 8
            for c in systemic:
                pdf.text(PAGE_MARGIN + 8, y, c.scenario, size=8, color=dtpdf.INK)
                pdf.text(549, y, f"{c.before:.1f} -> {c.after:.1f} ms "
                         f"({(c.ratio - 1) * 100:+.0f}%)", size=8,
                         font=dtpdf.COURIER, color=dtpdf.MUTED, align="right")
                y += 12
    _footer(pdf, 4, subtitle)

    path.parent.mkdir(parents=True, exist_ok=True)
    pdf.save(path)
    return path


def open_file(path: Path) -> None:
    """Hand the finished report to whatever the desktop opens PDFs with.

    Failure here is reported and ignored. The report exists on disk either way,
    and a headless machine or a CI runner has no opener at all — refusing to
    finish because nothing could display the file would break exactly the
    environments the tool is most useful in.
    """
    opener = "open" if sys.platform == "darwin" else "xdg-open"
    try:
        subprocess.Popen([opener, str(path)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except FileNotFoundError:
        print(f"({opener} not available; the report is at {path})")


if __name__ == "__main__":
    sys.exit(main())
