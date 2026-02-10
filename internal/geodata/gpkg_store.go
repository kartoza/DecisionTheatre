package geodata

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"sync"
	"unsafe"

	_ "github.com/mattn/go-sqlite3"
)

// GpkgStore provides access to the datapack geopackage
type GpkgStore struct {
	db       *sql.DB
	dataDir  string
	columns  []string
	mu       sync.RWMutex
}

// CatchmentFeature represents a single catchment with geometry and attributes
type CatchmentFeature struct {
	ID         int64              `json:"id"`
	Geometry   json.RawMessage    `json:"geometry"`
	Properties map[string]float64 `json:"properties"`
}

// FeatureCollection is a GeoJSON FeatureCollection
type FeatureCollection struct {
	Type     string           `json:"type"`
	Features []GeoJSONFeature `json:"features"`
}

// GeoJSONFeature is a GeoJSON Feature
type GeoJSONFeature struct {
	Type       string                 `json:"type"`
	ID         int64                  `json:"id"`
	Geometry   json.RawMessage        `json:"geometry"`
	Properties map[string]interface{} `json:"properties"`
}

// NewGpkgStore opens the datapack geopackage
func NewGpkgStore(dataDir string) (*GpkgStore, error) {
	gpkgPath := filepath.Join(dataDir, "datapack.gpkg")

	// Open with spatialite extension
	db, err := sql.Open("sqlite3", gpkgPath+"?mode=ro")
	if err != nil {
		return nil, fmt.Errorf("failed to open geopackage: %w", err)
	}

	// Test connection
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("failed to connect to geopackage: %w", err)
	}

	store := &GpkgStore{
		db:      db,
		dataDir: dataDir,
	}

	// Load column names from scenario_current
	if err := store.loadColumns(); err != nil {
		log.Printf("Warning: could not load columns: %v", err)
	}

	return store, nil
}

// loadColumns reads the column names from the scenario tables
func (s *GpkgStore) loadColumns() error {
	rows, err := s.db.Query("PRAGMA table_info(scenario_current)")
	if err != nil {
		return err
	}
	defer rows.Close()

	var columns []string
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dfltValue sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err != nil {
			continue
		}
		// Skip the ID column
		if name != "catchID" && name != "fid" && name != "ogc_fid" {
			columns = append(columns, name)
		}
	}

	s.mu.Lock()
	s.columns = columns
	s.mu.Unlock()

	log.Printf("Loaded %d attribute columns from geopackage", len(columns))
	return nil
}

// GetColumns returns available attribute columns
func (s *GpkgStore) GetColumns() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.columns
}

// QueryCatchments returns catchments within a bounding box with a specific attribute
func (s *GpkgStore) QueryCatchments(scenario, attribute string, minx, miny, maxx, maxy float64) (*FeatureCollection, error) {
	// Validate scenario
	tableName := "scenario_current"
	if scenario == "reference" {
		tableName = "scenario_reference"
	}

	// Use pre-computed geojson column - much faster than WKB conversion
	// Only select the fields we need (no geometry blob)
	// Use integer columns for faster index-based joins
	// Limit to 2000 features for performance (frontend should zoom in for more detail)
	query := fmt.Sprintf(`
		SELECT
			c.HYBAS_ID,
			c.geojson,
			s."%s" as value
		FROM catchments_lev12 c
		JOIN %s s ON c.HYBAS_ID_int = s.catchID_int
		WHERE c.geojson IS NOT NULL
		  AND c.fid IN (
			SELECT id FROM rtree_catchments_lev12_geom
			WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?
		  )
		LIMIT 2000
	`, attribute, tableName)

	rows, err := s.db.Query(query, maxx, minx, maxy, miny)
	if err != nil {
		return nil, fmt.Errorf("query failed: %w", err)
	}
	defer rows.Close()

	features := []GeoJSONFeature{}

	for rows.Next() {
		var id float64
		var geojsonStr string
		var value sql.NullFloat64

		if err := rows.Scan(&id, &geojsonStr, &value); err != nil {
			log.Printf("Warning: failed to scan row: %v", err)
			continue
		}

		if geojsonStr == "" {
			continue
		}

		props := map[string]interface{}{
			"HYBAS_ID": int64(id),
		}
		if value.Valid {
			props[attribute] = value.Float64
		}

		features = append(features, GeoJSONFeature{
			Type:       "Feature",
			ID:         int64(id),
			Geometry:   json.RawMessage(geojsonStr),
			Properties: props,
		})
	}

	return &FeatureCollection{
		Type:     "FeatureCollection",
		Features: features,
	}, nil
}

