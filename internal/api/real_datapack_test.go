package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	_ "github.com/mattn/go-sqlite3"
)

// The whole-of-Africa walkthrough, over HTTP, against a real datapack. Skipped
// unless one is pointed at:
//
//	DT_DATAPACK_DIR=/path/to/data go test ./internal/api/ -run TestRealDatapack -v -timeout 30m
//
// This is issue #140 as it was actually reported - the site posts 147,837
// catchment ids and reads back four views - and it is deliberately at the HTTP
// layer rather than the store's, because the last failure was in writing the
// response, not in computing it: whiskers took 391 seconds and then died with
// "write tcp ...: i/o timeout", which no store-level test would have caught.

func realDatapackRouter(t *testing.T, dir string) *mux.Router {
	t.Helper()
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

// everyCatchmentID reads the ids straight out of the datapack, as a client
// that had selected the whole continent would hold them. HYBAS_ID is a REAL
// column, so scanning it into a string is how a caller ends up with ids
// spelled "1.12187985e+09" - which is exactly the input that must not quietly
// cost the fast query plan.
func everyCatchmentID(t *testing.T, dir string) []string {
	t.Helper()
	db, err := sql.Open("sqlite3", "file:"+dir+"/datapack.gpkg?mode=ro&immutable=1")
	if err != nil {
		t.Fatalf("open datapack: %v", err)
	}
	defer db.Close()

	rows, err := db.Query(`SELECT HYBAS_ID FROM catchments_lev12`)
	if err != nil {
		t.Fatalf("read ids: %v", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatalf("scan id: %v", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read ids: %v", err)
	}
	return ids
}

func TestRealDatapackAfricaWalkthrough(t *testing.T) {
	dir := os.Getenv("DT_DATAPACK_DIR")
	if dir == "" {
		t.Skip("set DT_DATAPACK_DIR to a directory containing datapack.gpkg to run this")
	}
	if _, err := os.Stat(dir + "/datapack.gpkg"); err != nil {
		t.Skipf("no datapack.gpkg in %s: %v", dir, err)
	}

	router := realDatapackRouter(t, dir)
	ids := everyCatchmentID(t, dir)
	t.Logf("posting %d catchment ids", len(ids))

	body, err := json.Marshal(map[string]interface{}{
		"runtime": "browser",
		"site": map[string]interface{}{
			"id":             "africa",
			"title":          "Africa",
			"catchmentIds":   ids,
			"creationMethod": "catchments",
		},
	})
	if err != nil {
		t.Fatalf("marshal request: %v", err)
	}

	post := func(path string) (*httptest.ResponseRecorder, time.Duration) {
		start := time.Now()
		req := httptest.NewRequest("POST", path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		router.ServeHTTP(w, req)
		return w, time.Since(start)
	}

	t.Run("summary answers with the whole continent aggregated", func(t *testing.T) {
		w, elapsed := post("/sites/africa/summary")
		if w.Code != http.StatusOK {
			t.Fatalf("status %d: %s", w.Code, w.Body.String())
		}
		t.Logf("summary: %d bytes in %v", w.Body.Len(), elapsed.Round(time.Millisecond))

		var got geodata.CatchmentAggregate
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode summary: %v", err)
		}
		if got.MatchedCount == 0 || len(got.Current) == 0 {
			t.Fatalf("summary describes nothing: matched %d, %d attributes", got.MatchedCount, len(got.Current))
		}
		if got.TotalAreaKm2 <= 0 {
			t.Errorf("total area is %v", got.TotalAreaKm2)
		}
	})

	t.Run("whiskers answer with real bounds", func(t *testing.T) {
		w, elapsed := post("/sites/africa/whiskers")
		if w.Code != http.StatusOK {
			t.Fatalf("status %d: %s", w.Code, w.Body.String())
		}
		t.Logf("whiskers: %d bytes in %v", w.Body.Len(), elapsed.Round(time.Millisecond))

		var got geodata.WhiskerBounds
		if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
			t.Fatalf("decode whiskers: %v", err)
		}
		// The reported failure was a body of exactly this shape with all four
		// fields null, delivered as 200.
		for name, bound := range map[string]map[string]float64{
			"referenceLower": got.ReferenceLower, "referenceUpper": got.ReferenceUpper,
			"currentLower": got.CurrentLower, "currentUpper": got.CurrentUpper,
		} {
			if len(bound) == 0 {
				t.Errorf("%s came back empty; that is the null-whiskers bug", name)
			}
		}
	})

	t.Run("the per-catchment breakdown is refused, not attempted", func(t *testing.T) {
		w, elapsed := post("/sites/africa/catchments")
		if w.Code != http.StatusRequestEntityTooLarge {
			t.Fatalf("status %d, want 413: %s", w.Code, w.Body.String())
		}
		// It must be refused on sight, not after building a multi-gigabyte
		// answer and then thinking better of it.
		if elapsed > 5*time.Second {
			t.Errorf("took %v to refuse; the bound is meant to be checked before any work", elapsed)
		}
		t.Logf("catchments: %d, %s", w.Code, w.Body.String())
	})
}
