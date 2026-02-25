package geodata

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"sync"
	"unsafe"

	polyclip "github.com/ctessum/polyclip-go"
	_ "github.com/mattn/go-sqlite3"
)

// GpkgStore provides access to the datapack geopackage
type GpkgStore struct {
	db      *sql.DB
	dataDir string
	columns []string
	mu      sync.RWMutex
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
		// Skip internal/ID columns - keep only data attributes
		if name == "catchment_id" || name == "fid" || name == "ogc_fid" ||
			name == "catchment_id_int" {
			continue
		}
		columns = append(columns, name)
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

// GetScenarios returns available scenarios
func (s *GpkgStore) GetScenarios() []string {
	return []string{"current", "reference"}
}

func resolveScenarioTable(scenario string) string {
	if scenario == "reference" || scenario == "future" {
		return "scenario_reference"
	}
	return "scenario_current"
}

// GetScenarioData returns data for a scenario and attribute as a map of catchment ID to value
func (s *GpkgStore) GetScenarioData(scenario, attribute string) (map[string]float64, error) {
	tableName := resolveScenarioTable(scenario)

	if !s.isValidColumn(attribute) {
		return nil, fmt.Errorf("invalid attribute: %s", attribute)
	}

	query := fmt.Sprintf(`SELECT catchment_id, "%s" FROM %s WHERE "%s" IS NOT NULL`,
		attribute, tableName, attribute)

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to query scenario data: %w", err)
	}
	defer rows.Close()

	result := make(map[string]float64)
	for rows.Next() {
		var catchmentID string
		var value float64
		if err := rows.Scan(&catchmentID, &value); err != nil {
			continue
		}
		result[catchmentID] = value
	}

	return result, nil
}

// GetComparisonData returns comparison data for two scenarios for a given attribute
func (s *GpkgStore) GetComparisonData(left, right, attribute string) (map[string][2]float64, error) {
	if !s.isValidColumn(attribute) {
		return nil, fmt.Errorf("invalid attribute: %s", attribute)
	}

	leftTable := resolveScenarioTable(left)
	rightTable := resolveScenarioTable(right)

	query := fmt.Sprintf(`
		SELECT l.catchment_id, l."%s", r."%s"
		FROM %s l
		JOIN %s r ON l.catchment_id = r.catchment_id
		WHERE l."%s" IS NOT NULL AND r."%s" IS NOT NULL`,
		attribute, attribute, leftTable, rightTable, attribute, attribute)

	rows, err := s.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to query comparison data: %w", err)
	}
	defer rows.Close()

	result := make(map[string][2]float64)
	for rows.Next() {
		var catchmentID string
		var leftVal, rightVal float64
		if err := rows.Scan(&catchmentID, &leftVal, &rightVal); err != nil {
			continue
		}
		result[catchmentID] = [2]float64{leftVal, rightVal}
	}

	return result, nil
}

