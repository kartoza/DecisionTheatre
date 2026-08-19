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
	respondError(w, status, err.Error())
}

// respondCancelled records a request abandoned by its client.
func respondCancelled(w http.ResponseWriter, r *http.Request) {
	log.Printf("[cancelled] %s %s: client disconnected before the response was ready", r.Method, r.URL.Path)
	w.WriteHeader(StatusClientClosedRequest)
}

// clientGone reports whether this request's client has already disconnected.
//
// It exists for the two store calls whose signatures return no error at all
// (GetCatchmentAttributes and ComputeWhiskerBounds): those return an empty
// result for a cancellation exactly as they do for a genuine failure, so the
// handler has to consult the context to know which it is. Giving them error
// returns is the separately-tracked swallowed-error issue; this keeps the
// cancellation path honest in the meantime without touching it.
func clientGone(r *http.Request) bool {
	return errors.Is(r.Context().Err(), context.Canceled)
}
