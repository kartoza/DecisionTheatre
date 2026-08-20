package server

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/api"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/httputil"
)

//go:embed all:static
var staticFS embed.FS

//go:embed all:docs_site/*
var docsFS embed.FS

// glyphCacheLimit caps the in-process glyph cache at 64 MB.
const glyphCacheLimit = 64 * 1024 * 1024

// glyphHTTPClient has a short timeout so that an unreachable CDN does not hold
// browser connections open. MapLibre renders gracefully without glyphs when the
// request fails fast; a hanging connection blocks all other requests to the
// same localhost origin (HTTP/1.1 caps at 6 per host:port).
var glyphHTTPClient = &http.Client{Timeout: 5 * time.Second}

// Server holds all the components for the web application
type Server struct {
	cfg        config.Config
	httpServer *http.Server

	// geocode rate-limits and caches place-name lookups so the upstream policy
	// is honoured once for the whole deployment; see geocode.go.
	geocode *geocodeLimiter

	// stores and routes are swapped, never mutated in place: a datapack install
	// replaces both from a background goroutine while requests are being served.
	// See state.go for why this is a pointer swap rather than a set of fields.
	stores atomic.Pointer[dataStores]
	routes atomic.Pointer[mux.Router]

	// Cached style JSON, rewritten to use local URLs. A mutex and an explicit
	// valid flag, because the sync.Once this replaces was being reassigned to
	// invalidate it — while other goroutines could be inside Do.
	style styleCache

	// In-process glyph cache: key = "fontstack/range", value = []byte.
	// Glyphs fetched from the external CDN on first use are served locally
	// for all subsequent requests, eliminating external HTTPS latency in grid view.
	glyphCache      sync.Map
	glyphCacheSizeB atomic.Int64

	// Auxiliary tile-only HTTP servers, one per extra localhost port.
	// HTTP/1.1 caps connections at 6 per origin (host:port). Running N extra
	// servers on sequential ports gives the browser N extra 6-connection pools
	// so that the ~80 tile requests in grid view are served in parallel instead
	// of being forced through a narrow bottleneck.
	auxServers []*http.Server
	auxPorts   []int

	// Install state — protected by installMu
	installMu        sync.Mutex
	installStatus    string // "idle" | "installing" | "done" | "error"
	installErr       string
	installProgress  float64   // 0-100, only meaningful while installStatus == "installing"
	installStartedAt time.Time // set when installStatus transitions to "installing"
}

// New creates a new Server with all components initialized
func New(cfg config.Config) (*Server, error) {
	s := &Server{cfg: cfg}

	// Publish the stores before anything can serve a request. openDataStores logs
	// and leaves a store nil when it cannot be opened, which is the ordinary state
	// on a machine with no datapack yet — the setup guide is what runs then.
	s.stores.Store(openDataStores(cfg.DataDir, cfg.ResourcesDir))

	s.geocode = newGeocodeLimiter(cfg.Version)

	s.setRouter(s.buildRouter())

	// Pre-warm the tile cache in the background so that low-zoom tiles are
	// already in RAM when the first map renders. The webview takes a second or
	// two to start, giving the goroutine a head-start on loading Africa z0-5.
	if tileStore := s.data().tiles; tileStore != nil {
		go tileStore.WarmCache("africa",
			[4]float64{-17.546539, -34.837477, 63.500977, 37.352693}, 5)
	}

	return s, nil
}

