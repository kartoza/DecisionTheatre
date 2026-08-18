package server

import (
	"net/http"
	"strings"

	"github.com/kartoza/decision-theatre/internal/httputil"
)

// Request body limits.
//
// Every JSON handler decoded straight from r.Body with no cap, and nginx was
// configured to pass bodies up to 2 GB, so one POST could make the process
// buffer two gigabytes. There is no legitimate request anywhere near that size.
//
// The limits below are generous against real payloads and small against an
// attack. Raise one only with a payload that needs it, and say which.
const (
	// DefaultMaxBodyBytes covers every JSON handler: a few identifiers, some
	// numbers, occasionally a list of catchment ids.
	DefaultMaxBodyBytes int64 = 1 << 20 // 1 MiB

	// LargeMaxBodyBytes covers the handlers that carry geometry or an inline
	// image. A site boundary drawn by hand is tens of kilobytes; one dissolved
	// from several hundred catchments, or a base64 thumbnail, is larger.
	//
	// Measured against the fixtures in this repository the worst case is a few
	// megabytes, so this leaves roughly an order of magnitude of headroom.
	LargeMaxBodyBytes int64 = 32 << 20 // 32 MiB
)

// largeBodyPaths are the request paths allowed LargeMaxBodyBytes.
//
// Matched as suffixes on the cleaned path so the {id} segment does not need
// enumerating. Deliberately a list rather than a prefix on /api: an endpoint
// gets the larger allowance by being named here, not by accident.
var largeBodyPaths = []string{
	"/sites",                     // create, with geometry
	"/sites/dissolve-catchments", // a list of catchment ids in, geometry out
}

// largeBodySuffixes are path endings allowed LargeMaxBodyBytes, so that
// /api/sites/{id} and /api/sites/{id}/indicators do not need the id spelled out.
var largeBodySuffixes = []string{
	"/indicators",
	"/catchments",
}

// maxBytesForPath returns the limit that applies to a request path.
func maxBytesForPath(path string) int64 {
	trimmed := strings.TrimSuffix(path, "/")

	for _, p := range largeBodyPaths {
		if trimmed == p || strings.HasSuffix(trimmed, p) {
			return LargeMaxBodyBytes
		}
	}
	for _, suffix := range largeBodySuffixes {
		if strings.HasSuffix(trimmed, suffix) {
			return LargeMaxBodyBytes
		}
	}

	// An /api/sites/{id} update carries the whole site, geometry included.
	if strings.Contains(trimmed, "/sites/") {
		return LargeMaxBodyBytes
	}

	return DefaultMaxBodyBytes
}

// limitRequestBody caps how much a handler can read from a request.
//
// http.MaxBytesReader makes the read fail past the limit rather than letting the
// handler buffer without bound. On its own that surfaces as a decode error and a
// 500, which describes the wrong thing: the request is at fault, not the server.
// So the limit is also checked against Content-Length up front, where it is
// declared, and answered with 413.
//
// A chunked request declares no length. MaxBytesReader still stops the read, and
// the handler's decode error is then a 400 rather than a 413 — the request is
// still refused, which is what matters.
func limitRequestBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Body == nil || r.Body == http.NoBody {
			next.ServeHTTP(w, r)
			return
		}

		limit := maxBytesForPath(r.URL.Path)

		// Refuse a declared oversize before reading a byte of it.
		if r.ContentLength > limit {
			httputil.RespondError(w, http.StatusRequestEntityTooLarge,
				"request body is too large")
			return
		}

		r.Body = http.MaxBytesReader(w, r.Body, limit)
		next.ServeHTTP(w, r)
	})
}
