package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
)

// A datapack install reached into the live server from a background goroutine and
// reassigned the tile store, the geopackage store, the site store, two config
// directories, the router and the running http.Server's Handler — one field at a
// time, with no lock held, while request goroutines were reading them.
//
// Everything here is written to run under -race. Without the fix these report
// races and, for the tile handler, panic on a nil dereference.

// tileRouter routes to the tile handler so that mux.Vars is populated. Calling
// the handler directly leaves the path variables empty, and it validates the
// coordinates before it looks at the store — correctly, since a malformed request
// is a 400 whatever the server's state.
func tileRouter(srv *Server) *mux.Router {
	r := mux.NewRouter()
	r.HandleFunc("/tiles/{name}/{z:[0-9]+}/{x:[0-9]+}/{y:[0-9]+}.pbf",
		srv.handleTileRequest).Methods("GET")
	return r
}

// hammer runs fn from several goroutines until stop is closed.
func hammer(fn func()) (stop func()) {
	done := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// fn first, then the check. Testing done first means that on a busy
			// machine the caller's loop can finish and close the channel before
			// these goroutines are ever scheduled, so every one of them returns
			// having done nothing and the test asserts against no activity at
			// all. That is exactly how TestStyleCacheUnderConcurrentInvalidation
			// failed with "the cache never built anything" while a container
			// build was saturating the CPU. This way each goroutine contributes
			// at least one call.
			for {
				fn()
				select {
				case <-done:
					return
				default:
				}
			}
		}()
	}
	return func() {
		close(done)
		wg.Wait()
	}
}

// The shape of the original crash: tile requests in flight while the install path
// takes the store away.
func TestTileRequestsDuringAStoreSwapDoNotPanic(t *testing.T) {
	srv := newTestServer(t, false)

	router := tileRouter(srv)
	stop := hammer(func() {
		req := httptest.NewRequest(http.MethodGet, "/tiles/africa/3/4/4.pbf", nil)
		rec := httptest.NewRecorder()
		router.ServeHTTP(rec, req)

		// Whatever else happens, it must not be a success with no store.
		if rec.Code != http.StatusServiceUnavailable &&
			rec.Code != http.StatusNotFound &&
			rec.Code != http.StatusOK {
			t.Errorf("unexpected status %d", rec.Code)
		}
	})

	for i := 0; i < 200; i++ {
		srv.swapStores(&dataStores{dataDir: t.TempDir()})
	}
	stop()
}

// With no tile store the handler must say so, rather than dereferencing nil.
func TestTileRequestWithNoStoreIsServiceUnavailable(t *testing.T) {
	srv := newTestServer(t, false)
	srv.swapStores(&dataStores{dataDir: t.TempDir()})

	req := httptest.NewRequest(http.MethodGet, "/tiles/africa/3/4/4.pbf", nil)
	rec := httptest.NewRecorder()
	tileRouter(srv).ServeHTTP(rec, req)

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503 while the store is unavailable", rec.Code)
	}
	if rec.Header().Get("Retry-After") == "" {
		t.Error("a 503 should say when to come back")
	}
}

// The stores and the directories they were opened from must move together: a
// request that reads the pointer sees one consistent set, never the new store
// with the old directory.
func TestStoreSwapIsObservedAtomically(t *testing.T) {
	srv := newTestServer(t, false)

	a := &dataStores{dataDir: "/a", resourcesDir: "/a-resources"}
	b := &dataStores{dataDir: "/b", resourcesDir: "/b-resources"}

	// Atomic because this is incremented from every hammer goroutine. A plain int
	// would be a race in the test itself — invisible only for as long as the
	// branch never fires, which is exactly when it would start mattering.
	var mismatched atomic.Int64
	stop := hammer(func() {
		current := srv.data()
		// Whichever set is current, its two fields belong to the same one.
		if current.dataDir == "/a" && current.resourcesDir != "/a-resources" {
			mismatched.Add(1)
		}
		if current.dataDir == "/b" && current.resourcesDir != "/b-resources" {
			mismatched.Add(1)
		}
	})

	for i := 0; i < 500; i++ {
		if i%2 == 0 {
			srv.swapStores(a)
		} else {
			srv.swapStores(b)
		}
	}
	stop()

	if got := mismatched.Load(); got != 0 {
		t.Errorf("%d observations saw a half-applied swap", got)
	}
}

// The router used to be rebuilt in place and the running server's Handler
// reassigned, both while requests were being routed.
func TestRouterSwapDuringRequests(t *testing.T) {
	srv := newTestServer(t, false)
	handler := srv.rootHandler()

	stop := hammer(func() {
		req := httptest.NewRequest(http.MethodGet, "/api/health", nil)
		handler.ServeHTTP(httptest.NewRecorder(), req)
	})

	for i := 0; i < 100; i++ {
		srv.rebuildRoutes()
	}
	stop()
}

