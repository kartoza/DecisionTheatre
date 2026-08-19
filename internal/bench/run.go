package bench

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
	"runtime"
	"sort"
	"strings"
	"time"
)

// Options control one execution of the suite.
type Options struct {
	// Target base URL, e.g. http://127.0.0.1:8080.
	Target string

	// Label is free text distinguishing this run from others.
	Label string

	// Iterations is the number of measured samples per scenario.
	Iterations int

	// Warmup requests are made and discarded before measuring. The first request
	// to a cold server pays for connection setup, page cache misses and any lazy
	// initialisation, and including it turns a latency measurement into a
	// startup measurement.
	Warmup int

	// IncludeHeavy runs the scenarios marked Heavy. Off by default: the
	// full-domain statistics request is roughly 14 MB and several seconds, and
	// running it a hundred times against production is not a benchmark, it is an
	// inconvenience for whoever is using the site.
	IncludeHeavy bool

	// HeavyIterations caps how many samples a heavy scenario takes, however high
	// Iterations is.
	HeavyIterations int

	// Timeout per request.
	Timeout time.Duration

	// Commit metadata, when the caller built the target from source.
	Commit      string
	CommitDate  string
	CommitTitle string

	// Progress is called as scenarios complete, for a command line that would
	// otherwise sit silent for minutes.
	Progress func(done, total int, s Scenario)

	// Shuffle randomises the order scenarios run in, seeded from ShuffleSeed.
	//
	// Off by default, and the reasoning is worth stating because the intuitive
	// answer is the wrong one. Scenarios do interfere: a four-second, 1.8 MB
	// query leaves the page cache, the SQLite cache and the Go heap in a state
	// the next scenario inherits. That is a bias. But this tool's output is
	// almost always a *difference* between two runs, and a bias that is
	// identical on both sides of a subtraction cancels; a randomised order
	// gives each run a different bias, which does not cancel and instead
	// inflates the variance of every comparison.
	//
	// So the fixed order is kept for comparing, and this exists to answer the
	// separate question "does order matter here at all" by running both ways
	// and looking. Turning it on for one side of a comparison and not the other
	// is the one thing that would be worse than either.
	Shuffle     bool
	ShuffleSeed int64

	// SettleTimeout bounds how long Execute waits for the target to stop
	// getting faster before it starts measuring. Zero uses a default; a
	// negative value skips settling entirely, which is only correct for a
	// target that has been up for a while.
	SettleTimeout time.Duration

	// Log receives methodology notes as they are decided — what settled when,
	// which scenario turned out to be absent. Optional.
	Log func(format string, args ...any)
}

func (o *Options) applyDefaults() {
	if o.Iterations <= 0 {
		o.Iterations = 20
	}
	// A warmup of zero means zero.
	//
	// It used to be silently promoted to three, which made "--warmup 0"
	// impossible to express — and that flag is the only way to ask the question
	// "how expensive is the first request", which for several scenarios here is
	// the difference between 22 ms and 0.5 ms. Negative now means "use the
	// default"; zero is honoured.
	if o.Warmup < 0 {
		o.Warmup = 3
	}
	if o.HeavyIterations <= 0 {
		o.HeavyIterations = 3
	}
	if o.Timeout <= 0 {
		o.Timeout = 120 * time.Second
	}
	if o.SettleTimeout == 0 {
		// Long enough for the grid geometry cache, which was measured at 12.5 s
		// on the real datapack, plus room for a slower disk. A sweep pays this
		// once per revision and it is cheap against a full build.
		o.SettleTimeout = 90 * time.Second
	}
	if o.Log == nil {
		o.Log = func(string, ...any) {}
	}
	if o.Shuffle && o.ShuffleSeed == 0 {
		o.ShuffleSeed = time.Now().UnixNano()
	}
}

// logf writes a methodology note, tolerating an unset Log.
//
// applyDefaults installs a no-op, but runScenario is reachable without it — from
// a test, or from any future caller that builds Options directly — and three
// call sites dereferenced the callback unconditionally. Absence detection made
// one of those reachable: a scenario the target answers with the SPA fallback
// took the absent branch and segfaulted before it could record why.
func (o *Options) logf(format string, args ...any) {
	if o.Log != nil {
		o.Log(format, args...)
	}
}

