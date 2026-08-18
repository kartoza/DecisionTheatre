package geodata

import (
	"database/sql"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
	"time"
)

// ScenarioValues holds one scenario's attribute values, aligned index-for-index
// with the CatchmentValues.IDs they belong to.
//
// Values and Valid are parallel flat slices rather than a []*float64 because a
// full-dataset query returns ~148k rows: pointers would mean one heap
// allocation per value, where this is two allocations for the whole series. A
// false Valid marshals as JSON null, which is needed because the per-scenario
// NULL sets need not agree and a single shared ID array has to be able to say
// "this scenario has no value here".
type ScenarioValues struct {
	Values []float64
	Valid  []bool
}

// clone returns an independent copy, so two scenarios that happened to read the
// same table can be mutated separately (see the fan-out in QueryCatchmentValues).
func (v *ScenarioValues) clone() *ScenarioValues {
	values := make([]float64, len(v.Values))
	copy(values, v.Values)
	valid := make([]bool, len(v.Valid))
	copy(valid, v.Valid)
	return &ScenarioValues{Values: values, Valid: valid}
}

// append records one value, or a JSON null when valid is false.
func (v *ScenarioValues) append(value float64, valid bool) {
	v.Values = append(v.Values, value)
	v.Valid = append(v.Valid, valid)
}

// Set overwrites the value at index i, marking it present. Used to overlay
// site-specific ideal values onto a queried series.
func (v *ScenarioValues) Set(i int, value float64) {
	if v == nil || i < 0 || i >= len(v.Values) {
		return
	}
	v.Values[i] = value
	v.Valid[i] = true
}

// MarshalJSON writes the series as a flat JSON array of numbers and nulls.
//
// Hand-rolled rather than left to encoding/json because this is the hot path
// the columnar format exists to make cheap: reflection over ~148k float64s,
// twice per stats refresh, is a measurable share of the response time. The
// output is written with strconv's shortest round-trip formatting, so every
// number parses back to bit-identical float64 - statistics computed from it
// are unchanged, only the bytes on the wire are fewer.
//
// Non-finite values marshal as null rather than erroring the whole response.
// SQLite can hold an Inf in a REAL column and encoding/json would reject it;
// a single unrepresentable catchment must not cost the caller its statistics.
func (v ScenarioValues) MarshalJSON() ([]byte, error) {
	if len(v.Values) != len(v.Valid) {
		return nil, fmt.Errorf("scenario values misaligned: %d values, %d validity flags", len(v.Values), len(v.Valid))
	}

	// ~12 bytes per number is typical for the indicator values in the datapack
	// (a handful of significant digits plus a separator); growing from a close
	// estimate beats growing from nothing.
	buf := make([]byte, 0, len(v.Values)*12+2)
	buf = append(buf, '[')
	for i, val := range v.Values {
		if i > 0 {
			buf = append(buf, ',')
		}
		if !v.Valid[i] || math.IsNaN(val) || math.IsInf(val, 0) {
			buf = append(buf, "null"...)
			continue
		}
		buf = strconv.AppendFloat(buf, val, 'g', -1, 64)
	}
	buf = append(buf, ']')
	return buf, nil
}

// CatchmentValues is the columnar result of a values-only query: one shared
// array of catchment IDs plus one parallel array of values per requested
// scenario.
//
// The GeoJSON FeatureCollection this replaced spent 114 bytes per catchment to
// carry an int64 and a float64, and repeated the literal string null once per
// catchment for a geometry no caller ever read. Callers of this query are
// computing statistics, not rendering, so the feature wrapper bought nothing.
//
// Measured on data/datapack.gpkg, NPP_gm2, full domain (141,897 catchments have
// a value for it), against what the two concurrent full-domain stats requests
// used to cost between them. gzip is the level 5 this server applies (see
// internal/server/compress.go); the parse times are node 22 / V8, warm, median
// of seven:
//
//	                       raw          gzip5        JSON.parse
//	before, two requests   29,380,768   2,901,154    216.8 ms
//	after, one request      3,129,840     983,966     20.6 ms
//	                            9.4x         2.9x       10.5x
//
// The compressed saving is much smaller than the raw one, as it must be:
// deflate is very good at 147,837 repetitions of the same wrapper. The parse
// time is the number that matters on the older hardware this was reported
// from, and it does not benefit from compression at all.
type CatchmentValues struct {
	// Attribute is the column the values were read from.
	Attribute string
	// IDs holds each catchment's HYBAS_ID. Every series is aligned to it.
	IDs []int64
	// Scenarios lists the requested scenario names in request order, and is
	// the intended iteration order for Series.
	Scenarios []string
	// Series maps a scenario name to that scenario's values.
	Series map[string]*ScenarioValues
}

// BuildIDIndex returns a HYBAS_ID to array-position lookup, for callers that
// need to overlay values onto many catchments at once.
func (cv *CatchmentValues) BuildIDIndex() map[int64]int {
	index := make(map[int64]int, len(cv.IDs))
	for i, id := range cv.IDs {
		index[id] = i
	}
	return index
}

// maxValueScenarios caps how many series one request may ask for. Three is the
// number of distinct scenarios the datapack has; the cap exists so a caller
// cannot turn one request into an unbounded number of column reads.
const maxValueScenarios = 3

