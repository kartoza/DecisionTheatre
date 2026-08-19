package geodata

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"testing"
	"time"
)

// The measurements behind the sizing decisions in this package, against a real
// datapack rather than the synthetic one. A real datapack is several gigabytes
// and is not in a checkout, so these are skipped unless one is pointed at:
//
//	DT_DATAPACK_DIR=/path/to/data go test ./internal/geodata/ -run TestRealDatapack -v -timeout 30m
//
// They are the reason weightTableThreshold, aggregateColumnChunkSize and
// MaxDetailCatchments hold the values they do. Every number quoted in those
// comments came from here, and can be re-derived by running it.

func realDatapackStore(t *testing.T) *GpkgStore {
	t.Helper()
	dir := os.Getenv("DT_DATAPACK_DIR")
	if dir == "" {
		t.Skip("set DT_DATAPACK_DIR to a directory containing datapack.gpkg to run this")
	}
	if _, err := os.Stat(dir + "/datapack.gpkg"); err != nil {
		t.Skipf("no datapack.gpkg in %s: %v", dir, err)
	}
	store, err := NewGpkgStore(dir)
	if err != nil {
		t.Fatalf("NewGpkgStore: %v", err)
	}
	t.Cleanup(store.Close)
	return store
}

func realDatapackIDs(t *testing.T, s *GpkgStore, limit int) []string {
	t.Helper()
	query := `SELECT HYBAS_ID FROM catchments_lev12`
	if limit > 0 {
		query += fmt.Sprintf(" LIMIT %d", limit)
	}
	rows, err := s.db.Query(query)
	if err != nil {
		t.Fatalf("read catchment ids: %v", err)
	}
	defer rows.Close()

	var ids []string
	for rows.Next() {
		var raw interface{}
		if err := rows.Scan(&raw); err != nil {
			t.Fatalf("scan catchment id: %v", err)
		}
		ids = append(ids, normalizeCatchmentID(dbValueToString(raw)))
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read catchment ids: %v", err)
	}
	return ids
}

// TestRealDatapackWholeContinent is the case both issues were reported
// against: every catchment in the datapack, as the whole-of-Africa site.
//
// It asserts the answers are right - against an independent SQL aggregate -
// and reports the timings. Before the aggregation moved into SQL, whiskers for
// this site took 391 seconds and then failed to write the response at all.
func TestRealDatapackWholeContinent(t *testing.T) {
	s := realDatapackStore(t)
	ctx := context.Background()

	ids := realDatapackIDs(t, s, 0)
	t.Logf("catchments: %d", len(ids))

	areaStart := time.Now()
	weights, err := s.GetCatchmentAreasByIDs(ctx, ids)
	if err != nil {
		t.Fatalf("GetCatchmentAreasByIDs: %v", err)
	}
	t.Logf("GetCatchmentAreasByIDs: %v", time.Since(areaStart).Round(time.Millisecond))

	whiskerStart := time.Now()
	bounds, err := s.ComputeWhiskerBounds(ctx, weights)
	if err != nil {
		t.Fatalf("ComputeWhiskerBounds: %v", err)
	}
	t.Logf("ComputeWhiskerBounds: %v", time.Since(whiskerStart).Round(time.Millisecond))
	t.Logf("whiskers end to end (areas + bounds): %v", time.Since(areaStart).Round(time.Millisecond))
	if len(bounds.CurrentUpper) == 0 || len(bounds.ReferenceLower) == 0 {
		t.Errorf("whisker bounds came back empty for %d catchments: %+v", len(weights), bounds)
	}

	summaryStart := time.Now()
	agg, err := s.AggregateCatchmentIndicators(ctx, weights)
	if err != nil {
		t.Fatalf("AggregateCatchmentIndicators: %v", err)
	}
	t.Logf("AggregateCatchmentIndicators: %v (matched %d of %d)",
		time.Since(summaryStart).Round(time.Millisecond), agg.MatchedCount, agg.CatchmentCount)

	if len(agg.Current) == 0 {
		t.Fatal("summary came back with no attributes")
	}

	// The speed is only worth having if the arithmetic is right, so one
	// attribute is checked against a straightforward aggregate written the
	// obvious way, with no chunking, weight table or column batching in it.
	s.mu.RLock()
	column := s.columns[0]
	s.mu.RUnlock()

	var numerator, denominator sql.NullFloat64
	crossCheck := fmt.Sprintf(`
		SELECT SUM(c.SUB_AREA * s."%s"), SUM(CASE WHEN s."%s" IS NULL THEN 0 ELSE c.SUB_AREA END)
		FROM scenario_current s JOIN catchments_lev12 c ON c.HYBAS_ID_int = s.catchment_id_int`,
		column, column)
	if err := s.db.QueryRowContext(ctx, crossCheck).Scan(&numerator, &denominator); err != nil {
		t.Fatalf("cross-check query: %v", err)
	}
	want := numerator.Float64 / denominator.Float64
	got := agg.Current[column]
	if math.Abs(got-want) > math.Abs(want)*1e-9 {
		t.Errorf("%s: the aggregate gave %v, a direct SQL aggregate gives %v", column, got, want)
	}
}

// TestRealDatapackSmallSite guards the plan that nearly every real site takes.
// A site is normally a handful of catchments - Munywana is 11 - and that case
// must stay in the tens of milliseconds no matter what the continent-scale
// path needs.
func TestRealDatapackSmallSite(t *testing.T) {
	s := realDatapackStore(t)
	ctx := context.Background()

	weights, err := s.GetCatchmentAreasByIDs(ctx, realDatapackIDs(t, s, 11))
	if err != nil {
		t.Fatalf("GetCatchmentAreasByIDs: %v", err)
	}

	start := time.Now()
	if _, err := s.ComputeWhiskerBounds(ctx, weights); err != nil {
		t.Fatalf("ComputeWhiskerBounds: %v", err)
	}
	whiskers := time.Since(start)

	start = time.Now()
	if _, err := s.AggregateCatchmentIndicators(ctx, weights); err != nil {
		t.Fatalf("AggregateCatchmentIndicators: %v", err)
	}
	t.Logf("%d catchments: whiskers %v, summary %v",
		len(weights), whiskers.Round(time.Millisecond), time.Since(start).Round(time.Millisecond))

	if whiskers > 5*time.Second {
		t.Errorf("whiskers for %d catchments took %v; the small-site plan has regressed", len(weights), whiskers)
	}
}

// TestRealDatapackDetailResponseSize is where MaxDetailCatchments comes from:
// what a per-catchment response actually costs to produce and to send.
func TestRealDatapackDetailResponseSize(t *testing.T) {
	s := realDatapackStore(t)
	ctx := context.Background()
	ids := realDatapackIDs(t, s, MaxDetailCatchments)

	for _, count := range []int{100, 1000, MaxDetailCatchments} {
		if count > len(ids) {
			continue
		}
		queryStart := time.Now()
		got, err := s.GetCatchmentIndicatorsByIDs(ctx, ids[:count])
		if err != nil {
			t.Fatalf("%d catchments: %v", count, err)
		}
		queryTime := time.Since(queryStart)

		encodeStart := time.Now()
		body, err := json.Marshal(got)
		if err != nil {
			t.Fatalf("encode %d catchments: %v", count, err)
		}
		t.Logf("%6d catchments: %8.1f MB, query %v, encode %v (%.1f KB each)",
			count, float64(len(body))/(1024*1024), queryTime.Round(time.Millisecond),
			time.Since(encodeStart).Round(time.Millisecond), float64(len(body))/float64(count)/1024)
	}
}
