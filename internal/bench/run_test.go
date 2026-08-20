package bench

import (
	"bytes"
	"compress/gzip"
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// testClient is the client the runner is given in these tests. Its timeout is
// short so a hanging server fails the test in seconds rather than at the Go test
// binary's ten-minute limit.
func testClient(timeout time.Duration) *http.Client {
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &http.Client{Timeout: timeout}
}

// probe is the scenario used wherever the scenario itself is not the subject.
var probe = Scenario{Name: "probe", Group: "Test", Path: "/probe", Why: "under test"}

// fastOptions keeps the runner from spending real time: warmup and iteration
// counts are chosen per test, never the production defaults.
func fastOptions(iterations, warmup int) Options {
	o := Options{Iterations: iterations, Warmup: warmup, HeavyIterations: 1, Timeout: 5 * time.Second}
	// Normalised the same way Execute normalises them, so these tests exercise
	// the option handling the command line actually gets rather than a
	// half-populated struct that only tests ever see.
	o.applyDefaults()
	o.SettleTimeout = 0 // runScenario never settles; keep the tests instant.
	return o
}

// ---------------------------------------------------------------------------
// Warmup

// Warmup requests must be issued and then thrown away. Guards against the
// regression that turns a latency measurement into a startup measurement: the
// first request to a cold server pays for connection setup and lazy
// initialisation, and counting it makes every run's p99 a lie.
func TestWarmupRequestsAreIssuedAndThenExcludedFromTheStatistics(t *testing.T) {
	var requests int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt64(&requests, 1)
		// The warmup requests are made slow and the measured ones fast. If warmup
		// leaked into the statistics the maximum would be far above 5 ms.
		if n <= 3 {
			time.Sleep(60 * time.Millisecond)
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL, probe, fastOptions(5, 3))

	if got := atomic.LoadInt64(&requests); got != 8 {
		t.Errorf("server saw %d requests, want 3 warmup + 5 measured = 8", got)
	}
	if res.Samples != 5 {
		t.Errorf("Samples = %d, want 5: warmup must not be counted", res.Samples)
	}
	if res.TotalMs.N != 5 {
		t.Errorf("TotalMs.N = %d, want 5", res.TotalMs.N)
	}
	if res.TotalMs.Max >= 60 {
		t.Errorf("TotalMs.Max = %.1f ms, which is a warmup sample leaking into the statistics", res.TotalMs.Max)
	}
}

// A warmup request that fails must not be counted as an error: a server that is
// still starting is not a result. Guards against a cold start being reported as
// a broken scenario.
func TestAFailingWarmupRequestIsNotCountedAsAnError(t *testing.T) {
	var requests int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt64(&requests, 1) <= 2 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL, probe, fastOptions(4, 2))

	if res.Errors != 0 {
		t.Errorf("Errors = %d, want 0: the failures were in warmup", res.Errors)
	}
	if res.Samples != 4 {
		t.Errorf("Samples = %d, want 4", res.Samples)
	}
	if res.StatusCounts[http.StatusServiceUnavailable] != 0 {
		t.Errorf("a warmup status was recorded in StatusCounts: %v", res.StatusCounts)
	}
}

// ---------------------------------------------------------------------------
// Failure

// This is the behaviour the whole tool rests on. A scenario that answers 404 to
// every request is fast — far faster than the working version — and if those
// timings were recorded the report would call it an improvement. Guards against
// a fast failure being read as a win.
func TestAScenarioThatAnswersNotFoundEveryTimeRecordsNoTimings(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL, probe, fastOptions(6, 1))

	if res.Samples != 0 {
		t.Errorf("Samples = %d, want 0: a 404 is not a measurement", res.Samples)
	}
	if res.Errors != 6 {
		t.Errorf("Errors = %d, want 6", res.Errors)
	}
	if res.StatusCounts[http.StatusNotFound] != 6 {
		t.Errorf("StatusCounts = %v, want six 404s recorded", res.StatusCounts)
	}
	if res.TotalMs != (Stats{}) || res.TTFBMs != (Stats{}) {
		t.Errorf("timings were recorded for a scenario that only ever 404s: %+v", res.TotalMs)
	}
}

