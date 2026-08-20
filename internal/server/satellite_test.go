package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/kartoza/decision-theatre/internal/config"
)

// The browser used to fetch satellite tiles directly from the configured
// provider, which meant the one thing standing between this deployment and a
// provider's free-tier terms — a monthly tile count — was invisible to the one
// process able to enforce it, and a keyed provider's key would have had to live
// in browser JavaScript. The upstream is now a whole style (MapTiler's Hybrid:
// satellite imagery plus OSM-derived roads and labels), not one raster tile
// type, so these tests pin the resolve-and-rewrite chain — style, TileJSON,
// tile, sprite — as well as the caching and quota-enforcement behaviour none of
// which is visible from the outside once tiles are loading successfully.

// fakeMapTilerUpstream serves a minimal Hybrid-shaped style: one raster source
// with inline tiles, one vector source behind a TileJSON reference (MapTiler's
// usual shape), plus a sprite and glyphs field.
type fakeMapTilerUpstream struct {
	*httptest.Server
	rasterCalls   atomic.Int32
	vectorCalls   atomic.Int32
	tileJSONCalls atomic.Int32
	spriteCalls   atomic.Int32
	rasterFails   atomic.Bool
}

func newFakeMapTilerUpstream(t *testing.T) *fakeMapTilerUpstream {
	t.Helper()
	u := &fakeMapTilerUpstream{}

	mux := http.NewServeMux()
	u.Server = httptest.NewServer(mux)
	t.Cleanup(u.Close)

	mux.HandleFunc("/style.json", func(w http.ResponseWriter, r *http.Request) {
		style := map[string]interface{}{
			"version": 8,
			"sources": map[string]interface{}{
				"satellite": map[string]interface{}{
					"type":        "raster",
					"tiles":       []string{u.URL + "/raster/{z}/{x}/{y}.jpg?key=secret"},
					"tileSize":    256,
					"attribution": "© Satellite Co",
				},
				"roads": map[string]interface{}{
					"type": "vector",
					"url":  u.URL + "/roads/tiles.json?key=secret",
				},
			},
			"sprite": u.URL + "/sprites/sprite?key=secret",
			"glyphs": u.URL + "/fonts/{fontstack}/{range}.pbf?key=secret",
			"layers": []interface{}{},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(style)
	})

	mux.HandleFunc("/roads/tiles.json", func(w http.ResponseWriter, r *http.Request) {
		u.tileJSONCalls.Add(1)
		tj := map[string]interface{}{
			"tilejson": "2.2.0",
			"tiles":    []string{u.URL + "/vector/{z}/{x}/{y}.pbf?key=secret"},
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(tj)
	})

	mux.HandleFunc("/raster/", func(w http.ResponseWriter, r *http.Request) {
		u.rasterCalls.Add(1)
		if u.rasterFails.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "image/jpeg")
		_, _ = w.Write([]byte("raster tile bytes"))
	})

	mux.HandleFunc("/vector/", func(w http.ResponseWriter, r *http.Request) {
		u.vectorCalls.Add(1)
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write([]byte("vector tile bytes"))
	})

	mux.HandleFunc("/sprites/sprite.json", func(w http.ResponseWriter, r *http.Request) {
		u.spriteCalls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"marker":{"width":1,"height":1,"x":0,"y":0,"pixelRatio":1}}`))
	})

	return u
}

// newSatelliteServer builds a Server with the satellite proxy pointed at a
// fake upstream style, and its quota set to limit.
func newSatelliteServer(t *testing.T, styleURL string, limit int) *Server {
	t.Helper()

	srv, err := New(config.Config{
		Port:                0,
		DataDir:             t.TempDir(),
		Version:             "test",
		SatelliteStyleURL:   styleURL,
		SatelliteQuotaLimit: limit,
		SatelliteUsageDir:   t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return srv
}

func getSatellite(t *testing.T, srv *Server, path string) *httptest.ResponseRecorder {
	t.Helper()
	rec := httptest.NewRecorder()
	srv.currentRouter().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestSatelliteStyleIsRewrittenToLocalPaths(t *testing.T) {
	upstream := newFakeMapTilerUpstream(t)
	srv := newSatelliteServer(t, upstream.URL+"/style.json", 1_000_000)

	rec := getSatellite(t, srv, "/api/satellite-style.json")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d: %s", rec.Code, rec.Body.String())
	}

	var style map[string]interface{}
	if err := json.Unmarshal(rec.Body.Bytes(), &style); err != nil {
		t.Fatalf("body is not JSON: %v", err)
	}

	sources := style["sources"].(map[string]interface{})

	// Absolute, not relative: MapLibre fetches vector tiles from inside a Web
	// Worker, whose location is its own script, not the page. A relative URL
	// resolved there throws "Failed to construct 'Request'" and silently drops
	// the whole source — which is exactly how the vector (roads) source went
	// missing while the raster one, fetched on the main thread, worked fine.
	satellite := sources["satellite"].(map[string]interface{})
	if got := satellite["tiles"].([]interface{})[0].(string); got != "http://example.com/api/satellite-tile/satellite/{z}/{x}/{y}" {
		t.Errorf("satellite tiles = %q", got)
	}
	if _, hasURL := satellite["url"]; hasURL {
		t.Error("an inline-tiles source kept a url field")
	}

	roads := sources["roads"].(map[string]interface{})
	if got := roads["url"].(string); got != "http://example.com/api/satellite-tilejson/roads" {
		t.Errorf("roads url = %q", got)
	}

	if got := style["sprite"].(string); got != "http://example.com/api/satellite-sprite" {
		t.Errorf("sprite = %q", got)
	}
	if got := style["glyphs"].(string); got != "http://example.com/fonts/{fontstack}/{range}.pbf" {
		t.Errorf("glyphs = %q, want the existing local font proxy, not a new one", got)
	}

	// The upstream key must never appear in what the browser receives.
	if strings.Contains(rec.Body.String(), "secret") {
		t.Error("upstream key leaked into the served style")
	}
}

func TestSatelliteTileJSONIsRewrittenAndCached(t *testing.T) {
	upstream := newFakeMapTilerUpstream(t)
	srv := newSatelliteServer(t, upstream.URL+"/style.json", 1_000_000)

	getSatellite(t, srv, "/api/satellite-style.json") // registers the roads source's tilejson upstream

	for i := 0; i < 3; i++ {
		rec := getSatellite(t, srv, "/api/satellite-tilejson/roads")
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status %d: %s", i, rec.Code, rec.Body.String())
		}
		var tj map[string]interface{}
		if err := json.Unmarshal(rec.Body.Bytes(), &tj); err != nil {
			t.Fatalf("body is not JSON: %v", err)
		}
		if got := tj["tiles"].([]interface{})[0].(string); got != "http://example.com/api/satellite-tile/roads/{z}/{x}/{y}" {
			t.Errorf("tiles = %q", got)
		}
	}

	if upstream.tileJSONCalls.Load() != 1 {
		t.Errorf("upstream tilejson was fetched %d times, want 1 (cached)", upstream.tileJSONCalls.Load())
	}
}

func TestSatelliteTileUnknownSourceIs404(t *testing.T) {
	upstream := newFakeMapTilerUpstream(t)
	srv := newSatelliteServer(t, upstream.URL+"/style.json", 1_000_000)

	rec := getSatellite(t, srv, "/api/satellite-tile/nonexistent/1/2/3")
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404 for an unresolved source", rec.Code)
	}
}

// Resolving both sources — the raster one via the style, the vector one via
// its TileJSON — then fetching tiles from each must count against one shared
// quota, cache independently, and pass through each source's own content type
// and encoding.
func TestSatelliteTilesAreFetchedCachedAndSharedQuotaCounted(t *testing.T) {
	upstream := newFakeMapTilerUpstream(t)
	srv := newSatelliteServer(t, upstream.URL+"/style.json", 1_000_000)

	getSatellite(t, srv, "/api/satellite-style.json")
	getSatellite(t, srv, "/api/satellite-tilejson/roads")

	rasterRec := getSatellite(t, srv, "/api/satellite-tile/satellite/5/2/3")
	if rasterRec.Code != http.StatusOK || rasterRec.Body.String() != "raster tile bytes" {
		t.Fatalf("raster tile: status %d, body %q", rasterRec.Code, rasterRec.Body.String())
	}
	if ct := rasterRec.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Errorf("raster Content-Type = %q", ct)
	}

	vectorRec := getSatellite(t, srv, "/api/satellite-tile/roads/5/2/3")
	if vectorRec.Code != http.StatusOK || vectorRec.Body.String() != "vector tile bytes" {
		t.Fatalf("vector tile: status %d, body %q", vectorRec.Code, vectorRec.Body.String())
	}
	if ce := vectorRec.Header().Get("Content-Encoding"); ce != "gzip" {
		t.Errorf("vector Content-Encoding = %q, want gzip forwarded from upstream", ce)
	}

	// Repeat requests for the same tiles must be served from cache.
	getSatellite(t, srv, "/api/satellite-tile/satellite/5/2/3")
	getSatellite(t, srv, "/api/satellite-tile/roads/5/2/3")

	if upstream.rasterCalls.Load() != 1 {
		t.Errorf("raster upstream called %d times, want 1", upstream.rasterCalls.Load())
	}
	if upstream.vectorCalls.Load() != 1 {
		t.Errorf("vector upstream called %d times, want 1", upstream.vectorCalls.Load())
	}

	count, _ := srv.satellite.usage.Snapshot(1_000_000)
	if count != 2 {
		t.Errorf("usage count = %d, want 2 (one per source, cache hits don't recount)", count)
	}
}

// Once the shared quota is spent, every source must be refused — the cap
// covers the whole MapTiler key's traffic through this proxy, not one source.
func TestSatelliteTileRefusedOnceSharedQuotaExceeded(t *testing.T) {
	upstream := newFakeMapTilerUpstream(t)
	srv := newSatelliteServer(t, upstream.URL+"/style.json", 1)

	getSatellite(t, srv, "/api/satellite-style.json")
	getSatellite(t, srv, "/api/satellite-tilejson/roads")

	first := getSatellite(t, srv, "/api/satellite-tile/satellite/1/1/1")
	if first.Code != http.StatusOK {
		t.Fatalf("first tile: status %d", first.Code)
	}

	second := getSatellite(t, srv, "/api/satellite-tile/roads/2/2/2")
	if second.Code != http.StatusTooManyRequests {
		t.Errorf("status = %d, want 429 once the shared quota is spent", second.Code)
	}
	if upstream.vectorCalls.Load() != 0 {
		t.Errorf("vector upstream was called %d times, want 0 (refused before fetching)", upstream.vectorCalls.Load())
	}
}

func TestSatelliteTileRejectsACoordinateThatOverflowsInt(t *testing.T) {
	upstream := newFakeMapTilerUpstream(t)
	srv := newSatelliteServer(t, upstream.URL+"/style.json", 1_000_000)
	getSatellite(t, srv, "/api/satellite-style.json")

	rec := getSatellite(t, srv, "/api/satellite-tile/satellite/5/2/99999999999999999999")
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for a coordinate too large for int", rec.Code)
	}
}

func TestSatelliteTileUpstreamFailureReturnsBadGateway(t *testing.T) {
	upstream := newFakeMapTilerUpstream(t)
	upstream.rasterFails.Store(true)
	srv := newSatelliteServer(t, upstream.URL+"/style.json", 1_000_000)
	getSatellite(t, srv, "/api/satellite-style.json")

	rec := getSatellite(t, srv, "/api/satellite-tile/satellite/9/9/9")
	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
}

func TestSatelliteSpriteIsProxiedAndCached(t *testing.T) {
	upstream := newFakeMapTilerUpstream(t)
	srv := newSatelliteServer(t, upstream.URL+"/style.json", 1_000_000)
	getSatellite(t, srv, "/api/satellite-style.json") // registers the sprite upstream

	for i := 0; i < 3; i++ {
		rec := getSatellite(t, srv, "/api/satellite-sprite.json")
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status %d: %s", i, rec.Code, rec.Body.String())
		}
	}

	if upstream.spriteCalls.Load() != 1 {
		t.Errorf("sprite upstream called %d times, want 1 (cached)", upstream.spriteCalls.Load())
	}

	// Sprite traffic is deliberately not part of the tile quota — see the
	// package doc comment in satellite.go.
	count, _ := srv.satellite.usage.Snapshot(1_000_000)
	if count != 0 {
		t.Errorf("usage count = %d, want 0 (sprite fetches must not count)", count)
	}
}

// Using the default MapTiler style with no key configured (SatelliteStyleURL
// empty, DT_MAPTILER_API_KEY unset) must refuse cleanly rather than attempt —
// and keep retrying — a fetch MapTiler would reject anyway.
func TestSatelliteStyleUnavailableWithNoStyleURLOrKey(t *testing.T) {
	srv, err := New(config.Config{
		Port:                0,
		DataDir:             t.TempDir(),
		Version:             "test",
		SatelliteQuotaLimit: 1_000_000,
		SatelliteUsageDir:   t.TempDir(),
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	rec := getSatellite(t, srv, "/api/satellite-style.json")
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404 when no style URL or key is configured", rec.Code)
	}
}

func TestSatelliteSpriteWithoutAStyleIs404(t *testing.T) {
	upstream := newFakeMapTilerUpstream(t)
	srv := newSatelliteServer(t, upstream.URL+"/style.json", 1_000_000)

	rec := getSatellite(t, srv, "/api/satellite-sprite.json")
	if rec.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404 before the style has ever been resolved", rec.Code)
	}
}

// Every satellite response now embeds absolute URLs pointing back at this
// server (see buildStyle's doc comment on why relative ones broke vector
// tiles), which means a dev setup serving the frontend and this backend from
// different origins — Vite on :5173 proxying everything else to :8080 — has
// the browser fetch those URLs directly, cross-origin, rather than through
// the proxy. Without this header the browser blocks every one of them.
func TestSatelliteResponsesAreCORSOpen(t *testing.T) {
	upstream := newFakeMapTilerUpstream(t)
	srv := newSatelliteServer(t, upstream.URL+"/style.json", 1_000_000)

	styleRec := getSatellite(t, srv, "/api/satellite-style.json")
	if got := styleRec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("style Access-Control-Allow-Origin = %q, want \"*\"", got)
	}

	tileJSONRec := getSatellite(t, srv, "/api/satellite-tilejson/roads")
	if got := tileJSONRec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("tilejson Access-Control-Allow-Origin = %q, want \"*\"", got)
	}

	tileRec := getSatellite(t, srv, "/api/satellite-tile/satellite/1/1/1")
	if got := tileRec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("tile Access-Control-Allow-Origin = %q, want \"*\"", got)
	}

	spriteRec := getSatellite(t, srv, "/api/satellite-sprite.json")
	if got := spriteRec.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("sprite Access-Control-Allow-Origin = %q, want \"*\"", got)
	}
}
