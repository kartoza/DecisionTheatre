package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/projects"
	"github.com/kartoza/decision-theatre/internal/sites"
	"github.com/kartoza/decision-theatre/internal/tiles"
)

// Handler provides HTTP API endpoints
type Handler struct {
	tileStore    *tiles.MBTilesStore
	geoStore     *geodata.GeoParquetStore
	gpkgStore    *geodata.GpkgStore
	projectStore *projects.Store
	siteStore    *sites.Store
	cfg          config.Config
}

// NewHandler creates a new API handler
func NewHandler(
	tileStore *tiles.MBTilesStore,
	geoStore *geodata.GeoParquetStore,
	gpkgStore *geodata.GpkgStore,
	projectStore *projects.Store,
	siteStore *sites.Store,
	cfg config.Config,
) *Handler {
	return &Handler{
		tileStore:    tileStore,
		geoStore:     geoStore,
		gpkgStore:    gpkgStore,
		projectStore: projectStore,
		siteStore:    siteStore,
		cfg:          cfg,
	}
}

// RegisterRoutes sets up all API routes
func (h *Handler) RegisterRoutes(r *mux.Router) {
	// Health and info
	r.HandleFunc("/health", h.handleHealth).Methods("GET")
	r.HandleFunc("/info", h.handleInfo).Methods("GET")

	// Tile metadata
	r.HandleFunc("/tilesets", h.handleListTilesets).Methods("GET")
	r.HandleFunc("/tilesets/{name}/metadata", h.handleTilesetMetadata).Methods("GET")

	// Scenario data
	r.HandleFunc("/scenarios", h.handleListScenarios).Methods("GET")
	r.HandleFunc("/columns", h.handleListColumns).Methods("GET")
	r.HandleFunc("/scenario/{scenario}/{attribute}", h.handleScenarioData).Methods("GET")
	r.HandleFunc("/compare", h.handleComparisonData).Methods("GET")
	r.HandleFunc("/catchment/{id}", h.handleCatchmentIdentify).Methods("GET")

	// Choropleth endpoint - returns GeoJSON filtered by bbox
	r.HandleFunc("/choropleth", h.handleChoropleth).Methods("GET")

	// Project management
	r.HandleFunc("/projects", h.handleListProjects).Methods("GET")
	r.HandleFunc("/projects", h.handleCreateProject).Methods("POST")
	r.HandleFunc("/projects/{id}", h.handleGetProject).Methods("GET")
	r.HandleFunc("/projects/{id}", h.handleUpdateProject).Methods("PUT", "PATCH")
	r.HandleFunc("/projects/{id}", h.handleDeleteProject).Methods("DELETE")

	// Site management
	r.HandleFunc("/sites", h.handleListSites).Methods("GET")
	r.HandleFunc("/sites", h.handleCreateSite).Methods("POST")
	r.HandleFunc("/sites/{id}", h.handleGetSite).Methods("GET")
	r.HandleFunc("/sites/{id}", h.handleUpdateSite).Methods("PUT", "PATCH")
	r.HandleFunc("/sites/{id}", h.handleDeleteSite).Methods("DELETE")

	// Catchment selection for site creation
	r.HandleFunc("/sites/dissolve-catchments", h.handleDissolveCatchments).Methods("POST")
}

// respondJSON sends a JSON response
func respondJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		log.Printf("Error encoding response: %v", err)
	}
}

// respondError sends a JSON error response
func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]string{"error": message})
}

// handleHealth returns server health status
func (h *Handler) handleHealth(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// handleInfo returns server information
func (h *Handler) handleInfo(w http.ResponseWriter, r *http.Request) {
	info := map[string]interface{}{
		"version":      h.cfg.Version,
		"tiles_loaded": h.tileStore != nil,
		"geo_loaded":   h.geoStore != nil,
	}
	respondJSON(w, http.StatusOK, info)
}

// handleListTilesets returns available tilesets
func (h *Handler) handleListTilesets(w http.ResponseWriter, r *http.Request) {
	if h.tileStore == nil {
		respondJSON(w, http.StatusOK, []string{})
		return
	}
	respondJSON(w, http.StatusOK, h.tileStore.ListTilesets())
}

// handleTilesetMetadata returns metadata for a tileset
func (h *Handler) handleTilesetMetadata(w http.ResponseWriter, r *http.Request) {
	if h.tileStore == nil {
		respondError(w, http.StatusNotFound, "no tile stores loaded")
		return
	}

	name := mux.Vars(r)["name"]
	meta, err := h.tileStore.GetMetadata(name)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, meta)
}

