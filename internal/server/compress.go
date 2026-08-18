package server

import (
	"compress/gzip"
	"net/http"
	"strconv"
	"strings"
	"sync"
)

// Response compression.
//
// Searching the server for compression used to find exactly one hit: the tile
// handler, where MBTiles blobs are already gzipped on disk and the header merely
// declares it. No /api response was compressed.
//
// GeoJSON is close to a best case for deflate — repeated key names, repeated
// coordinate digit patterns, long runs of similar floats. Measured against the
// full-Africa choropleth on the real datapack, 5,760,913 bytes:
//
//	level 1: 2,074,170 bytes  2.78x  100ms
//	level 3: 1,934,806 bytes  2.98x  173ms
//	level 5: 1,794,866 bytes  3.21x  230ms
//	level 6: 1,782,908 bytes  3.23x  275ms
//	level 9: 1,773,189 bytes  3.25x  294ms
//
// Level 5 is the choice, for one specific reason: nginx in front of the hosted
// deployment already compresses with gzip_comp_level 6, which produced 1,810,329
// bytes on the same payload. Anything weaker here would be a regression for the
// hosted users this is for, because once we set Content-Encoding nginx passes the
// body through instead of compressing it itself. Level 5 slightly beats what
// nginx was achieving, at a level whose extra cost over 6 and 9 is nil.
const gzipLevel = 5

// compressMinBytes is the response size below which compressing is not worth the
// ~20 bytes of gzip framing, the CPU, or the loss of Content-Length. Matches
// gzip_min_length in deployments/nginx.conf so the two tiers agree.
const compressMinBytes = 1024

// compressibleTypes are the content types worth compressing. Everything absent
// from this list is passed through, which is the safe default: an unknown type is
// more likely to be an already-compressed binary than a compressible text format.
var compressibleTypes = []string{
	"application/json",
	"application/geo+json",
	"application/javascript",
	"image/svg+xml",
	"text/",
}

func isCompressibleType(contentType string) bool {
	ct := strings.ToLower(strings.TrimSpace(strings.Split(contentType, ";")[0]))
	if ct == "" {
		return false
	}
	for _, candidate := range compressibleTypes {
		if strings.HasSuffix(candidate, "/") {
			if strings.HasPrefix(ct, candidate) {
				return true
			}
			continue
		}
		if ct == candidate {
			return true
		}
	}
	return false
}

// acceptsGzip reports whether the client offered gzip.
//
// "gzip;q=0" is a client naming gzip in order to refuse it, and must be honoured.
// The quality is parsed rather than pattern-matched: q=0.01 begins with the same
// characters as q=0.0 but means the opposite — acceptable, barely.
func acceptsGzip(header string) bool {
	for _, part := range strings.Split(header, ",") {
		fields := strings.Split(strings.TrimSpace(part), ";")
		if !strings.EqualFold(strings.TrimSpace(fields[0]), "gzip") {
			continue
		}
		for _, param := range fields[1:] {
			key, value, found := strings.Cut(strings.TrimSpace(param), "=")
			if !found || !strings.EqualFold(strings.TrimSpace(key), "q") {
				continue
			}
			q, err := strconv.ParseFloat(strings.TrimSpace(value), 64)
			if err == nil && q == 0 {
				return false
			}
		}
		return true
	}
	return false
}

var gzipWriterPool = sync.Pool{
	New: func() any {
		zw, err := gzip.NewWriterLevel(nil, gzipLevel)
		if err != nil {
			// Only returned for an invalid level, which is a compile-time
			// constant here, so this cannot happen.
			panic("invalid gzip level: " + strconv.Itoa(gzipLevel))
		}
		return zw
	},
}

// gzipResponseWriter decides whether to compress once it has seen enough of the
// body to know how big it is and what type it is.
//
// The decision cannot be made up front: the handler sets Content-Type as it
// writes, and most do not set Content-Length at all. So the first
// compressMinBytes are buffered, and the header is not sent until either the
// threshold is crossed or the handler finishes.
type gzipResponseWriter struct {
	http.ResponseWriter

	status  int
	buf     []byte
	gz      *gzip.Writer
	decided bool // whether to compress has been settled
	raw     bool // settled as: do not compress
}

