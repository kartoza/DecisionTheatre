package geodata

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"strings"
	"time"
)

// SQLite's own limits, which every id-list query in this package has to be
// built around.
//
// A catchment set is not a small thing here: a whole-of-Africa site is 147,837
// catchments. Before these constants existed, the id-list queries emitted one
// bind variable per id in a single statement, so every one of them silently
// stopped working somewhere between eleven catchments and a continent - SQLite
// refuses to *prepare* a statement past the variable limit, so the failure
// arrives as an error on Query, not as a short result. See issues #63 and #140.
const (
	// sqliteMaxVariables is SQLITE_MAX_VARIABLE_NUMBER, which has defaulted to
	// 32766 since SQLite 3.32. Verified against the driver actually linked in
	// (see TestCatchmentIDChunkSizeRespectsSQLiteVariableLimit): 32,766 bind
	// variables prepare, 32,767 fail with "too many SQL variables".
	sqliteMaxVariables = 32766

	// catchmentIDChunkSize is how many catchment ids may go into one
	// statement. The widest form binds two variables per id - the id and its
	// weight, in the aggregate's VALUES clause - so the budget is halved, then
	// rounded down to leave room for the handful of non-id variables a query
	// may also carry.
	catchmentIDChunkSize = 16000

	// aggregateColumnChunkSize is how many indicator columns one aggregate
	// statement may cover. Each column contributes two result columns (a
	// weighted numerator and its matching weight total), plus one for the row
	// count, against SQLITE_MAX_COLUMN's default of 2000.
	//
	// Under the materialised plan every extra batch is another full scan of
	// the scenario table, and that scan is CPU-bound rather than I/O-bound
	// (measured: constant read_bytes, one core saturated), so a second batch
	// is paid for in full rather than absorbed by a warm page cache. This is
	// therefore set as high as the column limit safely allows rather than to
	// a round number: the real datapack has 502 indicator columns, which at
	// the previous value of 500 took two passes, the second of them to
	// aggregate two columns.
	aggregateColumnChunkSize = 900

	// weightTableThreshold is the catchment count above which the weights are
	// materialised into a TEMP table rather than inlined as a VALUES clause.
	//
	// This is a query-plan decision, and measurement against the real datapack
	// showed it is the single most expensive one in this file. With the
	// weights inline, SQLite drives the join from the VALUES list and looks
	// each catchment up through the scenario table's id index - one random row
	// fetch per catchment, per batch. That is the right plan for a site of a
	// few hundred catchments and a catastrophic one for a continent: a single
	// whisker table over 147,837 catchments took 5m56s that way.
	//
	// With the weights in an indexed TEMP table, SQLite instead scans the
	// scenario table once, sequentially, and probes the (small, in-memory)
	// weight table per row. See newWeightSet.
	//
	// The threshold is the point where the id list stops fitting in one
	// statement, which is also the point where the inline plan starts
	// repeating those random fetches batch after batch.
	weightTableThreshold = catchmentIDChunkSize

	// MaxDetailCatchments bounds any response that carries one record per
	// catchment.
	//
	// This is a response-size ceiling, not a database limit, and it is set
	// from measurement against the real datapack rather than from a round
	// number. Every record carries all 502 indicators for both scenarios, so
	// one catchment costs 17-31 KB of JSON:
	//
	//	    100 catchments     2.6 MB    0.2s query + 0.1s encode
	//	  1,000 catchments    17.9 MB    0.4s query + 0.5s encode
	//	  5,000 catchments   151.6 MB    1.9s query + 4.8s encode
	//
	// which puts the 147,837 catchments of the whole-of-Africa site at
	// something over 4 GB. Chunking the id list alone would have made that
	// request succeed, and a 4 GB body would have been a worse bug than the
	// blank view it replaced.
	//
	// 5,000 is where that curve is left: 152 MB and about seven seconds is
	// already far more than a client should be asked to hold, and it is three
	// orders of magnitude above any site drawn around a real place - the
	// Munywana site is 11 catchments. It is a ceiling, not a target. Past it
	// the request is refused rather than served, with a message naming the
	// summary endpoint, which answers what the table, chart and dial views are
	// actually asking in a fixed few kilobytes at any site size. See
	// ErrTooManyCatchments and the API's /sites/{id}/summary.
	MaxDetailCatchments = 5000
)

