package geodata

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strconv"
	"strings"
	"testing"

	"github.com/kartoza/decision-theatre/internal/gpkgtest"
)

// The synthetic datapack: three catchments whose areas are deliberately
// different, so an area-weighted mean is distinguishable from a plain one.
//
//	id 1000000001  area 4    current 10  reference 1
//	id 1000000002  area 1    current 20  reference 2
//	id 1000000003  area 1    current -   reference 3
func newAggregateTestDir(t *testing.T) string {
	t.Helper()
	return gpkgtest.Build(t, t.TempDir(), []gpkgtest.Catchment{
		{ID: 1000000001, Lat: 0, Long: 0, SizeDeg: 2, Current: gpkgtest.Float(10), Reference: gpkgtest.Float(1)},
		{ID: 1000000002, Lat: 0, Long: 4, SizeDeg: 1, Current: gpkgtest.Float(20), Reference: gpkgtest.Float(2)},
		{ID: 1000000003, Lat: 0, Long: 8, SizeDeg: 1, Current: nil, Reference: gpkgtest.Float(3)},
	}, 0, 100)
}

func openStore(t *testing.T, dir string) *GpkgStore {
	t.Helper()
	store, err := NewGpkgStore(dir)
	if err != nil {
		t.Fatalf("NewGpkgStore: %v", err)
	}
	t.Cleanup(store.Close)
	return store
}

// execOnDatapack runs DDL against the synthetic datapack before the store
// opens it. The store opens the file immutable and read-only, so any doctoring
// has to happen first.
func execOnDatapack(t *testing.T, dir string, statements ...string) {
	t.Helper()
	db, err := sql.Open("sqlite3", dir+"/datapack.gpkg")
	if err != nil {
		t.Fatalf("open datapack for doctoring: %v", err)
	}
	defer db.Close()
	for _, stmt := range statements {
		if _, err := db.Exec(stmt); err != nil {
			t.Fatalf("exec %q: %v", stmt, err)
		}
	}
}

// breakScenarioTable renames the one indicator column out of a scenario table.
// The store loads its column list from scenario_current, so a query that
// interpolates that list into a SELECT against the doctored table cannot
// return what it asked for - injected the same way a datapack schema drift or
// a half-migrated file would produce it.
//
// It surfaces as a scan failure rather than a prepare failure because SQLite
// resolves a double-quoted name it does not recognise as a string literal
// rather than rejecting it, so the row comes back carrying the column's own
// name where its value should be. That is precisely the kind of database
// failure that used to be skipped a row at a time and reported as success.
func breakScenarioTable(t *testing.T, dir, tableName string) {
	t.Helper()
	execOnDatapack(t, dir, fmt.Sprintf(
		`ALTER TABLE %s RENAME COLUMN "%s" TO "gone"`, tableName, gpkgtest.Attribute))
}

// removeScenarioTable takes a scenario table out of the datapack altogether,
// which is what a truncated or wrongly-built datapack looks like. The store
// cannot resolve an id column for a table that is not there - the other
// failure that used to be logged and answered with an empty result.
func removeScenarioTable(t *testing.T, dir, tableName string) {
	t.Helper()
	execOnDatapack(t, dir, fmt.Sprintf(`DROP TABLE %s`, tableName))
}

func testIDs(t *testing.T, count int) []string {
	t.Helper()
	ids := make([]string, 0, count)
	ids = append(ids, "1000000001", "1000000002", "1000000003")
	// Ids that match nothing, purely to push the list past SQLite's limits.
	for i := len(ids); i < count; i++ {
		ids = append(ids, strconv.Itoa(2000000000+i))
	}
	return ids
}

func weightsFor(ids []string, area float64) []CatchmentIndicators {
	weights := make([]CatchmentIndicators, len(ids))
	for i, id := range ids {
		weights[i] = CatchmentIndicators{ID: id, AreaKm2: area, AOIFraction: 1}
	}
	return weights
}

