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
import dtbench_pdf as dtpdf  # noqa: E402


def load(concurrency, p95, errors=0, health_p95=5.0, health_errors=0, rps=1.0):
    """One row of the load table, as sqlite3.Row would give it."""
    return {
        "concurrency": concurrency, "p95": p95, "errors": errors,
        "health_p95": health_p95, "health_errors": health_errors, "rps": rps,
    }


def verdict(loads):
    out = io.StringIO()
    with redirect_stdout(out):
        dtbench.print_verdict(loads)
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

    def test_sublinear_growth_is_not_called_queueing(self):
        # 8x the clients, 2.5x the latency. That is the server absorbing load
        # with real parallelism, not queueing behind it. The third bug was
        # classifying this correctly and then opening the sentence with
        # "load did not make it worse", which contradicted its own number.
        v = verdict([load(4, 6612.0), load(32, 16402.0)])
        self.assertIn("absorbed the load", v)
        self.assertNotIn("did not make it worse", v)
        self.assertNotIn("queued instead", v)

    def test_growth_without_refusals_does_not_claim_there_is_no_ceiling(self):
        # Nothing refused means the ceiling was not reached. That is a
        # different statement from "there is no ceiling", and conflating them
        # would have the tool assert something it did not measure.
        v = verdict([load(4, 6612.0), load(32, 16402.0)])
        self.assertIn("found no ceiling", v)
        self.assertIn("does not show there is none", v)

    def test_proportional_growth_is_queueing_however_large_the_load_step(self):
        # The discriminator has to be latency growth relative to load growth.
        # An earlier threshold scaled with the load ratio, so a bigger load
        # step demanded a bigger latency rise to count - which let genuine
        # queueing through whenever the ramp was steep.
        v = verdict([load(2, 1000.0), load(64, 30000.0)])
        self.assertIn("queued instead of shedding", v)

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


class TestStepDetection(unittest.TestCase):
    """Finding where a measurement changed level, which is what makes the
    history bisectable."""

    def test_a_clear_step_is_found_at_the_right_point(self):
        # Four runs at ~100, four at ~400. The step is at index 4.
        series = [100, 102, 98, 101, 400, 405, 398, 402]
        step = dtbench.find_step_change(series)
        self.assertIsNotNone(step)
        i, before, after = step
        self.assertEqual(i, 4)
        self.assertAlmostEqual(before, 100.5, delta=3)
        self.assertAlmostEqual(after, 401, delta=5)

    def test_noise_is_not_a_step(self):
        # The failure that would make this useless: a tool that finds a
        # regression in every series is one nobody keeps running.
        series = [100, 104, 97, 103, 99, 101, 98, 102]
        self.assertIsNone(dtbench.find_step_change(series))

    def test_a_single_spike_is_not_a_step(self):
        # One bad run - a laptop that started a backup mid-benchmark - must not
        # invent a step. This is why the halves are compared by median.
        series = [100, 101, 99, 100, 900, 100, 101, 99]
        step = dtbench.find_step_change(series)
        self.assertIsNone(step)

    def test_too_short_a_history_reports_nothing(self):
        # With one run either side, "before" and "after" are single
        # measurements and any difference is as likely to be jitter as news.
        self.assertIsNone(dtbench.find_step_change([100, 400]))
        self.assertIsNone(dtbench.find_step_change([100, 100, 400]))

    def test_an_improvement_is_found_too(self):
        # A tool that only looks for regressions cannot tell you when the fix
        # landed, which is half of what the history is for.
        series = [400, 405, 398, 402, 100, 102, 98, 101]
        step = dtbench.find_step_change(series)
        self.assertIsNotNone(step)
        i, before, after = step
        self.assertEqual(i, 4)
        self.assertLess(after, before)

    def test_a_small_absolute_change_on_a_fast_endpoint_is_ignored(self):
        # 1.0 ms to 1.4 ms is a 40% regression and completely meaningless: it
        # is within the resolution of the thing doing the measuring.
        series = [1.0, 1.0, 1.0, 1.0, 1.4, 1.4, 1.4, 1.4]
        self.assertIsNone(dtbench.find_step_change(series))

    def test_jitter_on_a_trivial_endpoint_is_ignored(self):
        # Taken from real history: /api/health at roughly 4 ms across four runs
        # on a busy machine, then roughly 1 ms across four on an idle one. 74%
        # and 3 ms, which cleared the original thresholds and should not.
        series = [4.2, 3.9, 4.4, 4.1, 1.2, 1.1, 1.3, 1.1]
        self.assertIsNone(dtbench.find_step_change(series),
                          "sub-5ms movement on a trivial endpoint is the host, "
                          "not the handler")

    def test_a_real_regression_on_a_fast_endpoint_is_still_found(self):
        # The floor must not be so high that it hides a genuine tenfold
        # regression just because the endpoint started out quick.
        series = [2.0, 2.1, 1.9, 2.0, 20.0, 21.0, 19.5, 20.5]
        self.assertIsNotNone(dtbench.find_step_change(series))


