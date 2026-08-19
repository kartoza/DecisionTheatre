package bench

import (
	"math"
	"strings"
	"testing"
)

// measured builds a scenario result with an exact median, so a test can sit on
// the noise floor to the millisecond rather than hoping a generated sample set
// lands where it needs to. Min and Max are set wide of the median by default so
// the overlap check does not fire unless a test asks for it.
func measured(name string, p50 float64) ScenarioResult {
	return ScenarioResult{
		Name:  name,
		Group: "Test",
		Why:   "under test",
		URL:   "http://127.0.0.1:8080/" + name,
		TotalMs: Stats{
			N: 20, Min: p50, P50: p50, P90: p50, P99: p50, Max: p50, Mean: p50,
		},
		Samples:      20,
		StatusCounts: map[int]int{200: 20},
		BytesMax:     1024,
		BytesMin:     1024,
	}
}

// spread widens a result's observed range, for the tests about overlapping
// distributions.
func spread(s ScenarioResult, min, max float64) ScenarioResult {
	s.TotalMs.Min = min
	s.TotalMs.Max = max
	return s
}

// runOf wraps results in a run with the provenance fields matched, so a test
// about verdicts is not distracted by warnings about mismatched targets.
func runOf(results ...ScenarioResult) Run {
	return Run{
		SchemaVersion: ResultsVersion,
		Target:        "http://127.0.0.1:8080",
		TargetKind:    "local",
		Host:          "workstation",
		Iterations:    20,
		Warmup:        3,
		Scenarios:     results,
	}
}

func onlyDelta(t *testing.T, c Comparison) Delta {
	t.Helper()
	if len(c.Deltas) != 1 {
		t.Fatalf("got %d deltas, want 1: %+v", len(c.Deltas), c.Deltas)
	}
	return c.Deltas[0]
}

// ---------------------------------------------------------------------------
// The noise floor

// Exactly at the noise floor a change is a verdict, not noise. Guards against
// the boundary being tested with <= on one side and < on the other, which would
// make the tool's own documented threshold wrong by one case.
func TestAChangeExactlyAtTheNoiseFloorIsAVerdictRatherThanNoise(t *testing.T) {
	slower := onlyDelta(t, Compare(runOf(measured("a", 100)), runOf(measured("a", 110))))
	if slower.Verdict != Slower {
		t.Errorf("a +10.0%% change is %q, want %q: the floor is the threshold, not the first unchanged value",
			slower.Verdict, Slower)
	}

	faster := onlyDelta(t, Compare(runOf(measured("a", 100)), runOf(measured("a", 90))))
	if faster.Verdict != Faster {
		t.Errorf("a -10.0%% change is %q, want %q", faster.Verdict, Faster)
	}
}

// Just inside the noise floor is unchanged in both directions. Guards against
// the tool reporting a 9% "improvement" as a win, which is how a benchmark suite
// loses its credibility the first time a rerun contradicts it.
func TestAChangeJustInsideTheNoiseFloorIsUnchangedInBothDirections(t *testing.T) {
	for _, c := range []struct {
		name       string
		base, curr float64
	}{
		{"slightly slower", 100, 109.9},
		{"slightly faster", 100, 90.1},
		{"identical", 100, 100},
	} {
		t.Run(c.name, func(t *testing.T) {
			d := onlyDelta(t, Compare(runOf(measured("a", c.base)), runOf(measured("a", c.curr))))
			if d.Verdict != Unchanged {
				t.Errorf("%.1f ms against %.1f ms is %q, want %q (%.3f relative)",
					c.base, c.curr, d.Verdict, Unchanged, d.RelativeChange)
			}
		})
	}
}

// The noise floor must stay blunt. Guards against somebody tightening it to look
// more scientific: at sample counts in the tens on a working machine, a tighter
// threshold produces confident verdicts a rerun contradicts.
func TestTheNoiseFloorIsDeliberatelyBlunt(t *testing.T) {
	if NoiseFloor < 0.05 {
		t.Errorf("NoiseFloor = %v, tighter than these measurements can support", NoiseFloor)
	}
	if NoiseFloor > 0.25 {
		t.Errorf("NoiseFloor = %v, so loose that real regressions go unreported", NoiseFloor)
	}
}