// handleListScenarios returns available scenarios
func (h *Handler) handleListScenarios(w http.ResponseWriter, r *http.Request) {
	if h.geoStore == nil {
		respondJSON(w, http.StatusOK, []string{})
		return
	}
	respondJSON(w, http.StatusOK, h.geoStore.GetScenarios())
}

// handleListColumns returns available attribute columns
func (h *Handler) handleListColumns(w http.ResponseWriter, r *http.Request) {
	// Prefer gpkgStore as it's now the primary source
	if h.gpkgStore != nil {
		respondJSON(w, http.StatusOK, h.gpkgStore.GetColumns())
		return
	}
	// Fallback to geoStore for backward compatibility
	if h.geoStore != nil {
		respondJSON(w, http.StatusOK, h.geoStore.GetColumns())
		return
	}
	respondJSON(w, http.StatusOK, []string{})
}

// handleScenarioData returns data for a scenario and attribute
func (h *Handler) handleScenarioData(w http.ResponseWriter, r *http.Request) {
	if h.geoStore == nil {
		respondError(w, http.StatusNotFound, "no geo data loaded")
		return
	}

	vars := mux.Vars(r)
	scenario := geodata.Scenario(vars["scenario"])
	attribute := vars["attribute"]

	data, err := h.geoStore.GetScenarioData(scenario, attribute)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, data)
}

// handleComparisonData returns comparison data for two scenarios
func (h *Handler) handleComparisonData(w http.ResponseWriter, r *http.Request) {
	if h.geoStore == nil {
		respondError(w, http.StatusNotFound, "no geo data loaded")
		return
	}

	left := geodata.Scenario(r.URL.Query().Get("left"))
	right := geodata.Scenario(r.URL.Query().Get("right"))
	attribute := r.URL.Query().Get("attribute")

	if left == "" || right == "" || attribute == "" {
		respondError(w, http.StatusBadRequest, "left, right, and attribute query parameters are required")
		return
	}

	data, err := h.geoStore.GetComparisonData(left, right, attribute)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, data)
}

// handleCatchmentIdentify returns all attributes for a catchment across scenarios
func (h *Handler) handleCatchmentIdentify(w http.ResponseWriter, r *http.Request) {
	if h.geoStore == nil {
		respondError(w, http.StatusNotFound, "no geo data loaded")
		return
	}

	catchmentID := mux.Vars(r)["id"]
	data := h.geoStore.GetCatchmentAttributes(catchmentID)
	if len(data) == 0 {
		respondError(w, http.StatusNotFound, "catchment not found")
		return
	}

	respondJSON(w, http.StatusOK, data)
}

// handleListProjects returns all projects
func (h *Handler) handleListProjects(w http.ResponseWriter, r *http.Request) {
	if h.projectStore == nil {
		respondJSON(w, http.StatusOK, []*projects.Project{})
		return
	}

	projectList, err := h.projectStore.List()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, projectList)
}

// handleGetProject returns a single project by ID
func (h *Handler) handleGetProject(w http.ResponseWriter, r *http.Request) {
	if h.projectStore == nil {
		respondError(w, http.StatusNotFound, "project store not initialized")
		return
	}

	id := mux.Vars(r)["id"]
	project, err := h.projectStore.Get(id)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, project)
}

// handleCreateProject creates a new project
func (h *Handler) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	if h.projectStore == nil {
		respondError(w, http.StatusInternalServerError, "project store not initialized")
		return
	}

	var project projects.Project
	if err := json.NewDecoder(r.Body).Decode(&project); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	created, err := h.projectStore.Create(&project)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusCreated, created)
}

