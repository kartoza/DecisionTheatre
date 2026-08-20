package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/gpkgtest"
)

// These tests drive the site data endpoints the way the hosted application
// does: browser runtime, site in the request body, no site store on the server
// at all. That is the exact path a whole-of-Africa walkthrough takes, and the
// path that answered 200 with `[]` (issue #140).

// newSiteTestHandler wires a Handler over a synthetic datapack whose three
// catchments have deliberately unequal areas (4, 1, 1), so an area-weighted
// mean is distinguishable from a plain one.
func newSiteTestHandler(t *testing.T, doctor ...string) *mux.Router {
	t.Helper()

	dir := gpkgtest.Build(t, t.TempDir(), []gpkgtest.Catchment{
		{ID: 1000000001, Lat: 0, Long: 0, SizeDeg: 2, Current: gpkgtest.Float(10), Reference: gpkgtest.Float(1)},
		{ID: 1000000002, Lat: 0, Long: 4, SizeDeg: 1, Current: gpkgtest.Float(20), Reference: gpkgtest.Float(2)},
		{ID: 1000000003, Lat: 0, Long: 8, SizeDeg: 1, Current: nil, Reference: gpkgtest.Float(3)},
	}, 0, 100)

	// Any doctoring has to happen before the store opens the file: it is
	// opened read-only and immutable.
	if len(doctor) > 0 {
		db, err := sql.Open("sqlite3", dir+"/datapack.gpkg")
		if err != nil {
			t.Fatalf("open datapack for doctoring: %v", err)
		}
		for _, stmt := range doctor {
			if _, err := db.Exec(stmt); err != nil {
				t.Fatalf("exec %q: %v", stmt, err)
			}
		}
		db.Close()
	}

	store, err := geodata.NewGpkgStore(dir)
	if err != nil {
		t.Fatalf("NewGpkgStore: %v", err)
	}
	t.Cleanup(store.Close)

	handler := NewHandler(nil, store, nil, config.Config{DataDir: dir, Version: "test"})
	r := mux.NewRouter()
	handler.RegisterRoutes(r)
	return r
}

