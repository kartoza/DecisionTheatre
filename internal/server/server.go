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
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/api"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/sites"
	"github.com/kartoza/decision-theatre/internal/tiles"
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
	router     *mux.Router
	tileStore  *tiles.MBTilesStore
	gpkgStore  *geodata.GpkgStore
	siteStore  *sites.Store

	// Cached style JSON bytes (rewritten to use local URLs). Protected by styleOnce.
	styleOnce  sync.Once
	styleBytes []byte

	// In-process glyph cache: key = "fontstack/range", value = []byte.
	// Glyphs fetched from the external CDN on first use are served locally
	// for all subsequent requests, eliminating external HTTPS latency in quad view.
	glyphCache      sync.Map
	glyphCacheSizeB atomic.Int64

	// Auxiliary tile-only HTTP servers, one per extra localhost port.
	// HTTP/1.1 caps connections at 6 per origin (host:port). Running N extra
	// servers on sequential ports gives the browser N extra 6-connection pools
	// so that the ~80 tile requests in quad view are served in parallel instead
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
	s := &Server{
		cfg:    cfg,
		router: mux.NewRouter(),
	}

	// Initialize MBTiles store (scan data dir and data/mbtiles)
	dataMBTilesDir := filepath.Join(cfg.DataDir, "mbtiles")
	tileStore, err := tiles.NewMBTilesStore(cfg.DataDir, dataMBTilesDir)
	if err != nil {
		log.Printf("Warning: MBTiles store not available: %v", err)
	} else {
		s.tileStore = tileStore
	}

	// Initialize GeoPackage store for scenario data and choropleth queries
	gpkgStore, err := geodata.NewGpkgStore(cfg.DataDir)
	if err != nil {
		log.Printf("Warning: GeoPackage store not available: %v", err)
	} else {
		s.gpkgStore = gpkgStore
	}

	// Initialize sites store
	siteStore, err := sites.NewStore(cfg.DataDir)
	if err != nil {
		log.Printf("Warning: Sites store not available: %v", err)
	} else {
		s.siteStore = siteStore
	}

	// Set up routes
	s.setupRoutes()

	// Pre-warm the tile cache in the background so that low-zoom tiles are
	// already in RAM when the first map renders. The webview takes a second or
	// two to start, giving the goroutine a head-start on loading Africa z0-5.
	if s.tileStore != nil {
		go s.tileStore.WarmCache("africa",
			[4]float64{-17.546539, -34.837477, 63.500977, 37.352693}, 5)
	}

	return s, nil
}

// setupRoutes configures all HTTP routes
func (s *Server) setupRoutes() {
	// API routes
	apiRouter := s.router.PathPrefix("/api").Subrouter()
	apiHandler := api.NewHandler(s.tileStore, s.gpkgStore, s.siteStore, s.cfg)
	apiHandler.RegisterRoutes(apiRouter)

	// Data pack management routes
	s.router.HandleFunc("/api/datapack/status", s.handleDatapackStatus).Methods("GET")
	s.router.HandleFunc("/api/datapack/install", s.handleDatapackInstall).Methods("POST")
	s.router.HandleFunc("/api/datapack/download-info", s.handleDatapackDownloadInfo).Methods("GET")
	s.router.HandleFunc("/api/datapack/download", s.handleDatapackDownload).Methods("GET")
	s.router.HandleFunc("/api/executables/info", s.handleExecutablesInfo).Methods("GET")
	s.router.HandleFunc("/api/executables/download/{platform}", s.handleExecutableDownload).Methods("GET")
	s.router.HandleFunc("/api/dialog/open-file", s.handleFileDialog).Methods("POST")

	// Tile routes - served directly for performance
	if s.tileStore != nil {
		s.router.HandleFunc("/tiles/{name}/{z:[0-9]+}/{x:[0-9]+}/{y:[0-9]+}.pbf",
			s.handleTileRequest).Methods("GET")
	}

	// Style and TileJSON endpoints
	s.router.HandleFunc("/data/style.json", s.handleStyleJSON).Methods("GET")
	s.router.HandleFunc("/data/tiles.json", s.handleTileJSON).Methods("GET")

	// Glyph proxy: serves MapLibre font glyphs locally after fetching from CDN once.
	// Eliminates repeated external HTTPS requests from each map instance in quad view.
	s.router.HandleFunc("/fonts/{fontstack}/{range}.pbf", s.handleGlyphProxy).Methods("GET")

	// Serve site images from data/images directory
	imagesDir := filepath.Join(s.cfg.DataDir, "images")
	s.router.PathPrefix("/data/images/").Handler(
		http.StripPrefix("/data/images/", http.FileServer(http.Dir(imagesDir))))

	// Serve walkthrough demo site JSON files from data/walkthroughs directory
	walkthroughsDir := filepath.Join(s.cfg.DataDir, "walkthroughs")
	s.router.PathPrefix("/data/walkthroughs/").Handler(
		http.StripPrefix("/data/walkthroughs/", http.FileServer(http.Dir(walkthroughsDir))))

	// Serve demo assets (e.g. the Munywana boundary shapefile used by the
	// guided tour) from the data/demo directory.
	demoDir := filepath.Join(s.cfg.DataDir, "demo")
	s.router.PathPrefix("/data/demo/").Handler(
		http.StripPrefix("/data/demo/", http.FileServer(http.Dir(demoDir))))

	// Embedded documentation site (MkDocs build output)
	docsContent, err := fs.Sub(docsFS, "docs_site")
	if err != nil {
		log.Printf("Warning: Could not load embedded docs: %v", err)
	} else {
		docsFileServer := http.StripPrefix("/docs/", http.FileServer(http.FS(docsContent)))
		s.router.PathPrefix("/docs/").Handler(docsFileServer)
	}

	// Static frontend files (embedded)
	staticContent, err := fs.Sub(staticFS, "static")
	if err != nil {
		log.Printf("Warning: Could not load embedded static files: %v", err)
		return
	}

	// SPA fallback: serve index.html for any non-API, non-tile route
	fileServer := http.FileServer(http.FS(staticContent))
	s.router.PathPrefix("/").Handler(spaHandler{staticContent: staticContent, fileServer: fileServer})
}