// The relative change and the millisecond change must agree in sign and
// magnitude. Guards against a report showing "-40%" next to "+30 ms".
func TestTheRelativeAndAbsoluteChangesAgree(t *testing.T) {
	d := onlyDelta(t, Compare(runOf(measured("a", 200)), runOf(measured("a", 50))))

	closeTo(t, "RelativeChange", d.RelativeChange, -0.75)
	closeTo(t, "AbsoluteChangeMs", d.AbsoluteChangeMs(), -150)
	closeTo(t, "Speedup", d.Speedup(), 4)
}

// Speedup must refuse to divide by zero rather than returning an infinity that
// renders as "+Inf× faster".
func TestSpeedupRefusesToDivideByZero(t *testing.T) {
	for _, d := range []Delta{
		{Baseline: measured("a", 0), Current: measured("a", 10)},
		{Baseline: measured("a", 10), Current: measured("a", 0)},
		{},
	} {
		got := d.Speedup()
		if got != 0 {
			t.Errorf("Speedup() = %v, want 0 when it cannot be computed", got)
		}
		if math.IsInf(got, 0) || math.IsNaN(got) {
			t.Errorf("Speedup() = %v, which would render as Inf or NaN", got)
		}
	}
}

// ---------------------------------------------------------------------------
// Broken, added, removed

// The central rule again, at the comparison layer and without a server: a
// current run with no successful samples is broken, whatever its timings say.
func TestACurrentRunWithNoSuccessfulSamplesIsBrokenAndNotFaster(t *testing.T) {
	failed := measured("a", 0)
	failed.Samples = 0
	failed.Errors = 20
	failed.TotalMs = Stats{}
	failed.StatusCounts = map[int]int{404: 20}

	c := Compare(runOf(measured("a", 500)), runOf(failed))
	d := onlyDelta(t, c)

	if d.Verdict != Broken {
		t.Errorf("verdict = %q, want %q", d.Verdict, Broken)
	}
	if !strings.Contains(d.Caveat, "failed") {
		t.Errorf("caveat = %q, want it to say the requests failed", d.Caveat)
	}
	if h := c.Summarise(); h.Faster != 0 || h.BiggestWin != nil {
		t.Errorf("a total failure was counted as an improvement: %+v", h)
	}
}

// Even one failure in an otherwise healthy current run stops the scenario being
// reported as a timing result. Guards against a 5%-failing endpoint being quoted
// as faster because the requests that failed were the slow ones.
func TestAPartlyFailingCurrentRunIsBrokenRatherThanTimed(t *testing.T) {
	partial := measured("a", 50)
	partial.Samples = 19
	partial.Errors = 1

	d := onlyDelta(t, Compare(runOf(measured("a", 500)), runOf(partial)))

	if d.Verdict != Broken {
		t.Errorf("verdict = %q, want %q: one in twenty requests failed", d.Verdict, Broken)
	}
	if !strings.Contains(d.Caveat, "1 of 20") {
		t.Errorf("caveat = %q, want it to quantify the failures", d.Caveat)
	}
}

// A baseline that never worked is not a comparison. Guards against a first
// working result being announced as an infinite improvement.
func TestABaselineWithNoSamplesMakesTheCurrentRunAFirstResultNotAWin(t *testing.T) {
	empty := measured("a", 0)
	empty.Samples = 0
	empty.Errors = 20
	empty.TotalMs = Stats{}

	c := Compare(runOf(empty), runOf(measured("a", 40)))
	d := onlyDelta(t, c)

	if d.Verdict != Added {
		t.Errorf("verdict = %q, want %q", d.Verdict, Added)
	}
	if !strings.Contains(d.Caveat, "baseline") {
		t.Errorf("caveat = %q, want it to explain the missing baseline", d.Caveat)
	}
	if h := c.Summarise(); h.Faster != 0 || h.BiggestWin != nil {
		t.Errorf("a first result was counted as a win: %+v", h)
	}
}