// QueryCatchments returns catchments within a bounding box with a specific attribute
func (s *GpkgStore) QueryCatchments(scenario, attribute string, minx, miny, maxx, maxy float64) (*FeatureCollection, error) {
	// Validate scenario
	tableName := resolveScenarioTable(scenario)

	// Validate attribute against allowed columns to prevent SQL injection
	if !s.isValidColumn(attribute) {
		return nil, fmt.Errorf("invalid attribute: %s", attribute)
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
		JOIN %s s ON c.HYBAS_ID_int = s.catchment_id_int
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

// DomainRange represents min/max values for an attribute across all scenarios
type DomainRange struct {
	Min float64 `json:"min"`
	Max float64 `json:"max"`
}

// isValidColumn checks if the given attribute name is in the allowed columns list
func (s *GpkgStore) isValidColumn(attribute string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, col := range s.columns {
		if col == attribute {
			return true
		}
	}
	return false
}

// GetDomainRange returns the min and max values for an attribute across all scenarios
func (s *GpkgStore) GetDomainRange(attribute string) (*DomainRange, error) {
	// Validate attribute against allowed columns to prevent SQL injection
	if !s.isValidColumn(attribute) {
		return nil, fmt.Errorf("invalid attribute: %s", attribute)
	}

	var minVal, maxVal sql.NullFloat64

	// Query domain_minima table
	query := fmt.Sprintf(`SELECT "%s" FROM domain_minima LIMIT 1`, attribute)
	err := s.db.QueryRow(query).Scan(&minVal)
	if err != nil {
		return nil, fmt.Errorf("failed to get domain minimum for %s: %w", attribute, err)
	}

	// Query domain_maxima table
	query = fmt.Sprintf(`SELECT "%s" FROM domain_maxima LIMIT 1`, attribute)
	err = s.db.QueryRow(query).Scan(&maxVal)
	if err != nil {
		return nil, fmt.Errorf("failed to get domain maximum for %s: %w", attribute, err)
	}

	return &DomainRange{
		Min: minVal.Float64,
		Max: maxVal.Float64,
	}, nil
}

// Close releases resources
func (s *GpkgStore) Close() {
	if s.db != nil {
		s.db.Close()
	}
}

// DissolveCatchments returns a dissolved/unioned geometry from multiple catchments
// Returns the geometry as GeoJSON (single outer boundary) and the total area in square kilometers
func (s *GpkgStore) DissolveCatchments(catchmentIDs []string) (json.RawMessage, float64, error) {
	if len(catchmentIDs) == 0 {
		return nil, 0, fmt.Errorf("no catchment IDs provided")
	}

	// Build placeholders for query
	placeholders := make([]string, len(catchmentIDs))
	args := make([]interface{}, len(catchmentIDs))
	for i, id := range catchmentIDs {
		placeholders[i] = "?"
		args[i] = id
	}

	query := fmt.Sprintf(`
		SELECT geojson
		FROM catchments_lev12
		WHERE HYBAS_ID IN (%s) AND geojson IS NOT NULL
	`, strings.Join(placeholders, ","))

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to query catchments: %w", err)
	}
	defer rows.Close()

	// Collect all polygons as polyclip.Polygon types
	var polyPolygons []polyclip.Polygon

	for rows.Next() {
		var geojsonStr string
		if err := rows.Scan(&geojsonStr); err != nil {
			continue
		}

		// Parse as GeoJSON geometry
		var geom map[string]interface{}
		if err := json.Unmarshal([]byte(geojsonStr), &geom); err != nil {
			log.Printf("Failed to unmarshal geometry: %v", err)
			continue
		}

		geomType, _ := geom["type"].(string)
		coords := geom["coordinates"]

		// Convert to polyclip polygon format
		switch geomType {
		case "Polygon":
			if c, ok := coords.([]interface{}); ok {
				poly := geojsonToPolyclipPolygon(c)
				if len(poly) > 0 {
					polyPolygons = append(polyPolygons, poly)
				}
			}
		case "MultiPolygon":
			if c, ok := coords.([]interface{}); ok {
				for _, p := range c {
					if pc, ok := p.([]interface{}); ok {
						poly := geojsonToPolyclipPolygon(pc)
						if len(poly) > 0 {
							polyPolygons = append(polyPolygons, poly)
						}
					}
				}
			}
		}
	}

	if len(polyPolygons) == 0 {
		return nil, 0, fmt.Errorf("no valid geometries found")
	}

	// For a single polygon, just return it
	if len(polyPolygons) == 1 {
		return polyclipPolygonToGeoJSON(polyPolygons[0])
	}

	// Union all polygons together
	result := polyPolygons[0]
	for i := 1; i < len(polyPolygons); i++ {
		result = result.Construct(polyclip.UNION, polyPolygons[i])
	}

	return polyclipPolygonToGeoJSON(result)
}

// geojsonToPolyclipPolygon converts GeoJSON polygon coordinates to polyclip.Polygon
func geojsonToPolyclipPolygon(rings []interface{}) polyclip.Polygon {
	poly := make(polyclip.Polygon, 0, len(rings))
	for _, ring := range rings {
		r, ok := ring.([]interface{})
		if !ok {
			continue
		}
		contour := make(polyclip.Contour, 0, len(r))
		for _, coord := range r {
			pt, ok := coord.([]interface{})
			if !ok || len(pt) < 2 {
				continue
			}
			x, _ := pt[0].(float64)
			y, _ := pt[1].(float64)
			contour = append(contour, polyclip.Point{X: x, Y: y})
		}
		if len(contour) > 0 {
			poly = append(poly, contour)
		}
	}
	return poly
}

// polyclipPolygonToGeoJSON converts polyclip.Polygon to GeoJSON
func polyclipPolygonToGeoJSON(poly polyclip.Polygon) (json.RawMessage, float64, error) {
	if len(poly) == 0 {
		return nil, 0, fmt.Errorf("empty polygon")
	}

	// Convert polyclip polygon to GeoJSON coordinates
	coords := make([][][2]float64, 0, len(poly))
	for _, contour := range poly {
		ring := make([][2]float64, 0, len(contour)+1)
		for _, pt := range contour {
			ring = append(ring, [2]float64{pt.X, pt.Y})
		}
		// Close the ring if not already closed
		if len(ring) > 0 && (ring[0] != ring[len(ring)-1]) {
			ring = append(ring, ring[0])
		}
		coords = append(coords, ring)
	}

	result := map[string]interface{}{
		"type":        "Polygon",
		"coordinates": coords,
	}

	resultJSON, err := json.Marshal(result)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to marshal result: %w", err)
	}

	return resultJSON, 0, nil
}

