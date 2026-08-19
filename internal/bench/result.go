package bench

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ResultsVersion is the schema version of a stored run.
//
// Stored runs are the point of this tool — a comparison against last month is
// only possible if last month's file can still be read. Bump this when the shape
// changes incompatibly, and keep the reader able to load older versions.
// Version 2 added the fields marked "schema 2" below. The additions are all
// optional, so a version 1 file still loads and simply lacks them; a reader must
// therefore treat a zero FloorMs or an empty SamplesMs as "not recorded" rather
// than as a measurement of zero.
const ResultsVersion = 2

// A Run is one execution of the suite against one target.
//
// Everything needed to interpret the numbers later is recorded here rather than
// inferred at read time. A results file that cannot say what it measured is a
// file that will eventually be misread.
type Run struct {
	SchemaVersion int `json:"schemaVersion"`

	// Label distinguishes runs a human chose to separate — "before", "after",
	// "prod-friday". Free text.
	Label string `json:"label,omitempty"`

	// Target is the base URL measured.
	Target string `json:"target"`

	// TargetKind is "local" or "remote", decided from the target. Latency to a
	// remote host is a floor under every measurement and must not be compared
	// with a local one without saying so.
	TargetKind string `json:"targetKind"`

	StartedAt time.Time     `json:"startedAt"`
	Duration  time.Duration `json:"duration"`

	// ServerVersion is what the target's /api/info reported. This is how a
	// result is attributed to a build.
	ServerVersion string `json:"serverVersion"`

	// Commit is the revision under test, when the tool built it (a sweep). Empty
	// for a target the tool did not build, such as production.
	Commit      string `json:"commit,omitempty"`
	CommitDate  string `json:"commitDate,omitempty"`
	CommitTitle string `json:"commitTitle,omitempty"`

	// Iterations and Warmup are recorded because a p99 over 5 samples and one
	// over 200 are not the same statistic.
	Iterations int `json:"iterations"`
	Warmup     int `json:"warmup"`

	// Host describes where the load was generated, since that bounds the result
	// as much as the server does.
	Host string `json:"host,omitempty"`

	Scenarios []ScenarioResult `json:"scenarios"`

	// Notes carries anything the tool wants a reader to know — a skipped heavy
	// scenario, a target that could not report its version.
	Notes []string `json:"notes,omitempty"`

	// --- schema 2 ---------------------------------------------------------

	// FloorMs is the p50 of the cheapest scenario in the suite: a request with
	// no work behind it. It is the round trip, and every other number in the
	// run contains it.
	//
	// Against localhost it is around 0.1 ms and can be ignored. Against
	// production it was measured at 222 ms, with every cheap scenario landing
	// within a millisecond of that figure — at which point the suite is
	// reporting the network and the server's contribution is a rounding error.
	// Recording the floor is what lets a reader tell those two situations
	// apart, and lets ServerMs subtract it.
	FloorMs float64 `json:"floorMs,omitempty"`

	// FloorDriftPercent is how far the floor moved between the start and the
	// end of the run.
	//
	// The floor is measured twice for one reason: this tool runs on a developer
	// machine that is also running an editor, a browser, and — as happened
	// while this was being written — another copy of this tool driven by
	// somebody else. A floor that moved during the run says the machine did
	// not hold still, and every number in the run inherits that doubt.
	FloorDriftPercent float64 `json:"floorDriftPercent,omitempty"`

	// SettleSeconds is how long the tool waited, after the target first
	// answered /api/health, for the target to stop getting faster.
	//
	// /api/health on this server returns 200 immediately and reads nothing. It
	// is not a readiness signal: at the moment it first answers, a background
	// goroutine is still unioning roughly 150,000 polygons into a grid geometry
	// cache, and the zoomed-out choropleth query blocks on that cache. Measured
	// on the real datapack, the cache took 12.5 s to build and the query cost
	// 10.4 s inside that window against 4.3 s after it — a 2.4x penalty
	// applied to whichever revision happened to be measured first.
	SettleSeconds float64 `json:"settleSeconds,omitempty"`

	// Settled is false when the target never stopped improving within the
	// allowed time, meaning the numbers that follow were taken from a server
	// that was still warming up.
	Settled bool `json:"settled"`

	// ScenarioOrder is the order scenarios were executed in, which is not
	// necessarily the order they are declared or reported in.
	ScenarioOrder []string `json:"scenarioOrder,omitempty"`

	// ShuffleSeed is the seed used when the order was randomised, so the order
	// can be reproduced. Zero when the order was the declared one.
	ShuffleSeed int64 `json:"shuffleSeed,omitempty"`

	// Coverage is how much of the server's route table this suite examined.
	//
	// Stored in the run because a scenario count says nothing about coverage
	// and a reader has no other way to know what was left out. The first time
	// anybody checked, 14 of 35 registered route patterns were probed while the
	// suite reported 37 scenarios and looked thorough.
	Coverage Coverage `json:"coverage"`

	// GoVersion is the toolchain that built the tool, and — in a sweep, where
	// the tool builds each revision with the toolchain it is itself running
	// under — the toolchain that built the target. Two revisions compiled by
	// different Go versions are not a clean comparison of their source.
	GoVersion string `json:"goVersion,omitempty"`
}