// Execute runs the suite and returns the result.
//
// Requests are issued one at a time. This measures latency, which is the
// question being asked — how long does a user wait — and not throughput. Running
// them concurrently would measure the machine's ability to saturate the server,
// which is a different question and one this tool does not claim to answer.
func Execute(ctx context.Context, opts Options) (Run, error) {
	opts.applyDefaults()

	if strings.TrimSpace(opts.Target) == "" {
		return Run{}, fmt.Errorf("no target given")
	}
	if _, err := url.Parse(opts.Target); err != nil {
		return Run{}, fmt.Errorf("target %q is not a URL: %w", opts.Target, err)
	}

	client := &http.Client{
		Timeout: opts.Timeout,
		// Redirects are followed by default; a target that redirects is measuring
		// the redirect too, which is honest — that is what a client experiences.
	}

	started := time.Now()
	run := Run{
		SchemaVersion: ResultsVersion,
		Label:         opts.Label,
		Target:        strings.TrimRight(opts.Target, "/"),
		TargetKind:    targetKind(opts.Target),
		StartedAt:     started,
		Iterations:    opts.Iterations,
		Warmup:        opts.Warmup,
		Commit:        opts.Commit,
		CommitDate:    opts.CommitDate,
		CommitTitle:   opts.CommitTitle,
		Host:          hostDescription(),
	}

	run.ServerVersion = serverVersion(ctx, client, run.Target)
	switch run.ServerVersion {
	case "":
		run.Notes = append(run.Notes,
			"The target did not report a version, so these results cannot be attributed to a build.")
	case "dev":
		run.Notes = append(run.Notes,
			`The target reports its version as "dev", which means it was built without a version stamped in. `+
				"Results can be compared with each other but not attributed to a release.")
	}

	run.GoVersion = runtime.Version()

	// Settle before measuring anything. See settle.go: /api/health answers
	// before the server is ready, so anything measured immediately after it is
	// partly a measurement of the startup work still in flight.
	if opts.SettleTimeout > 0 {
		st := Settle(ctx, client, run.Target, opts.SettleTimeout, opts.Log)
		run.SettleSeconds = st.Waited.Seconds()
		run.Settled = st.Settled
		run.Notes = append(run.Notes, st.Note)
	} else {
		// Recorded as unsettled rather than silently settled: a run that skipped
		// the check has not established that the target was warm, and the
		// difference matters to whoever reads it later.
		run.Notes = append(run.Notes,
			"Settling was skipped, so nothing establishes that the target had finished starting up. "+
				"On a freshly launched server the most expensive query in this suite costs 2.4x its steady-state "+
				"figure for the first 12 seconds.")
	}

	// The round-trip floor, measured before and after the suite. Before, so it
	// can be subtracted; after, so a machine that did not hold still during the
	// run says so.
	floorBefore := measureFloor(ctx, client, run.Target)
	run.FloorMs = floorBefore

	scenarios := Scenarios()

	// Coverage, computed from the suite rather than declared by it. Recorded in
	// every run so a report can say what was not looked at; see coverage.go.
	run.Coverage = MeasureCoverage(scenarios)
	run.Notes = append(run.Notes, "Route coverage: "+run.Coverage.Describe())

	// Order. Fixed by default so that whatever interference exists is the same
	// on both sides of a later subtraction — see Options.Shuffle for why the
	// obvious alternative is worse.
	if opts.Shuffle {
		r := rand.New(rand.NewSource(opts.ShuffleSeed))
		r.Shuffle(len(scenarios), func(i, j int) { scenarios[i], scenarios[j] = scenarios[j], scenarios[i] })
		run.ShuffleSeed = opts.ShuffleSeed
		run.Notes = append(run.Notes, fmt.Sprintf(
			"Scenario order was randomised (seed %d). Comparing a shuffled run against an unshuffled one adds "+
				"the ordering difference to whatever else changed.", opts.ShuffleSeed))
	}
	for _, s := range scenarios {
		run.ScenarioOrder = append(run.ScenarioOrder, s.Name)
	}

	for i, s := range scenarios {
		result := runScenario(ctx, client, run.Target, s, opts)
		run.Scenarios = append(run.Scenarios, result)
		if opts.Progress != nil {
			opts.Progress(i+1, len(scenarios), s)
		}
		if ctx.Err() != nil {
			run.Notes = append(run.Notes, "Interrupted before the suite finished; later scenarios are missing.")
			break
		}
	}

	// Results are stored in the declared order regardless of the order they were
	// run in, so that two runs line up in a report without the reader having to
	// think about it. ScenarioOrder keeps the truth about execution.
	sortScenariosAsDeclared(run.Scenarios)

	// Absence is collected into a note as well as recorded per scenario.
	//
	// The command line prints scenarios that produced no samples as "no
	// successful samples", which reads as a fault and is the wrong sentence for
	// a capability the build simply does not have. Until that wording lives
	// somewhere this file owns, the note carries the distinction so it is at
	// least visible without opening the JSON.
	var absent []string
	for _, s := range run.Scenarios {
		if s.Absent {
			absent = append(absent, s.Name)
		}
	}
	if len(absent) > 0 {
		run.Notes = append(run.Notes, fmt.Sprintf(
			"%d scenario(s) are not available on this build rather than broken by it: %s. Each one records why "+
				"in its absentReason. In a comparison these are reported as absent or added, never as a speed "+
				"change, because a route that does not exist answers faster than one that does.",
			len(absent), strings.Join(absent, ", ")))
	}

	floorAfter := measureFloor(ctx, client, run.Target)
	if floorBefore > 0 && floorAfter > 0 {
		run.FloorDriftPercent = (floorAfter - floorBefore) / floorBefore * 100
		if math.Abs(run.FloorDriftPercent) > 50 {
			run.Notes = append(run.Notes, fmt.Sprintf(
				"The round-trip floor moved %+.0f%% between the start and the end of this run (%.3f ms to %.3f ms). "+
					"Something else on this machine changed while it was measuring, so treat differences of that "+
					"order as unexplained rather than as results.",
				run.FloorDriftPercent, floorBefore, floorAfter))
		}
	}

	if run.TargetKind == "remote" && run.FloorMs > 1 {
		run.Notes = append(run.Notes, fmt.Sprintf(
			"The round trip to this target is %.0f ms. Every scenario below contains it, and for the cheap ones it "+
				"is essentially the whole number — those totals describe the network, not the server's code.",
			run.FloorMs))
	}

	run.Duration = time.Since(started)
	return run, nil
}

