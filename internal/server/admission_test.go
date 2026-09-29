package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// What these pin is the difference the change is for: under more load than the
// server can do at once, requests are refused rather than queued. A test that
// only checked "every request eventually got a 200" would have passed against
// the old code, which is how the 18.5 s p95 got shipped.

// newTestController builds a controller small enough to saturate deliberately.
func newTestController(slots, queue int, wait time.Duration) *admissionController {
	return &admissionController{
		slots:    make(chan struct{}, slots),
		maxQueue: int64(queue),
		maxWait:  wait,
	}
}

// blockingHandler holds every request until the returned func is called.
func blockingHandler() (http.Handler, func(), *atomic.Int64) {
	release := make(chan struct{})
	var inFlight atomic.Int64
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		inFlight.Add(1)
		<-release
		w.WriteHeader(http.StatusOK)
	})
	var once sync.Once
	return h, func() { once.Do(func() { close(release) }) }, &inFlight
}

func TestExcessLoadIsRefusedNotQueued(t *testing.T) {
	// The whole point. Two slots, no queue: the third concurrent request must
	// be told no, immediately, rather than made to wait for a slot.
	c := newTestController(2, 0, time.Second)
	inner, release, inFlight := blockingHandler()
	defer release()
	h := admitRequestsWith(c, inner)

	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/choropleth", nil))
		}()
	}
	waitFor(t, func() bool { return inFlight.Load() == 2 }, "two requests to occupy both slots")

	start := time.Now()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/choropleth", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("got %d, want 503 — an overloaded server that accepts the request has only moved the problem", rec.Code)
	}
	if elapsed := time.Since(start); elapsed > 200*time.Millisecond {
		t.Errorf("refusal took %s; saying no has to be cheap or shedding does not relieve anything", elapsed)
	}
	release()
	wg.Wait()
}

func TestRefusalTellsTheClientWhenToComeBack(t *testing.T) {
	// A 503 with no Retry-After leaves the client to guess, and clients guess
	// by retrying straight away, which is the load that caused the 503.
	c := newTestController(1, 0, time.Second)
	inner, release, inFlight := blockingHandler()
	defer release()
	h := admitRequestsWith(c, inner)

	go h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/choropleth", nil))
	waitFor(t, func() bool { return inFlight.Load() == 1 }, "the one slot to be taken")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/choropleth", nil))

	after := rec.Header().Get("Retry-After")
	if after == "" {
		t.Fatal("no Retry-After on the refusal")
	}
	if n, err := strconv.Atoi(after); err != nil || n <= 0 {
		t.Errorf("Retry-After %q is not a positive number of seconds", after)
	}
	if got := rec.Header().Get("Cache-Control"); got != "no-store" {
		t.Errorf("Cache-Control %q; a cached 503 outlives the overload that caused it", got)
	}
}

func TestHealthIsNeverShed(t *testing.T) {
	// If health is shed under load, the orchestrator kills a server that was
	// coping, and a slow minute becomes an outage.
	c := newTestController(1, 0, time.Second)
	inner, release, inFlight := blockingHandler()
	defer release()

	served := make(chan string, 4)
	h := admitRequestsWith(c, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/health" {
			served <- "health"
			w.WriteHeader(http.StatusOK)
			return
		}
		inner.ServeHTTP(w, r)
	}))

	go h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/choropleth", nil))
	waitFor(t, func() bool { return inFlight.Load() == 1 }, "the one slot to be taken")

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/health", nil))
	if rec.Code != http.StatusOK {
		t.Errorf("health got %d while the API was saturated, want 200", rec.Code)
	}
}

func TestStaticRequestsAreNotBounded(t *testing.T) {
	// Bounding the page itself would mean a load the server can absorb still
	// shows the user a broken site.
	c := newTestController(1, 0, time.Second)
	inner, release, inFlight := blockingHandler()
	defer release()

	h := admitRequestsWith(c, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/choropleth" {
			inner.ServeHTTP(w, r)
			return
		}
		w.WriteHeader(http.StatusOK)
	}))
	go h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/choropleth", nil))
	waitFor(t, func() bool { return inFlight.Load() == 1 }, "the one slot to be taken")

	for _, path := range []string{"/", "/assets/index.js", "/tiles/base/3/4/5.pbf"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if rec.Code != http.StatusOK {
			t.Errorf("%s got %d, want 200", path, rec.Code)
		}
	}
}

func TestUnknownAPIPathsAreBoundedByDefault(t *testing.T) {
	// The allowlist names the cheap paths, not the expensive ones, so a handler
	// added later is bounded until someone decides otherwise. Getting this
	// backwards is how an endpoint ends up unbounded by omission.
	for _, path := range []string{"/api/choropleth", "/api/precalculate/full", "/api/something-added-in-2027"} {
		if !needsAdmission(path) {
			t.Errorf("%s is not admission-controlled", path)
		}
	}
	for _, path := range []string{"/api/health", "/api/info", "/", "/tiles/x/1/2/3.pbf"} {
		if needsAdmission(path) {
			t.Errorf("%s is admission-controlled and should not be", path)
		}
	}
}

