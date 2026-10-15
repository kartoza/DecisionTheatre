// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

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

// Every tile URL carries a "?v=<mtime>" suffix so a client that already
// cached a z/x/y tile (notably the desktop app's webview, which persists its
// HTTP cache across restarts) re-fetches once the underlying .mbtiles is
// rebuilt, instead of serving stale bytes for Cache-Control's full 24h
// max-age — see tileVersionSuffix and MBTilesStore.Version.
func TestCatchmentsTileJSONTileURLsCarryVersionSuffix(t *testing.T) {
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
		SourceLayer string   `json:"sourceLayer"`
		Tiles       []string `json:"tiles"`
	}
	if err := json.Unmarshal(doc["tilesets"], &levels); err != nil {
		t.Fatalf("no usable tilesets array: %v (doc keys: %v)", err, doc)
	}
	for _, l := range levels {
		for _, tileURL := range l.Tiles {
			if !strings.Contains(tileURL, "?v=") {
				t.Errorf("%s: tile URL %q carries no cache-busting ?v= suffix", l.SourceLayer, tileURL)
			}
		}
	}
}

// `dt serve-legacy`: with all three of --legacy's own tilesets present, the
// endpoint serves them as a three-band split document - a coarse hex grid
// for z2-z4, a finer one from z5 (real lev12 boundaries are too dense to
// render legibly below z9, and a single hex resolution across the whole
// z2-z8 band went sub-pixel and sparse below about z5), real lev12 detail
// from z9. Same split-tileset document shape the default multi-resolution
// mode uses, a different table. Both hex tiers share one sourceLayer
// (catchments_lev12_hex_coarse's own vector layer is renamed to it via the
// output_layer treatment-table column) - bands are told apart by tilezoom,
// not sourceLayer, so a shared name across tiers is fine.
func TestCatchmentsTileJSONLegacyFlagServesHexAndDetailSplit(t *testing.T) {
	dataDir := t.TempDir()
	mbtilesDir := filepath.Join(dataDir, "mbtiles")
	if err := os.MkdirAll(mbtilesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"context", "catchments-lev04", "catchments-lev06", "catchments-lev08", "catchments-lev12", "catchments-lev12-hex-coarse", "catchments-lev12-hex", "catchments-lev12-full"} {
		minimalMBTiles(t, mbtilesDir, name)
	}

	srv, err := New(config.Config{Port: 0, DataDir: dataDir, Version: "test", LegacyCatchments: true})
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
	if len(levels) != 3 {
		t.Fatalf("expected 3 legacy bands (coarse hex, fine hex, detail), got %d", len(levels))
	}
	wantZooms := map[string]int{"catchments-lev12-hex-coarse": 2, "catchments-lev12-hex": 5, "catchments-lev12-full": 9}
	wantSourceLayers := map[string]string{"catchments-lev12-hex-coarse": "catchments_lev12_hex", "catchments-lev12-hex": "catchments_lev12_hex", "catchments-lev12-full": "catchments_lev12"}
	for _, l := range levels {
		if wantZooms[l.Name] != l.Tilezoom {
			t.Errorf("%s: tilezoom %d, want %d", l.Name, l.Tilezoom, wantZooms[l.Name])
		}
		if wantSourceLayers[l.Name] != l.SourceLayer {
			t.Errorf("%s: sourceLayer %q, want %q", l.Name, l.SourceLayer, wantSourceLayers[l.Name])
		}
		if len(l.Tiles) == 0 {
			t.Errorf("%s: no tile URLs", l.Name)
		}
	}
}

// A partially built --legacy store (only some of the three tilesets exist)
// still serves what it has rather than falling all the way back - the same
// resilience the default mode's own split document already has for a
// missing level.
func TestCatchmentsTileJSONLegacyFlagServesWhicheverLegacyTilesetExists(t *testing.T) {
	dataDir := t.TempDir()
	mbtilesDir := filepath.Join(dataDir, "mbtiles")
	if err := os.MkdirAll(mbtilesDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// Only the detail tileset built yet, not either hex tier.
	for _, name := range []string{"context", "catchments-lev04", "catchments-lev06", "catchments-lev08", "catchments-lev12", "catchments-lev12-full"} {
		minimalMBTiles(t, mbtilesDir, name)
	}

	srv, err := New(config.Config{Port: 0, DataDir: dataDir, Version: "test", LegacyCatchments: true})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	doc := catchmentsTileJSON(t, srv)

	var levels []struct {
		SourceLayer string `json:"sourceLayer"`
	}
	if err := json.Unmarshal(doc["tilesets"], &levels); err != nil || len(levels) != 1 {
		t.Fatalf("expected the one built legacy band, got %v (err %v)", doc["tilesets"], err)
	}
	if levels[0].SourceLayer != "catchments_lev12" {
		t.Errorf("sourceLayer = %q, want catchments_lev12", levels[0].SourceLayer)
	}
}

// The flag must not take the map down with it when none of the three legacy
// tilesets has actually been built for this datapack - fall back to
// whatever the normal (non-legacy) resolution would have served, same as
// any other optional tileset's absence.
func TestCatchmentsTileJSONLegacyFlagWithoutEitherLegacyTilesetFallsBack(t *testing.T) {
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
