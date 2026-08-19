package bench

import (
	"math"
	"sort"
)

// Statistics for samples in the tens.
//
// The previous version of this file did not exist, and the comparison it
// supported decided "faster" or "slower" by dividing two medians and checking
// whether the difference exceeded ten percent. Run against two real builds,
// that method produced this headline:
//
//	3 faster, 7 slower, 4 unchanged
//	biggest win:        tile-z5 (-27%)
//	biggest regression: catchment-values-viewport (+361%)
//
// The "biggest win" in the entire comparison was a tile that went from 0.11 ms
// to 0.08 ms — a difference of thirty microseconds, smaller than the scatter of
// the measurement itself. Eight of the thirteen verdicts rested on absolute
// differences under one millisecond. A relative threshold has no floor under
// it, so it says nothing about the code and everything about the timer.
//
// What follows fixes that with three independent gates, all of which a change
// must pass before it is called a change:
//
//  1. It must be big enough to matter in absolute terms — see practicalFloorMs.
//  2. It must be big enough to matter in relative terms — NoiseFloor, kept.
//  3. It must be unlikely to have arisen by chance — a Mann-Whitney rank-sum
//     test over the raw samples, with a Holm correction because the suite asks
//     the question fifteen times over and somebody testing fifteen hypotheses
//     at p<0.05 should expect a false positive about half the time.
//
// None of this makes a twenty-sample measurement into a strong one. It makes
// the tool decline to claim more than twenty samples can support, which is the
// difference between a report that survives being checked and one that does
// not.

// practicalFloorMs is the smallest difference in milliseconds this harness will
// attribute to the server rather than to itself.
//
// One millisecond. It is a judgement, and here is the evidence behind it. On
// localhost the cheap scenarios sit at 0.06–0.4 ms with an observed spread of
// 0.07–0.44 ms on a single scenario within one run; two runs minutes apart
// moved `health` from 0.07 ms to 0.09 ms, which is 38% and is nothing. Go's
// timer resolves far finer than this, so the floor is not the clock — it is the
// scheduler, the loopback stack, the Go GC and whatever else the machine is
// doing, none of which the target controls.
//
// The honest consequence is that this tool cannot measure a sub-millisecond
// improvement on a local target, and should not pretend otherwise. An endpoint
// that goes from 0.11 ms to 0.08 ms may well have got faster; this method
// cannot tell, and a method that cannot tell should say "unchanged".
const practicalFloorMs = 1.0

// significanceLevel is the family-wise error rate for the whole suite, not for
// a single scenario — that is what the Holm correction below buys.
const significanceLevel = 0.05

// TestResult is what a rank-sum test could establish about one scenario.
type TestResult struct {
	// Possible is false when the runs did not record raw samples — a result
	// stored by version 1 of this tool keeps only summary statistics, and no
	// test can be run against a median. The comparison then falls back to the
	// older, weaker check and says so.
	Possible bool

	// P is the two-sided p-value before correction.
	P float64

	// AdjustedP is P after the Holm step-down correction across the suite.
	AdjustedP float64

	// Significant is AdjustedP < significanceLevel.
	Significant bool

	// ShiftMs is the Hodges–Lehmann estimate of the difference: the median of
	// every pairwise difference between the two runs' samples. It is the
	// location shift the rank-sum test is testing for, and it is robust in a
	// way the difference of two medians is not.
	ShiftMs float64

	// LowMs and HighMs bound ShiftMs at the significance level, distribution
	// free. The width of this interval is the most honest single statement the
	// tool makes: at twenty samples it is usually wide, and a reader who sees
	// it will not over-read the point estimate.
	LowMs, HighMs float64
}

// mannWhitney runs a two-sided Mann-Whitney U test on two independent samples.
//
// Chosen over a t-test because latency distributions are not normal — they are
// bounded below, skewed right, and occasionally contain an outlier worth an
// order of magnitude — and a rank-based test does not care. Chosen over
// comparing medians because it uses every sample rather than one.
//
// The normal approximation with a tie correction and a continuity correction is
// used rather than the exact distribution. At the sample counts here (typically
// twenty against twenty, and never fewer than the guard below allows) the
// approximation is good to well within the precision anything downstream
// claims; the exact test would need a table or a recursion and would not change
// a verdict.
func mannWhitney(a, b []float64) (p float64, ok bool) {
	n1, n2 := len(a), len(b)
	// Below about eight per side the normal approximation stops being
	// trustworthy and, more to the point, the test has so little power that
	// "not significant" would mean nothing at all. Refusing is more useful
	// than answering badly — this is the case for the heavy scenarios, which
	// run three samples by design.
	if n1 < 8 || n2 < 8 {
		return 0, false
	}

	type item struct {
		v     float64
		first bool
	}
	all := make([]item, 0, n1+n2)
	for _, v := range a {
		all = append(all, item{v, true})
	}
	for _, v := range b {
		all = append(all, item{v, false})
	}
	sort.Slice(all, func(i, j int) bool { return all[i].v < all[j].v })

	// Midranks for ties, and the tie-correction term for the variance.
	ranks := make([]float64, len(all))
	var tieTerm float64
	for i := 0; i < len(all); {
		j := i
		for j+1 < len(all) && all[j+1].v == all[i].v {
			j++
		}
		mid := float64(i+j)/2 + 1
		for k := i; k <= j; k++ {
			ranks[k] = mid
		}
		t := float64(j - i + 1)
		tieTerm += t*t*t - t
		i = j + 1
	}

	var r1 float64
	for i, it := range all {
		if it.first {
			r1 += ranks[i]
		}
	}

	N := float64(n1 + n2)
	f1, f2 := float64(n1), float64(n2)
	u1 := r1 - f1*(f1+1)/2
	mu := f1 * f2 / 2
	variance := f1 * f2 / 12 * ((N + 1) - tieTerm/(N*(N-1)))
	if variance <= 0 {
		// Every sample identical. There is no difference to detect.
		return 1, true
	}

	z := math.Abs(u1-mu) - 0.5 // continuity correction
	if z < 0 {
		z = 0
	}
	z /= math.Sqrt(variance)

	// Two-sided p from the standard normal survival function.
	// erfc(z/sqrt2) is exactly 2*(1-Phi(z)).
	return math.Erfc(z / math.Sqrt2), true
}

