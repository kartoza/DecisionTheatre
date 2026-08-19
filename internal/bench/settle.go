package bench

import (
	"context"
	"fmt"
	"net/http"
	"time"
)

// Settling: waiting for a target to stop getting faster before believing it.
//
// The problem this solves is the worst kind of measurement error, because it is
// systematic rather than random and it lands on whichever revision happens to be
// measured first.
//
// A sweep starts measuring as soon as /api/health answers. That handler reads
// nothing — it returns a constant — so it answers the instant the listener is
// up, which was measured at 0.2 s after launch. At that moment the server is
// still doing three things it started at boot: pre-warming a tile cache,
// parsing tens of megabytes of CSV lookup tables, and — the expensive one —
// unioning roughly 150,000 catchment polygons into a grid geometry cache across
// every core on the machine. The zoomed-out choropleth query does not merely
// run slowly during that window; it blocks on a channel until the cache is
// built.
//
// Measured against the real 3.45 GB datapack, on a freshly launched server:
//
//	t+0.0s   choropleth-domain-aggregated   10358 ms
//	t+12.0s  choropleth-domain-aggregated    4306 ms
//	t+18.0s  choropleth-domain-aggregated    4381 ms
//	...      steady thereafter, 4.1–4.6 s
//
// and the server's own log recorded "grid geometry cache built: 3 tiers in
// 12476ms". So a revision measured immediately after health answers is charged
// 2.4x for the most expensive scenario in the suite, for reasons that have
// nothing whatever to do with its code. In a sweep across a range of revisions
// that is a bias with a consistent direction, which is exactly how a tool ends
// up proving something false.
//
// There is no readiness endpoint to ask instead: /api/info reports whether the
// stores were opened, not whether the caches were built, and the only true
// signal is a line on the server's stderr, which is unavailable when the target
// is production. So readiness is established the only way that works for any
// target — by measuring until the measurements stop improving.

// SettleResult describes what waiting for the target established.
type SettleResult struct {
	// Waited is how long settling took.
	Waited time.Duration

	// Settled is true when the probe stopped improving within the timeout.
	// False means measuring began on a target that was still warming up, and
	// every number that follows inherits that.
	Settled bool

	// FirstMs and FinalMs are the probe's first and last timings, so the size
	// of the startup penalty is on the record rather than merely avoided.
	FirstMs float64
	FinalMs float64

	// Note is the sentence to put in the run's notes.
	Note string
}

// settleProbe is the request used to decide readiness.
//
// It is the zoomed-out choropleth deliberately: it is the scenario that blocks
// on the slowest background cache, so it is the last thing to become ready. A
// cheaper probe would report the server settled while the expensive path was
// still building, which is precisely the failure being fixed. The cost is a
// handful of multi-second requests per run, which a sweep pays once per
// revision against a build measured in minutes.
func settleProbe() Scenario {
	return Scenario{
		Name:  "settle-probe",
		Path:  "/api/choropleth",
		Query: with(fullDomain, "scenario", "current", "attribute", "NPP_gm2", "zoom", "4"),
	}
}

// Settle repeats a probe request until it stops getting faster, or until limit
// expires.
//
// "Stopped getting faster" is defined as two consecutive timings within
// settleTolerance of the best seen so far. Two rather than one because a single
// pair can agree by accident; within a tolerance rather than exactly because
// these are wall-clock measurements on a shared machine and demanding exact
// agreement would never terminate.
//
// The test is deliberately one-sided. It waits for improvement to stop, not for
// the numbers to become stable in general: a target that gets slower is a
// finding to report, not a reason to keep waiting.
func Settle(ctx context.Context, client *http.Client, base string, limit time.Duration, log func(string, ...any)) SettleResult {
	const (
		// A probe within 15% of the best seen is not improving in any way that
		// matters against a 2.4x startup penalty. Tighter would chase noise on a
		// machine that also runs an editor and a browser.
		settleTolerance = 0.15
		// Two agreeing probes in a row.
		settleAgree = 2
	)

	var out SettleResult
	if log == nil {
		log = func(string, ...any) {}
	}

	s := settleProbe()
	target, err := s.URL(base)
	if err != nil {
		out.Note = "Settling was not attempted: the probe URL could not be built."
		return out
	}

	start := time.Now()
	deadline := start.Add(limit)
	best := 0.0
	agreed := 0

	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			break
		}
		sm, err := once(ctx, client, s, target, nil)
		if err != nil || sm.status >= 400 {
			// A target that will not answer this probe is not one this check can
			// speak about. Give up quickly rather than burning the whole timeout:
			// an older revision may not have the endpoint at all, and that is a
			// legitimate state, handled per scenario later.
			out.Waited = time.Since(start)
			out.Note = "Settling could not be established: the probe request did not succeed. " +
				"If this target was started moments ago, early scenarios may be measuring its startup."
			return out
		}

		ms := float64(sm.total.Microseconds()) / 1000
		if out.FirstMs == 0 {
			out.FirstMs = ms
		}
		out.FinalMs = ms

		switch {
		case best == 0 || ms < best*(1-settleTolerance):
			// A genuine improvement: the server is still warming up.
			best = ms
			agreed = 0
		default:
			if ms < best {
				best = ms
			}
			agreed++
		}

		if agreed >= settleAgree {
			out.Settled = true
			break
		}
	}

	out.Waited = time.Since(start)

	switch {
	case out.Settled && out.FirstMs > out.FinalMs*1.5:
		out.Note = fmt.Sprintf(
			"The target was still starting up when it began answering: the readiness probe cost %.0f ms at first "+
				"and %.0f ms once settled, so measuring immediately would have charged this build %.1fx for work "+
				"that finishes on its own. Waited %.1f s before measuring anything.",
			out.FirstMs, out.FinalMs, out.FirstMs/out.FinalMs, out.Waited.Seconds())
	case out.Settled:
		out.Note = fmt.Sprintf(
			"The target was already warm: the readiness probe did not improve over %.1f s of settling.",
			out.Waited.Seconds())
	default:
		out.Note = fmt.Sprintf(
			"The target never stopped getting faster within %.0f s, so the numbers below were taken from a server "+
				"that was still warming up and are an upper bound rather than a steady state. The probe went from "+
				"%.0f ms to %.0f ms and was still moving.",
			limit.Seconds(), out.FirstMs, out.FinalMs)
	}
	log("settle: %s", out.Note)
	return out
}