// buildRouter constructs a complete router.
//
// It returns a new router rather than mutating a field, so that a rebuild after a
// datapack install can be published with one atomic store instead of being
// assembled in place while requests are being routed through it.
func (s *Server) buildRouter() *mux.Router {
	router := mux.NewRouter()
	// API routes
	apiRouter := router.PathPrefix("/api").Subrouter()
	// One snapshot for the whole router: the api handler holds the stores it was
	// built with, which is why a rebuild is what publishes new ones.
	current := s.data()
	cfg := s.cfg
	cfg.DataDir = current.dataDir
	cfg.ResourcesDir = current.resourcesDir
	apiHandler := api.NewHandler(current.tiles, current.gpkg, current.sites, cfg)
	apiHandler.RegisterRoutes(apiRouter)

	// Data pack management routes. Serving the pack and the installers is the
	// hosted deployment's job, so those stay public.
	router.HandleFunc("/api/datapack/status", s.handleDatapackStatus).Methods("GET")
	router.HandleFunc("/api/datapack/download-info", s.handleDatapackDownloadInfo).Methods("GET")
	router.HandleFunc("/api/datapack/download", s.handleDatapackDownload).Methods("GET")
	router.HandleFunc("/api/executables/info", s.handleExecutablesInfo).Methods("GET")
	router.HandleFunc("/api/executables/download/{platform}", s.handleExecutableDownload).Methods("GET")

	// Place-name search, proxied so the upstream usage policy can be met at all;
	// see geocode.go. Public: both builds offer search.
	router.HandleFunc("/api/geocode", s.handleGeocode).Methods("GET")

	// Desktop-only. In server mode these paths are simply absent, so they 404
	// through the SPA fallback rather than existing and refusing — there is
	// nothing for a remote caller to probe. See config.Config.DesktopMode.
	if s.cfg.DesktopMode {
		router.HandleFunc("/api/dialog/open-file", s.handleFileDialog).Methods("POST")

		// Install takes a path on this machine's filesystem and replaces the
		// contents of the data directory with whatever it finds there. The path
		// can only come from the file dialog above, which is itself desktop-only,
		// so on a hosted deployment there was no way to use this route
		// legitimately and no authentication stopping anyone using it otherwise.
		router.HandleFunc("/api/datapack/install", s.handleDatapackInstall).Methods("POST")
	}

	// Tile routes - served directly for performance. Registered whenever a tile
	// store exists now; the handler re-reads the current store per request, so an
	// install swapping it out cannot leave this route pointing at a closed one.
	if current.tiles != nil {
		router.HandleFunc("/tiles/{name}/{z:[0-9]+}/{x:[0-9]+}/{y:[0-9]+}.pbf",
			s.handleTileRequest).Methods("GET")
	}

	// Style and TileJSON endpoints
	router.HandleFunc("/data/style.json", s.handleStyleJSON).Methods("GET")
	router.HandleFunc("/data/tiles.json", s.handleTileJSON).Methods("GET")

	// Glyph proxy: serves MapLibre font glyphs locally after fetching from CDN once.
	// Eliminates repeated external HTTPS requests from each map instance in grid view.
	router.HandleFunc("/fonts/{fontstack}/{range}.pbf", s.handleGlyphProxy).Methods("GET")

	// Serve site images from data/images directory
	// dataDirFS rather than http.Dir: these were rooted at the data directory as
	// it stood at startup, so after an install they served the replaced datapack's
	// files — or nothing, if that directory had been removed. See state.go.
	router.PathPrefix("/data/images/").Handler(
		http.StripPrefix("/data/images/", http.FileServer(dataDirFS{srv: s, sub: "images"})))

	// Serve walkthrough demo site JSON files from data/walkthroughs directory.
	//
	// compressedStatic rather than http.FileServer: these documents are large,
	// static for the life of a datapack, and were being gzipped again for every
	// visitor — 60–100 ms per request on the whole-of-Africa tour. Constructing it
	// here means rebuildRoutes hands a datapack install a fresh cache.
	router.PathPrefix("/data/walkthroughs/").Handler(
		http.StripPrefix("/data/walkthroughs/",
			newCompressedStatic(dataDirFS{srv: s, sub: "walkthroughs"})))

	// Serve demo assets (e.g. the Munywana boundary shapefile used by the
	// guided tour) from the data/demo directory.
	router.PathPrefix("/data/demo/").Handler(
		http.StripPrefix("/data/demo/", http.FileServer(dataDirFS{srv: s, sub: "demo"})))

	// Embedded documentation site (MkDocs build output)
	docsContent, err := fs.Sub(docsFS, "docs_site")
	if err != nil {
		log.Printf("Warning: Could not load embedded docs: %v", err)
	} else {
		docsFileServer := http.StripPrefix("/docs/", http.FileServer(http.FS(docsContent)))
		router.PathPrefix("/docs/").Handler(docsFileServer)
	}

	// Anything under /api that matched no route above is an API request for
	// something that does not exist, and must be told so in the language it asked
	// in. Without this it falls through to the SPA handler below and gets 200 with
	// a page of HTML — so a client sees a successful response it cannot parse.
	//
	// Registered after every API route and before the SPA fallback, because mux
	// matches in order. This matters more since the desktop-only routes were
	// gated: in server mode those paths are unrouted, and a stale or misdirected
	// client hitting one deserves a 404 rather than an index page.
	router.PathPrefix("/api/").HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httputil.RespondError(w, http.StatusNotFound,
			"no such endpoint: "+r.Method+" "+r.URL.Path)
	})

	// Static frontend files (embedded)
	staticContent, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Printf("Warning: Could not load embedded static files: %v", err)
		return router
	}

	// SPA fallback: serve index.html for any non-API, non-tile route
	fileServer := http.FileServer(http.FS(staticContent))
	router.PathPrefix("/").Handler(spaHandler{staticContent: staticContent, fileServer: fileServer})

	return router
}

