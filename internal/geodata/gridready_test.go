package geodata

import (
	"errors"
	"testing"
	"time"
)

// Low-zoom choropleth requests once blocked on a bare channel receive with no
// context and no timeout. The channel is closed by the grid-geometry build,
// whose workers had no recover() — and a panic there did not merely lose a cell:
// the goroutine died without sending, so wg.Wait never returned, the results
// channel was never closed, and the tier's ready channel never closed either.
// Every subsequent low-zoom request then blocked forever, accumulating
// goroutines until the process died.
//
// These tests were originally written against a per-tier sync.Once design on
// this branch. Main replaced that with mutex-guarded state that also makes a
// failed build retryable, which is the better answer, so the tests now assert
// the guarantees rather than the mechanism — every one of them would still have
// caught the original hang.

// newReadyStore builds the readiness machinery without opening a geopackage.
func newReadyStore() (*GpkgStore, map[float64]chan struct{}) {
	ready := make(map[float64]chan struct{}, len(gridTiersDegrees))
	for _, tier := range gridTiersDegrees {
		ready[tier] = make(chan struct{})
	}
	return &GpkgStore{gridGeometryReady: ready}, ready
}

func isClosed(t *testing.T, ch chan struct{}) bool {
	t.Helper()
	select {
	case <-ch:
		return true
	case <-time.After(2 * time.Second):
		return false
	}
}

// A failed build must release every waiter. This is the guarantee that turns a
// hang into an error, and it is the whole reason the failure path exists.
func TestAFailedBuildReleasesEveryTier(t *testing.T) {
	s, ready := newReadyStore()

	s.failGridGeometryCache(ready, errors.New("the datapack could not be read"))

	for _, tier := range gridTiersDegrees {
		if !isClosed(t, ready[tier]) {
			t.Errorf("tier %.3f still has waiters blocked after a failed build", tier)
		}
	}
}

// A failure after some tiers have already completed must not panic.
//
// The success path closes each tier as it finishes; the failure path closes all
// of them. Today every failure happens before the per-tier loop begins, so the
// two cannot overlap — but that is a property of where the calls sit, not of the
// code, and the cost of it changing is a panic in the build goroutine rather
// than an error a caller can see.
func TestAFailureAfterAPartialBuildDoesNotPanic(t *testing.T) {
	s, ready := newReadyStore()

	// The first tier completed before the failure, exactly as the success path
	// would have left it.
	close(ready[gridTiersDegrees[0]])

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("a partial build followed by a failure panicked: %v", r)
		}
	}()
	s.failGridGeometryCache(ready, errors.New("failed part way through"))

	for _, tier := range gridTiersDegrees {
		if !isClosed(t, ready[tier]) {
			t.Errorf("tier %.3f still has waiters blocked", tier)
		}
	}
}

// The error is recorded, so a request can say the build failed rather than
// return an empty result that reads as "there is no data here".
func TestAFailedBuildRecordsWhy(t *testing.T) {
	s, ready := newReadyStore()
	want := errors.New("no such column: geojson")

	s.failGridGeometryCache(ready, want)

	s.mu.RLock()
	got := s.gridGeometryErr
	building := s.gridGeometryBuilding
	s.mu.RUnlock()

	if !errors.Is(got, want) {
		t.Errorf("gridGeometryErr = %v, want %v", got, want)
	}
	// Cleared so the next request can try again. A failed build that stays
	// marked in-progress is the permanent breakage this replaced.
	if building {
		t.Error("still marked as building after a failure, so nothing would retry")
	}
}
