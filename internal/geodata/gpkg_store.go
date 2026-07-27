package geodata

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
	"unsafe"

	polyclip "github.com/ctessum/polyclip-go"
	_ "github.com/mattn/go-sqlite3"
)

// GpkgStore provides access to the datapack geopackage
type GpkgStore struct {
	db         *sql.DB
	dataDir    string
	columns    []string
	mu         sync.RWMutex
	idColCache sync.Map // tableName -> idColumnName string

	// gridGeometryCache holds the dissolved geometry for each cell of each
	// aggregation resolution tier (see gridTiersDegrees), keyed by tier size
	// then cell. It is independent of scenario/attribute - only the
	// per-request value join changes - so it is computed once in the
	// background and reused for every grid-aggregated choropleth request.
	gridGeometryCache map[float64]map[gridCellKey]json.RawMessage
	gridGeometryReady chan struct{}
	gridGeometryOnce  sync.Once
}

// gridCellKey identifies one cell of the low-zoom choropleth aggregation grid.
type gridCellKey struct{ gx, gy int64 }

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
		db:                db,
		dataDir:           dataDir,
		gridGeometryReady: make(chan struct{}),
	}

	// Load column names from scenario_current
	if err := store.loadColumns(); err != nil {
		log.Printf("Warning: could not load columns: %v", err)
	}

	// Start building the low-zoom choropleth grid geometry cache in the
	// background so it's typically warm by the time a user zooms out far
	// enough to need it (see queryCatchmentsGridAggregated).
	store.ensureGridGeometryCache()

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
		if name == "catchment_id" || name == "catchID" || name == "fid" || name == "ogc_fid" ||
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

func normalizeCatchmentID(id string) string {
	return strings.TrimSuffix(id, ".0")
}

func dbValueToString(v interface{}) string {
	switch t := v.(type) {
	case nil:
		return ""
	case string:
		return t
	case []byte:
		return string(t)
	case int:
		return strconv.Itoa(t)
	case int64:
		return strconv.FormatInt(t, 10)
	case float64:
		if math.Trunc(t) == t {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	default:
		return fmt.Sprint(t)
	}
}

func parseNumericIDs(ids []string) ([]interface{}, bool) {
	args := make([]interface{}, 0, len(ids))
	for _, id := range ids {
		parsed, err := strconv.ParseInt(normalizeCatchmentID(strings.TrimSpace(id)), 10, 64)
		if err != nil {
			return nil, false
		}
		args = append(args, parsed)
	}
	return args, true
}

func (s *GpkgStore) resolveScenarioIDColumn(tableName string) (string, error) {
	if cached, ok := s.idColCache.Load(tableName); ok {
		return cached.(string), nil
	}

	rows, err := s.db.Query(fmt.Sprintf("PRAGMA table_info(%s)", tableName))
	if err != nil {
		return "", err
	}
	defer rows.Close()

	columns := make(map[string]struct{})
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dfltValue sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dfltValue, &pk); err != nil {
			continue
		}
		columns[name] = struct{}{}
	}

	// Prefer indexed columns first.  All scenario tables have catchment_id_int
	// with an index; falling back to catchID causes a full-table scan.
	candidates := []string{"catchment_id_int", "catchment_id", "catchID"}
	for _, candidate := range candidates {
		if _, ok := columns[candidate]; ok {
			s.idColCache.Store(tableName, candidate)
			return candidate, nil
		}
	}

	return "", fmt.Errorf("no catchment id column found in %s", tableName)
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

