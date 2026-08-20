package server

import (
	"bytes"
	"compress/gzip"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// writeStatic puts a file of n bytes of compressible JSON-ish content on disk and
// returns the directory holding it.
func writeStatic(t *testing.T, name string, n int) string {
	t.Helper()
	dir := t.TempDir()
	body := strings.Repeat(`{"catchmentId":"1121879850","value":12.5},`, 1+n/42)
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func getStatic(t *testing.T, h http.Handler, path string, hdr map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func gunzip(t *testing.T, b []byte) []byte {
	t.Helper()
	zr, err := gzip.NewReader(bytes.NewReader(b))
	if err != nil {
		t.Fatalf("response is not valid gzip: %v", err)
	}
	out, err := io.ReadAll(zr)
	if err != nil {
		t.Fatalf("gzip body truncated: %v", err)
	}
	return out
}

// The point of the type: a second request must not repeat the compression.
func TestCompressedStaticCompressesOnce(t *testing.T) {
	dir := writeStatic(t, "tour.json", 200_000)
	h := newCompressedStatic(http.Dir(dir))

	for i := 0; i < 5; i++ {
		rec := getStatic(t, h, "/tour.json", map[string]string{"Accept-Encoding": "gzip"})
		if rec.Code != http.StatusOK {
			t.Fatalf("request %d: status %d", i, rec.Code)
		}
		if got := rec.Header().Get("Content-Encoding"); got != "gzip" {
			t.Fatalf("request %d: Content-Encoding %q, want gzip", i, got)
		}
	}
	if got := h.compressions.Load(); got != 1 {
		t.Errorf("compressed %d times over 5 requests, want 1", got)
	}
}

// A cached body must still be the file's content, not merely the right length.
func TestCompressedStaticServesTheFileContent(t *testing.T) {
	dir := writeStatic(t, "tour.json", 200_000)
	want, err := os.ReadFile(filepath.Join(dir, "tour.json"))
	if err != nil {
		t.Fatal(err)
	}
	h := newCompressedStatic(http.Dir(dir))

	// Twice: the second read comes from the cache, which is the one that could
	// diverge from the file without anyone noticing.
	for i := 0; i < 2; i++ {
		rec := getStatic(t, h, "/tour.json", map[string]string{"Accept-Encoding": "gzip"})
		if got := gunzip(t, rec.Body.Bytes()); !bytes.Equal(got, want) {
			t.Fatalf("request %d: served %d bytes, want %d", i, len(got), len(want))
		}
	}
}

// A datapack install replaces the file. Serving the previous body would be a
// correctness bug bought with latency.
func TestCompressedStaticInvalidatesWhenTheFileChanges(t *testing.T) {
	dir := writeStatic(t, "tour.json", 200_000)
	path := filepath.Join(dir, "tour.json")
	h := newCompressedStatic(http.Dir(dir))

	getStatic(t, h, "/tour.json", map[string]string{"Accept-Encoding": "gzip"})

	updated := []byte(strings.Repeat(`{"catchmentId":"9999999999","value":99.9},`, 5000))
	if err := os.WriteFile(path, updated, 0o644); err != nil {
		t.Fatal(err)
	}
	// Some filesystems carry coarse timestamps; make the change unambiguous the
	// way a real install would, rather than relying on the clock's resolution.
	future := time.Now().Add(2 * time.Second)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatal(err)
	}

	rec := getStatic(t, h, "/tour.json", map[string]string{"Accept-Encoding": "gzip"})
	if got := gunzip(t, rec.Body.Bytes()); !bytes.Equal(got, updated) {
		t.Error("served the previous datapack's body after the file changed")
	}
	if got := h.compressions.Load(); got != 2 {
		t.Errorf("compressed %d times, want 2 (once per version)", got)
	}
}

// Revalidation worked before this type existed and must keep working: it is what
// makes a repeat visit cost 4 ms instead of 100.
func TestCompressedStaticAnswers304(t *testing.T) {
	dir := writeStatic(t, "tour.json", 200_000)
	h := newCompressedStatic(http.Dir(dir))

	first := getStatic(t, h, "/tour.json", map[string]string{"Accept-Encoding": "gzip"})
	lastMod := first.Header().Get("Last-Modified")
	if lastMod == "" {
		t.Fatal("no Last-Modified, so a client cannot revalidate")
	}

	rec := getStatic(t, h, "/tour.json", map[string]string{
		"Accept-Encoding":   "gzip",
		"If-Modified-Since": lastMod,
	})
	if rec.Code != http.StatusNotModified {
		t.Errorf("status %d, want 304", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("304 carried %d bytes of body", rec.Body.Len())
	}
}

// A client that did not offer gzip must not be handed a compressed body.
func TestCompressedStaticHonoursAcceptEncoding(t *testing.T) {
	dir := writeStatic(t, "tour.json", 200_000)
	want, err := os.ReadFile(filepath.Join(dir, "tour.json"))
	if err != nil {
		t.Fatal(err)
	}
	h := newCompressedStatic(http.Dir(dir))

	for _, ae := range []string{"", "identity", "gzip;q=0"} {
		hdr := map[string]string{}
		if ae != "" {
			hdr["Accept-Encoding"] = ae
		}
		rec := getStatic(t, h, "/tour.json", hdr)
		if got := rec.Header().Get("Content-Encoding"); got != "" {
			t.Errorf("Accept-Encoding %q: Content-Encoding %q, want none", ae, got)
		}
		if !bytes.Equal(rec.Body.Bytes(), want) {
			t.Errorf("Accept-Encoding %q: body is not the file", ae)
		}
	}
}

// Vary is what stops a shared cache handing a compressed body to a client that
// cannot read one.
func TestCompressedStaticSetsVary(t *testing.T) {
	dir := writeStatic(t, "tour.json", 200_000)
	h := newCompressedStatic(http.Dir(dir))

	rec := getStatic(t, h, "/tour.json", map[string]string{"Accept-Encoding": "gzip"})
	if got := rec.Header().Get("Vary"); !strings.Contains(got, "Accept-Encoding") {
		t.Errorf("Vary %q, want it to name Accept-Encoding", got)
	}
}

// Below the threshold the framing costs more than it saves, and the existing
// middleware already declines. This must agree with it.
func TestCompressedStaticSkipsSmallFiles(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "small.json"), []byte(`{"a":1}`), 0o644); err != nil {
		t.Fatal(err)
	}
	h := newCompressedStatic(http.Dir(dir))

	rec := getStatic(t, h, "/small.json", map[string]string{"Accept-Encoding": "gzip"})
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding %q on a %d-byte file, want none", got, 7)
	}
	if got := h.compressions.Load(); got != 0 {
		t.Errorf("compressed %d small files, want 0", got)
	}
}