// handleUpdateProject updates an existing project
func (h *Handler) handleUpdateProject(w http.ResponseWriter, r *http.Request) {
	if h.projectStore == nil {
		respondError(w, http.StatusInternalServerError, "project store not initialized")
		return
	}

	id := mux.Vars(r)["id"]
	var updates projects.Project
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	updated, err := h.projectStore.Update(id, &updates)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, updated)
}

// handleDeleteProject deletes a project
func (h *Handler) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	if h.projectStore == nil {
		respondError(w, http.StatusInternalServerError, "project store not initialized")
		return
	}

	id := mux.Vars(r)["id"]
	if err := h.projectStore.Delete(id); err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// ChoroplethResponse wraps a FeatureCollection with domain range for consistent color scaling
type ChoroplethResponse struct {
	Type       string                   `json:"type"`
	Features   []geodata.GeoJSONFeature `json:"features"`
	DomainMin  float64                  `json:"domain_min"`
	DomainMax  float64                  `json:"domain_max"`
}

// handleChoropleth returns GeoJSON catchments filtered by bbox with attribute values
// Query params: scenario, attribute, minx, miny, maxx, maxy
func (h *Handler) handleChoropleth(w http.ResponseWriter, r *http.Request) {
	if h.gpkgStore == nil {
		respondError(w, http.StatusServiceUnavailable, "geopackage store not available")
		return
	}

	q := r.URL.Query()

	scenario := q.Get("scenario")
	if scenario == "" {
		scenario = "current"
	}

	attribute := q.Get("attribute")
	if attribute == "" {
		respondError(w, http.StatusBadRequest, "attribute parameter is required")
		return
	}

	// Parse bbox parameters
	minx, err := strconv.ParseFloat(q.Get("minx"), 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid minx parameter")
		return
	}
	miny, err := strconv.ParseFloat(q.Get("miny"), 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid miny parameter")
		return
	}
	maxx, err := strconv.ParseFloat(q.Get("maxx"), 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid maxx parameter")
		return
	}
	maxy, err := strconv.ParseFloat(q.Get("maxy"), 64)
	if err != nil {
		respondError(w, http.StatusBadRequest, "invalid maxy parameter")
		return
	}

	// Query catchments
	fc, err := h.gpkgStore.QueryCatchments(scenario, attribute, minx, miny, maxx, maxy)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Get domain range for consistent color scaling across scenarios
	domainRange, err := h.gpkgStore.GetDomainRange(attribute)
	if err != nil {
		// If domain tables don't exist, fall back to no domain range
		log.Printf("Warning: could not get domain range for %s: %v", attribute, err)
		domainRange = &geodata.DomainRange{Min: 0, Max: 0}
	}

	// Build response with domain range
	response := ChoroplethResponse{
		Type:       "FeatureCollection",
		Features:   fc.Features,
		DomainMin:  domainRange.Min,
		DomainMax:  domainRange.Max,
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	json.NewEncoder(w).Encode(response)
}

// ============================================================================
// Site Management Handlers
// ============================================================================

// handleListSites returns all sites
func (h *Handler) handleListSites(w http.ResponseWriter, r *http.Request) {
	if h.siteStore == nil {
		respondJSON(w, http.StatusOK, []*sites.Site{})
		return
	}

	siteList, err := h.siteStore.List()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, siteList)
}

// handleGetSite returns a single site by ID
func (h *Handler) handleGetSite(w http.ResponseWriter, r *http.Request) {
	if h.siteStore == nil {
		respondError(w, http.StatusNotFound, "site store not initialized")
		return
	}

	id := mux.Vars(r)["id"]
	site, err := h.siteStore.Get(id)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, site)
}

// handleCreateSite creates a new site
func (h *Handler) handleCreateSite(w http.ResponseWriter, r *http.Request) {
	if h.siteStore == nil {
		respondError(w, http.StatusInternalServerError, "site store not initialized")
		return
	}

	var site sites.Site
	if err := json.NewDecoder(r.Body).Decode(&site); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	created, err := h.siteStore.Create(&site)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusCreated, created)
}