// handleTileRequest serves vector tiles from MBTiles
func (s *Server) handleTileRequest(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	name := vars["name"]

	// Reject a malformed coordinate rather than letting it default to zero:
	// Sscanf leaves the target untouched on failure, so /tiles/africa/a/b/c.pbf
	// was silently served as tile 0/0/0.
	z, err := strconv.Atoi(vars["z"])
	if err != nil {
		http.Error(w, "Invalid tile coordinate", http.StatusBadRequest)
		return
	}
	x, err := strconv.Atoi(vars["x"])
	if err != nil {
		http.Error(w, "Invalid tile coordinate", http.StatusBadRequest)
		return
	}
	y, err := strconv.Atoi(vars["y"])
	if err != nil {
		http.Error(w, "Invalid tile coordinate", http.StatusBadRequest)
		return
	}

	// One snapshot, nil-checked. This called GetTile on whatever it found, and the
	// install path set the store to nil before deleting its files — so a tile
	// request arriving during an install dereferenced nil and took the process
	// down with it.
	tileStore := s.data().tiles
	if tileStore == nil {
		// Distinguishable from "no such tile": the data is being replaced, and the
		// same request will work shortly.
		w.Header().Set("Retry-After", "5")
		http.Error(w, "Tile store is unavailable while data is being installed",
			http.StatusServiceUnavailable)
		return
	}

	tileData, err := tileStore.GetTile(name, z, x, y)
	if err != nil {
		http.Error(w, "Tile not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/x-protobuf")
	w.Header().Set("Content-Encoding", "gzip")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(tileData)
}

// newAuxTileServer configures one auxiliary tile listener.
//
// These previously set IdleTimeout only, so a client that opened a connection and
// then stalled mid-request held it indefinitely. Tiles are small and read from a
// local mbtiles file, so nothing here streams for long and WriteTimeout needs no
// exemption, unlike the main server's downloads.
func newAuxTileServer(handler http.Handler) *http.Server {
	return &http.Server{
		Handler:      handler,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
}

// startAuxTileServers opens up to 3 extra listeners on the ports immediately
// following the main port. Each listener runs a minimal router that only
// handles tile requests, giving the browser additional HTTP/1.1 connection
// pools (6 connections per origin) so tile fetches are not serialised.
func (s *Server) startAuxTileServers(mainPort int) {
	for i := 1; i <= 3; i++ {
		port := mainPort + i
		// Registered unconditionally. These listeners are started once at boot and
		// were never revisited when a datapack install rebuilt the main router, so
		// they kept serving against whatever store existed at startup — the route
		// was missing entirely if none did, and stale afterwards if one appeared.
		// handleTileRequest now resolves the current store per request, so there is
		// nothing left for a rebuild to fix.
		r := mux.NewRouter()
		r.HandleFunc("/tiles/{name}/{z:[0-9]+}/{x:[0-9]+}/{y:[0-9]+}.pbf",
			s.handleTileRequest).Methods("GET")
		srv := newAuxTileServer(r)
		ln, err := net.Listen("tcp", s.cfg.ListenAddressForPort(port))
		if err != nil {
			log.Printf("Aux tile server: port %d unavailable, skipping: %v", port, err)
			continue
		}
		s.auxServers = append(s.auxServers, srv)
		s.auxPorts = append(s.auxPorts, port)
		go func(srv *http.Server, ln net.Listener, p int) {
			log.Printf("Aux tile server listening on port %d", p)
			if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
				log.Printf("Aux tile server port %d: %v", p, err)
			}
		}(srv, ln, port)
	}
}

func (s *Server) Start() error {
	s.httpServer = s.newHTTPServer()

	s.startAuxTileServers(s.cfg.Port)

	log.Printf("Server listening on http://%s", s.cfg.ListenAddress())
	return s.httpServer.ListenAndServe()
}

// rootHandler wraps the router in the middleware every request passes through.
//
// Compression is applied in server mode only. Desktop mode reaches the server
// exclusively over loopback — it binds 127.0.0.1 and opens its own WebView onto
// it — where there is no bandwidth to save, so compressing the full-Africa
// choropleth would spend 230ms of CPU per request to speed up a transfer that
// already takes milliseconds. Server mode is the one whose clients may be a
// network away, and the one nginx sits in front of.
func (s *Server) rootHandler() http.Handler {
	// The live router is read per request rather than captured: a datapack install
	// publishes a new one, and reassigning http.Server.Handler to do that was a
	// race, since net/http reads Handler for every connection it accepts.
	var handler http.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.currentRouter().ServeHTTP(w, r)
	})
	if !s.cfg.DesktopMode {
		handler = compressResponses(handler)
	}
	return limitRequestBody(handler)
}

