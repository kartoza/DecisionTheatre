package api

import (
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"time"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/httputil"
	"github.com/kartoza/decision-theatre/internal/sites"
	"github.com/kartoza/decision-theatre/internal/tiles"
)

// Handler provides HTTP API endpoints
type Handler struct {
	tileStore *tiles.MBTilesStore
	gpkgStore *geodata.GpkgStore
	siteStore *sites.Store
	cfg       config.Config
}

// NewHandler creates a new API handler
func NewHandler(
	tileStore *tiles.MBTilesStore,
	gpkgStore *geodata.GpkgStore,
	siteStore *sites.Store,
	cfg config.Config,
) *Handler {
	return &Handler{
		tileStore: tileStore,
		gpkgStore: gpkgStore,
		siteStore: siteStore,
		cfg:       cfg,
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

	// Site management
	r.HandleFunc("/sites", h.handleListSites).Methods("GET")
	r.HandleFunc("/sites", h.handleCreateSite).Methods("POST")
	r.HandleFunc("/sites/{id}", h.handleGetSite).Methods("GET")
	r.HandleFunc("/sites/{id}", h.handleUpdateSite).Methods("PUT", "PATCH")
	r.HandleFunc("/sites/{id}", h.handleDeleteSite).Methods("DELETE")

	// Catchment selection for site creation
	r.HandleFunc("/sites/dissolve-catchments", h.handleDissolveCatchments).Methods("POST")
	r.HandleFunc("/catchments/geometry/{id}", h.handleCatchmentGeometry).Methods("GET")

	// Site indicators
	r.HandleFunc("/sites/{id}/indicators", h.handleExtractIndicators).Methods("POST")
	r.HandleFunc("/sites/{id}/indicators", h.handleUpdateIndicators).Methods("PATCH")
	r.HandleFunc("/sites/{id}/indicators/reset", h.handleResetIdealIndicators).Methods("POST")

	// Site boundary editing (union/difference with catchments)
	r.HandleFunc("/sites/{id}/boundary/union/{catchmentId}", h.handleBoundaryUnion).Methods("POST")
	r.HandleFunc("/sites/{id}/boundary/difference/{catchmentId}", h.handleBoundaryDifference).Methods("POST")
}

// respondJSON sends a JSON response (delegates to httputil)
func respondJSON(w http.ResponseWriter, status int, data interface{}) {
	httputil.RespondJSON(w, status, data)
}

// respondError sends a JSON error response (delegates to httputil)
func respondError(w http.ResponseWriter, status int, message string) {
	httputil.RespondError(w, status, message)
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
		"geo_loaded":   h.gpkgStore != nil,
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
	if h.gpkgStore == nil {
		respondJSON(w, http.StatusOK, []string{})
		return
	}
	respondJSON(w, http.StatusOK, h.gpkgStore.GetScenarios())
}

// handleListColumns returns available attribute columns
func (h *Handler) handleListColumns(w http.ResponseWriter, r *http.Request) {
	if h.gpkgStore != nil {
		respondJSON(w, http.StatusOK, h.gpkgStore.GetColumns())
		return
	}
	respondJSON(w, http.StatusOK, []string{})
}

// handleScenarioData returns data for a scenario and attribute
func (h *Handler) handleScenarioData(w http.ResponseWriter, r *http.Request) {
	if h.gpkgStore == nil {
		respondError(w, http.StatusNotFound, "no geo data loaded")
		return
	}

	vars := mux.Vars(r)
	scenario := vars["scenario"]
	attribute := vars["attribute"]

	data, err := h.gpkgStore.GetScenarioData(scenario, attribute)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, data)
}

// handleComparisonData returns comparison data for two scenarios
func (h *Handler) handleComparisonData(w http.ResponseWriter, r *http.Request) {
	if h.gpkgStore == nil {
		respondError(w, http.StatusNotFound, "no geo data loaded")
		return
	}

	left := r.URL.Query().Get("left")
	right := r.URL.Query().Get("right")
	attribute := r.URL.Query().Get("attribute")

	if left == "" || right == "" || attribute == "" {
		respondError(w, http.StatusBadRequest, "left, right, and attribute query parameters are required")
		return
	}

	data, err := h.gpkgStore.GetComparisonData(left, right, attribute)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, data)
}

// handleCatchmentIdentify returns all attributes for a catchment across scenarios
func (h *Handler) handleCatchmentIdentify(w http.ResponseWriter, r *http.Request) {
	catchmentID := mux.Vars(r)["id"]

	if h.gpkgStore == nil {
		respondError(w, http.StatusNotFound, "no geo data loaded")
		return
	}

	data := h.gpkgStore.GetCatchmentAttributes(catchmentID)
	if len(data) == 0 {
		respondError(w, http.StatusNotFound, "catchment not found")
		return
	}

	respondJSON(w, http.StatusOK, data)
}