// The same behaviour, carried all the way through to the verdict a reader is
// given. This is the single most important assertion in the suite: a scenario
// that broke between two runs must be named as broken, must not be counted as
// faster, and must not be able to become the report's headline win.
func TestAScenarioThatStartedFailingIsCalledBrokenAndNeverAnImprovement(t *testing.T) {
	working := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(20 * time.Millisecond)
		_, _ = w.Write(bytes.Repeat([]byte("x"), 4096))
	}))
	defer working.Close()

	broken := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer broken.Close()

	opts := fastOptions(4, 1)
	base := Run{Scenarios: []ScenarioResult{
		runScenario(context.Background(), testClient(0), working.URL, probe, opts)}}
	cur := Run{Scenarios: []ScenarioResult{
		runScenario(context.Background(), testClient(0), broken.URL, probe, opts)}}

	if base.Scenarios[0].TotalMs.P50 <= 0 {
		t.Fatal("the baseline recorded no time, so the test cannot prove anything")
	}

	c := Compare(base, cur)
	if len(c.Deltas) != 1 {
		t.Fatalf("got %d deltas, want 1", len(c.Deltas))
	}
	d := c.Deltas[0]

	if d.Verdict != Broken {
		t.Errorf("verdict = %q, want %q: every request 404s in the current run", d.Verdict, Broken)
	}
	if d.Caveat == "" {
		t.Error("a broken scenario carries no caveat, so a reader is not told why the number is missing")
	}

	h := c.Summarise()
	if h.Faster != 0 {
		t.Errorf("Faster = %d, want 0: a scenario that stopped working is not an improvement", h.Faster)
	}
	if h.Broken != 1 {
		t.Errorf("Broken = %d, want 1", h.Broken)
	}
	if h.BiggestWin != nil {
		t.Errorf("BiggestWin = %q, want none: the only change is a failure", h.BiggestWin.Name)
	}
}

// Partial failure must be counted rather than averaged away. Guards against a
// scenario that fails half the time reporting a clean median over the half that
// worked, with nothing in the result to say the rest failed.
func TestPartialFailuresAreCountedAndKeptOutOfTheTimings(t *testing.T) {
	var requests int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if atomic.AddInt64(&requests, 1)%2 == 0 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL, probe, fastOptions(10, 0))

	if res.Samples+res.Errors != 10 {
		t.Errorf("Samples(%d) + Errors(%d) = %d, want 10: every attempt must be accounted for",
			res.Samples, res.Errors, res.Samples+res.Errors)
	}
	if res.Errors == 0 {
		t.Error("Errors = 0, but half the responses were 500")
	}
	if res.StatusCounts[http.StatusInternalServerError] != res.Errors {
		t.Errorf("StatusCounts = %v, want the 500s recorded alongside Errors = %d", res.StatusCounts, res.Errors)
	}
	if res.TotalMs.N != res.Samples {
		t.Errorf("TotalMs.N = %d but Samples = %d: the statistics disagree with the count",
			res.TotalMs.N, res.Samples)
	}
}

// A request that exceeds the timeout must be recorded as an error rather than as
// a very slow sample or a panic. Guards against a hung endpoint producing a
// plausible-looking timing.
func TestARequestThatTimesOutIsRecordedAsAnErrorRatherThanASlowSample(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	defer srv.Close()
	defer close(release)

	opts := fastOptions(2, 0)
	opts.Timeout = 100 * time.Millisecond

	res := runScenario(context.Background(), testClient(opts.Timeout), srv.URL, probe, opts)

	if res.Samples != 0 {
		t.Errorf("Samples = %d, want 0: nothing completed", res.Samples)
	}
	if res.Errors != 2 {
		t.Errorf("Errors = %d, want 2", res.Errors)
	}
	if len(res.StatusCounts) != 0 {
		t.Errorf("StatusCounts = %v, want empty: no response ever arrived", res.StatusCounts)
	}
}