// GetCatchmentAttributes returns all attributes for a specific catchment across both scenarios
// Returns a map: scenario -> attribute -> value
func (s *GpkgStore) GetCatchmentAttributes(catchmentID string) map[string]map[string]float64 {
	result := make(map[string]map[string]float64)

	// Query both scenario tables
	scenarios := []string{"current", "reference"}
	for _, scenario := range scenarios {
		tableName := "scenario_" + scenario
		attrs := make(map[string]float64)

		// Get all columns for this scenario
		s.mu.RLock()
		columns := s.columns
		s.mu.RUnlock()

		if len(columns) == 0 {
			continue
		}

		// Build SELECT query for all columns
		quotedCols := make([]string, len(columns))
		for i, col := range columns {
			quotedCols[i] = fmt.Sprintf(`"%s"`, col)
		}

		query := fmt.Sprintf(`SELECT %s FROM %s WHERE catchment_id = ?`,
			strings.Join(quotedCols, ", "), tableName)

		row := s.db.QueryRow(query, catchmentID)

		// Create a slice of interface{} for scanning
		values := make([]sql.NullFloat64, len(columns))
		scanArgs := make([]interface{}, len(columns))
		for i := range values {
			scanArgs[i] = &values[i]
		}

		if err := row.Scan(scanArgs...); err != nil {
			// Try with integer ID
			intID := catchmentID
			// Remove leading zeros or non-numeric chars if needed
			query = fmt.Sprintf(`SELECT %s FROM %s WHERE catchment_id_int = ?`,
				strings.Join(quotedCols, ", "), tableName)
			row = s.db.QueryRow(query, intID)
			if err := row.Scan(scanArgs...); err != nil {
				continue
			}
		}

		// Build attributes map
		for i, col := range columns {
			if values[i].Valid {
				attrs[col] = values[i].Float64
			}
		}

		if len(attrs) > 0 {
			result[scenario] = attrs
		}
	}

	return result
}

// CatchmentIndicators represents indicator values for a single catchment
type CatchmentIndicators struct {
	ID          string             `json:"id"`
	AreaKm2     float64            `json:"areaKm2"`
	Reference   map[string]float64 `json:"reference"`
	Current     map[string]float64 `json:"current"`
	AOIFraction float64            `json:"aoiFraction,omitempty"`
}

