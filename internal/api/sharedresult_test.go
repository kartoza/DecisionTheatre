package api

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The bug being fixed is invisible to a single-caller test: check-then-compute
// returns the right answer every time. It is only wrong in how much work it
// does, and only when more than one caller arrives at once. So every test here
// that matters counts computations rather than checking values.

func TestConcurrentCallersComputeOnce(t *testing.T) {
	var s sharedResult[int]
	var computations atomic.Int64
	started := make(chan struct{})
	release := make(chan struct{})

	const callers = 50
	var wg sync.WaitGroup
	results := make([]int, callers)
	for i := 0; i < callers; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			v, err := s.Get(context.Background(), "test", func() (int, error) {
				computations.Add(1)
				close(started)
				<-release
				return 42, nil
			})
			if err != nil {
				t.Errorf("caller %d: %v", i, err)
			}
			results[i] = v
		}(i)
	}

	<-started
	// Give the other 49 time to arrive and find the computation in flight. This
	// is the window the old code left open, in which each of them would have
	// started its own full-dataset scan.
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if n := computations.Load(); n != 1 {
		t.Errorf("%d computations for %d concurrent callers, want 1 — this is the amplifier", n, callers)
	}
	for i, v := range results {
		if v != 42 {
			t.Errorf("caller %d got %d, want 42: a waiter must get the leader's answer", i, v)
		}
	}
}

func TestLaterCallersUseTheCache(t *testing.T) {
	var s sharedResult[int]
	var computations atomic.Int64
	compute := func() (int, error) { computations.Add(1); return 7, nil }

	for i := 0; i < 5; i++ {
		v, err := s.Get(context.Background(), "test", compute)
		if err != nil || v != 7 {
			t.Fatalf("got %d, %v", v, err)
		}
	}
	if n := computations.Load(); n != 1 {
		t.Errorf("%d computations across 5 sequential calls, want 1", n)
	}
}

func TestAWaiterGivingUpDoesNotCancelTheWork(t *testing.T) {
	// The 26 s computation must survive an impatient reload, or the next
	// arrival starts it again and the endpoint never converges.
	var s sharedResult[int]
	leaderRunning := make(chan struct{})
	release := make(chan struct{})
	leaderDone := make(chan int, 1)

	go func() {
		v, _ := s.Get(context.Background(), "test", func() (int, error) {
			close(leaderRunning)
			<-release
			return 99, nil
		})
		leaderDone <- v
	}()
	<-leaderRunning

	ctx, cancel := context.WithCancel(context.Background())
	waiterDone := make(chan error, 1)
	go func() {
		_, err := s.Get(ctx, "test", func() (int, error) {
			t.Error("a waiter started its own computation")
			return 0, nil
		})
		waiterDone <- err
	}()

	time.Sleep(20 * time.Millisecond)
	cancel()

	select {
	case err := <-waiterDone:
		if !errors.Is(err, context.Canceled) {
			t.Errorf("waiter got %v, want context.Canceled", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the waiter did not return when its caller gave up")
	}

	close(release)
	select {
	case v := <-leaderDone:
		if v != 99 {
			t.Errorf("leader got %d; the work must outlive an impatient waiter", v)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the computation was abandoned when a waiter left")
	}
}

func TestAFailureIsNotCachedForever(t *testing.T) {
	// A transient failure - a locked database, a datapack still installing -
	// must not turn into a permanently broken endpoint.
	var s sharedResult[int]
	var attempts atomic.Int64
	compute := func() (int, error) {
		if attempts.Add(1) == 1 {
			return 0, errors.New("temporarily unavailable")
		}
		return 5, nil
	}

	if _, err := s.Get(context.Background(), "test", compute); err == nil {
		t.Fatal("the first call should have failed")
	}
	v, err := s.Get(context.Background(), "test", compute)
	if err != nil || v != 5 {
		t.Errorf("retry got %d, %v; a failure must be retryable", v, err)
	}
}

func TestConcurrentCallersShareOneFailure(t *testing.T) {
	// They must all be told, and they must not each retry inside the same
	// window - that would be the amplifier again, wearing an error's clothes.
	var s sharedResult[int]
	var computations atomic.Int64
	started := make(chan struct{})
	release := make(chan struct{})
	want := errors.New("nope")

	var wg sync.WaitGroup
	errs := make([]error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			_, errs[i] = s.Get(context.Background(), "test", func() (int, error) {
				computations.Add(1)
				close(started)
				<-release
				return 0, want
			})
		}(i)
	}
	<-started
	time.Sleep(50 * time.Millisecond)
	close(release)
	wg.Wait()

	if n := computations.Load(); n != 1 {
		t.Errorf("%d computations, want 1", n)
	}
	for i, err := range errs {
		if !errors.Is(err, want) {
			t.Errorf("caller %d got %v, want the leader's error", i, err)
		}
	}
}

func TestAPanickingComputationDoesNotStrandWaiters(t *testing.T) {
	// Without recovery in the leader, the in-flight entry is never cleared and
	// its channel never closed: every waiter and every later caller blocks for
	// the life of the process. One bad computation would take the endpoint down
	// permanently.
	var s sharedResult[int]
	done := make(chan error, 1)
	go func() {
		_, err := s.Get(context.Background(), "test", func() (int, error) {
			panic("boom")
		})
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Error("a panic became a nil error, which reads as success")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("a panicking computation left the caller blocked forever")
	}

	// And the endpoint still works afterwards.
	v, err := s.Get(context.Background(), "test", func() (int, error) { return 3, nil })
	if err != nil || v != 3 {
		t.Errorf("got %d, %v; one panic must not be permanent", v, err)
	}
}

func TestInvalidateForcesARecompute(t *testing.T) {
	var s sharedResult[int]
	var computations atomic.Int64
	compute := func() (int, error) { return int(computations.Add(1)), nil }

	if v, _ := s.Get(context.Background(), "test", compute); v != 1 {
		t.Fatalf("got %d", v)
	}
	s.Invalidate()
	if v, _ := s.Get(context.Background(), "test", compute); v != 2 {
		t.Error("Invalidate did not force a recompute")
	}
}

func TestPointerValuesWork(t *testing.T) {
	// The real use is sharedResult[*FullDomainData]; the zero value of a
	// pointer is nil, which must not be mistaken for "not computed yet".
	type payload struct{}
	var s sharedResult[*payload]
	var computations atomic.Int64

	compute := func() (*payload, error) {
		computations.Add(1)
		//nolint:nilnil // the test verifies a nil *payload is itself the cached value, not an absence of one
		return nil, nil
	}
	for i := 0; i < 3; i++ {
		v, err := s.Get(context.Background(), "test", compute)
		if err != nil || v != nil {
			t.Fatalf("got %v, %v", v, err)
		}
	}
	if n := computations.Load(); n != 1 {
		t.Errorf("%d computations; a nil result is still a result", n)
	}
}
