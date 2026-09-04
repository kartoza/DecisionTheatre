package api

import (
	"context"
	"fmt"
	"log"
	"runtime/debug"
	"sync"
)

// sharedResult computes a value once and gives it to everyone who asked.
//
// The pattern it replaces is cache-check-then-compute:
//
//	if cached != nil { return cached }
//	value := expensive()   // <- every concurrent miss runs this
//	cache = value
//
// which is correct for one caller and wrong for two. The window between the
// check and the store is as long as the computation, so on a cold start every
// request that arrives during it starts its own copy. /api/precalculate/full
// measured 26 s cold, so a single page load opening four panes ran the same
// 26 s aggregation four times over the whole dataset, on a four-core box, and
// the last one finished no sooner for it. That is not a slow endpoint; it is
// an amplifier, and pointing any crawler at it turns one request into as many
// full-dataset scans as it can open connections.
//
// Here the first caller computes and the rest wait on the same result. Cost
// goes from N times the work to one, and — the part that matters under load —
// stops being a function of how many people asked.
//
// The zero value is ready to use.
type sharedResult[T any] struct {
	mu       sync.Mutex
	value    T
	ok       bool
	inflight chan struct{}
	err      error
}

// Get returns the cached value, computing it if this is the first call.
//
// ctx bounds the wait, not the work. A caller that gives up releases only
// itself: the computation carries on for whoever is still waiting and for
// everyone who arrives later. Shared work that one request happens to trigger
// must not be thrown away because that particular request lost patience —
// discarding it would leave the next arrival to start the 26 s from scratch,
// which is exactly the behaviour a reload-happy user would produce.
//
// compute is therefore responsible for its own deadline. It is called with no
// context at all so that this is impossible to get wrong by accident.
func (s *sharedResult[T]) Get(ctx context.Context, name string, compute func() (T, error)) (T, error) {
	s.mu.Lock()
	if s.ok {
		v := s.value
		s.mu.Unlock()
		return v, nil
	}
	if wait := s.inflight; wait != nil {
		s.mu.Unlock()
		select {
		case <-wait:
		case <-ctx.Done():
			var zero T
			return zero, ctx.Err()
		}
		s.mu.Lock()
		v, err := s.value, s.err
		s.mu.Unlock()
		return v, err
	}

	// This caller is the leader.
	wait := make(chan struct{})
	s.inflight = wait
	s.mu.Unlock()

	value, err := s.runLeader(name, compute)

	s.mu.Lock()
	s.inflight = nil
	s.err = err
	if err == nil {
		s.value = value
		s.ok = true
	}
	s.mu.Unlock()
	close(wait)

	return value, err
}

// runLeader performs the computation, converting a panic into an error.
//
// Without this a panicking leader would unwind past the bookkeeping above and
// leave `inflight` set with its channel never closed, so every follower — and
// every later caller, since the entry never clears — would block forever. One
// bad computation would take the endpoint down permanently for a reason that
// appears nowhere in the code that looks like caching. The failure has to be
// contained where it happens.
func (s *sharedResult[T]) runLeader(name string, compute func() (T, error)) (value T, err error) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("panic computing %s: %v\n%s", name, r, debug.Stack())
			var zero T
			value = zero
			err = fmt.Errorf("%s failed", name)
		}
	}()
	return compute()
}

// cached reports the stored value without computing one.
//
// For tests that need to distinguish "served from the cache" from "recomputed
// on the way past", which a Get cannot tell you.
func (s *sharedResult[T]) cached() (T, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.value, s.ok
}

// Invalidate drops the cached value so the next Get recomputes.
//
// An in-flight computation is left alone: its callers asked before this, and
// stopping it would only make them wait for a second run of the same work.
func (s *sharedResult[T]) Invalidate() {
	s.mu.Lock()
	var zero T
	s.value, s.ok, s.err = zero, false, nil
	s.mu.Unlock()
}
