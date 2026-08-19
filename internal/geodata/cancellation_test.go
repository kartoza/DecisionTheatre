package geodata

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/kartoza/decision-theatre/internal/gpkgtest"
)

// This file is an internal test (package geodata, not geodata_test) because
// proving that a cancellation actually stops work requires reaching the
// connection pool: the only way to make a synthetic datapack's queries take
// long enough to abandon is to make them queue for a connection, which is
// exactly what happens on the real server when the map is being panned.

// newCancelTestStore opens a store over a synthetic datapack and waits for the
// background grid geometry cache to finish, so that build is not still holding
// a pooled connection when a test starts counting them.
func newCancelTestStore(t *testing.T) *GpkgStore {
	t.Helper()

	dir := gpkgtest.Build(t, t.TempDir(), []gpkgtest.Catchment{
		{ID: 1000000001, Lat: 0, Long: 0, SizeDeg: 0.5, Current: gpkgtest.Float(10), Reference: gpkgtest.Float(1)},
		{ID: 1000000002, Lat: 0, Long: 1, SizeDeg: 0.5, Current: gpkgtest.Float(20), Reference: gpkgtest.Float(2)},
	}, 0, 100)

	store, err := NewGpkgStore(dir)
	if err != nil {
		t.Fatalf("NewGpkgStore: %v", err)
	}
	t.Cleanup(store.Close)

	for _, tier := range gridTiersDegrees {
		select {
		case <-store.gridGeometryReady[tier]:
		case <-time.After(30 * time.Second):
			t.Fatalf("grid geometry cache tier %v never became ready", tier)
		}
	}
	return store
}