// GetCatchmentIndicatorsByIDs returns indicator values for multiple catchments
// Used for area-weighted aggregation in site calculations
func (s *GpkgStore) GetCatchmentIndicatorsByIDs(ids []string) ([]CatchmentIndicators, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	s.mu.RLock()
	columns := s.columns
	s.mu.RUnlock()

	if len(columns) == 0 {
		return nil, fmt.Errorf("no columns loaded")
	}

	// Build placeholders
	placeholders := make([]string, len(ids))
	args := make([]interface{}, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}

	results := make([]CatchmentIndicators, 0, len(ids))

	// Query each scenario
	scenarios := []string{"current", "reference"}
	scenarioData := make(map[string]map[string]map[string]float64) // scenario -> catchmentID -> attribute -> value

	for _, scenario := range scenarios {
		tableName := "scenario_" + scenario

		// Build SELECT query for all columns
		quotedCols := make([]string, len(columns))
		for i, col := range columns {
			quotedCols[i] = fmt.Sprintf(`"%s"`, col)
		}

		query := fmt.Sprintf(`
			SELECT catchment_id, %s
			FROM %s
			WHERE catchment_id IN (%s)
		`, strings.Join(quotedCols, ", "), tableName, strings.Join(placeholders, ","))

		rows, err := s.db.Query(query, args...)
		if err != nil {
			log.Printf("Failed to query %s: %v", tableName, err)
			continue
		}

		scenarioData[scenario] = make(map[string]map[string]float64)

		for rows.Next() {
			// Scan catchment_id + all columns
			values := make([]sql.NullFloat64, len(columns))
			var catchmentID string
			scanArgs := make([]interface{}, len(columns)+1)
			scanArgs[0] = &catchmentID
			for i := range values {
				scanArgs[i+1] = &values[i]
			}

			if err := rows.Scan(scanArgs...); err != nil {
				continue
			}

			attrs := make(map[string]float64)
			for i, col := range columns {
				if values[i].Valid {
					attrs[col] = values[i].Float64
				}
			}
			scenarioData[scenario][catchmentID] = attrs
		}
		rows.Close()
	}

	// Get catchment areas from geometry table
	areaQuery := fmt.Sprintf(`
		SELECT CAST(HYBAS_ID AS TEXT), SUB_AREA
		FROM catchments_lev12
		WHERE HYBAS_ID IN (%s)
	`, strings.Join(placeholders, ","))

	areaRows, err := s.db.Query(areaQuery, args...)
	if err != nil {
		log.Printf("Failed to query areas: %v", err)
	} else {
		defer areaRows.Close()
		for areaRows.Next() {
			var catchmentID string
			var area sql.NullFloat64
			if err := areaRows.Scan(&catchmentID, &area); err != nil {
				continue
			}

			// Normalize catchment ID by removing ".0" suffix if present
			// This handles the case where HYBAS_ID is REAL and gets ".0" appended
			normalizedID := strings.TrimSuffix(catchmentID, ".0")

			ci := CatchmentIndicators{
				ID:        normalizedID,
				AreaKm2:   area.Float64,
				Reference: scenarioData["reference"][normalizedID],
				Current:   scenarioData["current"][normalizedID],
			}
			if ci.Reference == nil {
				ci.Reference = make(map[string]float64)
			}
			if ci.Current == nil {
				ci.Current = make(map[string]float64)
			}
			results = append(results, ci)
		}
	}

	return results, nil
}

// GetCatchmentsByIDs returns catchment geometries for the given IDs
func (s *GpkgStore) GetCatchmentsByIDs(ids []string) ([]GeoJSONFeature, error) {
	if len(ids) == 0 {
		return nil, nil
	}

	// Build placeholders
	placeholders := make([]string, len(ids))
	args := make([]interface{}, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}

	query := fmt.Sprintf(`
		SELECT HYBAS_ID, geojson
		FROM catchments_lev12
		WHERE HYBAS_ID IN (%s) AND geojson IS NOT NULL
	`, strings.Join(placeholders, ","))

	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, fmt.Errorf("failed to query catchments: %w", err)
	}
	defer rows.Close()

	var features []GeoJSONFeature
	for rows.Next() {
		var id float64
		var geojsonStr string
		if err := rows.Scan(&id, &geojsonStr); err != nil {
			continue
		}

		features = append(features, GeoJSONFeature{
			Type:     "Feature",
			ID:       int64(id),
			Geometry: json.RawMessage(geojsonStr),
			Properties: map[string]interface{}{
				"HYBAS_ID": int64(id),
			},
		})
	}

	return features, nil
}

// UnionGeometries performs a union of two GeoJSON geometries using polyclip
// Returns the resulting geometry, area, and any error
func (s *GpkgStore) UnionGeometries(geom1, geom2 json.RawMessage) (json.RawMessage, float64, error) {
	// Parse the first geometry
	poly1, err := geojsonToPolyclip(geom1)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to parse first geometry: %w", err)
	}

	// Parse the second geometry
	poly2, err := geojsonToPolyclip(geom2)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to parse second geometry: %w", err)
	}

	// Perform union
	result := poly1.Construct(polyclip.UNION, poly2)

	// Convert back to GeoJSON
	geojson, err := polyclipToGeojson(result)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to convert result to geojson: %w", err)
	}

	// Calculate area (approximate using shoelace formula)
	area := calculatePolygonArea(result)

	return geojson, area, nil
}

