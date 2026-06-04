package api

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"archive/zip"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/sites"
)

// ============================================================================
// Minimal ESRI Shapefile parser (test-only; no external dependencies)
// Supports type 5 (Polygon), 15 (PolygonZ), and 25 (PolygonM).
// ============================================================================

type shpRing [][2]float64

// parseShapefileZip opens a .zip, locates the first .shp file, parses all
// polygon rings, and returns a GeoJSON geometry together with its bbox.
func parseShapefileZip(zipPath string) (json.RawMessage, [4]float64, error) {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return nil, [4]float64{}, err
	}
	defer r.Close()

	for _, f := range r.File {
		if !strings.HasSuffix(strings.ToLower(f.Name), ".shp") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, [4]float64{}, err
		}
		data, readErr := io.ReadAll(rc)
		rc.Close()
		if readErr != nil {
			return nil, [4]float64{}, readErr
		}
		rings, err := parseSHPRings(data)
		if err != nil {
			return nil, [4]float64{}, err
		}
		return ringsToGeoJSONAndBBox(rings)
	}
	return nil, [4]float64{}, fmt.Errorf("no .shp file found in %s", zipPath)
}

// parseSHPRings reads the binary SHP content and returns all polygon rings.
func parseSHPRings(data []byte) ([]shpRing, error) {
	const fileHeaderSize = 100
	if len(data) < fileHeaderSize {
		return nil, fmt.Errorf("shp too short (%d bytes)", len(data))
	}

	var rings []shpRing
	offset := fileHeaderSize

	for offset < len(data) {
		if offset+8 > len(data) {
			break
		}
		// Record header: record number (big-endian int32) + content length in 16-bit words (big-endian int32).
		contentLen := int(binary.BigEndian.Uint32(data[offset+4:offset+8])) * 2
		offset += 8

		if contentLen <= 0 || offset+contentLen > len(data) {
			break
		}
		rec := data[offset : offset+contentLen]
		offset += contentLen

		if len(rec) < 4 {
			continue
		}
		shapeType := binary.LittleEndian.Uint32(rec[0:4])

		switch shapeType {
		case 5, 15, 25: // Polygon, PolygonZ, PolygonM
			if len(rec) < 44 {
				continue
			}
			// bbox: rec[4:36]  (skipped)
			numParts := int(binary.LittleEndian.Uint32(rec[36:40]))
			numPoints := int(binary.LittleEndian.Uint32(rec[40:44]))

			partsEnd := 44 + numParts*4
			pointsStart := partsEnd
			if len(rec) < pointsStart+numPoints*16 {
				continue
			}

			parts := make([]int, numParts)
			for i := 0; i < numParts; i++ {
				parts[i] = int(binary.LittleEndian.Uint32(rec[44+i*4:]))
			}

			for i := 0; i < numParts; i++ {
				start := parts[i]
				end := numPoints
				if i+1 < numParts {
					end = parts[i+1]
				}
				if end <= start || start < 0 || end > numPoints {
					continue
				}
				ring := make(shpRing, 0, end-start)
				for j := start; j < end; j++ {
					base := pointsStart + j*16
					if base+16 > len(rec) {
						break
					}
					x := math.Float64frombits(binary.LittleEndian.Uint64(rec[base:]))
					y := math.Float64frombits(binary.LittleEndian.Uint64(rec[base+8:]))
					ring = append(ring, [2]float64{x, y})
				}
				if len(ring) >= 3 {
					rings = append(rings, ring)
				}
			}
		}
	}

	return rings, nil
}

// shpSignedArea computes the signed area via the shoelace formula.
// Positive → counter-clockwise (outer ring in GeoJSON).
// Negative → clockwise (hole in GeoJSON, or outer ring in Shapefile convention).
func shpSignedArea(r shpRing) float64 {
	n := len(r)
	sum := 0.0
	for i := 0; i < n; i++ {
		j := (i + 1) % n
		sum += r[i][0]*r[j][1] - r[j][0]*r[i][1]
	}
	return sum / 2
}

