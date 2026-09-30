package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/gpkgtest"
)

// newValuesTestHandler wires a Handler over a synthetic datapack so the
// values endpoint is exercised through the real SQL, not a stub.
func newValuesTestHandler(t *testing.T) *mux.Router {
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

	handler := NewHandler(nil, store, nil, config.Config{DataDir: dir, Version: "test"}, nil)
	r := mux.NewRouter()
	handler.RegisterRoutes(r)
	return r
}

func getValues(t *testing.T, r *mux.Router, target string) (*httptest.ResponseRecorder, CatchmentValuesResponse) {
	t.Helper()
	req := httptest.NewRequest("GET", target, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	var resp CatchmentValuesResponse
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode response: %v (body %s)", err, w.Body.String())
		}
	}
	return w, resp
}

func TestCatchmentValuesReturnsIDsValuesAndDomain(t *testing.T) {
	r := newValuesTestHandler(t)

	w, resp := getValues(t, r,
		"/catchment-values?scenario=current&attribute="+gpkgtest.Attribute+"&minx=-5&miny=-5&maxx=5&maxy=5")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}

	if len(resp.IDs) != 2 || len(resp.Values) != 2 {
		t.Fatalf("expected 2 ids and 2 values, got %v / %v", resp.IDs, resp.Values)
	}
	if resp.DomainMin != 0 || resp.DomainMax != 100 {
		t.Errorf("domain range %v..%v, want 0..100", resp.DomainMin, resp.DomainMax)
	}
	if resp.Attribute != gpkgtest.Attribute || resp.Scenario != "current" {
		t.Errorf("echoed scenario/attribute wrong: %q %q", resp.Scenario, resp.Attribute)
	}
}

// The whole point of the endpoint: it must not carry geometry. A response that
// quietly grew a geometry field would reintroduce the cost the vector-tile path
// exists to remove, while still passing every other assertion here.
func TestCatchmentValuesCarriesNoGeometry(t *testing.T) {
	r := newValuesTestHandler(t)

	req := httptest.NewRequest("GET",
		"/catchment-values?scenario=current&attribute="+gpkgtest.Attribute+"&minx=-5&miny=-5&maxx=5&maxy=5", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	for _, forbidden := range []string{"geometry", "features", "coordinates"} {
		if _, present := raw[forbidden]; present {
			t.Errorf("response carries a %q field; the tile pipeline supplies geometry", forbidden)
		}
	}
}

// The colour scale must not depend on which transport delivered the geometry:
// /choropleth and /catchment-values have to agree on the domain, or switching
// between the aggregated and tiled zoom ranges would recolour the map.
func TestCatchmentValuesDomainMatchesChoropleth(t *testing.T) {
	r := newValuesTestHandler(t)

	_, values := getValues(t, r,
		"/catchment-values?scenario=current&attribute="+gpkgtest.Attribute+"&minx=-5&miny=-5&maxx=5&maxy=5")

	req := httptest.NewRequest("GET",
		"/choropleth?scenario=current&attribute="+gpkgtest.Attribute+"&minx=-5&miny=-5&maxx=5&maxy=5", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("choropleth status %d: %s", w.Code, w.Body.String())
	}
	var choropleth ChoroplethResponse
	if err := json.Unmarshal(w.Body.Bytes(), &choropleth); err != nil {
		t.Fatalf("decode choropleth: %v", err)
	}

	if values.DomainMin != choropleth.DomainMin || values.DomainMax != choropleth.DomainMax {
		t.Errorf("domain %v..%v from values, %v..%v from choropleth",
			values.DomainMin, values.DomainMax, choropleth.DomainMin, choropleth.DomainMax)
	}
}

func TestCatchmentValuesRespectsBBox(t *testing.T) {
	r := newValuesTestHandler(t)

	_, resp := getValues(t, r,
		"/catchment-values?scenario=current&attribute="+gpkgtest.Attribute+"&minx=-0.4&miny=-0.4&maxx=0.4&maxy=0.4")
	if len(resp.IDs) != 1 || resp.IDs[0] != 1000000001 {
		t.Fatalf("expected only the catchment at the origin, got %v", resp.IDs)
	}
}

func TestCatchmentValuesValidatesParameters(t *testing.T) {
	r := newValuesTestHandler(t)

	cases := []struct {
		name   string
		target string
		status int
	}{
		{"missing attribute", "/catchment-values?scenario=current&minx=-5&miny=-5&maxx=5&maxy=5", http.StatusBadRequest},
		{"unparseable bbox", "/catchment-values?scenario=current&attribute=" + gpkgtest.Attribute + "&minx=west&miny=-5&maxx=5&maxy=5", http.StatusBadRequest},
		{"unknown attribute", "/catchment-values?scenario=current&attribute=not_a_column&minx=-5&miny=-5&maxx=5&maxy=5", http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tc.target, nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			if w.Code != tc.status {
				t.Errorf("status %d, want %d (body %s)", w.Code, tc.status, w.Body.String())
			}
		})
	}
}

