package geodata

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"
	"github.com/kartoza/decision-theatre/internal/gpkgtest"
)

// legacyFeature is the shape QueryCatchmentValues used to emit, one per
// catchment: a GeoJSON Feature wrapper with a null geometry carrying a single
// ID and a single float. It is reproduced here so the tests can assert that the
// columnar format carries exactly the same information and yields exactly the
// same statistics - the point of the change is fewer bytes, not different
// numbers.
type legacyFeature struct {
	Type       string             `json:"type"`
	ID         int64              `json:"id"`
	Geometry   json.RawMessage    `json:"geometry"`
	Properties map[string]float64 `json:"properties"`
}

type legacyCollection struct {
	Type     string          `json:"type"`
	Features []legacyFeature `json:"features"`
}

// zoneStats mirrors the frontend's computeZoneStats: min, max, mean and count
// over the values, summed in wire order.
type zoneStats struct {
	min, max, mean float64
	count          int
}

func statsFromLegacy(fc legacyCollection, attribute string) zoneStats {
	stats := zoneStats{min: math.Inf(1), max: math.Inf(-1)}
	sum := 0.0
	for _, f := range fc.Features {
		v, ok := f.Properties[attribute]
		if !ok || math.IsNaN(v) {
			continue
		}
		if v < stats.min {
			stats.min = v
		}
		if v > stats.max {
			stats.max = v
		}
		sum += v
		stats.count++
	}
	stats.mean = sum / float64(stats.count)
	return stats
}

func statsFromSeries(values []interface{}) zoneStats {
	stats := zoneStats{min: math.Inf(1), max: math.Inf(-1)}
	sum := 0.0
	for _, raw := range values {
		v, ok := raw.(float64)
		if !ok || math.IsNaN(v) {
			continue
		}
		if v < stats.min {
			stats.min = v
		}
		if v > stats.max {
			stats.max = v
		}
		sum += v
		stats.count++
	}
	stats.mean = sum / float64(stats.count)
	return stats
}