// ErrTooManyCatchments reports a per-catchment request that would produce an
// unbounded response. Callers should offer the aggregate summary instead; the
// HTTP layer maps it to 413.
var ErrTooManyCatchments = errors.New("too many catchments for a per-catchment response")

// errTableAbsent reports a table that is not in this datapack at all, as
// opposed to one whose query failed. The two must not be conflated: a datapack
// built without the whisker tables is a datapack with no whiskers, which is a
// fact to report, whereas a whisker table that fails to read is a fault.
var errTableAbsent = errors.New("table not present in datapack")

// idChunks returns the [start, end) index ranges that cover n items in chunks
// of at most size.
func idChunks(n, size int) [][2]int {
	if n <= 0 {
		return nil
	}
	if size <= 0 {
		size = n
	}
	chunks := make([][2]int, 0, (n+size-1)/size)
	for start := 0; start < n; start += size {
		end := start + size
		if end > n {
			end = n
		}
		chunks = append(chunks, [2]int{start, end})
	}
	return chunks
}

// querier is the read surface shared by *sql.DB and *sql.Conn, so that work
// holding a specific connection can keep using it rather than taking a second
// one out of a bounded pool.
type querier interface {
	QueryContext(ctx context.Context, query string, args ...interface{}) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...interface{}) *sql.Row
}

// tableExists reports whether the datapack contains a table or view of this
// name. It is the check that lets an absent table be reported as absent rather
// than as a query failure.
func (s *GpkgStore) tableExists(ctx context.Context, q querier, tableName string) (bool, error) {
	var found string
	err := q.QueryRowContext(ctx,
		`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`,
		tableName).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// catchmentWeights is a catchment set reduced to what every aggregate needs:
// each catchment's id, in both the text and integer spellings the scenario
// tables use, and the area it contributes to a weighted mean.
type catchmentWeights struct {
	ids         []string      // normalized, de-duplicated
	textArgs    []interface{} // ids as text, index-aligned with ids
	numericArgs []interface{} // ids as int64, nil unless every id parsed
	numeric     bool
	weights     []float64 // area x AOI fraction, index-aligned with ids
	total       float64
}

// newCatchmentWeights reduces catchments to their aggregation weights.
//
// The weight is area x AOI fraction. A fraction outside (0, 1] is taken as 1
// rather than as a zero-area catchment: aoiFraction is `omitempty` on the
// wire, so a catchment that never had one - and every catchment of a site
// built by selecting catchments rather than by drawing a boundary - arrives
// here as 0 meaning "unset", not as "does not overlap". This is the rule
// ComputeWhiskerBounds has always applied, and it is kept so that whisker
// numbers do not move.
//
// Duplicate ids are collapsed, since a repeated id would otherwise count its
// catchment twice in both the numerator and the denominator.
func newCatchmentWeights(catchments []CatchmentIndicators) *catchmentWeights {
	w := &catchmentWeights{
		ids:      make([]string, 0, len(catchments)),
		textArgs: make([]interface{}, 0, len(catchments)),
		weights:  make([]float64, 0, len(catchments)),
	}
	seen := make(map[string]struct{}, len(catchments))
	for _, c := range catchments {
		id := normalizeCatchmentID(strings.TrimSpace(c.ID))
		if id == "" {
			continue
		}
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}

		frac := c.AOIFraction
		if frac <= 0 || frac > 1 {
			frac = 1
		}
		weight := c.AreaKm2 * frac
		if weight < 0 {
			weight = 0
		}

		w.ids = append(w.ids, id)
		w.textArgs = append(w.textArgs, id)
		w.weights = append(w.weights, weight)
		w.total += weight
	}

	// A datapack row with no SUB_AREA, or a catchment set that has not been
	// through area lookup, would otherwise weight everything at zero and
	// aggregate to nothing at all. Falling back to equal weights matches
	// computeAreaWeightedIndicators, which is how the server has always
	// computed a site's indicators in that situation.
	if w.total <= 0 && len(w.ids) > 0 {
		for i := range w.weights {
			w.weights[i] = 1
		}
		w.total = float64(len(w.weights))
	}

	w.numericArgs, w.numeric = parseNumericIDs(w.ids)
	return w
}