// "future" is the reference scenario recoloured by a site's saved targets. With
// no site it must fall back to reference values, exactly as /choropleth does.
func TestCatchmentValuesFutureFallsBackToReference(t *testing.T) {
	r := newValuesTestHandler(t)

	_, future := getValues(t, r,
		"/catchment-values?scenario=future&attribute="+gpkgtest.Attribute+"&minx=-5&miny=-5&maxx=5&maxy=5")
	_, reference := getValues(t, r,
		"/catchment-values?scenario=reference&attribute="+gpkgtest.Attribute+"&minx=-5&miny=-5&maxx=5&maxy=5")

	if len(future.Values) != len(reference.Values) {
		t.Fatalf("future returned %d values, reference %d", len(future.Values), len(reference.Values))
	}
	for i := range future.Values {
		if future.Values[i] != reference.Values[i] {
			t.Errorf("value %d: future %v != reference %v", i, future.Values[i], reference.Values[i])
		}
	}
}

func TestCatchmentValuesWithoutStoreIsUnavailable(t *testing.T) {
	handler := newTestHandler()
	r := mux.NewRouter()
	handler.RegisterRoutes(r)

	req := httptest.NewRequest("GET",
		"/catchment-values?scenario=current&attribute=x&minx=-5&miny=-5&maxx=5&maxy=5", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("status %d, want 503", w.Code)
	}
}

// newLevelledValuesTestHandler is newValuesTestHandler plus the
// multi-resolution basin tables, so the zoom parameter's level dispatch is
// exercised through the real SQL.
func newLevelledValuesTestHandler(t *testing.T) *mux.Router {
	t.Helper()

	dir := t.TempDir()
	gpkgtest.Build(t, dir, []gpkgtest.Catchment{
		{ID: 1000000001, Lat: 0, Long: 0, SizeDeg: 0.5, Current: gpkgtest.Float(10), Reference: gpkgtest.Float(1)},
		{ID: 1000000002, Lat: 0, Long: 1, SizeDeg: 0.5, Current: gpkgtest.Float(20), Reference: gpkgtest.Float(2)},
	}, 0, 100)
	gpkgtest.AddBasinLevels(t, dir, map[string][]gpkgtest.Basin{
		"04": {{ID: 4000000001, Current: gpkgtest.Float(15), Reference: gpkgtest.Float(1.5)}},
		"06": {
			{ID: 6000000001, Current: gpkgtest.Float(12), Reference: gpkgtest.Float(1.2)},
			{ID: 6000000002, Current: gpkgtest.Float(18), Reference: gpkgtest.Float(1.8)},
		},
	})

	store, err := geodata.NewGpkgStore(dir)
	if err != nil {
		t.Fatalf("NewGpkgStore: %v", err)
	}
	t.Cleanup(store.Close)

	handler := NewHandler(nil, store, nil, config.Config{DataDir: dir, Version: "test"}, nil)
	r := mux.NewRouter()
	handler.RegisterRoutes(r)
	return r
}

// The tiles carry catchments_lev04 in the z2-z5 band and lev06 in z6-z8, so a
// zoom in those bands must return that level's basin ids — lev12 ids would
// never match the tiles' feature ids and the choropleth would paint nothing.
func TestCatchmentValuesZoomSelectsBasinLevel(t *testing.T) {
	r := newLevelledValuesTestHandler(t)

	_, low := getValues(t, r,
		"/catchment-values?scenario=current&attribute="+gpkgtest.Attribute+"&minx=-5&miny=-5&maxx=5&maxy=5&zoom=2")
	if len(low.IDs) != 1 || low.IDs[0] != 4000000001 || low.Values[0] != 15 {
		t.Fatalf("zoom=2 should serve lev04 basins, got ids %v values %v", low.IDs, low.Values)
	}

	_, mid := getValues(t, r,
		"/catchment-values?scenario=current&attribute="+gpkgtest.Attribute+"&minx=-5&miny=-5&maxx=5&maxy=5&zoom=6.5")
	if len(mid.IDs) != 2 || mid.IDs[0] != 6000000001 || mid.IDs[1] != 6000000002 {
		t.Fatalf("zoom=6.5 should serve lev06 basins, got ids %v", mid.IDs)
	}
}

