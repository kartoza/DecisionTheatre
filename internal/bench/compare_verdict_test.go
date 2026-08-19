package bench

import "testing"

// Regression tests built from the comparison that prompted this work: the
// 14 August baseline against 19 August main, n=12, both local, same machine,
// same datapack. The old method's headline was
//
//	3 faster, 7 slower, 4 unchanged
//	biggest win:        tile-z5 (-27%)
//	biggest regression: catchment-values-viewport (+361%)
//
// Both named results were artefacts. These tests assert they no longer appear.

// scatter builds n samples clustered around mid with the given half-width, in
// the interleaved way real timings arrive.
func scatter(mid, halfWidth float64, n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		frac := float64(i%5)/4*2 - 1 // -1 .. +1
		out[i] = mid + frac*halfWidth
	}
	return out
}

func result(name string, p50 float64, samples []float64, bytes int64) ScenarioResult {
	r := ScenarioResult{
		Name:      name,
		Group:     "g",
		Samples:   len(samples),
		SamplesMs: samples,
		BytesMin:  bytes,
		BytesMax:  bytes,
	}
	r.TotalMs = Summarise(samples)
	if p50 > 0 {
		r.TotalMs.P50 = p50
	}
	return r
}

func runWith(results ...ScenarioResult) Run {
	return Run{SchemaVersion: ResultsVersion, Settled: true, Iterations: 20, TargetKind: "local", Scenarios: results}
}

func findDelta(t *testing.T, c Comparison, name string) Delta {
	t.Helper()
	for _, d := range c.Deltas {
		if d.Name == name {
			return d
		}
	}
	t.Fatalf("no delta named %q", name)
	return Delta{}
}

func TestThirtyMicrosecondsIsNotTheBiggestWin(t *testing.T) {
	// tile-z5: 0.11 ms to 0.08 ms. Reported by the old method as the single
	// biggest improvement in the whole comparison.
	base := runWith(result("tile-z5", 0.11, scatter(0.11, 0.03, 20), 7529))
	cur := runWith(result("tile-z5", 0.08, scatter(0.08, 0.03, 20), 7529))

	d := findDelta(t, Compare(base, cur), "tile-z5")
	if d.Verdict != Unchanged {
		t.Fatalf("a 0.03 ms difference was called %q; this harness cannot resolve that and must say so",
			d.Verdict)
	}
	if d.Caveat == "" {
		t.Fatal("an unchanged verdict on a difference below the resolution floor must explain itself")
	}
}

func TestSubMillisecondNoiseAcrossTheSuiteProducesNoVerdicts(t *testing.T) {
	// The five cheap scenarios from the real comparison, all of which moved by
	// hundredths of a millisecond and all of which were given verdicts.
	cases := []struct {
		name       string
		before     float64
		after      float64
		payload    int64
		oldVerdict string
	}{
		{"health", 0.07, 0.09, 16, "+38%"},
		{"info", 0.06, 0.08, 201, "+40%"},
		{"metadata-colors", 0.06, 0.07, 930, "+20%"},
		{"scenarios", 0.07, 0.10, 24, "+44%"},
		{"tile-z8", 0.13, 0.10, 36158, "-20%"},
	}
	var b, c []ScenarioResult
	for _, x := range cases {
		b = append(b, result(x.name, x.before, scatter(x.before, 0.02, 20), x.payload))
		c = append(c, result(x.name, x.after, scatter(x.after, 0.02, 20), x.payload))
	}

	cmp := Compare(runWith(b...), runWith(c...))
	for _, x := range cases {
		if d := findDelta(t, cmp, x.name); d.Verdict != Unchanged {
			t.Errorf("%s moved by %.2f ms and was called %q (old method said %s)",
				x.name, x.after-x.before, d.Verdict, x.oldVerdict)
		}
	}
	if h := cmp.Summarise(); h.Faster != 0 || h.Slower != 0 {
		t.Fatalf("five scenarios of pure noise produced %d faster and %d slower", h.Faster, h.Slower)
	}
}