// Both runs failing is broken, not unchanged. Guards against an endpoint that
// has been dead for a month quietly reporting "no change" every time.
func TestBothRunsFailingIsBrokenRatherThanUnchanged(t *testing.T) {
	dead := measured("a", 0)
	dead.Samples = 0
	dead.Errors = 20
	dead.TotalMs = Stats{}

	d := onlyDelta(t, Compare(runOf(dead), runOf(dead)))

	if d.Verdict != Broken {
		t.Errorf("verdict = %q, want %q", d.Verdict, Broken)
	}
	if !strings.Contains(d.Caveat, "either run") {
		t.Errorf("caveat = %q, want it to say neither run worked", d.Caveat)
	}
}

// A recovered scenario — broken in the baseline, healthy now — must not be a
// timing comparison against numbers that were never valid.
func TestAScenarioThatRecoveredIsNotComparedAgainstItsBrokenBaseline(t *testing.T) {
	wasBroken := measured("a", 3)
	wasBroken.Errors = 20
	wasBroken.Samples = 0
	wasBroken.TotalMs = Stats{}

	d := onlyDelta(t, Compare(runOf(wasBroken), runOf(measured("a", 300))))

	if d.Verdict == Slower {
		t.Errorf("verdict = %q: the scenario was not working before, so it did not get slower", d.Verdict)
	}
}

// A skipped scenario has nothing to compare and must say so rather than being
// reported as a change from or to zero.
func TestASkippedScenarioIsExplainedRatherThanComparedAgainstZero(t *testing.T) {
	skipped := ScenarioResult{
		Name: "heavy", Group: "Statistics",
		Skipped: true, SkippedReason: "heavy scenario; run with --heavy to include it",
	}

	for _, c := range []struct {
		name       string
		base, curr ScenarioResult
	}{
		{"skipped in the current run", measured("heavy", 4000), skipped},
		{"skipped in the baseline", skipped, measured("heavy", 4000)},
		{"skipped in both", skipped, skipped},
	} {
		t.Run(c.name, func(t *testing.T) {
			d := onlyDelta(t, Compare(runOf(c.base), runOf(c.curr)))
			if d.Verdict != Unchanged {
				t.Errorf("verdict = %q, want %q", d.Verdict, Unchanged)
			}
			if !strings.Contains(d.Caveat, "Skipped") {
				t.Errorf("caveat = %q, want it to say the scenario was skipped", d.Caveat)
			}
			if d.RelativeChange != 0 {
				t.Errorf("RelativeChange = %v for a skipped scenario", d.RelativeChange)
			}
		})
	}
}

// Scenarios present on only one side must be labelled, not silently dropped.
// Guards against a report that looks complete while omitting the scenario the
// reader came to see.
func TestScenariosPresentInOnlyOneRunAreLabelledNotDropped(t *testing.T) {
	base := runOf(measured("kept", 10), measured("gone", 20))
	cur := runOf(measured("kept", 10), measured("new", 30))

	c := Compare(base, cur)
	if len(c.Deltas) != 3 {
		t.Fatalf("got %d deltas, want 3 (kept, gone, new): %+v", len(c.Deltas), c.Deltas)
	}

	byName := map[string]Delta{}
	for _, d := range c.Deltas {
		byName[d.Name] = d
	}
	if byName["new"].Verdict != Added {
		t.Errorf("new scenario verdict = %q, want %q", byName["new"].Verdict, Added)
	}
	if byName["gone"].Verdict != Removed {
		t.Errorf("removed scenario verdict = %q, want %q", byName["gone"].Verdict, Removed)
	}
	if byName["kept"].Verdict != Unchanged {
		t.Errorf("unchanged scenario verdict = %q", byName["kept"].Verdict)
	}

	h := c.Summarise()
	if h.Added != 1 || h.Removed != 1 {
		t.Errorf("Added/Removed = %d/%d, want 1/1", h.Added, h.Removed)
	}
	// Neither counts as a measured change: the suite changed, the software did not.
	if h.Faster != 0 || h.Slower != 0 {
		t.Errorf("a suite change was counted as a performance change: %+v", h)
	}
}