// TestCatchmentIDChunkSizeRespectsSQLiteVariableLimit pins the two numbers
// every id-list query in this package is built around, against the driver
// actually linked in rather than against the documentation.
//
// If a future SQLite build lowers SQLITE_MAX_VARIABLE_NUMBER, this fails here
// - loudly, in a unit test - rather than in production as an empty map at some
// site size nobody happened to try.
func TestCatchmentIDChunkSizeRespectsSQLiteVariableLimit(t *testing.T) {
	if catchmentIDChunkSize*2 > sqliteMaxVariables {
		t.Fatalf("catchmentIDChunkSize %d binds %d variables in the aggregate's VALUES clause, over the %d limit",
			catchmentIDChunkSize, catchmentIDChunkSize*2, sqliteMaxVariables)
	}

	db, err := sql.Open("sqlite3", ":memory:")
	if err != nil {
		t.Fatalf("open in-memory database: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`CREATE TABLE t (id INTEGER)`); err != nil {
		t.Fatalf("create table: %v", err)
	}

	prepares := func(n int) error {
		args := make([]interface{}, n)
		for i := range args {
			args[i] = i
		}
		rows, err := db.Query(
			fmt.Sprintf(`SELECT id FROM t WHERE id IN (%s)`, strings.TrimSuffix(strings.Repeat("?,", n), ",")), args...)
		if err != nil {
			return err
		}
		return rows.Close()
	}

	if err := prepares(sqliteMaxVariables); err != nil {
		t.Fatalf("%d bind variables should prepare, got %v", sqliteMaxVariables, err)
	}
	if err := prepares(sqliteMaxVariables + 1); err == nil {
		t.Fatalf("%d bind variables prepared; sqliteMaxVariables is stale and every chunk size derived from it is wrong",
			sqliteMaxVariables+1)
	}
}

// TestGetCatchmentIndicatorsByIDsReportsQueryFailure is the test issue #63
// exists for.
//
// A failed query used to be logged and turned into an empty result with a nil
// error. That reached the browser as HTTP 200 and `[]`, which is exactly what
// a site whose catchments genuinely have no data looks like - so a broken
// database rendered as an empty table, an empty chart and a dial reading
// nothing, with no indication anywhere that anything had gone wrong.
func TestGetCatchmentIndicatorsByIDsReportsQueryFailure(t *testing.T) {
	dir := newAggregateTestDir(t)
	breakScenarioTable(t, dir, "scenario_reference")
	store := openStore(t, dir)

	got, err := store.GetCatchmentIndicatorsByIDs(context.Background(),
		[]string{"1000000001", "1000000002"})
	if err == nil {
		t.Fatalf("a failed query returned success with %d catchments; "+
			"an empty success is indistinguishable from a site with no data", len(got))
	}
	if got != nil {
		t.Errorf("returned %d catchments alongside the error; partial data invites the caller to render it", len(got))
	}
}

// The other way the same request fails: a scenario table that is not in the
// datapack at all. The store cannot resolve an id column for it, which used to
// be logged and answered with an empty result for that scenario - so a
// datapack missing half its data looked exactly like a site with half its data
// missing.
func TestGetCatchmentIndicatorsByIDsReportsAnAbsentScenarioTable(t *testing.T) {
	dir := newAggregateTestDir(t)
	removeScenarioTable(t, dir, "scenario_reference")
	store := openStore(t, dir)

	got, err := store.GetCatchmentIndicatorsByIDs(context.Background(), []string{"1000000001"})
	if err == nil {
		t.Fatalf("a missing scenario table returned success with %d catchments", len(got))
	}
}

// The same, one layer down: whatever the aggregate cannot compute it must not
// report as an aggregate of nothing.
func TestAggregateCatchmentIndicatorsReportsQueryFailure(t *testing.T) {
	dir := newAggregateTestDir(t)
	breakScenarioTable(t, dir, "scenario_current")
	store := openStore(t, dir)

	got, err := store.AggregateCatchmentIndicators(context.Background(),
		weightsFor([]string{"1000000001", "1000000002"}, 1))
	if err == nil {
		t.Fatalf("a failed aggregate returned success: %+v", got)
	}
	if got != nil {
		t.Errorf("returned a summary alongside the error: %+v", got)
	}
}

func TestComputeWhiskerBoundsReportsQueryFailure(t *testing.T) {
	dir := newAggregateTestDir(t)
	execOnDatapack(t, dir,
		fmt.Sprintf(`CREATE TABLE scenario_reference_lower (catchment_id_int INTEGER, "%s" REAL)`, gpkgtest.Attribute),
		fmt.Sprintf(`CREATE TABLE scenario_reference_upper (catchment_id_int INTEGER, "%s" REAL)`, gpkgtest.Attribute),
		fmt.Sprintf(`CREATE TABLE scenario_current_lower (catchment_id_int INTEGER, "%s" REAL)`, gpkgtest.Attribute),
		// The fourth table exists but has lost the indicator column, so its
		// query fails while the other three succeed.
		`CREATE TABLE scenario_current_upper (catchment_id_int INTEGER, "gone" REAL)`)
	store := openStore(t, dir)

	bounds, err := store.ComputeWhiskerBounds(context.Background(),
		weightsFor([]string{"1000000001"}, 1))
	if err == nil {
		t.Fatalf("a failed whisker query returned success: %+v", bounds)
	}
}

// A datapack built without the whisker tables has no whiskers. That is a fact
// about the data, not a fault, and must stay distinguishable from a whisker
// table that failed to read - which is why absence is reported as empty bounds
// and failure as an error.
func TestComputeWhiskerBoundsTreatsAbsentTablesAsNoWhiskers(t *testing.T) {
	store := openStore(t, newAggregateTestDir(t))

	bounds, err := store.ComputeWhiskerBounds(context.Background(),
		weightsFor([]string{"1000000001"}, 1))
	if err != nil {
		t.Fatalf("a datapack without whisker tables should report no whiskers, not an error: %v", err)
	}
	if bounds.ReferenceLower != nil || bounds.CurrentUpper != nil {
		t.Errorf("expected absent bounds, got %+v", bounds)
	}
}

// TestAggregateCatchmentIndicatorsWeightsByArea checks the arithmetic the
// whole aggregate exists to do, including the part that is easy to get wrong:
// the denominator is per-attribute, counting only catchments that actually
// have a value, so a catchment missing this indicator does not drag the mean
// toward zero.
func TestAggregateCatchmentIndicatorsWeightsByArea(t *testing.T) {
	store := openStore(t, newAggregateTestDir(t))

	// Areas come from the datapack (SizeDeg squared): 4, 1 and 1.
	got, err := store.AggregateCatchmentIndicators(context.Background(),
		[]CatchmentIndicators{
			{ID: "1000000001", AreaKm2: 4, AOIFraction: 1},
			{ID: "1000000002", AreaKm2: 1, AOIFraction: 1},
			{ID: "1000000003", AreaKm2: 1, AOIFraction: 1},
		})
	if err != nil {
		t.Fatalf("AggregateCatchmentIndicators: %v", err)
	}

	// current: catchment 3 has no value, so it is excluded from both sums.
	//   (10*4 + 20*1) / (4 + 1) = 12
	if v := got.Current[gpkgtest.Attribute]; math.Abs(v-12) > 1e-9 {
		t.Errorf("current mean %v, want 12 - a catchment with no value must leave the denominator alone", v)
	}
	// reference: all three have values.
	//   (1*4 + 2*1 + 3*1) / (4 + 1 + 1) = 1.5
	if v := got.Reference[gpkgtest.Attribute]; math.Abs(v-1.5) > 1e-9 {
		t.Errorf("reference mean %v, want 1.5", v)
	}
	if got.CatchmentCount != 3 || got.MatchedCount != 3 {
		t.Errorf("counts: catchments=%d matched=%d, want 3 and 3", got.CatchmentCount, got.MatchedCount)
	}
	if math.Abs(got.TotalAreaKm2-6) > 1e-9 {
		t.Errorf("total area %v, want 6", got.TotalAreaKm2)
	}
}

// The AOI fraction has to reach the weighting, or a site that clips its
// catchments produces the same numbers as one that contains them whole.
func TestAggregateCatchmentIndicatorsAppliesAOIFraction(t *testing.T) {
	store := openStore(t, newAggregateTestDir(t))

	got, err := store.AggregateCatchmentIndicators(context.Background(),
		[]CatchmentIndicators{
			{ID: "1000000001", AreaKm2: 4, AOIFraction: 0.25}, // effective weight 1
			{ID: "1000000002", AreaKm2: 1, AOIFraction: 1},    // effective weight 1
		})
	if err != nil {
		t.Fatalf("AggregateCatchmentIndicators: %v", err)
	}
	// (10*1 + 20*1) / 2 = 15, rather than the 12 the unclipped areas give.
	if v := got.Current[gpkgtest.Attribute]; math.Abs(v-15) > 1e-9 {
		t.Errorf("current mean %v, want 15 - the AOI fraction is not reaching the weights", v)
	}
}

// TestAggregateCatchmentIndicatorsHandlesMoreIDsThanSQLiteVariables is the
// #140 regression test: the whole-of-Africa case, at the scale that broke it.
//
// A single IN clause over this many ids cannot be prepared at all, so before
// the id list was chunked the query failed - and, because the failure was
// swallowed, the four views of that site drew an empty table, an empty chart
// and a dial with no needle.
func TestAggregateCatchmentIndicatorsHandlesMoreIDsThanSQLiteVariables(t *testing.T) {
	store := openStore(t, newAggregateTestDir(t))

	ids := testIDs(t, sqliteMaxVariables+5000)
	weights := make([]CatchmentIndicators, len(ids))
	for i, id := range ids {
		area := 1.0
		if id == "1000000001" {
			area = 4
		}
		weights[i] = CatchmentIndicators{ID: id, AreaKm2: area, AOIFraction: 1}
	}

	got, err := store.AggregateCatchmentIndicators(context.Background(), weights)
	if err != nil {
		t.Fatalf("aggregating %d ids: %v", len(ids), err)
	}
	// Only the three real catchments contribute; the padding ids match no row,
	// so the answer is the same as the small case.
	if v := got.Current[gpkgtest.Attribute]; math.Abs(v-12) > 1e-9 {
		t.Errorf("current mean %v, want 12", v)
	}
	if got.MatchedCount != 3 {
		t.Errorf("matched %d catchments, want 3", got.MatchedCount)
	}
	if got.CatchmentCount != len(ids) {
		t.Errorf("catchment count %d, want %d", got.CatchmentCount, len(ids))
	}
}

func TestGetCatchmentAreasByIDsHandlesMoreIDsThanSQLiteVariables(t *testing.T) {
	store := openStore(t, newAggregateTestDir(t))

	ids := testIDs(t, sqliteMaxVariables+5000)
	got, err := store.GetCatchmentAreasByIDs(context.Background(), ids)
	if err != nil {
		t.Fatalf("fetching areas for %d ids: %v", len(ids), err)
	}
	if len(got) != 3 {
		t.Fatalf("got %d catchments, want the 3 real ones", len(got))
	}
	for _, c := range got {
		if c.AreaKm2 <= 0 {
			t.Errorf("catchment %s came back with no area", c.ID)
		}
	}
}

// TestGetCatchmentIndicatorsByIDsRefusesUnboundedRequest covers the other half
// of the bound. Chunking alone would have made the Africa case answerable and
// roughly 5 GB, which is a worse bug than the blank view it replaced.
func TestGetCatchmentIndicatorsByIDsRefusesUnboundedRequest(t *testing.T) {
	store := openStore(t, newAggregateTestDir(t))

	got, err := store.GetCatchmentIndicatorsByIDs(context.Background(),
		testIDs(t, MaxDetailCatchments+1))
	if !errors.Is(err, ErrTooManyCatchments) {
		t.Fatalf("got (%d catchments, %v), want ErrTooManyCatchments", len(got), err)
	}
	if !strings.Contains(err.Error(), strconv.Itoa(MaxDetailCatchments)) {
		t.Errorf("the error should name the limit so a caller can act on it: %v", err)
	}

	// Exactly at the limit is served, so the boundary is where it says it is.
	if _, err := store.GetCatchmentIndicatorsByIDs(context.Background(),
		testIDs(t, MaxDetailCatchments)); err != nil {
		t.Fatalf("a request at exactly the limit was refused: %v", err)
	}
}

// TestGridGeometryCacheFailureIsReportedNotDrawnAsEmpty covers the third shape
// of the same defect, in the one place where it outlived the request.
//
// The grid geometry cache is built once in the background and then serves
// every aggregated choropleth. Its row scan never checked rows.Err, so a read
// that failed part-way published whatever had been dissolved so far and marked
// every tier ready - a partial continent, cached and presented as a complete
// one, for the life of the process. And because a sync.Once guarded the build,
// nothing could ever try again.
func TestGridGeometryCacheFailureIsReportedNotDrawnAsEmpty(t *testing.T) {
	dir := newAggregateTestDir(t)
	// Without the geometry column the build's query cannot be prepared, which
	// is a database failure arriving exactly where a corrupt page would.
	execOnDatapack(t, dir, `ALTER TABLE catchments_lev12 DROP COLUMN geojson`)
	store := openStore(t, dir)

	rows := []gridRow{{lat: 0, long: 0, area: 1, value: sql.NullFloat64{Float64: 5, Valid: true}}}
	fc, err := store.queryCatchmentsGridAggregated(context.Background(), gpkgtest.Attribute, rows)
	if err == nil {
		features := 0
		if fc != nil {
			features = len(fc.Features)
		}
		t.Fatalf("a failed cache build returned success with %d features; "+
			"a blank map presented as an accurate one is the bug", features)
	}

	store.mu.RLock()
	cached := len(store.gridGeometryCache)
	building := store.gridGeometryBuilding
	store.mu.RUnlock()

	if cached != 0 {
		t.Errorf("a failed build published %d tiers; a partial cache renders as a continent with "+
			"holes in it and reports success", cached)
	}
	// The build is no longer marked in flight, so the next request starts a
	// fresh attempt rather than inheriting the failure forever.
	if building {
		t.Error("a failed build left itself marked as running; nothing would ever retry it")
	}
}

// A site boundary that cannot be read used to produce no fractions and no
// error, leaving every catchment weighted at its 1.0 default - so the caller
// aggregated as though the site covered each of its catchments entirely, and
// got numbers that were quietly wrong rather than an error it could report.
func TestApplyAOIFractionsReportsUnreadableSiteGeometry(t *testing.T) {
	store := openStore(t, newAggregateTestDir(t))

	catchments := []CatchmentIndicators{{ID: "1000000001", AreaKm2: 4, AOIFraction: 1}}
	err := store.ApplyAOIFractions(context.Background(), catchments,
		[]byte(`{"type":"Polygon","coordinates":"not coordinates"}`))
	if err == nil {
		t.Fatal("an unreadable site boundary was accepted; the fractions it should have produced " +
			"are the weights every aggregate for this site is computed from")
	}
}

// TestBothAggregatePlansAgree is the guard on there being two of them.
//
// A small catchment set is inlined into the statement; a large one is
// materialised into a TEMP table so SQLite scans the scenario table once
// instead of chasing a random row fetch per catchment. That second plan is
// 36x faster on the real datapack at continent scale, which is exactly the
// kind of win that tempts one into not checking it computes the same number.
func TestBothAggregatePlansAgree(t *testing.T) {
	store := openStore(t, newAggregateTestDir(t))
	ctx := context.Background()

	w := newCatchmentWeights([]CatchmentIndicators{
		{ID: "1000000001", AreaKm2: 4, AOIFraction: 1},
		{ID: "1000000002", AreaKm2: 1, AOIFraction: 0.5},
		{ID: "1000000003", AreaKm2: 1, AOIFraction: 1},
	})

	store.mu.RLock()
	columns := store.columns
	store.mu.RUnlock()

	for _, tableName := range []string{"scenario_current", "scenario_reference"} {
		idColumn, err := store.resolveScenarioIDColumn(ctx, store.db, tableName)
		if err != nil {
			t.Fatalf("resolve id column: %v", err)
		}

		inline := newWeightedTotals(len(columns))
		if err := store.aggregateViaValuesClause(ctx, tableName, idColumn, w, columns, inline); err != nil {
			t.Fatalf("inline plan: %v", err)
		}

		// The synthetic set is far below weightTableThreshold, so the
		// materialised plan is asked for directly rather than waiting for a
		// continent to test it.
		ws, err := store.newWeightSet(ctx, w, true)
		if err != nil {
			t.Fatalf("weight set: %v", err)
		}
		if !ws.materialised() {
			t.Fatal("weight set was not materialised")
		}

		materialisedTotals := newWeightedTotals(len(columns))
		err = store.aggregateViaWeightTable(ctx, tableName, idColumn, ws, columns, materialisedTotals)
		ws.close()
		if err != nil {
			t.Fatalf("materialised plan: %v", err)
		}

		if inline.matched != materialisedTotals.matched {
			t.Errorf("%s: inline matched %d rows, materialised matched %d",
				tableName, inline.matched, materialisedTotals.matched)
		}
		inlineMean, materialisedMean := inline.mean(), materialisedTotals.mean()
		if len(inlineMean) != len(materialisedMean) {
			t.Fatalf("%s: inline produced %d attributes, materialised %d",
				tableName, len(inlineMean), len(materialisedMean))
		}
		for col, want := range inlineMean {
			got, ok := materialisedMean[col]
			if !ok {
				t.Errorf("%s: materialised plan lost attribute %s", tableName, col)
				continue
			}
			if math.Abs(got-want) > 1e-12 {
				t.Errorf("%s attribute %s: inline %v, materialised %v - the two plans must agree",
					tableName, col, want, got)
			}
		}
	}
}

// TestMaterialisedAggregateScansTheScenarioTable pins the query plan, because
// the plan is the entire performance story of this file and nothing else in
// the test suite would notice it changing.
//
// Measured against the real datapack at 147,837 catchments, one whisker table
// takes about 7 seconds when SQLite scans the scenario table and probes the
// weights per row, and over 200 seconds when it runs the join the other way
// round and fetches one random row per catchment instead. Both plans return
// the same numbers, so only this assertion stands between the fast one and a
// silent return to a six-minute request.
func TestMaterialisedAggregateScansTheScenarioTable(t *testing.T) {
	store := openStore(t, newAggregateTestDir(t))
	ctx := context.Background()

	w := newCatchmentWeights([]CatchmentIndicators{
		{ID: "1000000001", AreaKm2: 4, AOIFraction: 1},
		{ID: "1000000002", AreaKm2: 1, AOIFraction: 1},
	})

	conn, err := store.db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := store.populateWeightTable(ctx, conn, w); err != nil {
		t.Fatalf("populate weight table: %v", err)
	}

	query := fmt.Sprintf(
		`EXPLAIN QUERY PLAN SELECT %s FROM scenario_current s CROSS JOIN %s w ON s.catchment_id_int = w.cid`,
		aggregateExpressions([]string{gpkgtest.Attribute}), weightTableName)
	rows, err := conn.QueryContext(ctx, query)
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	defer rows.Close()

	var plan []string
	for rows.Next() {
		var id, parent, notUsed int
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatalf("scan plan: %v", err)
		}
		plan = append(plan, detail)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("read plan: %v", err)
	}
	if len(plan) == 0 {
		t.Fatal("no query plan returned")
	}

	// The scenario table must be the outer loop, scanned once...
	if !strings.HasPrefix(plan[0], "SCAN s") {
		t.Errorf("outer loop is %q, want a scan of the scenario table; "+
			"driving the join from the weights means one random row fetch per catchment: %v", plan[0], plan)
	}
	// ...and the weights must be probed by rowid, not scanned per row, which
	// would make the whole thing quadratic.
	if len(plan) < 2 || !strings.Contains(plan[1], "SEARCH w") {
		t.Errorf("inner loop is %q, want a keyed search of the weight table: %v", plan[len(plan)-1], plan)
	}
}

