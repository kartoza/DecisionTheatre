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
	// weighted numerator and its matching weight total) and SQLITE_MAX_COLUMN
	// defaults to 2000, so this leaves a wide margin.
	aggregateColumnChunkSize = 500

	// MaxDetailCatchments bounds any response that carries one record per
	// catchment.
	//
	// This is a response-size ceiling, not a database limit. Measured against
	// the real datapack, /sites/{id}/catchments returns 1.16 GB for 32,766
	// catchments - roughly 35 KB each, since every record carries every
	// indicator for both scenarios - which extrapolates to about 5 GB for the
	// 147,837 catchments of the whole-of-Africa site. Chunking the id list
	// alone would have made that request succeed, which would have been a
	// worse bug than the blank view it replaced.
	//
	// 5,000 catchments is therefore the ceiling: about 175 MB, still far more
	// than any client should be asked to parse, and comfortably above any
	// site drawn around a real place - the Munywana site is 11 catchments.
	// Past it the request is refused rather than served, with a message
	// naming the summary endpoint that answers what the table, chart and dial
	// views are actually asking in a fixed few kilobytes. See
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

// tableExists reports whether the datapack contains a table or view of this
// name. It is the check that lets an absent table be reported as absent rather
// than as a query failure.
func (s *GpkgStore) tableExists(ctx context.Context, tableName string) (bool, error) {
	var found string
	err := s.db.QueryRowContext(ctx,
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
// what makes a 147,837-catchment site answerable at all. The id set is split
// into catchmentIDChunkSize batches and the columns into
// aggregateColumnChunkSize batches to stay inside SQLite's variable and column
// limits; the sums are additive, so the batches simply accumulate.
//
// It returns errTableAbsent, unwrapped by errors.Is, when the datapack has no
// such table.
func (s *GpkgStore) aggregateWeightedTable(ctx context.Context, tableName string, w *catchmentWeights) (*weightedTotals, error) {
	s.mu.RLock()
	columns := s.columns
	s.mu.RUnlock()
	if len(columns) == 0 {
		return nil, fmt.Errorf("no columns loaded")
	}
	if w.len() == 0 {
		return newWeightedTotals(0), nil
	}

	exists, err := s.tableExists(ctx, tableName)
	if err != nil {
		return nil, fmt.Errorf("failed to look up %s: %w", tableName, err)
	}
	if !exists {
		return nil, fmt.Errorf("%s: %w", tableName, errTableAbsent)
	}

	idColumn, err := s.resolveScenarioIDColumn(ctx, tableName)
	if err != nil {
		return nil, fmt.Errorf("failed to resolve ID column for %s: %w", tableName, err)
	}

	totals := newWeightedTotals(len(columns))

	for _, idChunk := range idChunks(w.len(), catchmentIDChunkSize) {
		start, end := idChunk[0], idChunk[1]
		idArgs := w.args(idColumn, start, end)

		tuples := make([]string, end-start)
		for i := range tuples {
			tuples[i] = "(?,?)"
		}
		valuesClause := strings.Join(tuples, ",")

		for colIndex, colChunk := range idChunks(len(columns), aggregateColumnChunkSize) {
			colStart, colEnd := colChunk[0], colChunk[1]
			chunkColumns := columns[colStart:colEnd]

			// SUM skips NULLs, and weight x NULL is NULL, so the numerator
			// already excludes catchments with no value for this column; the
			// CASE gives the denominator the same exclusion explicitly.
			exprs := make([]string, 0, len(chunkColumns)*2+1)
			exprs = append(exprs, "COUNT(*)")
			for _, col := range chunkColumns {
				exprs = append(exprs,
					fmt.Sprintf(`SUM(w.weight * s."%s")`, col),
					fmt.Sprintf(`SUM(CASE WHEN s."%s" IS NULL THEN 0 ELSE w.weight END)`, col))
			}

			query := fmt.Sprintf(
				`WITH w(cid, weight) AS (VALUES %s) SELECT %s FROM %s s JOIN w ON s.%s = w.cid`,
				valuesClause, strings.Join(exprs, ", "), tableName, idColumn)

			args := make([]interface{}, 0, (end-start)*2)
			for i := start; i < end; i++ {
				args = append(args, idArgs[i-start], w.weights[i])
			}

			scanned := make([]sql.NullFloat64, len(chunkColumns)*2)
			var matched sql.NullInt64
			scanArgs := make([]interface{}, 0, len(scanned)+1)
			scanArgs = append(scanArgs, &matched)
			for i := range scanned {
				scanArgs = append(scanArgs, &scanned[i])
			}

			// A failure here is reported, never converted into an empty
			// result: an aggregate of nothing and an aggregate that could not
			// be computed look identical to every caller downstream, and the
			// second one must not be able to render as the first. This is the
			// whole of issue #63.
			if err := s.db.QueryRowContext(ctx, query, args...).Scan(scanArgs...); err != nil {
				return nil, fmt.Errorf("failed to aggregate %s: %w", tableName, err)
			}

			// COUNT(*) is the same number in every column chunk of a given id
			// chunk, so only the first contributes.
			if colIndex == 0 && matched.Valid {
				totals.matched += int(matched.Int64)
			}
			for i, col := range chunkColumns {
				if scanned[i*2].Valid {
					totals.numerator[col] += scanned[i*2].Float64
				}
				if scanned[i*2+1].Valid {
					totals.denominator[col] += scanned[i*2+1].Float64
				}
			}
		}
	}

	return totals, nil
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

	w := newCatchmentWeights(catchments)
	agg := &CatchmentAggregate{
		CatchmentCount: w.len(),
		TotalAreaKm2:   w.total,
		Reference:      map[string]float64{},
		Current:        map[string]float64{},
	}
	if w.len() == 0 {
		return agg, nil
	}

	type scenarioResult struct {
		scenario string
		totals   *weightedTotals
		err      error
	}
	ch := make(chan scenarioResult, 2)
	scenarios := []string{"current", "reference"}
	for _, scenario := range scenarios {
		scenario := scenario
		go func() {
			totals, err := s.aggregateWeightedTable(ctx, "scenario_"+scenario, w)
			ch <- scenarioResult{scenario: scenario, totals: totals, err: err}
		}()
	}

	var firstErr error
	results := make(map[string]*weightedTotals, len(scenarios))
	for range scenarios {
		r := <-ch
		if r.err != nil {
			if firstErr == nil {
				firstErr = r.err
			}
			continue
		}
		results[r.scenario] = r.totals
	}
	if firstErr != nil {
		return nil, firstErr
	}

	agg.Current = results["current"].mean()
	agg.Reference = results["reference"].mean()
	agg.MatchedCount = results["current"].matched
	if results["reference"].matched > agg.MatchedCount {
		agg.MatchedCount = results["reference"].matched
	}
	return agg, nil
}
