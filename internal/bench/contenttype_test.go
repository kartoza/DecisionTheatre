package bench

// CONTENT TYPE VALIDATION — regression guards.
//
// This file was written as a specification, before the behaviour existed, so
// that the acceptance criteria could be judged against something other than the
// implementer's own reading of the problem. Four of its tests failed by design.
// Perf has since implemented absence detection and they pass, so the file is now
// what it was always going to become: the guard that stops the hole reopening.
//
// The hole it closes:
//
// Decision Theatre serves a single-page application. Any path the API router
// does not claim falls through to the SPA handler, which answers 200 OK with
// text/html and the contents of index.html. Verified against the live server on
// 2026-08-19:
//
//	$ curl -D - http://127.0.0.1:8080/api/does-not-exist
//	HTTP/1.1 200 OK
//	Content-Length: 2703
//	Content-Type: text/html; charset=utf-8
//
// So an endpoint that does not exist is not a 404. It is a fast, small, entirely
// successful-looking 200, and dtbench used to record it as a healthy sample. The
// consequence was worse than a missing number: measured against a build from
// before an endpoint was written, the endpoint appeared to have existed all along
// and to have been several times faster before it was implemented. The 14 August
// build reported catchment-values-viewport at 0.11 ms / 16 B against today's
// 0.49 ms / 725 B — a fabricated four-fold regression, in the direction that
// flatters the older code.
//
// The guard in run_test.go — a scenario that starts failing must be called
// broken rather than fast — does not catch this, because the status is 200 and
// nothing about the response says it is the wrong response. Status alone is not
// enough. The suite has to know what each scenario is supposed to return.
//
// How the implementation answered, and what these tests now pin:
//
// A response that is not what the scenario expects is recorded as *absent*
// rather than as an error. That distinction is perf's and it is the right one:
// an endpoint that predates a feature has not failed, and marking it broken
// would put a fault against a revision whose only crime is being old. So these
// tests assert the substance — no samples, no timings, no bytes, and a recorded
// reason — rather than an error count, which is the one thing absence
// deliberately does not produce.
//
// They still take their scenarios from the real Scenarios() suite rather than
// from fixtures, so an implementation cannot satisfy them while leaving the
// real suite unprotected.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// spaFallbackBody is what the Decision Theatre server actually returns for an
// unrouted path: a complete, valid HTML document, served with a 200.
const spaFallbackBody = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Decision Theatre</title></head>
<body><div id="root"></div><script src="/assets/index.js"></script></body>
</html>`

// spaFallbackServer answers every request the way the real server answers a path
// its API router does not recognise.
func spaFallbackServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Accept-Ranges", "bytes")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(spaFallbackBody))
	}))
	t.Cleanup(srv.Close)
	return srv
}

// scenarioNamed returns a scenario from the real suite. Using the real
// definitions rather than a fixture is the point: whatever mechanism records
// what a scenario should return has to be attached to the suite for the tool to
// benefit from it, and a fixture scenario would let an implementation pass these
// tests while leaving the real suite unprotected.
func scenarioNamed(t *testing.T, name string) Scenario {
	t.Helper()
	for _, s := range Scenarios() {
		if s.Name == name {
			return s
		}
	}
	t.Fatalf("no scenario named %q in the suite", name)
	return Scenario{}
}

// An API endpoint that answers 200 with an HTML page is not answering. It is the
// SPA fallback, and the scenario is measuring the cost of serving index.html.
// That must be recorded as a failure, not as an extremely fast success.
func TestAnAPIEndpointAnsweringHTMLIsNotRecordedAsAFastSuccess(t *testing.T) {
	srv := spaFallbackServer(t)

	// Every JSON-returning scenario in the suite, because the fallback catches
	// all of them equally and a fix that only covers one is not a fix.
	for _, name := range []string{
		"health",
		"info",
		"metadata-colors",
		"columns",
		"scenarios",
		"choropleth-viewport",
		"choropleth-domain-aggregated",
		"catchment-values-viewport",
		"catchments-bounds",
		"catchment-identify",
		"tilejson",
	} {
		t.Run(name, func(t *testing.T) {
			res := runScenario(context.Background(), testClient(0), srv.URL,
				scenarioNamed(t, name), fastOptions(5, 1))

			if res.Samples != 0 {
				t.Errorf("Samples = %d, want 0: the server returned an HTML page, not this endpoint's response",
					res.Samples)
			}
			// Accounted for one way or the other, and never silently absent from
			// the result: either recorded as absent with a reason, or counted as
			// errors. What must never happen is a scenario that quietly reports
			// nothing at all, because that is indistinguishable in a report from
			// a scenario nobody ran.
			if !res.Absent && res.Errors == 0 {
				t.Errorf("the SPA fallback was neither flagged absent nor counted as an error: %+v", res)
			}
			if res.Absent && res.AbsentReason == "" {
				t.Error("the scenario was flagged absent with no reason, so a report cannot explain the gap")
			}
			if res.TotalMs.N != 0 {
				t.Errorf("timings were recorded for the SPA fallback (p50 %.2f ms over %d samples); "+
					"these are the numbers that make an unwritten endpoint look fast",
					res.TotalMs.P50, res.TotalMs.N)
			}
			if res.BytesMax != 0 {
				t.Errorf("BytesMax = %d, which is the size of index.html rather than of this endpoint's payload",
					res.BytesMax)
			}
		})
	}
}

// A tile endpoint answering HTML is the same fault in a different content type.
// Guards against a fix that special-cases JSON and leaves the tile scenarios —
// which are the ones that move most between builds — still measuring index.html.
func TestATileEndpointAnsweringHTMLIsNotRecordedAsAFastSuccess(t *testing.T) {
	srv := spaFallbackServer(t)

	for _, name := range []string{"tile-z8", "tile-z5"} {
		t.Run(name, func(t *testing.T) {
			res := runScenario(context.Background(), testClient(0), srv.URL,
				scenarioNamed(t, name), fastOptions(4, 1))

			if res.Samples != 0 {
				t.Errorf("Samples = %d, want 0: a vector tile scenario was served an HTML document", res.Samples)
			}
			if !res.Absent && res.Errors == 0 {
				t.Errorf("an HTML document served for a vector tile was neither flagged absent nor counted "+
					"as an error: %+v", res)
			}
			if res.TotalMs.N != 0 {
				t.Errorf("timings were recorded for an HTML document served in place of a tile (%d samples)",
					res.TotalMs.N)
			}
		})
	}
}

// The consequence, stated as the reader experiences it. A baseline that measured
// the SPA fallback for an endpoint that did not exist yet, compared with a
// current run that measures the endpoint for real, must not produce a regression.
// The endpoint did not get slower; it got written.
//
// This is the assertion that matters most in this file: it is the one that
// describes a number a client could be shown, and today that number is a
// four-fold regression that never happened.
func TestAnEndpointThatDidNotExistInTheBaselineIsNotReportedAsARegression(t *testing.T) {
	before := spaFallbackServer(t)

	after := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Slower and larger than the fallback, exactly as a real implementation
		// compares against serving a cached index.html. The delay is deliberate
		// and generous so the fabricated regression is unambiguous rather than
		// resting on which of two sub-millisecond servers won the scheduler.
		time.Sleep(3 * time.Millisecond)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"values":[` + strings.Repeat("1,", 300) + `1]}`))
	}))
	defer after.Close()

	s := scenarioNamed(t, "catchment-values-viewport")
	opts := fastOptions(5, 1)

	baseline := Run{
		Target: before.URL, TargetKind: "local", Host: "h", Iterations: opts.Iterations,
		Scenarios: []ScenarioResult{runScenario(context.Background(), testClient(0), before.URL, s, opts)},
	}
	current := Run{
		Target: before.URL, TargetKind: "local", Host: "h", Iterations: opts.Iterations,
		Scenarios: []ScenarioResult{runScenario(context.Background(), testClient(0), after.URL, s, opts)},
	}

	c := Compare(baseline, current)
	if len(c.Deltas) != 1 {
		t.Fatalf("got %d deltas, want 1", len(c.Deltas))
	}
	d := c.Deltas[0]

	if d.Verdict == Slower {
		t.Errorf("verdict = %q with a %.0f%% change: the endpoint did not get slower, it did not exist before",
			d.Verdict, d.RelativeChange*100)
	}
	if d.Verdict == Faster || d.Verdict == Unchanged {
		t.Errorf("verdict = %q: comparing a real response against the SPA fallback is not a comparison at all",
			d.Verdict)
	}
	if d.Caveat == "" {
		t.Error("no caveat explains why this scenario has no comparable baseline")
	}

	h := c.Summarise()
	if h.BiggestRegression != nil {
		t.Errorf("BiggestRegression = %q (%.0f%%), a regression that never happened and which would lead "+
			"the report", h.BiggestRegression.Name, h.BiggestRegression.RelativeChange*100)
	}
	if h.Slower != 0 {
		t.Errorf("Slower = %d, want 0", h.Slower)
	}
}

