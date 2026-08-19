package bench

import (
	"fmt"
	"math"
	"sort"
	"strings"
)

// Verdict is how a change between two runs should be read.
type Verdict string

const (
	// Faster and Slower are changes large enough to be worth acting on.
	Faster Verdict = "faster"
	Slower Verdict = "slower"

	// Unchanged covers differences small enough to be indistinguishable from
	// run-to-run noise. Reporting a 3% "improvement" as a win is how benchmark
	// suites lose their credibility.
	Unchanged Verdict = "unchanged"

	// Added and Removed are scenarios present on only one side, which happens
	// whenever the suite itself changes.
	Added   Verdict = "added"
	Removed Verdict = "removed"

	// Broken is a scenario that started erroring. It is called out separately
	// because a scenario that 404s is usually *faster*, and reporting that as an
	// improvement would be actively misleading.
	Broken Verdict = "broken"

	// Traded is a change that costs server time and saves payload, or the
	// reverse. It is the shape of nearly every payload optimisation, and it
	// needs its own word because calling it "slower" is how this tool came to
	// headline the best change of the week as a 830% regression.
	//
	// See transfer.go: measured over loopback, compression and every other
	// size-reducing change is pure cost, because the transfer it saves takes no
	// measurable time on the same machine.
	Traded Verdict = "traded"

	// Absent is a scenario the target could not answer because the endpoint or
	// capability does not exist on that build.
	//
	// It is separate from Broken, and the distinction is not pedantry. In a
	// sweep across a range of revisions, an endpoint added on the Tuesday is
	// *absent* on Monday's build and *working* on Wednesday's, and neither is a
	// fault. Reported as Broken it looks like a regression somebody introduced;
	// reported as Faster — which is what happened before this existed, because
	// the missing route returned a small HTML page in a tenth of a millisecond —
	// it looks like the feature made things worse.
	Absent Verdict = "absent"
)

// A BytesVerdict is how a change in response size should be read.
//
// Size gets its own verdict because it is a different kind of evidence from
// time, and better evidence. A byte count is deterministic: the same request
// against the same build returns the same number every time, so a change in it
// is a fact rather than an estimate, and needs no statistics to defend.
//
// It also happens to be where this project's recent work actually shows up.
// Between the two builds compared while this was written, the timing verdicts
// were noise in both directions, while the choropleth viewport payload went
// from 179.2 KB to 36.6 KB and the aggregated domain payload from 5.5 MB to
// 1.7 MB. A report that leads with timing and mentions bytes in a column has
// the emphasis backwards for that dataset.
type BytesVerdict string

const (
	BytesSmaller BytesVerdict = "smaller"
	BytesLarger  BytesVerdict = "larger"
	BytesSame    BytesVerdict = "same"
	BytesUnknown BytesVerdict = "unknown"
)

// bytesFloor is the relative change in payload size below which the difference
// is treated as incidental.
//
// Two percent. Payload sizes are deterministic for a fixed build and query, but
// not quite identical across builds for uninteresting reasons — a version
// string of a different length, gzip finding a slightly different match. Two
// percent is far below any change worth reporting and far above that jitter.
const bytesFloor = 0.02

// NoiseFloor is the relative change below which a difference is called
// unchanged.
//
// Ten percent is deliberately blunt. These measurements come from a developer
// machine with a browser and an editor open, over a shared network for a remote
// target, at sample counts in the tens. A tighter threshold would produce
// confident-looking verdicts that a rerun would contradict, and the first time
// that happens nobody believes the report again.
//
// It is a floor, not a claim of statistical significance: the report also shows
// the spread, so a reader can see when a "faster" is resting on one fast sample.
const NoiseFloor = 0.10