// hodgesLehmann estimates the shift from a to b as the median of all pairwise
// differences, with a distribution-free confidence interval at the given level.
//
// The interval comes from the rank-sum distribution: the k-th smallest and
// k-th largest of the sorted pairwise differences bracket the shift, where k is
// read off the normal approximation to the Wilcoxon statistic. It requires no
// assumption about the shape of either distribution, which is the whole point.
func hodgesLehmann(a, b []float64, level float64) (shift, low, high float64) {
	n1, n2 := len(a), len(b)
	if n1 == 0 || n2 == 0 {
		return 0, 0, 0
	}

	diffs := make([]float64, 0, n1*n2)
	for _, x := range b {
		for _, y := range a {
			diffs = append(diffs, x-y)
		}
	}
	sort.Float64s(diffs)
	shift = medianSorted(diffs)

	f1, f2 := float64(n1), float64(n2)
	m := f1 * f2
	z := zForTwoSided(level)
	k := int(math.Round(m/2 - z*math.Sqrt(m*(f1+f2+1)/12)))
	if k < 1 {
		// The sample is too small for the interval to exclude anything; report
		// the full observed range rather than a bound that is not there.
		return shift, diffs[0], diffs[len(diffs)-1]
	}
	if k > len(diffs) {
		k = len(diffs)
	}
	return shift, diffs[k-1], diffs[len(diffs)-k]
}

func medianSorted(s []float64) float64 {
	n := len(s)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return s[n/2]
	}
	return (s[n/2-1] + s[n/2]) / 2
}

// zForTwoSided is the standard normal quantile for a two-sided interval at the
// given level. Only two levels are ever asked for, so a table beats inverting
// the error function.
func zForTwoSided(level float64) float64 {
	switch {
	case level <= 0.01:
		return 2.5758
	case level <= 0.05:
		return 1.9600
	default:
		return 1.6449
	}
}

// holmAdjust applies the Holm step-down correction in place.
//
// Fifteen scenarios each tested at p<0.05 gives roughly a one-in-two chance
// that at least one of them looks significant when nothing changed at all. A
// report that names a "biggest win" is picking the most extreme of fifteen
// results, which is precisely the situation the correction exists for. Holm
// rather than plain Bonferroni because it is uniformly more powerful and no
// less valid, so it costs nothing to prefer.
//
// The input is the set of p-values across the suite; the output is written back
// to the same TestResults.
func holmAdjust(tests []*TestResult) {
	type entry struct {
		t *TestResult
		p float64
	}
	var live []entry
	for _, t := range tests {
		if t != nil && t.Possible {
			live = append(live, entry{t, t.P})
		}
	}
	if len(live) == 0 {
		return
	}
	sort.Slice(live, func(i, j int) bool { return live[i].p < live[j].p })

	m := float64(len(live))
	running := 0.0
	for i, e := range live {
		adj := (m - float64(i)) * e.p
		// Step-down: an adjusted p-value can never decrease as raw p increases.
		if adj < running {
			adj = running
		}
		running = adj
		if adj > 1 {
			adj = 1
		}
		e.t.AdjustedP = adj
		e.t.Significant = adj < significanceLevel
	}
}

// noiseBandMs estimates, from the summary statistics alone, how large a
// difference has to be before it is distinguishable.
//
// Used when raw samples are unavailable — a baseline stored by version 1 of
// this tool. P90 minus P50 is a one-sided dispersion that survives an outlier
// where max minus min does not, and adding the two runs' dispersions is a
// deliberately generous account of how much the pair could disagree by chance.
func noiseBandMs(base, cur Stats) float64 {
	return (base.P90 - base.P50) + (cur.P90 - cur.P50)
}