func (w *catchmentWeights) len() int { return len(w.ids) }

// args returns the id bind values for ids[start:end] in the spelling idColumn
// expects.
func (w *catchmentWeights) args(idColumn string, start, end int) []interface{} {
	if strings.HasSuffix(idColumn, "_int") && w.numeric {
		return w.numericArgs[start:end]
	}
	return w.textArgs[start:end]
}

// weightedTotals is one table's contribution to a weighted mean, kept
// unreduced so that the per-chunk and per-scenario sums can be added up before
// the single division at the end.
type weightedTotals struct {
	numerator   map[string]float64 // sum(weight x value) over rows with a value
	denominator map[string]float64 // sum(weight) over the same rows
	matched     int
}

func newWeightedTotals(capacity int) *weightedTotals {
	return &weightedTotals{
		numerator:   make(map[string]float64, capacity),
		denominator: make(map[string]float64, capacity),
	}
}

// mean reduces the totals to one value per attribute. An attribute no
// catchment had a value for is absent from the result rather than present as
// zero - a missing indicator must stay missing, or it renders as a real
// measurement of nothing.
func (t *weightedTotals) mean() map[string]float64 {
	result := make(map[string]float64, len(t.numerator))
	for col, num := range t.numerator {
		if den := t.denominator[col]; den > 0 {
			result[col] = num / den
		}
	}
	return result
}

// weightSet is a catchment set made joinable from SQL, in whichever of the two
// forms suits its size.
//
// Small sets are inlined into each statement as a VALUES clause. Large ones are
// materialised once into a TEMP table keyed by catchment id, which both lifts
// the bind-variable ceiling and, far more importantly, changes which way round
// SQLite runs the join (see weightTableThreshold).
type weightSet struct {
	weights *catchmentWeights

	// conn is the connection holding the TEMP table, and is nil for an inline
	// set. The table is only visible to this one connection, so every query
	// against it has to be issued here.
	conn *sql.Conn
}

// weightTableName is the TEMP table a materialised weightSet lives in. It is
// per-connection, so the name cannot collide between concurrent requests.
const weightTableName = "aoi_weights"

// newWeightSet prepares the catchments for querying, materialising them into a
// TEMP table when asked to. The decision is the caller's, since what counts as
// worth it depends on the query (see weightTableThreshold); tests pass true
// directly so the materialised path is exercised without needing a continent.
//
// The caller must close the result.
func (s *GpkgStore) newWeightSet(ctx context.Context, w *catchmentWeights, materialise bool) (*weightSet, error) {
	ws := &weightSet{weights: w}
	if !materialise {
		return ws, nil
	}

	// The materialised plan depends on the weight table being keyed by an
	// INTEGER PRIMARY KEY, which is what makes SQLite's rowid lookup cheap
	// enough that it scans the scenario table instead (see
	// populateWeightTable). Ids that are not integers cannot key it that way,
	// so those fall back to the inline plan: slower for a large set, but this
	// datapack's catchment ids are HYBAS integers and no known datapack takes
	// that path.
	if !w.numeric {
		log.Printf("Warning: %d catchments have ids that are not integers, so the query falls back to "+
			"the plan that looks each one up individually, which is much slower at this size", w.len())
		return ws, nil
	}

	start := time.Now()
	conn, err := s.db.Conn(ctx)
	if err != nil {
		return nil, fmt.Errorf("failed to take a connection for the weight table: %w", err)
	}

	if err := s.populateWeightTable(ctx, conn, w); err != nil {
		// The connection is returned to the pool carrying a TEMP table that
		// may be half-built, so it is dropped before letting go of it.
		_, _ = conn.ExecContext(ctx, "DROP TABLE IF EXISTS temp."+weightTableName)
		_ = conn.Close()
		return nil, err
	}

	ws.conn = conn
	log.Printf("[perf] newWeightSet materialised %d weights in %dms", w.len(), time.Since(start).Milliseconds())
	return ws, nil
}