// A Delta is one scenario compared across two runs.
type Delta struct {
	Name  string
	Group string
	Why   string

	Baseline ScenarioResult
	Current  ScenarioResult

	// RelativeChange in p50 total time: negative is faster.
	RelativeChange float64

	// BytesChange is the relative change in response size, on the same sign
	// convention.
	BytesChange float64

	Verdict Verdict

	// Caveat explains a verdict that should not be taken at face value.
	Caveat string

	// --- added with the statistics ---------------------------------------

	// BytesVerdict is the payload-size finding, independent of the timing one.
	BytesVerdict BytesVerdict

	// Test is what a rank-sum test over the raw samples could establish. When
	// Test.Possible is false the verdict rests on the weaker summary-statistics
	// check instead, and Caveat says so.
	Test TestResult

	// Trade describes a size-for-time change and where it breaks even. Consult
	// it before reading RelativeChange as a regression.
	Trade Trade

	// FloorDominated marks a delta whose scenario is mostly round-trip time on
	// both sides, so the totals are describing the network rather than the
	// server. Measured against production, every cheap scenario landed within a
	// millisecond of 222 ms.
	FloorDominated bool
}

// SignificanceNote is the sentence describing what the statistics established,
// or why they could not be applied. Empty when there is nothing to say.
//
// It exists so that a report can print the reasoning next to the number rather
// than leaving a reader to trust the verdict word.
func (d Delta) SignificanceNote() string {
	if d.Verdict == Added || d.Verdict == Removed || d.Verdict == Absent || d.Verdict == Broken {
		return ""
	}
	if !d.Test.Possible {
		return ""
	}
	if d.Test.Significant {
		return fmt.Sprintf(
			"Rank-sum test over %d and %d samples: shift %+.2f ms (95%% interval %+.2f to %+.2f ms), "+
				"p=%.4f after correcting for the %d scenarios tested.",
			d.Baseline.Samples, d.Current.Samples, d.Test.ShiftMs, d.Test.LowMs, d.Test.HighMs, d.Test.AdjustedP,
			d.testFamilySize())
	}
	return fmt.Sprintf(
		"Rank-sum test cannot separate these: shift %+.2f ms with a 95%% interval of %+.2f to %+.2f ms, "+
			"p=%.3f after correction. At these sample counts a difference this size is not distinguishable "+
			"from run-to-run variation.",
		d.Test.ShiftMs, d.Test.LowMs, d.Test.HighMs, d.Test.AdjustedP)
}

// testFamilySize is recovered from the correction itself: Holm multiplies the
// smallest p-value by the family size, so the ratio recovers it. Only used for
// wording, and only when both are non-zero.
func (d Delta) testFamilySize() int {
	if d.Test.P <= 0 || d.Test.AdjustedP <= 0 {
		return 0
	}
	return int(math.Round(d.Test.AdjustedP / d.Test.P))
}

// AbsoluteChangeMs is the p50 difference in milliseconds, negative when faster.
func (d Delta) AbsoluteChangeMs() float64 {
	return d.Current.TotalMs.P50 - d.Baseline.TotalMs.P50
}

// Speedup expresses the change as a multiple, which is how these results get
// quoted in a pull request. Returns 0 when it cannot be computed.
func (d Delta) Speedup() float64 {
	if d.Current.TotalMs.P50 <= 0 || d.Baseline.TotalMs.P50 <= 0 {
		return 0
	}
	return d.Baseline.TotalMs.P50 / d.Current.TotalMs.P50
}

// A Comparison is two runs, scenario by scenario.
type Comparison struct {
	Baseline Run
	Current  Run
	Deltas   []Delta

	// Warnings are conditions that make the comparison less than apples to
	// apples. They are part of the result rather than a log line, because they
	// have to appear next to the numbers to do their job.
	Warnings []string
}

