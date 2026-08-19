package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
)

// The glyph proxy is the one place in the process that talks to MapTiler, and
// until issue #31 it did so with a key compiled into this file. These tests fix
// the two properties that replaced it: the key comes from configuration, and its
// absence stops the request instead of sending one that says "key=" and nothing
// more.

// recordingTransport answers every request from a canned response and remembers
// what it was asked for, so a test can assert on the upstream URL without
// reaching the network.
type recordingTransport struct {
	mu       sync.Mutex
	requests []*url.URL

	status int
	body   []byte
}

func (rt *recordingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	rt.mu.Lock()
	rt.requests = append(rt.requests, req.URL)
	rt.mu.Unlock()

	status := rt.status
	if status == 0 {
		status = http.StatusOK
	}
	return &http.Response{
		StatusCode: status,
		Body:       io.NopCloser(bytes.NewReader(rt.body)),
		Header:     make(http.Header),
		Request:    req,
	}, nil
}

func (rt *recordingTransport) seen() []*url.URL {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	return append([]*url.URL(nil), rt.requests...)
}

// installTransport points the package's glyph client at a stub for one test.
// Not parallel-safe, deliberately: the client is a package variable, and sharing
// it between concurrent tests would make the recorded requests meaningless.
func installTransport(t *testing.T, rt *recordingTransport) {
	t.Helper()

	original := glyphHTTPClient
	glyphHTTPClient = &http.Client{Transport: rt}
	t.Cleanup(func() { glyphHTTPClient = original })
}

func newGlyphServer(t *testing.T, key string) *Server {
	t.Helper()

	srv, err := New(config.Config{
		Port:        0,
		DataDir:     t.TempDir(),
		Version:     "test",
		MapTilerKey: key,
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return srv
}

// requestGlyphs issues one glyph request through the router, so the route
// pattern and its {fontstack}/{range} variables are exercised too.
func requestGlyphs(t *testing.T, srv *Server, path string) *httptest.ResponseRecorder {
	t.Helper()

	rec := httptest.NewRecorder()
	router := mux.NewRouter()
	router.HandleFunc("/fonts/{fontstack}/{range}.pbf", srv.handleGlyphProxy).Methods("GET")
	router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, path, nil))
	return rec
}

func TestGlyphProxyUsesConfiguredKey(t *testing.T) {
	rt := &recordingTransport{body: []byte("glyph-bytes")}
	installTransport(t, rt)

	srv := newGlyphServer(t, "configured-key")

	rec := requestGlyphs(t, srv, "/fonts/Open%20Sans%20Regular/0-255.pbf")

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	if got := rec.Body.String(); got != "glyph-bytes" {
		t.Errorf("body = %q, want the upstream bytes", got)
	}

	seen := rt.seen()
	if len(seen) != 1 {
		t.Fatalf("made %d upstream requests, want 1", len(seen))
	}
	if key := seen[0].Query().Get("key"); key != "configured-key" {
		t.Errorf("upstream key = %q, want the configured value", key)
	}
	if seen[0].Host != "api.maptiler.com" {
		t.Errorf("upstream host = %q, want api.maptiler.com", seen[0].Host)
	}
}