// gpbToGeoJSON converts GeoPackage Binary geometry to GeoJSON
// GPB format: magic (2 bytes) + version (1) + flags (1) + srs_id (4) + envelope (variable) + WKB
func gpbToGeoJSON(gpb []byte) (json.RawMessage, error) {
	if len(gpb) < 8 {
		return nil, fmt.Errorf("gpb too short")
	}

	// Check magic number "GP"
	if gpb[0] != 0x47 || gpb[1] != 0x50 {
		return nil, fmt.Errorf("invalid GPB magic")
	}

	// Get flags to determine envelope size
	flags := gpb[3]
	envelopeType := (flags >> 1) & 0x07

	// Calculate envelope size based on type
	var envelopeSize int
	switch envelopeType {
	case 0:
		envelopeSize = 0
	case 1:
		envelopeSize = 32 // minx, maxx, miny, maxy
	case 2, 3:
		envelopeSize = 48 // + minz, maxz or minm, maxm
	case 4:
		envelopeSize = 64 // all four
	default:
		envelopeSize = 0
	}

	// WKB starts after header (8 bytes) + envelope
	wkbStart := 8 + envelopeSize
	if wkbStart >= len(gpb) {
		return nil, fmt.Errorf("gpb truncated")
	}

	wkb := gpb[wkbStart:]

	// Convert WKB to GeoJSON
	return wkbToGeoJSON(wkb)
}

// wkbToGeoJSON converts WKB to GeoJSON
func wkbToGeoJSON(wkb []byte) (json.RawMessage, error) {
	if len(wkb) < 5 {
		return nil, fmt.Errorf("wkb too short")
	}

	// For now, return a placeholder - we'll implement full WKB parsing
	// or use a library like go-geom

	// Simple approach: try to detect polygon/multipolygon and build basic GeoJSON
	// This is a simplified implementation

	byteOrder := wkb[0]
	var geomType uint32

	if byteOrder == 0 {
		// Big endian
		geomType = uint32(wkb[1])<<24 | uint32(wkb[2])<<16 | uint32(wkb[3])<<8 | uint32(wkb[4])
	} else {
		// Little endian
		geomType = uint32(wkb[4])<<24 | uint32(wkb[3])<<16 | uint32(wkb[2])<<8 | uint32(wkb[1])
	}

	// Mask out SRID flag and Z/M flags
	baseType := geomType & 0xFF

	switch baseType {
	case 3: // Polygon
		return parseWKBPolygon(wkb, byteOrder == 0)
	case 6: // MultiPolygon
		return parseWKBMultiPolygon(wkb, byteOrder == 0)
	default:
		return nil, fmt.Errorf("unsupported geometry type: %d", baseType)
	}
}

func parseWKBPolygon(wkb []byte, bigEndian bool) (json.RawMessage, error) {
	// Simplified polygon parsing
	// Full implementation would handle all cases properly

	if len(wkb) < 9 {
		return nil, fmt.Errorf("polygon wkb too short")
	}

	offset := 5 // Skip byte order + type

	var numRings uint32
	if bigEndian {
		numRings = uint32(wkb[offset])<<24 | uint32(wkb[offset+1])<<16 | uint32(wkb[offset+2])<<8 | uint32(wkb[offset+3])
	} else {
		numRings = uint32(wkb[offset+3])<<24 | uint32(wkb[offset+2])<<16 | uint32(wkb[offset+1])<<8 | uint32(wkb[offset])
	}
	offset += 4

	rings := make([][][2]float64, 0, numRings)

	for i := uint32(0); i < numRings; i++ {
		if offset+4 > len(wkb) {
			break
		}

		var numPoints uint32
		if bigEndian {
			numPoints = uint32(wkb[offset])<<24 | uint32(wkb[offset+1])<<16 | uint32(wkb[offset+2])<<8 | uint32(wkb[offset+3])
		} else {
			numPoints = uint32(wkb[offset+3])<<24 | uint32(wkb[offset+2])<<16 | uint32(wkb[offset+1])<<8 | uint32(wkb[offset])
		}
		offset += 4

		ring := make([][2]float64, 0, numPoints)
		for j := uint32(0); j < numPoints; j++ {
			if offset+16 > len(wkb) {
				break
			}
			x := readFloat64(wkb[offset:offset+8], bigEndian)
			y := readFloat64(wkb[offset+8:offset+16], bigEndian)
			offset += 16
			ring = append(ring, [2]float64{x, y})
		}
		rings = append(rings, ring)
	}

	geojson := map[string]interface{}{
		"type":        "Polygon",
		"coordinates": rings,
	}

	return json.Marshal(geojson)
}

