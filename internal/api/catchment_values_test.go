package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/gpkgtest"
)

func TestParseScenarioList(t *testing.T) {
	cases := []struct {
		name    string
		raw     string
		want    []string
		wantErr bool
	}{
		{name: "empty defaults to current", raw: "", want: []string{"current"}},
		{name: "single", raw: "reference", want: []string{"reference"}},
		{name: "pair keeps request order", raw: "reference,current", want: []string{"reference", "current"}},
		{name: "whitespace tolerated", raw: " current , future ", want: []string{"current", "future"}},
		// A comparison can have the same scenario on both sides; one series is
		// the right answer, not two identical ones.
		{name: "repeats collapse", raw: "current,current", want: []string{"current"}},
		{name: "unknown rejected", raw: "current,scenario_current", wantErr: true},
		// The render path answers an unrecognised scenario from scenario_current.
		// This path takes a caller-supplied list, so it says no instead.
		{name: "sql fragment rejected", raw: "current;DROP TABLE catchments_lev12", wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := parseScenarioList(tc.raw)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected %q to be rejected, got %v", tc.raw, got)
				}
				return
			}
			if err != nil {
				t.Fatalf("parseScenarioList(%q): %v", tc.raw, err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("parseScenarioList(%q) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

func seriesOf(values ...float64) *geodata.ScenarioValues {
	series := &geodata.ScenarioValues{}
	for _, v := range values {
		series.Values = append(series.Values, v)
		series.Valid = append(series.Valid, true)
	}
	return series
}

// A single-scenario response carries one flat values array, and no trace of the
// FeatureCollection it replaced.
func TestSingleScenarioResponseIsFlat(t *testing.T) {
	response := CatchmentValuesResponse{
		Type:      CatchmentValuesType,
		Attribute: "NPP_gm2",
		Scenarios: []string{"current"},
		IDs:       []int64{1121879850, 1121879851},
		Values:    seriesOf(1234.5678901234, 2.5),
		DomainMin: 0,
		DomainMax: 9999,
	}

	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshalling response: %v", err)
	}
	body := string(encoded)

	for _, forbidden := range []string{"FeatureCollection", `"features"`, `"geometry"`, `"properties"`} {
		if strings.Contains(body, forbidden) {
			t.Errorf("response still carries %s: %s", forbidden, body)
		}
	}
	want := `{"type":"CatchmentValues","attribute":"NPP_gm2","scenarios":["current"],` +
		`"ids":[1121879850,1121879851],"values":[1234.5678901234,2.5],"domain_min":0,"domain_max":9999}`
	if body != want {
		t.Errorf("unexpected wire format:\n got: %s\nwant: %s", body, want)
	}
}

// A two-scenario response is the deduplication of two concurrent requests: one
// ID array, one values array per scenario.
func TestMultiScenarioResponseSendsIDsOnce(t *testing.T) {
	response := CatchmentValuesResponse{
		Type:      CatchmentValuesType,
		Attribute: "NPP_gm2",
		Scenarios: []string{"current", "reference"},
		IDs:       []int64{1121879850, 1121879851},
		Series: map[string]*geodata.ScenarioValues{
			"current":   seriesOf(1, 2),
			"reference": seriesOf(3, 4),
		},
	}

	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatalf("marshalling response: %v", err)
	}
	body := string(encoded)

	if strings.Count(body, "1121879850") != 1 {
		t.Errorf("the id array was sent more than once: %s", body)
	}
	if strings.Contains(body, `"values":`) {
		t.Errorf("a multi-scenario response should not also carry a flat values array: %s", body)
	}
	var decoded struct {
		Series map[string][]float64 `json:"series"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decoding response: %v", err)
	}
	if !reflect.DeepEqual(decoded.Series["reference"], []float64{3, 4}) {
		t.Errorf("reference series did not survive the round trip: %v", decoded.Series["reference"])
	}
}

// The site store is optional (browser runtime, or a request without a site), and
// its absence must not cost the caller their statistics.
func TestIdealOverridesWithoutASite(t *testing.T) {
	h := newTestHandler()

	if got := h.idealOverridesFor("", "NPP_gm2"); len(got) != 0 {
		t.Errorf("expected no overrides without a site id, got %v", got)
	}
	if got := h.idealOverridesFor("some-site", "NPP_gm2"); len(got) != 0 {
		t.Errorf("expected no overrides without a site store, got %v", got)
	}
}

// newValuesTestHandler wires a Handler over a synthetic datapack so the
// /catchment-values endpoint is exercised through the real SQL, not a stub.
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

func getTileValues(t *testing.T, r *mux.Router, target string) (*httptest.ResponseRecorder, TileValuesResponse) {
	t.Helper()
	req := httptest.NewRequest("GET", target, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	var resp TileValuesResponse
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode response: %v (body %s)", err, w.Body.String())
		}
	}
	return w, resp
}

func TestCatchmentValuesReturnsIDsValuesAndDomain(t *testing.T) {
	r := newValuesTestHandler(t)

	w, resp := getTileValues(t, r,
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

	_, values := getTileValues(t, r,
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

	_, resp := getTileValues(t, r,
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

	_, future := getTileValues(t, r,
		"/catchment-values?scenario=future&attribute="+gpkgtest.Attribute+"&minx=-5&miny=-5&maxx=5&maxy=5")
	_, reference := getTileValues(t, r,
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
