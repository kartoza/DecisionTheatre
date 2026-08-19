package server

import (
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/gorilla/mux"
)

// No /api response was compressed, and GeoJSON is close to a best case for
// deflate. Measured on the real datapack, the full-Africa choropleth is 5,760,913
// bytes and compresses to 1,794,866 at the level used here.

// bigJSON returns a payload above the threshold that compresses well, in the
// shape these endpoints actually return.
func bigJSON() string {
	var b strings.Builder
	b.WriteString(`{"ids":[`)
	for i := 0; i < 4000; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString("1121879850")
	}
	b.WriteString(`],"values":[`)
	for i := 0; i < 4000; i++ {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString("412.3")
	}
	b.WriteString(`]}`)
	return b.String()
}

func jsonHandler(body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	})
}

func get(t *testing.T, h http.Handler, path, acceptEncoding string) *httptest.ResponseRecorder {
	t.Helper()

	req := httptest.NewRequest(http.MethodGet, path, nil)
	if acceptEncoding != "" {
		req.Header.Set("Accept-Encoding", acceptEncoding)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestLargeJSONIsCompressed(t *testing.T) {
	body := bigJSON()
	rec := get(t, compressResponses(jsonHandler(body)), "/api/choropleth", "gzip")

	if enc := rec.Header().Get("Content-Encoding"); enc != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", enc)
	}
	if rec.Body.Len() >= len(body) {
		t.Errorf("compressed body is %d bytes against %d raw — no saving",
			rec.Body.Len(), len(body))
	}

	// And it must actually be readable gzip of exactly the original.
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("body is not valid gzip: %v", err)
	}
	got, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("reading the gzip body: %v", err)
	}
	if string(got) != body {
		t.Errorf("round trip lost data: got %d bytes, want %d", len(got), len(body))
	}
	t.Logf("%d bytes -> %d (%.2fx)", len(body), rec.Body.Len(),
		float64(len(body))/float64(rec.Body.Len()))
}

// Below the threshold the framing and the lost Content-Length cost more than the
// saving.
func TestSmallResponseIsNotCompressed(t *testing.T) {
	body := `{"status":"ok"}`
	rec := get(t, compressResponses(jsonHandler(body)), "/api/health", "gzip")

	if enc := rec.Header().Get("Content-Encoding"); enc != "" {
		t.Errorf("Content-Encoding = %q for a %d-byte body", enc, len(body))
	}
	if rec.Body.String() != body {
		t.Errorf("body = %q, want %q", rec.Body.String(), body)
	}
}

// The tile handler declares gzip because the MBTiles blob on disk is already
// gzipped. Compressing it again would produce a body no client can read.
func TestAlreadyEncodedResponseIsNotRecompressed(t *testing.T) {
	payload := strings.Repeat("pretend this is a gzipped tile blob", 200)

	h := compressResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.Header().Set("Content-Encoding", "gzip")
		_, _ = w.Write([]byte(payload))
	}))
	rec := get(t, h, "/tiles/africa/1/2/3.pbf", "gzip")

	if rec.Body.String() != payload {
		t.Error("an already-encoded body was altered; it would be double-compressed")
	}
	if got := rec.Header().Values("Content-Encoding"); len(got) != 1 {
		t.Errorf("Content-Encoding = %v, want exactly one value", got)
	}
}

func TestBinaryContentTypeIsNotCompressed(t *testing.T) {
	payload := strings.Repeat("x", 8192)

	for _, ct := range []string{
		"application/octet-stream",
		"application/zip",
		"image/png",
		"application/x-protobuf",
	} {
		h := compressResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", ct)
			_, _ = w.Write([]byte(payload))
		}))
		rec := get(t, h, "/api/datapack/download", "gzip")

		if enc := rec.Header().Get("Content-Encoding"); enc != "" {
			t.Errorf("%s was compressed (Content-Encoding %q)", ct, enc)
		}
	}
}