// ChoroplethResponse wraps a FeatureCollection with domain range for consistent color scaling
type ChoroplethResponse struct {
	Type      string                   `json:"type"`
	Features  []geodata.GeoJSONFeature `json:"features"`
	DomainMin float64                  `json:"domain_min"`
	DomainMax float64                  `json:"domain_max"`
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
		Type:      "FeatureCollection",
		Features:  fc.Features,
		DomainMin: domainRange.Min,
		DomainMax: domainRange.Max,
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
	Geometry    json.RawMessage    `json:"geometry"`
	BoundingBox *sites.BoundingBox `json:"boundingBox"`
	Area        float64            `json:"area"`
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
							if x < bbox.MinX {
								bbox.MinX = x
							}
							if x > bbox.MaxX {
								bbox.MaxX = x
							}
							if y < bbox.MinY {
								bbox.MinY = y
							}
							if y > bbox.MaxY {
								bbox.MaxY = y
							}
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
									if x < bbox.MinX {
										bbox.MinX = x
									}
									if x > bbox.MaxX {
										bbox.MaxX = x
									}
									if y < bbox.MinY {
										bbox.MinY = y
									}
									if y > bbox.MaxY {
										bbox.MaxY = y
									}
								}
							}
						}
					}
				}
			}
		}
	}
}

// handleCatchmentGeometry returns the full geometry for a single catchment from the GeoPackage
func (h *Handler) handleCatchmentGeometry(w http.ResponseWriter, r *http.Request) {
	if h.gpkgStore == nil {
		respondError(w, http.StatusServiceUnavailable, "geopackage store not available")
		return
	}

	catchmentID := mux.Vars(r)["id"]
	if catchmentID == "" {
		respondError(w, http.StatusBadRequest, "catchment ID required")
		return
	}

	features, err := h.gpkgStore.GetCatchmentsByIDs([]string{catchmentID})
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	if len(features) == 0 {
		respondError(w, http.StatusNotFound, "catchment not found")
		return
	}

	respondJSON(w, http.StatusOK, features[0])
}

// ============================================================================
// Site Indicators Handlers
// ============================================================================

// ExtractIndicatorsRequest represents the request body for indicator extraction
type ExtractIndicatorsRequest struct {
	Runtime string                 `json:"runtime"`
	Site    map[string]interface{} `json:"site"`
}

// handleExtractIndicators extracts and stores indicators for a site from its catchments
// This performs area-weighted aggregation of all indicator values
func (h *Handler) handleExtractIndicators(w http.ResponseWriter, r *http.Request) {
	if h.siteStore == nil {
		respondError(w, http.StatusInternalServerError, "site store not initialized")
		return
	}
	if h.gpkgStore == nil {
		respondError(w, http.StatusServiceUnavailable, "geopackage store not available")
		return
	}

	id := mux.Vars(r)["id"]

	// Decode request body
	var req ExtractIndicatorsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("Warning: failed to decode request body: %v", err)
		// Continue with extraction even if body decode fails (for backwards compatibility)
	}

	var site *sites.Site
	var err error

	if req.Runtime == "browser" {
		// Convert map to Site struct - never fetch from store in browser mode
		if len(req.Site) == 0 {
			respondError(w, http.StatusBadRequest, "browser runtime requires site data in request body")
			return
		}

		// Marshal and unmarshal to convert map to struct
		siteJSON, marshalErr := json.Marshal(req.Site)
		if marshalErr != nil {
			respondError(w, http.StatusBadRequest, "invalid site data in request body")
			return
		}

		site = &sites.Site{}
		if err = json.Unmarshal(siteJSON, site); err != nil {
			respondError(w, http.StatusBadRequest, "invalid site data in request body")
			return
		}
	} else {
		// Backwards compatibility: if runtime is missing/unknown, use persisted site
		site, err = h.siteStore.Get(id)
		if err != nil {
			respondError(w, http.StatusNotFound, err.Error())
			return
		}
	}

	// Get catchment IDs for this site
	catchmentIDs := site.CatchmentIDs
	if len(catchmentIDs) == 0 {
		respondError(w, http.StatusBadRequest, "site has no associated catchments")
		return
	}

	// Get indicator data for all catchments
	catchmentData, err := h.gpkgStore.GetCatchmentIndicatorsByIDs(catchmentIDs)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to get catchment data: "+err.Error())
		return
	}

	if len(catchmentData) == 0 {
		respondError(w, http.StatusNotFound, "no data found for catchments")
		return
	}

	// Compute area-weighted aggregations
	indicators := computeAreaWeightedIndicators(catchmentData)
	indicators.CatchmentIDs = catchmentIDs

	// Update site with indicators
	site.Indicators = indicators

	// For browser runtime, return the site directly without storing
	if req.Runtime == "browser" {
		respondJSON(w, http.StatusOK, site)
		return
	}

	// For other runtimes, update in store and return
	updated, err := h.siteStore.Update(id, site)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to update site: "+err.Error())
		return
	}

	respondJSON(w, http.StatusOK, updated)
}