func (s *GpkgStore) populateWeightTable(ctx context.Context, conn *sql.Conn, w *catchmentWeights) error {
	// The weight table is a few megabytes and is read once per scenario table,
	// so it belongs in memory rather than in a temp file on disk.
	if _, err := conn.ExecContext(ctx, "PRAGMA temp_store = MEMORY"); err != nil {
		return fmt.Errorf("failed to set temp store: %w", err)
	}

	// A connection comes from a pool and may have served an earlier weight
	// set, so the table is dropped rather than assumed absent.
	if _, err := conn.ExecContext(ctx, "DROP TABLE IF EXISTS temp."+weightTableName); err != nil {
		return fmt.Errorf("failed to clear the weight table: %w", err)
	}

	// cid is an INTEGER PRIMARY KEY, which makes it the table's rowid, and
	// that is not a detail - it is the whole reason this path is fast.
	//
	// Measured against the real datapack: with cid as an INTEGER PRIMARY KEY,
	// SQLite plans "SCAN s, SEARCH w USING INTEGER PRIMARY KEY" - one
	// sequential pass over the scenario table, probing the weights per row.
	// With the same data in a column carrying an ordinary index it plans
	// "SCAN w, SEARCH s USING INDEX" instead, running the join the other way
	// round: one random row fetch into a multi-hundred-megabyte table per
	// catchment. That single difference is 7s versus more than 200s for one
	// table, so it is pinned here rather than left to the planner's cost
	// estimates.
	if _, err := conn.ExecContext(ctx, fmt.Sprintf(
		`CREATE TEMP TABLE %s (cid INTEGER PRIMARY KEY, weight REAL NOT NULL)`,
		weightTableName)); err != nil {
		return fmt.Errorf("failed to create the weight table: %w", err)
	}

	// Inserted in batches inside one transaction: a row at a time would mean
	// 147,837 round trips through the driver for a continent-sized site.
	const insertBatch = 500
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("failed to begin the weight table transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	for _, chunk := range idChunks(w.len(), insertBatch) {
		rows := chunk[1] - chunk[0]
		tuples := make([]string, rows)
		args := make([]interface{}, 0, rows*2)
		for i := range tuples {
			tuples[i] = "(?,?)"
			index := chunk[0] + i
			args = append(args, w.numericArgs[index], w.weights[index])
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf(
			`INSERT INTO %s (cid, weight) VALUES %s`,
			weightTableName, strings.Join(tuples, ",")), args...); err != nil {
			return fmt.Errorf("failed to fill the weight table: %w", err)
		}
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("failed to commit the weight table: %w", err)
	}
	return nil
}

// close releases the connection holding the TEMP table, dropping the table
// first so the pooled connection goes back clean.
func (ws *weightSet) close() {
	if ws == nil || ws.conn == nil {
		return
	}
	_, _ = ws.conn.ExecContext(context.Background(), "DROP TABLE IF EXISTS temp."+weightTableName)
	_ = ws.conn.Close()
	ws.conn = nil
}

// materialised reports whether the weights are in a TEMP table. Such a set
// belongs to one connection and so to one table's aggregation; see
// aggregateTables.
func (ws *weightSet) materialised() bool { return ws.conn != nil }

// querier returns the connection this weight set's queries must use: the one
// holding its TEMP table, or the pool when there is no table to be tied to.
func (ws *weightSet) querier(s *GpkgStore) querier {
	if ws.conn != nil {
		return ws.conn
	}
	return s.db
}

// aggregateExpressions returns the SELECT list for one batch of columns: the
// matched row count, then a weighted numerator and its matching weight total
// for each column.
//
// SUM skips NULLs and weight x NULL is NULL, so the numerator already excludes
// catchments with no value for the column; the CASE gives the denominator the
// same exclusion explicitly.
func aggregateExpressions(columns []string) string {
	exprs := make([]string, 0, len(columns)*2+1)
	exprs = append(exprs, "COUNT(*)")
	for _, col := range columns {
		exprs = append(exprs,
			fmt.Sprintf(`SUM(w.weight * s."%s")`, col),
			fmt.Sprintf(`SUM(CASE WHEN s."%s" IS NULL THEN 0 ELSE w.weight END)`, col))
	}
	return strings.Join(exprs, ", ")
}