// TestBothAreaLookupsAgree covers the other place where one query grew two
// plans. Above weightTableThreshold the areas are read by scanning
// catchments_lev12 against a materialised id set rather than looking each id
// up through the index - about 3s instead of 30s for a continent, because each
// index lookup is a random fetch of a row carrying a geometry blob. The two
// routes must return the same catchments with the same areas.
func TestBothAreaLookupsAgree(t *testing.T) {
	store := openStore(t, newAggregateTestDir(t))
	ctx := context.Background()
	ids := []string{"1000000001", "1000000002", "1000000003"}

	batched, err := store.GetCatchmentAreasByIDs(ctx, ids)
	if err != nil {
		t.Fatalf("batched lookup: %v", err)
	}
	scanned, err := store.catchmentAreasByScan(ctx, ids)
	if err != nil {
		t.Fatalf("scan lookup: %v", err)
	}
	if scanned == nil {
		t.Fatal("the scan route declined a set of integer ids")
	}

	if len(batched) != len(scanned) {
		t.Fatalf("batched returned %d catchments, scan returned %d", len(batched), len(scanned))
	}

	// Order is not part of either route's contract - the scan returns table
	// order - so they are compared as sets.
	want := make(map[string]float64, len(batched))
	for _, c := range batched {
		want[c.ID] = c.AreaKm2
	}
	for _, c := range scanned {
		area, ok := want[c.ID]
		if !ok {
			t.Errorf("scan returned catchment %s that the batched lookup did not", c.ID)
			continue
		}
		if area != c.AreaKm2 {
			t.Errorf("catchment %s: batched area %v, scanned area %v", c.ID, area, c.AreaKm2)
		}
		if c.AOIFraction != 1 {
			t.Errorf("catchment %s: scan route left AOIFraction at %v, want the 1.0 default", c.ID, c.AOIFraction)
		}
	}
}