// From zoom 11 the tiles carry full lev12 detail, so the zoom parameter must
// change nothing: same ids, same bbox filtering as a request without it.
func TestCatchmentValuesZoomAboveBandsIsDetail(t *testing.T) {
	r := newLevelledValuesTestHandler(t)

	_, resp := getValues(t, r,
		"/catchment-values?scenario=current&attribute="+gpkgtest.Attribute+"&minx=-0.4&miny=-0.4&maxx=0.4&maxy=0.4&zoom=11.5")
	if len(resp.IDs) != 1 || resp.IDs[0] != 1000000001 {
		t.Fatalf("zoom=11.5 should serve bbox-filtered lev12 catchments, got %v", resp.IDs)
	}
}

// A datapack tiled before the multi-resolution levels existed has no basin
// tables; a zoomed request must fall back to lev12 values rather than erroring,
// exactly as the GeoJSON path does.
func TestCatchmentValuesZoomWithoutBasinTablesFallsBack(t *testing.T) {
	r := newValuesTestHandler(t)

	_, resp := getValues(t, r,
		"/catchment-values?scenario=current&attribute="+gpkgtest.Attribute+"&minx=-5&miny=-5&maxx=5&maxy=5&zoom=3")
	if len(resp.IDs) != 2 {
		t.Fatalf("expected lev12 fallback with 2 catchments, got %v", resp.IDs)
	}
}

func TestCatchmentValuesRejectsUnparseableZoom(t *testing.T) {
	r := newValuesTestHandler(t)

	w, _ := getValues(t, r,
		"/catchment-values?scenario=current&attribute="+gpkgtest.Attribute+"&minx=-5&miny=-5&maxx=5&maxy=5&zoom=deep")
	if w.Code != http.StatusBadRequest {
		t.Errorf("status %d, want 400", w.Code)
	}
}

// The four numbers the "Full" range mode needs, computed where the data
// lives. Must match what the client's zoneStatsFromValues derived from the
// raw payload: plain min/max/mean over non-null values, count of values used.
func TestFullDomainStats(t *testing.T) {
	r := newValuesTestHandler(t)

	req := httptest.NewRequest("GET", "/stats/full?scenario=current&attribute="+gpkgtest.Attribute, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var resp FullDomainStatsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Min != 10 || resp.Max != 20 || resp.Mean != 15 || resp.Count != 2 {
		t.Errorf("stats = %+v, want min 10 max 20 mean 15 count 2", resp)
	}
}

// "future" with no site is the reference scenario, exactly as /choropleth
// and /catchment-values treat it — disagreeing would recolour the Full range
// depending on which endpoint a client asked.
func TestFullDomainStatsFutureIsReference(t *testing.T) {
	r := newValuesTestHandler(t)

	get := func(scenario string) FullDomainStatsResponse {
		req := httptest.NewRequest("GET", "/stats/full?scenario="+scenario+"&attribute="+gpkgtest.Attribute, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != http.StatusOK {
			t.Fatalf("%s status %d: %s", scenario, w.Code, w.Body.String())
		}
		var resp FullDomainStatsResponse
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode: %v", err)
		}
		return resp
	}

	future, reference := get("future"), get("reference")
	if future.Min != reference.Min || future.Max != reference.Max || future.Mean != reference.Mean || future.Count != reference.Count {
		t.Errorf("future %+v != reference %+v", future, reference)
	}
}

func TestFullDomainStatsValidatesParameters(t *testing.T) {
	r := newValuesTestHandler(t)

	cases := []struct {
		name   string
		target string
		status int
	}{
		{"missing attribute", "/stats/full?scenario=current", http.StatusBadRequest},
		{"unknown attribute", "/stats/full?scenario=current&attribute=not_a_column", http.StatusInternalServerError},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tc.target, nil)
			w := httptest.NewRecorder()
			r.ServeHTTP(w, req)
			if w.Code != tc.status {
				t.Errorf("status %d, want %d (body %s)", w.Code, tc.status, w.Body.String())
			}
		})
	}
}
