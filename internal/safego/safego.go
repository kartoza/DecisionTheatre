// Package safego starts background goroutines that cannot take the process
// with them.
//
// An unrecovered panic in any goroutine kills the whole program — not just that
// goroutine, and not just the request that started it. net/http recovers panics
// raised inside a handler, so a bad request normally costs one connection; but
// the moment a handler hands work to `go func()`, that protection is gone. The
// server had four such goroutines and only one of them recovered, and two of
// the four are started by ordinary requests: creating a site, and extracting
// its indicators. A malformed site was a way to stop the container without
// sending any load at all.
//
// The rule this package exists to enforce: background work is started with
// safego.Run, never with a bare `go func()`. What is lost when one panics is
// that piece of work, which is what should be lost.
package safego

import (
	"fmt"
	"log"
	"runtime/debug"
)

// PanicHandler is called when recovered work panics. Replaced in tests.
var PanicHandler = func(name string, value any, stack []byte) {
	log.Printf("panic in background task %q: %v\n%s", name, value, stack)
}

// Run starts fn in a goroutine, recovering any panic.
//
// `name` identifies the work in the log. Make it specific enough to find the
// code from the message: the point of the log line is that the work silently
// did not happen, and something has to say so.
func Run(name string, fn func()) {
	go Recovered(name, fn)()
}

// Recovered wraps fn so that a panic inside it is logged rather than fatal.
//
// Use it where the goroutine is already being started for another reason — a
// worker pool, an errgroup — and only the recovery is wanted.
func Recovered(name string, fn func()) func() {
	return func() {
		defer func() {
			if r := recover(); r != nil {
				PanicHandler(name, r, debug.Stack())
			}
		}()
		fn()
	}
}

// RunErr is Run for work that reports failure, so a panic and an error are
// handled the same way by the caller rather than one being silent.
func RunErr(name string, fn func() error, onErr func(error)) {
	Run(name, func() {
		if err := fn(); err != nil && onErr != nil {
			onErr(err)
		}
	})
}

// Guard converts a recovered panic into an error, for synchronous work that
// should fail its request rather than the process.
func Guard(name string, fn func() error) (err error) {
	defer func() {
		if r := recover(); r != nil {
			PanicHandler(name, r, debug.Stack())
			err = fmt.Errorf("%s panicked: %v", name, r)
		}
	}()
	return fn()
}