// TestCatchmentIDsParseInEverySpellingTheDatapackUses guards the gate on the
// fast query plans. HYBAS_ID is a REAL column, so the same catchment id
// legitimately arrives spelled three different ways, and only an integer
// spelling reaches the plan that scans once instead of fetching per catchment.
// An id list containing one exponent-formatted value used to take the whole
// request down to the slow plan silently.
func TestCatchmentIDsParseInEverySpellingTheDatapackUses(t *testing.T) {
	for _, spelling := range []string{"1121879850", "1121879850.0", "1.12187985e+09"} {
		got, ok := parseCatchmentID(spelling)
		if !ok {
			t.Errorf("%q was rejected; it is a catchment id", spelling)
			continue
		}
		if got != 1121879850 {
			t.Errorf("%q parsed as %d, want 1121879850", spelling, got)
		}
	}

	// Things that are not catchment ids stay rejected, so the integer-keyed
	// plans are never handed something that is not one.
	for _, notAnID := range []string{"", "   ", "abc", "1121879850.5", "1e400", "0x10"} {
		if got, ok := parseCatchmentID(notAnID); ok {
			t.Errorf("%q was accepted as catchment id %d", notAnID, got)
		}
	}

	// And the whole-list gate agrees.
	if _, ok := parseNumericIDs([]string{"1121879850", "1.12187985e+09"}); !ok {
		t.Error("a list of integer ids in mixed spellings was rejected, which would cost the fast plan")
	}
	if _, ok := parseNumericIDs([]string{"1121879850", "not-an-id"}); ok {
		t.Error("a list containing a non-id was accepted")
	}
}