// handleTileRequest serves vector tiles from MBTiles
func (s *Server) handleTileRequest(w http.ResponseWriter, r *http.Request) {
	vars := mux.Vars(r)
	name := vars["name"]

	var z, x, y int
	fmt.Sscanf(vars["z"], "%d", &z)
	fmt.Sscanf(vars["x"], "%d", &x)
	fmt.Sscanf(vars["y"], "%d", &y)

	tileData, err := s.tileStore.GetTile(name, z, x, y)
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

// startAuxTileServers opens up to 3 extra listeners on the ports immediately
// following the main port. Each listener runs a minimal router that only
// handles tile requests, giving the browser additional HTTP/1.1 connection
// pools (6 connections per origin) so tile fetches are not serialised.
func (s *Server) startAuxTileServers(mainPort int) {
	for i := 1; i <= 3; i++ {
		port := mainPort + i
		r := mux.NewRouter()
		if s.tileStore != nil {
			r.HandleFunc("/tiles/{name}/{z:[0-9]+}/{x:[0-9]+}/{y:[0-9]+}.pbf",
				s.handleTileRequest).Methods("GET")
		}
		srv := &http.Server{
			Handler:     r,
			IdleTimeout: 120 * time.Second,
		}
		ln, err := net.Listen("tcp", fmt.Sprintf(":%d", port))
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
	s.httpServer = &http.Server{
		Addr:        fmt.Sprintf(":%d", s.cfg.Port),
		Handler:     s.router,
		ReadTimeout: 15 * time.Second,
		// WriteTimeout is intentionally unset (0 = disabled) — long-running operations
		// such as datapack extraction can take several minutes on large archives.
		// This is safe because the server only listens on localhost.
		IdleTimeout: 120 * time.Second,
	}

	s.startAuxTileServers(s.cfg.Port)

	log.Printf("Server listening on http://localhost:%d", s.cfg.Port)
	return s.httpServer.ListenAndServe()
}

// Stop gracefully shuts down the server.
func (s *Server) Stop() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if s.tileStore != nil {
		s.tileStore.Close()
	}
	if s.gpkgStore != nil {
		s.gpkgStore.Close()
	}

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
// subsequent requests (e.g. the 4 panes in quad view) are served from memory.
func (s *Server) handleStyleJSON(w http.ResponseWriter, r *http.Request) {
	base := baseURL(r)

	var buildErr error
	s.styleOnce.Do(func() {
		stylePath := filepath.Join(s.cfg.DataDir, "mbtiles", "style.json")
		data, err := os.ReadFile(stylePath)
		if err != nil && s.cfg.ResourcesDir != "" {
			// Fall back to the bundled style in the resources directory.
			stylePath = filepath.Join(s.cfg.ResourcesDir, "mbtiles", "style.json")
			data, err = os.ReadFile(stylePath)
		}
		if err != nil {
			buildErr = err
			return
		}

		var style map[string]interface{}
		if err := json.Unmarshal(data, &style); err != nil {
			buildErr = err
			return
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
		// CDN. In quad view this eliminates 7 duplicate external HTTPS round-trips
		// (only the first request per glyph range ever leaves the machine).
		style["glyphs"] = base + "/fonts/{fontstack}/{range}.pbf"

		out, err := json.Marshal(style)
		if err != nil {
			buildErr = err
			return
		}
		s.styleBytes = out
	})

	if buildErr != nil || s.styleBytes == nil {
		// styleOnce already ran and failed, or file not found — reset so a
		// retry is possible after a datapack install.
		s.styleOnce = sync.Once{}
		http.Error(w, "Style not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	w.Write(s.styleBytes)
}

// handleTileJSON serves TileJSON metadata. It returns multiple tile URL variants
// (localhost ↔ 127.0.0.1 plus aux ports) so the browser treats them as separate
// origins and opens independent HTTP/1.1 connection pools (6 each), maximising
// parallel tile loading in quad view.
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
	if s.tileStore != nil {
		meta, err := s.tileStore.GetMetadata("africa")
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
	json.NewEncoder(w).Encode(tileJSON)
}

// handleGlyphProxy serves MapLibre font glyph PBF files. The first request for
// each {fontstack}/{range} pair is fetched from the upstream MapTiler CDN and
// stored in an in-process cache; all subsequent requests (from other map
// instances in quad view) are served instantly from memory.
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
	// A new datapack may have a different style.json — reset the cached bytes.
	s.styleOnce = sync.Once{}
	s.styleBytes = nil
	s.router = mux.NewRouter()
	s.setupRoutes()
	if s.httpServer != nil {
		s.httpServer.Handler = s.router
	}
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