class TestSystemicChanges(unittest.TestCase):
    """Telling a change in the code from a change in the machine.

    The first report drawn from real history announced step changes on
    /api/health, /api/info, the index page and a tile read, all at the same run
    and all in the same direction. Every one of those is a round trip with
    nothing behind it. What had changed was that the host was busy earlier, and
    a report that names a commit for that sends someone through four unrelated
    handlers looking for a cause in none of them.
    """

    def change(self, scenario, run_id, before=100.0, after=200.0):
        return dtbench.StepChange(scenario, 4, before, after, run_id,
                                  "abc123", "", "2026-01-01T00:00:00")

    def test_a_whole_suite_moving_at_once_is_flagged_as_systemic(self):
        changes = [self.change(n, run_id=7) for n in
                   ("health", "info", "index", "tile-z5")]
        dtbench.mark_systemic(changes)
        self.assertTrue(all(c.systemic for c in changes))

    def test_one_endpoint_moving_alone_is_a_real_change(self):
        changes = [self.change("choropleth-viewport", run_id=7),
                   self.change("health", run_id=2),
                   self.change("info", run_id=4)]
        dtbench.mark_systemic(changes)
        self.assertFalse(any(c.systemic for c in changes),
                         "changes at different runs are not a common cause")

    def test_opposite_directions_are_not_a_common_cause(self):
        # Two got slower and two got faster on the same run. Whatever that is,
        # it is not one thing moving everything the same way.
        changes = [self.change("a", 7, 100, 200), self.change("b", 7, 100, 200),
                   self.change("c", 7, 200, 100), self.change("d", 7, 200, 100)]
        dtbench.mark_systemic(changes)
        self.assertFalse(any(c.systemic for c in changes))

    def test_too_few_changes_to_call_it_a_pattern(self):
        changes = [self.change("a", 7), self.change("b", 7)]
        dtbench.mark_systemic(changes)
        self.assertFalse(any(c.systemic for c in changes))


class TestTargets(unittest.TestCase):
    """Pointing the tool at something other than localhost."""

    def test_localhost_in_its_various_spellings_is_recognised(self):
        # Getting this wrong in the permissive direction would let the load
        # phase loose on a remote host; in the strict direction it would refuse
        # to stress the local server, which is the tool's main job.
        for target in ("http://localhost:8080", "http://127.0.0.1:8080",
                       "http://[::1]:8080", "http://0.0.0.0:8080"):
            self.assertTrue(dtbench.is_colocated(target), target)

    def test_a_remote_host_is_not_colocated(self):
        self.assertFalse(
            dtbench.is_colocated("https://africanlandscapefutures.wits.ac.za"))

    def test_an_unresolvable_host_is_treated_as_remote(self):
        # Fail safe. Treating a name that cannot be resolved as local would put
        # the load phase behind a DNS lookup going wrong.
        self.assertFalse(dtbench.is_colocated("https://not-a-real-host.invalid"))


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