// scanAggregateRow reads one aggregate row into totals. countRows is false for
// every column batch after the first, since COUNT(*) repeats the same number
// in each of them.
func (t *weightedTotals) scanAggregateRow(row *sql.Row, columns []string, countRows bool) error {
	scanned := make([]sql.NullFloat64, len(columns)*2)
	var matched sql.NullInt64
	scanArgs := make([]interface{}, 0, len(scanned)+1)
	scanArgs = append(scanArgs, &matched)
	for i := range scanned {
		scanArgs = append(scanArgs, &scanned[i])
	}
	if err := row.Scan(scanArgs...); err != nil {
		return err
	}
	if countRows && matched.Valid {
		t.matched += int(matched.Int64)
	}
	for i, col := range columns {
		if scanned[i*2].Valid {
			t.numerator[col] += scanned[i*2].Float64
		}
		if scanned[i*2+1].Valid {
			t.denominator[col] += scanned[i*2+1].Float64
		}
	}
	return nil
}

// aggregateWeightedTable computes, entirely in SQL, the weighted mean of every
// indicator column of one scenario-shaped table across the given catchments:
//
//	sum(area x aoiFraction x value) / sum(area x aoiFraction)
//
// with the denominator taken per attribute over only those catchments that
// actually have a value for it - a catchment missing one indicator must not
// count toward that indicator's denominator with an implicit zero numerator,
// which would drag the mean toward zero. This matches the frontend's
// computeAOIWeightedAttributeValue and the server's own
// computeAreaWeightedIndicators.
//
// Nothing per-catchment crosses the SQL boundary: each statement returns a
// single row of sums regardless of how many catchments it covers, which is
// what makes a 147,837-catchment site answerable at all.
//
// It returns errTableAbsent, unwrapped by errors.Is, when the datapack has no
// such table.
func (s *GpkgStore) aggregateWeightedTable(ctx context.Context, tableName string, ws *weightSet) (*weightedTotals, error) {
	s.mu.RLock()
	columns := s.columns
	s.mu.RUnlock()
	if len(columns) == 0 {
		return nil, fmt.Errorf("no columns loaded")
	}
	w := ws.weights
	if w.len() == 0 {
		return newWeightedTotals(0), nil
	}

	q := ws.querier(s)
	exists, err := s.tableExists(ctx, q, tableName)
	if err != nil {
		return nil, fmt.Errorf("failed to look up %s: %w", tableName, err)
	}
	if !exists {
		return nil, fmt.Errorf("%s: %w", tableName, errTableAbsent)
	}

	idColumn, err := s.resolveScenarioIDColumn(ctx, q, tableName)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve ID column for %s: %w", tableName, err)
	}

	// The weight table is keyed by an INTEGER PRIMARY KEY, so it can only be
	// joined to an integer id column. Against a textual one the comparison
	// needs a conversion, the key becomes unusable, and the pinned loop order
	// would turn into a full scan of the weights per scanned row - far worse
	// than the plan it replaced. A table like that takes the inline path.
	materialised := ws.materialised() && strings.HasSuffix(idColumn, "_int")
	if ws.materialised() && !materialised {
		log.Printf("Warning: %s joins on %s, which the weight table cannot key on; "+
			"falling back to the inline plan", tableName, idColumn)
	}

	start := time.Now()
	totals := newWeightedTotals(len(columns))
	if materialised {
		err = s.aggregateViaWeightTable(ctx, tableName, idColumn, ws, columns, totals)
	} else {
		err = s.aggregateViaValuesClause(ctx, tableName, idColumn, w, columns, totals)
	}
	if err != nil {
		return nil, err
	}
	log.Printf("[perf] aggregateWeightedTable table=%s catchments=%d materialised=%t duration_ms=%d",
		tableName, w.len(), materialised, time.Since(start).Milliseconds())
	return totals, nil
}