// Two runs with no scenarios in common at all is a real possibility after the
// suite is renamed. It must produce a report that says so rather than an empty
// one that reads as "nothing changed".
func TestTwoRunsWithNoScenariosInCommonReportEverythingAsAddedOrRemoved(t *testing.T) {
	c := Compare(runOf(measured("old-a", 10), measured("old-b", 20)),
		runOf(measured("new-a", 30), measured("new-b", 40)))

	if len(c.Deltas) != 4 {
		t.Fatalf("got %d deltas, want 4", len(c.Deltas))
	}
	h := c.Summarise()
	if h.Added != 2 || h.Removed != 2 {
		t.Errorf("Added/Removed = %d/%d, want 2/2", h.Added, h.Removed)
	}
	if h.Faster+h.Slower+h.Unchanged != 0 {
		t.Errorf("scenarios with no counterpart were counted as measured: %+v", h)
	}
	if h.BiggestWin != nil || h.BiggestRegression != nil {
		t.Error("a comparison with nothing in common named a win or a regression")
	}
}

// Two empty runs must produce an empty comparison rather than a panic. Guards
// against `dtbench report` crashing on a pair of interrupted runs.
func TestTwoEmptyRunsCompareWithoutPanicking(t *testing.T) {
	c := Compare(Run{}, Run{})

	if len(c.Deltas) != 0 {
		t.Errorf("got %d deltas from two empty runs", len(c.Deltas))
	}
	h := c.Summarise()
	if h != (Headline{}) {
		t.Errorf("Summarise of an empty comparison = %+v, want the zero value", h)
	}
	if got := h.Describe(); !strings.Contains(got, "0 faster") {
		t.Errorf("Describe() = %q, want it to state the empty result plainly", got)
	}
}

// A run with zero scenarios against a healthy one must report every scenario as
// removed rather than as a suite-wide regression.
func TestARunWithZeroScenariosReportsTheOtherRunsScenariosAsRemoved(t *testing.T) {
	c := Compare(runOf(measured("a", 10), measured("b", 20)), runOf())

	if len(c.Deltas) != 2 {
		t.Fatalf("got %d deltas, want 2", len(c.Deltas))
	}
	for _, d := range c.Deltas {
		if d.Verdict != Removed {
			t.Errorf("scenario %s verdict = %q, want %q", d.Name, d.Verdict, Removed)
		}
	}
}

// ---------------------------------------------------------------------------
// Caveats

// A verdict resting on distributions that overlap must say so. Guards against a
// "40% faster" headline that rests on one fast sample.
func TestAVerdictRestingOnOverlappingSpreadsCarriesACaveat(t *testing.T) {
	base := spread(measured("a", 100), 10, 400)
	cur := spread(measured("a", 60), 10, 400)

	d := onlyDelta(t, Compare(runOf(base), runOf(cur)))

	if d.Verdict != Faster {
		t.Fatalf("verdict = %q, want %q", d.Verdict, Faster)
	}
	if !strings.Contains(d.Caveat, "overlap") {
		t.Errorf("caveat = %q, want it to warn that the spreads overlap", d.Caveat)
	}
}

// Cleanly separated distributions must not be hedged. Guards against a caveat on
// every row, which trains a reader to ignore all of them.
func TestACleanlySeparatedVerdictIsNotHedged(t *testing.T) {
	base := spread(measured("a", 400), 380, 420)
	cur := spread(measured("a", 40), 35, 45)

	d := onlyDelta(t, Compare(runOf(base), runOf(cur)))

	if d.Verdict != Faster {
		t.Fatalf("verdict = %q, want %q", d.Verdict, Faster)
	}
	if d.Caveat != "" {
		t.Errorf("caveat = %q, want none: the distributions do not overlap", d.Caveat)
	}
}

// A payload that changed size without a change in time is worth surfacing: it
// usually means a change that has not yet become a user-visible win, and a
// reader who is not told will conclude the work did nothing.
func TestAPayloadThatChangedSizeWithoutChangingTimeIsSurfaced(t *testing.T) {
	base := measured("a", 100)
	base.BytesMax = 1000
	cur := measured("a", 102)
	cur.BytesMax = 400

	d := onlyDelta(t, Compare(runOf(base), runOf(cur)))

	if d.Verdict != Unchanged {
		t.Fatalf("verdict = %q, want %q", d.Verdict, Unchanged)
	}
	closeTo(t, "BytesChange", d.BytesChange, -0.6)
	if !strings.Contains(d.Caveat, "Response size") {
		t.Errorf("caveat = %q, want it to mention the size change", d.Caveat)
	}
}