// ServerMs is a scenario duration with the round-trip floor removed: an
// estimate of the time the server spent rather than the time the user waited.
//
// Both are legitimate and they answer different questions. "How long does a
// user in Johannesburg wait" is the total; "did our code get faster" is closer
// to this. It is an estimate and not a measurement — the floor is itself a
// sample with its own spread, and subtracting it from a number of the same
// order leaves almost nothing but noise — so callers should show it beside the
// raw figure, never instead of it.
func (r Run) ServerMs(ms float64) float64 {
	v := ms - r.FloorMs
	if v < 0 {
		return 0
	}
	return v
}

// FloorDominated reports whether the round trip is large enough that this
// figure is mostly network.
//
// Two-thirds is a judgement, not a derivation: below it the server is still the
// larger term and a comparison of totals is defensible; above it a reader
// quoting the total as evidence about the code is quoting the network.
func (r Run) FloorDominated(ms float64) bool {
	return ms > 0 && r.FloorMs/ms > 0.66
}

// A ScenarioResult is the distribution for one scenario.
type ScenarioResult struct {
	Name  string `json:"name"`
	Group string `json:"group"`
	Why   string `json:"why,omitempty"`
	URL   string `json:"url"`

	// Skipped and why, so a gap in the report is explained rather than blank.
	Skipped       bool   `json:"skipped,omitempty"`
	SkippedReason string `json:"skippedReason,omitempty"`

	Samples int `json:"samples"`
	Errors  int `json:"errors"`

	// StatusCounts records every status seen, not just the first. A scenario that
	// is fast because it started 404ing is the failure mode this catches.
	StatusCounts map[int]int `json:"statusCounts,omitempty"`

	// Durations, in milliseconds. Total is the whole response including reading
	// the body — for a 14 MB response that is most of it, and it is what the user
	// waits for. TTFB separates the server's thinking from the transfer.
	TotalMs Stats `json:"totalMs"`
	TTFBMs  Stats `json:"ttfbMs"`

	// Bytes is the response body size, which should not vary between samples; if
	// it does, that is recorded as a range rather than averaged away.
	BytesMin int64 `json:"bytesMin"`
	BytesMax int64 `json:"bytesMax"`

	// ContentEncoding as negotiated. A comparison between a gzipped and an
	// ungzipped run is not a comparison at all, so it is recorded.
	ContentEncoding string `json:"contentEncoding,omitempty"`

	// ETag and CacheControl, because caching behaviour is part of performance and
	// a change here explains a change in the numbers.
	ETag         string `json:"etag,omitempty"`
	CacheControl string `json:"cacheControl,omitempty"`

	// --- schema 2 ---------------------------------------------------------
	// Everything below was added after the first version of this tool produced
	// a comparison whose headline was wrong in both directions. Each field
	// exists to stop a specific way of being confidently wrong; the comments
	// say which.

	// Absent means the target answered, but not with this scenario's response —
	// the route does not exist on this build, or the capability it measures is
	// not implemented.
	//
	// This is a third state alongside "worked" and "broke", and the reason it
	// has to exist is that this server answers an unrouted /api path with 200
	// and an HTML page. Without this field those become fast successful
	// samples, and a scenario added on Tuesday appears to have existed on
	// Monday and to have been four times quicker. Absent is also the *expected*
	// state for the early revisions of a sweep, so it must not read as a fault.
	Absent       bool   `json:"absent,omitempty"`
	AbsentReason string `json:"absentReason,omitempty"`

	// ContentType as returned, recorded so a reader can check the judgement
	// above rather than take it on trust.
	ContentType string `json:"contentType,omitempty"`

	// WarmupMs summarises the requests that were made and then discarded.
	//
	// Discarding them is right — a steady-state latency is the question — but
	// discarding them *silently* hides the thing most likely to make the
	// headline meaningless. Several endpoints here are dominated by a
	// server-side cache that the first request populates, so the difference
	// between this and TotalMs is the size of the cache effect, and it belongs
	// in the record rather than in the bin.
	WarmupMs Stats `json:"warmupMs"`

	// CacheSpeedup is the first warmup request divided by the measured p50: how
	// many times faster a repeat is than a first hit. Values well above 1 mean
	// the p50 is a cache-hit measurement, and should be read as one.
	CacheSpeedup float64 `json:"cacheSpeedup,omitempty"`

	// SamplesMs are the raw measured totals, in milliseconds and in the order
	// taken.
	//
	// Kept because summary statistics cannot be tested against each other: a
	// rank-sum test needs the samples, and without one the tool can only
	// compare two medians and hope. At twenty samples this costs a couple of
	// hundred bytes per scenario, which is nothing against being able to say
	// how likely a difference is to be noise. Order is preserved so a drift
	// within a run stays visible.
	SamplesMs []float64 `json:"samplesMs,omitempty"`

	// Conditional records that this scenario measured a revalidation rather
	// than a fetch, so its timings are not comparable with a fetch of the same
	// URL.
	Conditional bool `json:"conditional,omitempty"`

	// LastError is the transport error from the final failed request, verbatim.
	//
	// Errors were previously only counted, which left a report able to say that
	// every request failed but not why — and "connection refused", "TLS
	// handshake timeout" and "context deadline exceeded" call for three
	// completely different responses from whoever reads it. Verbatim rather
	// than classified: the Go error text already names the cause, and a
	// classification would be one more thing to get wrong.
	LastError string `json:"lastError,omitempty"`
}