// newHTTPServer builds the main listener's configuration.
//
// Separate from Start so a test can inspect the address and the timeouts without
// binding a port or blocking in ListenAndServe.
func (s *Server) newHTTPServer() *http.Server {
	return &http.Server{
		Addr: s.cfg.ListenAddress(),
		// Every request goes through the body limit; see bodylimit.go.
		Handler:     s.rootHandler(),
		ReadTimeout: 15 * time.Second,
		// WriteTimeout used to be disabled entirely, justified by a claim that
		// the server "only listens on localhost" — which was not true: it bound
		// 0.0.0.0. The binding is fixed now, but a disabled write timeout still
		// means a stalled client holds a connection and its goroutine forever, so
		// it is bounded here on its own merits.
		//
		// Nothing needs minutes. Datapack extraction, the original reason given,
		// answers 202 immediately and reports progress through
		// /api/datapack/status, so no handler blocks on it. The two handlers that
		// genuinely stream a large file — the datapack and executable downloads —
		// extend their own deadline with http.NewResponseController rather than
		// forcing every request to be unbounded. See datapack.go.
		WriteTimeout: 120 * time.Second,
		IdleTimeout:  120 * time.Second,
	}
}

// Stop gracefully shuts down the server.
func (s *Server) Stop() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	s.data().close()

	for _, aux := range s.auxServers {
		aux.Shutdown(ctx) //nolint:errcheck
	}

	return s.httpServer.Shutdown(ctx)
}

// baseURL returns the scheme+host for the current request. When running
// behind a reverse proxy that terminates TLS (e.g. nginx), r.TLS is nil even
// for HTTPS requests, so we also honor the standard X-Forwarded-Proto header.
func baseURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https" {
		scheme = "https"
	}
	return fmt.Sprintf("%s://%s", scheme, r.Host)
}