// An already-compressed format gains nothing and costs CPU.
func TestCompressedStaticSkipsIncompressibleTypes(t *testing.T) {
	dir := t.TempDir()
	blob := bytes.Repeat([]byte{0x89, 0x50, 0x4e, 0x47}, 20_000)
	if err := os.WriteFile(filepath.Join(dir, "image.png"), blob, 0o644); err != nil {
		t.Fatal(err)
	}
	h := newCompressedStatic(http.Dir(dir))

	rec := getStatic(t, h, "/image.png", map[string]string{"Accept-Encoding": "gzip"})
	if got := rec.Header().Get("Content-Encoding"); got != "" {
		t.Errorf("Content-Encoding %q on a PNG, want none", got)
	}
	if got := h.compressions.Load(); got != 0 {
		t.Errorf("compressed %d PNGs, want 0", got)
	}
}

// A missing file is the plain handler's answer to give, unchanged.
func TestCompressedStaticMissingFile(t *testing.T) {
	h := newCompressedStatic(http.Dir(t.TempDir()))
	rec := getStatic(t, h, "/nope.json", map[string]string{"Accept-Encoding": "gzip"})
	if rec.Code != http.StatusNotFound {
		t.Errorf("status %d, want 404", rec.Code)
	}
}

// Over the limit the body is still correct; only the retention is skipped. The
// failure mode has to be the old behaviour, never a wrong answer.
func TestCompressedStaticOverLimitStillServes(t *testing.T) {
	dir := writeStatic(t, "tour.json", 200_000)
	want, err := os.ReadFile(filepath.Join(dir, "tour.json"))
	if err != nil {
		t.Fatal(err)
	}
	h := newCompressedStatic(http.Dir(dir))
	h.limitB = 1 // nothing can fit

	for i := 0; i < 2; i++ {
		rec := getStatic(t, h, "/tour.json", map[string]string{"Accept-Encoding": "gzip"})
		if got := gunzip(t, rec.Body.Bytes()); !bytes.Equal(got, want) {
			t.Fatalf("request %d: body is not the file", i)
		}
	}
	if got := h.compressions.Load(); got != 2 {
		t.Errorf("compressed %d times with the cache disabled, want 2", got)
	}
	if h.usedB != 0 {
		t.Errorf("retained %d bytes despite the limit", h.usedB)
	}
}

// The handler is shared across request goroutines; -race is the point of this.
func TestCompressedStaticConcurrent(t *testing.T) {
	dir := writeStatic(t, "tour.json", 200_000)
	want, err := os.ReadFile(filepath.Join(dir, "tour.json"))
	if err != nil {
		t.Fatal(err)
	}
	h := newCompressedStatic(http.Dir(dir))

	var wg sync.WaitGroup
	for i := 0; i < 24; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			req := httptest.NewRequest(http.MethodGet, "/tour.json", nil)
			req.Header.Set("Accept-Encoding", "gzip")
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != http.StatusOK {
				t.Errorf("status %d", rec.Code)
			}
		}()
	}
	wg.Wait()

	rec := getStatic(t, h, "/tour.json", map[string]string{"Accept-Encoding": "gzip"})
	if got := gunzip(t, rec.Body.Bytes()); !bytes.Equal(got, want) {
		t.Error("body is not the file after concurrent access")
	}
}

// HEAD must report what GET would send, without a body.
func TestCompressedStaticHead(t *testing.T) {
	dir := writeStatic(t, "tour.json", 200_000)
	h := newCompressedStatic(http.Dir(dir))

	req := httptest.NewRequest(http.MethodHead, "/tour.json", nil)
	req.Header.Set("Accept-Encoding", "gzip")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d", rec.Code)
	}
	if rec.Body.Len() != 0 {
		t.Errorf("HEAD returned %d bytes of body", rec.Body.Len())
	}
}