// Compare lines up two runs.
func Compare(baseline, current Run) Comparison {
	c := Comparison{Baseline: baseline, Current: current}

	if baseline.TargetKind != current.TargetKind {
		c.Warnings = append(c.Warnings, fmt.Sprintf(
			"These runs measured different kinds of target (%s against %s). Network latency to a remote host "+
				"is a floor under every number, so the two are not directly comparable.",
			baseline.TargetKind, current.TargetKind))
	}
	if baseline.Target != current.Target && baseline.TargetKind == current.TargetKind {
		c.Warnings = append(c.Warnings, fmt.Sprintf(
			"Different targets: %s against %s.", baseline.Target, current.Target))
	}
	if baseline.Host != current.Host && baseline.Host != "" && current.Host != "" {
		c.Warnings = append(c.Warnings, fmt.Sprintf(
			"The load was generated from different machines (%s against %s), which bounds the result as much "+
				"as the server does.", baseline.Host, current.Host))
	}
	if baseline.Iterations != current.Iterations {
		c.Warnings = append(c.Warnings, fmt.Sprintf(
			"Different sample counts (%d against %d): a p99 over few samples is not the same statistic as one "+
				"over many.", baseline.Iterations, current.Iterations))
	}

	seen := map[string]bool{}
	for _, cur := range current.Scenarios {
		seen[cur.Name] = true
		base, ok := baseline.Scenario(cur.Name)
		if !ok {
			c.Deltas = append(c.Deltas, Delta{
				Name: cur.Name, Group: cur.Group, Why: cur.Why,
				Current: cur, Verdict: Added,
			})
			continue
		}
		c.Deltas = append(c.Deltas, delta(base, cur))
	}

	if baseline.SchemaVersion < 2 || current.SchemaVersion < 2 {
		c.Warnings = append(c.Warnings,
			"At least one of these runs was recorded before this tool kept raw samples, so its verdicts rest on a "+
				"comparison of medians against the observed spread rather than on a significance test. Rerun both "+
				"sides to get the stronger check.")
	}
	if !baseline.Settled || !current.Settled {
		c.Warnings = append(c.Warnings,
			"At least one of these runs began measuring before its target had finished starting up. The most "+
				"expensive query in this suite costs roughly 2.4x its steady-state figure while the grid geometry "+
				"cache is still building, so a difference of that order may be a difference in warm-up, not in code.")
	}
	if baseline.Iterations < 8 || current.Iterations < 8 {
		c.Warnings = append(c.Warnings, fmt.Sprintf(
			"Sample counts of %d and %d are too small for the rank-sum test to run, so timing verdicts here are "+
				"the weaker median comparison. Payload-size findings are unaffected — those are exact.",
			baseline.Iterations, current.Iterations))
	}

	for _, base := range baseline.Scenarios {
		if !seen[base.Name] {
			c.Deltas = append(c.Deltas, Delta{
				Name: base.Name, Group: base.Group, Why: base.Why,
				Baseline: base, Verdict: Removed,
			})
		}
	}

	// The significance correction has to see the whole suite at once — that is
	// what makes it a correction — so it happens after every delta exists, and
	// the verdicts that depend on it are settled afterwards.
	tests := make([]*TestResult, 0, len(c.Deltas))
	for i := range c.Deltas {
		tests = append(tests, &c.Deltas[i].Test)
	}
	holmAdjust(tests)
	for i := range c.Deltas {
		finaliseVerdict(&c.Deltas[i], baseline, current)
	}

	sort.SliceStable(c.Deltas, func(i, j int) bool {
		if c.Deltas[i].Group != c.Deltas[j].Group {
			return c.Deltas[i].Group < c.Deltas[j].Group
		}
		return c.Deltas[i].Name < c.Deltas[j].Name
	})
	return c
}

