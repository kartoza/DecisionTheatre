package server

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
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

// Server holds all the components for the web application
type Server struct {
	cfg        config.Config
	httpServer *http.Server
	router     *mux.Router
	tileStore  *tiles.MBTilesStore
	gpkgStore  *geodata.GpkgStore
	siteStore  *sites.Store

	// Install state — protected by installMu
	installMu     sync.Mutex
	installStatus string // "idle" | "installing" | "done" | "error"
	installErr    string
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
	s.router.HandleFunc("/api/dialog/open-file", s.handleFileDialog).Methods("POST")

	// Tile routes - served directly for performance
	if s.tileStore != nil {
		s.router.HandleFunc("/tiles/{name}/{z:[0-9]+}/{x:[0-9]+}/{y:[0-9]+}.pbf",
			s.handleTileRequest).Methods("GET")
	}

	// Style and TileJSON endpoints
	s.router.HandleFunc("/data/style.json", s.handleStyleJSON).Methods("GET")
	s.router.HandleFunc("/data/tiles.json", s.handleTileJSON).Methods("GET")

	// Serve site images from data/images directory
	imagesDir := filepath.Join(s.cfg.DataDir, "images")
	s.router.PathPrefix("/data/images/").Handler(
		http.StripPrefix("/data/images/", http.FileServer(http.Dir(imagesDir))))

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

// Start begins listening for HTTP connections
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

	log.Printf("Server listening on http://localhost:%d", s.cfg.Port)
	return s.httpServer.ListenAndServe()
}

// Stop gracefully shuts down the server
func (s *Server) Stop() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// Close stores
	if s.tileStore != nil {
		s.tileStore.Close()
	}
	if s.gpkgStore != nil {
		s.gpkgStore.Close()
	}

	return s.httpServer.Shutdown(ctx)
}

// handleStyleJSON serves the MapBox style JSON from resources, rewriting the source URL
func (s *Server) handleStyleJSON(w http.ResponseWriter, r *http.Request) {
	stylePath := filepath.Join(s.cfg.DataDir, "mbtiles", "style.json")
	data, err := os.ReadFile(stylePath)
	if err != nil {
		http.Error(w, "Style not found", http.StatusNotFound)
		return
	}

	// Parse and rewrite the source URL to use the request's host
	var style map[string]interface{}
	if err := json.Unmarshal(data, &style); err != nil {
		http.Error(w, "Invalid style JSON", http.StatusInternalServerError)
		return
	}

	// Rewrite sources to point to our tile endpoint
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	baseURL := fmt.Sprintf("%s://%s", scheme, r.Host)

	if sources, ok := style["sources"].(map[string]interface{}); ok {
		for name, src := range sources {
			if srcMap, ok := src.(map[string]interface{}); ok {
				srcMap["url"] = baseURL + "/data/tiles.json"
				sources[name] = srcMap
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	json.NewEncoder(w).Encode(style)
}

// handleTileJSON serves TileJSON metadata for the catchments tileset
func (s *Server) handleTileJSON(w http.ResponseWriter, r *http.Request) {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	baseURL := fmt.Sprintf("%s://%s", scheme, r.Host)

	tileJSON := map[string]interface{}{
		"tilejson": "2.2.0",
		"name":     "africa",
		"scheme":   "xyz",
		"tiles":    []string{baseURL + "/tiles/africa/{z}/{x}/{y}.pbf"},
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

// rebuildRoutes creates a new router and re-registers all routes with the current store references.
// This is needed after a datapack install, since the old apiHandler holds stale nil store pointers.
func (s *Server) rebuildRoutes() {
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