// ringsToGeoJSONAndBBox converts parsed rings to GeoJSON Polygon / MultiPolygon
// and computes the geometry bounding box.
// Rings are treated as independent polygon parts (holes are reversed to outer rings
// for simplicity — the geometry is used only for catchment bbox lookup and AOI
// intersection in tests, so this approximation does not affect correctness).
func ringsToGeoJSONAndBBox(rings []shpRing) (json.RawMessage, [4]float64, error) {
	bbox := [4]float64{math.MaxFloat64, math.MaxFloat64, -math.MaxFloat64, -math.MaxFloat64}

	type geoRing = [][2]float64
	type geoPoly = []geoRing // outer ring + holes

	var polys []geoPoly

	for _, r := range rings {
		area := shpSignedArea(r)

		// Close the ring if not already closed.
		ring := geoRing(r)
		if len(ring) > 0 && ring[0] != ring[len(ring)-1] {
			ring = append(ring, ring[0])
		}

		// Enforce CCW winding for GeoJSON outer rings.
		// In ESRI Shapefiles, outer rings are clockwise (negative shoelace area).
		if area < 0 {
			for i, j := 0, len(ring)-1; i < j; i, j = i+1, j-1 {
				ring[i], ring[j] = ring[j], ring[i]
			}
		}

		// Each ring becomes a standalone polygon (outer ring only).
		polys = append(polys, geoPoly{ring})

		for _, pt := range ring {
			if pt[0] < bbox[0] {
				bbox[0] = pt[0]
			}
			if pt[1] < bbox[1] {
				bbox[1] = pt[1]
			}
			if pt[0] > bbox[2] {
				bbox[2] = pt[0]
			}
			if pt[1] > bbox[3] {
				bbox[3] = pt[1]
			}
		}
	}

	if len(polys) == 0 {
		return nil, bbox, fmt.Errorf("shapefile contains no polygon rings")
	}

	var geomJSON []byte
	var marshalErr error
	if len(polys) == 1 {
		geomJSON, marshalErr = json.Marshal(map[string]interface{}{
			"type":        "Polygon",
			"coordinates": polys[0],
		})
	} else {
		geomJSON, marshalErr = json.Marshal(map[string]interface{}{
			"type":        "MultiPolygon",
			"coordinates": polys,
		})
	}
	if marshalErr != nil {
		return nil, bbox, marshalErr
	}
	return json.RawMessage(geomJSON), bbox, nil
}

// ============================================================================
// Shared integration test infrastructure
// ============================================================================

const (
	realDataDir  = "../../data"
	testDataDir2 = "../../test_data"
)

// openIntegrationStores skips the test if the datapack is not present and
// returns a GpkgStore backed by the real datapack.gpkg.
func openIntegrationStores(t *testing.T) *geodata.GpkgStore {
	t.Helper()
	gpkgPath := filepath.Join(realDataDir, "datapack.gpkg")
	if _, err := os.Stat(gpkgPath); err != nil {
		t.Skipf("datapack.gpkg not found — skipping integration test: %v", err)
	}
	gpkg, err := geodata.NewGpkgStore(realDataDir)
	if err != nil {
		t.Skipf("could not open GpkgStore: %v", err)
	}
	t.Cleanup(gpkg.Close)
	return gpkg
}

// buildRouter assembles a Handler + mux.Router using the provided stores.
func buildRouter(gpkg *geodata.GpkgStore, siteStore *sites.Store, dataDir string) *mux.Router {
	cfg := config.Config{Port: 0, DataDir: dataDir, Version: "test"}
	h := NewHandler(nil, gpkg, siteStore, cfg)
	r := mux.NewRouter()
	h.RegisterRoutes(r)
	return r
}

// postBody makes a JSON POST request against the router and returns the recorder.
func postBody(t *testing.T, r *mux.Router, path string, body interface{}) *httptest.ResponseRecorder {
	t.Helper()
	data, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal request body: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

// fetchCatchmentIDs calls POST /catchments/in-bbox and returns the IDs.
func fetchCatchmentIDs(t *testing.T, r *mux.Router, bbox [4]float64) []string {
	t.Helper()
	w := postBody(t, r, "/catchments/in-bbox", map[string]interface{}{
		"minX":            bbox[0],
		"minY":            bbox[1],
		"maxX":            bbox[2],
		"maxY":            bbox[3],
		"limit":           10000,
		"includeGeometry": false,
	})
	if w.Code != http.StatusOK {
		t.Fatalf("POST /catchments/in-bbox returned %d: %s", w.Code, w.Body.String())
	}
	var resp CatchmentsInBBoxResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal /catchments/in-bbox: %v", err)
	}
	if len(resp.CatchmentIDs) == 0 {
		t.Fatalf("no catchments in bbox [%.4f,%.4f,%.4f,%.4f]", bbox[0], bbox[1], bbox[2], bbox[3])
	}
	return resp.CatchmentIDs
}

