package geodata

import (
	"encoding/json"
	"errors"
	"sync"
	"testing"
	"time"
)

// Low-zoom choropleth requests blocked on a bare channel receive with no context
// and no timeout. The channel is closed by the grid-geometry build, whose workers
// had no recover() — and a panic there did not merely lose a cell: the goroutine
// died without sending, so wg.Wait never returned, the results channel was never
// closed, and the tier's ready channel never closed either. Every subsequent
// low-zoom request then blocked forever, accumulating goroutines until the process
// died.

// newReadyStore builds the readiness machinery without opening a geopackage.
func newReadyStore() *GpkgStore {
	ready := make(map[float64]chan struct{}, len(gridTiersDegrees))
	closeReady := make(map[float64]*sync.Once, len(gridTiersDegrees))
	for _, tier := range gridTiersDegrees {
		ready[tier] = make(chan struct{})
		closeReady[tier] = &sync.Once{}
	}
	return &GpkgStore{
		gridGeometryReady: ready,
		closeReady:        closeReady,
	}
}

// The build's deferred close must release waiters even when it ends abnormally.
func TestCloseAllGridReadyReleasesEveryTier(t *testing.T) {
	s := newReadyStore()

	s.closeAllGridReady()

	for _, tier := range gridTiersDegrees {
		select {
		case <-s.gridGeometryReady[tier]:
		default:
			t.Errorf("tier %.3f was left open; requests on it would block forever", tier)
		}
	}
}

// The failure paths close every tier, including ones already closed on success.
// Without the sync.Once that is a "close of closed channel" panic — a partial
// failure turned into a crash.
func TestClosingAReadyTierTwiceIsSafe(t *testing.T) {
	s := newReadyStore()

	defer func() {
		if r := recover(); r != nil {
			t.Errorf("closing twice panicked: %v", r)
		}
	}()

	s.closeGridReady(gridTiersDegrees[0])
	s.closeGridReady(gridTiersDegrees[0])
	s.closeAllGridReady()
	s.closeAllGridReady()
}

// A panic anywhere in the build must still release every waiter, which is what the
// deferred close is for. This models the build's own structure: panic, recover at
// the top, and confirm nothing is left blocked.
func TestAPanickingBuildStillReleasesWaiters(t *testing.T) {
	s := newReadyStore()

	// Someone waiting, as a request would be.
	waited := make(chan struct{})
	go func() {
		<-s.gridGeometryReady[gridTiersDegrees[0]]
		close(waited)
	}()

	func() {
		defer s.closeAllGridReady()
		defer func() { _ = recover() }()

		panic("polyclip fell over")
	}()

	select {
	case <-waited:
	case <-time.After(2 * time.Second):
		t.Fatal("a waiter was still blocked after the build panicked")
	}
}

// A tier that built before a panic keeps serving. Marking every tier failed would
// turn one bad tier into an outage across all of them.
func TestAPartialFailureLeavesBuiltTiersUsable(t *testing.T) {
	s := newReadyStore()

	built := gridTiersDegrees[0]

	// Mark one tier as built, the way the build does on success.
	s.mu.Lock()
	s.gridGeometryCache = map[float64]map[gridCellKey]json.RawMessage{
		built: {},
	}
	s.mu.Unlock()

	s.recordGridBuildErrForUnbuiltTiers(errors.New("boom"))

	s.mu.RLock()
	defer s.mu.RUnlock()

	if err := s.gridBuildErr[built]; err != nil {
		t.Errorf("tier %.3f built successfully but was marked failed: %v", built, err)
	}
	for _, tier := range gridTiersDegrees[1:] {
		if s.gridBuildErr[tier] == nil {
			t.Errorf("tier %.3f never built but was not marked failed", tier)
		}
	}
}
