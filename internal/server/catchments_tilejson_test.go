package server

import (
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"

	"github.com/kartoza/decision-theatre/internal/config"
)

// minimalMBTiles writes an empty-but-valid mbtiles file so the tile store
// registers a tileset under its filename. Contents don't matter here — these
// tests assert which *document shape* /data/catchments-tiles.json serves for
// which generation of datapack.
func minimalMBTiles(t *testing.T, dir, name string) {
	t.Helper()
	db, err := sql.Open("sqlite3", filepath.Join(dir, name+".mbtiles"))
	if err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	defer db.Close()
	for _, stmt := range []string{
		`CREATE TABLE metadata (name TEXT, value TEXT)`,
		`CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)`,
		`INSERT INTO metadata (name, value) VALUES ('format', 'pbf')`,
	} {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("exec %s: %v", stmt, err)
		}
	}
}

func catchmentsTileJSON(t *testing.T, srv *Server) map[string]json.RawMessage {
	t.Helper()
	req := httptest.NewRequest("GET", "http://127.0.0.1/data/catchments-tiles.json", nil)
	w := httptest.NewRecorder()
	srv.currentRouter().ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal(w.Body.Bytes(), &doc); err != nil {
		t.Fatalf("decode: %v", err)
	}
	return doc
}

// A datapack tiled with the split-tileset matrix (one standalone tileset per
// catchment level, each at a single zoom) must be described by the "tilesets"
// form: per-level tile URLs and the tilezoom the client turns into
// minzoom=maxzoom on its own MapLibre source — that equality is what makes
// MapLibre overzoom the level across its whole display band.
func TestCatchmentsTileJSONSplitTilesets(t *testing.T) {
	dataDir := t.TempDir()
	mbtilesDir := filepath.Join(dataDir, "mbtiles")
	if err := os.MkdirAll(mbtilesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"context", "catchments-lev04", "catchments-lev06", "catchments-lev08", "catchments-lev12"} {
		minimalMBTiles(t, mbtilesDir, name)
	}

	srv, err := New(config.Config{Port: 0, DataDir: dataDir, Version: "test"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	doc := catchmentsTileJSON(t, srv)

	var levels []struct {
		Name        string   `json:"name"`
		SourceLayer string   `json:"sourceLayer"`
		Tilezoom    int      `json:"tilezoom"`
		Tiles       []string `json:"tiles"`
	}
	if err := json.Unmarshal(doc["tilesets"], &levels); err != nil {
		t.Fatalf("no usable tilesets array: %v (doc keys: %v)", err, doc)
	}
	if len(levels) != 4 {
		t.Fatalf("expected 4 level tilesets, got %d", len(levels))
	}
	wantZooms := map[string]int{
		"catchments_lev04": 0, "catchments_lev06": 6,
		"catchments_lev08": 9, "catchments_lev12": 11,
	}
	for _, l := range levels {
		if wantZooms[l.SourceLayer] != l.Tilezoom {
			t.Errorf("%s: tilezoom %d, want %d", l.SourceLayer, l.Tilezoom, wantZooms[l.SourceLayer])
		}
		if len(l.Tiles) == 0 {
			t.Errorf("%s: no tile URLs", l.SourceLayer)
		}
	}
}

// `dt serve-legacy`: with the wide-range catchments-lev12-full tileset
// present, the endpoint serves it with the plain single-tileset TileJSON
// shape (no "tilesets" array) spanning its full declared zoom range - which
// is the entire mechanism: the frontend's existing single-band tileset
// handling renders lev12 detail from the lowest zoom up with no further
// awareness that this mode exists at all.
func TestCatchmentsTileJSONLegacyFlagServesWideLev12(t *testing.T) {
	dataDir := t.TempDir()
	mbtilesDir := filepath.Join(dataDir, "mbtiles")
	if err := os.MkdirAll(mbtilesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"context", "catchments-lev04", "catchments-lev06", "catchments-lev08", "catchments-lev12", "catchments-lev12-full"} {
		minimalMBTiles(t, mbtilesDir, name)
	}

	srv, err := New(config.Config{Port: 0, DataDir: dataDir, Version: "test", LegacyCatchments: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	doc := catchmentsTileJSON(t, srv)

	if _, hasSplit := doc["tilesets"]; hasSplit {
		t.Error("--legacy served the split multi-resolution document instead of the wide lev12 tileset")
	}
	var tiles []string
	if err := json.Unmarshal(doc["tiles"], &tiles); err != nil || len(tiles) == 0 {
		t.Fatalf("legacy document missing tiles URLs: %v", err)
	}
	for _, u := range tiles {
		if !strings.Contains(u, "/tiles/catchments-lev12-full/") {
			t.Errorf("tile URL %q does not reference catchments-lev12-full", u)
		}
	}
	var minz, maxz float64
	if err := json.Unmarshal(doc["minzoom"], &minz); err != nil || minz != 2 {
		t.Errorf("minzoom = %v, want 2", minz)
	}
	if err := json.Unmarshal(doc["maxzoom"], &maxz); err != nil || maxz != 12 {
		t.Errorf("maxzoom = %v, want 12", maxz)
	}
}

// The flag must not take the map down with it when the wide tileset hasn't
// actually been built for this datapack - fall back to whatever the normal
// (non-legacy) resolution would have served, same as any other optional
// tileset's absence.
func TestCatchmentsTileJSONLegacyFlagWithoutWideTilesetFallsBack(t *testing.T) {
	dataDir := t.TempDir()
	mbtilesDir := filepath.Join(dataDir, "mbtiles")
	if err := os.MkdirAll(mbtilesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"context", "catchments-lev04", "catchments-lev06", "catchments-lev08", "catchments-lev12"} {
		minimalMBTiles(t, mbtilesDir, name)
	}

	srv, err := New(config.Config{Port: 0, DataDir: dataDir, Version: "test", LegacyCatchments: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	doc := catchmentsTileJSON(t, srv)

	levels, ok := doc["tilesets"]
	if !ok {
		t.Fatal("expected fallback to the split multi-resolution document")
	}
	var parsed []struct {
		SourceLayer string `json:"sourceLayer"`
	}
	if err := json.Unmarshal(levels, &parsed); err != nil || len(parsed) != 4 {
		t.Errorf("fallback document malformed: %v", err)
	}
}

// A legacy datapack (one combined catchments tileset) must keep getting the
// single-tileset TileJSON unchanged, so older data keeps rendering.
func TestCatchmentsTileJSONLegacyFallback(t *testing.T) {
	dataDir := t.TempDir()
	mbtilesDir := filepath.Join(dataDir, "mbtiles")
	if err := os.MkdirAll(mbtilesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	minimalMBTiles(t, mbtilesDir, "catchments")

	srv, err := New(config.Config{Port: 0, DataDir: dataDir, Version: "test"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	doc := catchmentsTileJSON(t, srv)

	if _, hasSplit := doc["tilesets"]; hasSplit {
		t.Error("legacy datapack served the split-tileset document")
	}
	var tiles []string
	if err := json.Unmarshal(doc["tiles"], &tiles); err != nil || len(tiles) == 0 {
		t.Errorf("legacy document missing tiles URLs: %v", err)
	}
}
