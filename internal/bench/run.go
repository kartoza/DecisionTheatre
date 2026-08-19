package bench

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"net/url"
	"os"
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
}

func (o *Options) applyDefaults() {
	if o.Iterations <= 0 {
		o.Iterations = 20
	}
	if o.Warmup < 0 {
		o.Warmup = 0
	}
	if o.Warmup == 0 {
		o.Warmup = 3
	}
	if o.HeavyIterations <= 0 {
		o.HeavyIterations = 3
	}
	if o.Timeout <= 0 {
		o.Timeout = 120 * time.Second
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
	if run.ServerVersion == "" {
		run.Notes = append(run.Notes,
			"The target did not report a version, so these results cannot be attributed to a build.")
	} else if run.ServerVersion == "dev" {
		run.Notes = append(run.Notes,
			`The target reports its version as "dev", which means it was built without a version stamped in. `+
				"Results can be compared with each other but not attributed to a release.")
	}

	scenarios := Scenarios()
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

	run.Duration = time.Since(started)
	return run, nil
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

	// Warmup is discarded. Failures here are not counted either — a server that
	// is still starting is not a result.
	for i := 0; i < opts.Warmup; i++ {
		if ctx.Err() != nil {
			break
		}
		_, _ = once(ctx, client, s, target)
	}

	totals := make([]float64, 0, iterations)
	ttfbs := make([]float64, 0, iterations)
	res.BytesMin = -1

	for i := 0; i < iterations; i++ {
		if ctx.Err() != nil {
			break
		}
		sample, err := once(ctx, client, s, target)
		if err != nil {
			res.Errors++
			continue
		}

		res.StatusCounts[sample.status]++
		if sample.status >= 400 {
			// Counted, and not mixed into the timings: a fast 404 would otherwise
			// read as an improvement.
			res.Errors++
			continue
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

	if res.BytesMin < 0 {
		res.BytesMin = 0
	}
	res.Samples = len(totals)
	res.TotalMs = Summarise(totals)
	res.TTFBMs = Summarise(ttfbs)
	return res
}

type sample struct {
	status       int
	total        time.Duration
	ttfb         time.Duration
	bytes        int64
	encoding     string
	etag         string
	cacheControl string
}

// once issues one request and measures it.
//
// Accept-Encoding is set explicitly. Left alone, Go's transport adds gzip and
// transparently decompresses, which would report the decompressed size — and the
// number that matters for a 14 MB response is what crossed the network. Setting
// the header disables that transparency, so the bytes counted are wire bytes.
func once(ctx context.Context, client *http.Client, s Scenario, target string) (sample, error) {
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