// createSite creates a site via POST /sites and returns the created site.
// creationMethod should be "shapefile", "geojson", "drawn", or "catchments".
func createSite(t *testing.T, r *mux.Router, name string, geom json.RawMessage, catchmentIDs []string, method string) sites.Site {
	t.Helper()
	body := map[string]interface{}{
		"title":          name,
		"catchmentIds":   catchmentIDs,
		"creationMethod": method,
	}
	if len(geom) > 0 {
		body["geometry"] = geom
	}
	w := postBody(t, r, "/sites", body)
	if w.Code != http.StatusCreated {
		t.Fatalf("POST /sites returned %d: %s", w.Code, w.Body.String())
	}
	var site sites.Site
	if err := json.Unmarshal(w.Body.Bytes(), &site); err != nil {
		t.Fatalf("unmarshal created site: %v", err)
	}
	if site.ID == "" {
		t.Fatal("created site has no ID")
	}
	return site
}

// extractIndicators triggers async extraction via POST then polls GET until indicators appear.
func extractIndicators(t *testing.T, r *mux.Router, siteID string) sites.Site {
	t.Helper()
	// Fire extraction — backend returns 202 immediately.
	w := postBody(t, r, "/sites/"+siteID+"/indicators", map[string]interface{}{})
	if w.Code != http.StatusAccepted && w.Code != http.StatusOK {
		t.Fatalf("POST /sites/%s/indicators returned %d: %s", siteID, w.Code, w.Body.String())
	}
	// Poll GET /sites/{id}/indicators until indicators are ready.
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		req := httptest.NewRequest(http.MethodGet, "/sites/"+siteID+"/indicators", nil)
		rw := httptest.NewRecorder()
		r.ServeHTTP(rw, req)
		if rw.Code == http.StatusAccepted {
			time.Sleep(100 * time.Millisecond)
			continue
		}
		if rw.Code != http.StatusOK {
			t.Fatalf("GET /sites/%s/indicators returned %d: %s", siteID, rw.Code, rw.Body.String())
		}
		var site sites.Site
		if err := json.Unmarshal(rw.Body.Bytes(), &site); err != nil {
			t.Fatalf("unmarshal indicator poll response: %v", err)
		}
		if site.Indicators != nil {
			return site
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("extractIndicators: timed out waiting for site %s indicators", siteID)
	return sites.Site{}
}

// waitForSiteCatchments polls the site store until the background
// populateSiteCatchmentDetailsDeferred goroutine has finished writing
// site.Catchments, or until timeout expires.  This simulates the brief
// natural delay between a user creating a site and clicking "Extract
// Indicators", ensuring the extraction request benefits from the cache.
func waitForSiteCatchments(t *testing.T, siteStore *sites.Store, siteID string, timeout time.Duration) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		s, err := siteStore.Get(siteID)
		if err == nil && len(s.Catchments) > 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Logf("warning: deferred catchment population did not complete within %v — extraction will recompute", timeout)
}

// assertIndicatorsValid checks that the site has non-empty, sensible indicator values.
func assertIndicatorsValid(t *testing.T, site sites.Site) {
	t.Helper()
	ind := site.Indicators
	if ind == nil {
		t.Fatal("site.indicators is nil")
	}
	if ind.CatchmentCount == 0 {
		t.Error("indicators.catchmentCount is 0")
	}
	if len(ind.Current) == 0 {
		t.Error("indicators.current is empty")
	}
	if len(ind.Reference) == 0 {
		t.Error("indicators.reference is empty")
	}
	if ind.TotalAreaKm2 <= 0 {
		t.Errorf("indicators.totalAreaKm2 = %f, want > 0", ind.TotalAreaKm2)
	}
}

