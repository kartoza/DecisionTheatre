#!/usr/bin/env python3
"""Tests for the parts of dtbench that draw conclusions.

The measuring is straightforward and fails loudly when it breaks. The verdict
is the part that has been wrong twice while looking entirely plausible, which
is exactly the kind of thing that needs pinning down.

    python3 scripts/test_dtbench.py
"""

import io
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import dtbench  # noqa: E402


def load(concurrency, p95, errors=0, health_p95=5.0, health_errors=0, rps=1.0):
    """One row of the load table, as sqlite3.Row would give it."""
    return {
        "concurrency": concurrency, "p95": p95, "errors": errors,
        "health_p95": health_p95, "health_errors": health_errors, "rps": rps,
    }


def verdict(loads):
    out = io.StringIO()
    with redirect_stdout(out):
        dtbench._verdict(loads)
    return out.getvalue()


class TestVerdict(unittest.TestCase):

    def test_a_server_that_is_down_is_reported_as_down(self):
        # Nothing else matters if the cheapest request is failing.
        v = verdict([load(8, 100.0, health_errors=3)])
        self.assertIn("down for everyone", v)

    def test_fast_health_does_not_excuse_slow_work(self):
        # The original bug. Health answered in 2 ms while real work sat at
        # 18.5 s, and the report called the server responsive. Health is fast
        # because health is free; it is not evidence about anything else.
        v = verdict([load(8, 6000.0), load(32, 18500.0)])
        self.assertNotIn("responsive", v.lower())
        self.assertIn("queued", v)

    def test_one_client_is_never_accused_of_queueing(self):
        # The second bug. With a single client there is no queue to be in, so a
        # slow response means a slow endpoint and nothing else.
        v = verdict([load(1, 5800.0)])
        self.assertNotIn("queued", v)
        self.assertIn("one load level", v)

    def test_latency_that_tracks_load_is_queueing(self):
        # The signature of an unbounded queue: double the clients, double the
        # wait. Measured before the fix as 10.4 s at 8 and 60.3 s at 64.
        v = verdict([load(8, 10355.0), load(32, 43043.0), load(64, 60340.0)])
        self.assertIn("queued instead of shedding", v)
        self.assertIn("no request was ever refused", v)

    def test_flat_latency_under_rising_load_is_not_queueing(self):
        # The state after the fix: the server refuses the excess, so latency
        # stops tracking the load. It must not be reported as queueing just
        # because the remaining number is large.
        v = verdict([load(8, 9449.0), load(32, 9669.0, errors=96),
                     load(64, 5337.0, errors=2355)])
        self.assertNotIn("queued instead", v)
        self.assertIn("load did not make it worse", v)

    def test_slow_but_bounded_work_points_at_the_handler(self):
        # A distinct and real finding: the limits are working, the endpoint is
        # expensive. Saying so is the difference between someone tuning the
        # concurrency (pointless) and someone caching the response (the fix).
        v = verdict([load(8, 9449.0, errors=0), load(64, 9500.0, errors=100)])
        self.assertIn("the work itself is slow", v)
        self.assertIn("handler", v)

    def test_shedding_and_fast_is_the_wanted_behaviour(self):
        v = verdict([load(8, 200.0), load(64, 250.0, errors=500)])
        self.assertIn("behaviour wanted under overload", v)

    def test_an_unsaturated_server_says_so(self):
        # No errors, fast, flat. The test simply did not push hard enough, and
        # claiming the server is robust on that basis would be unearned.
        v = verdict([load(1, 50.0), load(8, 60.0)])
        self.assertIn("not saturated by this test", v)

    def test_slow_health_is_called_out_separately(self):
        # Cheap requests queued behind expensive ones is its own diagnosis:
        # it means the expensive work is starving everything else, which a
        # look at the work-latency alone would miss.
        v = verdict([load(8, 4000.0), load(64, 9000.0, health_p95=2500.0)])
        self.assertIn("health check degraded", v)

    def test_no_division_by_zero_on_an_instant_baseline(self):
        # A p95 of 0 is possible for a trivial endpoint on a fast machine, and
        # a crash here would take down the report for a healthy server.
        v = verdict([load(1, 0.0), load(64, 100.0)])
        self.assertTrue(v.strip())


class TestScenarios(unittest.TestCase):

    def test_every_scenario_has_a_size_guard(self):
        # Without a minimum size, a 404 body or an empty JSON array is recorded
        # as the fastest endpoint in the suite, and the report reads as a
        # performance win. This is the guard that stops a broken server
        # looking like a fast one.
        for s in dtbench.SCENARIOS:
            self.assertGreater(
                s.min_bytes, 0,
                f"{s.name} would accept an empty response as a fast one")

    def test_scenario_names_are_unique(self):
        # They key the history comparison; a duplicate would silently merge two
        # different measurements into one trend line.
        names = [s.name for s in dtbench.SCENARIOS]
        self.assertEqual(len(names), len(set(names)))

    def test_api_paths_use_the_real_prefix(self):
        # These were written as /api/v1/ from the project convention and every
        # one of them 404'd against the actual server, which uses /api.
        for s in dtbench.SCENARIOS:
            self.assertNotIn("/api/v1/", s.path,
                             f"{s.name} uses a prefix this server does not serve")


if __name__ == "__main__":
    unittest.main(verbosity=2)