// computeAreaWeightedIndicators calculates area-weighted indicator aggregations
func computeAreaWeightedIndicators(catchments []geodata.CatchmentIndicators) *sites.SiteIndicators {
	indicators := &sites.SiteIndicators{
		Reference:      make(map[string]float64),
		Current:        make(map[string]float64),
		Ideal:          make(map[string]float64),
		ExtractedAt:    time.Now().UTC().Format(time.RFC3339),
		CatchmentCount: len(catchments),
	}

	// Calculate total area
	totalArea := 0.0
	for _, c := range catchments {
		totalArea += c.AreaKm2
	}
	indicators.TotalAreaKm2 = totalArea

	if totalArea == 0 {
		// Fallback to simple average if no area data
		totalArea = float64(len(catchments))
		for i := range catchments {
			catchments[i].AreaKm2 = 1.0
		}
	}

	// Collect all attribute keys
	allKeys := make(map[string]bool)
	for _, c := range catchments {
		for k := range c.Reference {
			allKeys[k] = true
		}
		for k := range c.Current {
			allKeys[k] = true
		}
	}

	// Compute area-weighted values for each attribute
	for key := range allKeys {
		refSum := 0.0
		refWeight := 0.0
		curSum := 0.0
		curWeight := 0.0

		for _, c := range catchments {
			if val, ok := c.Reference[key]; ok {
				refSum += val * c.AreaKm2
				refWeight += c.AreaKm2
			}
			if val, ok := c.Current[key]; ok {
				curSum += val * c.AreaKm2
				curWeight += c.AreaKm2
			}
		}

		if refWeight > 0 {
			indicators.Reference[key] = refSum / refWeight
			// Initialize ideal values as copy of reference
			indicators.Ideal[key] = refSum / refWeight
		}
		if curWeight > 0 {
			indicators.Current[key] = curSum / curWeight

		}
	}

	return indicators
}

// UpdateIndicatorsRequest represents a request to update ideal indicator values
type UpdateIndicatorsRequest struct {
	Ideal map[string]float64 `json:"ideal"`
}

// handleUpdateIndicators updates the ideal indicator values for a site
func (h *Handler) handleUpdateIndicators(w http.ResponseWriter, r *http.Request) {
	if h.siteStore == nil {
		respondError(w, http.StatusInternalServerError, "site store not initialized")
		return
	}

	id := mux.Vars(r)["id"]
	site, err := h.siteStore.Get(id)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	if site.Indicators == nil {
		respondError(w, http.StatusBadRequest, "site has no indicators - extract them first")
		return
	}

	var req UpdateIndicatorsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Update ideal values
	for key, value := range req.Ideal {
		site.Indicators.Ideal[key] = value
	}

	updated, err := h.siteStore.Update(id, site)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to update site: "+err.Error())
		return
	}

	respondJSON(w, http.StatusOK, updated)
}

// handleResetIdealIndicators resets ideal values to match current values
func (h *Handler) handleResetIdealIndicators(w http.ResponseWriter, r *http.Request) {
	if h.siteStore == nil {
		respondError(w, http.StatusInternalServerError, "site store not initialized")
		return
	}

	id := mux.Vars(r)["id"]
	site, err := h.siteStore.Get(id)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	if site.Indicators == nil {
		respondError(w, http.StatusBadRequest, "site has no indicators")
		return
	}

	// Reset ideal to reference values
	site.Indicators.Ideal = make(map[string]float64)
	for key, value := range site.Indicators.Reference {
		site.Indicators.Ideal[key] = value
	}

	updated, err := h.siteStore.Update(id, site)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to update site: "+err.Error())
		return
	}

	respondJSON(w, http.StatusOK, updated)
}

// ============================================================================
// Site Boundary Editing Handlers (Union/Difference)
// ============================================================================

// BoundaryOperationResponse returns the updated geometry after union/difference
type BoundaryOperationResponse struct {
	Geometry    json.RawMessage    `json:"geometry"`
	BoundingBox *sites.BoundingBox `json:"boundingBox"`
	Area        float64            `json:"area"`
}