// ============================================================================
// TestSiteCreationAndIndicatorExtraction
//
// Full pipeline: shapefile parse → catchment bbox lookup → POST /sites →
// wait for background enrichment goroutine → POST /sites/{id}/indicators.
//
// Timing is split into two parts:
//   - creation: POST /sites (fast disk write + starts background goroutine)
//   - extraction: POST /indicators after the goroutine has populated
//     site.Catchments — handleExtractIndicators reuses the cached data so
//     only ComputeWhiskerBounds queries the DB.
//
// The goroutine-wait window is not billed to either budget; it mirrors the
// natural pause between a user creating a site and clicking Extract.
// ============================================================================

func TestSiteCreationAndIndicatorExtraction(t *testing.T) {
	cases := []struct {
		name             string
		zipFile          string
		creationBudget   time.Duration // POST /sites must complete within this
		extractionBudget time.Duration // POST /indicators (warm cache) must complete within this
	}{
		{
			name:             "munywana_small",
			zipFile:          "Munywana_dissolved_fixed.zip",
			creationBudget:   500 * time.Millisecond,
			extractionBudget: 2 * time.Second,
		},
		{
			name:             "testmalawi_medium",
			zipFile:          "test.zip",
			creationBudget:   500 * time.Millisecond,
			extractionBudget: 2 * time.Second,
		},
		{
			// Full Malawi national boundary.  The dev datapack yields 2257 catchments
			// in bbox — ~3.7× the 600+ the user's deployment has.  With the warm-cache
			// path, extraction only runs ComputeWhiskerBounds (4 concurrent queries).
			name:             "gadm41_large",
			zipFile:          "gadm41_admin.zip",
			creationBudget:   500 * time.Millisecond,
			extractionBudget: 10 * time.Second,
		},
	}

	// Share one GpkgStore (read-only) across all sub-tests.
	gpkg := openIntegrationStores(t)

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			zipPath := filepath.Join(testDataDir2, tc.zipFile)
			if _, err := os.Stat(zipPath); err != nil {
				t.Skipf("test shapefile not found: %v", err)
			}

			geom, bbox, err := parseShapefileZip(zipPath)
			if err != nil {
				t.Fatalf("parseShapefileZip(%s): %v", tc.zipFile, err)
			}
			if len(geom) == 0 {
				t.Fatal("empty geometry from shapefile")
			}

			tmpDir := t.TempDir()
			siteStore, err := sites.NewStore(tmpDir)
			if err != nil {
				t.Fatalf("NewStore: %v", err)
			}
			router := buildRouter(gpkg, siteStore, realDataDir)

			// ---- Site creation ----
			catchmentIDs := fetchCatchmentIDs(t, router, bbox)
			t0Create := time.Now()
			site := createSite(t, router, tc.name, geom, catchmentIDs, "shapefile")
			createElapsed := time.Since(t0Create)

			// Wait for the background goroutine to finish enriching site.Catchments.
			// handleExtractIndicators will then reuse the cached data.
			waitForSiteCatchments(t, siteStore, site.ID, 30*time.Second)

			// ---- Indicator extraction (warm-cache path) ----
			t0Extract := time.Now()
			resultSite := extractIndicators(t, router, site.ID)
			extractElapsed := time.Since(t0Extract)

			assertIndicatorsValid(t, resultSite)

			ind := resultSite.Indicators
			t.Logf("%s: %d catchments, %.1f km², %d indicators — create %v, extract %v (budgets %v / %v)",
				tc.name,
				ind.CatchmentCount,
				ind.TotalAreaKm2,
				len(ind.Current),
				createElapsed.Round(time.Millisecond),
				extractElapsed.Round(time.Millisecond),
				tc.creationBudget,
				tc.extractionBudget,
			)

			if createElapsed > tc.creationBudget {
				t.Errorf("creation budget exceeded: %v > %v", createElapsed.Round(time.Millisecond), tc.creationBudget)
			}
			if extractElapsed > tc.extractionBudget {
				t.Errorf("extraction budget exceeded: %v > %v", extractElapsed.Round(time.Millisecond), tc.extractionBudget)
			}
		})
	}
}