// ---------------------------------------------------------------------------
// Warnings

// Comparing a local run with a remote one must warn: network latency to a remote
// host is a floor under every number, and the two are not the same measurement.
func TestComparingLocalWithRemoteWarnsThatTheNumbersAreNotComparable(t *testing.T) {
	base := runOf(measured("a", 10))
	cur := runOf(measured("a", 200))
	cur.TargetKind = "remote"
	cur.Target = "https://dt.kartoza.com"

	c := Compare(base, cur)

	if !anyContains(c.Warnings, "different kinds of target") {
		t.Errorf("warnings = %v, want one about local against remote", c.Warnings)
	}
}

// Two different hosts of the same kind must warn too, without repeating the
// local-against-remote wording.
func TestComparingTwoDifferentTargetsOfTheSameKindWarns(t *testing.T) {
	base := runOf(measured("a", 10))
	cur := runOf(measured("a", 10))
	cur.Target = "http://localhost:9000"

	c := Compare(base, cur)

	if !anyContains(c.Warnings, "Different targets") {
		t.Errorf("warnings = %v, want one naming both targets", c.Warnings)
	}
	if anyContains(c.Warnings, "different kinds of target") {
		t.Errorf("warnings = %v, want no kind warning when both are local", c.Warnings)
	}
}

// The machine generating the load bounds the result as much as the server does,
// so a comparison across machines must be flagged.
func TestComparingRunsFromDifferentMachinesWarns(t *testing.T) {
	base := runOf(measured("a", 10))
	cur := runOf(measured("a", 10))
	cur.Host = "ci-runner"

	c := Compare(base, cur)

	if !anyContains(c.Warnings, "different machines") {
		t.Errorf("warnings = %v, want one about the load being generated elsewhere", c.Warnings)
	}
}

// A missing host must not produce a warning about a machine nobody named.
// Guards against a warning that says "generated on  against workstation".
func TestAMissingHostDoesNotProduceAWarningAboutAnEmptyMachine(t *testing.T) {
	base := runOf(measured("a", 10))
	base.Host = ""
	cur := runOf(measured("a", 10))

	c := Compare(base, cur)

	if anyContains(c.Warnings, "different machines") {
		t.Errorf("warnings = %v, want none: one run simply did not record a host", c.Warnings)
	}
}

// A p99 over five samples is not the same statistic as one over two hundred, so
// mismatched sample counts must be flagged next to the numbers.
func TestComparingRunsWithDifferentSampleCountsWarns(t *testing.T) {
	base := runOf(measured("a", 10))
	cur := runOf(measured("a", 10))
	cur.Iterations = 200

	c := Compare(base, cur)

	if !anyContains(c.Warnings, "Different sample counts") {
		t.Errorf("warnings = %v, want one about the sample counts", c.Warnings)
	}
}

// Two comparable runs must produce no warnings at all. Guards against warnings
// that always appear and therefore say nothing.
func TestTwoComparableRunsProduceNoWarnings(t *testing.T) {
	c := Compare(runOf(measured("a", 10)), runOf(measured("a", 11)))

	if len(c.Warnings) != 0 {
		t.Errorf("warnings = %v, want none for two runs of the same target from the same machine", c.Warnings)
	}
}

// ---------------------------------------------------------------------------
// Ordering and the headline

// Deltas must be grouped and then alphabetical, so two reports of the same suite
// can be read side by side.
func TestDeltasAreOrderedByGroupThenName(t *testing.T) {
	a := measured("zebra", 10)
	a.Group = "Baseline"
	b := measured("alpha", 10)
	b.Group = "Tiles"
	d := measured("beta", 10)
	d.Group = "Baseline"

	c := Compare(runOf(a, b, d), runOf(a, b, d))

	var got []string
	for _, delta := range c.Deltas {
		got = append(got, delta.Group+"/"+delta.Name)
	}
	want := []string{"Baseline/beta", "Baseline/zebra", "Tiles/alpha"}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("delta order = %v, want %v", got, want)
			break
		}
	}
}