// The important half. Without a key the handler must not call MapTiler at all:
// a request with an empty key parameter is refused with 403, the proxy would
// swallow that into the same empty response, and the user would be left with an
// unlabelled map and no indication that a setting is missing.
func TestGlyphProxyWithoutKeyMakesNoRequest(t *testing.T) {
	rt := &recordingTransport{body: []byte("must-not-be-fetched")}
	installTransport(t, rt)

	srv := newGlyphServer(t, "")

	rec := requestGlyphs(t, srv, "/fonts/Open%20Sans%20Regular/0-255.pbf")

	if n := len(rt.seen()); n != 0 {
		t.Fatalf("made %d upstream requests with no key configured; the first was %s",
			n, rt.seen()[0])
	}

	// Still a valid, empty answer rather than an error: MapLibre retries a 4xx or
	// 5xx, and draws the map without those labels when handed an empty body.
	if rec.Code != http.StatusOK {
		t.Errorf("status = %d, want 200 so MapLibre stops asking", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("body = %q, want empty", rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/x-protobuf" {
		t.Errorf("Content-Type = %q, want application/x-protobuf", ct)
	}
}

// A key that is only whitespace is a mis-set variable, not a key.
func TestGlyphProxyWhitespaceKeyMakesNoRequest(t *testing.T) {
	rt := &recordingTransport{}
	installTransport(t, rt)

	srv := newGlyphServer(t, "   \n")

	requestGlyphs(t, srv, "/fonts/Open%20Sans%20Regular/0-255.pbf")

	if n := len(rt.seen()); n != 0 {
		t.Fatalf("made %d upstream requests for a whitespace-only key", n)
	}
}

// writeStyle puts a style.json where handleStyleJSON will find it, carrying the
// kind of absolute MapTiler glyphs URL that used to be committed.
func writeStyle(t *testing.T, dataDir, glyphs string) {
	t.Helper()

	dir := filepath.Join(dataDir, "mbtiles")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("creating %s: %v", dir, err)
	}
	style := map[string]any{
		"version": 8,
		"name":    "test",
		"sources": map[string]any{"t": map[string]any{"type": "vector", "url": "http://elsewhere/tiles.json"}},
		"glyphs":  glyphs,
		"layers":  []any{},
	}
	data, err := json.Marshal(style)
	if err != nil {
		t.Fatalf("marshalling style: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "style.json"), data, 0o644); err != nil {
		t.Fatalf("writing style.json: %v", err)
	}
}

func servedStyle(t *testing.T, srv *Server) map[string]any {
	t.Helper()

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/data/style.json", nil)
	req.Host = "localhost:8080"
	srv.handleStyleJSON(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("style status = %d, want 200", rec.Code)
	}
	var style map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &style); err != nil {
		t.Fatalf("style is not JSON: %v", err)
	}
	return style
}

// There is exactly one place the key is injected, and the style is not it.
//
// The browser only ever reads the style through this handler, which rewrites
// glyphs to the local proxy — so a key in the style file on disk was never used
// for anything, and shipping the served style with a key in it would hand it to
// every client for no benefit. The proxy holds the key; the style points at the
// proxy.
func TestServedStyleCarriesLocalProxyNotTheKey(t *testing.T) {
	dataDir := t.TempDir()
	writeStyle(t, dataDir, "https://api.maptiler.com/fonts/{fontstack}/{range}.pbf?key=leaked-key")

	srv, err := New(config.Config{
		Port:        0,
		DataDir:     dataDir,
		Version:     "test",
		MapTilerKey: "configured-key",
	})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	style := servedStyle(t, srv)

	glyphs, _ := style["glyphs"].(string)
	if glyphs != "http://localhost:8080/fonts/{fontstack}/{range}.pbf" {
		t.Errorf("glyphs = %q, want the local proxy URL", glyphs)
	}
	if strings.Contains(glyphs, "key=") {
		t.Errorf("glyphs = %q leaks a key parameter to the browser", glyphs)
	}

	// Belt and braces over the whole document: neither the key on disk nor the
	// configured one may reach the client by any other field.
	body, _ := json.Marshal(style)
	for _, secret := range []string{"leaked-key", "configured-key", "api.maptiler.com"} {
		if bytes.Contains(body, []byte(secret)) {
			t.Errorf("served style contains %q:\n%s", secret, body)
		}
	}
}

// The proxy still has to be reachable from the style when no key is configured:
// MapLibre needs a glyphs URL for its symbol layers, and the empty responses are
// what let it render the map without labels rather than fail.
func TestServedStyleStillPointsAtProxyWithoutKey(t *testing.T) {
	dataDir := t.TempDir()
	writeStyle(t, dataDir, "/fonts/{fontstack}/{range}.pbf")

	srv, err := New(config.Config{Port: 0, DataDir: dataDir, Version: "test"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	style := servedStyle(t, srv)

	if glyphs, _ := style["glyphs"].(string); glyphs != "http://localhost:8080/fonts/{fontstack}/{range}.pbf" {
		t.Errorf("glyphs = %q, want the local proxy URL", glyphs)
	}
}
