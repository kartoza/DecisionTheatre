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
)

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

	for _, base := range baseline.Scenarios {
		if !seen[base.Name] {
			c.Deltas = append(c.Deltas, Delta{
				Name: base.Name, Group: base.Group, Why: base.Why,
				Baseline: base, Verdict: Removed,
			})
		}
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

	switch {
	case base.Skipped || cur.Skipped:
		d.Verdict = Unchanged
		d.Caveat = "Skipped in at least one run, so there is nothing to compare."
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
	if base.BytesMax > 0 {
		d.BytesChange = float64(cur.BytesMax-base.BytesMax) / float64(base.BytesMax)
	}

	switch {
	case math.Abs(d.RelativeChange) < NoiseFloor:
		d.Verdict = Unchanged
	case d.RelativeChange < 0:
		d.Verdict = Faster
	default:
		d.Verdict = Slower
	}

	// A verdict resting on a distribution wide enough to contain the other run's
	// median is not a verdict. Say so rather than quietly reporting the number.
	if d.Verdict != Unchanged && overlapping(base, cur) {
		d.Caveat = "The two runs' spreads overlap: the medians differ, but individual samples do not separate cleanly. " +
			"Treat the direction as indicative and rerun if it matters."
	}

	// Bytes changing while time does not is worth surfacing: it usually means a
	// payload change that has not yet shown up as a user-visible win.
	if d.Verdict == Unchanged && math.Abs(d.BytesChange) >= NoiseFloor {
		d.Caveat = fmt.Sprintf("Response size changed by %.0f%% without a matching change in time.",
			d.BytesChange*100)
	}

	return d
}

// overlapping reports whether each run's median falls inside the other's
// observed range — a cheap, honest check that does not pretend to be a
// significance test.
func overlapping(base, cur ScenarioResult) bool {
	return (cur.TotalMs.P50 >= base.TotalMs.Min && cur.TotalMs.P50 <= base.TotalMs.Max) ||
		(base.TotalMs.P50 >= cur.TotalMs.Min && base.TotalMs.P50 <= cur.TotalMs.Max)
}

// Headline summarises a comparison in the terms the report leads with.
type Headline struct {
	Faster, Slower, Unchanged, Broken, Added, Removed int

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
		case Unchanged:
			h.Unchanged++
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