// Stats summarises a set of samples.
//
// Percentiles use nearest-rank on the sorted samples: with the small sample
// counts this tool runs, interpolation invents precision that is not there.
type Stats struct {
	N    int     `json:"n"`
	Min  float64 `json:"min"`
	P50  float64 `json:"p50"`
	P90  float64 `json:"p90"`
	P99  float64 `json:"p99"`
	Max  float64 `json:"max"`
	Mean float64 `json:"mean"`
}

// Summarise computes Stats from durations in milliseconds.
func Summarise(samples []float64) Stats {
	if len(samples) == 0 {
		return Stats{}
	}
	sorted := append([]float64(nil), samples...)
	sort.Float64s(sorted)

	var sum float64
	for _, v := range sorted {
		sum += v
	}

	return Stats{
		N:    len(sorted),
		Min:  sorted[0],
		P50:  percentile(sorted, 50),
		P90:  percentile(sorted, 90),
		P99:  percentile(sorted, 99),
		Max:  sorted[len(sorted)-1],
		Mean: sum / float64(len(sorted)),
	}
}

// percentile returns the nearest-rank percentile of an already sorted slice.
func percentile(sorted []float64, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	rank := int(math.Ceil(p / 100 * float64(len(sorted))))
	if rank < 1 {
		rank = 1
	}
	if rank > len(sorted) {
		rank = len(sorted)
	}
	return sorted[rank-1]
}

