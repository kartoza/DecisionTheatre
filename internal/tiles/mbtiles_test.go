package tiles

import (
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

// createTestMBTiles creates a temporary MBTiles database for testing
func createTestMBTiles(t *testing.T, dir, name string) string {
	t.Helper()

	dbPath := filepath.Join(dir, name+".mbtiles")
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("Failed to create test DB: %v", err)
	}
	defer db.Close()

	// Create MBTiles schema
	statements := []string{
		`CREATE TABLE metadata (name TEXT, value TEXT)`,
		`CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)`,
		`INSERT INTO metadata (name, value) VALUES ('name', 'test')`,
		`INSERT INTO metadata (name, value) VALUES ('format', 'pbf')`,
		`INSERT INTO metadata (name, value) VALUES ('minzoom', '0')`,
		`INSERT INTO metadata (name, value) VALUES ('maxzoom', '14')`,
		`INSERT INTO metadata (name, value) VALUES ('bounds', '-180,-85,180,85')`,
		`INSERT INTO metadata (name, value) VALUES ('center', '0,0,2')`,
		`INSERT INTO metadata (name, value) VALUES ('type', 'overlay')`,
		// Insert a test tile at z=0, x=0, y=0 (TMS y=0)
		`INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (0, 0, 0, X'1F8B0800000000000003')`,
	}

	for _, stmt := range statements {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("Failed to execute: %s: %v", stmt, err)
		}
	}

	return dbPath
}

func TestNewMBTilesStore(t *testing.T) {
	dir := t.TempDir()
	createTestMBTiles(t, dir, "test")

	store, err := NewMBTilesStore(dir)
	if err != nil {
		t.Fatalf("NewMBTilesStore failed: %v", err)
	}
	defer store.Close()

	tilesets := store.ListTilesets()
	if len(tilesets) != 1 {
		t.Errorf("Expected 1 tileset, got %d", len(tilesets))
	}
	if tilesets[0] != "test" {
		t.Errorf("Expected tileset name 'test', got '%s'", tilesets[0])
	}
}

// TestVersionChangesOnRebuild guards the cache-busting mechanism
// tileVersionSuffix (internal/server) relies on: a tileset's Version must
// change whenever its .mbtiles file is rebuilt, since that's the only
// signal that invalidates a client's (notably the desktop app's webview,
// which persists its HTTP cache across restarts) already-cached tiles for
// unchanged z/x/y coordinates under Cache-Control's 24h max-age.
func TestVersionChangesOnRebuild(t *testing.T) {
	dir := t.TempDir()
	dbPath := createTestMBTiles(t, dir, "test")

	store, err := NewMBTilesStore(dir)
	if err != nil {
		t.Fatalf("NewMBTilesStore failed: %v", err)
	}
	defer store.Close()

	before, ok := store.Version("test")
	if !ok {
		t.Fatal("Version(\"test\") reported unknown; expected the mtime captured at load time")
	}

	rebuilt := before + 1 // a real rebuild always advances mtime; simulate without a sleep
	if err := os.Chtimes(dbPath, time.Unix(rebuilt, 0), time.Unix(rebuilt, 0)); err != nil {
		t.Fatalf("Chtimes failed: %v", err)
	}

	store2, err := NewMBTilesStore(dir)
	if err != nil {
		t.Fatalf("second NewMBTilesStore failed: %v", err)
	}
	defer store2.Close()

	after, ok := store2.Version("test")
	if !ok {
		t.Fatal("Version(\"test\") reported unknown on the reloaded store")
	}
	if after == before {
		t.Errorf("Version did not change after the file's mtime advanced: still %d", after)
	}
}

func TestVersionUnknownTileset(t *testing.T) {
	dir := t.TempDir()
	createTestMBTiles(t, dir, "test")

	store, err := NewMBTilesStore(dir)
	if err != nil {
		t.Fatalf("NewMBTilesStore failed: %v", err)
	}
	defer store.Close()

	if _, ok := store.Version("does-not-exist"); ok {
		t.Error("Version reported ok=true for a tileset that was never loaded")
	}
}

