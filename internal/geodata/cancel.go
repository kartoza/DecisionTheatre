package geodata

import (
	"context"
	"errors"
)

// IsCancellation reports whether err is the caller abandoning the work rather
// than something going wrong.
//
// Every query in this package is reachable from an HTTP handler, and the map
// issues one on every pan and zoom. A user who pans again, closes the tab, or
// hits Escape cancels a request that was already in flight; that is the normal
// operation of the application, not a fault. Work started on its behalf must
// stop, but nothing about it should be logged as an error or counted as one.
//
// Two error shapes have to be recognised, which is why the context is a
// parameter rather than this being a bare errors.Is:
//
//   - database/sql returns context.Canceled directly when the context is
//     already done, and Rows.Err reports it in preference to whatever the
//     driver said when a scan is interrupted part-way.
//   - When SQLite is interrupted mid-statement, go-sqlite3 reports its own
//     "interrupted" error (SQLITE_INTERRUPT), which has no relation to
//     context.Canceled at all. Consulting the context alongside the error
//     covers that case without importing the driver's error type here.
//
// context.DeadlineExceeded is deliberately not treated as a cancellation: a
// query that blew a timeout is a genuine failure worth reporting, whereas a
// user changing their mind is not.
func IsCancellation(ctx context.Context, err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, context.Canceled) {
		return true
	}
	return ctx != nil && errors.Is(ctx.Err(), context.Canceled)
}