// measureFloor times the cheapest scenario in the suite, which by construction
// has no work behind it, and returns its median in milliseconds.
//
// Deliberately not derived from the health scenario's own result: it is taken
// before the suite starts and again after it finishes, and those two points are
// what make it useful.
func measureFloor(ctx context.Context, client *http.Client, base string) float64 {
	const n = 15
	s := Scenario{Name: "floor", Path: "/api/health"}
	target, err := s.URL(base)
	if err != nil {
		return 0
	}
	var got []float64
	for i := 0; i < n; i++ {
		if ctx.Err() != nil {
			break
		}
		sm, err := once(ctx, client, s, target, nil)
		if err != nil || sm.status >= 400 {
			continue
		}
		// The first few are discarded here as everywhere else; a floor that
		// includes connection setup is not the floor.
		if i >= 3 {
			got = append(got, float64(sm.total.Microseconds())/1000)
		}
	}
	return Summarise(got).P50
}

// sortScenariosAsDeclared restores the suite's declared order.
func sortScenariosAsDeclared(results []ScenarioResult) {
	rank := map[string]int{}
	for i, s := range Scenarios() {
		rank[s.Name] = i
	}
	sort.SliceStable(results, func(i, j int) bool {
		return rank[results[i].Name] < rank[results[j].Name]
	})
}