// writeValuesFixture builds a minimal datapack holding rowCount catchments with
// a value in each scenario. Values are deliberately awkward floats: the whole
// claim of the columnar format is that it changes the bytes and not the
// numbers, which is only worth asserting on values that a lazy formatter would
// round.
func writeValuesFixture(t *testing.T, dir string, rowCount int) {
	t.Helper()

	db, err := sql.Open("sqlite3", filepath.Join(dir, "datapack.gpkg"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()

	schema := []string{
		`CREATE TABLE catchments_lev12 (fid INTEGER PRIMARY KEY, HYBAS_ID TEXT, HYBAS_ID_int INTEGER, geojson TEXT, geojson_simplified TEXT)`,
		`CREATE TABLE scenario_current (catchment_id_int INTEGER, NPP_gm2 REAL, SOC REAL)`,
		`CREATE TABLE scenario_reference (catchment_id_int INTEGER, NPP_gm2 REAL, SOC REAL)`,
		`CREATE TABLE rtree_catchments_lev12_geom (id INTEGER, minx REAL, maxx REAL, miny REAL, maxy REAL)`,
		`CREATE TABLE domain_minima (NPP_gm2 REAL, SOC REAL)`,
		`CREATE TABLE domain_maxima (NPP_gm2 REAL, SOC REAL)`,
		`INSERT INTO domain_minima VALUES (0.0, 0.0)`,
		`INSERT INTO domain_maxima VALUES (9999.0, 9999.0)`,
	}
	for _, stmt := range schema {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("fixture schema: %s: %v", stmt, err)
		}
	}

	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < rowCount; i++ {
		id := int64(1121879850 + i)
		// Longitudes spread across a degree so a sub-extent query selects a
		// predictable subset.
		lon := float64(i) / float64(rowCount)
		current := 1234.5678901234 + float64(i)/3.0
		reference := 987.65432109876 + float64(i)/7.0
		if _, err := tx.Exec(
			`INSERT INTO catchments_lev12 (fid, HYBAS_ID, HYBAS_ID_int, geojson) VALUES (?, ?, ?, ?)`,
			i+1, fmt.Sprintf("%d", id), id, `{"type":"Polygon","coordinates":[]}`,
		); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(`INSERT INTO rtree_catchments_lev12_geom VALUES (?, ?, ?, ?, ?)`,
			i+1, lon, lon+0.0001, 0.0, 0.0001); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(`INSERT INTO scenario_current VALUES (?, ?, ?)`, id, current, current/2); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(`INSERT INTO scenario_reference VALUES (?, ?, ?)`, id, reference, reference/2); err != nil {
			t.Fatal(err)
		}
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func openValuesFixture(t *testing.T, rowCount int) *GpkgStore {
	t.Helper()
	dir := t.TempDir()
	writeValuesFixture(t, dir, rowCount)

	store, err := NewGpkgStore(dir)
	if err != nil {
		t.Fatalf("opening fixture datapack: %v", err)
	}
	t.Cleanup(func() { _ = store.db.Close() })
	return store
}

// decodeSeries returns one scenario's values from a marshalled response, as
// []interface{} so JSON nulls survive as nil.
func decodeSeries(t *testing.T, encoded []byte) []interface{} {
	t.Helper()
	var values []interface{}
	if err := json.Unmarshal(encoded, &values); err != nil {
		t.Fatalf("decoding series: %v", err)
	}
	return values
}

func TestCatchmentValuesCarryEveryCatchment(t *testing.T) {
	store := openValuesFixture(t, 500)

	values, err := store.QueryCatchmentValues(context.Background(), []string{"current"}, "NPP_gm2", -180, -90, 180, 90)
	if err != nil {
		t.Fatalf("QueryCatchmentValues: %v", err)
	}

	if len(values.IDs) != 500 {
		t.Errorf("expected every catchment, got %d of 500", len(values.IDs))
	}
	series := values.Series["current"]
	if series == nil {
		t.Fatal("no series for the requested scenario")
	}
	if len(series.Values) != len(values.IDs) {
		t.Errorf("series is not aligned to ids: %d values, %d ids", len(series.Values), len(values.IDs))
	}
	if values.IDs[0] != 1121879850 {
		t.Errorf("HYBAS_ID was not preserved: got %d", values.IDs[0])
	}
}

// The bounding box is honoured, and it is the only thing that limits the row
// count - there is no zoom tier and no LIMIT on this path, by design.
func TestCatchmentValuesRespectTheBoundingBox(t *testing.T) {
	store := openValuesFixture(t, 100)

	values, err := store.QueryCatchmentValues(context.Background(), []string{"current"}, "NPP_gm2", 0, -1, 0.5, 1)
	if err != nil {
		t.Fatalf("QueryCatchmentValues: %v", err)
	}

	if len(values.IDs) == 0 || len(values.IDs) >= 100 {
		t.Errorf("expected a subset of the 100 catchments, got %d", len(values.IDs))
	}
}

// The whole point of the format: identical statistics, fewer bytes. Both are
// asserted here against the GeoJSON shape this replaced, built from the same
// query result.
func TestColumnarStatisticsMatchTheGeoJSONShape(t *testing.T) {
	store := openValuesFixture(t, 2000)

	values, err := store.QueryCatchmentValues(context.Background(), []string{"current"}, "NPP_gm2", -180, -90, 180, 90)
	if err != nil {
		t.Fatalf("QueryCatchmentValues: %v", err)
	}
	series := values.Series["current"]

	legacy := legacyCollection{Type: "FeatureCollection"}
	for i, id := range values.IDs {
		legacy.Features = append(legacy.Features, legacyFeature{
			Type:       "Feature",
			ID:         id,
			Geometry:   json.RawMessage("null"),
			Properties: map[string]float64{"HYBAS_ID": float64(id), "NPP_gm2": series.Values[i]},
		})
	}

	legacyJSON, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	columnarJSON, err := json.Marshal(series)
	if err != nil {
		t.Fatal(err)
	}
	idsJSON, err := json.Marshal(values.IDs)
	if err != nil {
		t.Fatal(err)
	}
	columnarTotal := len(columnarJSON) + len(idsJSON)

	// Statistics computed from the two encodings must agree bit for bit, since
	// nothing about the arithmetic changed - only how the numbers arrive.
	var decodedLegacy legacyCollection
	if err := json.Unmarshal(legacyJSON, &decodedLegacy); err != nil {
		t.Fatal(err)
	}
	want := statsFromLegacy(decodedLegacy, "NPP_gm2")
	got := statsFromSeries(decodeSeries(t, columnarJSON))

	if got != want {
		t.Errorf("statistics differ between the two encodings:\n  geojson:  %+v\n  columnar: %+v", want, got)
	}

	if columnarTotal >= len(legacyJSON) {
		t.Errorf("columnar encoding is not smaller: %d bytes vs %d", columnarTotal, len(legacyJSON))
	}
	t.Logf("2000 catchments: geojson %d bytes, columnar %d bytes (%.1fx smaller)",
		len(legacyJSON), columnarTotal, float64(len(legacyJSON))/float64(columnarTotal))

	// No per-feature wrapper and no repeated null geometry: the two things the
	// ticket is about.
	if strings.Contains(string(columnarJSON), "Feature") || strings.Contains(string(columnarJSON), "geometry") {
		t.Error("the columnar encoding still carries feature wrappers")
	}
	if strings.Contains(string(columnarJSON), "null") {
		t.Error("the columnar encoding still carries null geometries")
	}
}

// Every value must survive the round trip exactly. strconv's shortest
// round-trip formatting guarantees this; a fixed-precision formatter would not,
// and the statistics would drift.
func TestSeriesValuesRoundTripExactly(t *testing.T) {
	series := &ScenarioValues{}
	awkward := []float64{
		1234.5678901234, 0.1, 1e-7, 1e21, -0.0, 3.141592653589793,
		math.SmallestNonzeroFloat64, math.MaxFloat64,
	}
	for _, v := range awkward {
		series.append(v, true)
	}

	encoded, err := json.Marshal(series)
	if err != nil {
		t.Fatalf("marshalling series: %v", err)
	}

	var decoded []float64
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decoding series: %v", err)
	}
	for i, want := range awkward {
		if math.Float64bits(decoded[i]) != math.Float64bits(want) {
			t.Errorf("value %d did not round trip: sent %v, got %v", i, want, decoded[i])
		}
	}
}

// A catchment a scenario has no value for has to be representable, because all
// series share one ID array.
func TestMissingValuesMarshalAsNull(t *testing.T) {
	series := &ScenarioValues{}
	series.append(1.5, true)
	series.append(0, false)
	series.append(math.Inf(1), true)

	encoded, err := json.Marshal(series)
	if err != nil {
		t.Fatalf("marshalling series: %v", err)
	}
	if string(encoded) != "[1.5,null,null]" {
		t.Errorf("expected [1.5,null,null], got %s", encoded)
	}
}

// Both scenarios of a comparison come back from one query, sharing one ID
// array. That sharing is the saving, so it is worth asserting explicitly.
func TestTwoScenariosShareOneIDArray(t *testing.T) {
	store := openValuesFixture(t, 200)

	values, err := store.QueryCatchmentValues(context.Background(), []string{"current", "reference"}, "NPP_gm2", -180, -90, 180, 90)
	if err != nil {
		t.Fatalf("QueryCatchmentValues: %v", err)
	}

	if len(values.Series) != 2 {
		t.Fatalf("expected two series, got %d", len(values.Series))
	}
	for _, scenario := range []string{"current", "reference"} {
		series := values.Series[scenario]
		if series == nil {
			t.Fatalf("no series for %s", scenario)
		}
		if len(series.Values) != len(values.IDs) {
			t.Errorf("%s series is not aligned to ids: %d values, %d ids", scenario, len(series.Values), len(values.IDs))
		}
	}
	if values.Series["current"].Values[0] == values.Series["reference"].Values[0] {
		t.Error("the two scenarios returned the same value; they read different tables")
	}

	// Same answer as two separate single-scenario queries would have given.
	single, err := store.QueryCatchmentValues(context.Background(), []string{"reference"}, "NPP_gm2", -180, -90, 180, 90)
	if err != nil {
		t.Fatal(err)
	}
	for i := range single.IDs {
		if single.IDs[i] != values.IDs[i] {
			t.Fatalf("id %d differs between the combined and single query", i)
		}
		if single.Series["reference"].Values[i] != values.Series["reference"].Values[i] {
			t.Fatalf("value %d differs between the combined and single query", i)
		}
	}
}

// reference and future read the same table. They must still get independent
// series, because the API layer overlays a site's edited targets onto future
// and must not thereby edit reference.
func TestFutureAndReferenceDoNotShareStorage(t *testing.T) {
	store := openValuesFixture(t, 10)

	values, err := store.QueryCatchmentValues(context.Background(), []string{"reference", "future"}, "NPP_gm2", -180, -90, 180, 90)
	if err != nil {
		t.Fatalf("QueryCatchmentValues: %v", err)
	}

	before := values.Series["reference"].Values[0]
	values.Series["future"].Set(0, 42)
	if values.Series["reference"].Values[0] != before {
		t.Error("editing the future series changed the reference series")
	}
	if values.Series["future"].Values[0] != 42 {
		t.Error("the future series was not edited")
	}
}

func TestQueryCatchmentValuesRejectsBadInput(t *testing.T) {
	store := openValuesFixture(t, 5)

	if _, err := store.QueryCatchmentValues(context.Background(), []string{"current"}, "NPP_gm2; DROP TABLE catchments_lev12", -180, -90, 180, 90); err == nil {
		t.Error("an attribute outside the column list was accepted")
	}
	if _, err := store.QueryCatchmentValues(context.Background(), nil, "NPP_gm2", -180, -90, 180, 90); err == nil {
		t.Error("a request with no scenario was accepted")
	}
	if _, err := store.QueryCatchmentValues(context.Background(), []string{"a", "b", "c", "d"}, "NPP_gm2", -180, -90, 180, 90); err == nil {
		t.Error("a request for more series than the datapack has scenarios was accepted")
	}
}

func TestBuildIDIndexAddressesEveryCatchment(t *testing.T) {
	store := openValuesFixture(t, 50)

	values, err := store.QueryCatchmentValues(context.Background(), []string{"current"}, "NPP_gm2", -180, -90, 180, 90)
	if err != nil {
		t.Fatalf("QueryCatchmentValues: %v", err)
	}

	index := values.BuildIDIndex()
	for i, id := range values.IDs {
		if index[id] != i {
			t.Fatalf("id %d maps to position %d, expected %d", id, index[id], i)
		}
	}
}

// newStore opens a GpkgStore over a synthetic datapack using gpkgtest.Build.
func newStore(t *testing.T) *GpkgStore {
	t.Helper()

	dir := gpkgtest.Build(t, t.TempDir(), []gpkgtest.Catchment{
		{ID: 1000000001, Lat: 0, Long: 0, SizeDeg: 0.5, Current: gpkgtest.Float(10), Reference: gpkgtest.Float(1)},
		{ID: 1000000002, Lat: 0, Long: 1, SizeDeg: 0.5, Current: gpkgtest.Float(20), Reference: gpkgtest.Float(2)},
		// No current value: the real datapack has catchments with no data for
		// a given indicator, and the values query must leave them out rather
		// than shipping a zero that would paint as the domain minimum.
		{ID: 1000000003, Lat: 0, Long: 2, SizeDeg: 0.5, Current: nil, Reference: gpkgtest.Float(3)},
	}, 0, 100)

	store, err := NewGpkgStore(dir)
	if err != nil {
		t.Fatalf("NewGpkgStore: %v", err)
	}
	t.Cleanup(store.Close)
	return store
}

func TestQueryCatchmentValueArraysReturnsIDsAndValuesInBBox(t *testing.T) {
	store := newStore(t)

	// A bbox covering the first two catchments only.
	values, err := store.QueryCatchmentValueArrays(context.Background(), "current", gpkgtest.Attribute, -0.5, -0.5, 1.5, 0.5)
	if err != nil {
		t.Fatalf("QueryCatchmentValueArrays: %v", err)
	}

	if len(values.IDs) != len(values.Values) {
		t.Fatalf("ids and values must be index-aligned: %d ids, %d values", len(values.IDs), len(values.Values))
	}

	got := map[int64]float64{}
	for i, id := range values.IDs {
		got[id] = values.Values[i]
	}
	want := map[int64]float64{1000000001: 10, 1000000002: 20}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for id, v := range want {
		if got[id] != v {
			t.Errorf("catchment %d: got %v, want %v", id, got[id], v)
		}
	}
}

func TestQueryCatchmentValueArraysSkipsNullValues(t *testing.T) {
	store := newStore(t)

	values, err := store.QueryCatchmentValueArrays(context.Background(), "current", gpkgtest.Attribute, -5, -5, 5, 5)
	if err != nil {
		t.Fatalf("QueryCatchmentValueArrays: %v", err)
	}

	for _, id := range values.IDs {
		if id == 1000000003 {
			t.Fatalf("catchment with a NULL value was included; a missing value must stay missing "+
				"so the paint expression's coalesce decides how to render it (ids=%v)", values.IDs)
		}
	}
	if len(values.IDs) != 2 {
		t.Fatalf("expected the two valued catchments, got %v", values.IDs)
	}
}

func TestQueryCatchmentValueArraysRejectsUnknownAttribute(t *testing.T) {
	store := newStore(t)

	// The attribute name is interpolated into SQL, so an unvalidated one is an
	// injection point; the allow-list is loaded from scenario_current's columns.
	if _, err := store.QueryCatchmentValueArrays(context.Background(), "current", `x" FROM sqlite_master; --`, -5, -5, 5, 5); err == nil {
		t.Fatal("expected an error for an attribute that is not a known column")
	}
}