func delta(base, cur ScenarioResult) Delta {
	d := Delta{
		Name:     cur.Name,
		Group:    cur.Group,
		Why:      cur.Why,
		Baseline: base,
		Current:  cur,
	}

	d.BytesVerdict = bytesVerdict(base, cur)
	if base.BytesMax > 0 {
		d.BytesChange = float64(cur.BytesMax-base.BytesMax) / float64(base.BytesMax)
	}

	switch {
	case base.Skipped || cur.Skipped:
		d.Verdict = Unchanged
		d.Caveat = "Skipped in at least one run, so there is nothing to compare."
		return d

	// Absence is checked before breakage, and before anything is divided,
	// because the two look identical in the timings and mean opposite things.
	case base.Absent && cur.Absent:
		d.Verdict = Absent
		d.Caveat = "Not available on either build: " + firstNonEmpty(cur.AbsentReason, base.AbsentReason)
		return d

	case base.Absent && !cur.Absent:
		d.Verdict = Added
		d.Caveat = "This did not exist on the baseline build (" + base.AbsentReason +
			"). It is a new capability, so there is no 'before' to be faster or slower than."
		return d

	case cur.Absent && !base.Absent:
		// Losing a capability is a real regression, but not a *timing* one, and
		// calling it Broken would be right in spirit while implying an error the
		// server did not report.
		d.Verdict = Broken
		d.Caveat = "This worked on the baseline and does not on the current build: " + cur.AbsentReason
		return d

	case cur.Samples == 0 && base.Samples == 0:
		d.Verdict = Broken
		d.Caveat = "No successful samples in either run."
		return d

	case cur.Samples == 0:
		d.Verdict = Broken
		d.Caveat = "Every request failed in the current run. A scenario that stops working often looks faster."
		return d

	case base.Samples == 0:
		d.Verdict = Added
		d.Caveat = "The baseline had no successful samples, so this is a first result rather than a change."
		return d
	}

	// A scenario that started erroring, even partly, is not a performance
	// result. Say so instead of dividing two numbers.
	if cur.Errors > 0 && base.Errors == 0 {
		d.Verdict = Broken
		d.Caveat = fmt.Sprintf("%d of %d requests failed in the current run.",
			cur.Errors, cur.Errors+cur.Samples)
		return d
	}

	if base.TotalMs.P50 > 0 {
		d.RelativeChange = (cur.TotalMs.P50 - base.TotalMs.P50) / base.TotalMs.P50
	}

	// The test runs here; the verdict it feeds is decided in finaliseVerdict,
	// once every scenario's p-value is known and can be corrected together.
	if p, ok := mannWhitney(base.SamplesMs, cur.SamplesMs); ok {
		d.Test.Possible = true
		d.Test.P = p
		d.Test.ShiftMs, d.Test.LowMs, d.Test.HighMs =
			hodgesLehmann(base.SamplesMs, cur.SamplesMs, significanceLevel)
	}

	return d
}

