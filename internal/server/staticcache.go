package server

import (
	"bytes"
	"compress/gzip"
	"io"
	"mime"
	"net/http"
	"path"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Compressed static file serving.
//
// The compression middleware pools gzip *writers*, not their output, so a static
// document was recompressed on every request. Measured against the real datapack
// on the whole-of-Africa walkthrough — 2,104,591 bytes — the same file, back to
// back:
//
//	Accept-Encoding: gzip      0.091 – 0.119 s   467,225 bytes
//	Accept-Encoding: identity  0.0022 – 0.0025 s  2,104,591 bytes
//
// Five consecutive gzip requests all cost the same: there was no warm-up effect
// because there was nothing to warm. Roughly 2.5 ms of that is serving the file
// and the remaining 60–100 ms is gzip level 5, repeated for every visitor.
//
// Compressing is emphatically the right trade — 2.01 MB to 456 KB on the wire is
// worth far more than 64 ms on any real connection. The waste was compressing the
// *same bytes* over and over. These files change only when the datapack changes,
// so the work belongs to the datapack, not to the request.
//
// This does not cache API responses, and must not: those vary with query
// parameters and with site state, and a cache keyed on path alone would serve one
// user another's answer. It caches files, keyed on the file's own identity.

// staticCacheLimitB caps the total compressed bytes held.
//
// The walkthrough documents are the reason this exists and they total under a
// megabyte compressed, so the limit is not expected to bind. It is here so that a
// datapack with an unexpectedly large data directory cannot turn a serving
// optimisation into unbounded memory growth. Past the limit, responses are still
// compressed and served correctly — they are simply not retained.
const staticCacheLimitB = 32 << 20

// compressedStatic serves files from an http.FileSystem, compressing each once
// and reusing the bytes until the file changes.
//
// Invalidation has two independent guards, because serving a stale body would be
// a correctness bug traded for latency, and that is a bad trade at any speed:
//
//   - Every entry records the size and modification time it was built from. A
//     request whose file no longer matches recompresses rather than reusing.
//   - The handler is constructed in buildRouter, which rebuildRoutes calls after
//     a datapack install, so a swap starts from an empty cache regardless.
type compressedStatic struct {
	fs       http.FileSystem
	fallback http.Handler
	limitB   int64

	mu      sync.RWMutex
	entries map[string]staticEntry
	usedB   int64

	// compressions counts how many times a body was actually compressed. It
	// exists so a test can assert that a second request did not repeat the work,
	// which is the whole point of the type and is otherwise invisible.
	compressions atomic.Int64
}

type staticEntry struct {
	// identity is the size and modification time the body was built from.
	identity string
	body     []byte
	modTime  time.Time
	ctype    string
}

func newCompressedStatic(fsys http.FileSystem) *compressedStatic {
	return &compressedStatic{
		fs:       fsys,
		fallback: http.FileServer(fsys),
		limitB:   staticCacheLimitB,
		entries:  make(map[string]staticEntry),
	}
}

func (c *compressedStatic) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Anything this does not positively recognise goes to http.FileServer, which
	// is the behaviour being replaced. That is the safe direction: a miss costs
	// the compression we were already paying, while a wrong hit serves bad bytes.
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		c.fallback.ServeHTTP(w, r)
		return
	}
	if !acceptsGzip(r.Header.Get("Accept-Encoding")) {
		c.fallback.ServeHTTP(w, r)
		return
	}

	// A Range request must be answered against the real, uncompressed bytes.
	// entry.body is already gzip-compressed, so slicing it here would hand
	// http.ServeContent nothing to compute a meaningful Content-Range from: it
	// would describe an offset into the compressed stream while Content-Encoding
	// still claims gzip, a combination browsers reject under HTTP/2 with
	// ERR_HTTP2_PROTOCOL_ERROR. This is the same framing bug isPartialContent
	// (compress.go) fixes for the streaming compressor, reintroduced here because
	// this cache pre-compresses before ServeContent ever sees the request.
	if r.Header.Get("Range") != "" {
		c.fallback.ServeHTTP(w, r)
		return
	}

	name := path.Clean("/" + r.URL.Path)
	f, err := c.fs.Open(name)
	if err != nil {
		c.fallback.ServeHTTP(w, r)
		return
	}
	defer f.Close()

	info, err := f.Stat()
	if err != nil || info.IsDir() {
		c.fallback.ServeHTTP(w, r)
		return
	}

	// Type comes from the extension rather than from sniffing the body: sniffing
	// would mean reading the file before deciding whether it is worth reading.
	ctype := mime.TypeByExtension(path.Ext(name))
	if info.Size() < compressMinBytes || !isCompressibleType(ctype) {
		c.fallback.ServeHTTP(w, r)
		return
	}

	identity := strconv.FormatInt(info.Size(), 10) + "-" +
		strconv.FormatInt(info.ModTime().UnixNano(), 10)

	entry, ok := c.lookup(name, identity)
	if !ok {
		body, err := compressAll(f)
		if err != nil {
			// Reading or compressing failed after the file opened. Nothing has
			// been written yet, so the plain handler can still answer.
			c.fallback.ServeHTTP(w, r)
			return
		}
		c.compressions.Add(1)
		entry = staticEntry{
			identity: identity,
			body:     body,
			modTime:  info.ModTime(),
			ctype:    ctype,
		}
		c.store(name, entry)
	}

	header := w.Header()
	header.Set("Content-Type", entry.ctype)
	header.Set("Content-Encoding", "gzip")
	// Without this a shared cache could hand a compressed body to a client that
	// did not ask for one. The uncompressed path goes to http.FileServer, so the
	// two representations genuinely differ.
	header.Set("Vary", "Accept-Encoding")

	// ServeContent applies the conditional and range rules, so If-Modified-Since
	// keeps answering 304 exactly as http.FileServer did before this existed.
	http.ServeContent(w, r, name, entry.modTime, bytes.NewReader(entry.body))
}

func (c *compressedStatic) lookup(name, identity string) (staticEntry, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	entry, ok := c.entries[name]
	if !ok || entry.identity != identity {
		return staticEntry{}, false
	}
	return entry, true
}

// store retains an entry if it fits. Over the limit the response is still served
// from the bytes just produced; only the retention is skipped, so the failure
// mode is the old behaviour rather than a wrong answer.
func (c *compressedStatic) store(name string, entry staticEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if old, ok := c.entries[name]; ok {
		c.usedB -= int64(len(old.body))
		delete(c.entries, name)
	}
	if c.usedB+int64(len(entry.body)) > c.limitB {
		return
	}
	c.entries[name] = entry
	c.usedB += int64(len(entry.body))
}

// compressAll gzips r in full, reusing a writer from the same pool the streaming
// middleware uses so both tiers compress at the same level.
func compressAll(r io.Reader) ([]byte, error) {
	var buf bytes.Buffer
	zw := gzipWriterPool.Get().(*gzip.Writer)
	defer gzipWriterPool.Put(zw)

	zw.Reset(&buf)
	if _, err := io.Copy(zw, r); err != nil {
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}
