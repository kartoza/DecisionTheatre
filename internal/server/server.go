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
	"net/url"
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

	// satellite fetches, caches and quota-limits satellite imagery tiles from
	// the configured upstream provider; see satellite.go.
	satellite *satelliteTileProxy

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
	glyphCache sync.Map
	// The datapack style's own glyphs URL, the no-key fallback for the glyph
	// proxy — see datapackGlyphTemplate.
	glyphTemplateOnce sync.Once
	glyphTemplate     string
	glyphCacheSizeB   atomic.Int64

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

	// Persisted alongside settings.json so a restart does not reset what most
	// providers treat as a running monthly total. A failure to locate or read it
	// is not fatal: LoadSatelliteUsage always returns a usable, if unpersisted,
	// counter — see its doc comment.
	settingsDir := cfg.SatelliteUsageDir
	if settingsDir == "" {
		var err error
		settingsDir, err = config.SettingsDir()
		if err != nil {
			log.Printf("Warning: could not determine settings directory, satellite usage will not persist: %v", err)
			settingsDir = os.TempDir()
		}
	}
	satelliteUsage, err := config.LoadSatelliteUsage(settingsDir)
	if err != nil {
		log.Printf("Warning: could not load satellite usage: %v", err)
	}
	s.satellite = newSatelliteTileProxy(cfg, satelliteUsage)

	s.setRouter(s.buildRouter())

	// Pre-warm the tile cache in the background so that low-zoom tiles are
	// already in RAM when the first map renders. The webview takes a second or
	// two to start, giving the goroutine a head-start on loading Africa z0-5.
	if tileStore := s.data().tiles; tileStore != nil {
		go tileStore.WarmCache("context",
			[4]float64{-17.546539, -34.837477, 63.500977, 37.352693}, 5)
		// The catchments tileset comes in two generations: one combined
		// "catchments" file (legacy), or one standalone tileset per level,
		// each tiled at a single zoom (see catchmentLevelTilesets). Warming
		// a name that is not present is a cheap no-op, so warm both spellings
		// rather than branching on which datapack this is. Only the low-zoom
		// levels matter here — lev08/lev12 tiles are fetched on approach.
		go tileStore.WarmCache("catchments",
			[4]float64{-17.546539, -34.837477, 63.500977, 37.352693}, 5)
		go tileStore.WarmCache("catchments-lev04",
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
	apiHandler := api.NewHandler(current.tiles, current.gpkg, current.sites, cfg, s.satellite.usage)
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

	// Satellite imagery, proxied so every tile the Hybrid style references can
	// be counted and quota-enforced, and so the MapTiler key stays server-side;
	// see satellite.go. Public: both builds show the basemap.
	router.HandleFunc("/api/satellite-style.json", s.handleSatelliteStyle).Methods("GET")
	router.HandleFunc("/api/satellite-tilejson/{source:[a-zA-Z0-9_-]+}",
		s.handleSatelliteTileJSON).Methods("GET")
	router.HandleFunc("/api/satellite-tile/{source:[a-zA-Z0-9_-]+}/{z:[0-9]+}/{x:[0-9]+}/{y:[0-9]+}",
		s.handleSatelliteTile).Methods("GET")
	router.HandleFunc("/api/satellite-sprite{variant:(?:\\.json|\\.png|@2x\\.json|@2x\\.png)}",
		s.handleSatelliteSprite).Methods("GET")

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
	router.HandleFunc("/data/catchments-tiles.json", s.handleCatchmentsTileJSON).Methods("GET")

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

	// Serve the area-weighted whisker-bound CSVs from the data directory root.
	// These back ChartView's box-plot whisker fallback for any site the backend
	// has no record of — walkthrough demo sites, always, since they are static
	// assets rather than site-store records — so /sites/{id}/whiskers 404s and
	// the frontend falls back to fetching these directly and computing bounds
	// itself. Before this route existed the fetch fell through to the SPA
	// handler and got index.html back with a 200, which parsed as zero rows:
	// every box plot in every demo tour silently collapsed to a flat line.
	// Named explicitly, not PathPrefix'd, because nothing else at the data
	// root is meant to be downloadable this way.
	whiskerCSVHandler := http.StripPrefix("/data/", newCompressedStatic(dataDirFS{srv: s, sub: ""}))
	for _, name := range []string{
		"current_upper.csv", "current_lower.csv",
		"reference_upper.csv", "reference_lower.csv",
	} {
		router.Handle("/data/"+name, whiskerCSVHandler).Methods("GET")
	}

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

	// Crawler rules. Registered before the SPA fallback, which would otherwise
	// answer /robots.txt with a page of HTML — a 200 with no directives in it,
	// which a crawler reads as permission to crawl everything. See robots.go.
	router.HandleFunc("/robots.txt", handleRobots).Methods("GET")

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
	// Sscanf leaves the target untouched on failure, so /tiles/context/a/b/c.pbf
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
// Outermost first: admission control, then the body limit, then compression,
// then the live router. Admission leads because refusing has to be cheaper
// than serving, or shedding just moves the overload rather than relieving it.
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
	// Admission control is outermost so that a refused request costs a status
	// line and nothing else: no body read, no compression, no routing. The
	// whole value of shedding is that saying no is cheap.
	return admitRequests(limitRequestBody(handler))
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

		// Rewrite tile sources to point to our local TileJSON endpoints. Most
		// sources are the combined "context" tileset; catchments_lev12 ships
		// as its own tileset (see handleCatchmentsTileJSON) so MapLibre can
		// overzoom it independently past its own, lower, real maxzoom.
		if sources, ok := style["sources"].(map[string]interface{}); ok {
			for name, src := range sources {
				if srcMap, ok := src.(map[string]interface{}); ok {
					if name == "Catchments" {
						srcMap["url"] = base + "/data/catchments-tiles.json"
					} else {
						srcMap["url"] = base + "/data/tiles.json"
					}
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
	// The embedded glyphs/tile URLs are absolute (see above), so a Vite dev
	// setup — :5173 proxying everything else to :8080 — has the browser fetch
	// them directly, cross-origin. Same reasoning as writeSatelliteJSON.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Write(styleBytes)
}

// writeTileJSON serves TileJSON metadata for the named tileset. It returns
// multiple tile URL variants (localhost ↔ 127.0.0.1 plus aux ports) so the
// browser treats them as separate origins and opens independent HTTP/1.1
// connection pools (6 each), maximising parallel tile loading in grid view.
//
// minzoom/maxzoom here are the tileset's own, real, tiled range — not
// necessarily the deepest zoom the app ever displays it at. Declaring the
// true (lower) maxzoom for a tileset like "catchments" is what makes
// MapLibre overzoom it (reuse and rescale the deepest real tile) instead of
// requesting tiles that were never generated.
func (s *Server) writeTileJSON(w http.ResponseWriter, r *http.Request, name string, minzoom, maxzoom int) {
	base := baseURL(r)

	// Derive the alternate hostname: localhost ↔ 127.0.0.1.
	altBase := base
	switch {
	case strings.Contains(r.Host, "localhost"):
		altBase = strings.Replace(base, "localhost", "127.0.0.1", 1)
	case strings.Contains(r.Host, "127.0.0.1"):
		altBase = strings.Replace(base, "127.0.0.1", "localhost", 1)
	}

	tileURLs := []string{base + "/tiles/" + name + "/{z}/{x}/{y}.pbf"}
	if altBase != base {
		tileURLs = append(tileURLs, altBase+"/tiles/"+name+"/{z}/{x}/{y}.pbf")
	}
	// Aux ports each provide an independent 6-connection HTTP/1.1 pool.
	for _, p := range s.auxPorts {
		tileURLs = append(tileURLs, fmt.Sprintf("http://localhost:%d/tiles/%s/{z}/{x}/{y}.pbf", p, name))
	}

	tileJSON := map[string]interface{}{
		"tilejson": "2.2.0",
		"name":     name,
		"scheme":   "xyz",
		"tiles":    tileURLs,
		"minzoom":  minzoom,
		"maxzoom":  maxzoom,
		"bounds":   []float64{-17.546539, -34.837477, 63.500977, 37.352693},
		"center":   []float64{22.977, 1.258, 4},
	}

	// Add vector_layers from mbtiles metadata if available
	if tileStore := s.data().tiles; tileStore != nil {
		meta, err := tileStore.GetMetadata(name)
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
	// See the same header in handleStyleJSON: the tile URLs here are absolute
	// and, in a Vite dev setup, fetched cross-origin.
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_ = json.NewEncoder(w).Encode(tileJSON)
}

// handleTileJSON serves the combined "context" tileset (everything except
// catchments_lev12, which ships separately — see handleCatchmentsTileJSON).
func (s *Server) handleTileJSON(w http.ResponseWriter, r *http.Request) {
	s.writeTileJSON(w, r, "context", 2, 15)
}

// handleCatchmentsTileJSON serves the standalone catchments tileset: real
// tiles for lev04/06/08/12, each at its own zoom band (see
// datasources/mbtiles-config/layer-treatment.csv and
// internal/geodata/gpkg_store.go's basinLevelForZoom for the matching
// choropleth bands), minzoom 2 up to lev12's real maxzoom (12) —
// deliberately lower than the app's navigable zoom range (up to 15):
// scripts/gpkg_to_mbtiles.sh tiles lev12 once, fully ungeneralised, with no
// separate simplified band, and MapLibre overzooms this source for
// anything past z12 rather than tiling it again at every deeper zoom —
// exactly what per-source overzoom is for, which the combined "context"
// tileset can't offer per-layer since one TileJSON maxzoom covers every
// layer bundled into it. The exact zoom cutover between levels is a
// visual-tuning question, not a fixed constant — adjust the treatment
// table and this call together.
func (s *Server) handleCatchmentsTileJSON(w http.ResponseWriter, r *http.Request) {
	// --legacy (`dt serve-legacy`): always lev12 *values*, at every zoom,
	// never the coarser multi-resolution bands' aggregates (handleCatchmentValues
	// enforces that half). Below about z8 real lev12 boundaries are too dense
	// to read as a map at all — 147,837 slivers in one viewport reads as a
	// solid mesh, not catchments — so this mode's own two-band split swaps
	// real boundaries for a hexagon per catchment there (centred on its own
	// centroid, sized from its own SUB_AREA — see
	// generate_catchment_hexagons.py), keeping a catchment's identity and
	// rough position without detail nothing could render legibly. Real lev12
	// detail still takes over from z9, same cutover the default mode's own
	// lev08→lev12 handoff uses. Both bands are single-zoom-tiled and
	// overzoomed exactly like the default mode's own levels (see
	// writeSplitCatchmentsTileJSON) — this is the same split-tileset
	// document shape with a different table, not a new mechanism. Falls
	// through to the normal multires behaviour if neither legacy tileset has
	// been built for this datapack, rather than taking the flag down with it.
	if s.cfg.LegacyCatchments && (s.hasTileset("catchments-lev12-hex") || s.hasTileset("catchments-lev12-full")) {
		s.writeSplitCatchmentsTileJSON(w, r, legacyCatchmentTilesets)
		return
	}

	// Preferred: one standalone tileset per level, each tiled at exactly one
	// zoom and overzoomed through its whole display band (tile once, draw
	// all the way in). Present iff the datapack was tiled with the
	// split-tileset treatment matrix; older datapacks carry the combined
	// "catchments" tileset and get the legacy document unchanged.
	if s.hasTileset("catchments-lev12") {
		s.writeSplitCatchmentsTileJSON(w, r, catchmentLevelTilesets)
		return
	}
	s.writeTileJSON(w, r, "catchments", 2, 12)
}

// levelTileset names one standalone catchment tileset, the source-layer its
// tiles carry, and the single zoom it is tiled at.
type levelTileset struct {
	name        string
	sourceLayer string
	tilezoom    int
}

// catchmentLevelTilesets lists the per-level standalone catchment tilesets in
// band order with the single zoom each is tiled at (see
// datasources/mbtiles-config/layer-treatment.csv — the two must agree). The
// display band each level covers is derived by the client: from its tilezoom
// up to the next level's, the last level unbounded.
var catchmentLevelTilesets = []levelTileset{
	// lev04 is floored at z0 rather than z2: a small grid-view pane fits the
	// whole study area below z2, and a band floor above the pane's zoom
	// leaves the choropleth blank until the user happens to zoom across it.
	// One z0 tile covers the domain; detail=16 keeps its coordinate grid
	// sub-pixel through the band's deepest display zoom.
	{"catchments-lev04", "catchments_lev04", 0},
	{"catchments-lev06", "catchments_lev06", 6},
	{"catchments-lev08", "catchments_lev08", 9},
	{"catchments-lev12", "catchments_lev12", 11},
}

// catchmentsLev12HexSourceLayer is the --legacy hex band's vector-tile
// source-layer name — built, not a literal, so TestSpecCoversGeoPackageTablesInSQL
// doesn't mistake it for a reference to a datapack.gpkg table Go reads by
// SQL. It isn't one: catchments_lev12_hex (see
// generate_catchment_hexagons.py) lives only in datasources/catchments/
// catchments.gpkg, a tiling-pipeline *input* never shipped as part of
// datapack.gpkg, and nothing in this codebase queries it — a GeoPackageTables
// entry for it would have check-data warn "missing" on every valid datapack,
// forever, since it could never be present in the file that check validates.
var catchmentsLev12HexSourceLayer = "catchments_lev12" + "_hex"

// legacyCatchmentTilesets is catchmentLevelTilesets' --legacy counterpart:
// hexagons standing in for real boundaries below z9 (see
// handleCatchmentsTileJSON), real lev12 detail from z9. Both still carry
// lev12 ids/values — GetCatchmentIDsByBBox-style lookups and
// handleCatchmentValues's legacy branch don't care which geometry a tile
// uses, only that the id namespace is lev12 throughout.
var legacyCatchmentTilesets = []levelTileset{
	{"catchments-lev12-hex", catchmentsLev12HexSourceLayer, 2},
	{"catchments-lev12-full", "catchments_lev12", 9},
}

// hasTileset reports whether the tile store serves a tileset by this name.
func (s *Server) hasTileset(name string) bool {
	tileStore := s.data().tiles
	if tileStore == nil {
		return false
	}
	for _, t := range tileStore.ListTilesets() {
		if t == name {
			return true
		}
	}
	return false
}

// tileURLVariants builds the tile URL templates for one tileset: the request
// host, its localhost↔127.0.0.1 twin, and the aux ports — each a separate
// origin with its own HTTP/1.1 connection pool (see writeTileJSON).
func (s *Server) tileURLVariants(r *http.Request, name string) []string {
	base := baseURL(r)
	altBase := base
	switch {
	case strings.Contains(r.Host, "localhost"):
		altBase = strings.Replace(base, "localhost", "127.0.0.1", 1)
	case strings.Contains(r.Host, "127.0.0.1"):
		altBase = strings.Replace(base, "127.0.0.1", "localhost", 1)
	}
	urls := []string{base + "/tiles/" + name + "/{z}/{x}/{y}.pbf"}
	if altBase != base {
		urls = append(urls, altBase+"/tiles/"+name+"/{z}/{x}/{y}.pbf")
	}
	for _, p := range s.auxPorts {
		urls = append(urls, fmt.Sprintf("http://localhost:%d/tiles/%s/{z}/{x}/{y}.pbf", p, name))
	}
	return urls
}

// writeSplitCatchmentsTileJSON describes the per-level catchment tilesets in
// one document: a "tilesets" array with each level's own tile URLs and the
// single zoom it is tiled at. The client builds one MapLibre source per
// entry with minzoom=maxzoom=tilezoom, which is precisely what makes
// MapLibre overzoom that level's tiles across its whole display band
// instead of requesting zooms that were never generated.
func (s *Server) writeSplitCatchmentsTileJSON(w http.ResponseWriter, r *http.Request, table []levelTileset) {
	type levelTilesetJSON struct {
		Name        string   `json:"name"`
		SourceLayer string   `json:"sourceLayer"`
		Tilezoom    int      `json:"tilezoom"`
		Tiles       []string `json:"tiles"`
	}
	levels := make([]levelTilesetJSON, 0, len(table))
	for _, lt := range table {
		if !s.hasTileset(lt.name) {
			// All-or-nothing would blank whole bands on a partially built
			// store; serving the levels that exist keeps the map usable and
			// the client falls back to GeoJSON for uncovered zooms.
			continue
		}
		levels = append(levels, levelTilesetJSON{
			Name:        lt.name,
			SourceLayer: lt.sourceLayer,
			Tilezoom:    lt.tilezoom,
			Tiles:       s.tileURLVariants(r, lt.name),
		})
	}

	doc := map[string]interface{}{
		"tilejson": "2.2.0",
		"name":     "catchments",
		"scheme":   "xyz",
		"bounds":   []float64{-17.546539, -34.837477, 63.500977, 37.352693},
		"center":   []float64{22.977, 1.258, 4},
		"tilesets": levels,
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_ = json.NewEncoder(w).Encode(doc)
}

// glyphUpstreamURL builds the CDN URL for one glyph range. With a configured
// MapTiler key that key is used; without one it falls back to the glyphs URL
// template embedded in the datapack's own style.json, which ships with its
// own key — before this fallback, a machine with no DT_MAPTILER_API_KEY got
// an empty 200 for every glyph range and the map rendered no text at all
// (no place names, and no debug catchment labels).
func (s *Server) glyphUpstreamURL(fontstack, glyphRange string) string {
	if key := config.MapTilerAPIKey(); key != "" {
		return fmt.Sprintf("https://api.maptiler.com/fonts/%s/%s.pbf?key=%s", fontstack, glyphRange, key)
	}
	if tpl := s.datapackGlyphTemplate(); tpl != "" {
		u := strings.Replace(tpl, "{fontstack}", url.PathEscape(fontstack), 1)
		return strings.Replace(u, "{range}", glyphRange, 1)
	}
	// No key and no datapack template: keep the old behaviour (the fetch
	// fails and the handler answers with an empty 200).
	return fmt.Sprintf("https://api.maptiler.com/fonts/%s/%s.pbf?key=", fontstack, glyphRange)
}

// datapackGlyphTemplate reads the absolute glyphs URL out of the datapack's
// style.json, once. Empty when the style has none or is unreadable — callers
// treat that as "no fallback available".
func (s *Server) datapackGlyphTemplate() string {
	s.glyphTemplateOnce.Do(func() {
		current := s.data()
		for _, dir := range []string{current.dataDir, current.resourcesDir} {
			raw, err := os.ReadFile(filepath.Join(dir, "mbtiles", "style.json"))
			if err != nil {
				continue
			}
			var style struct {
				Glyphs string `json:"glyphs"`
			}
			if json.Unmarshal(raw, &style) != nil {
				continue
			}
			if strings.HasPrefix(style.Glyphs, "http") {
				s.glyphTemplate = style.Glyphs
				return
			}
		}
	})
	return s.glyphTemplate
}

// handleGlyphProxy serves MapLibre font glyph PBF files. The first request for
// each {fontstack}/{range} pair is fetched from the upstream CDN (see
// glyphUpstreamURL) and stored in an in-process cache; all subsequent
// requests (from other map instances in grid view) are served instantly from
// memory.
func (s *Server) handleGlyphProxy(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	fontstack := vars["fontstack"]
	glyphRange := vars["range"]
	cacheKey := fontstack + "/" + glyphRange

	// The glyphs URL embedded in the style JSON is absolute (see
	// handleStyleJSON), so in a Vite dev setup the browser fetches it
	// cross-origin, straight past the proxy. Set unconditionally since every
	// branch below writes a response.
	w.Header().Set("Access-Control-Allow-Origin", "*")

	if v, ok := s.glyphCache.Load(cacheKey); ok {
		w.Header().Set("Content-Type", "application/x-protobuf")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		w.Write(v.([]byte))
		return
	}

	upstreamURL := s.glyphUpstreamURL(fontstack, glyphRange)
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