// DifferenceGeometries performs a difference of two GeoJSON geometries using polyclip
// Returns the resulting geometry (geom1 - geom2), area, and any error
func (s *GpkgStore) DifferenceGeometries(geom1, geom2 json.RawMessage) (json.RawMessage, float64, error) {
	// Parse the first geometry
	poly1, err := geojsonToPolyclip(geom1)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to parse first geometry: %w", err)
	}

	// Parse the second geometry
	poly2, err := geojsonToPolyclip(geom2)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to parse second geometry: %w", err)
	}

	// Perform difference
	result := poly1.Construct(polyclip.DIFFERENCE, poly2)

	// Convert back to GeoJSON
	geojson, err := polyclipToGeojson(result)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to convert result to geojson: %w", err)
	}

	// Calculate area
	area := calculatePolygonArea(result)

	return geojson, area, nil
}

// geojsonToPolyclip converts GeoJSON geometry to polyclip polygon
func geojsonToPolyclip(geom json.RawMessage) (polyclip.Polygon, error) {
	var g struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}
	if err := json.Unmarshal(geom, &g); err != nil {
		return nil, err
	}

	switch g.Type {
	case "Polygon":
		var coords [][][]float64
		if err := json.Unmarshal(g.Coordinates, &coords); err != nil {
			return nil, err
		}
		return coordinatesToPolyclip(coords), nil

	case "MultiPolygon":
		var multiCoords [][][][]float64
		if err := json.Unmarshal(g.Coordinates, &multiCoords); err != nil {
			return nil, err
		}
		// Combine all polygons
		var result polyclip.Polygon
		for _, coords := range multiCoords {
			poly := coordinatesToPolyclip(coords)
			if result == nil {
				result = poly
			} else {
				result = result.Construct(polyclip.UNION, poly)
			}
		}
		return result, nil

	default:
		return nil, fmt.Errorf("unsupported geometry type: %s", g.Type)
	}
}

// coordinatesToPolyclip converts GeoJSON polygon coordinates to polyclip polygon
func coordinatesToPolyclip(coords [][][]float64) polyclip.Polygon {
	poly := make(polyclip.Polygon, len(coords))
	for i, ring := range coords {
		contour := make(polyclip.Contour, len(ring))
		for j, pt := range ring {
			contour[j] = polyclip.Point{X: pt[0], Y: pt[1]}
		}
		poly[i] = contour
	}
	return poly
}

// polyclipToGeojson converts polyclip polygon back to GeoJSON
func polyclipToGeojson(poly polyclip.Polygon) (json.RawMessage, error) {
	if len(poly) == 0 {
		// Return empty polygon
		return json.Marshal(map[string]interface{}{
			"type":        "Polygon",
			"coordinates": [][][]float64{},
		})
	}

	// Convert to GeoJSON coordinates
	coords := make([][][]float64, len(poly))
	for i, contour := range poly {
		ring := make([][]float64, len(contour))
		for j, pt := range contour {
			ring[j] = []float64{pt.X, pt.Y}
		}
		// Close the ring if not already closed
		if len(ring) > 0 && (ring[0][0] != ring[len(ring)-1][0] || ring[0][1] != ring[len(ring)-1][1]) {
			ring = append(ring, ring[0])
		}
		coords[i] = ring
	}

	return json.Marshal(map[string]interface{}{
		"type":        "Polygon",
		"coordinates": coords,
	})
}

// calculatePolygonArea calculates the area of a polyclip polygon in square km (approximate)
func calculatePolygonArea(poly polyclip.Polygon) float64 {
	if len(poly) == 0 {
		return 0
	}

	totalArea := 0.0
	for i, contour := range poly {
		area := 0.0
		n := len(contour)
		for j := 0; j < n; j++ {
			k := (j + 1) % n
			area += contour[j].X * contour[k].Y
			area -= contour[k].X * contour[j].Y
		}
		area = area / 2.0

		// First contour is exterior (positive area), rest are holes (negative)
		if i == 0 {
			totalArea += area
		} else {
			totalArea -= area // Subtract holes
		}
	}

	// Convert from degrees squared to km squared (approximate at equator)
	// 1 degree ≈ 111 km at equator
	kmPerDegree := 111.0
	return totalArea * kmPerDegree * kmPerDegree * -1 // Negative because counter-clockwise
}