func TestAnEndpointThatDidNotExistIsAddedNotARegression(t *testing.T) {
	// catchment-values-viewport: absent on 14 August, where the SPA fallback
	// answered 200 with a 16-byte HTML page in 0.11 ms. The old method called
	// it a 361% regression caused by the work that introduced it.
	before := ScenarioResult{Name: "catchment-values-viewport", Group: "g",
		Absent: true, AbsentReason: "the server answered 200 with an HTML page rather than application/json"}
	after := result("catchment-values-viewport", 0.50, scatter(0.50, 0.1, 20), 725)

	d := findDelta(t, Compare(runWith(before), runWith(after)), "catchment-values-viewport")
	if d.Verdict != Added {
		t.Fatalf("an endpoint absent from the baseline was reported as %q, not added", d.Verdict)
	}
	if d.Verdict == Slower {
		t.Fatal("the work that introduced an endpoint was blamed for making it slower")
	}
}

func TestLosingACapabilityIsReportedAsBroken(t *testing.T) {
	before := result("x", 5, scatter(5, 0.2, 20), 900)
	after := ScenarioResult{Name: "x", Group: "g", Absent: true, AbsentReason: "route removed"}
	if d := findDelta(t, Compare(runWith(before), runWith(after)), "x"); d.Verdict != Broken {
		t.Fatalf("a capability present on the baseline and gone now was reported as %q", d.Verdict)
	}
}

func TestPayloadWinIsSurfacedWhenTimingDoesNotMove(t *testing.T) {
	// The genuine finding in the real data: choropleth-viewport went from
	// 179.2 KB to 36.6 KB while the timings stayed inside the noise. A report
	// that only speaks about time would call that week a wash.
	base := runWith(result("choropleth-viewport", 16.0, scatter(16.0, 1.5, 20), 183548))
	cur := runWith(result("choropleth-viewport", 15.5, scatter(15.5, 1.5, 20), 37483))

	d := findDelta(t, Compare(base, cur), "choropleth-viewport")
	if d.BytesVerdict != BytesSmaller {
		t.Fatalf("a five-fold payload reduction was recorded as %q", d.BytesVerdict)
	}
	if d.Caveat == "" {
		t.Fatal("a large payload win alongside an unmoved timing must be stated, not left in a column")
	}
}

func TestGenuineLargeImprovementIsStillReported(t *testing.T) {
	// The gates must not be so conservative that a real win disappears.
	base := runWith(result("choropleth-domain-aggregated", 4400, scatter(4400, 120, 20), 5500000))
	cur := runWith(result("choropleth-domain-aggregated", 1700, scatter(1700, 90, 20), 1700000))

	d := findDelta(t, Compare(base, cur), "choropleth-domain-aggregated")
	if d.Verdict != Faster {
		t.Fatalf("a 2.6x improvement was reported as %q", d.Verdict)
	}
	if !d.Test.Significant {
		t.Fatal("a clear separation should survive the correction")
	}
	if d.SignificanceNote() == "" {
		t.Fatal("a reported win should carry the evidence for it")
	}
}

func TestUnsettledRunsCarryAWarning(t *testing.T) {
	base := runWith(result("x", 5, scatter(5, 0.2, 20), 900))
	base.Settled = false
	cur := runWith(result("x", 5, scatter(5, 0.2, 20), 900))

	c := Compare(base, cur)
	found := false
	for _, w := range c.Warnings {
		if len(w) > 0 && contains(w, "finished starting up") {
			found = true
		}
	}
	if !found {
		t.Fatal("a comparison involving a run that never settled must say so: the startup penalty on the " +
			"expensive query is 2.4x and would otherwise read as a code change")
	}
}

func TestSchemaOneBaselineFallsBackAndSaysSo(t *testing.T) {
	base := runWith(result("x", 5, nil, 900))
	base.SchemaVersion = 1
	base.Scenarios[0].Samples = 20
	base.Scenarios[0].TotalMs = Stats{N: 20, Min: 4.8, P50: 5, P90: 5.2, P99: 5.4, Max: 5.5}
	cur := runWith(result("x", 9, scatter(9, 0.2, 20), 900))

	c := Compare(base, cur)
	found := false
	for _, w := range c.Warnings {
		if contains(w, "raw samples") {
			found = true
		}
	}
	if !found {
		t.Fatal("a comparison against a pre-samples result must disclose that no significance test was possible")
	}
	if d := findDelta(t, c, "x"); d.Test.Possible {
		t.Fatal("a test was claimed against a baseline with no raw samples")
	}
}

func contains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