// The headline must name the extremes, not the first thing it found. Guards
// against a report leading with a 12% win while a 90% regression sits below it.
func TestTheHeadlineNamesTheLargestChangeInEachDirection(t *testing.T) {
	base := runOf(measured("small-win", 100), measured("big-win", 1000),
		measured("small-loss", 100), measured("big-loss", 100))
	cur := runOf(measured("small-win", 80), measured("big-win", 100),
		measured("small-loss", 120), measured("big-loss", 900))

	h := Compare(base, cur).Summarise()

	if h.Faster != 2 || h.Slower != 2 {
		t.Errorf("Faster/Slower = %d/%d, want 2/2", h.Faster, h.Slower)
	}
	if h.BiggestWin == nil || h.BiggestWin.Name != "big-win" {
		t.Errorf("BiggestWin = %v, want big-win", h.BiggestWin)
	}
	if h.BiggestRegression == nil || h.BiggestRegression.Name != "big-loss" {
		t.Errorf("BiggestRegression = %v, want big-loss", h.BiggestRegression)
	}
}

// The command-line summary must lead with breakage in capitals when something
// broke, because that is the line most readers will paste into a pull request.
func TestTheCommandLineSummaryShoutsAboutBreakage(t *testing.T) {
	broken := measured("a", 0)
	broken.Samples = 0
	broken.Errors = 20
	broken.TotalMs = Stats{}

	got := Compare(runOf(measured("a", 100)), runOf(broken)).Summarise().Describe()

	if !strings.Contains(got, "BROKEN") {
		t.Errorf("Describe() = %q, want it to shout about the broken scenario", got)
	}
}

// A clean comparison must not mention breakage at all.
func TestTheCommandLineSummaryStaysQuietWhenNothingBroke(t *testing.T) {
	got := Compare(runOf(measured("a", 100)), runOf(measured("a", 50))).Summarise().Describe()

	if strings.Contains(got, "BROKEN") {
		t.Errorf("Describe() = %q, want no mention of breakage", got)
	}
	if !strings.Contains(got, "biggest win") {
		t.Errorf("Describe() = %q, want it to name the win", got)
	}
}

// The suite's total payload is the closest thing to "what a page load costs", so
// it must add up the whole suite rather than the compared subset.
func TestTheHeadlineTotalsThePayloadOfTheWholeSuite(t *testing.T) {
	a := measured("a", 10)
	a.BytesMax = 1000
	b := measured("b", 10)
	b.BytesMax = 2000
	after := measured("a", 10)
	after.BytesMax = 500
	alsoAfter := measured("b", 10)
	alsoAfter.BytesMax = 2000

	h := Compare(runOf(a, b), runOf(after, alsoAfter)).Summarise()

	if h.TotalBytesBaseline != 3000 {
		t.Errorf("TotalBytesBaseline = %d, want 3000", h.TotalBytesBaseline)
	}
	if h.TotalBytesCurrent != 2500 {
		t.Errorf("TotalBytesCurrent = %d, want 2500", h.TotalBytesCurrent)
	}
}

// KNOWN GAP (dtbench): when both runs are partly failing, the comparison falls
// through to a timing verdict over whichever requests happened to succeed. The
// broken check only fires when the current run has errors and the baseline has
// none. An endpoint failing 50% of the time in both runs is therefore reported
// as a clean speed comparison with no caveat at all. Recorded rather than fixed
// because the fix belongs in run.go, which the performance specialist owns; see
// NOTES-qa.md.
func TestBothRunsPartlyFailingIsCurrentlyReportedAsACleanTimingComparison(t *testing.T) {
	base := measured("a", 500)
	base.Errors = 10
	base.Samples = 10
	cur := measured("a", 100)
	cur.Errors = 10
	cur.Samples = 10

	d := onlyDelta(t, Compare(runOf(base), runOf(cur)))

	if d.Verdict != Faster {
		t.Fatalf("verdict = %q — the gap this test records has changed; if both-sides failure is now "+
			"caveated, update the assertion to match", d.Verdict)
	}
	if d.Caveat != "" {
		t.Fatalf("caveat = %q — a caveat has been added; update this test to assert it", d.Caveat)
	}
}