// ============================================================================
// TestCatchmentsCreationMethodSkipsAOI
//
// Sites created with creationMethod == "catchments" are formed by dissolving
// a set of selected catchments, so every catchment is 100% inside the
// boundary.  Both the background goroutine and handleExtractIndicators must
// skip ApplyAOIFractions for this method.  This test confirms:
//   1. Extraction succeeds and returns valid indicators.
//   2. Extraction with the warm cache is fast (no polyclip work needed).
// ============================================================================

func TestCatchmentsCreationMethodSkipsAOI(t *testing.T) {
	// Reuse the small munywana bbox to get a manageable set of catchment IDs.
	zipPath := filepath.Join(testDataDir2, "Munywana_dissolved_fixed.zip")
	if _, err := os.Stat(zipPath); err != nil {
		t.Skipf("Munywana shapefile not found")
	}

	gpkg := openIntegrationStores(t)
	_, bbox, err := parseShapefileZip(zipPath)
	if err != nil {
		t.Fatalf("parseShapefileZip: %v", err)
	}

	tmpDir := t.TempDir()
	siteStore, _ := sites.NewStore(tmpDir)
	router := buildRouter(gpkg, siteStore, realDataDir)

	catchmentIDs := fetchCatchmentIDs(t, router, bbox)

	// Create with method "catchments" — no geometry required.
	site := createSite(t, router, "catchments_method_test", nil, catchmentIDs, "catchments")
	if site.CreationMethod != "catchments" {
		t.Fatalf("site.creationMethod = %q, want catchments", site.CreationMethod)
	}

	// Wait for background goroutine.
	waitForSiteCatchments(t, siteStore, site.ID, 10*time.Second)

	// Extraction should be fast: no AOI fractions (skipped by creationMethod guard),
	// and site.Catchments is already populated so DB queries are also skipped.
	t0 := time.Now()
	result := extractIndicators(t, router, site.ID)
	elapsed := time.Since(t0)

	assertIndicatorsValid(t, result)

	t.Logf("catchments method: %d catchments, extract %v", result.Indicators.CatchmentCount, elapsed.Round(time.Millisecond))

	const budget = 2 * time.Second
	if elapsed > budget {
		t.Errorf("extraction budget exceeded: %v > %v", elapsed.Round(time.Millisecond), budget)
	}
}

// ============================================================================
// TestShapefileParserOutput
//
// Unit-level sanity checks for the shapefile parser itself: verifies that the
// geometry type, vertex count, and bbox are reasonable for each test file.
// Does not require the datapack.
// ============================================================================

func TestShapefileParserOutput(t *testing.T) {
	cases := []struct {
		name         string
		zipFile      string
		wantType     string   // "Polygon" or "MultiPolygon"
		wantMinVerts int      // minimum total vertex count
		wantBBoxMinX float64  // rough westmost longitude
		wantBBoxMaxX float64  // rough eastmost longitude
	}{
		{
			name:         "munywana",
			zipFile:      "Munywana_dissolved_fixed.zip",
			wantType:     "Polygon",
			wantMinVerts: 100,
			wantBBoxMinX: 32.0,
			wantBBoxMaxX: 33.0,
		},
		{
			name:         "testmalawi",
			zipFile:      "test.zip",
			wantType:     "Polygon",
			wantMinVerts: 1000,
			wantBBoxMinX: 33.0,
			wantBBoxMaxX: 35.0,
		},
		{
			name:         "gadm41",
			zipFile:      "gadm41_admin.zip",
			wantMinVerts: 5000,
			wantBBoxMinX: 32.0,
			wantBBoxMaxX: 36.0,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			zipPath := filepath.Join(testDataDir2, tc.zipFile)
			if _, err := os.Stat(zipPath); err != nil {
				t.Skipf("test shapefile not found: %v", err)
			}

			geom, bbox, err := parseShapefileZip(zipPath)
			if err != nil {
				t.Fatalf("parseShapefileZip: %v", err)
			}

			// Check geometry type.
			var parsed struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(geom, &parsed); err != nil {
				t.Fatalf("unmarshal geometry: %v", err)
			}
			if tc.wantType != "" && parsed.Type != tc.wantType {
				t.Errorf("geometry type = %q, want %q", parsed.Type, tc.wantType)
			}
			if parsed.Type != "Polygon" && parsed.Type != "MultiPolygon" {
				t.Errorf("unexpected geometry type %q", parsed.Type)
			}

			// Count vertices.
			totalVerts := countVertices(geom)
			if totalVerts < tc.wantMinVerts {
				t.Errorf("vertex count = %d, want >= %d", totalVerts, tc.wantMinVerts)
			}

			// Check bbox rough bounds.
			if bbox[0] > tc.wantBBoxMaxX || bbox[2] < tc.wantBBoxMinX {
				t.Errorf("bbox [%.4f,%.4f,%.4f,%.4f] does not span expected longitude range [%.1f, %.1f]",
					bbox[0], bbox[1], bbox[2], bbox[3], tc.wantBBoxMinX, tc.wantBBoxMaxX)
			}
			if bbox[0] >= bbox[2] || bbox[1] >= bbox[3] {
				t.Errorf("invalid bbox: [%.4f,%.4f,%.4f,%.4f]", bbox[0], bbox[1], bbox[2], bbox[3])
			}

			t.Logf("%s: type=%s vertices=%d bbox=[%.4f,%.4f,%.4f,%.4f]",
				tc.name, parsed.Type, totalVerts, bbox[0], bbox[1], bbox[2], bbox[3])
		})
	}
}