func (w *gzipResponseWriter) WriteHeader(status int) {
	// Held back until the decision is made, because that decision changes the
	// headers. Close or the threshold will send it.
	if w.status == 0 {
		w.status = status
	}
}

// hasBody reports whether a status code permits a response body. Compressing a
// 204 or 304 would add a body where the protocol says there is none.
func hasBody(status int) bool {
	switch {
	case status == http.StatusNoContent, status == http.StatusNotModified:
		return false
	case status >= 100 && status < 200:
		return false
	}
	return true
}

// decide settles whether this response is compressed and sends the header.
func (w *gzipResponseWriter) decide() {
	if w.decided {
		return
	}
	w.decided = true

	if w.status == 0 {
		w.status = http.StatusOK
	}
	header := w.Header()

	// Already encoded — the tile handler declares gzip because the blob on disk
	// is gzipped. Compressing again would produce a body no client can read.
	alreadyEncoded := header.Get("Content-Encoding") != ""
	tooSmall := len(w.buf) < compressMinBytes && w.gz == nil

	if alreadyEncoded || !hasBody(w.status) || !isCompressibleType(header.Get("Content-Type")) || tooSmall {
		w.raw = true
		w.ResponseWriter.WriteHeader(w.status)
		return
	}

	header.Set("Content-Encoding", "gzip")
	// The length of the compressed body is not known yet, and the handler's value
	// describes the uncompressed one.
	header.Del("Content-Length")
	w.ResponseWriter.WriteHeader(w.status)

	zw := gzipWriterPool.Get().(*gzip.Writer)
	zw.Reset(w.ResponseWriter)
	w.gz = zw
}

func (w *gzipResponseWriter) Write(p []byte) (int, error) {
	if w.decided {
		if w.raw {
			return w.ResponseWriter.Write(p)
		}
		return w.gz.Write(p)
	}

	w.buf = append(w.buf, p...)
	if len(w.buf) < compressMinBytes {
		// Not enough yet to know whether compressing is worth it.
		return len(p), nil
	}

	w.decide()
	buffered := w.buf
	w.buf = nil
	var err error
	if w.raw {
		_, err = w.ResponseWriter.Write(buffered)
	} else {
		_, err = w.gz.Write(buffered)
	}
	if err != nil {
		return 0, err
	}
	// Report the caller's own length: the bytes it handed over were all accepted,
	// whatever they compressed to.
	return len(p), nil
}

// Flush honours an explicit flush from the handler. Nothing streams today, but a
// wrapper that swallowed Flush would break it silently if something started to.
func (w *gzipResponseWriter) Flush() {
	if !w.decided {
		// A flush means the client wants what there is now, so decide on what has
		// been seen so far rather than waiting for the threshold.
		w.decide()
		if len(w.buf) > 0 {
			buffered := w.buf
			w.buf = nil
			if w.raw {
				_, _ = w.ResponseWriter.Write(buffered)
			} else {
				_, _ = w.gz.Write(buffered)
			}
		}
	}
	if w.gz != nil {
		_ = w.gz.Flush()
	}
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Close finishes the response: sends the header if nothing did, writes out a body
// that stayed under the threshold, and returns the gzip writer to the pool.
func (w *gzipResponseWriter) Close() {
	if !w.decided {
		w.decide()
		if len(w.buf) > 0 {
			_, _ = w.ResponseWriter.Write(w.buf)
			w.buf = nil
		}
		return
	}
	if w.gz != nil {
		_ = w.gz.Close()
		gzipWriterPool.Put(w.gz)
		w.gz = nil
	}
}

// compressResponses gzips responses that are worth gzipping.
//
// It is applied in server mode only; see the call site in Start for why the
// desktop build is excluded.
func compressResponses(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Vary regardless of what this particular request negotiated: a cache
		// keyed without it would serve a gzipped body to a client that cannot
		// read one.
		w.Header().Add("Vary", "Accept-Encoding")

		if !acceptsGzip(r.Header.Get("Accept-Encoding")) {
			next.ServeHTTP(w, r)
			return
		}

		gw := &gzipResponseWriter{ResponseWriter: w}
		defer gw.Close()
		next.ServeHTTP(gw, r)
	})
}