// A server that closes the connection mid-response must be an error, not a
// truncated measurement. Guards against io.Copy's error being ignored and a
// short body being recorded as a real, small, fast response.
func TestAServerThatClosesTheConnectionMidResponseIsRecordedAsAnError(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = listener.Close() }()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			// Promise ten kilobytes, send a hundred bytes, hang up.
			_, _ = conn.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 10240\r\n\r\n"))
			_, _ = conn.Write(bytes.Repeat([]byte("x"), 100))
			_ = conn.Close()
		}
	}()

	base := "http://" + listener.Addr().String()
	res := runScenario(context.Background(), testClient(2*time.Second), base, probe, fastOptions(3, 0))

	_ = listener.Close()
	<-done

	if res.Samples != 0 {
		t.Errorf("Samples = %d, want 0: the body never arrived in full", res.Samples)
	}
	if res.Errors != 3 {
		t.Errorf("Errors = %d, want 3", res.Errors)
	}
	if res.BytesMax != 0 {
		t.Errorf("BytesMax = %d, want 0: a truncated body is not a size measurement", res.BytesMax)
	}
}

// A cancelled context must stop between requests and keep what it has. Guards
// against Ctrl-C during a sweep losing everything measured so far.
func TestACancelledRunStopsBetweenRequestsWithoutLosingWhatItHas(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	res := runScenario(ctx, testClient(0), srv.URL, probe, fastOptions(5, 1))

	if res.Samples != 0 || res.Errors != 0 {
		t.Errorf("a cancelled run recorded Samples = %d, Errors = %d, want 0 and 0", res.Samples, res.Errors)
	}
	if res.Name != probe.Name {
		t.Errorf("a cancelled run lost the scenario's identity: %+v", res)
	}
}

// ---------------------------------------------------------------------------
// Bytes and headers

// The size recorded must be the bytes that crossed the network. Go's transport
// will add Accept-Encoding and transparently decompress unless the header is set
// explicitly, and that would report the decompressed size — for the 14 MB
// scenario that is the difference between a payload win and no change at all.
func TestBytesRecordedForAGzippedResponseAreTheWireBytesNotTheDecompressedSize(t *testing.T) {
	plain := bytes.Repeat([]byte("decision theatre "), 4096) // ~68 KB, highly compressible

	var compressed bytes.Buffer
	zw := gzip.NewWriter(&compressed)
	if _, err := zw.Write(plain); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	wire := compressed.Bytes()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			t.Errorf("the runner did not ask for gzip: Accept-Encoding = %q", r.Header.Get("Accept-Encoding"))
		}
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("ETag", `W/"deadbeef"`)
		w.Header().Set("Cache-Control", "public, max-age=60")
		_, _ = w.Write(wire)
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL, probe, fastOptions(3, 0))

	if res.Samples != 3 {
		t.Fatalf("Samples = %d, want 3", res.Samples)
	}
	if int(res.BytesMax) != len(wire) {
		t.Errorf("BytesMax = %d, want the compressed wire size %d", res.BytesMax, len(wire))
	}
	if int(res.BytesMax) == len(plain) {
		t.Errorf("BytesMax = %d, which is the decompressed size: the transport decompressed transparently",
			res.BytesMax)
	}
	if len(wire) >= len(plain) {
		t.Fatal("the fixture did not compress, so this test proves nothing")
	}
	if res.ContentEncoding != "gzip" {
		t.Errorf("ContentEncoding = %q, want gzip: a gzipped run compared with an ungzipped one is not a comparison",
			res.ContentEncoding)
	}
	if res.ETag != `W/"deadbeef"` {
		t.Errorf("ETag = %q, want the header the server sent", res.ETag)
	}
	if res.CacheControl != "public, max-age=60" {
		t.Errorf("CacheControl = %q, want the header the server sent", res.CacheControl)
	}
}