// countVertices counts total coordinate pairs in a GeoJSON Polygon or MultiPolygon.
func countVertices(geom json.RawMessage) int {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(geom, &raw); err != nil {
		return 0
	}
	geomType := strings.Trim(string(raw["type"]), `"`)
	switch geomType {
	case "Polygon":
		var coords [][][2]float64
		json.Unmarshal(raw["coordinates"], &coords)
		n := 0
		for _, ring := range coords {
			n += len(ring)
		}
		return n
	case "MultiPolygon":
		var coords [][][][2]float64
		json.Unmarshal(raw["coordinates"], &coords)
		n := 0
		for _, poly := range coords {
			for _, ring := range poly {
				n += len(ring)
			}
		}
		return n
	}
	return 0
}

// ============================================================================
// TestIndicatorExtractionConsistency
//
// Verifies that running indicator extraction twice for the same site returns
// the same catchment count and total area (i.e. it is deterministic).
// ============================================================================

func TestIndicatorExtractionConsistency(t *testing.T) {
	zipPath := filepath.Join(testDataDir2, "Munywana_dissolved_fixed.zip")
	if _, err := os.Stat(zipPath); err != nil {
		t.Skipf("Munywana shapefile not found")
	}

	gpkg := openIntegrationStores(t)
	geom, bbox, err := parseShapefileZip(zipPath)
	if err != nil {
		t.Fatalf("parseShapefileZip: %v", err)
	}

	tmpDir := t.TempDir()
	siteStore, _ := sites.NewStore(tmpDir)
	router := buildRouter(gpkg, siteStore, realDataDir)

	catchmentIDs := fetchCatchmentIDs(t, router, bbox)
	site := createSite(t, router, "munywana_consistency", geom, catchmentIDs, "shapefile")

	waitForSiteCatchments(t, siteStore, site.ID, 5*time.Second)

	result1 := extractIndicators(t, router, site.ID)
	result2 := extractIndicators(t, router, site.ID)

	assertIndicatorsValid(t, result1)
	assertIndicatorsValid(t, result2)

	if result1.Indicators.CatchmentCount != result2.Indicators.CatchmentCount {
		t.Errorf("CatchmentCount not stable: %d vs %d",
			result1.Indicators.CatchmentCount, result2.Indicators.CatchmentCount)
	}
	if math.Abs(result1.Indicators.TotalAreaKm2-result2.Indicators.TotalAreaKm2) > 0.1 {
		t.Errorf("TotalAreaKm2 not stable: %.4f vs %.4f",
			result1.Indicators.TotalAreaKm2, result2.Indicators.TotalAreaKm2)
	}
	t.Logf("extraction stable: %d catchments, %.2f km²",
		result1.Indicators.CatchmentCount, result1.Indicators.TotalAreaKm2)
}
