package tiles

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"

	_ "github.com/mattn/go-sqlite3"
)

// MBTilesStore manages access to MBTiles databases
type MBTilesStore struct {
	databases map[string]*sql.DB
	mu        sync.RWMutex
}

// TileMetadata holds metadata from an MBTiles file
type TileMetadata struct {
	Name        string `json:"name"`
	Format      string `json:"format"`
	Description string `json:"description"`
	MinZoom     int    `json:"minzoom"`
	MaxZoom     int    `json:"maxzoom"`
	Center      string `json:"center"`
	Bounds      string `json:"bounds"`
	Type        string `json:"type"`
	JSON        string `json:"json,omitempty"`
}

// NewMBTilesStore scans the given directories for .mbtiles files and opens them
func NewMBTilesStore(dirs ...string) (*MBTilesStore, error) {
	store := &MBTilesStore{
		databases: make(map[string]*sql.DB),
	}

	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			log.Printf("Warning: failed to read directory %s: %v", dir, err)
			continue
		}

		for _, entry := range entries {
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".mbtiles") {
				continue
			}

			name := strings.TrimSuffix(entry.Name(), ".mbtiles")
			if _, exists := store.databases[name]; exists {
				continue
			}

			dbPath := filepath.Join(dir, entry.Name())

			db, err := sql.Open("sqlite3", dbPath+"?mode=ro")
			if err != nil {
				log.Printf("Warning: Failed to open MBTiles %s: %v", name, err)
				continue
			}

			// Verify it's a valid MBTiles database
			var count int
			err = db.QueryRow("SELECT count(*) FROM sqlite_master WHERE type IN ('table','view') AND name='tiles'").Scan(&count)
			if err != nil || count == 0 {
				log.Printf("Warning: %s is not a valid MBTiles file", name)
				db.Close()
				continue
			}

			store.databases[name] = db
			log.Printf("Loaded MBTiles: %s (%s)", name, dbPath)
		}
	}

	if len(store.databases) == 0 {
		return store, fmt.Errorf("no valid .mbtiles files found")
	}

	return store, nil
}

// GetTile retrieves a single tile from the named MBTiles database
func (s *MBTilesStore) GetTile(name string, z, x, y int) ([]byte, error) {
	s.mu.RLock()
	db, ok := s.databases[name]
	s.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("unknown tileset: %s", name)
	}

	// MBTiles uses TMS y-coordinate (flipped)
	tmsY := (1 << uint(z)) - 1 - y

	var tileData []byte
	err := db.QueryRow(
		"SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
		z, x, tmsY,
	).Scan(&tileData)

	if err != nil {
		return nil, fmt.Errorf("tile not found: z=%d x=%d y=%d: %w", z, x, y, err)
	}

	return tileData, nil
}

// GetMetadata retrieves metadata for a named tileset
func (s *MBTilesStore) GetMetadata(name string) (*TileMetadata, error) {
	s.mu.RLock()
	db, ok := s.databases[name]
	s.mu.RUnlock()

	if !ok {
		return nil, fmt.Errorf("unknown tileset: %s", name)
	}

	meta := &TileMetadata{Name: name}

	rows, err := db.Query("SELECT name, value FROM metadata")
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			continue
		}

		switch key {
		case "format":
			meta.Format = value
		case "description":
			meta.Description = value
		case "minzoom":
			fmt.Sscanf(value, "%d", &meta.MinZoom)
		case "maxzoom":
			fmt.Sscanf(value, "%d", &meta.MaxZoom)
		case "center":
			meta.Center = value
		case "bounds":
			meta.Bounds = value
		case "type":
			meta.Type = value
		case "json":
			meta.JSON = value
		}
	}

	return meta, nil
}

// ListTilesets returns the names of all loaded tilesets
func (s *MBTilesStore) ListTilesets() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()

	names := make([]string, 0, len(s.databases))
	for name := range s.databases {
		names = append(names, name)
	}
	return names
}

// Close closes all open database connections
func (s *MBTilesStore) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()

	for name, db := range s.databases {
		if err := db.Close(); err != nil {
			log.Printf("Error closing MBTiles %s: %v", name, err)
		}
	}
}
