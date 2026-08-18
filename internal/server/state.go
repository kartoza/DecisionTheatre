package server

import (
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/sites"
	"github.com/kartoza/decision-theatre/internal/tiles"
)

// Server state that a datapack install replaces.
//
// Installing a datapack used to reach into the live server from a background
// goroutine and reassign, one field at a time and with no lock held: the tile
// store, the geopackage store, the site store, two config directories, the
// router, and the running http.Server's Handler. Meanwhile request goroutines
// were reading those same fields.
//
// That was three separate faults. A data race on every field. A nil dereference,
// because the stores were set to nil first and the tile handler called a method
// on whatever it found. And a torn update, because a request arriving mid-swap
// could see the new tile store with the old data directory.
//
// The fix is to stop mutating shared fields at all. Everything that changes
// together is grouped into one immutable value, published with a single atomic
// store. A request reads the pointer once and works from a consistent snapshot
// for its whole life; a swap cannot be observed half-applied, because there is
// only ever one write.

// dataStores is the set of things a datapack install replaces, as one value.
//
// Treat it as immutable once published: build a new one and swap, never edit a
// field on a published instance. Fields may be nil when the corresponding store
// failed to open, which is normal on a machine with no datapack yet — every
// reader has to cope with that regardless.
type dataStores struct {
	tiles *tiles.MBTilesStore
	gpkg  *geodata.GpkgStore
	sites *sites.Store

	// The directories these stores were opened from. They travel with the stores
	// because they change at the same moment and for the same reason: three
	// http.Dir file servers were left rooted at the previous data directory,
	// serving images and walkthroughs from the datapack that had just been
	// replaced.
	dataDir      string
	resourcesDir string
}

// close releases the stores. Called only on a value no longer published.
func (d *dataStores) close() {
	if d == nil {
		return
	}
	if d.tiles != nil {
		d.tiles.Close()
	}
	if d.gpkg != nil {
		d.gpkg.Close()
	}
}

// data returns the current stores. Never nil: New publishes a value before the
// server can serve anything, even when every store inside it failed to open.
//
// Call once per request and use the result throughout. Calling it repeatedly is
// safe but pointless, and reintroduces exactly the inconsistency this exists to
// prevent — a handler could otherwise see one snapshot for the tile store and a
// newer one for the data directory.
func (s *Server) data() *dataStores {
	if d := s.stores.Load(); d != nil {
		return d
	}
	// Only reachable if a caller constructs a Server without New, which the
	// package does not do. An empty value keeps every reader's nil checks
	// meaningful instead of panicking here.
	return &dataStores{}
}

// swapStores publishes a new set and returns the one it replaced.
//
// The caller decides when to close the old value — see closeAfterGrace for why
// that is not done here.
func (s *Server) swapStores(next *dataStores) *dataStores {
	return s.stores.Swap(next)
}

// storeGracePeriod is how long a replaced set of stores is left open after it
// stops being published.
//
// A request that read the pointer just before a swap is still using those stores.
// Closing them immediately turns its query into "database is closed" — not a
// crash, but a request that fails for no reason the user did anything to cause.
// Waiting costs one set of file handles for a few seconds and lets in-flight work
// finish against the data it started with.
const storeGracePeriod = 30 * time.Second

// closeAfterGrace closes a replaced set of stores once in-flight requests have
// had time to finish with it.
func closeAfterGrace(old *dataStores) {
	if old == nil {
		return
	}
	go func() {
		time.Sleep(storeGracePeriod)
		old.close()
	}()
}

// currentRouter returns the live router.
//
// The router is swapped on install rather than mutated, and the running
// http.Server's Handler is never reassigned — that assignment was itself a race,
// since net/http reads Handler for every connection it accepts. The handler
// installed at startup reads this pointer instead, so routes can be rebuilt
// underneath it safely.
func (s *Server) currentRouter() *mux.Router {
	return s.routes.Load()
}

// setRouter publishes a router.
func (s *Server) setRouter(r *mux.Router) {
	s.routes.Store(r)
}

// dataDirFS serves files from whichever data directory is current.
//
// http.Dir captures its root when the file server is built. Three of them —
// images, walkthroughs and demo assets — were built once at startup, so after an
// install they went on serving the replaced datapack's files, or failing if that
// directory had been removed. Resolving the root per request means they cannot go
// stale, whatever order a future rebuild happens in.
type dataDirFS struct {
	srv *Server
	sub string
}

func (f dataDirFS) Open(name string) (http.File, error) {
	root := filepath.Join(f.srv.data().dataDir, f.sub)
	// http.Dir applies the path confinement that makes this safe: it rejects a
	// name that escapes the root, which is why the FileSystem is delegated to
	// rather than joining the name here.
	return http.Dir(root).Open(name)
}

// styleCache holds the rewritten style.json.
//
// This replaces a sync.Once that was reassigned to invalidate the cache — from a
// request goroutine, while other goroutines could be inside Do. A sync.Once must
// not be copied or reassigned after first use, and the cached bytes were read
// with no synchronisation at all.
//
// A mutex and an explicit valid flag say the same thing without that hazard, and
// make invalidation an ordinary operation rather than a trick.
type styleCache struct {
	mu    sync.Mutex
	bytes []byte
	valid bool
}

// get returns the cached bytes, building them with the supplied function on a
// miss.
//
// The build runs under the lock so that a burst of first requests produces one
// build rather than one each — the behaviour the sync.Once was there for. A
// failed build is not cached, so the next request retries.
func (c *styleCache) get(build func() ([]byte, error)) ([]byte, error) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.valid {
		return c.bytes, nil
	}

	out, err := build()
	if err != nil {
		return nil, err
	}
	c.bytes = out
	c.valid = true
	return out, nil
}

// invalidate drops the cached bytes. Safe to call while requests are in flight:
// one already holding the returned slice keeps reading it, since the slice is
// replaced rather than modified.
func (c *styleCache) invalidate() {
	c.mu.Lock()
	c.bytes = nil
	c.valid = false
	c.mu.Unlock()
}

// openDataStores opens every store rooted at a data directory.
//
// Failures are logged and left as nil rather than returned: a machine with no
// datapack yet is an ordinary state the application is designed to start in — it
// shows the setup guide — so a missing store is not a reason to refuse to run.
func openDataStores(dataDir, resourcesDir string) *dataStores {
	next := &dataStores{dataDir: dataDir, resourcesDir: resourcesDir}

	if tileStore, err := tiles.NewMBTilesStore(dataDir, filepath.Join(dataDir, "mbtiles")); err != nil {
		log.Printf("Warning: MBTiles store not available: %v", err)
	} else {
		next.tiles = tileStore
	}

	if gpkgStore, err := geodata.NewGpkgStore(dataDir); err != nil {
		log.Printf("Warning: GeoPackage store not available: %v", err)
	} else {
		next.gpkg = gpkgStore
	}

	if siteStore, err := sites.NewStore(dataDir); err != nil {
		log.Printf("Warning: Sites store not available: %v", err)
	} else {
		next.sites = siteStore
	}

	return next
}

// dataDirExists reports whether a directory is usable, for logging on reload.
func dataDirExists(dir string) bool {
	info, err := os.Stat(dir)
	return err == nil && info.IsDir()
}