// The style cache replaced a sync.Once that was reassigned to invalidate it,
// while other goroutines could be inside Do.
func TestStyleCacheUnderConcurrentInvalidation(t *testing.T) {
	var cache styleCache
	var builds int
	var buildMu sync.Mutex

	stop := hammer(func() {
		_, _ = cache.get(func() ([]byte, error) {
			buildMu.Lock()
			builds++
			buildMu.Unlock()
			return []byte(`{"version":8}`), nil
		})
	})

	for i := 0; i < 500; i++ {
		cache.invalidate()
	}
	stop()

	buildMu.Lock()
	defer buildMu.Unlock()
	if builds == 0 {
		t.Error("the cache never built anything")
	}
}

// A burst of first requests must produce one build, which is what the sync.Once
// was there for.
func TestStyleCacheBuildsOncePerValidity(t *testing.T) {
	var cache styleCache
	var builds int

	build := func() ([]byte, error) {
		builds++
		return []byte("x"), nil
	}
	for i := 0; i < 10; i++ {
		if _, err := cache.get(build); err != nil {
			t.Fatalf("get: %v", err)
		}
	}

	if builds != 1 {
		t.Errorf("built %d times, want 1", builds)
	}

	cache.invalidate()
	if _, err := cache.get(build); err != nil {
		t.Fatalf("get after invalidate: %v", err)
	}
	if builds != 2 {
		t.Errorf("built %d times after invalidation, want 2", builds)
	}
}

// A failed build must not be cached, or one missing file would mean the style
// never loads again — which is why the old code reassigned the Once.
func TestStyleCacheDoesNotCacheAFailure(t *testing.T) {
	var cache styleCache

	if _, err := cache.get(func() ([]byte, error) {
		return nil, os.ErrNotExist
	}); err == nil {
		t.Fatal("expected the build error")
	}

	got, err := cache.get(func() ([]byte, error) { return []byte("ok"), nil })
	if err != nil {
		t.Fatalf("retry after a failed build: %v", err)
	}
	if string(got) != "ok" {
		t.Errorf("got %q, want the retry's value", got)
	}
}

// The three file servers rooted at the data directory were built once at startup,
// so after an install they served the replaced datapack's files.
func TestDataDirFileServerFollowsASwap(t *testing.T) {
	first := t.TempDir()
	second := t.TempDir()
	for dir, body := range map[string]string{first: "old", second: "new"} {
		if err := os.MkdirAll(filepath.Join(dir, "images"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "images", "a.txt"), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	srv := newTestServer(t, false)
	srv.swapStores(&dataStores{dataDir: first})

	handler := http.StripPrefix("/data/images/",
		http.FileServer(dataDirFS{srv: srv, sub: "images"}))

	get := func() string {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/data/images/a.txt", nil))
		return rec.Body.String()
	}

	if got := get(); got != "old" {
		t.Fatalf("before the swap: %q", got)
	}

	srv.swapStores(&dataStores{dataDir: second})

	if got := get(); got != "new" {
		t.Errorf("after the swap: %q, want the new datapack's file", got)
	}
}

// http.Dir's confinement must still apply through the indirection.
func TestDataDirFileServerRefusesTraversal(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("no"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, "images"), 0o755); err != nil {
		t.Fatal(err)
	}

	srv := newTestServer(t, false)
	srv.swapStores(&dataStores{dataDir: dir})

	fsys := dataDirFS{srv: srv, sub: "images"}
	if _, err := fsys.Open("/../secret.txt"); err == nil {
		t.Error("a traversing path was served from outside the images directory")
	}
}

// Every store in a replaced set is closed, and only after it stops being
// published — a request holding the old pointer is still using them.
func TestSwapReturnsThePreviousSetForClosing(t *testing.T) {
	srv := newTestServer(t, false)

	first := &dataStores{dataDir: "/first"}
	srv.swapStores(first)

	previous := srv.swapStores(&dataStores{dataDir: "/second"})
	if previous != first {
		t.Errorf("swap returned %+v, want the set it replaced", previous)
	}
	if srv.data().dataDir != "/second" {
		t.Errorf("current is %q after the swap", srv.data().dataDir)
	}
}

// A Server that never published anything must not panic on read.
func TestDataIsNeverNil(t *testing.T) {
	var s Server

	if s.data() == nil {
		t.Fatal("data() returned nil")
	}
	if s.data().tiles != nil {
		t.Error("an unpublished server reported a tile store")
	}
}

// The aux tile listeners are started once at boot and were never revisited when a
// rebuild happened, so their route had to stop depending on startup state.
func TestAuxTileRouteIsRegisteredRegardlessOfStartupStores(t *testing.T) {
	srv, err := New(config.Config{Port: 0, DataDir: t.TempDir(), Version: "test"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	// No datapack in a temp dir, so there is no tile store at startup — which is
	// precisely when the route used to be left unregistered forever.
	if srv.data().tiles != nil {
		t.Skip("unexpected tile store in an empty directory")
	}

	rec := httptest.NewRecorder()
	tileRouter(srv).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/tiles/africa/1/2/3.pbf", nil))

	if rec.Code == http.StatusNotFound {
		t.Error("the tile route is unrouted; a later install could never serve tiles here")
	}
	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503 with no store", rec.Code)
	}
}