func TestNoCompressionWithoutAcceptEncoding(t *testing.T) {
	body := bigJSON()

	for _, header := range []string{"", "identity", "br", "gzip;q=0"} {
		rec := get(t, compressResponses(jsonHandler(body)), "/api/choropleth", header)

		if enc := rec.Header().Get("Content-Encoding"); enc != "" {
			t.Errorf("Accept-Encoding %q produced Content-Encoding %q", header, enc)
		}
		if rec.Body.String() != body {
			t.Errorf("Accept-Encoding %q: body was altered", header)
		}
	}
}

func TestAcceptsGzip(t *testing.T) {
	cases := map[string]bool{
		"gzip":                      true,
		"gzip, deflate":             true,
		"deflate, gzip;q=1.0":       true,
		"br;q=1.0, gzip;q=0.8":      true,
		"GZIP":                      true,
		" gzip ":                    true,
		"identity":                  false,
		"":                          false,
		"br":                        false,
		"gzip;q=0":                  false,
		"gzip;q=0.0":                false,
		"deflate, gzip;q=0":         false,
		"x-gzip":                    false, // deliberately not treated as gzip
		"identity;q=1, gzip;q=0.01": true,
	}

	for header, want := range cases {
		if got := acceptsGzip(header); got != want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", header, got, want)
		}
	}
}

// A cache that keyed on the URL alone would hand a gzipped body to a client that
// asked for identity. Vary must be set either way, not only when compressing.
func TestVaryIsAlwaysSet(t *testing.T) {
	for _, header := range []string{"gzip", "identity", ""} {
		rec := get(t, compressResponses(jsonHandler(bigJSON())), "/api/choropleth", header)

		if !strings.Contains(rec.Header().Get("Vary"), "Accept-Encoding") {
			t.Errorf("Accept-Encoding %q: Vary = %q, want it to include Accept-Encoding",
				header, rec.Header().Get("Vary"))
		}
	}
}

// The handler's Content-Length describes the uncompressed body. Left in place it
// would contradict the bytes on the wire.
func TestContentLengthIsRemovedWhenCompressing(t *testing.T) {
	body := bigJSON()
	h := compressResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Content-Length", strconv.Itoa(len(body)))
		_, _ = w.Write([]byte(body))
	}))
	rec := get(t, h, "/api/choropleth", "gzip")

	if got := rec.Header().Get("Content-Length"); got != "" {
		t.Errorf("Content-Length = %q on a compressed response, describing the uncompressed body", got)
	}
}

// A 304 has no body by definition; adding a gzip member would invent one.
func TestStatusesWithoutABodyAreNotCompressed(t *testing.T) {
	for _, status := range []int{http.StatusNoContent, http.StatusNotModified} {
		h := compressResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
		}))
		rec := get(t, h, "/api/thing", "gzip")

		if rec.Code != status {
			t.Errorf("status = %d, want %d", rec.Code, status)
		}
		if enc := rec.Header().Get("Content-Encoding"); enc != "" {
			t.Errorf("status %d got Content-Encoding %q", status, enc)
		}
		if rec.Body.Len() != 0 {
			t.Errorf("status %d got a %d-byte body", status, rec.Body.Len())
		}
	}
}

// http.ServeContent answers a Range request with 206, a Content-Length for just
// that slice, and a Content-Range naming uncompressed offsets. Gzipping the slice
// invalidates all three: the bytes are no longer a standalone gzip stream, and
// Content-Range would still describe the pre-compression file. This is what
// produced ERR_HTTP2_PROTOCOL_ERROR for embedded frontend assets in production.
func TestPartialContentIsNotCompressed(t *testing.T) {
	body := bigJSON()
	h := compressResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/javascript")
		w.Header().Set("Content-Range", "bytes 0-99/"+strconv.Itoa(len(body)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte(body[:100]))
	}))
	rec := get(t, h, "/assets/chakra-CdCWquJF.js", "gzip")

	if rec.Code != http.StatusPartialContent {
		t.Errorf("status = %d, want 206", rec.Code)
	}
	if enc := rec.Header().Get("Content-Encoding"); enc != "" {
		t.Errorf("Content-Encoding = %q on a 206, would corrupt the range framing", enc)
	}
	if rec.Body.String() != body[:100] {
		t.Error("206 body was altered")
	}
}

