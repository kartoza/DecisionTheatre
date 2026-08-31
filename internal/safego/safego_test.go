package safego

import (
	"errors"
	"sync"
	"testing"
	"time"
)

// A panic in a goroutine kills the process, not just the goroutine. These tests
// cannot prove that directly — a test that crashed the runner would take the
// suite with it — so what they pin is that the recovery is in place and that
// the failure is reported rather than swallowed. Silence would be the worse
// bug: work that stops happening and says nothing.

func captureHandler(t *testing.T) (*sync.WaitGroup, *[]string) {
	t.Helper()
	var mu sync.Mutex
	var names []string
	var wg sync.WaitGroup

	original := PanicHandler
	t.Cleanup(func() { PanicHandler = original })
	PanicHandler = func(name string, _ any, stack []byte) {
		mu.Lock()
		names = append(names, name)
		mu.Unlock()
		if len(stack) == 0 {
			t.Error("no stack captured; the log would not say where it happened")
		}
		wg.Done()
	}
	return &wg, &names
}

func TestRunRecoversAPanic(t *testing.T) {
	wg, names := captureHandler(t)
	wg.Add(1)

	Run("exploding-task", func() { panic("boom") })

	wg.Wait()
	if len(*names) != 1 || (*names)[0] != "exploding-task" {
		t.Errorf("handler saw %v, want [exploding-task]", *names)
	}
}

func TestRunStillRunsTheWork(t *testing.T) {
	done := make(chan struct{})
	Run("ordinary-task", func() { close(done) })

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("the work never ran; recovery must not stop the happy path")
	}
}

func TestOnePanicDoesNotStopLaterWork(t *testing.T) {
	// The point of the package: one piece of background work failing costs that
	// work and nothing else.
	wg, _ := captureHandler(t)
	wg.Add(1)
	Run("first", func() { panic("boom") })
	wg.Wait()

	done := make(chan struct{})
	Run("second", func() { close(done) })
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("later work did not run")
	}
}

func TestRecoveredWrapsWithoutStarting(t *testing.T) {
	// Recovered hands back a function; it must not run it. Used where the
	// goroutine is started by something else, like a worker pool.
	ran := false
	fn := Recovered("wrapped", func() { ran = true })
	if ran {
		t.Fatal("Recovered ran the work itself")
	}
	fn()
	if !ran {
		t.Error("calling the wrapper did not run the work")
	}
}

func TestRunErrReportsAnError(t *testing.T) {
	got := make(chan error, 1)
	RunErr("failing-task",
		func() error { return errors.New("nope") },
		func(err error) { got <- err })

	select {
	case err := <-got:
		if err == nil || err.Error() != "nope" {
			t.Errorf("got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the error handler was never called")
	}
}

func TestGuardTurnsAPanicIntoAnError(t *testing.T) {
	// For synchronous work: the request fails, the process does not.
	_, _ = captureHandler(t)
	PanicHandler = func(string, any, []byte) {}

	err := Guard("sync-task", func() error { panic("boom") })
	if err == nil {
		t.Fatal("a panic became a nil error, which reads as success")
	}
}

func TestGuardPassesAnOrdinaryErrorThrough(t *testing.T) {
	want := errors.New("ordinary")
	if err := Guard("sync-task", func() error { return want }); !errors.Is(err, want) {
		t.Errorf("got %v, want %v", err, want)
	}
}