func TestGetTile(t *testing.T) {
	dir := t.TempDir()
	createTestMBTiles(t, dir, "test")

	store, err := NewMBTilesStore(dir)
	if err != nil {
		t.Fatalf("NewMBTilesStore failed: %v", err)
	}
	defer store.Close()

	// z=0, x=0, y=0 in XYZ -> TMS y = (1<<0) - 1 - 0 = 0
	data, err := store.GetTile("test", 0, 0, 0)
	if err != nil {
		t.Fatalf("GetTile failed: %v", err)
	}

	if len(data) == 0 {
		t.Error("Expected non-empty tile data")
	}
}

func TestGetTileNotFound(t *testing.T) {
	dir := t.TempDir()
	createTestMBTiles(t, dir, "test")

	store, err := NewMBTilesStore(dir)
	if err != nil {
		t.Fatalf("NewMBTilesStore failed: %v", err)
	}
	defer store.Close()

	_, err = store.GetTile("test", 10, 100, 100)
	if err == nil {
		t.Error("Expected error for missing tile")
	}
}

func TestGetTileUnknownTileset(t *testing.T) {
	dir := t.TempDir()
	createTestMBTiles(t, dir, "test")

	store, err := NewMBTilesStore(dir)
	if err != nil {
		t.Fatalf("NewMBTilesStore failed: %v", err)
	}
	defer store.Close()

	_, err = store.GetTile("nonexistent", 0, 0, 0)
	if err == nil {
		t.Error("Expected error for unknown tileset")
	}
}

func TestGetMetadata(t *testing.T) {
	dir := t.TempDir()
	createTestMBTiles(t, dir, "test")

	store, err := NewMBTilesStore(dir)
	if err != nil {
		t.Fatalf("NewMBTilesStore failed: %v", err)
	}
	defer store.Close()

	meta, err := store.GetMetadata("test")
	if err != nil {
		t.Fatalf("GetMetadata failed: %v", err)
	}

	if meta.Format != "pbf" {
		t.Errorf("Expected format 'pbf', got '%s'", meta.Format)
	}
	if meta.MinZoom != 0 {
		t.Errorf("Expected minzoom 0, got %d", meta.MinZoom)
	}
	if meta.MaxZoom != 14 {
		t.Errorf("Expected maxzoom 14, got %d", meta.MaxZoom)
	}
}

func TestEmptyDirectory(t *testing.T) {
	dir := t.TempDir()

	_, err := NewMBTilesStore(dir)
	if err == nil {
		t.Error("Expected error for empty directory")
	}
}

func TestNonExistentDirectory(t *testing.T) {
	_, err := NewMBTilesStore("/nonexistent/path")
	if err == nil {
		t.Error("Expected error for nonexistent directory")
	}
}

func TestInvalidMBTiles(t *testing.T) {
	dir := t.TempDir()

	// Create a SQLite DB without tiles table
	dbPath := filepath.Join(dir, "invalid.mbtiles")
	db, err := sql.Open("sqlite3", dbPath)
	if err != nil {
		t.Fatalf("Failed to create test DB: %v", err)
	}
	db.Exec("CREATE TABLE dummy (id INTEGER)")
	db.Close()

	_, err = NewMBTilesStore(dir)
	if err == nil {
		t.Error("Expected error for invalid MBTiles")
	}
}

func TestMultipleTilesets(t *testing.T) {
	dir := t.TempDir()
	createTestMBTiles(t, dir, "basemap")
	createTestMBTiles(t, dir, "catchments")

	store, err := NewMBTilesStore(dir)
	if err != nil {
		t.Fatalf("NewMBTilesStore failed: %v", err)
	}
	defer store.Close()

	tilesets := store.ListTilesets()
	if len(tilesets) != 2 {
		t.Errorf("Expected 2 tilesets, got %d", len(tilesets))
	}
}

func TestNonMBTilesFiles(t *testing.T) {
	dir := t.TempDir()
	createTestMBTiles(t, dir, "test")

	// Create a non-mbtiles file
	os.WriteFile(filepath.Join(dir, "readme.txt"), []byte("hello"), 0644)

	store, err := NewMBTilesStore(dir)
	if err != nil {
		t.Fatalf("NewMBTilesStore failed: %v", err)
	}
	defer store.Close()

	tilesets := store.ListTilesets()
	if len(tilesets) != 1 {
		t.Errorf("Expected 1 tileset (ignoring non-mbtiles), got %d", len(tilesets))
	}
}