// A response labelled application/json whose body is not JSON is not a usable
// response either. Realistic when a reverse proxy or an error middleware writes
// a plain-text message without correcting the content type. Weaker than the
// header check and more expensive, so validating it on the discarded warmup
// request rather than on every measured one is the sensible reading.
func TestAResponseLabelledJSONWhoseBodyIsNotJSONIsNotRecordedAsASuccess(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte("upstream connect error or disconnect/reset before headers"))
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL,
		scenarioNamed(t, "columns"), fastOptions(4, 1))

	if res.Samples != 0 {
		t.Errorf("Samples = %d, want 0: the body is not JSON however it is labelled", res.Samples)
	}
}

// A proxy's HTML error page carries a 4xx or 5xx, so the existing status check
// already rejects it. Recorded here so a content-type change cannot accidentally
// start treating a 502 HTML page as merely a wrong content type and lose the
// status information that explains it.
func TestAProxysHTMLErrorPageIsRecordedAsAFailureWithItsStatus(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>"))
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL,
		scenarioNamed(t, "choropleth-viewport"), fastOptions(3, 1))

	if res.Samples != 0 {
		t.Errorf("Samples = %d, want 0", res.Samples)
	}
	if res.Errors != 3 {
		t.Errorf("Errors = %d, want 3", res.Errors)
	}
	if res.StatusCounts[http.StatusBadGateway] != 3 {
		t.Errorf("StatusCounts = %v, want the 502s recorded: the status is what tells a reader it was the "+
			"proxy and not the application", res.StatusCounts)
	}
}

// A body that stops short of its declared Content-Length must not be recorded as
// a small fast response. The transport surfaces this as an unexpected EOF, and
// the runner must let it count as an error rather than keeping the partial size.
// Paired with TestAServerThatClosesTheConnectionMidResponseIsRecordedAsAnError in
// run_test.go, which covers the same fault at the connection level.
func TestABodyShorterThanItsDeclaredLengthIsNotRecordedAsASmallFastResponse(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", "100000")
		_, _ = w.Write([]byte(`{"values":[1,2,3`))
		// Returning here closes the response with far less than promised.
	}))
	defer srv.Close()

	res := runScenario(context.Background(), testClient(0), srv.URL,
		scenarioNamed(t, "catchment-values-viewport"), fastOptions(3, 1))

	if res.Samples != 0 {
		t.Errorf("Samples = %d, want 0: the body never arrived in full", res.Samples)
	}
	if res.BytesMax != 0 {
		t.Errorf("BytesMax = %d, want 0: a truncated body is not a size measurement", res.BytesMax)
	}
}