func runScenario(ctx context.Context, client *http.Client, base string, s Scenario, opts Options) ScenarioResult {
	res := ScenarioResult{
		Name:         s.Name,
		Group:        s.Group,
		Why:          s.Why,
		StatusCounts: map[int]int{},
	}

	target, err := s.URL(base)
	if err != nil {
		res.Skipped = true
		res.SkippedReason = err.Error()
		return res
	}
	res.URL = target

	if s.Heavy && !opts.IncludeHeavy {
		res.Skipped = true
		res.SkippedReason = "heavy scenario; run with --heavy to include it"
		return res
	}

	iterations := opts.Iterations
	if s.Heavy && iterations > opts.HeavyIterations {
		iterations = opts.HeavyIterations
	}

	// A body that has to be built from the target — a tour posts its own site
	// document back. A failure here means the document is not on this build,
	// which is an absence rather than a fault: in a sweep it is exactly what an
	// older revision should report.
	if s.Prepare != nil {
		body, err := s.Prepare(ctx, client, base)
		if err != nil {
			res.Absent = true
			res.AbsentReason = err.Error()
			opts.logf("  %s: %s", s.Name, err)
			return res
		}
		s.Body = body
	}

	// A conditional scenario needs a validator before it can measure anything,
	// and if the server will not give it one there is nothing here to time.
	var extra map[string]string
	if s.Conditional {
		res.Conditional = true
		headers, reason := conditionalHeaders(ctx, client, s, target)
		if headers == nil {
			res.Absent = true
			res.AbsentReason = reason
			opts.logf("  %s: %s", s.Name, reason)
			return res
		}
		extra = headers
	}

	// Warmup is discarded from the reported distribution but not from the
	// record. Failures here are not counted as errors — a server that is still
	// starting is not a result — but the timings are kept, because the gap
	// between the first request and the steady state is the size of whatever
	// cache sits behind this endpoint, and hiding it is how a cache-hit
	// measurement gets quoted as a request measurement.
	var warmups []float64
	for i := 0; i < opts.Warmup; i++ {
		if ctx.Err() != nil {
			break
		}
		sm, err := sampleOnce(ctx, client, s, base, target, extra)
		if err == nil && sm.status < 400 {
			warmups = append(warmups, float64(sm.total.Microseconds())/1000)
		}
	}
	res.WarmupMs = Summarise(warmups)

	totals := make([]float64, 0, iterations)
	ttfbs := make([]float64, 0, iterations)
	res.BytesMin = -1
	absentReasons := 0
	var lastReason string

	for i := 0; i < iterations; i++ {
		if ctx.Err() != nil {
			break
		}
		sample, err := sampleOnce(ctx, client, s, base, target, extra)
		if err != nil {
			res.Errors++
			// Kept verbatim so a report can say why, not merely how many.
			res.LastError = err.Error()
			continue
		}

		res.StatusCounts[sample.status]++
		if sample.contentType != "" {
			res.ContentType = sample.contentType
		}

		// A conditional scenario is only measuring what it claims to measure if
		// the server actually revalidates. Anything else is a full response
		// wearing a conditional request's clothes, and timing it would report
		// the cost of not having the feature as though it were the cost of
		// having it.
		if s.Conditional {
			if sample.status != http.StatusNotModified {
				absentReasons++
				lastReason = fmt.Sprintf(
					"the request carried a validator and the server answered %d with a full %d-byte body instead of "+
						"304, so this build does not revalidate: the saving is unavailable, not measured as zero",
					sample.status, sample.bytes)
				continue
			}
		} else {
			ok, absent, reason := s.checkResponse(sample.status, sample.contentType, sample.bytes)
			if !ok {
				lastReason = reason
				if absent {
					absentReasons++
				} else {
					// Counted, and not mixed into the timings: a fast 404 would
					// otherwise read as an improvement.
					res.Errors++
				}
				continue
			}
		}

		totals = append(totals, float64(sample.total.Microseconds())/1000)
		ttfbs = append(ttfbs, float64(sample.ttfb.Microseconds())/1000)

		if res.BytesMin < 0 || sample.bytes < res.BytesMin {
			res.BytesMin = sample.bytes
		}
		if sample.bytes > res.BytesMax {
			res.BytesMax = sample.bytes
		}
		if sample.encoding != "" {
			res.ContentEncoding = sample.encoding
		}
		if sample.etag != "" {
			res.ETag = sample.etag
		}
		if sample.cacheControl != "" {
			res.CacheControl = sample.cacheControl
		}
	}

	// Nothing usable came back and the reason was absence rather than failure.
	// Reporting that as "broken" would put a fault against a revision whose only
	// crime is predating the feature.
	if len(totals) == 0 && absentReasons > 0 {
		res.Absent = true
		res.AbsentReason = lastReason
		res.BytesMin = 0
		opts.logf("  %s: %s", s.Name, lastReason)
		return res
	}

	if res.BytesMin < 0 {
		res.BytesMin = 0
	}
	res.Samples = len(totals)
	res.SamplesMs = totals
	res.TotalMs = Summarise(totals)
	res.TTFBMs = Summarise(ttfbs)

	// How much faster a repeat is than a first hit. Reported rather than acted
	// on: for most of this suite a cache hit is genuinely what a user gets, so
	// suppressing the cache would measure a situation that does not occur. What
	// would be dishonest is presenting the hit as if it were the whole cost, and
	// this number is what stops that.
	if res.WarmupMs.N > 0 && res.TotalMs.P50 > 0 {
		res.CacheSpeedup = res.WarmupMs.Min / res.TotalMs.P50
	}

	return res
}

// conditionalHeaders primes a conditional scenario, returning the request
// headers that will make every measured request a revalidation.
//
// Returns nil, and a reason a human can act on, when the server offers nothing
// to revalidate against. At the time of writing that is every endpoint on this
// server: no handler sets an ETag and only the static file routes carry a
// Last-Modified. That is a finding, not an error, so it is worded as one.
func conditionalHeaders(ctx context.Context, client *http.Client, s Scenario, target string) (map[string]string, string) {
	sm, err := once(ctx, client, s, target, nil)
	if err != nil {
		return nil, fmt.Sprintf("could not fetch the resource to revalidate: %v", err)
	}
	if sm.status >= 400 {
		return nil, fmt.Sprintf("the resource to revalidate answered HTTP %d", sm.status)
	}
	if ok, _, reason := s.checkResponse(sm.status, sm.contentType, sm.bytes); !ok {
		return nil, reason
	}

	switch {
	case sm.etag != "":
		return map[string]string{"If-None-Match": sm.etag}, ""
	case sm.lastModified != "":
		return map[string]string{"If-Modified-Since": sm.lastModified}, ""
	default:
		return nil, fmt.Sprintf(
			"this build sends no ETag and no Last-Modified for %s, so a client that already holds the response "+
				"cannot ask whether it is still current and must refetch all %d bytes. The saving a conditional "+
				"request would give is therefore unavailable on this build rather than measured as zero",
			s.Path, sm.bytes)
	}
}

