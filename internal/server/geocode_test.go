package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/kartoza/decision-theatre/internal/config"
)

// newGeocodeServer builds a Server with just enough wired up to exercise the
// geocode handler. Named distinctly from any other test helper in this package so
// the two cannot collide.
func newGeocodeServer(t *testing.T) *Server {
	t.Helper()

	srv, err := New(config.Config{Port: 0, DataDir: t.TempDir(), Version: "test"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return srv
}

// The browser called nominatim.openstreetmap.org directly, with no identifying
// User-Agent and a 400ms input debounce as its only rate limiting. The OSM usage
// policy requires a User-Agent naming the application and a contact, caps traffic
// at one request per second, and asks that results be cached.
//
// None of that can be done from browser JavaScript — User-Agent is a forbidden
// header name for fetch, and a per-tab debounce is not a rate limit — so the
// requests are proxied. These tests pin the parts that make that compliant, since
// none of them is visible in the application's behaviour.

func TestUserAgentIdentifiesTheApplicationAndAContact(t *testing.T) {
	g := newGeocodeLimiter("1.2.3")

	if !strings.Contains(g.userAgent, "DecisionTheatre") {
		t.Errorf("User-Agent %q does not name the application", g.userAgent)
	}
	if !strings.Contains(g.userAgent, "1.2.3") {
		t.Errorf("User-Agent %q does not carry the version", g.userAgent)
	}
	if !strings.Contains(g.userAgent, nominatimContact) {
		t.Errorf("User-Agent %q carries no contact; the usage policy requires one", g.userAgent)
	}
}

// An unversioned build must still identify itself, not send "DecisionTheatre/".
func TestUserAgentWithoutAVersion(t *testing.T) {
	g := newGeocodeLimiter("")

	if strings.Contains(g.userAgent, "DecisionTheatre/ ") || strings.HasSuffix(g.userAgent, "/") {
		t.Errorf("User-Agent %q has an empty version", g.userAgent)
	}
	if !strings.Contains(g.userAgent, "dev") {
		t.Errorf("User-Agent %q should fall back to a placeholder version", g.userAgent)
	}
}

// The header must actually reach the wire, not merely be computed.
func TestSearchSendsTheIdentifyingHeader(t *testing.T) {
	var gotUA, gotAccept string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotUA = r.Header.Get("User-Agent")
		gotAccept = r.Header.Get("Accept")
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"lat":"-25.7","lon":"28.2","display_name":"Pretoria, South Africa"}]`))
	}))
	defer upstream.Close()

	g := newGeocodeLimiter("1.2.3")
	g.searchURL = upstream.URL

	places, err := g.search(context.Background(), "Pretoria")
	if err != nil {
		t.Fatalf("search: %v", err)
	}

	if !strings.Contains(gotUA, "DecisionTheatre") {
		t.Errorf("upstream saw User-Agent %q", gotUA)
	}
	if gotAccept != "application/json" {
		t.Errorf("upstream saw Accept %q", gotAccept)
	}
	if len(places) != 1 || places[0].Name != "Pretoria, South Africa" {
		t.Fatalf("places = %+v", places)
	}
	if places[0].Lat != -25.7 || places[0].Lng != 28.2 {
		t.Errorf("coordinates = %v, %v; want -25.7, 28.2", places[0].Lat, places[0].Lng)
	}
}

// A result that cannot be parsed is dropped rather than becoming a place at 0,0
// in the Gulf of Guinea.
func TestSearchDropsUnparseableCoordinates(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[
			{"lat":"not-a-number","lon":"28.2","display_name":"Broken"},
			{"lat":"-25.7","lon":"28.2","display_name":"Good"}
		]`))
	}))
	defer upstream.Close()

	g := newGeocodeLimiter("test")
	g.searchURL = upstream.URL

	places, err := g.search(context.Background(), "x")
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(places) != 1 || places[0].Name != "Good" {
		t.Errorf("places = %+v, want only the parseable one", places)
	}
}

func TestSearchTreatsAnUpstreamErrorAsAnError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusTooManyRequests)
	}))
	defer upstream.Close()

	g := newGeocodeLimiter("test")
	g.searchURL = upstream.URL

	if _, err := g.search(context.Background(), "x"); err == nil {
		t.Error("a 429 from upstream was treated as success")
	}
}

// One request per second, across the whole deployment. The first caller goes
// immediately; the next has to wait.
func TestReserveEnforcesOneRequestPerSecond(t *testing.T) {
	g := newGeocodeLimiter("test")

	if wait := g.reserve(); wait != 0 {
		t.Errorf("first reservation waited %v, want none", wait)
	}
	second := g.reserve()
	if second <= 0 {
		t.Fatalf("second reservation waited %v; the limit is not being applied", second)
	}
	if second > nominatimMinInterval {
		t.Errorf("second reservation waited %v, more than the %v interval", second, nominatimMinInterval)
	}

	// Reservations accumulate rather than all seeing the same free slot, or
	// concurrent callers would burst.
	third := g.reserve()
	if third <= second {
		t.Errorf("third reservation waited %v, not more than the second's %v; "+
			"concurrent callers would exceed the limit", third, second)
	}
}