// QueryCatchmentValues returns every catchment's attribute value within a
// bounding box, with no geometry and no LIMIT, for one or more scenarios at
// once. It exists for statistics (min/max/mean/count) where accuracy across the
// true full dataset matters and per-catchment HYBAS_ID is required (e.g.
// filtering to a site's catchments), unlike QueryCatchments' render paths,
// which trade some accuracy/detail for a bounded, renderable feature count.
//
// Multiple scenarios are served in one pass because the two callers that use
// this - full-domain stats and site stats - each want exactly the same extent
// and attribute for the left and right scenario of a comparison, and fired two
// concurrent requests for them. One query means one bbox scan and, on the wire,
// one copy of the ID array instead of two.
//
// Scenarios that resolve to the same table (reference and future both read
// scenario_reference) are read once and fanned out, so asking for both costs
// nothing extra.
func (s *GpkgStore) QueryCatchmentValues(scenarios []string, attribute string, minx, miny, maxx, maxy float64) (*CatchmentValues, error) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] QueryCatchmentValues scenarios=%s attribute=%s bbox=[%.2f,%.2f,%.2f,%.2f] duration_ms=%d",
			strings.Join(scenarios, "+"), attribute, minx, miny, maxx, maxy, time.Since(start).Milliseconds())
	}()

	if len(scenarios) == 0 {
		return nil, fmt.Errorf("no scenario requested")
	}
	if len(scenarios) > maxValueScenarios {
		return nil, fmt.Errorf("too many scenarios requested: %d (max %d)", len(scenarios), maxValueScenarios)
	}
	if !s.isValidColumn(attribute) {
		return nil, fmt.Errorf("invalid attribute: %s", attribute)
	}

	// Map each scenario onto the table it reads, collapsing duplicates so the
	// query selects each column once.
	tables := make([]string, 0, len(scenarios))
	columnForScenario := make(map[string]int, len(scenarios))
	for _, scenario := range scenarios {
		table := resolveScenarioTable(scenario)
		column := -1
		for i, existing := range tables {
			if existing == table {
				column = i
				break
			}
		}
		if column < 0 {
			column = len(tables)
			tables = append(tables, table)
		}
		columnForScenario[scenario] = column
	}

	// LEFT JOIN, not INNER: with more than one scenario a catchment present in
	// only one of the tables must still appear, carrying a null for the other.
	// For a single scenario SQLite rewrites this back to an inner join, since
	// the WHERE term below is false when the right-hand row is all NULLs - so
	// the one-scenario plan is unchanged from when this query was inner-joined.
	var joins, selects, notNull strings.Builder
	for i, table := range tables {
		alias := "t" + strconv.Itoa(i)
		fmt.Fprintf(&selects, `, %s."%s"`, alias, attribute)
		fmt.Fprintf(&joins, "\n\t\tLEFT JOIN %s %s ON c.HYBAS_ID_int = %s.catchment_id_int", table, alias, alias)
		if i > 0 {
			notNull.WriteString(" OR ")
		}
		fmt.Fprintf(&notNull, `%s."%s" IS NOT NULL`, alias, attribute)
	}

	query := fmt.Sprintf(`
		SELECT c.HYBAS_ID%s
		FROM catchments_lev12 c%s
		WHERE (%s)
		  AND c.fid IN (
			SELECT id FROM rtree_catchments_lev12_geom
			WHERE minx <= ? AND maxx >= ? AND miny <= ? AND maxy >= ?
		  )
	`, selects.String(), joins.String(), notNull.String())

	rows, err := s.db.Query(query, maxx, minx, maxy, miny)
	if err != nil {
		return nil, fmt.Errorf("query failed: %w", err)
	}
	defer rows.Close()

	// One series per distinct table; scenarios sharing a table share a series
	// until the fan-out below, which is why these are indexed by column.
	columns := make([]*ScenarioValues, len(tables))
	for i := range columns {
		columns[i] = &ScenarioValues{}
	}

	ids := []int64{}
	// HYBAS_ID is read as float64 to match the rest of this file: the column is
	// TEXT in some datapacks and REAL in others, and the values (10-digit basin
	// identifiers) are well inside float64's exact integer range.
	var id float64
	scanned := make([]sql.NullFloat64, len(tables))
	dest := make([]interface{}, 0, len(tables)+1)
	dest = append(dest, &id)
	for i := range scanned {
		dest = append(dest, &scanned[i])
	}

	for rows.Next() {
		if err := rows.Scan(dest...); err != nil {
			log.Printf("Warning: failed to scan row: %v", err)
			continue
		}
		ids = append(ids, int64(id))
		for i, value := range scanned {
			columns[i].append(value.Float64, value.Valid)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("row iteration failed: %w", err)
	}

	// Fan the shared columns back out to scenario names. The first scenario to
	// claim a column takes it; a second one (reference and future both read
	// scenario_reference) gets a copy, because the caller may overlay a site's
	// ideal values onto "future" and must not thereby edit "reference".
	series := make(map[string]*ScenarioValues, len(scenarios))
	claimed := make([]bool, len(columns))
	for _, scenario := range scenarios {
		column := columnForScenario[scenario]
		if claimed[column] {
			series[scenario] = columns[column].clone()
			continue
		}
		claimed[column] = true
		series[scenario] = columns[column]
	}

	return &CatchmentValues{
		Attribute: attribute,
		IDs:       ids,
		Scenarios: scenarios,
		Series:    series,
	}, nil
}