// handleBoundaryUnion adds a catchment to the site boundary using geometry union
func (h *Handler) handleBoundaryUnion(w http.ResponseWriter, r *http.Request) {
	if h.siteStore == nil {
		respondError(w, http.StatusInternalServerError, "site store not initialized")
		return
	}
	if h.gpkgStore == nil {
		respondError(w, http.StatusServiceUnavailable, "geopackage store not available")
		return
	}

	vars := mux.Vars(r)
	siteID := vars["id"]
	catchmentID := vars["catchmentId"]

	// Get the site
	site, err := h.siteStore.Get(siteID)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	if len(site.Geometry) == 0 {
		respondError(w, http.StatusBadRequest, "site has no geometry")
		return
	}

	// Get catchment geometry
	features, err := h.gpkgStore.GetCatchmentsByIDs([]string{catchmentID})
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(features) == 0 {
		respondError(w, http.StatusNotFound, "catchment not found")
		return
	}

	// Perform union operation using SpatiaLite
	newGeometry, newArea, err := h.gpkgStore.UnionGeometries(site.Geometry, features[0].Geometry)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "union failed: "+err.Error())
		return
	}

	// Update catchment IDs (add the new catchment)
	catchmentIDStr := catchmentID
	alreadyExists := false
	for _, id := range site.CatchmentIDs {
		if id == catchmentIDStr {
			alreadyExists = true
			break
		}
	}
	if !alreadyExists {
		site.CatchmentIDs = append(site.CatchmentIDs, catchmentIDStr)
	}

	// Compute new bounding box
	var bbox *sites.BoundingBox
	if len(newGeometry) > 0 {
		var geom map[string]interface{}
		if err := json.Unmarshal(newGeometry, &geom); err == nil {
			bbox = &sites.BoundingBox{MinX: 180, MinY: 90, MaxX: -180, MaxY: -90}
			extractBBoxFromGeom(geom, bbox)
		}
	}

	// Update site
	site.Geometry = newGeometry
	site.BoundingBox = bbox
	site.Area = newArea

	updated, err := h.siteStore.Update(siteID, site)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to update site: "+err.Error())
		return
	}

	respondJSON(w, http.StatusOK, BoundaryOperationResponse{
		Geometry:    updated.Geometry,
		BoundingBox: updated.BoundingBox,
		Area:        updated.Area,
	})
}

// handleBoundaryDifference removes a catchment from the site boundary using geometry difference
func (h *Handler) handleBoundaryDifference(w http.ResponseWriter, r *http.Request) {
	if h.siteStore == nil {
		respondError(w, http.StatusInternalServerError, "site store not initialized")
		return
	}
	if h.gpkgStore == nil {
		respondError(w, http.StatusServiceUnavailable, "geopackage store not available")
		return
	}

	vars := mux.Vars(r)
	siteID := vars["id"]
	catchmentID := vars["catchmentId"]

	// Get the site
	site, err := h.siteStore.Get(siteID)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	if len(site.Geometry) == 0 {
		respondError(w, http.StatusBadRequest, "site has no geometry")
		return
	}

	// Get catchment geometry
	features, err := h.gpkgStore.GetCatchmentsByIDs([]string{catchmentID})
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	if len(features) == 0 {
		respondError(w, http.StatusNotFound, "catchment not found")
		return
	}

	// Perform difference operation using SpatiaLite
	newGeometry, newArea, err := h.gpkgStore.DifferenceGeometries(site.Geometry, features[0].Geometry)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "difference failed: "+err.Error())
		return
	}

	// Update catchment IDs (remove the catchment)
	catchmentIDStr := catchmentID
	newCatchmentIDs := make([]string, 0, len(site.CatchmentIDs))
	for _, id := range site.CatchmentIDs {
		if id != catchmentIDStr {
			newCatchmentIDs = append(newCatchmentIDs, id)
		}
	}
	site.CatchmentIDs = newCatchmentIDs

	// Compute new bounding box
	var bbox *sites.BoundingBox
	if len(newGeometry) > 0 {
		var geom map[string]interface{}
		if err := json.Unmarshal(newGeometry, &geom); err == nil {
			bbox = &sites.BoundingBox{MinX: 180, MinY: 90, MaxX: -180, MaxY: -90}
			extractBBoxFromGeom(geom, bbox)
		}
	}

	// Update site
	site.Geometry = newGeometry
	site.BoundingBox = bbox
	site.Area = newArea

	updated, err := h.siteStore.Update(siteID, site)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to update site: "+err.Error())
		return
	}

	respondJSON(w, http.StatusOK, BoundaryOperationResponse{
		Geometry:    updated.Geometry,
		BoundingBox: updated.BoundingBox,
		Area:        updated.Area,
	})
}