// Scenario returns the result for a named scenario, and whether it was present.
func (r Run) Scenario(name string) (ScenarioResult, bool) {
	for _, s := range r.Scenarios {
		if s.Name == name {
			return s, true
		}
	}
	return ScenarioResult{}, false
}

// Describe is the one-line identity of a run, used in reports and listings.
func (r Run) Describe() string {
	parts := []string{}
	if r.Label != "" {
		parts = append(parts, r.Label)
	}
	if r.Commit != "" {
		parts = append(parts, shortCommit(r.Commit))
	} else if r.ServerVersion != "" {
		parts = append(parts, r.ServerVersion)
	}
	parts = append(parts, r.StartedAt.Format("2006-01-02 15:04"))
	return strings.Join(parts, " · ")
}

func shortCommit(c string) string {
	if len(c) > 8 {
		return c[:8]
	}
	return c
}

// Filename is the stable name a run is stored under: sortable by time, and
// carrying enough identity to be recognised in a directory listing.
func (r Run) Filename() string {
	stamp := r.StartedAt.UTC().Format("20060102-150405")
	who := r.Label
	if who == "" {
		who = r.TargetKind
	}
	if r.Commit != "" {
		who += "-" + shortCommit(r.Commit)
	}
	return fmt.Sprintf("%s-%s.json", stamp, sanitise(who))
}

func sanitise(s string) string {
	var b strings.Builder
	for _, r := range strings.ToLower(s) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-', r == '_':
			b.WriteRune('-')
		default:
			b.WriteRune('-')
		}
	}
	return strings.Trim(b.String(), "-")
}

// Save writes a run to dir, creating it if needed, and returns the path.
func (r Run) Save(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create results directory: %w", err)
	}
	path := filepath.Join(dir, r.Filename())

	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return "", fmt.Errorf("encode run: %w", err)
	}
	data = append(data, '\n')

	// Written through a temporary file: a results directory is read by later
	// invocations, and a half-written file there would be a permanent, silent
	// corruption of the history this tool exists to keep.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return "", fmt.Errorf("write run: %w", err)
	}
	if err := os.Rename(tmp, path); err != nil {
		return "", fmt.Errorf("place run: %w", err)
	}
	return path, nil
}

// LoadRun reads one stored run.
func LoadRun(path string) (Run, error) {
	var run Run
	data, err := os.ReadFile(path)
	if err != nil {
		return run, fmt.Errorf("read %s: %w", path, err)
	}
	if err := json.Unmarshal(data, &run); err != nil {
		return run, fmt.Errorf("parse %s: %w", path, err)
	}
	if run.SchemaVersion > ResultsVersion {
		return run, fmt.Errorf("%s was written by a newer version of this tool (schema %d, this understands %d)",
			path, run.SchemaVersion, ResultsVersion)
	}
	return run, nil
}

// LoadRuns reads every run in a directory, oldest first.
//
// A file that cannot be read is reported and skipped rather than aborting the
// load: one corrupt file should not make the rest of the history unreadable.
func LoadRuns(dir string) ([]Run, []error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, []error{fmt.Errorf("read results directory: %w", err)}
	}

	var runs []Run
	var problems []error
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		run, err := LoadRun(filepath.Join(dir, e.Name()))
		if err != nil {
			problems = append(problems, err)
			continue
		}
		runs = append(runs, run)
	}
	sort.Slice(runs, func(i, j int) bool { return runs[i].StartedAt.Before(runs[j].StartedAt) })
	return runs, problems
}
