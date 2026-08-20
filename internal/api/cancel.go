package api

import (
	"context"
	"errors"
	"log"
	"net/http"

	"github.com/kartoza/decision-theatre/internal/geodata"
)

// StatusClientClosedRequest is nginx's non-standard 499, used here for a
// request whose client disconnected before the answer was ready.
//
// Nothing reads the status: the connection is already gone, and net/http
// discards the write. It exists so that the outcome is visible where outcomes
// are recorded - access logs, tests, and any future metrics middleware - as
// something other than the 200 or 500 it would otherwise be indistinguishable
// from. A cancelled request must never land in the error bucket, because the
// error bucket is what someone pages on.
const StatusClientClosedRequest = 499

// respondStoreError writes the response for an error returned by a data-store
// call, separating "the client went away" from "the query failed".
//
// A cancellation is reported at info level and never as an error, and carries
// no message body: there is no one left to read it, and a body would only
// serve to make a routine disconnect look like a server fault in a log
// aggregator.
func respondStoreError(w http.ResponseWriter, r *http.Request, status int, err error) {
	if geodata.IsCancellation(r.Context(), err) {
		respondCancelled(w, r)
		return
	}
	// Asking for more per-catchment records than the API will serve is the
	// client asking for the wrong thing, not the server failing. 413 with the
	// limit in the message says so, and says it in a way a caller can act on
	// by switching to the aggregate summary.
	if errors.Is(err, geodata.ErrTooManyCatchments) {
		respondError(w, http.StatusRequestEntityTooLarge, err.Error())
		return
	}
	respondError(w, status, err.Error())
}

// respondCancelled records a request abandoned by its client.
func respondCancelled(w http.ResponseWriter, r *http.Request) {
	log.Printf("[cancelled] %s %s: client disconnected before the response was ready", r.Method, r.URL.Path)
	w.WriteHeader(StatusClientClosedRequest)
}

// clientGone reports whether this request's client has already disconnected.
//
// Both of the store calls it was written for - GetCatchmentAttributes and
// ComputeWhiskerBounds - now return errors, so a cancellation reaches the
// handler as one. It is kept as a belt-and-braces check on the paths that
// persist their result: a request whose client has already gone must not have
// its answer cached onto the site, and the context is the only thing that
// knows.
func clientGone(r *http.Request) bool {
	return errors.Is(r.Context().Err(), context.Canceled)
}