// aggregateViaWeightTable is the large-set plan: one statement per column
// batch, joining the scenario table to the materialised weights. SQLite scans
// the scenario table once and probes the weight table's index per row.
func (s *GpkgStore) aggregateViaWeightTable(ctx context.Context, tableName, idColumn string, ws *weightSet, columns []string, totals *weightedTotals) error {
	for batch, colChunk := range idChunks(len(columns), aggregateColumnChunkSize) {
		chunkColumns := columns[colChunk[0]:colChunk[1]]

		// CROSS JOIN, not JOIN: in SQLite that is the documented way to fix
		// the loop order, and it is the scenario table that must be the outer
		// loop. The join is otherwise identical - CROSS JOIN in SQLite has no
		// effect on the result, only on the plan - but it means a future
		// version's cost model cannot quietly flip this back to a random row
		// fetch per catchment.
		query := fmt.Sprintf(`SELECT %s FROM %s s CROSS JOIN %s w ON s.%s = w.cid`,
			aggregateExpressions(chunkColumns), tableName, weightTableName, idColumn)

		// A failure here is reported, never converted into an empty result: an
		// aggregate of nothing and an aggregate that could not be computed
		// look identical to every caller downstream, and the second one must
		// not be able to render as the first. This is the whole of issue #63.
		row := ws.conn.QueryRowContext(ctx, query)
		if err := totals.scanAggregateRow(row, chunkColumns, batch == 0); err != nil {
			return fmt.Errorf("failed to aggregate %s: %w", tableName, err)
		}
	}
	return nil
}

// aggregateViaValuesClause is the small-set plan: the weights ride along inside
// each statement, and SQLite looks each catchment up through the scenario
// table's id index. That is the cheaper plan while the set stays selective -
// which is what keeps a site of a few dozen catchments answering in
// milliseconds - and the reason weightTableThreshold exists is that it stops
// being cheaper long before the bind-variable limit forces the issue.
func (s *GpkgStore) aggregateViaValuesClause(ctx context.Context, tableName, idColumn string, w *catchmentWeights, columns []string, totals *weightedTotals) error {
	for _, idChunk := range idChunks(w.len(), catchmentIDChunkSize) {
		start, end := idChunk[0], idChunk[1]
		idArgs := w.args(idColumn, start, end)

		tuples := make([]string, end-start)
		for i := range tuples {
			tuples[i] = "(?,?)"
		}
		valuesClause := strings.Join(tuples, ",")

		args := make([]interface{}, 0, (end-start)*2)
		for i := start; i < end; i++ {
			args = append(args, idArgs[i-start], w.weights[i])
		}

		for batch, colChunk := range idChunks(len(columns), aggregateColumnChunkSize) {
			chunkColumns := columns[colChunk[0]:colChunk[1]]
			query := fmt.Sprintf(
				`WITH w(cid, weight) AS (VALUES %s) SELECT %s FROM %s s JOIN w ON s.%s = w.cid`,
				valuesClause, aggregateExpressions(chunkColumns), tableName, idColumn)

			row := s.db.QueryRowContext(ctx, query, args...)
			if err := totals.scanAggregateRow(row, chunkColumns, batch == 0); err != nil {
				return fmt.Errorf("failed to aggregate %s: %w", tableName, err)
			}
		}
	}
	return nil
}

// aggregateTables aggregates several scenario-shaped tables over one catchment
// set, returning the totals for each table that the datapack has. A table that
// is simply absent is left out of the result; anything else is an error.
//
// Each table is aggregated concurrently, with its own weight set. Sharing one
// materialised weight set between them would mean sharing the single
// connection its TEMP table lives on, and so running the tables one after
// another - which matters because this work is CPU-bound rather than
// I/O-bound: measured against the real datapack, the scan sits at one
// saturated core with no disk reads at all, so four tables at once cost about
// what one does on a machine with cores to spare. The duplicated weight tables
// are a few hundred milliseconds each and are built in parallel too.
func (s *GpkgStore) aggregateTables(ctx context.Context, tableNames []string, w *catchmentWeights) (map[string]*weightedTotals, error) {
	type tableResult struct {
		name   string
		totals *weightedTotals
		err    error
	}

	ch := make(chan tableResult, len(tableNames))
	for _, tableName := range tableNames {
		tableName := tableName
		go func() {
			defer func() {
				if r := recover(); r != nil {
					ch <- tableResult{name: tableName, err: fmt.Errorf("panic aggregating %s: %v", tableName, r)}
				}
			}()

			ws, err := s.newWeightSet(ctx, w, w.len() > weightTableThreshold)
			if err != nil {
				ch <- tableResult{name: tableName, err: err}
				return
			}
			defer ws.close()

			totals, err := s.aggregateWeightedTable(ctx, tableName, ws)
			ch <- tableResult{name: tableName, totals: totals, err: err}
		}()
	}

	results := make(map[string]*weightedTotals, len(tableNames))
	var firstErr error
	for range tableNames {
		r := <-ch
		switch {
		case r.err == nil:
			results[r.name] = r.totals
		case errors.Is(r.err, errTableAbsent):
			// The datapack does not have this table. Left out of the result
			// rather than reported, so the caller can decide whether that is
			// a missing feature or a missing prerequisite.
		case firstErr == nil:
			firstErr = r.err
		}
	}
	if firstErr != nil {
		return nil, firstErr
	}
	return results, nil
}