// A response size that varies between samples must be recorded as a range rather
// than averaged away. Guards against a payload that grew for some requests being
// invisible in the result.
func TestAResponseSizeThatVariesIsRecordedAsARange(t *testing.T) {
	var requests int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := atomic.AddInt64(&requests, 1)
		_, _ = w.Write(bytes.Repeat([]byte("x"), int(n)*100))
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL, probe, fastOptions(4, 0))

	if res.BytesMin != 100 {
		t.Errorf("BytesMin = %d, want 100", res.BytesMin)
	}
	if res.BytesMax != 400 {
		t.Errorf("BytesMax = %d, want 400", res.BytesMax)
	}
}

// An empty body must record zero bytes rather than the sentinel the runner uses
// internally. Guards against -1 reaching a report as "-1 B".
func TestAnEmptyResponseRecordsZeroBytesRatherThanTheInternalSentinel(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL, probe, fastOptions(2, 0))

	if res.BytesMin < 0 || res.BytesMax < 0 {
		t.Errorf("byte range is negative: %d..%d", res.BytesMin, res.BytesMax)
	}
}

// A scenario that never produced a successful sample must still report zero
// bytes, not the -1 sentinel. Guards against the sentinel escaping when every
// request failed.
func TestAScenarioWithNoSuccessfulSamplesReportsZeroBytes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "gone", http.StatusGone)
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL, probe, fastOptions(2, 0))

	if res.BytesMin != 0 || res.BytesMax != 0 {
		t.Errorf("byte range = %d..%d, want 0..0", res.BytesMin, res.BytesMax)
	}
}

// TTFB must separate the server's thinking from the transfer, and must never
// exceed the total. Guards against the two being measured from different clocks.
func TestTimeToFirstByteIsMeasuredAndNeverExceedsTheTotal(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(30 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		time.Sleep(30 * time.Millisecond)
		_, _ = w.Write([]byte("body"))
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL, probe, fastOptions(3, 1))

	if res.TTFBMs.N != res.TotalMs.N {
		t.Fatalf("TTFB has %d samples and total has %d", res.TTFBMs.N, res.TotalMs.N)
	}
	if res.TTFBMs.P50 > res.TotalMs.P50 {
		t.Errorf("TTFB p50 %.1f ms exceeds total p50 %.1f ms", res.TTFBMs.P50, res.TotalMs.P50)
	}
	if res.TTFBMs.P50 <= 0 {
		t.Error("TTFB was not measured at all")
	}
}

// ---------------------------------------------------------------------------
// Scenario handling

// A heavy scenario must be skipped unless asked for, and must say why. Guards
// against the 14 MB full-domain query being run against production by anyone who
// types `dtbench run` without reading the flags.
func TestAHeavyScenarioIsSkippedWithAReasonUnlessAskedFor(t *testing.T) {
	var requests int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&requests, 1)
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	heavy := Scenario{Name: "heavy", Group: "Statistics", Path: "/heavy", Heavy: true}

	res := runScenario(context.Background(), testClient(0), srv.URL, heavy, fastOptions(5, 1))

	if !res.Skipped {
		t.Error("a heavy scenario ran without --heavy")
	}
	if !strings.Contains(res.SkippedReason, "--heavy") {
		t.Errorf("SkippedReason = %q, want it to say how to include the scenario", res.SkippedReason)
	}
	if got := atomic.LoadInt64(&requests); got != 0 {
		t.Errorf("a skipped heavy scenario still made %d requests", got)
	}
}

// When a heavy scenario is asked for, its sample count is capped separately.
// Guards against `--n 100 --heavy` transferring 1.4 GB.
func TestAHeavyScenarioIsCappedAtItsOwnSampleCount(t *testing.T) {
	var requests int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&requests, 1)
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	opts := fastOptions(50, 0)
	opts.IncludeHeavy = true
	opts.HeavyIterations = 2

	res := runScenario(context.Background(), testClient(0), srv.URL,
		Scenario{Name: "heavy", Path: "/heavy", Heavy: true}, opts)

	if res.Samples != 2 {
		t.Errorf("Samples = %d, want the heavy cap of 2 rather than the 50 asked for", res.Samples)
	}
	if got := atomic.LoadInt64(&requests); got != 2 {
		t.Errorf("the server saw %d requests, want 2", got)
	}
}