func parseWKBMultiPolygon(wkb []byte, bigEndian bool) (json.RawMessage, error) {
	if len(wkb) < 9 {
		return nil, fmt.Errorf("multipolygon wkb too short")
	}

	offset := 5 // Skip byte order + type

	var numPolygons uint32
	if bigEndian {
		numPolygons = uint32(wkb[offset])<<24 | uint32(wkb[offset+1])<<16 | uint32(wkb[offset+2])<<8 | uint32(wkb[offset+3])
	} else {
		numPolygons = uint32(wkb[offset+3])<<24 | uint32(wkb[offset+2])<<16 | uint32(wkb[offset+1])<<8 | uint32(wkb[offset])
	}
	offset += 4

	polygons := make([][][][2]float64, 0, numPolygons)

	for p := uint32(0); p < numPolygons; p++ {
		if offset+9 > len(wkb) {
			break
		}

		// Skip byte order and type for inner polygon
		offset += 5

		var numRings uint32
		if bigEndian {
			numRings = uint32(wkb[offset])<<24 | uint32(wkb[offset+1])<<16 | uint32(wkb[offset+2])<<8 | uint32(wkb[offset+3])
		} else {
			numRings = uint32(wkb[offset+3])<<24 | uint32(wkb[offset+2])<<16 | uint32(wkb[offset+1])<<8 | uint32(wkb[offset])
		}
		offset += 4

		rings := make([][][2]float64, 0, numRings)

		for i := uint32(0); i < numRings; i++ {
			if offset+4 > len(wkb) {
				break
			}

			var numPoints uint32
			if bigEndian {
				numPoints = uint32(wkb[offset])<<24 | uint32(wkb[offset+1])<<16 | uint32(wkb[offset+2])<<8 | uint32(wkb[offset+3])
			} else {
				numPoints = uint32(wkb[offset+3])<<24 | uint32(wkb[offset+2])<<16 | uint32(wkb[offset+1])<<8 | uint32(wkb[offset])
			}
			offset += 4

			ring := make([][2]float64, 0, numPoints)
			for j := uint32(0); j < numPoints; j++ {
				if offset+16 > len(wkb) {
					break
				}
				x := readFloat64(wkb[offset:offset+8], bigEndian)
				y := readFloat64(wkb[offset+8:offset+16], bigEndian)
				offset += 16
				ring = append(ring, [2]float64{x, y})
			}
			rings = append(rings, ring)
		}
		polygons = append(polygons, rings)
	}

	geojson := map[string]interface{}{
		"type":        "MultiPolygon",
		"coordinates": polygons,
	}

	return json.Marshal(geojson)
}

func readFloat64(b []byte, bigEndian bool) float64 {
	var bits uint64
	if bigEndian {
		bits = uint64(b[0])<<56 | uint64(b[1])<<48 | uint64(b[2])<<40 | uint64(b[3])<<32 |
			uint64(b[4])<<24 | uint64(b[5])<<16 | uint64(b[6])<<8 | uint64(b[7])
	} else {
		bits = uint64(b[7])<<56 | uint64(b[6])<<48 | uint64(b[5])<<40 | uint64(b[4])<<32 |
			uint64(b[3])<<24 | uint64(b[2])<<16 | uint64(b[1])<<8 | uint64(b[0])
	}
	return *(*float64)(unsafe.Pointer(&bits))
}

// Close releases resources
func (s *GpkgStore) Close() {
	if s.db != nil {
		s.db.Close()
	}
}