// GetScenarioAverages returns area-weighted means for one scenario across multiple attributes.
// When bbox is provided, the aggregation is restricted to catchments intersecting that bbox.
func (s *GpkgStore) GetScenarioAverages(scenario string, attributes []string, bbox *[4]float64) (map[string]float64, error) {
	if len(attributes) == 0 {
		return nil, fmt.Errorf("no attributes provided")
	}

	tableName := resolveScenarioTable(scenario)

	selectExprs := make([]string, 0, len(attributes))
	for i, attr := range attributes {
		if !s.isValidColumn(attr) {
			return nil, fmt.Errorf("invalid attribute: %s", attr)
		}
		alias := fmt.Sprintf("a%d", i)
		expr := fmt.Sprintf(
			`SUM(CASE WHEN s."%s" IS NOT NULL THEN s."%s" * c.SUB_AREA END) / NULLIF(SUM(CASE WHEN s."%s" IS NOT NULL THEN c.SUB_AREA END), 0) AS %s`,
			attr, attr, attr, alias,
		)
		selectExprs = append(selectExprs, expr)
	}

	query := fmt.Sprintf(
		`SELECT %s
		 FROM %s s
		 JOIN catchments_lev12 c ON s.catchment_id_int = c.HYBAS_ID_int`,
		strings.Join(selectExprs, ", "),
		tableName,
	)

	args := make([]interface{}, 0)
	if bbox != nil {
		query += `
		 WHERE c.fid IN (
			SELECT id FROM rtree_catchments_lev12_geom
			WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?
		 )`
		minx, miny, maxx, maxy := bbox[0], bbox[1], bbox[2], bbox[3]
		args = append(args, maxx, minx, maxy, miny)
	}

	row := s.db.QueryRow(query, args...)
	vals := make([]sql.NullFloat64, len(attributes))
	scanArgs := make([]interface{}, len(attributes))
	for i := range vals {
		scanArgs[i] = &vals[i]
	}

	if err := row.Scan(scanArgs...); err != nil {
		return nil, fmt.Errorf("failed to query scenario averages: %w", err)
	}

	out := make(map[string]float64)
	for i, attr := range attributes {
		if vals[i].Valid {
			out[attr] = vals[i].Float64
		}
	}

	return out, nil
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

// DetailZoomThreshold is retained for logging/observability only; it no longer
// selects the render path (see QueryCatchments).
const DetailZoomThreshold = 5.0

// maxDetailedFeatures is the most per-catchment features QueryCatchments will
// ever return as full detailed geometry. A fixed zoom threshold isn't a
// reliable proxy for "how many catchments does this bbox match" - dense
// regions (e.g. mountainous or forested areas with many small catchments) can
// exceed a feature-count budget at a zoom level that's perfectly safe
// elsewhere. Deciding on the actual match count instead guarantees every
// catchment in view is represented (falling back to the grid-aggregated
// choropleth rather than silently truncating and leaving gaps).
const maxDetailedFeatures = 10000

// gridTiersDegrees lists the aggregation cell sizes available when a bbox
// matches more than maxDetailedFeatures catchments, finest first. Catchments
// falling in the same cell are dissolved into a single feature (their
// simplified geometries unioned together) whose value is the SUB_AREA-weighted
// average of its members. queryCatchmentsGridAggregated picks the finest tier
// whose resulting cell count for the *current* bbox stays within
// gridRenderBudget: a small, sparse view gets a fine grid that reads almost
// like the true catchment texture, while only a genuinely continent-scale
// view falls back to the coarsest tier. Every tier fully covers the area (no
// gaps) and its cell outlines follow real catchment boundaries rather than a
// plain square.
var gridTiersDegrees = []float64{0.08, 0.2, 0.5}

// gridRenderBudget caps how many aggregated features a single choropleth
// response may contain, mirroring maxDetailedFeatures for the render path.
const gridRenderBudget = 8000

// QueryCatchments returns catchments within a bounding box with a specific
// attribute. If the bbox matches at most maxDetailedFeatures catchments it
// returns full per-catchment geometry; otherwise it falls back to a
// grid-aggregated choropleth (see gridCellSizeDegrees) so a densely-catchmented
// area never gets silently truncated into a gappy render.
func (s *GpkgStore) QueryCatchments(scenario, attribute string, minx, miny, maxx, maxy, zoom float64) (*FeatureCollection, error) {
	start := time.Now()
	var path string
	var matched int
	defer func() {
		log.Printf("[perf] QueryCatchments scenario=%s attribute=%s bbox=[%.2f,%.2f,%.2f,%.2f] zoom=%.1f matched=%d path=%s duration_ms=%d", scenario, attribute, minx, miny, maxx, maxy, zoom, matched, path, time.Since(start).Milliseconds())
	}()

	// Validate scenario
	tableName := resolveScenarioTable(scenario)

	// Validate attribute against allowed columns to prevent SQL injection
	if !s.isValidColumn(attribute) {
		return nil, fmt.Errorf("invalid attribute: %s", attribute)
	}

	matched, err := s.countCatchmentsInBounds(tableName, minx, miny, maxx, maxy)
	if err != nil {
		return nil, err
	}

	if matched <= maxDetailedFeatures {
		path = "detailed"
		return s.queryCatchmentsDetailed(tableName, attribute, minx, miny, maxx, maxy)
	}
	path = "aggregated"
	return s.queryCatchmentsGridAggregated(tableName, attribute, minx, miny, maxx, maxy)
}

// countCatchmentsInBounds counts how many rows queryCatchmentsDetailed would
// return for this bbox - same FROM/JOIN/WHERE, minus the geometry/value
// columns - so QueryCatchments can decide the render path from an exact
// count rather than an approximation. Cheap enough to run on every request:
// no geometry parsing, just an indexed bbox lookup and a join.
func (s *GpkgStore) countCatchmentsInBounds(tableName string, minx, miny, maxx, maxy float64) (int, error) {
	query := fmt.Sprintf(`
		SELECT COUNT(*)
		FROM catchments_lev12 c
		JOIN %s s ON c.HYBAS_ID_int = s.catchment_id_int
		WHERE c.geojson IS NOT NULL
		  AND c.fid IN (
			SELECT id FROM rtree_catchments_lev12_geom
			WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?
		  )
	`, tableName)

	var count int
	if err := s.db.QueryRow(query, maxx, minx, maxy, miny).Scan(&count); err != nil {
		return 0, fmt.Errorf("count query failed: %w", err)
	}
	return count, nil
}

// queryCatchmentsDetailed returns one feature per catchment with full-detail geometry.
func (s *GpkgStore) queryCatchmentsDetailed(tableName, attribute string, minx, miny, maxx, maxy float64) (*FeatureCollection, error) {
	// Use pre-computed geojson column - much faster than WKB conversion
	// Only select the fields we need (no geometry blob)
	// Use integer columns for faster index-based joins
	// The caller (QueryCatchments) has already confirmed the bbox matches at
	// most maxDetailedFeatures catchments; this LIMIT is just a defensive cap,
	// not the mechanism that decides detailed vs. aggregated.
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
		LIMIT ?
	`, attribute, tableName)

	rows, err := s.db.Query(query, maxx, minx, maxy, miny, maxDetailedFeatures)
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

// QueryCatchmentValues returns every catchment's attribute value within a bounding
// box, with no geometry and no LIMIT. It exists for statistics (min/max/mean/count)
// where accuracy across the true full dataset matters and per-catchment HYBAS_ID is
// required (e.g. filtering to a site's catchments), unlike QueryCatchments' render
// paths, which trade some accuracy/detail for a bounded, renderable feature count.
// Callers never hand this to a map source, so shipping one feature per catchment
// (with a null geometry) doesn't carry the rendering cost that motivated those
// other paths.
func (s *GpkgStore) QueryCatchmentValues(scenario, attribute string, minx, miny, maxx, maxy float64) (*FeatureCollection, error) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] QueryCatchmentValues scenario=%s attribute=%s bbox=[%.2f,%.2f,%.2f,%.2f] duration_ms=%d", scenario, attribute, minx, miny, maxx, maxy, time.Since(start).Milliseconds())
	}()

	tableName := resolveScenarioTable(scenario)
	if !s.isValidColumn(attribute) {
		return nil, fmt.Errorf("invalid attribute: %s", attribute)
	}

	query := fmt.Sprintf(`
		SELECT c.HYBAS_ID, s."%s" as value
		FROM catchments_lev12 c
		JOIN %s s ON c.HYBAS_ID_int = s.catchment_id_int
		WHERE s."%s" IS NOT NULL
		  AND c.fid IN (
			SELECT id FROM rtree_catchments_lev12_geom
			WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?
		  )
	`, attribute, tableName, attribute)

	rows, err := s.db.Query(query, maxx, minx, maxy, miny)
	if err != nil {
		return nil, fmt.Errorf("query failed: %w", err)
	}
	defer rows.Close()

	features := []GeoJSONFeature{}
	for rows.Next() {
		var id, value float64
		if err := rows.Scan(&id, &value); err != nil {
			log.Printf("Warning: failed to scan row: %v", err)
			continue
		}

		features = append(features, GeoJSONFeature{
			Type:     "Feature",
			ID:       int64(id),
			Geometry: json.RawMessage("null"),
			Properties: map[string]interface{}{
				"HYBAS_ID": int64(id),
				attribute:  value,
			},
		})
	}

	return &FeatureCollection{
		Type:     "FeatureCollection",
		Features: features,
	}, nil
}

// ensureGridGeometryCache kicks off buildGridGeometryCache exactly once. Safe
// to call from every request; only the first call actually starts the build.
func (s *GpkgStore) ensureGridGeometryCache() {
	s.gridGeometryOnce.Do(func() {
		go s.buildGridGeometryCache()
	})
}

// gridCellKeyFor returns the cell a catchment at (lat, long) falls into at
// the given tier's cell size.
func gridCellKeyFor(lat, long, cellSizeDegrees float64) gridCellKey {
	return gridCellKey{
		gx: int64(math.Floor(long / cellSizeDegrees)),
		gy: int64(math.Floor(lat / cellSizeDegrees)),
	}
}

// buildGridGeometryCache dissolves every catchment's simplified geometry into
// its cell, for every tier in gridTiersDegrees, once for the lifetime of the
// store. This is the expensive part of grid aggregation (~150k small polygon
// unions per tier); doing it here means a choropleth request only has to do a
// cheap SQL aggregation over attribute values and look up the matching
// pre-built geometry.
func (s *GpkgStore) buildGridGeometryCache() {
	start := time.Now()
	defer close(s.gridGeometryReady)

	rows, err := s.db.Query(`
		SELECT lat, long, geojson_simplified
		FROM catchments_lev12
		WHERE lat IS NOT NULL AND long IS NOT NULL AND geojson_simplified IS NOT NULL
	`)
	if err != nil {
		log.Printf("Warning: failed to build grid geometry cache: %v", err)
		return
	}
	defer rows.Close()

	polygonsByTierCell := make(map[float64]map[gridCellKey][]polyclip.Polygon, len(gridTiersDegrees))
	for _, tier := range gridTiersDegrees {
		polygonsByTierCell[tier] = make(map[gridCellKey][]polyclip.Polygon)
	}

	for rows.Next() {
		var lat, long float64
		var geojsonStr string
		if err := rows.Scan(&lat, &long, &geojsonStr); err != nil {
			continue
		}

		polys, err := geometryRawToPolygons(json.RawMessage(geojsonStr))
		if err != nil || len(polys) == 0 {
			continue
		}
		for _, tier := range gridTiersDegrees {
			key := gridCellKeyFor(lat, long, tier)
			polygonsByTierCell[tier][key] = append(polygonsByTierCell[tier][key], polys...)
		}
	}

	cache := make(map[float64]map[gridCellKey]json.RawMessage, len(gridTiersDegrees))
	for _, tier := range gridTiersDegrees {
		tierPolygons := polygonsByTierCell[tier]
		tierCache := make(map[gridCellKey]json.RawMessage, len(tierPolygons))

		for key, polys := range tierPolygons {
			if len(polys) == 0 {
				continue
			}

			dissolved := polys[0]
			for i := 1; i < len(polys); i++ {
				dissolved = dissolved.Construct(polyclip.UNION, polys[i])
			}

			geometryJSON, _, err := polyclipPolygonToGeoJSON(dissolved)
			if err != nil {
				continue
			}
			tierCache[key] = geometryJSON
		}

		cache[tier] = tierCache
		log.Printf("[perf] grid geometry cache tier=%.3f built: %d cells", tier, len(tierCache))
	}

	s.mu.Lock()
	s.gridGeometryCache = cache
	s.mu.Unlock()

	log.Printf("[perf] grid geometry cache built: %d tiers in %dms", len(gridTiersDegrees), time.Since(start).Milliseconds())
}

// queryCatchmentsGridAggregated bins catchments into the finest gridTiersDegrees
// cell size the current bbox can afford (see gridRenderBudget) and returns one
// feature per populated cell: the pre-dissolved union of its members' simplified
// geometries (see buildGridGeometryCache), coloured by the SUB_AREA-weighted
// average of the attribute across those members. Unioning keeps the cell's
// outline following real catchment boundaries (rather than a plain square), and
// picking the finest affordable tier keeps the choropleth as close to the true
// catchment texture as the feature budget allows - only a genuinely
// continent-scale view is forced down to the coarsest tier.
func (s *GpkgStore) queryCatchmentsGridAggregated(tableName, attribute string, minx, miny, maxx, maxy float64) (*FeatureCollection, error) {
	s.ensureGridGeometryCache()
	<-s.gridGeometryReady

	// Every catchment in the bbox is included here, even ones with a null
	// value for attribute - a cell whose catchments simply lack data for this
	// particular indicator should still render (falling back to the domain
	// minimum via the frontend's coalesce, same as the detailed path does for
	// a null-valued catchment) rather than leaving a hole in the choropleth.
	query := fmt.Sprintf(`
		SELECT c.lat, c.long, c.SUB_AREA, s."%s" as value
		FROM catchments_lev12 c
		JOIN %s s ON c.HYBAS_ID_int = s.catchment_id_int
		WHERE c.lat IS NOT NULL AND c.long IS NOT NULL
		  AND c.SUB_AREA IS NOT NULL AND c.SUB_AREA > 0
		  AND c.fid IN (
			SELECT id FROM rtree_catchments_lev12_geom
			WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?
		  )
	`, attribute, tableName)

	rows, err := s.db.Query(query, maxx, minx, maxy, miny)
	if err != nil {
		return nil, fmt.Errorf("query failed: %w", err)
	}
	defer rows.Close()

	type catchmentRow struct {
		lat, long, area float64
		value           sql.NullFloat64
	}
	var catchmentRows []catchmentRow
	for rows.Next() {
		var r catchmentRow
		if err := rows.Scan(&r.lat, &r.long, &r.area, &r.value); err != nil {
			log.Printf("Warning: failed to scan row: %v", err)
			continue
		}
		catchmentRows = append(catchmentRows, r)
	}

	type cellAccumulator struct {
		weightedSum float64
		validArea   float64
		count       int
	}

	// Try tiers finest-to-coarsest; use the first whose cell count fits the
	// budget, falling back to the coarsest (last) tier regardless.
	var chosenTier float64
	var cells map[gridCellKey]*cellAccumulator
	for i, tier := range gridTiersDegrees {
		candidate := make(map[gridCellKey]*cellAccumulator)
		for _, r := range catchmentRows {
			key := gridCellKeyFor(r.lat, r.long, tier)
			acc, ok := candidate[key]
			if !ok {
				acc = &cellAccumulator{}
				candidate[key] = acc
			}
			if r.value.Valid {
				acc.weightedSum += r.value.Float64 * r.area
				acc.validArea += r.area
			}
			acc.count++
		}
		if len(candidate) <= gridRenderBudget || i == len(gridTiersDegrees)-1 {
			chosenTier = tier
			cells = candidate
			break
		}
	}
	log.Printf("[perf] queryCatchmentsGridAggregated catchments=%d tier=%.3f cells=%d", len(catchmentRows), chosenTier, len(cells))

	s.mu.RLock()
	tierCache := s.gridGeometryCache[chosenTier]
	s.mu.RUnlock()

	features := make([]GeoJSONFeature, 0, len(cells))
	var nextID int64
	for key, acc := range cells {
		geometryJSON, ok := tierCache[key]
		if !ok {
			continue
		}
		nextID++

		props := map[string]interface{}{
			"aggregated":     true,
			"catchmentCount": acc.count,
		}
		if acc.validArea > 0 {
			props[attribute] = acc.weightedSum / acc.validArea
		}

		features = append(features, GeoJSONFeature{
			Type:       "Feature",
			ID:         nextID,
			Geometry:   geometryJSON,
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
	start := time.Now()
	defer func() {
		log.Printf("[perf] GetDomainRange attribute=%s duration_ms=%d", attribute, time.Since(start).Milliseconds())
	}()

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

	type ringData struct {
		coords  [][2]float64
		absArea float64
	}

	rings := make([]ringData, 0, len(poly))
	for _, contour := range poly {
		if len(contour) < 3 {
			continue
		}

		ring := make([][2]float64, 0, len(contour)+1)
		for _, pt := range contour {
			ring = append(ring, [2]float64{pt.X, pt.Y})
		}
		if ring[0] != ring[len(ring)-1] {
			ring = append(ring, ring[0])
		}

		rawArea := signedRingArea(ring)
		if math.Abs(rawArea) <= 1e-12 {
			continue
		}

		rings = append(rings, ringData{coords: ring, absArea: math.Abs(rawArea)})
	}

	if len(rings) == 0 {
		return nil, 0, fmt.Errorf("empty polygon")
	}

	// Build parent-child nesting by containment. This preserves holes and supports
	// disconnected outers by emitting MultiPolygon when needed.
	parents := make([]int, len(rings))
	depths := make([]int, len(rings))
	for i := range parents {
		parents[i] = -1
	}

	for i := range rings {
		pt := rings[i].coords[0]
		bestParent := -1
		bestArea := math.MaxFloat64
		for j := range rings {
			if i == j {
				continue
			}
			if rings[j].absArea <= rings[i].absArea {
				continue
			}
			if pointInRing(pt, rings[j].coords) && rings[j].absArea < bestArea {
				bestParent = j
				bestArea = rings[j].absArea
			}
		}
		parents[i] = bestParent
	}

	for i := range rings {
		d := 0
		p := parents[i]
		for p != -1 {
			d++
			p = parents[p]
		}
		depths[i] = d
	}

	outerToPolygon := make(map[int]int)
	multiCoords := make([][][][2]float64, 0)
	for i := range rings {
		if depths[i]%2 != 0 {
			continue
		}
		outerToPolygon[i] = len(multiCoords)
		multiCoords = append(multiCoords, [][][2]float64{rings[i].coords})
	}

	for i := range rings {
		if depths[i]%2 == 0 {
			continue
		}
		p := parents[i]
		for p != -1 && depths[p]%2 != 0 {
			p = parents[p]
		}
		if p == -1 {
			continue
		}
		idx := outerToPolygon[p]
		multiCoords[idx] = append(multiCoords[idx], rings[i].coords)
	}

	var result map[string]interface{}
	if len(multiCoords) == 1 {
		result = map[string]interface{}{
			"type":        "Polygon",
			"coordinates": multiCoords[0],
		}
	} else {
		result = map[string]interface{}{
			"type":        "MultiPolygon",
			"coordinates": multiCoords,
		}
	}

	resultJSON, err := json.Marshal(result)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to marshal result: %w", err)
	}

	return resultJSON, 0, nil
}

func signedRingArea(ring [][2]float64) float64 {
	if len(ring) < 4 {
		return 0
	}
	area := 0.0
	for i := 0; i < len(ring)-1; i++ {
		area += ring[i][0]*ring[i+1][1] - ring[i+1][0]*ring[i][1]
	}
	return area / 2
}

func pointInRing(point [2]float64, ring [][2]float64) bool {
	if len(ring) < 4 {
		return false
	}

	inside := false
	px, py := point[0], point[1]
	for i, j := 0, len(ring)-1; i < len(ring); j, i = i, i+1 {
		xi, yi := ring[i][0], ring[i][1]
		xj, yj := ring[j][0], ring[j][1]

		intersects := ((yi > py) != (yj > py)) &&
			(px < (xj-xi)*(py-yi)/(yj-yi)+xi)
		if intersects {
			inside = !inside
		}
	}

	return inside
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
	Ideal       map[string]float64 `json:"ideal,omitempty"`
	AOIFraction float64            `json:"aoiFraction,omitempty"`
}

// GetCatchmentIndicatorsByIDs returns indicator values for multiple catchments
// Used for area-weighted aggregation in site calculations
func (s *GpkgStore) GetCatchmentIndicatorsByIDs(ids []string) ([]CatchmentIndicators, error) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] GetCatchmentIndicatorsByIDs ids=%d duration_ms=%d", len(ids), time.Since(start).Milliseconds())
	}()

	if len(ids) == 0 {
		return nil, nil
	}

	s.mu.RLock()
	columns := s.columns
	s.mu.RUnlock()

	if len(columns) == 0 {
		return nil, fmt.Errorf("no columns loaded")
	}

	placeholders := make([]string, len(ids))
	textArgs := make([]interface{}, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		textArgs[i] = normalizeCatchmentID(strings.TrimSpace(id))
	}
	numericArgs, numericIDs := parseNumericIDs(ids)

	results := make([]CatchmentIndicators, 0, len(ids))
	quotedCols := make([]string, len(columns))
	for i, col := range columns {
		quotedCols[i] = fmt.Sprintf(`"%s"`, col)
	}

	// Query current and reference scenarios concurrently — independent reads.
	type scenarioResult struct {
		scenario string
		data     map[string]map[string]float64
		err      error
	}
	scenarioCh := make(chan scenarioResult, 2)

	queryScenario := func(scenario string) {
		scenarioStart := time.Now()
		tableName := "scenario_" + scenario
		idColumn, err := s.resolveScenarioIDColumn(tableName)
		if err != nil {
			log.Printf("Failed to resolve ID column for %s: %v", tableName, err)
			scenarioCh <- scenarioResult{scenario: scenario, data: nil}
			return
		}

		queryArgs := textArgs
		if strings.HasSuffix(idColumn, "_int") && numericIDs {
			queryArgs = numericArgs
		}

		query := fmt.Sprintf(`
			SELECT %s, %s
			FROM %s
			WHERE %s IN (%s)
		`, idColumn, strings.Join(quotedCols, ", "), tableName, idColumn, strings.Join(placeholders, ","))

		rows, err := s.db.Query(query, queryArgs...)
		if err != nil {
			log.Printf("Failed to query %s: %v", tableName, err)
			scenarioCh <- scenarioResult{scenario: scenario, data: nil}
			return
		}
		defer rows.Close()

		data := make(map[string]map[string]float64)
		rowCount := 0

		// Pre-allocate scan buffers once; rows.Scan writes through the pointers
		// on every call so the same backing memory is reused for each row.
		values := make([]sql.NullFloat64, len(columns))
		var catchmentIDRaw interface{}
		scanArgs := make([]interface{}, len(columns)+1)
		scanArgs[0] = &catchmentIDRaw
		for i := range values {
			scanArgs[i+1] = &values[i]
		}

		for rows.Next() {
			if err := rows.Scan(scanArgs...); err != nil {
				continue
			}

			normalizedID := normalizeCatchmentID(dbValueToString(catchmentIDRaw))
			attrs := make(map[string]float64, len(columns))
			for i, col := range columns {
				if values[i].Valid {
					attrs[col] = values[i].Float64
				}
			}
			data[normalizedID] = attrs
			rowCount++
		}
		if err := rows.Err(); err != nil {
			scenarioCh <- scenarioResult{scenario: scenario, err: fmt.Errorf("failed to scan %s: %w", tableName, err)}
			return
		}
		log.Printf("[perf] GetCatchmentIndicatorsByIDs step=scenarioQuery scenario=%s id_column=%s rows=%d duration_ms=%d", scenario, idColumn, rowCount, time.Since(scenarioStart).Milliseconds())
		scenarioCh <- scenarioResult{scenario: scenario, data: data}
	}

	go queryScenario("current")
	go queryScenario("reference")

	scenarioData := make(map[string]map[string]map[string]float64)
	for range [2]struct{}{} {
		r := <-scenarioCh
		if r.err != nil {
			return nil, r.err
		}
		if r.data != nil {
			scenarioData[r.scenario] = r.data
		}
	}

	areaStart := time.Now()
	areaColumn := "HYBAS_ID"
	areaArgs := textArgs
	if numericIDs {
		areaColumn = "HYBAS_ID_int"
		areaArgs = numericArgs
	}
	areaQuery := fmt.Sprintf(`
		SELECT %s, SUB_AREA
		FROM catchments_lev12
		WHERE %s IN (%s)
	`, areaColumn, areaColumn, strings.Join(placeholders, ","))

	areaRows, err := s.db.Query(areaQuery, areaArgs...)
	if err != nil {
		log.Printf("Failed to query areas: %v", err)
	} else {
		defer areaRows.Close()
		areaRowCount := 0
		for areaRows.Next() {
			var catchmentIDRaw interface{}
			var area sql.NullFloat64
			if err := areaRows.Scan(&catchmentIDRaw, &area); err != nil {
				continue
			}

			normalizedID := normalizeCatchmentID(dbValueToString(catchmentIDRaw))
			ci := CatchmentIndicators{
				ID:          normalizedID,
				AreaKm2:     area.Float64,
				Reference:   scenarioData["reference"][normalizedID],
				Current:     scenarioData["current"][normalizedID],
				AOIFraction: 1.0,
			}
			if ci.Reference == nil {
				ci.Reference = make(map[string]float64)
			}
			if ci.Current == nil {
				ci.Current = make(map[string]float64)
			}
			results = append(results, ci)
			areaRowCount++
		}
		if err := areaRows.Err(); err != nil {
			return nil, fmt.Errorf("failed to scan catchment areas: %w", err)
		}
		log.Printf("[perf] GetCatchmentIndicatorsByIDs step=areaQuery id_column=%s rows=%d duration_ms=%d", areaColumn, areaRowCount, time.Since(areaStart).Milliseconds())
	}

	return results, nil
}

// ApplyAOIFractions computes overlap fractions between site geometry and catchments.
// Fractions are written in-place to catchments as values in [0, 1].
func (s *GpkgStore) ApplyAOIFractions(catchments []CatchmentIndicators, siteGeometry json.RawMessage) error {
	if len(catchments) == 0 || len(siteGeometry) == 0 {
		return nil
	}

	ids := make([]string, 0, len(catchments))
	for _, c := range catchments {
		if strings.TrimSpace(c.ID) == "" {
			continue
		}
		ids = append(ids, c.ID)
	}

	if len(ids) == 0 {
		return nil
	}

	fractions, err := s.GetCatchmentAOIFractions(ids, siteGeometry)
	if err != nil {
		return err
	}

	for i := range catchments {
		normalizedID := normalizeCatchmentID(catchments[i].ID)
		if frac, ok := fractions[normalizedID]; ok {
			catchments[i].AOIFraction = frac
		}
	}

	return nil
}

// GetCatchmentAOIFractions returns site-overlap fractions for catchments by ID.
func (s *GpkgStore) GetCatchmentAOIFractions(ids []string, siteGeometry json.RawMessage) (map[string]float64, error) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] GetCatchmentAOIFractions ids=%d duration_ms=%d", len(ids), time.Since(start).Milliseconds())
	}()

	result := make(map[string]float64, len(ids))
	if len(ids) == 0 || len(siteGeometry) == 0 {
		return result, nil
	}

	parseStart := time.Now()
	sitePolygons, err := geometryRawToPolygons(siteGeometry)
	if err != nil || len(sitePolygons) == 0 {
		return result, nil
	}
	// Simplify the site polygon for intersection computation so that high-vertex
	// uploads (e.g. 6 000-vertex Malawi boundary) don't make polyclip extremely
	// slow per catchment.  The displayed geometry is unaffected.
	sitePolygons = simplifyPolygonsForComputation(sitePolygons)
	log.Printf("[perf] GetCatchmentAOIFractions step=parseSiteGeometry polygons=%d duration_ms=%d", len(sitePolygons), time.Since(parseStart).Milliseconds())

	fetchStart := time.Now()
	features, err := s.GetCatchmentsByIDs(ids)
	if err != nil {
		return result, err
	}
	log.Printf("[perf] GetCatchmentAOIFractions step=fetchCatchments features=%d duration_ms=%d", len(features), time.Since(fetchStart).Milliseconds())

	overlapStart := time.Now()

	type intersectResult struct {
		id   string
		frac float64
	}

	numWorkers := runtime.NumCPU()
	if numWorkers < 1 {
		numWorkers = 1
	}
	sem := make(chan struct{}, numWorkers)
	resultCh := make(chan intersectResult, len(features))
	var wg sync.WaitGroup

	for _, feature := range features {
		feature := feature
		wg.Add(1)
		sem <- struct{}{}
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			defer func() {
				if r := recover(); r != nil {
					log.Printf("GetCatchmentAOIFractions: panic in intersection goroutine: %v", r)
				}
			}()

			catchmentID := normalizeCatchmentID(strconv.FormatInt(feature.ID, 10))
			catchmentPolygons, err := geometryRawToPolygons(feature.Geometry)
			if err != nil || len(catchmentPolygons) == 0 {
				return
			}

			catchmentArea := sumPolygonAreaKm2(catchmentPolygons)
			if !isFinitePositive(catchmentArea) {
				return
			}

			overlapArea := intersectionAreaKm2(sitePolygons, catchmentPolygons)
			frac := 0.0
			if isFinitePositive(overlapArea) {
				frac = overlapArea / catchmentArea
				if frac < 0 {
					frac = 0
				} else if frac > 1 {
					frac = 1
				}
			}
			resultCh <- intersectResult{id: catchmentID, frac: frac}
		}()
	}
	wg.Wait()
	close(resultCh)

	for r := range resultCh {
		result[r.id] = r.frac
	}
	log.Printf("[perf] GetCatchmentAOIFractions step=overlapLoop features=%d matched=%d workers=%d duration_ms=%d", len(features), len(result), numWorkers, time.Since(overlapStart).Milliseconds())

	return result, nil
}

func geometryRawToPolygons(geometry json.RawMessage) ([]polyclip.Polygon, error) {
	var parsed struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}
	if err := json.Unmarshal(geometry, &parsed); err != nil {
		return nil, err
	}

	switch parsed.Type {
	case "Polygon":
		var coords [][][]float64
		if err := json.Unmarshal(parsed.Coordinates, &coords); err != nil {
			return nil, err
		}
		poly := coordinatesToPolyclipPolygon(coords)
		if len(poly) == 0 {
			return nil, nil
		}
		return []polyclip.Polygon{poly}, nil
	case "MultiPolygon":
		var coords [][][][]float64
		if err := json.Unmarshal(parsed.Coordinates, &coords); err != nil {
			return nil, err
		}
		polys := make([]polyclip.Polygon, 0, len(coords))
		for _, polygon := range coords {
			poly := coordinatesToPolyclipPolygon(polygon)
			if len(poly) > 0 {
				polys = append(polys, poly)
			}
		}
		return polys, nil
	default:
		return nil, nil
	}
}

func coordinatesToPolyclipPolygon(rings [][][]float64) polyclip.Polygon {
	poly := make(polyclip.Polygon, 0, len(rings))
	for _, ring := range rings {
		if len(ring) < 3 {
			continue
		}
		contour := make(polyclip.Contour, 0, len(ring))
		for _, pt := range ring {
			if len(pt) < 2 {
				continue
			}
			contour = append(contour, polyclip.Point{X: pt[0], Y: pt[1]})
		}
		if len(contour) >= 3 {
			poly = append(poly, contour)
		}
	}
	return poly
}

// rdpPolyline reduces an OPEN polyline's vertex count using the
// Ramer-Douglas-Peucker algorithm with the given tolerance (degrees).
// Caller must ensure len(pts) >= 2.
func rdpPolyline(pts polyclip.Contour, tol float64) polyclip.Contour {
	if len(pts) <= 2 {
		return pts
	}
	first, last := pts[0], pts[len(pts)-1]
	dx := last.X - first.X
	dy := last.Y - first.Y
	lineLen := math.Sqrt(dx*dx + dy*dy)

	maxDist, maxIdx := -1.0, 0
	for i := 1; i < len(pts)-1; i++ {
		var dist float64
		if lineLen < 1e-12 {
			ddx := pts[i].X - first.X
			ddy := pts[i].Y - first.Y
			dist = math.Sqrt(ddx*ddx + ddy*ddy)
		} else {
			dist = math.Abs(dy*pts[i].X-dx*pts[i].Y+last.X*first.Y-last.Y*first.X) / lineLen
		}
		if dist > maxDist {
			maxDist = dist
			maxIdx = i
		}
	}

	if maxDist <= tol {
		return polyclip.Contour{first, last}
	}
	left := rdpPolyline(pts[:maxIdx+1], tol)
	right := rdpPolyline(pts[maxIdx:], tol)
	return append(left[:len(left)-1], right...)
}

// rdpSimplifyContour simplifies a polygon ring (open or closed) with RDP.
// GeoJSON rings are explicitly closed (first == last); the duplicate endpoint
// is stripped before simplification and re-added after so the standard
// open-polyline algorithm works correctly.
func rdpSimplifyContour(pts polyclip.Contour, tol float64) polyclip.Contour {
	if len(pts) < 4 {
		return pts
	}
	closed := pts[0] == pts[len(pts)-1]
	open := pts
	if closed {
		open = pts[:len(pts)-1] // remove duplicate closing point
	}
	if len(open) < 3 {
		return pts
	}
	// For a closed ring, find the best "split" vertex (farthest from any edge)
	// by rotating the ring so that vertex becomes the first point, then run RDP.
	if closed {
		// Find the vertex that is farthest from its two neighbours — a good anchor.
		anchorIdx := 0
		maxGap := -1.0
		n := len(open)
		for i := 0; i < n; i++ {
			prev := open[(i+n-1)%n]
			next := open[(i+1)%n]
			dx1 := open[i].X - prev.X
			dy1 := open[i].Y - prev.Y
			dx2 := next.X - open[i].X
			dy2 := next.Y - open[i].Y
			gap := math.Sqrt(dx1*dx1+dy1*dy1) + math.Sqrt(dx2*dx2+dy2*dy2)
			if gap > maxGap {
				maxGap = gap
				anchorIdx = i
			}
		}
		// Rotate so the anchor is first, append it again to close.
		rotated := make(polyclip.Contour, 0, n+1)
		rotated = append(rotated, open[anchorIdx:]...)
		rotated = append(rotated, open[:anchorIdx]...)
		rotated = append(rotated, rotated[0]) // close
		simplified := rdpPolyline(rotated, tol)
		if len(simplified) < 3 {
			return pts
		}
		return simplified
	}
	return rdpPolyline(open, tol)
}

// simplifyPolygonsForComputation simplifies each contour of every polygon using
// RDP at 0.001° tolerance (~110 m at the equator).  This reduces the vertex
// count of complex site boundaries (e.g. 6 000+ vertices) before calling the
// polyclip intersection, which is O(n×m) in vertex counts.
func simplifyPolygonsForComputation(polygons []polyclip.Polygon) []polyclip.Polygon {
	const tol = 0.001
	out := make([]polyclip.Polygon, 0, len(polygons))
	for _, poly := range polygons {
		simplified := make(polyclip.Polygon, 0, len(poly))
		for _, contour := range poly {
			s := rdpSimplifyContour(contour, tol)
			if len(s) >= 3 {
				simplified = append(simplified, s)
			}
		}
		if len(simplified) > 0 {
			out = append(out, simplified)
		}
	}
	if len(out) == 0 {
		return polygons // fall back to originals if simplification collapsed everything
	}
	return out
}

func sumPolygonAreaKm2(polygons []polyclip.Polygon) float64 {
	total := 0.0
	for _, p := range polygons {
		total += calculatePolygonArea(p)
	}
	return total
}

func intersectionAreaKm2(a, b []polyclip.Polygon) float64 {
	total := 0.0
	for _, ap := range a {
		for _, bp := range b {
			inter := ap.Construct(polyclip.INTERSECTION, bp)
			total += calculatePolygonArea(inter)
		}
	}
	return total
}

func isFinitePositive(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v > 0
}

// GetCatchmentsByIDs returns catchment geometries for the given IDs
func (s *GpkgStore) GetCatchmentsByIDs(ids []string) ([]GeoJSONFeature, error) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] GetCatchmentsByIDs ids=%d duration_ms=%d", len(ids), time.Since(start).Milliseconds())
	}()

	if len(ids) == 0 {
		return nil, nil
	}

	placeholders := make([]string, len(ids))
	textArgs := make([]interface{}, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		textArgs[i] = normalizeCatchmentID(strings.TrimSpace(id))
	}
	numericArgs, numericIDs := parseNumericIDs(ids)
	idColumn := "HYBAS_ID"
	queryArgs := textArgs
	if numericIDs {
		idColumn = "HYBAS_ID_int"
		queryArgs = numericArgs
	}

	queryStart := time.Now()
	query := fmt.Sprintf(`
		SELECT %s, geojson
		FROM catchments_lev12
		WHERE %s IN (%s) AND geojson IS NOT NULL
	`, idColumn, idColumn, strings.Join(placeholders, ","))

	rows, err := s.db.Query(query, queryArgs...)
	if err != nil {
		return nil, fmt.Errorf("failed to query catchments: %w", err)
	}
	defer rows.Close()

	var features []GeoJSONFeature
	rowCount := 0
	for rows.Next() {
		var idRaw interface{}
		var geojsonStr string
		if err := rows.Scan(&idRaw, &geojsonStr); err != nil {
			continue
		}

		normalizedID := normalizeCatchmentID(dbValueToString(idRaw))
		numericID, err := strconv.ParseInt(normalizedID, 10, 64)
		if err != nil {
			continue
		}

		features = append(features, GeoJSONFeature{
			Type:     "Feature",
			ID:       numericID,
			Geometry: json.RawMessage(geojsonStr),
			Properties: map[string]interface{}{
				"HYBAS_ID": numericID,
			},
		})
		rowCount++
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to scan catchments: %w", err)
	}
	log.Printf("[perf] GetCatchmentsByIDs step=query id_column=%s rows=%d duration_ms=%d", idColumn, rowCount, time.Since(queryStart).Milliseconds())

	return features, nil
}

// GetCatchmentsByBBox returns catchment geometries intersecting the provided bounding box.
// The limit is capped by the caller to avoid very large responses.
func (s *GpkgStore) GetCatchmentsByBBox(minx, miny, maxx, maxy float64, limit int) ([]GeoJSONFeature, error) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] GetCatchmentsByBBox limit=%d duration_ms=%d", limit, time.Since(start).Milliseconds())
	}()

	if limit <= 0 {
		// SQLite treats a negative LIMIT as "no limit".
		limit = -1
	}

	query := `
		SELECT HYBAS_ID, geojson
		FROM catchments_lev12
		WHERE geojson IS NOT NULL
		  AND fid IN (
			SELECT id FROM rtree_catchments_lev12_geom
			WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?
		  )
		LIMIT ?
	`

	rows, err := s.db.Query(query, maxx, minx, maxy, miny, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query catchments by bbox: %w", err)
	}
	defer rows.Close()

	features := make([]GeoJSONFeature, 0)
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

// GetCatchmentIDsByBBox returns catchment IDs intersecting the provided bounding box.
func (s *GpkgStore) GetCatchmentIDsByBBox(minx, miny, maxx, maxy float64, limit int) ([]string, error) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] GetCatchmentIDsByBBox limit=%d duration_ms=%d", limit, time.Since(start).Milliseconds())
	}()

	if limit <= 0 {
		// SQLite treats a negative LIMIT as "no limit".
		limit = -1
	}

	query := `
		SELECT CAST(c.HYBAS_ID AS TEXT)
		FROM rtree_catchments_lev12_geom r
		JOIN catchments_lev12 c ON c.fid = r.id
		WHERE r.minx <= ? AND r.maxx >= ? AND r.miny <= ? AND r.maxy >= ?
		LIMIT ?
	`

	rows, err := s.db.Query(query, maxx, minx, maxy, miny, limit)
	if err != nil {
		return nil, fmt.Errorf("failed to query catchment IDs by bbox: %w", err)
	}
	defer rows.Close()

	ids := make([]string, 0)
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			continue
		}
		ids = append(ids, normalizeCatchmentID(id))
	}

	return ids, nil
}

// GetCatchmentsBounds returns the envelope of all catchment geometries.
func (s *GpkgStore) GetCatchmentsBounds() ([4]float64, error) {
	var bounds [4]float64

	const query = `
		SELECT MIN(minx), MIN(miny), MAX(maxx), MAX(maxy)
		FROM rtree_catchments_lev12_geom
	`

	if err := s.db.QueryRow(query).Scan(&bounds[0], &bounds[1], &bounds[2], &bounds[3]); err != nil {
		return bounds, fmt.Errorf("failed to query catchments bounds: %w", err)
	}

	if !(bounds[0] < bounds[2] && bounds[1] < bounds[3]) {
		return bounds, fmt.Errorf("invalid catchments bounds")
	}

	return bounds, nil
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

// ComputeWhiskerBounds returns area-weighted whisker bounds for the given catchments
// by querying the four whisker scenario tables directly from the GeoPackage.
// This replaces the CSV-based WhiskerStore approach which required loading 200-400 MB
// files into memory at startup.
func (s *GpkgStore) ComputeWhiskerBounds(catchments []CatchmentIndicators) WhiskerBounds {
	if len(catchments) == 0 {
		return WhiskerBounds{}
	}

	s.mu.RLock()
	columns := s.columns
	s.mu.RUnlock()
	if len(columns) == 0 {
		return WhiskerBounds{}
	}

	// Build ID lookup and total weighted area.
	type catchInfo struct {
		weight float64 // (AreaKm2 * AOIFraction) / totalArea
	}
	totalArea := 0.0
	for _, c := range catchments {
		frac := c.AOIFraction
		if frac <= 0 || frac > 1 {
			frac = 1
		}
		totalArea += c.AreaKm2 * frac
	}
	if totalArea <= 0 {
		return WhiskerBounds{}
	}
	weights := make(map[string]catchInfo, len(catchments))
	for _, c := range catchments {
		frac := c.AOIFraction
		if frac <= 0 || frac > 1 {
			frac = 1
		}
		weights[c.ID] = catchInfo{weight: (c.AreaKm2 * frac) / totalArea}
	}

	ids := make([]string, 0, len(catchments))
	for _, c := range catchments {
		ids = append(ids, c.ID)
	}
	placeholders := make([]string, len(ids))
	textArgs := make([]interface{}, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		textArgs[i] = id
	}
	numericArgs, numericIDs := parseNumericIDs(ids)

	quotedCols := make([]string, len(columns))
	for i, col := range columns {
		quotedCols[i] = fmt.Sprintf(`"%s"`, col)
	}
	phStr := strings.Join(placeholders, ",")
	colStr := strings.Join(quotedCols, ", ")

	queryTable := func(tableName string) map[string]float64 {
		idColumn, err := s.resolveScenarioIDColumn(tableName)
		if err != nil {
			log.Printf("ComputeWhiskerBounds: failed to resolve ID column for %s: %v", tableName, err)
			return nil
		}
		queryArgs := textArgs
		if strings.HasSuffix(idColumn, "_int") && numericIDs {
			queryArgs = numericArgs
		}
		query := fmt.Sprintf(`SELECT %s, %s FROM %s WHERE %s IN (%s)`,
			idColumn, colStr, tableName, idColumn, phStr)

		rows, err := s.db.Query(query, queryArgs...)
		if err != nil {
			log.Printf("ComputeWhiskerBounds: failed to query %s: %v", tableName, err)
			return nil
		}
		defer rows.Close()

		weightedSums := make(map[string]float64)
		validWeights := make(map[string]float64)

		// Pre-allocate scan buffers once outside the row loop.
		vals := make([]sql.NullFloat64, len(columns))
		var idRaw interface{}
		scanArgs := make([]interface{}, len(columns)+1)
		scanArgs[0] = &idRaw
		for i := range vals {
			scanArgs[i+1] = &vals[i]
		}

		for rows.Next() {
			if err := rows.Scan(scanArgs...); err != nil {
				continue
			}
			normalID := normalizeCatchmentID(dbValueToString(idRaw))
			ci, ok := weights[normalID]
			if !ok {
				continue
			}
			for i, col := range columns {
				if vals[i].Valid {
					weightedSums[col] += vals[i].Float64 * ci.weight
					validWeights[col] += ci.weight
				}
			}
		}
		if rows.Err() != nil {
			return nil
		}

		result := make(map[string]float64, len(weightedSums))
		for col, ws := range weightedSums {
			if vw := validWeights[col]; vw > 0 {
				result[col] = ws / vw
			}
		}
		return result
	}

	// Run all four table queries concurrently — they are independent reads.
	type namedResult struct {
		name   string
		values map[string]float64
	}
	ch := make(chan namedResult, 4)
	for _, tbl := range []string{
		"scenario_reference_lower",
		"scenario_reference_upper",
		"scenario_current_lower",
		"scenario_current_upper",
	} {
		tbl := tbl
		go func() {
			defer func() {
				if r := recover(); r != nil {
					log.Printf("ComputeWhiskerBounds: panic querying %s: %v", tbl, r)
					ch <- namedResult{name: tbl, values: nil}
				}
			}()
			ch <- namedResult{name: tbl, values: queryTable(tbl)}
		}()
	}
	var bounds WhiskerBounds
	for range [4]struct{}{} {
		r := <-ch
		switch r.name {
		case "scenario_reference_lower":
			bounds.ReferenceLower = r.values
		case "scenario_reference_upper":
			bounds.ReferenceUpper = r.values
		case "scenario_current_lower":
			bounds.CurrentLower = r.values
		case "scenario_current_upper":
			bounds.CurrentUpper = r.values
		}
	}
	return bounds
}