// A scenario with a body must send it, with a content type, using the method it
// declares. Guards against a POST scenario silently being measured as a GET.
func TestAScenarioWithABodyIsSentAsDeclared(t *testing.T) {
	type seen struct {
		method, contentType, body string
	}
	got := make(chan seen, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := new(bytes.Buffer)
		_, _ = buf.ReadFrom(r.Body)
		select {
		case got <- seen{r.Method, r.Header.Get("Content-Type"), buf.String()}:
		default:
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	s := Scenario{Name: "post", Method: http.MethodPost, Path: "/thing", Body: `{"a":1}`}
	runScenario(context.Background(), testClient(0), srv.URL, s, fastOptions(1, 0))

	first := <-got
	if first.method != http.MethodPost {
		t.Errorf("method = %s, want POST", first.method)
	}
	if first.contentType != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", first.contentType)
	}
	if first.body != `{"a":1}` {
		t.Errorf("body = %q, want the scenario's body", first.body)
	}
}

// A target with a trailing slash must not produce a doubled slash in the URL.
// Guards against `--target http://host:8080/` measuring //api/health, which some
// routers 404 and which would be recorded as a broken suite.
func TestATargetWithATrailingSlashDoesNotProduceADoubledPath(t *testing.T) {
	paths := make(chan string, 4)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case paths <- r.URL.Path:
		default:
		}
		// Answered as the real endpoint answers. The runner now checks that a
		// response is the kind the scenario expects, so a bare "ok" would be
		// recorded as absent and this test would pass its path assertion while
		// measuring nothing.
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL+"///",
		scenarioNamed(t, "health"), fastOptions(1, 0))

	if got := <-paths; got != "/api/health" {
		t.Errorf("requested %q, want /api/health", got)
	}
	if strings.Contains(res.URL, "//api") {
		t.Errorf("recorded URL %q contains a doubled slash", res.URL)
	}
	if res.Samples != 1 {
		t.Errorf("Samples = %d, want 1", res.Samples)
	}
}

// A target the URL parser rejects must be reported before any measuring starts,
// not discovered fifteen scenarios later as a suite of zeroes.
func TestExecuteRefusesATargetThatIsNotAURL(t *testing.T) {
	for _, target := range []string{"", "   ", "http://[::1"} {
		_, err := Execute(context.Background(), Options{Target: target, Iterations: 1, Warmup: 1})
		if err == nil {
			t.Errorf("Execute(%q) succeeded, want an error naming the target", target)
			continue
		}
		if !strings.Contains(err.Error(), "target") {
			t.Errorf("Execute(%q) error = %q, which does not mention the target", target, err)
		}
	}
}

// ---------------------------------------------------------------------------
// Whole-suite behaviour

