package server

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// Every JSON handler used to decode straight from r.Body with no cap, and nginx
// passed bodies up to 2 GB, so one POST could make the process buffer two
// gigabytes.

func TestMaxBytesForPath(t *testing.T) {
	cases := map[string]int64{
		// Small: identifiers and numbers.
		"/api/datapack/install": DefaultMaxBodyBytes,
		"/api/datapack/status":  DefaultMaxBodyBytes,
		"/api/metadata/units":   DefaultMaxBodyBytes,
		"/api/health":           DefaultMaxBodyBytes,
		"/api/dialog/open-file": DefaultMaxBodyBytes,
		// A GET carrying no body; the default limit is the right answer.
		"/api/catchments/geometry/1121879850": DefaultMaxBodyBytes,

		// Large: geometry or an inline image.
		"/api/sites":                          LargeMaxBodyBytes,
		"/api/sites/":                         LargeMaxBodyBytes,
		"/api/sites/dissolve-catchments":      LargeMaxBodyBytes,
		"/api/sites/abc-123":                  LargeMaxBodyBytes,
		"/api/sites/abc-123/indicators":       LargeMaxBodyBytes,
		"/api/sites/abc-123/indicators/reset": LargeMaxBodyBytes,
		"/api/sites/abc-123/catchments":       LargeMaxBodyBytes,
	}

	for path, want := range cases {
		if got := maxBytesForPath(path); got != want {
			t.Errorf("maxBytesForPath(%q) = %d, want %d", path, got, want)
		}
	}
}

// A declared oversize is refused before any of it is read, and with the status
// that describes the fault: 413, not 500.
func TestOversizedBodyIsRejectedWith413(t *testing.T) {
	var reached bool
	handler := limitRequestBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		reached = true
		w.WriteHeader(http.StatusOK)
	}))

	body := strings.NewReader(strings.Repeat("x", 16))
	req := httptest.NewRequest(http.MethodPost, "/api/datapack/install", body)
	// Declare more than the limit; the handler must not run.
	req.ContentLength = DefaultMaxBodyBytes + 1

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d", rec.Code, http.StatusRequestEntityTooLarge)
	}
	if reached {
		t.Error("the handler ran for a body that was already too large")
	}
}

// A body within the limit is untouched — the cap must not break normal requests.
func TestBodyWithinLimitPassesThrough(t *testing.T) {
	const payload = `{"path":"/tmp/pack.zip"}`

	var seen string
	handler := limitRequestBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, len(payload))
		n, _ := r.Body.Read(buf)
		seen = string(buf[:n])
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPost, "/api/datapack/install", strings.NewReader(payload))
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200", rec.Code)
	}
	if seen != payload {
		t.Errorf("handler read %q, want %q", seen, payload)
	}
}

// An undeclared body — chunked, no Content-Length — cannot be caught up front,
// so MaxBytesReader must still stop the read. The request is refused either way.
func TestUndeclaredOversizedBodyStopsAtTheLimit(t *testing.T) {
	var readErr error
	var read int

	handler := limitRequestBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		buf := make([]byte, 4096)
		for {
			n, err := r.Body.Read(buf)
			read += n
			if err != nil {
				readErr = err
				return
			}
		}
	}))

	// Twice the limit, with the length hidden.
	req := httptest.NewRequest(http.MethodPost, "/api/datapack/install",
		strings.NewReader(strings.Repeat("x", int(DefaultMaxBodyBytes*2))))
	req.ContentLength = -1

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if readErr == nil {
		t.Fatal("the handler read an unbounded body to completion")
	}
	if int64(read) > DefaultMaxBodyBytes {
		t.Errorf("handler read %d bytes, more than the %d limit", read, DefaultMaxBodyBytes)
	}
}

// The larger allowance must genuinely apply, or saving a site with geometry
// breaks.
func TestLargeLimitAppliesToSiteGeometry(t *testing.T) {
	handler := limitRequestBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// Comfortably over the default limit, comfortably under the large one.
	size := DefaultMaxBodyBytes * 4
	req := httptest.NewRequest(http.MethodPut, "/api/sites/abc-123",
		strings.NewReader(strings.Repeat("x", int(size))))
	req.ContentLength = size

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("a %d-byte site update was refused with %d; the large limit is not applying",
			size, rec.Code)
	}
}

// And the larger allowance is still an allowance.
func TestLargeLimitIsStillBounded(t *testing.T) {
	handler := limitRequestBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodPut, "/api/sites/abc-123", strings.NewReader("x"))
	req.ContentLength = LargeMaxBodyBytes + 1

	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Errorf("status = %d, want %d for a body over the large limit",
			rec.Code, http.StatusRequestEntityTooLarge)
	}
}

// The limits are only meaningful if they are smaller than what nginx passes
// through. This guards the pair from drifting apart.
func TestLimitsAreSaneRelativeToEachOther(t *testing.T) {
	if DefaultMaxBodyBytes >= LargeMaxBodyBytes {
		t.Errorf("the default limit (%d) should be below the large one (%d)",
			DefaultMaxBodyBytes, LargeMaxBodyBytes)
	}
	// 40m in deployments/nginx.conf.
	const nginxLimit int64 = 40 << 20
	if LargeMaxBodyBytes > nginxLimit {
		t.Errorf("LargeMaxBodyBytes (%d) exceeds nginx's client_max_body_size (%d); "+
			"requests would be refused by the proxy with a less useful error",
			LargeMaxBodyBytes, nginxLimit)
	}
}

func TestNoBodyIsNotRejected(t *testing.T) {
	handler := limitRequestBody(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Errorf("a GET with no body was refused with %d", rec.Code)
	}
}

// Guards the shape of the middleware rather than one path: whatever the routing
// looks like later, no path may be unbounded.
func TestEveryPathHasALimit(t *testing.T) {
	for _, p := range []string{
		"/", "/api", "/api/anything", "/api/sites", "/data/images/x.png",
		"/docs/index.html", "/tiles/africa/1/2/3.pbf",
		fmt.Sprintf("/api/%s", strings.Repeat("deep/", 20)),
	} {
		if got := maxBytesForPath(p); got <= 0 {
			t.Errorf("maxBytesForPath(%q) = %d; every path must be bounded", p, got)
		}
	}
}
