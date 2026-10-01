package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"

	"github.com/kartoza/decision-theatre/internal/gpkgtest"
)

// The identify tool used to have nothing to query below lev12 detail zoom:
// the grid-aggregated GeoJSON those zooms rendered carried no catchment id
// at all. Once the multi-resolution tiles started rendering real basin
// geometry there, a click carries a real HYBAS_ID - a basin id, not a lev12
// catchment id - and the plain /catchment/{id} lookup (scenario_current,
// keyed by lev12 ids) would never find it: a silent 404 the frontend
// swallowed, which is what "identify does nothing" looked like. The `level`
// parameter is the fix: it routes the lookup to the matching basin table.

func identifyGet(t *testing.T, r *mux.Router, target string) (*httptest.ResponseRecorder, map[string]map[string]float64) {
	t.Helper()
	req := httptest.NewRequest("GET", target, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)

	var resp map[string]map[string]float64
	if w.Code == http.StatusOK {
		if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
			t.Fatalf("decode response: %v (body %s)", err, w.Body.String())
		}
	}
	return w, resp
}

func TestCatchmentIdentifyWithLevelReturnsBasinAttributes(t *testing.T) {
	r := newLevelledValuesTestHandler(t)

	w, resp := identifyGet(t, r, "/catchment/4000000001?level=04")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if resp["current"][gpkgtest.Attribute] != 15 {
		t.Errorf("current = %v, want 15", resp["current"][gpkgtest.Attribute])
	}
	if resp["reference"][gpkgtest.Attribute] != 1.5 {
		t.Errorf("reference = %v, want 1.5", resp["reference"][gpkgtest.Attribute])
	}
}

func TestCatchmentIdentifyWithLevelSelectsTheRightBasin(t *testing.T) {
	r := newLevelledValuesTestHandler(t)

	_, second := identifyGet(t, r, "/catchment/6000000002?level=06")
	if second["current"][gpkgtest.Attribute] != 18 {
		t.Errorf("6000000002 current = %v, want 18 (not the other lev06 basin's 12)", second["current"][gpkgtest.Attribute])
	}
}

func TestCatchmentIdentifyRejectsUnknownLevel(t *testing.T) {
	r := newLevelledValuesTestHandler(t)

	w, _ := identifyGet(t, r, "/catchment/4000000001?level=99")
	if w.Code != http.StatusBadRequest {
		t.Errorf("status %d, want 400", w.Code)
	}
}

// A level-tagged id with no matching basin row is "not found", exactly as
// an unknown lev12 id already is - not a 500, and not a silently empty 200
// that would leave the identify panel showing nothing with no way to tell
// whether that was a real absence of data or a bug.
func TestCatchmentIdentifyWithLevelUnknownIDIs404(t *testing.T) {
	r := newLevelledValuesTestHandler(t)

	w, _ := identifyGet(t, r, "/catchment/9999999999?level=04")
	if w.Code != http.StatusNotFound {
		t.Errorf("status %d, want 404", w.Code)
	}
}

// Without a level parameter the endpoint's behaviour is exactly what it was
// before this feature existed: a lev12 lookup, unaffected by whether the
// datapack has basin tables at all.
func TestCatchmentIdentifyWithoutLevelStaysOnDetailPath(t *testing.T) {
	r := newLevelledValuesTestHandler(t)

	w, resp := identifyGet(t, r, "/catchment/1000000001")
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if resp["current"][gpkgtest.Attribute] != 10 {
		t.Errorf("current = %v, want 10", resp["current"][gpkgtest.Attribute])
	}
}

// A datapack without the multi-resolution tables (no scenario_current_lev04
// etc.) must answer "not found" for a level-tagged request, not a 500 - the
// frontend already only sends `level` when its own tileset resolution found
// banded tiles, but the endpoint must not trust that and crash if it didn't.
func TestCatchmentIdentifyWithLevelOnDatapackWithoutBasinTables(t *testing.T) {
	r := newValuesTestHandler(t)

	w, _ := identifyGet(t, r, "/catchment/1000000001?level=04")
	if w.Code != http.StatusNotFound {
		t.Errorf("status %d, want 404 (no basin tables in this datapack)", w.Code)
	}
}
