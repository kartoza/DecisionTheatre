package api

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/kartoza/decision-theatre/internal/geodata"
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