// finaliseVerdict decides faster/slower/unchanged once the whole suite's
// p-values have been corrected together.
//
// Three gates, and a change must pass all of them. The reasoning for each is in
// stats.go; the short version is that the previous single relative threshold
// named a thirty-microsecond difference as the biggest win in the comparison.
func finaliseVerdict(d *Delta, baseline, current Run) {
	if d.Verdict == Added || d.Verdict == Removed || d.Verdict == Absent || d.Verdict == Broken {
		return
	}
	if d.Baseline.Skipped || d.Current.Skipped {
		return
	}

	base, cur := d.Baseline, d.Current
	abs := math.Abs(d.AbsoluteChangeMs())

	// Is this scenario mostly network on both sides? If so its total says very
	// little about the code, whatever the arithmetic works out to.
	d.FloorDominated = baseline.FloorDominated(base.TotalMs.P50) && current.FloorDominated(cur.TotalMs.P50)

	// Gate 1: absolute size. Below the harness's own resolution, nothing can be
	// concluded in either direction.
	if abs < PracticalFloorMs {
		d.Verdict = Unchanged
		d.Caveat = joinCaveat(d.Caveat, fmt.Sprintf(
			"The difference is %.2f ms, below the %.1f ms this harness can attribute to the server rather than to "+
				"itself. Whether this endpoint changed is not something these measurements can establish.",
			abs, PracticalFloorMs))
		annotateBytes(d)
		return
	}

	// Gate 2: relative size. A 1 ms change on a 4 s query is real and irrelevant.
	if math.Abs(d.RelativeChange) < NoiseFloor {
		d.Verdict = Unchanged
		annotateBytes(d)
		return
	}

	// Gate 3: is it distinguishable from run-to-run variation?
	if d.Test.Possible {
		if !d.Test.Significant {
			d.Verdict = Unchanged
			d.Caveat = joinCaveat(d.Caveat, d.SignificanceNote())
			annotateBytes(d)
			return
		}
	} else {
		// No raw samples: fall back to the observed spread, and be explicit that
		// this is the weaker check rather than letting it pass as the strong one.
		band := noiseBandMs(base.TotalMs, cur.TotalMs)
		if abs < band {
			d.Verdict = Unchanged
			d.Caveat = joinCaveat(d.Caveat, fmt.Sprintf(
				"The %.2f ms difference is inside the %.2f ms spread these two runs already show, and raw samples "+
					"were not recorded, so no significance test is possible.", abs, band))
			annotateBytes(d)
			return
		}
		d.Caveat = joinCaveat(d.Caveat,
			"Raw samples were not recorded for at least one side, so this verdict rests on comparing medians "+
				"against the observed spread rather than on a significance test.")
	}

	// A real, measurable difference in server time. Before naming it faster or
	// slower, check whether it is really a trade — see transfer.go. Measured on
	// the same machine as the server, a change that spends CPU to send fewer
	// bytes shows all of its cost and none of its benefit, and calling that a
	// regression argues against the work most worth doing.
	d.Trade = tradeOff(d.AbsoluteChangeMs(), d.Baseline.BytesMax-d.Current.BytesMax)
	if d.Trade.IsTrade && math.Abs(d.BytesChange) >= NoiseFloor {
		d.Verdict = Traded
		d.Caveat = joinCaveat(d.Caveat, d.Trade.Describe())
		if d.Test.Possible {
			d.Caveat = joinCaveat(d.Caveat, d.SignificanceNote())
		}
		return
	}

	if d.RelativeChange < 0 {
		d.Verdict = Faster
	} else {
		d.Verdict = Slower
	}

	if d.Test.Possible {
		d.Caveat = joinCaveat(d.Caveat, d.SignificanceNote())
	}
	if d.FloorDominated {
		d.Caveat = joinCaveat(d.Caveat,
			"Both sides of this scenario are dominated by the round trip to the target, so this difference is "+
				"more likely to be about the network than about the server's code.")
	}
	if cacheDominated(cur) {
		d.Caveat = joinCaveat(d.Caveat, fmt.Sprintf(
			"A repeat request here is %.0fx faster than a first one, so this figure is a cache-hit measurement. "+
				"That is what a user gets on a second visit, but it is not the cost of producing the response.",
			cur.CacheSpeedup))
	}
	annotateBytes(d)
}

// cacheDominated marks a scenario whose steady-state figure owes most of itself
// to a server-side cache populated by the warm-up.
//
// Threshold of three: measured on a warm production-shaped server,
// catchment-values went from 22.2 ms on a first hit to 0.49 ms on repeats — 45x
// — while genuinely uncached scenarios sat between 1.0x and 1.6x. Three
// separates those cleanly without being sensitive to where exactly it is put.
func cacheDominated(r ScenarioResult) bool { return r.CacheSpeedup >= 3 }

// bytesVerdict compares payload sizes, which unlike timings are exact.
func bytesVerdict(base, cur ScenarioResult) BytesVerdict {
	if base.Absent || cur.Absent || base.Skipped || cur.Skipped ||
		base.BytesMax <= 0 || cur.BytesMax <= 0 {
		return BytesUnknown
	}
	change := float64(cur.BytesMax-base.BytesMax) / float64(base.BytesMax)
	switch {
	case math.Abs(change) < bytesFloor:
		return BytesSame
	case change < 0:
		return BytesSmaller
	default:
		return BytesLarger
	}
}