// Caching is part of the usage policy, and the point is that a repeat search
// makes no upstream request at all.
func TestRepeatedQueryIsServedFromCache(t *testing.T) {
	var upstreamCalls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls++
		_, _ = w.Write([]byte(`[{"lat":"-25.7","lon":"28.2","display_name":"Pretoria"}]`))
	}))
	defer upstream.Close()

	srv := newGeocodeServer(t)
	srv.geocode.searchURL = upstream.URL

	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, "/api/geocode?q=Pretoria", nil)
		srv.handleGeocode(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status %d: %s", i, rec.Code, rec.Body.String())
		}
	}

	if upstreamCalls != 1 {
		t.Errorf("upstream was called %d times for the same query; caching is not working", upstreamCalls)
	}
}

// Case differs, place does not.
func TestCacheIsCaseInsensitive(t *testing.T) {
	var upstreamCalls int
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamCalls++
		_, _ = w.Write([]byte(`[{"lat":"-25.7","lon":"28.2","display_name":"Pretoria"}]`))
	}))
	defer upstream.Close()

	srv := newGeocodeServer(t)
	srv.geocode.searchURL = upstream.URL

	for _, q := range []string{"Pretoria", "pretoria", "PRETORIA"} {
		rec := httptest.NewRecorder()
		srv.handleGeocode(rec, httptest.NewRequest(http.MethodGet, "/api/geocode?q="+q, nil))
	}

	if upstreamCalls != 1 {
		t.Errorf("upstream called %d times for the same place in different cases", upstreamCalls)
	}
}

func TestGeocodeRejectsAMissingQuery(t *testing.T) {
	srv := newGeocodeServer(t)

	rec := httptest.NewRecorder()
	srv.handleGeocode(rec, httptest.NewRequest(http.MethodGet, "/api/geocode", nil))

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
}

// This endpoint speaks upstream under our name, so it must not be usable to push
// arbitrary volume there.
func TestGeocodeRejectsAnOverlongQuery(t *testing.T) {
	srv := newGeocodeServer(t)

	long := strings.Repeat("a", geocodeMaxQueryLen+1)
	rec := httptest.NewRecorder()
	srv.handleGeocode(rec, httptest.NewRequest(http.MethodGet, "/api/geocode?q="+long, nil))

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for a %d-character query", rec.Code, len(long))
	}
}

// An upstream failure must not become a client error: the client keeps its
// bundled gazetteer matches, so search still works.
func TestUpstreamFailureReturnsAnEmptyListNotAnError(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()

	srv := newGeocodeServer(t)
	srv.geocode.searchURL = upstream.URL

	rec := httptest.NewRecorder()
	srv.handleGeocode(rec, httptest.NewRequest(http.MethodGet, "/api/geocode?q=nowhere", nil))

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 with an empty list", rec.Code)
	}
	var places []place
	if err := json.Unmarshal(rec.Body.Bytes(), &places); err != nil {
		t.Fatalf("body is not a JSON list: %s", rec.Body.String())
	}
	if len(places) != 0 {
		t.Errorf("places = %+v, want empty", places)
	}
}

// A caller far enough back in the queue is refused rather than parked, because by
// the time its turn came the user would have typed something else.
func TestALongWaitIsRefusedRatherThanParked(t *testing.T) {
	srv := newGeocodeServer(t)

	// Consume enough slots that the next wait exceeds the threshold.
	for i := 0; i < 5; i++ {
		srv.geocode.reserve()
	}

	rec := httptest.NewRecorder()
	srv.handleGeocode(rec, httptest.NewRequest(http.MethodGet, "/api/geocode?q=somewhere", nil))

	if rec.Code != http.StatusTooManyRequests {
		t.Errorf("status = %d, want 429", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("a 429 should say when to come back")
	}
}

// The cache must not grow without bound on a stream of distinct queries.
func TestCacheIsBounded(t *testing.T) {
	g := newGeocodeLimiter("test")

	for i := 0; i < geocodeCacheMax+50; i++ {
		g.store(strings.Repeat("q", i%40)+string(rune('a'+i%26))+strconv.Itoa(i), []place{{Name: "x"}})
	}

	g.mu.Lock()
	size := len(g.cache)
	g.mu.Unlock()

	if size > geocodeCacheMax {
		t.Errorf("cache holds %d entries, above the %d bound", size, geocodeCacheMax)
	}
}

// A stale entry is not served.
func TestCacheEntriesExpire(t *testing.T) {
	g := newGeocodeLimiter("test")
	g.store("pretoria", []place{{Name: "Pretoria"}})

	g.mu.Lock()
	entry := g.cache["pretoria"]
	entry.at = time.Now().Add(-geocodeCacheTTL - time.Minute)
	g.cache["pretoria"] = entry
	g.mu.Unlock()

	if _, ok := g.cached("pretoria"); ok {
		t.Error("an expired entry was served from the cache")
	}
}