// sampleOnce produces one sample, which for most scenarios is one request and
// for a sequence scenario is the sum of several.
//
// Summing is the whole point of a sequence — see Scenario.Sequence — so the
// pieces are deliberately not reported individually. What is kept from the
// parts is the worst of them: the first failing status wins, so a sequence in
// which one endpoint 404s does not average into a healthy-looking total.
func sampleOnce(ctx context.Context, client *http.Client, s Scenario, base, target string, extra map[string]string) (sample, error) {
	out, err := once(ctx, client, s, target, extra)
	if err != nil || len(s.Sequence) == 0 {
		return out, err
	}

	for _, p := range s.Sequence {
		step := Scenario{Name: s.Name, Path: p, ContentType: s.ContentType}
		stepTarget, err := step.URL(base)
		if err != nil {
			return out, err
		}
		next, err := once(ctx, client, step, stepTarget, extra)
		if err != nil {
			return out, err
		}

		out.total += next.total
		out.ttfb += next.ttfb
		out.bytes += next.bytes
		// A sequence is only as healthy as its unhealthiest member.
		if next.status >= out.status {
			out.status = next.status
		}
		if next.contentType != "" && out.contentType == "" {
			out.contentType = next.contentType
		}
	}
	return out, nil
}

type sample struct {
	status       int
	total        time.Duration
	ttfb         time.Duration
	bytes        int64
	encoding     string
	etag         string
	cacheControl string
	contentType  string
	lastModified string
}

// once issues one request and measures it.
//
// Accept-Encoding is set explicitly. Left alone, Go's transport adds gzip and
// transparently decompresses, which would report the decompressed size — and the
// number that matters for a 14 MB response is what crossed the network. Setting
// the header disables that transparency, so the bytes counted are wire bytes.
func once(ctx context.Context, client *http.Client, s Scenario, target string, extra map[string]string) (sample, error) {
	var out sample

	var body io.Reader
	if s.Body != "" {
		body = strings.NewReader(s.Body)
	}

	req, err := http.NewRequestWithContext(ctx, s.HTTPMethod(), target, body)
	if err != nil {
		return out, err
	}
	req.Header.Set("Accept-Encoding", "gzip")
	if s.Body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	// Conditional headers, when the scenario is measuring a revalidation.
	for k, v := range extra {
		req.Header.Set(k, v)
	}

	var firstByte time.Time
	trace := &httptrace.ClientTrace{
		GotFirstResponseByte: func() { firstByte = time.Now() },
	}
	req = req.WithContext(httptrace.WithClientTrace(req.Context(), trace))

	start := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return out, err
	}
	defer func() { _ = resp.Body.Close() }()

	n, err := io.Copy(io.Discard, resp.Body)
	if err != nil {
		return out, err
	}
	out.total = time.Since(start)
	if !firstByte.IsZero() {
		out.ttfb = firstByte.Sub(start)
	}

	out.status = resp.StatusCode
	out.bytes = n
	out.encoding = resp.Header.Get("Content-Encoding")
	out.etag = resp.Header.Get("ETag")
	out.cacheControl = resp.Header.Get("Cache-Control")
	out.contentType = resp.Header.Get("Content-Type")
	out.lastModified = resp.Header.Get("Last-Modified")
	return out, nil
}

// serverVersion asks the target what build it is. Best effort: a target that
// cannot say is recorded as such rather than guessed at.
func serverVersion(ctx context.Context, client *http.Client, base string) string {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/info", nil)
	if err != nil {
		return ""
	}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return ""
	}

	var info struct {
		Version string `json:"version"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil {
		return ""
	}
	return info.Version
}

func targetKind(target string) string {
	u, err := url.Parse(target)
	if err != nil {
		return "unknown"
	}
	host := u.Hostname()
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return "local"
	}
	return "remote"
}

func hostDescription() string {
	name, err := os.Hostname()
	if err != nil {
		return ""
	}
	return name
}