// postSite makes the request a browser-runtime client makes: the site itself,
// in the body, with the ids it wants answered.
func postSite(t *testing.T, r *mux.Router, path string, catchmentIDs []string) *httptest.ResponseRecorder {
	t.Helper()

	body, err := json.Marshal(map[string]interface{}{
		"runtime": "browser",
		"site": map[string]interface{}{
			"id":             "test-site",
			"title":          "Test site",
			"catchmentIds":   catchmentIDs,
			"creationMethod": "catchments",
		},
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	req := httptest.NewRequest("POST", path, bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func manyIDs(count int) []string {
	ids := []string{"1000000001", "1000000002", "1000000003"}
	for i := len(ids); i < count; i++ {
		ids = append(ids, strconv.Itoa(2000000000+i))
	}
	return ids
}

// TestSiteCatchmentsFailureIsNotAnEmptySuccess is issue #63 seen from the
// client's end, and it is the assertion that matters most in this file.
//
// With the database read broken, the endpoint used to answer 200 with a 3-byte
// body: `[]`. Every view downstream treats that as a site whose catchments
// have no data, so a broken backend rendered as an empty table and a dial
// reading nothing, with nothing anywhere reporting a fault.
func TestSiteCatchmentsFailureIsNotAnEmptySuccess(t *testing.T) {
	r := newSiteTestHandler(t, fmt.Sprintf(
		`ALTER TABLE scenario_reference RENAME COLUMN "%s" TO "gone"`, gpkgtest.Attribute))

	w := postSite(t, r, "/sites/test-site/catchments", []string{"1000000001", "1000000002"})

	if w.Code == http.StatusOK {
		t.Fatalf("a failed query answered 200 with %q; an empty success renders as a blank view "+
			"and reports nothing", w.Body.String())
	}
	if w.Code != http.StatusInternalServerError {
		t.Errorf("status %d, want 500: %s", w.Code, w.Body.String())
	}
	if w.Body.Len() == 0 {
		t.Error("a failure should say what went wrong")
	}
}

func TestSiteWhiskersFailureIsNotAnEmptySuccess(t *testing.T) {
	r := newSiteTestHandler(t,
		// A whisker table that exists but cannot be read, as opposed to one
		// that is simply not in this datapack.
		`CREATE TABLE scenario_current_upper (catchment_id_int INTEGER, "gone" REAL)`)

	w := postSite(t, r, "/sites/test-site/whiskers", []string{"1000000001", "1000000002"})

	if w.Code == http.StatusOK {
		t.Fatalf("a failed whisker query answered 200 with %q; four nulls are what a chart with no "+
			"uncertainty range looks like, not what a failure should look like", w.Body.String())
	}
}

// TestSiteCatchmentsRefusesUnboundedResponse: the per-catchment breakdown is
// bounded, and says so. Measured against the real datapack this response is
// 1.16 GB for 32,766 catchments; a whole-of-Africa site has 147,837.
func TestSiteCatchmentsRefusesUnboundedResponse(t *testing.T) {
	r := newSiteTestHandler(t)

	w := postSite(t, r, "/sites/test-site/catchments", manyIDs(geodata.MaxDetailCatchments+1))

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status %d, want 413: %s", w.Code, w.Body.String())
	}
	if !bytes.Contains(w.Body.Bytes(), []byte(strconv.Itoa(geodata.MaxDetailCatchments))) {
		t.Errorf("the refusal should name the limit: %s", w.Body.String())
	}
}

// The three endpoints a continent-sized site actually needs must work at that
// size. Between them they are what the table, chart and dial views read.
func TestContinentSizedSiteIsAnswerable(t *testing.T) {
	r := newSiteTestHandler(t)
	ids := manyIDs(40000) // past SQLITE_MAX_VARIABLE_NUMBER, as Africa is

	t.Run("summary", func(t *testing.T) {
		w := postSite(t, r, "/sites/test-site/summary", ids)
		if w.Code != http.StatusOK {
			t.Fatalf("status %d: %s", w.Code, w.Body.String())
		}

		var got geodata.CatchmentAggregate
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode summary: %v (body %s)", err, w.Body.String())
		}
		// Areas come from the datapack: 4, 1, 1. Catchment 3 has no current
		// value, so it is excluded from that scenario entirely:
		//   (10*4 + 20*1) / (4 + 1) = 12
		if v := got.Current[gpkgtest.Attribute]; math.Abs(v-12) > 1e-9 {
			t.Errorf("current mean %v, want 12", v)
		}
		if got.MatchedCount != 3 {
			t.Errorf("matched %d catchments, want the 3 the datapack has", got.MatchedCount)
		}
		if w.Body.Len() > 64*1024 {
			t.Errorf("the summary grew to %d bytes; it is meant to be bounded regardless of site size", w.Body.Len())
		}
	})

	t.Run("whiskers", func(t *testing.T) {
		w := postSite(t, r, "/sites/test-site/whiskers", ids)
		if w.Code != http.StatusOK {
			t.Fatalf("status %d: %s", w.Code, w.Body.String())
		}
	})

	t.Run("slim catchments", func(t *testing.T) {
		w := postSite(t, r, "/sites/test-site/catchments?slim=true", ids)
		if w.Code != http.StatusOK {
			t.Fatalf("status %d: %s", w.Code, w.Body.String())
		}
		var got []struct {
			ID      string  `json:"id"`
			AreaKm2 float64 `json:"areaKm2"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode slim catchments: %v", err)
		}
		if len(got) != 3 {
			t.Fatalf("got %d catchments, want the 3 the datapack has", len(got))
		}
	})
}

// The summary is the answer the dial, chart and table were computing by hand
// from a per-catchment list. Both routes have to reach it, since the desktop
// build asks by id and the browser build posts the site.
func TestSiteSummaryIsAreaWeighted(t *testing.T) {
	r := newSiteTestHandler(t)

	w := postSite(t, r, "/sites/test-site/summary", []string{"1000000001", "1000000002", "1000000003"})
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}

	var got geodata.CatchmentAggregate
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode summary: %v", err)
	}
	// reference: (1*4 + 2*1 + 3*1) / 6 = 1.5
	if v := got.Reference[gpkgtest.Attribute]; math.Abs(v-1.5) > 1e-9 {
		t.Errorf("reference mean %v, want 1.5 - a plain mean would give 2", v)
	}
}

func TestSiteSummaryFailureIsNotAnEmptySuccess(t *testing.T) {
	r := newSiteTestHandler(t, fmt.Sprintf(
		`ALTER TABLE scenario_current RENAME COLUMN "%s" TO "gone"`, gpkgtest.Attribute))

	w := postSite(t, r, "/sites/test-site/summary", []string{"1000000001"})
	if w.Code == http.StatusOK {
		t.Fatalf("a failed aggregate answered 200 with %q", w.Body.String())
	}
}