// A run against a server that answers everything must record every scenario,
// stamp the schema version, and carry its provenance. Guards against a results
// file that cannot say what it measured — the thing this tool exists to replace.
func TestARunRecordsEveryScenarioAndItsOwnProvenance(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/info" {
			_, _ = w.Write([]byte(`{"version":"1.2.3"}`))
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	run, err := Execute(context.Background(), Options{
		Target: srv.URL, Label: "unit", Iterations: 1, Warmup: 1, Timeout: 5 * time.Second,
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if got, want := len(run.Scenarios), len(Scenarios()); got != want {
		t.Errorf("recorded %d scenarios, want all %d", got, want)
	}
	if run.SchemaVersion != ResultsVersion {
		t.Errorf("SchemaVersion = %d, want %d", run.SchemaVersion, ResultsVersion)
	}
	if run.ServerVersion != "1.2.3" {
		t.Errorf("ServerVersion = %q, want the version /api/info reported", run.ServerVersion)
	}
	if run.TargetKind != "local" {
		t.Errorf("TargetKind = %q, want local for a 127.0.0.1 target", run.TargetKind)
	}
	if run.Duration <= 0 {
		t.Error("Duration was not recorded")
	}
	if run.Iterations != 1 || run.Warmup != 1 {
		t.Errorf("Iterations/Warmup recorded as %d/%d, want 1/1", run.Iterations, run.Warmup)
	}
	if run.Label != "unit" {
		t.Errorf("Label = %q, want unit", run.Label)
	}
	if run.Host == "" {
		t.Error("Host was not recorded, so the result cannot say where the load came from")
	}

	// Every scenario in the default suite must have been given a URL, so a blank
	// row in a report is always an explained skip and never an oversight.
	for _, s := range run.Scenarios {
		if s.Skipped {
			if s.SkippedReason == "" {
				t.Errorf("scenario %s was skipped without a reason", s.Name)
			}
			continue
		}
		if s.URL == "" {
			t.Errorf("scenario %s has no URL recorded", s.Name)
		}
	}
}

// A target that cannot say what build it is must be noted, because a number
// without its provenance is what this tool replaces.
func TestATargetThatCannotReportItsVersionIsNoted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/info" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	run, err := Execute(context.Background(), Options{Target: srv.URL, Iterations: 1, Warmup: 1})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if run.ServerVersion != "" {
		t.Errorf("ServerVersion = %q, want empty", run.ServerVersion)
	}
	if !anyContains(run.Notes, "did not report a version") {
		t.Errorf("Notes = %v, want one explaining the missing version", run.Notes)
	}
}

// A target that reports itself as "dev" must be noted too: those results can be
// compared with each other but not attributed to a release.
func TestADevBuildIsNotedAsUnattributable(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/info" {
			_, _ = w.Write([]byte(`{"version":"dev"}`))
			return
		}
		_, _ = w.Write([]byte("ok"))
	}))
	defer srv.Close()

	run, _ := Execute(context.Background(), Options{Target: srv.URL, Iterations: 1, Warmup: 1})

	if !anyContains(run.Notes, "dev") {
		t.Errorf("Notes = %v, want one about the dev build", run.Notes)
	}
}

// A target that answers HTML to everything, as a misconfigured proxy or the
// wrong port would, must produce a run full of explained failures rather than a
// panic or a plausible-looking set of timings for pages that are not the API.
func TestATargetServingHTMLInsteadOfTheAPIProducesAnHonestRunNotAPanic(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = fmt.Fprint(w, "<html><body>502 Bad Gateway</body></html>")
	}))
	defer srv.Close()

	run, err := Execute(context.Background(), Options{Target: srv.URL, Iterations: 2, Warmup: 1})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}

	if run.ServerVersion != "" {
		t.Errorf("ServerVersion = %q, want empty: the target never said", run.ServerVersion)
	}
	measured := 0
	for _, s := range run.Scenarios {
		if s.Skipped {
			continue
		}
		if s.Samples != 0 {
			t.Errorf("scenario %s recorded %d samples from a 502", s.Name, s.Samples)
		}
		if s.TotalMs.N != 0 {
			t.Errorf("scenario %s recorded timings for a 502 error page", s.Name)
		}
		// Every scenario that got as far as issuing a request must be able to
		// say what came back. The suite now contains scenarios that give up
		// before measuring — a conditional scenario that cannot prime its
		// validator, a tour that cannot resolve its catchment — and those
		// legitimately have no statuses to report. What must not happen is a
		// scenario that made requests and recorded nothing about them.
		if len(s.StatusCounts) == 0 {
			continue
		}
		measured++
		if s.StatusCounts[http.StatusBadGateway] == 0 {
			t.Errorf("scenario %s made requests but did not record the 502s: %v", s.Name, s.StatusCounts)
		}
	}
	if measured == 0 {
		t.Fatal("no scenario recorded any status at all, so this test proved nothing")
	}
}