// handleUpdateSite updates an existing site
func (h *Handler) handleUpdateSite(w http.ResponseWriter, r *http.Request) {
	if h.siteStore == nil {
		respondError(w, http.StatusInternalServerError, "site store not initialized")
		return
	}

	id := mux.Vars(r)["id"]
	var updates sites.Site
	if err := json.NewDecoder(r.Body).Decode(&updates); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	updated, err := h.siteStore.Update(id, &updates)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, updated)
}

// handleDeleteSite deletes a site
func (h *Handler) handleDeleteSite(w http.ResponseWriter, r *http.Request) {
	if h.siteStore == nil {
		respondError(w, http.StatusInternalServerError, "site store not initialized")
		return
	}

	id := mux.Vars(r)["id"]
	if err := h.siteStore.Delete(id); err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

// DissolveCatchmentsRequest represents a request to dissolve catchments into a site boundary
type DissolveCatchmentsRequest struct {
	CatchmentIDs []string `json:"catchmentIds"`
}

// DissolveCatchmentsResponse returns the dissolved boundary geometry
type DissolveCatchmentsResponse struct {
	Geometry    json.RawMessage       `json:"geometry"`
	BoundingBox *sites.BoundingBox    `json:"boundingBox"`
	Area        float64               `json:"area"`
}

// handleDissolveCatchments creates a dissolved boundary from selected catchments
func (h *Handler) handleDissolveCatchments(w http.ResponseWriter, r *http.Request) {
	if h.gpkgStore == nil {
		respondError(w, http.StatusServiceUnavailable, "geopackage store not available")
		return
	}

	var req DissolveCatchmentsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if len(req.CatchmentIDs) == 0 {
		respondError(w, http.StatusBadRequest, "no catchment IDs provided")
		return
	}

	// Get dissolved geometry from gpkg store
	geometry, area, err := h.gpkgStore.DissolveCatchments(req.CatchmentIDs)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Compute bounding box
	var bbox *sites.BoundingBox
	if len(geometry) > 0 {
		var geom map[string]interface{}
		if err := json.Unmarshal(geometry, &geom); err == nil {
			bbox = &sites.BoundingBox{MinX: 180, MinY: 90, MaxX: -180, MaxY: -90}
			extractBBoxFromGeom(geom, bbox)
		}
	}

	response := DissolveCatchmentsResponse{
		Geometry:    geometry,
		BoundingBox: bbox,
		Area:        area,
	}

	respondJSON(w, http.StatusOK, response)
}

// extractBBoxFromGeom recursively extracts coordinates to compute bounding box
func extractBBoxFromGeom(geom map[string]interface{}, bbox *sites.BoundingBox) {
	geomType, _ := geom["type"].(string)

	switch geomType {
	case "Polygon", "MultiLineString":
		coords, ok := geom["coordinates"].([]interface{})
		if ok {
			for _, ring := range coords {
				r, ok := ring.([]interface{})
				if ok {
					for _, c := range r {
						pt, ok := c.([]interface{})
						if ok && len(pt) >= 2 {
							x, _ := pt[0].(float64)
							y, _ := pt[1].(float64)
							if x < bbox.MinX { bbox.MinX = x }
							if x > bbox.MaxX { bbox.MaxX = x }
							if y < bbox.MinY { bbox.MinY = y }
							if y > bbox.MaxY { bbox.MaxY = y }
						}
					}
				}
			}
		}
	case "MultiPolygon":
		coords, ok := geom["coordinates"].([]interface{})
		if ok {
			for _, polygon := range coords {
				p, ok := polygon.([]interface{})
				if ok {
					for _, ring := range p {
						r, ok := ring.([]interface{})
						if ok {
							for _, c := range r {
								pt, ok := c.([]interface{})
								if ok && len(pt) >= 2 {
									x, _ := pt[0].(float64)
									y, _ := pt[1].(float64)
									if x < bbox.MinX { bbox.MinX = x }
									if x > bbox.MaxX { bbox.MaxX = x }
									if y < bbox.MinY { bbox.MinY = y }
									if y > bbox.MaxY { bbox.MaxY = y }
								}
							}
						}
					}
				}
			}
		}
	}
}
