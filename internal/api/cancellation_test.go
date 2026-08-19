package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/gpkgtest"
)

// newCancelTestHandler wires a Handler over a synthetic datapack and returns
// both the router and the handler, so a test can look at cached state the
// router alone would not expose.
func newCancelTestHandler(t *testing.T) (*mux.Router, *Handler) {
	t.Helper()

	dir := gpkgtest.Build(t, t.TempDir(), []gpkgtest.Catchment{
		{ID: 1000000001, Lat: 0, Long: 0, SizeDeg: 0.5, Current: gpkgtest.Float(10), Reference: gpkgtest.Float(1)},
		{ID: 1000000002, Lat: 0, Long: 1, SizeDeg: 0.5, Current: gpkgtest.Float(20), Reference: gpkgtest.Float(2)},
	}, 0, 100)

	store, err := geodata.NewGpkgStore(dir)
	if err != nil {
		t.Fatalf("NewGpkgStore: %v", err)
	}
	t.Cleanup(store.Close)

	handler := NewHandler(nil, store, nil, config.Config{DataDir: dir, Version: "test"})
	r := mux.NewRouter()
	handler.RegisterRoutes(r)
	return r, handler
}

// cancelledRequest builds a request whose client has already gone away, which
// is what net/http hands a handler when the connection drops mid-request.
func cancelledRequest(target string) *http.Request {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	return httptest.NewRequest("GET", target, nil).WithContext(ctx)
}

// A disconnected client must not be served a 200 carrying whatever the query
// happened to have read, nor a 500 that would show up as a server fault. The
// data endpoints are the ones that matter: the map issues one of these on every
// pan and zoom, so the abandoned ones vastly outnumber the completed ones.
func TestAbandonedRequestsAreNotReportedAsSuccessOrFailure(t *testing.T) {
	targets := []struct {
		name   string
		target string
	}{
		{"catchment values", "/catchment-values?scenario=current&attribute=" + gpkgtest.Attribute + "&minx=-5&miny=-5&maxx=5&maxy=5"},
		{"choropleth", "/choropleth?scenario=current&attribute=" + gpkgtest.Attribute + "&minx=-5&miny=-5&maxx=5&maxy=5"},
		{"catchments bounds", "/catchments/bounds"},
		{"catchment geometry", "/catchments/geometry/1000000001"},
		{"aggregate", "/aggregate?scenario=current&attributes=" + gpkgtest.Attribute},
	}

	for _, tc := range targets {
		t.Run(tc.name, func(t *testing.T) {
			r, _ := newCancelTestHandler(t)

			w := httptest.NewRecorder()
			r.ServeHTTP(w, cancelledRequest(tc.target))

			if w.Code != StatusClientClosedRequest {
				t.Fatalf("status %d, want %d (body %s)", w.Code, StatusClientClosedRequest, w.Body.String())
			}
			if w.Body.Len() != 0 {
				t.Errorf("a response body was written for a client that is no longer there: %s", w.Body.String())
			}

			// The same request with a live client is still served normally -
			// otherwise the assertion above would pass for a broken endpoint.
			w = httptest.NewRecorder()
			r.ServeHTTP(w, httptest.NewRequest("GET", tc.target, nil))
			if w.Code != http.StatusOK {
				t.Fatalf("with a live client: status %d, want 200 (body %s)", w.Code, w.Body.String())
			}
		})
	}
}

// GetCatchmentAttributes has no error return, so an abandoned request comes
// back from it indistinguishable from a catchment that does not exist. Telling
// the client its catchment is missing would be a lie, and would show up as a
// 404 rate spike whenever users click around quickly.
func TestAbandonedIdentifyIsNotReportedAsNotFound(t *testing.T) {
	r, _ := newCancelTestHandler(t)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, cancelledRequest("/catchment/1000000001"))

	if w.Code == http.StatusNotFound {
		t.Fatal("an abandoned identify was reported as a missing catchment")
	}
	if w.Code != StatusClientClosedRequest {
		t.Fatalf("status %d, want %d (body %s)", w.Code, StatusClientClosedRequest, w.Body.String())
	}
}

// The full-domain precalculation is the opposite judgement: it is computed once
// and cached for the life of the process, and every pane of every later
// quad-view load is served from that cache. It must therefore survive the
// request that happened to trigger it - otherwise one user reloading impatiently
// throws the work away and the next arrival starts from nothing.
func TestPrecalculateFullSurvivesTheRequestThatTriggeredIt(t *testing.T) {
	r, handler := newCancelTestHandler(t)

	w := httptest.NewRecorder()
	r.ServeHTTP(w, cancelledRequest("/precalculate/full"))

	handler.fullDomainMu.Lock()
	cached := handler.fullDomainCache
	handler.fullDomainMu.Unlock()

	if cached == nil {
		t.Fatal("the shared full-domain cache was discarded because one client disconnected")
	}
	if len(cached.Current) == 0 || len(cached.Reference) == 0 {
		t.Fatalf("cached averages are empty: %+v", cached)
	}

	// And the next request is served from it.
	w = httptest.NewRecorder()
	r.ServeHTTP(w, httptest.NewRequest("GET", "/precalculate/full", nil))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d, want 200 (body %s)", w.Code, w.Body.String())
	}
	var got FullDomainData
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v (body %s)", err, w.Body.String())
	}
	if got.Current[gpkgtest.Attribute] != cached.Current[gpkgtest.Attribute] {
		t.Errorf("served %v, cached %v", got.Current, cached.Current)
	}
}