// A target unreachable altogether must still return a run, so the failure is
// visible and saved rather than losing the invocation to an error.
func TestAnUnreachableTargetStillProducesAReadableRun(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	_ = listener.Close() // nothing is listening there now

	run, err := Execute(context.Background(), Options{
		Target: "http://" + addr, Iterations: 1, Warmup: 1, Timeout: 2 * time.Second,
	})
	if err != nil {
		t.Fatalf("Execute: %v", err)
	}
	if len(run.Scenarios) == 0 {
		t.Fatal("no scenarios recorded")
	}
	for _, s := range run.Scenarios {
		if !s.Skipped && s.Samples != 0 {
			t.Errorf("scenario %s recorded %d samples against a closed port", s.Name, s.Samples)
		}
	}
}

// Defaults must be sane without a caller filling anything in, so `dtbench run`
// with no flags is a real measurement rather than a single unwarmed sample.
func TestDefaultOptionsAreASensibleMeasurement(t *testing.T) {
	var o Options
	o.applyDefaults()

	if o.Iterations < 10 {
		t.Errorf("default Iterations = %d, too few for a percentile to mean anything", o.Iterations)
	}
	// Warmup is deliberately not defaulted here any more: perf made zero mean
	// zero so that "--warmup 0" can express "measure the first request", which
	// for several scenarios is the difference between 22 ms and 0.5 ms. The
	// consequence is that the zero value of Options performs no warmup, so the
	// guarantee moved to the command line, where the default is set — see
	// TestTheCommandLineDefaultsToDiscardingWarmupRequests in cmd/dtbench.
	if o.Warmup != 0 {
		t.Errorf("default Warmup = %d, want 0: an unset Warmup now means none, and the safe default lives "+
			"on the command-line flag", o.Warmup)
	}
	var unspecified Options
	unspecified.Warmup = -1
	unspecified.applyDefaults()
	if unspecified.Warmup < 1 {
		t.Errorf("Warmup = %d after asking for the default, want at least one discarded request",
			unspecified.Warmup)
	}
	if o.HeavyIterations <= 0 || o.HeavyIterations >= o.Iterations {
		t.Errorf("default HeavyIterations = %d, want a smaller cap than Iterations = %d",
			o.HeavyIterations, o.Iterations)
	}
	if o.Timeout <= 0 {
		t.Errorf("default Timeout = %v, want a positive bound", o.Timeout)
	}
}

// Warmup can be switched off, and asking for none must produce none.
//
// This was filed as a bug in the first QA pass: applyDefaults promoted both zero
// and any negative value to three, so `--warmup 0` silently made three requests
// the user had asked not to make. It mattered because that flag is the only way
// to ask "how expensive is the first request", which for several scenarios here
// is the difference between 22 ms and 0.5 ms. Perf has fixed it; this now pins
// the fix, end to end, so the promotion cannot come back.
func TestWarmupCanBeSwitchedOffAndZeroMeansZero(t *testing.T) {
	var explicitlyZero Options
	explicitlyZero.Warmup = 0
	explicitlyZero.applyDefaults()

	if explicitlyZero.Warmup != 0 {
		t.Errorf("Warmup = %d after asking for 0, want 0", explicitlyZero.Warmup)
	}

	// And no warmup request is actually issued, which is the thing the flag
	// promises rather than merely the field value.
	var requests int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&requests, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL,
		scenarioNamed(t, "health"), fastOptions(4, 0))

	if got := atomic.LoadInt64(&requests); got != 4 {
		t.Errorf("the server saw %d requests, want exactly the 4 measured ones and no warmup", got)
	}
	if res.Samples != 4 {
		t.Errorf("Samples = %d, want 4", res.Samples)
	}
}

// The local/remote distinction is what stops a localhost run being compared with
// a production one without a warning, so it must be right for every form of
// loopback.
func TestTargetKindDistinguishesLoopbackFromEverythingElse(t *testing.T) {
	for target, want := range map[string]string{
		"http://127.0.0.1:8080":  "local",
		"http://localhost:8080":  "local",
		"http://[::1]:8080":      "local",
		"https://dt.kartoza.com": "remote",
		"http://192.168.1.10":    "remote",
	} {
		if got := targetKind(target); got != want {
			t.Errorf("targetKind(%q) = %q, want %q", target, got, want)
		}
	}
}

func anyContains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if strings.Contains(s, needle) {
			return true
		}
	}
	return false
}
