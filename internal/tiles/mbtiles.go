package tiles

import (
	"database/sql"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"

	_ "github.com/mattn/go-sqlite3"
)

// lonToTileX converts a longitude to a tile X index at the given zoom level.
func lonToTileX(lon float64, z int) int {
	return int(math.Floor((lon + 180.0) / 360.0 * math.Pow(2, float64(z))))
}

// latToTileY converts a latitude to a tile Y index (XYZ convention) at zoom.
func latToTileY(lat float64, z int) int {
	latRad := lat * math.Pi / 180.0
	return int(math.Floor((1.0 - math.Log(math.Tan(latRad)+1.0/math.Cos(latRad))/math.Pi) / 2.0 * math.Pow(2, float64(z))))
}

// tileCacheLimit caps the in-process tile cache at 512 MB. On Linux the OS
// page cache naturally keeps hot tiles in RAM, but on Windows NTFS I/O
// overhead means every SQLite read is expensive even for recently-read tiles.
// Caching in Go memory eliminates the SQLite round-trip entirely after the
// first request for each tile.
const tileCacheLimit = 512 * 1024 * 1024

// MBTilesStore manages access to MBTiles databases
type MBTilesStore struct {
	databases  map[string]*sql.DB
	mu         sync.RWMutex
	tileCache  sync.Map // key: "name/z/x/y" → []byte
	cacheSizeB atomic.Int64
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

			// immutable=1: SQLite skips all locking and change-detection, giving
			// faster reads for static files. _mmap_size enables memory-mapped I/O:
			// on Windows this dramatically reduces NTFS per-read overhead because
			// SQLite reads via virtual memory instead of ReadFile syscalls.
			// cache=shared lets multiple connections share one page cache.
			db, err := sql.Open("sqlite3", dbPath+
				"?mode=ro&immutable=1&cache=shared&_busy_timeout=5000&_mmap_size=268435456")
			if err != nil {
				log.Printf("Warning: Failed to open MBTiles %s: %v", name, err)
				continue
			}

			// Allow up to 32 concurrent read connections. Quad view can generate
			// ~80 simultaneous tile requests (8 maps × ~10 tiles at initial zoom);
			// a pool of 8 serialised most of them. 32 keeps the SQLite reader
			// busy without hitting OS file-descriptor limits on typical systems.
			db.SetMaxOpenConns(32)
			db.SetMaxIdleConns(32)

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

// GetTile retrieves a single tile from the named MBTiles database.
// Results are cached in process memory (up to tileCacheLimit bytes) so that
// repeated requests — common when switching between views or zooming back to
// a previously visited area — never hit SQLite a second time. This is the
// primary reason map loading is faster on repeated access on Windows.
func (s *MBTilesStore) GetTile(name string, z, x, y int) ([]byte, error) {
	cacheKey := fmt.Sprintf("%s/%d/%d/%d", name, z, x, y)
	if v, ok := s.tileCache.Load(cacheKey); ok {
		return v.([]byte), nil
	}

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

	// Store in cache while under the size limit. LoadOrStore prevents a
	// double-store if two goroutines fetched the same tile simultaneously.
	if s.cacheSizeB.Load() < tileCacheLimit {
		if _, loaded := s.tileCache.LoadOrStore(cacheKey, tileData); !loaded {
			s.cacheSizeB.Add(int64(len(tileData)))
		}
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
			// A malformed value leaves the zoom at its zero default, which is a
			// usable fallback — but say so, because a silently wrong zoom range
			// looks like a data problem much later.
			if _, err := fmt.Sscanf(value, "%d", &meta.MinZoom); err != nil {
				log.Printf("Warning: %s has an unparseable minzoom %q: %v", name, value, err)
			}
		case "maxzoom":
			if _, err := fmt.Sscanf(value, "%d", &meta.MaxZoom); err != nil {
				log.Printf("Warning: %s has an unparseable maxzoom %q: %v", name, value, err)
			}
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

// WarmCache pre-loads all tiles within the given WGS84 bounding box
// [west, south, east, north] for zoom levels 0 through maxZoom into the
// in-process tile cache. This eliminates cold-cache SQLite I/O for the tiles
// most likely to be requested on the first map render — particularly valuable
// on Windows where the OS page cache is less aggressive than Linux's.
// It is safe to call concurrently; duplicate fetches are handled by LoadOrStore.
func (s *MBTilesStore) WarmCache(name string, bounds [4]float64, maxZoom int) {
	west, south, east, north := bounds[0], bounds[1], bounds[2], bounds[3]
	loaded := 0
	for z := 0; z <= maxZoom; z++ {
		n := int(math.Pow(2, float64(z)))
		minX := clamp(lonToTileX(west, z), 0, n-1)
		maxX := clamp(lonToTileX(east, z), 0, n-1)
		minY := clamp(latToTileY(north, z), 0, n-1) // north → smaller Y
		maxY := clamp(latToTileY(south, z), 0, n-1) // south → larger Y
		for x := minX; x <= maxX; x++ {
			for y := minY; y <= maxY; y++ {
				if _, err := s.GetTile(name, z, x, y); err == nil {
					loaded++
				}
			}
		}
	}
	log.Printf("Tile cache warmed: %d tiles for %s z0–%d", loaded, name, maxZoom)
}

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
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