func TestShortQueueAbsorbsABurst(t *testing.T) {
	// A quad-view page load fires four API calls at once. On an otherwise idle
	// server none of them may be refused, or the fix is worse than the problem.
	c := newTestController(1, 8, 2*time.Second)
	var served atomic.Int64
	h := admitRequestsWith(c, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(5 * time.Millisecond)
		served.Add(1)
		w.WriteHeader(http.StatusOK)
	}))

	var wg sync.WaitGroup
	codes := make([]int, 4)
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/choropleth", nil))
			codes[i] = rec.Code
		}(i)
	}
	wg.Wait()
	for i, code := range codes {
		if code != http.StatusOK {
			t.Errorf("request %d of a 4-request page load got %d on an idle server", i, code)
		}
	}
}

func TestASlowQueueTimesOutRatherThanWaiting(t *testing.T) {
	// Depth alone assumes every queued request costs the same. They do not:
	// /api/scenarios is 2 ms and /api/choropleth is 4.5 s. The wait bound is
	// what stops a shallow queue of slow work becoming a long wait.
	c := newTestController(1, 100, 50*time.Millisecond)
	inner, release, inFlight := blockingHandler()
	defer release()
	h := admitRequestsWith(c, inner)

	go h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/choropleth", nil))
	waitFor(t, func() bool { return inFlight.Load() == 1 }, "the one slot to be taken")

	start := time.Now()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/choropleth", nil))
	elapsed := time.Since(start)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("got %d, want 503 after the queue wait expired", rec.Code)
	}
	if elapsed > time.Second {
		t.Errorf("waited %s for a 50ms bound", elapsed)
	}
}

func TestAClientLeavingIsNotCountedAsOverload(t *testing.T) {
	// A disconnect while queued must not read as a shed: it would make ordinary
	// navigation-away look like the server failing, and the shed count is the
	// signal someone will eventually alert on.
	c := newTestController(1, 100, 10*time.Second)
	inner, release, inFlight := blockingHandler()
	defer release()
	h := admitRequestsWith(c, inner)

	go h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/choropleth", nil))
	waitFor(t, func() bool { return inFlight.Load() == 1 }, "the one slot to be taken")

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan int, 1)
	go func() {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/choropleth", nil).WithContext(ctx))
		done <- rec.Code
	}()
	time.Sleep(30 * time.Millisecond)
	cancel()

	select {
	case code := <-done:
		if code != 499 {
			t.Errorf("got %d, want 499 for a client that hung up while queued", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a cancelled request stayed in the queue")
	}
	if n := c.shedCount.Load(); n != 0 {
		t.Errorf("shed count %d; a disconnect is not an overload", n)
	}
}

func TestSlotsAreReturnedWhenAHandlerPanics(t *testing.T) {
	// A slot leaked per panic would silently reduce capacity to zero, and the
	// server would then refuse everything while doing nothing.
	c := newTestController(1, 0, time.Second)
	h := admitRequestsWith(c, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		panic("boom")
	}))

	for i := 0; i < 3; i++ {
		func() {
			defer func() { _ = recover() }()
			h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/api/choropleth", nil))
		}()
	}
	if got := len(c.slots); got != 0 {
		t.Errorf("%d slots still held after panicking handlers", got)
	}
}

func TestCapacityIsNeverZero(t *testing.T) {
	// A controller with no slots refuses everything for ever.
	c := newAdmissionController()
	if c.capacity() < minConcurrency {
		t.Errorf("capacity %d, want at least %d", c.capacity(), minConcurrency)
	}
	if c.maxQueue <= 0 {
		t.Errorf("queue %d leaves no room for an ordinary page load", c.maxQueue)
	}
}

func TestEveryRequestIsEitherServedOrRefused(t *testing.T) {
	// Under sustained overload nothing may hang and nothing may be lost. This
	// is the property the whole design exists to provide.
	c := newTestController(2, 4, 100*time.Millisecond)
	h := admitRequestsWith(c, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(20 * time.Millisecond)
		w.WriteHeader(http.StatusOK)
	}))

	const n = 100
	results := make(chan int, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/choropleth", nil))
			results <- rec.Code
		}()
	}

	finished := make(chan struct{})
	go func() { wg.Wait(); close(finished) }()
	select {
	case <-finished:
	case <-time.After(30 * time.Second):
		t.Fatal("requests were still outstanding after 30s under overload")
	}
	close(results)

	var ok, shed int
	for code := range results {
		switch code {
		case http.StatusOK:
			ok++
		case http.StatusServiceUnavailable:
			shed++
		default:
			t.Fatalf("unexpected status %d", code)
		}
	}
	if ok+shed != n {
		t.Fatalf("%d served + %d refused != %d sent", ok, shed, n)
	}
	if shed == 0 {
		t.Error("nothing was refused at 50x capacity, which means everything was queued")
	}
	if ok == 0 {
		t.Error("nothing was served; shedding must not starve the work")
	}
	t.Logf("%d served, %d refused", ok, shed)
}

// waitFor blocks until cond holds, failing the test if it never does.
func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("timed out waiting for " + what)
}