// The status the handler chose must survive, or an error becomes a 200.
func TestStatusCodeIsPreserved(t *testing.T) {
	body := bigJSON()
	h := compressResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(body))
	}))
	rec := get(t, h, "/api/choropleth", "gzip")

	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", rec.Code)
	}
	if rec.Header().Get("Content-Encoding") != "gzip" {
		t.Error("a large error body should still be compressed")
	}
}

// A handler writing in many small pieces — json.Encoder does this — must produce
// the same bytes as one that writes at once.
func TestManySmallWritesRoundTrip(t *testing.T) {
	chunks := 500
	chunk := strings.Repeat("abcdefgh", 8)

	h := compressResponses(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		for i := 0; i < chunks; i++ {
			_, _ = w.Write([]byte(chunk))
		}
	}))
	rec := get(t, h, "/api/choropleth", "gzip")

	if rec.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("not compressed: %q", rec.Header().Get("Content-Encoding"))
	}
	zr, err := gzip.NewReader(rec.Body)
	if err != nil {
		t.Fatalf("invalid gzip: %v", err)
	}
	got, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("reading: %v", err)
	}
	if want := strings.Repeat(chunk, chunks); string(got) != want {
		t.Errorf("round trip differs: %d bytes, want %d", len(got), len(want))
	}
}

func TestIsCompressibleType(t *testing.T) {
	cases := map[string]bool{
		"application/json":                true,
		"application/json; charset=utf-8": true,
		"APPLICATION/JSON":                true,
		"application/geo+json":            true,
		"text/html":                       true,
		"text/plain; charset=utf-8":       true,
		"image/svg+xml":                   true,
		"application/javascript":          true,
		"application/x-protobuf":          false,
		"image/png":                       false,
		"application/zip":                 false,
		"application/octet-stream":        false,
		"":                                false,
		"application/json-but-not-really": false,
		"font/woff2":                      false,
	}

	for ct, want := range cases {
		if got := isCompressibleType(ct); got != want {
			t.Errorf("isCompressibleType(%q) = %v, want %v", ct, got, want)
		}
	}
}

// Compression is applied in server mode only: desktop reaches the server over
// loopback, where it would cost CPU to speed up nothing.
func TestCompressionAppliedInServerModeOnly(t *testing.T) {
	for _, mode := range []struct {
		name     string
		desktop  bool
		wantGzip bool
	}{
		{"server", false, true},
		{"desktop", true, false},
	} {
		srv := newTestServer(t, mode.desktop)
		// A route with a body big enough to cross the threshold.
		srv.setRouter(muxWithBigJSON())
		handler := srv.rootHandler()

		rec := get(t, handler, "/api/choropleth", "gzip")
		gotGzip := rec.Header().Get("Content-Encoding") == "gzip"

		if gotGzip != mode.wantGzip {
			t.Errorf("%s mode: compressed = %v, want %v", mode.name, gotGzip, mode.wantGzip)
		}
	}
}

// muxWithBigJSON is a router with one route returning a compressible payload.
func muxWithBigJSON() *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/api/choropleth", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(bigJSON()))
	})
	return r
}

// The nginx thresholds and the application's must agree, or a response is
// compressed by one tier and not the other for no stated reason.
func TestThresholdMatchesNginx(t *testing.T) {
	conf, err := os.ReadFile(filepath.Join("..", "..", "deployments", "nginx.conf"))
	if err != nil {
		t.Skipf("could not read nginx.conf: %v", err)
	}
	want := "gzip_min_length " + strconv.Itoa(compressMinBytes) + ";"
	if !strings.Contains(string(conf), want) {
		t.Errorf("nginx.conf does not contain %q; the two tiers disagree on what is worth compressing", want)
	}
}
