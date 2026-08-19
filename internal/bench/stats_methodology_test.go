package bench

import (
	"math"
	"testing"
)

// These tests encode the reasons the statistics exist. The previous method —
// dividing two medians and checking for a ten percent difference — named a
// 0.03 ms change as the biggest win in a thirteen-scenario comparison. Each
// test below is one of the ways that happened.

func seq(base, step float64, n int) []float64 {
	out := make([]float64, n)
	for i := range out {
		out[i] = base + step*float64(i)
	}
	return out
}

func TestMannWhitneyRefusesSamplesTooSmallToMeanAnything(t *testing.T) {
	// The heavy scenarios run three samples by design. Answering with a
	// confident p-value there would be worse than declining.
	if _, ok := mannWhitney(seq(1, 0.1, 3), seq(2, 0.1, 3)); ok {
		t.Fatal("the test ran on three samples a side; at that size it has no power and should refuse")
	}
	if _, ok := mannWhitney(seq(1, 0.1, 20), seq(2, 0.1, 20)); !ok {
		t.Fatal("the test refused twenty samples a side, which it should accept")
	}
}

func TestMannWhitneyDetectsAClearSeparation(t *testing.T) {
	p, ok := mannWhitney(seq(10, 0.1, 20), seq(20, 0.1, 20))
	if !ok {
		t.Fatal("test declined to run")
	}
	if p > 0.001 {
		t.Fatalf("two entirely separated samples gave p=%v; a real change must be detectable", p)
	}
}

func TestMannWhitneyDoesNotSeparateOverlappingNoise(t *testing.T) {
	// Two runs of the same thing. This is the shape of every sub-millisecond
	// "verdict" the old method produced.
	a := []float64{0.07, 0.08, 0.07, 0.09, 0.08, 0.07, 0.10, 0.08, 0.07, 0.09,
		0.08, 0.07, 0.08, 0.09, 0.07, 0.08, 0.08, 0.07, 0.09, 0.08}
	b := []float64{0.08, 0.07, 0.09, 0.08, 0.07, 0.08, 0.09, 0.07, 0.08, 0.08,
		0.09, 0.07, 0.08, 0.07, 0.09, 0.08, 0.07, 0.08, 0.08, 0.09}
	p, ok := mannWhitney(a, b)
	if !ok {
		t.Fatal("test declined to run")
	}
	if p < 0.05 {
		t.Fatalf("noise was called significant at p=%v", p)
	}
}

func TestMannWhitneyHandlesTiesWithoutBlowingUp(t *testing.T) {
	// Timings quantise, so ties are common; an uncorrected variance would
	// overstate significance.
	a := make([]float64, 20)
	b := make([]float64, 20)
	for i := range a {
		a[i], b[i] = 1, 1
	}
	p, ok := mannWhitney(a, b)
	if !ok || p < 0.99 {
		t.Fatalf("identical samples should be maximally unremarkable, got p=%v ok=%v", p, ok)
	}
}

func TestHolmCorrectsForAskingTheQuestionManyTimes(t *testing.T) {
	// Fifteen scenarios each at p<0.05 gives roughly a coin flip on at least
	// one false positive. A single borderline result must not survive.
	tests := make([]*TestResult, 15)
	for i := range tests {
		tests[i] = &TestResult{Possible: true, P: 0.5}
	}
	tests[0].P = 0.04 // would be "significant" uncorrected
	holmAdjust(tests)
	if tests[0].Significant {
		t.Fatalf("a p=0.04 among fifteen tests was called significant (adjusted %v); that is how a report "+
			"acquires a 'biggest win' that is not there", tests[0].AdjustedP)
	}

	tests[0].P = 0.0001
	holmAdjust(tests)
	if !tests[0].Significant {
		t.Fatalf("a genuinely strong result was suppressed (adjusted %v)", tests[0].AdjustedP)
	}
}

func TestHolmIsMonotonic(t *testing.T) {
	tests := []*TestResult{
		{Possible: true, P: 0.001},
		{Possible: true, P: 0.002},
		{Possible: true, P: 0.30},
	}
	holmAdjust(tests)
	if tests[0].AdjustedP > tests[1].AdjustedP || tests[1].AdjustedP > tests[2].AdjustedP {
		t.Fatalf("adjusted p-values must not decrease as raw ones increase: %v", []float64{
			tests[0].AdjustedP, tests[1].AdjustedP, tests[2].AdjustedP})
	}
}

func TestHodgesLehmannEstimatesTheShift(t *testing.T) {
	a := seq(10, 0.01, 20)
	b := seq(15, 0.01, 20)
	shift, low, high := hodgesLehmann(a, b, significanceLevel)
	if math.Abs(shift-5) > 0.2 {
		t.Fatalf("shift estimate %v, expected about 5", shift)
	}
	if low > shift || high < shift {
		t.Fatalf("interval [%v, %v] does not contain the estimate %v", low, high, shift)
	}
	if low > 0 != (high > 0) {
		t.Fatalf("a clear shift should give an interval that excludes zero: [%v, %v]", low, high)
	}
}

func TestHodgesLehmannIntervalIsWideWhenTheDataAreNoisy(t *testing.T) {
	// The honest output at these sample sizes: an interval that spans zero.
	a := []float64{1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2}
	b := []float64{2, 1, 3, 2, 1, 3, 2, 1, 3, 2, 1, 3, 2, 1, 3, 2, 1, 3, 2, 1}
	_, low, high := hodgesLehmann(a, b, significanceLevel)
	if low > 0 || high < 0 {
		t.Fatalf("noisy data produced an interval excluding zero: [%v, %v]", low, high)
	}
}

func TestPracticalFloorIsAboveTheObservedSubMillisecondScatter(t *testing.T) {
	// Measured on this machine: a single scenario's samples within one run
	// ranged 0.07 to 0.44 ms, and two runs minutes apart moved a median from
	// 0.07 to 0.09 ms. The floor has to sit above that or it does nothing.
	const observedScatterMs = 0.44
	if PracticalFloorMs < observedScatterMs {
		t.Fatalf("the practical floor of %v ms is below the %v ms scatter actually observed, so differences "+
			"smaller than the measurement noise would still be reported as verdicts",
			PracticalFloorMs, observedScatterMs)
	}
}