// TestCancelledRequestStopsQueuedQuery is the test this whole change exists
// for. A query that is waiting its turn for a database connection - the state
// every extra request lands in once the pool is busy, which is precisely when
// abandoned work is most expensive - must give up the moment its client goes
// away, rather than running to completion for an answer nobody will read.
//
// Before contexts were threaded through, the store called db.Query, which waits
// on the pool forever: this test would sit here until it timed out.
func TestCancelledRequestStopsQueuedQuery(t *testing.T) {
	store := newCancelTestStore(t)

	// Occupy every connection in the pool so the query below has to queue.
	maxConns := store.db.Stats().MaxOpenConnections
	if maxConns <= 0 {
		t.Fatalf("expected a bounded connection pool, got MaxOpenConnections=%d", maxConns)
	}
	held := make([]*sql.Conn, 0, maxConns)
	for i := 0; i < maxConns; i++ {
		conn, err := store.db.Conn(context.Background())
		if err != nil {
			t.Fatalf("holding connection %d: %v", i, err)
		}
		held = append(held, conn)
	}
	t.Cleanup(func() {
		for _, conn := range held {
			_ = conn.Close()
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	done := make(chan error, 1)
	go func() {
		_, err := store.QueryCatchmentValueArrays(ctx, "current", gpkgtest.Attribute, -5, -5, 5, 5)
		done <- err
	}()

	// Let the query settle into the queue, then abandon it the way a user
	// panning the map again does.
	time.Sleep(50 * time.Millisecond)
	cancel()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled query returned success; the cancellation never reached the database call")
		}
		if !IsCancellation(ctx, err) {
			t.Fatalf("cancelled query failed with %v, want a cancellation", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("query was still queued 10s after the client disconnected: cancellation is not reaching the connection pool")
	}
}

// storeCall is one entry point of the store, exercised with both a live and a
// cancelled context.
type storeCall struct {
	name string
	call func(context.Context, *GpkgStore) error
}

// TestEveryQueryHonoursCancellation walks the store's query surface and checks
// each entry point twice: once with a live context, where it must succeed
// (otherwise the cancelled case would pass for the wrong reason), and once with
// a context cancelled before the call, where it must report a cancellation
// rather than quietly returning whatever it managed to read.
//
// It is written as a table on purpose: a query added later without a context
// parameter cannot be added to this list, and one added with a context it then
// ignores fails here.
func TestEveryQueryHonoursCancellation(t *testing.T) {
	calls := []storeCall{
		{"QueryCatchments", func(ctx context.Context, s *GpkgStore) error {
			_, err := s.QueryCatchments(ctx, "current", gpkgtest.Attribute, -5, -5, 5, 5, 8)
			return err
		}},
		{"QueryCatchmentValues", func(ctx context.Context, s *GpkgStore) error {
			_, err := s.QueryCatchmentValues(ctx, "current", gpkgtest.Attribute, -5, -5, 5, 5)
			return err
		}},
		{"QueryCatchmentValueArrays", func(ctx context.Context, s *GpkgStore) error {
			_, err := s.QueryCatchmentValueArrays(ctx, "current", gpkgtest.Attribute, -5, -5, 5, 5)
			return err
		}},
		{"GetScenarioAverages", func(ctx context.Context, s *GpkgStore) error {
			_, err := s.GetScenarioAverages(ctx, "current", []string{gpkgtest.Attribute}, nil)
			return err
		}},
		{"GetDomainRange", func(ctx context.Context, s *GpkgStore) error {
			_, err := s.GetDomainRange(ctx, gpkgtest.Attribute)
			return err
		}},
		{"GetCatchmentsBounds", func(ctx context.Context, s *GpkgStore) error {
			_, err := s.GetCatchmentsBounds(ctx)
			return err
		}},
		{"GetCatchmentsByBBox", func(ctx context.Context, s *GpkgStore) error {
			_, err := s.GetCatchmentsByBBox(ctx, -5, -5, 5, 5, 100)
			return err
		}},
		{"GetCatchmentIDsByBBox", func(ctx context.Context, s *GpkgStore) error {
			_, err := s.GetCatchmentIDsByBBox(ctx, -5, -5, 5, 5, 100)
			return err
		}},
		{"GetCatchmentsByIDs", func(ctx context.Context, s *GpkgStore) error {
			_, err := s.GetCatchmentsByIDs(ctx, []string{"1000000001"})
			return err
		}},
		{"GetCatchmentIndicatorsByIDs", func(ctx context.Context, s *GpkgStore) error {
			_, err := s.GetCatchmentIndicatorsByIDs(ctx, []string{"1000000001"})
			return err
		}},
		{"DissolveCatchments", func(ctx context.Context, s *GpkgStore) error {
			_, _, err := s.DissolveCatchments(ctx, []string{"1000000001"})
			return err
		}},
		{"GetCatchmentAOIFractions", func(ctx context.Context, s *GpkgStore) error {
			_, err := s.GetCatchmentAOIFractions(ctx, []string{"1000000001"},
				json.RawMessage(`{"type":"Polygon","coordinates":[[[-1,-1],[1,-1],[1,1],[-1,1],[-1,-1]]]}`))
			return err
		}},
	}

	for _, tc := range calls {
		t.Run(tc.name, func(t *testing.T) {
			store := newCancelTestStore(t)

			if err := tc.call(context.Background(), store); err != nil {
				t.Fatalf("with a live context the call must succeed, got %v", err)
			}

			ctx, cancel := context.WithCancel(context.Background())
			cancel()

			err := tc.call(ctx, store)
			if err == nil {
				t.Fatal("returned success for an abandoned request; the context is not reaching the database call")
			}
			if !IsCancellation(ctx, err) {
				t.Fatalf("returned %v, want a cancellation", err)
			}
		})
	}
}

// The grid geometry cache is shared: it is built once and then serves every
// aggregated choropleth for the life of the process. A request that gives up
// waiting for it must take only itself out of the picture - if it tore the
// build down, one impatient user would leave every other waiting request with
// no geometry and no build still running to supply it.
func TestGivingUpOnTheGridCacheDoesNotCancelTheBuild(t *testing.T) {
	// A store whose tiers are all still building: the ready channels are open.
	ready := make(map[float64]chan struct{}, len(gridTiersDegrees))
	for _, tier := range gridTiersDegrees {
		ready[tier] = make(chan struct{})
	}
	// The build is already marked as in flight so the wait below does not kick
	// one off against a nil database.
	store := &GpkgStore{gridGeometryReady: ready, gridGeometryBuilding: true}

	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	rows := []gridRow{{lat: 0, long: 0, area: 1, value: sql.NullFloat64{Float64: 5, Valid: true}}}

	done := make(chan error, 1)
	go func() {
		_, err := store.queryCatchmentsGridAggregated(ctx, gpkgtest.Attribute, rows)
		done <- err
	}()

	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("waiting request returned %v, want context.Canceled", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a cancelled request is still waiting for the grid cache")
	}

	// The build's own signal is untouched: nothing closed the channels, and
	// nothing else observed a cancellation.
	for _, tier := range gridTiersDegrees {
		select {
		case <-ready[tier]:
			t.Fatalf("tier %v was marked ready by an abandoned request; the shared build was torn down", tier)
		default:
		}
	}
}

func TestIsCancellation(t *testing.T) {
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()

	expired, cancelExpired := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancelExpired()

	cases := []struct {
		name string
		ctx  context.Context
		err  error
		want bool
	}{
		{"no error", cancelled, nil, false},
		{"context.Canceled", context.Background(), context.Canceled, true},
		{"wrapped context.Canceled", context.Background(), errors.New("query failed: " + context.Canceled.Error()), false},
		// SQLite reports its own error when interrupted mid-statement, with no
		// relation to context.Canceled; the context is what identifies it.
		{"driver interrupt under a cancelled context", cancelled, errors.New("interrupted"), true},
		{"genuine failure under a live context", context.Background(), errors.New("no such table: catchments_lev12"), false},
		// A blown deadline is a real failure worth reporting, not a user
		// changing their mind.
		{"deadline exceeded", expired, context.DeadlineExceeded, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := IsCancellation(tc.ctx, tc.err); got != tc.want {
				t.Errorf("IsCancellation = %v, want %v", got, tc.want)
			}
		})
	}
}