// handleStyleJSON serves the MapLibre style JSON, rewriting tile source URLs to
// use the local server and the glyphs URL to use the local caching proxy.
// The result is built once and cached for the lifetime of the server; all
// subsequent requests (e.g. the 4 panes in grid view) are served from memory.
func (s *Server) handleStyleJSON(w http.ResponseWriter, r *http.Request) {
	base := baseURL(r)
	current := s.data()

	styleBytes, err := s.style.get(func() ([]byte, error) {
		stylePath := filepath.Join(current.dataDir, "mbtiles", "style.json")
		data, err := os.ReadFile(stylePath)
		if err != nil && current.resourcesDir != "" {
			// Fall back to the bundled style in the resources directory.
			stylePath = filepath.Join(current.resourcesDir, "mbtiles", "style.json")
			data, err = os.ReadFile(stylePath)
		}
		if err != nil {
			return nil, err
		}

		var style map[string]interface{}
		if err := json.Unmarshal(data, &style); err != nil {
			return nil, err
		}

		// Rewrite tile sources to point to our local TileJSON endpoint.
		if sources, ok := style["sources"].(map[string]interface{}); ok {
			for name, src := range sources {
				if srcMap, ok := src.(map[string]interface{}); ok {
					srcMap["url"] = base + "/data/tiles.json"
					sources[name] = srcMap
				}
			}
		}

		// Rewrite glyphs to use the local caching proxy instead of the external
		// CDN. In grid view this eliminates 7 duplicate external HTTPS round-trips
		// (only the first request per glyph range ever leaves the machine).
		style["glyphs"] = base + "/fonts/{fontstack}/{range}.pbf"

		return json.Marshal(style)
	})

	// A failed build is not cached, so no invalidation is needed here to make a
	// retry possible after an install. That is what the old code was doing by
	// assigning a fresh sync.Once over the existing one — from this request
	// goroutine, while other goroutines could be inside Do, which is exactly what
	// a sync.Once must never have done to it.
	if err != nil || styleBytes == nil {
		http.Error(w, "Style not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Write(styleBytes)
}

// handleTileJSON serves TileJSON metadata. It returns multiple tile URL variants
// (localhost ↔ 127.0.0.1 plus aux ports) so the browser treats them as separate
// origins and opens independent HTTP/1.1 connection pools (6 each), maximising
// parallel tile loading in grid view.
func (s *Server) handleTileJSON(w http.ResponseWriter, r *http.Request) {
	base := baseURL(r)

	// Derive the alternate hostname: localhost ↔ 127.0.0.1.
	altBase := base
	switch {
	case strings.Contains(r.Host, "localhost"):
		altBase = strings.Replace(base, "localhost", "127.0.0.1", 1)
	case strings.Contains(r.Host, "127.0.0.1"):
		altBase = strings.Replace(base, "127.0.0.1", "localhost", 1)
	}

	tileURLs := []string{base + "/tiles/africa/{z}/{x}/{y}.pbf"}
	if altBase != base {
		tileURLs = append(tileURLs, altBase+"/tiles/africa/{z}/{x}/{y}.pbf")
	}
	// Aux ports each provide an independent 6-connection HTTP/1.1 pool.
	for _, p := range s.auxPorts {
		tileURLs = append(tileURLs, fmt.Sprintf("http://localhost:%d/tiles/africa/{z}/{x}/{y}.pbf", p))
	}

	tileJSON := map[string]interface{}{
		"tilejson": "2.2.0",
		"name":     "africa",
		"scheme":   "xyz",
		"tiles":    tileURLs,
		"minzoom":  2,
		"maxzoom":  15,
		"bounds":   []float64{-17.546539, -34.837477, 63.500977, 37.352693},
		"center":   []float64{22.977, 1.258, 4},
	}

	// Add vector_layers from mbtiles metadata if available
	if tileStore := s.data().tiles; tileStore != nil {
		meta, err := tileStore.GetMetadata("africa")
		if err == nil && meta.JSON != "" {
			var metaJSON map[string]interface{}
			if json.Unmarshal([]byte(meta.JSON), &metaJSON) == nil {
				if vl, ok := metaJSON["vector_layers"]; ok {
					tileJSON["vector_layers"] = vl
				}
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_ = json.NewEncoder(w).Encode(tileJSON)
}

// handleGlyphProxy serves MapLibre font glyph PBF files. The first request for
// each {fontstack}/{range} pair is fetched from the upstream MapTiler CDN and
// stored in an in-process cache; all subsequent requests (from other map
// instances in grid view) are served instantly from memory.
func (s *Server) handleGlyphProxy(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	fontstack := vars["fontstack"]
	glyphRange := vars["range"]
	cacheKey := fontstack + "/" + glyphRange

	if v, ok := s.glyphCache.Load(cacheKey); ok {
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Write(v.([]byte))
		return
	}

	upstreamURL := fmt.Sprintf(
		"https://api.maptiler.com/fonts/%s/%s.pbf?key=cc4PpmmWZP73LjU1nsw3",
		fontstack, glyphRange,
	)
	resp, err := glyphHTTPClient.Get(upstreamURL)
	if err != nil {
		// CDN unreachable (no internet, timeout, etc.) — return an empty 200 so
		// MapLibre skips these glyphs and continues rendering instead of hanging.
		log.Printf("Glyph proxy: upstream fetch failed for %s/%s: %v", fontstack, glyphRange, err)
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		log.Printf("Glyph proxy: upstream returned %d for %s/%s", resp.StatusCode, fontstack, glyphRange)
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
		return
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.WriteHeader(http.StatusOK)
		return
	}

	if s.glyphCacheSizeB.Load() < glyphCacheLimit {
		if _, loaded := s.glyphCache.LoadOrStore(cacheKey, data); !loaded {
			s.glyphCacheSizeB.Add(int64(len(data)))
		}
	}

	w.Header().Set("Content-Type", "application/x-protobuf")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Write(data)
}

// rebuildRoutes creates a new router and re-registers all routes with the current store references.
// This is needed after a datapack install, since the old apiHandler holds stale nil store pointers.
func (s *Server) rebuildRoutes() {
	// A new datapack may have a different style.json.
	s.style.invalidate()

	// Publish, do not mutate. The router used to be replaced field-by-field while
	// requests were being routed through it, and the running server's Handler was
	// reassigned underneath net/http.
	s.setRouter(s.buildRouter())
}

// spaHandler serves the SPA, falling back to index.html for client-side routing
type spaHandler struct {
	staticContent fs.FS
	fileServer    http.Handler
}

func (h spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Try to open the file
	path := r.URL.Path
	if path == "/" {
		path = "index.html"
	}

	// fs.FS paths must not have a leading slash
	cleanPath := strings.TrimPrefix(path, "/")

	_, err := fs.Stat(h.staticContent, cleanPath)
	if err != nil {
		// File not found, serve index.html for SPA routing
		r.URL.Path = "/"
	}

	h.fileServer.ServeHTTP(w, r)
}