// annotateBytes adds the payload finding to a delta whose timing said nothing.
//
// This is the case that matters most for the work this tool was built to
// assess: the vector-tile and columnar changes cut payloads by four- and
// three-fold while the timings moved inside the noise, and a report that only
// speaks about time would have called that week a wash.
func annotateBytes(d *Delta) {
	if d.Verdict != Unchanged || d.BytesVerdict == BytesSame || d.BytesVerdict == BytesUnknown {
		return
	}
	if math.Abs(d.BytesChange) < NoiseFloor {
		return
	}
	direction := "smaller"
	if d.BytesVerdict == BytesLarger {
		direction = "larger"
	}
	d.Caveat = joinCaveat(d.Caveat, fmt.Sprintf(
		"The response is %.0f%% %s (%d to %d bytes) even though the time did not move measurably. Payload sizes "+
			"are exact rather than sampled, so this one is a fact, not an estimate.",
		math.Abs(d.BytesChange)*100, direction, d.Baseline.BytesMax, d.Current.BytesMax))
}

func joinCaveat(existing, add string) string {
	switch {
	case add == "":
		return existing
	case existing == "":
		return add
	default:
		return existing + " " + add
	}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// Headline summarises a comparison in the terms the report leads with.
type Headline struct {
	Faster, Slower, Unchanged, Broken, Added, Removed int

	// Traded counts size-for-time changes, which are neither a win nor a
	// regression until you say over what connection.
	Traded int

	// BiggestWin and BiggestRegression are the deltas worth naming.
	BiggestWin        *Delta
	BiggestRegression *Delta

	// TotalBytesBaseline and TotalBytesCurrent add up one pass of the suite,
	// which is the closest thing to "what a page load costs".
	TotalBytesBaseline int64
	TotalBytesCurrent  int64
}

// describe is the one-paragraph version printed on the command line, so a reader
// gets the finding without opening the report.
func (h Headline) describe() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d faster, %d slower, %d unchanged", h.Faster, h.Slower, h.Unchanged)
	if h.Traded > 0 {
		fmt.Fprintf(&b, ", %d traded (smaller but slower to produce, or the reverse)", h.Traded)
	}
	if h.Broken > 0 {
		fmt.Fprintf(&b, ", %d BROKEN", h.Broken)
	}
	if h.BiggestWin != nil {
		fmt.Fprintf(&b, "\nbiggest win:        %s (%.0f%%)", h.BiggestWin.Name, h.BiggestWin.RelativeChange*100)
	}
	if h.BiggestRegression != nil {
		fmt.Fprintf(&b, "\nbiggest regression: %s (%+.0f%%)",
			h.BiggestRegression.Name, h.BiggestRegression.RelativeChange*100)
	}
	return b.String()
}

// Describe is describe, exported for callers outside the package.
func (h Headline) Describe() string { return h.describe() }

// Summarise counts the verdicts and finds the extremes.
func (c Comparison) Summarise() Headline {
	var h Headline
	for i := range c.Deltas {
		d := &c.Deltas[i]
		switch d.Verdict {
		case Faster:
			h.Faster++
			if h.BiggestWin == nil || d.RelativeChange < h.BiggestWin.RelativeChange {
				h.BiggestWin = d
			}
		case Slower:
			h.Slower++
			if h.BiggestRegression == nil || d.RelativeChange > h.BiggestRegression.RelativeChange {
				h.BiggestRegression = d
			}
			// Note the asymmetry with Traded above: a trade can never become the
			// headline regression, because the headline is the one number that
			// gets quoted and "biggest regression: tour-viphya (+830%)" was a
			// four-hundred-kilobyte saving.
		case Unchanged:
			h.Unchanged++
		case Traded:
			h.Traded++
		case Broken:
			h.Broken++
		case Added:
			h.Added++
		case Removed:
			h.Removed++
		}
		h.TotalBytesBaseline += d.Baseline.BytesMax
		h.TotalBytesCurrent += d.Current.BytesMax
	}
	return h
}
