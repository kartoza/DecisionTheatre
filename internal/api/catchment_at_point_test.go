// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

package api

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/gpkgtest"
)

// GOLDEN RULE under test: catchment identification always reads lev12,
// regardless of which multi-resolution band would be rendered at a given
// zoom. /api/catchments/at-point is the mechanism - it never takes a zoom
// or a band, only a point, so there is nothing for it to get wrong.
//
// newPointLookupTestHandler deliberately includes a non-rectangular
// polygon (a right triangle) alongside an ordinary square. A square's
// bounding box and its polygon coincide, which would let a bbox-only
// implementation pass every test by accident; the triangle's does not, so
// a point inside its bbox but outside the triangle itself only passes if
// the real point-in-polygon test is doing the work.
func newPointLookupTestHandler(t *testing.T) *mux.Router {
	t.Helper()

	dir := gpkgtest.Build(t, t.TempDir(), []gpkgtest.Catchment{
		// Far from the triangle below, so its bbox can never be mistaken
		// as a candidate for a triangle-targeted point.
		{ID: 9000000001, Lat: 50, Long: 50, SizeDeg: 2, Current: gpkgtest.Float(1), Reference: gpkgtest.Float(1)},
	}, 0, 100)

	db, err := sql.Open("sqlite3", dir+"/datapack.gpkg")
	if err != nil {
		t.Fatalf("open datapack for doctoring: %v", err)
	}
	defer db.Close()

	// Right triangle with vertices (0,0), (2,0), (0,2). Its bounding box is
	// the square [0,2]x[0,2], but the corner near (2,2) - roughly a third
	// of that square's area - lies outside the triangle itself.
	const triangleID = 9000000002
	const triangleGeoJSON = `{"type":"Polygon","coordinates":[[[0,0],[2,0],[0,2],[0,0]]]}`
	if _, err := db.Exec(
		`INSERT INTO catchments_lev12 (fid, HYBAS_ID, HYBAS_ID_int, lat, long, SUB_AREA, geojson)
		 VALUES (2, ?, ?, 1, 1, 4, ?)`,
		fmt.Sprintf("%d", triangleID), triangleID, triangleGeoJSON,
	); err != nil {
		t.Fatalf("insert triangle catchment: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO rtree_catchments_lev12_geom (id, minx, maxx, miny, maxy) VALUES (2, 0, 2, 0, 2)`,
	); err != nil {
		t.Fatalf("insert triangle rtree row: %v", err)
	}

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

func atPoint(t *testing.T, r *mux.Router, lng, lat string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest("GET", "/catchments/at-point?lng="+lng+"&lat="+lat, nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestCatchmentAtPointResolvesOrdinarySquareCatchment(t *testing.T) {
	r := newPointLookupTestHandler(t)

	w := atPoint(t, r, "50", "50")
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var got map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["id"] != "9000000001" {
		t.Errorf("id = %q, want 9000000001", got["id"])
	}
}

func TestCatchmentAtPointResolvesRealPolygonNotJustBBox(t *testing.T) {
	r := newPointLookupTestHandler(t)

	w := atPoint(t, r, "0.5", "0.5")
	if w.Code != 200 {
		t.Fatalf("inside triangle: status %d: %s", w.Code, w.Body.String())
	}
	var got map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["id"] != "9000000002" {
		t.Errorf("inside triangle: id = %q, want 9000000002", got["id"])
	}
}

func TestCatchmentAtPointRejectsPointInBBoxButOutsidePolygon(t *testing.T) {
	r := newPointLookupTestHandler(t)

	// (1.8, 1.8): x+y = 3.6 > 2, so it is outside the triangle even though
	// it is inside the triangle's bounding box.
	w := atPoint(t, r, "1.8", "1.8")
	if w.Code != 404 {
		t.Fatalf("inside bbox, outside triangle: status %d, want 404: %s", w.Code, w.Body.String())
	}
}

func TestCatchmentAtPointFarFromAnyCatchmentIs404(t *testing.T) {
	r := newPointLookupTestHandler(t)

	w := atPoint(t, r, "-50", "-50")
	if w.Code != 404 {
		t.Fatalf("status %d, want 404", w.Code)
	}
}

func TestCatchmentAtPointRequiresLngAndLat(t *testing.T) {
	r := newPointLookupTestHandler(t)

	for _, qs := range []string{"", "?lng=1", "?lat=1", "?lng=notanumber&lat=1"} {
		req := httptest.NewRequest("GET", "/catchments/at-point"+qs, nil)
		w := httptest.NewRecorder()
		r.ServeHTTP(w, req)
		if w.Code != 400 {
			t.Errorf("query %q: status %d, want 400", qs, w.Code)
		}
	}
}

func TestCatchmentAtPointWithNoStoreIsServiceUnavailable(t *testing.T) {
	handler := NewHandler(nil, nil, nil, config.Config{Version: "test"}, nil)
	r := mux.NewRouter()
	handler.RegisterRoutes(r)

	w := atPoint(t, r, "0.5", "0.5")
	if w.Code != 503 {
		t.Fatalf("status %d, want 503", w.Code)
	}
}