class TestPDF(unittest.TestCase):
    """The PDF writer.

    A malformed PDF does not fail loudly: most readers salvage what they can
    and show a blank page, so the failure arrives as "the report is empty"
    long after the run that produced it. These check the structure the format
    actually requires.
    """

    def render(self, build) -> bytes:
        import tempfile
        pdf = dtpdf.PDF()
        pdf.add_page()
        build(pdf)
        with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
            pdf.save(f.name)
            return Path(f.name).read_bytes()

    def test_the_file_has_the_structure_a_reader_looks_for(self):
        data = self.render(lambda p: p.text(50, 50, "hello"))
        self.assertTrue(data.startswith(b"%PDF-"))
        self.assertIn(b"/Type /Catalog", data)
        self.assertIn(b"/Type /Pages", data)
        self.assertIn(b"/Type /Page", data)
        self.assertIn(b"xref", data)
        self.assertTrue(data.rstrip().endswith(b"%%EOF"))

    def test_the_xref_offsets_point_at_their_objects(self):
        # The one part of the format that is easy to get subtly wrong and
        # impossible to notice by looking at the output: a reader that trusts
        # the table lands in the middle of an object and gives up.
        data = self.render(lambda p: p.text(50, 50, "hello"))
        start = data.index(b"\nxref\n") + 6
        lines = data[start:].split(b"\n")
        count = int(lines[0].split()[1])
        for i in range(1, count):
            offset = int(lines[i + 1].split()[0])
            self.assertEqual(data[offset:offset + len(b"%d 0 obj" % i)],
                             b"%d 0 obj" % i,
                             f"xref entry {i} does not point at object {i}")

    def test_parentheses_and_backslashes_survive(self):
        # "p95 (ms)" is an ordinary label. Unescaped, its bracket ends the
        # string literal early and the rest of the page becomes syntax.
        data = self.render(lambda p: p.text(50, 50, "p95 (ms) \\ 100%"))
        self.assertIn(b"\\(ms\\)", data)
        self.assertIn(b"\\\\", data)

    def test_characters_outside_winansi_are_transliterated_not_dropped(self):
        # An em dash silently becoming nothing changes the meaning of a
        # sentence, which is worse than rendering an approximation of it.
        data = self.render(lambda p: p.text(50, 50, "before — after"))
        self.assertIn(b"before - after", data)

    def test_every_page_is_in_the_page_tree(self):
        pdf = dtpdf.PDF()
        for i in range(3):
            pdf.add_page()
            pdf.text(50, 50, f"page {i}")
        import tempfile
        with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
            pdf.save(f.name)
            data = Path(f.name).read_bytes()
        self.assertIn(b"/Count 3", data)
        self.assertEqual(data.count(b"/Type /Page\n") + data.count(b"/Type /Page "), 3)

    def test_text_width_tracks_the_string(self):
        # Right-aligned columns of numbers depend on this. If it were a
        # constant per character, a column would not line up.
        wide = dtpdf.text_width("WWWWW", 10)
        narrow = dtpdf.text_width("iiiii", 10)
        self.assertGreater(wide, narrow * 2)

    def test_courier_is_measured_as_monospace(self):
        # The tables use Courier precisely so digits align.
        a = dtpdf.text_width("11111", 10, dtpdf.COURIER)
        b = dtpdf.text_width("88888", 10, dtpdf.COURIER)
        self.assertAlmostEqual(a, b, places=6)

    def test_axis_ceilings_are_round_numbers(self):
        # An axis labelled 4873.2 is honest and unreadable.
        self.assertEqual(dtpdf.nice_ceiling(4873.2), 5000)
        self.assertEqual(dtpdf.nice_ceiling(0.9), 1)
        self.assertEqual(dtpdf.nice_ceiling(1), 1)
        self.assertGreater(dtpdf.nice_ceiling(0), 0)

    def test_a_chart_with_no_data_does_not_crash(self):
        # A first run has nothing to plot, and that is the run somebody is
        # most likely to be watching.
        data = self.render(lambda p: dtpdf.line_chart(
            p, 40, 40, 400, 120, [], [], "empty"))
        self.assertIn(b"no data", data)

    def test_a_flat_series_does_not_divide_by_zero(self):
        data = self.render(lambda p: dtpdf.line_chart(
            p, 40, 40, 400, 120, [0.0, 0.0, 0.0], ["a", "b", "c"], "flat"))
        self.assertTrue(data.startswith(b"%PDF-"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