// CatchmentAggregate is the bounded answer to "what do these catchments add up
// to": one number per indicator per scenario, plus the totals that produced
// them.
//
// It is the shape the table, chart and dial views actually need. Each of them
// reduces a catchment set to a scalar - the dial literally calls
// computeAOIWeightedAttributeValue and reads one number out of it - so
// enumerating 147,837 records over the wire to divide them down to a handful
// of scalars in the browser was always the wrong end to do the work at.
type CatchmentAggregate struct {
	// CatchmentCount is how many distinct catchments were asked about;
	// MatchedCount is how many of them the scenario table actually had a row
	// for. The two differing is not an error - the datapack legitimately has
	// no row for some catchments - but a MatchedCount of zero for a non-empty
	// request means the answer describes nothing, and callers should say so
	// rather than draw it.
	CatchmentCount int `json:"catchmentCount"`
	MatchedCount   int `json:"matchedCount"`

	// TotalAreaKm2 is the summed area x AOI fraction of the requested
	// catchments, i.e. the denominator's ceiling.
	TotalAreaKm2 float64 `json:"totalAreaKm2"`

	Reference map[string]float64 `json:"reference"`
	Current   map[string]float64 `json:"current"`
}

// AggregateCatchmentIndicators returns the area-weighted mean of every
// indicator, for both scenarios, across the given catchments - computed in
// SQL, close to the data, and bounded in size no matter how many catchments
// are involved.
//
// Only the ID, AreaKm2 and AOIFraction of each catchment are read; the
// indicator maps are not, so callers may pass the cheap result of
// GetCatchmentAreasByIDs rather than paying for a full per-catchment fetch.
func (s *GpkgStore) AggregateCatchmentIndicators(ctx context.Context, catchments []CatchmentIndicators) (*CatchmentAggregate, error) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] AggregateCatchmentIndicators catchments=%d duration_ms=%d", len(catchments), time.Since(start).Milliseconds())
	}()

	agg := &CatchmentAggregate{
		CatchmentCount: len(catchments),
		Reference:      map[string]float64{},
		Current:        map[string]float64{},
	}
	if len(catchments) == 0 {
		return agg, nil
	}

	w := newCatchmentWeights(catchments)
	agg.CatchmentCount = w.len()
	agg.TotalAreaKm2 = w.total
	if w.len() == 0 {
		return agg, nil
	}

	results, err := s.aggregateTables(ctx, []string{"scenario_current", "scenario_reference"}, w)
	if err != nil {
		return nil, err
	}

	// Unlike the whisker tables, these two are the datapack's core data. Their
	// absence is reported rather than quietly answered with an empty summary.
	current, ok := results["scenario_current"]
	if !ok {
		return nil, fmt.Errorf("scenario_current: %w", errTableAbsent)
	}
	reference, ok := results["scenario_reference"]
	if !ok {
		return nil, fmt.Errorf("scenario_reference: %w", errTableAbsent)
	}

	agg.Current = current.mean()
	agg.Reference = reference.mean()
	agg.MatchedCount = current.matched
	if reference.matched > agg.MatchedCount {
		agg.MatchedCount = reference.matched
	}
	return agg, nil
}
