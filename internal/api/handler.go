package api

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/httputil"
	"github.com/kartoza/decision-theatre/internal/sites"
	"github.com/kartoza/decision-theatre/internal/tiles"
)

// FullDomainData holds precomputed area-weighted means for all attributes across
// the full dataset for each scenario. Used by the frontend to skip per-attribute
// aggregate API calls when zone range mode is "Full" (domain).
type FullDomainData struct {
	Reference map[string]float64 `json:"reference"`
	Current   map[string]float64 `json:"current"`
}

// Handler provides HTTP API endpoints
type Handler struct {
	tileStore          *tiles.MBTilesStore
	gpkgStore          *geodata.GpkgStore
	siteStore          *sites.Store
	cfg                config.Config
	metaCache          *MetadataCache
	lookupsMu          sync.RWMutex
	lookups            *LookupTables
	pendingCatchments  sync.Map // siteID → chan struct{} closed when deferred catchment goroutine finishes
	pendingExtractions sync.Map // siteID → struct{} while async indicator extraction is running

	// Cached full-domain precalculation: computed once on first request.
	fullDomainMu    sync.Mutex
	fullDomainCache *FullDomainData
}

// NewHandler creates a new API handler. metadata.csv is parsed synchronously
// (small file, needed immediately by metadata endpoints). The large ecological
// lookup CSVs are loaded in a background goroutine so the HTTP server can start
// accepting requests right away; any PATCH request that arrives before loading
// completes will fall back to proportional-scaling approximations.
func NewHandler(
	tileStore *tiles.MBTilesStore,
	gpkgStore *geodata.GpkgStore,
	siteStore *sites.Store,
	cfg config.Config,
) *Handler {
	h := &Handler{
		tileStore: tileStore,
		gpkgStore: gpkgStore,
		siteStore: siteStore,
		cfg:       cfg,
		metaCache: loadMetadataCache(cfg.DataDir),
	}
	go func() {
		lt := LoadLookupTables(cfg.DataDir)
		h.lookupsMu.Lock()
		h.lookups = lt
		h.lookupsMu.Unlock()
	}()
	return h
}

// getLookups returns the ecological lookup tables, or nil if they are still
// loading. The PATCH recalculation handler falls back to proportional scaling
// when nil is returned.
func (h *Handler) getLookups() *LookupTables {
	h.lookupsMu.RLock()
	defer h.lookupsMu.RUnlock()
	return h.lookups
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
	r.HandleFunc("/metadata/colors", h.handleMetadataColors).Methods("GET")
	r.HandleFunc("/metadata/details", h.handleMetadataDetails).Methods("GET")
	r.HandleFunc("/metadata/variabletypes", h.handleMetadataVariableTypes).Methods("GET")
	r.HandleFunc("/metadata/inputs", h.handleMetadataInputs).Methods("GET")
	r.HandleFunc("/metadata/targetinputs", h.handleMetadataTargetInputs).Methods("GET")
	r.HandleFunc("/metadata/targetranges", h.handleMetadataTargetRanges).Methods("GET")
	r.HandleFunc("/metadata/canmap", h.handleMetadataCanMap).Methods("GET")
	r.HandleFunc("/metadata/cangraph", h.handleMetadataCanGraph).Methods("GET")
	r.HandleFunc("/metadata/axislabels", h.handleMetadataAxisLabels).Methods("GET")
	r.HandleFunc("/metadata/xaxislabels", h.handleMetadataXAxisLabels).Methods("GET")
	r.HandleFunc("/metadata/units", h.handleMetadataUnits).Methods("GET")
	r.HandleFunc("/metadata/charttypes", h.handleMetadataChartTypes).Methods("GET")
	r.HandleFunc("/metadata/groupingvariables", h.handleMetadataGroupingVariables).Methods("GET")
	r.HandleFunc("/metadata/groupingvalues", h.handleMetadataGroupingValues).Methods("GET")
	r.HandleFunc("/metadata/dial0middle", h.handleMetadataDial0Middle).Methods("GET")
	r.HandleFunc("/scenario/{scenario}/{attribute}", h.handleScenarioData).Methods("GET")
	r.HandleFunc("/aggregate", h.handleAggregateData).Methods("GET")
	r.HandleFunc("/precalculate/full", h.handlePrecalculateFull).Methods("GET")
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
	r.HandleFunc("/catchments/bounds", h.handleCatchmentsBounds).Methods("GET")
	r.HandleFunc("/catchments/geometry/{id}", h.handleCatchmentGeometry).Methods("GET")
	r.HandleFunc("/catchments/in-bbox", h.handleCatchmentsInBBox).Methods("POST")

	// Site indicators
	r.HandleFunc("/sites/{id}/indicators", h.handleGetSiteIndicators).Methods("GET")
	r.HandleFunc("/sites/{id}/indicators", h.handleExtractIndicators).Methods("POST")
	r.HandleFunc("/sites/{id}/indicators", h.handleUpdateIndicators).Methods("PATCH")
	r.HandleFunc("/sites/{id}/indicators/reset", h.handleResetIdealIndicators).Methods("POST")
	r.HandleFunc("/sites/{id}/catchments", h.handleSiteCatchments).Methods("GET", "POST")
	r.HandleFunc("/sites/{id}/whiskers", h.handleSiteWhiskers).Methods("GET", "POST")

	// Site boundary editing (union/difference with catchments)
	r.HandleFunc("/sites/{id}/boundary/union/{catchmentId}", h.handleBoundaryUnion).Methods("POST")
	r.HandleFunc("/sites/{id}/boundary/difference/{catchmentId}", h.handleBoundaryDifference).Methods("POST")
}

// handleMetadataColors returns a map of attribute column names to hex colors.
func (h *Handler) handleMetadataColors(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.Colors)
}

// handleMetadataDetails returns a map of attribute column names to detailed names.
func (h *Handler) handleMetadataDetails(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.Details)
}

// handleMetadataVariableTypes returns a map of attribute column names to variable types.
func (h *Handler) handleMetadataVariableTypes(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.VariableTypes)
}

// handleMetadataInputs returns a map of attribute column names to user input flags.
func (h *Handler) handleMetadataInputs(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.Inputs)
}

// handleMetadataTargetInputs returns a map of attribute column names to target input flags.
func (h *Handler) handleMetadataTargetInputs(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.TargetInputs)
}

// TargetRange holds optional min/max bounds for a target input slider.
// A nil pointer means no bound is defined in metadata.csv.
type TargetRange struct {
	Min *float64 `json:"min"`
	Max *float64 `json:"max"`
}

// handleMetadataTargetRanges returns per-column Target_min/Target_max bounds.
func (h *Handler) handleMetadataTargetRanges(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.TargetRanges)
}

// handleMetadataCanMap returns a map of attribute column names to canMap flags.
func (h *Handler) handleMetadataCanMap(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.CanMap)
}

// handleMetadataCanGraph returns a map of attribute column names to canGraph flags.
func (h *Handler) handleMetadataCanGraph(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.CanGraph)
}

// handleMetadataDial0Middle returns a map of attribute column names to
// dial_0_middle flags, indicating whether the dial gauge should center on
// zero with positive values to the right and negative values to the left.
func (h *Handler) handleMetadataDial0Middle(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.Dial0Middle)
}

// handleMetadataAxisLabels returns a map of attribute column names to axis labels.
func (h *Handler) handleMetadataAxisLabels(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.AxisLabels)
}

// handleMetadataXAxisLabels returns a map of attribute column names to x-axis labels.
func (h *Handler) handleMetadataXAxisLabels(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.XAxisLabels)
}

// handleMetadataUnits returns a map of attribute column names to units.
func (h *Handler) handleMetadataUnits(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.Units)
}

// handleMetadataChartTypes returns a map of attribute column names to chart types.
func (h *Handler) handleMetadataChartTypes(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.ChartTypes)
}

// handleMetadataGroupingVariables returns a map of attribute column names to grouping variable values.
func (h *Handler) handleMetadataGroupingVariables(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.GroupingVariables)
}

// handleMetadataGroupingValues returns a map of attribute column names to their GroupingValues.
func (h *Handler) handleMetadataGroupingValues(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusOK, h.metaCache.GroupingValues)
}

// respondJSON sends a JSON response (delegates to httputil)
func respondJSON(w http.ResponseWriter, status int, data interface{}) {
	httputil.RespondJSON(w, status, data)
}

// respondError sends a JSON error response (delegates to httputil)
func respondError(w http.ResponseWriter, status int, message string) {
	httputil.RespondError(w, status, message)
}

var dotNormalizer = regexp.MustCompile(`\.{2,}`)

func normalizeMetadataColor(raw string) string {
	color := strings.TrimSpace(raw)
	if color == "" {
		return ""
	}

	if !strings.HasPrefix(color, "#") {
		color = "#" + color
	}

	body := strings.ToUpper(strings.TrimPrefix(color, "#"))
	if body == "" {
		return ""
	}

	// Fix common OCR-style typos seen in metadata color values.
	body = strings.NewReplacer(
		"O", "0",
		"I", "1",
		"L", "1",
		"S", "5",
	).Replace(body)

	if l := len(body); l != 3 && l != 4 && l != 6 && l != 8 {
		return ""
	}

	for _, ch := range body {
		if (ch < '0' || ch > '9') && (ch < 'A' || ch > 'F') {
			return ""
		}
	}

	return "#" + body
}

func normalizeMetadataColumn(name string) string {
	if name == "catchID" {
		return "catchment_id"
	}
	if name == "sp_current.catchID" || name == "sp_reference$catchID" || name == "sp_reference.catchID" {
		return ""
	}

	result := name
	result = strings.ReplaceAll(result, " - ", ".")
	result = strings.ReplaceAll(result, "-", ".")
	result = strings.ReplaceAll(result, " ", ".")
	result = strings.ReplaceAll(result, "$", ".")
	result = strings.ReplaceAll(result, "'s", ".s")
	result = strings.ReplaceAll(result, "'", ".")
	result = strings.ReplaceAll(result, "/", ".")
	result = strings.ReplaceAll(result, "+", ".")
	result = dotNormalizer.ReplaceAllString(result, ".")

	return result
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

// handleAggregateData returns area-weighted means for a scenario across one or more attributes.
// Query params:
//
//	scenario: scenario name (required)
//	attributes: comma-separated list of attribute column names (required)
//	minx,miny,maxx,maxy: optional bbox for extent aggregation
func (h *Handler) handleAggregateData(w http.ResponseWriter, r *http.Request) {
	if h.gpkgStore == nil {
		respondError(w, http.StatusNotFound, "no geo data loaded")
		return
	}

	q := r.URL.Query()
	scenario := strings.TrimSpace(q.Get("scenario"))
	if scenario == "" {
		respondError(w, http.StatusBadRequest, "scenario query parameter is required")
		return
	}

	rawAttrs := strings.TrimSpace(q.Get("attributes"))
	if rawAttrs == "" {
		respondError(w, http.StatusBadRequest, "attributes query parameter is required")
		return
	}

	parts := strings.Split(rawAttrs, ",")
	attributes := make([]string, 0, len(parts))
	for _, p := range parts {
		attr := strings.TrimSpace(p)
		if attr != "" {
			attributes = append(attributes, attr)
		}
	}
	if len(attributes) == 0 {
		respondError(w, http.StatusBadRequest, "no valid attributes provided")
		return
	}

	var bbox *[4]float64
	hasMinX := q.Get("minx") != ""
	hasMinY := q.Get("miny") != ""
	hasMaxX := q.Get("maxx") != ""
	hasMaxY := q.Get("maxy") != ""
	if hasMinX || hasMinY || hasMaxX || hasMaxY {
		if !(hasMinX && hasMinY && hasMaxX && hasMaxY) {
			respondError(w, http.StatusBadRequest, "minx,miny,maxx,maxy must all be provided together")
			return
		}

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
		bbox = &[4]float64{minx, miny, maxx, maxy}
	}

	aggStart := time.Now()
	agg, err := h.gpkgStore.GetScenarioAverages(scenario, attributes, bbox)
	log.Printf("[perf] handleAggregateData scenario=%s attributes=%d hasBbox=%v duration_ms=%d", scenario, len(attributes), bbox != nil, time.Since(aggStart).Milliseconds())
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, agg)
}

// handlePrecalculateFull returns precomputed area-weighted means for all
// attributes across the full dataset for both reference and current scenarios.
// The result is computed once and cached in memory for the server lifetime so
// subsequent requests (e.g. quad-view panes all loading on startup) are served
// instantly without hitting the database again.
func (h *Handler) handlePrecalculateFull(w http.ResponseWriter, r *http.Request) {
	if h.gpkgStore == nil {
		respondError(w, http.StatusNotFound, "no geo data loaded")
		return
	}

	h.fullDomainMu.Lock()
	cached := h.fullDomainCache
	h.fullDomainMu.Unlock()

	if cached != nil {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "public, max-age=3600")
		json.NewEncoder(w).Encode(cached)
		return
	}

	columns := h.gpkgStore.GetColumns()
	if len(columns) == 0 {
		respondError(w, http.StatusInternalServerError, "no columns available")
		return
	}

	start := time.Now()
	refAgg, err := h.gpkgStore.GetScenarioAverages("reference", columns, nil)
	if err != nil {
		respondError(w, http.StatusInternalServerError, fmt.Sprintf("failed to compute reference averages: %v", err))
		return
	}
	curAgg, err := h.gpkgStore.GetScenarioAverages("current", columns, nil)
	if err != nil {
		respondError(w, http.StatusInternalServerError, fmt.Sprintf("failed to compute current averages: %v", err))
		return
	}
	log.Printf("[perf] handlePrecalculateFull columns=%d duration_ms=%d", len(columns), time.Since(start).Milliseconds())

	data := &FullDomainData{
		Reference: refAgg,
		Current:   curAgg,
	}

	h.fullDomainMu.Lock()
	h.fullDomainCache = data
	h.fullDomainMu.Unlock()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	json.NewEncoder(w).Encode(data)
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
	start := time.Now()
	q := r.URL.Query()
	scenario := q.Get("scenario")
	if scenario == "" {
		scenario = "current"
	}
	attribute := q.Get("attribute")
	defer func() {
		log.Printf("[perf] handleChoropleth scenario=%s attribute=%s duration_ms=%d", scenario, attribute, time.Since(start).Milliseconds())
	}()

	if h.gpkgStore == nil {
		respondError(w, http.StatusServiceUnavailable, "geopackage store not available")
		return
	}

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

	// zoom is optional; callers that omit it (or send a non-numeric value)
	// get full-detail geometry, matching the pre-existing behaviour.
	zoom, err := strconv.ParseFloat(q.Get("zoom"), 64)
	if err != nil {
		zoom = geodata.DetailZoomThreshold
	}

	// For the future/target scenario with a known site, build a lookup of
	// per-catchment ideal values so the choropleth shows user-edited targets.
	siteID := q.Get("siteId")
	var idealOverrides map[int64]float64
	if scenario == "future" && siteID != "" && h.siteStore != nil {
		if site, siteErr := h.siteStore.Get(siteID); siteErr == nil {
			idealOverrides = make(map[int64]float64, len(site.Catchments))
			for _, c := range site.Catchments {
				if c.Ideal == nil {
					continue
				}
				val, ok := c.Ideal[attribute]
				if !ok {
					continue
				}
				if idF, parseErr := strconv.ParseFloat(c.ID, 64); parseErr == nil {
					idealOverrides[int64(idF)] = val
				}
			}
		}
	}

	// Use reference geometry when overlaying ideal values; future without a
	// site falls back to reference as before.
	queryScenario := scenario
	if scenario == "future" {
		queryScenario = "reference"
	}

	// Query catchments. valuesOnly requests bypass the zoom-based render paths
	// entirely: they're used for statistics that need true full-dataset
	// accuracy (and, for site stats, real per-catchment HYBAS_ID to filter by)
	// rather than a bounded, renderable feature count.
	queryStart := time.Now()
	var fc *geodata.FeatureCollection
	if q.Get("valuesOnly") == "1" {
		fc, err = h.gpkgStore.QueryCatchmentValues(queryScenario, attribute, minx, miny, maxx, maxy)
	} else {
		fc, err = h.gpkgStore.QueryCatchments(queryScenario, attribute, minx, miny, maxx, maxy, zoom)
	}
	log.Printf("[perf] handleChoropleth step=queryCatchments scenario=%s attribute=%s features=%d duration_ms=%d", queryScenario, attribute, func() int {
		if fc != nil {
			return len(fc.Features)
		}
		return 0
	}(), time.Since(queryStart).Milliseconds())
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Overlay site-specific ideal values onto the GeoJSON features.
	if len(idealOverrides) > 0 {
		for i := range fc.Features {
			if hybasID, ok := fc.Features[i].Properties["HYBAS_ID"].(int64); ok {
				if idealVal, exists := idealOverrides[hybasID]; exists {
					fc.Features[i].Properties[attribute] = idealVal
				}
			}
		}
	}

	// Get domain range for consistent color scaling across scenarios
	domainStart := time.Now()
	domainRange, err := h.gpkgStore.GetDomainRange(attribute)
	log.Printf("[perf] handleChoropleth step=getDomainRange attribute=%s duration_ms=%d", attribute, time.Since(domainStart).Milliseconds())
	if err != nil {
		// If domain tables don't exist, fall back to no domain range
		log.Printf("Warning: could not get domain range for %s: %v", attribute, err)
		domainRange = &geodata.DomainRange{Min: 0, Max: 0}
	}

	// Prefer metadata.csv's curated maxval_curr/maxval_ref over the scanned
	// domain_maxima table for the max bound — these are authoritative
	// per-scenario ceilings rather than a value derived from scanning every
	// catchment. "future" (target) values are edited starting from current,
	// so they share current's ceiling. Falls back to the scanned max when a
	// column is missing/blank for this attribute.
	maxvalByScenario := h.metaCache.MaxValReference
	if scenario != "reference" {
		maxvalByScenario = h.metaCache.MaxValCurrent
	}
	if metaMax, ok := maxvalByScenario[attribute]; ok {
		domainRange.Max = metaMax
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
	start := time.Now()
	id := mux.Vars(r)["id"]
	defer func() {
		log.Printf("[perf] handleGetSite site_id=%s duration_ms=%d", id, time.Since(start).Milliseconds())
	}()

	if h.siteStore == nil {
		respondError(w, http.StatusNotFound, "site store not initialized")
		return
	}

	site, err := h.siteStore.Get(id)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}

	// Strip the large per-catchment indicator arrays — they can be several MB for
	// sites with 50+ catchments and are only needed by GET /sites/{id}/catchments.
	// Omitting them here cuts response size and parse time dramatically.
	site.Catchments = nil

	respondJSON(w, http.StatusOK, site)
}

// waitForPendingCatchments waits (up to timeout) for the deferred goroutine that
// populates site.Catchments after creation, then reloads the site from the store.
// Returns the (possibly refreshed) site once the goroutine finishes or times out.
func (h *Handler) waitForPendingCatchments(site *sites.Site, timeout time.Duration) *sites.Site {
	if ch, ok := h.pendingCatchments.Load(site.ID); ok {
		select {
		case <-ch.(chan struct{}):
		case <-time.After(timeout):
			log.Printf("[perf] waitForPendingCatchments timeout site_id=%s", site.ID)
			return site
		}
		if refreshed, err := h.siteStore.Get(site.ID); err == nil {
			return refreshed
		}
	}
	return site
}

func (h *Handler) populateSiteCatchmentDetails(site *sites.Site) error {
	start := time.Now()
	defer func() {
		catchmentCount := 0
		siteID := ""
		if site != nil {
			catchmentCount = len(site.CatchmentIDs)
			siteID = site.ID
		}
		log.Printf("[perf] populateSiteCatchmentDetails site_id=%s catchments=%d duration_ms=%d", siteID, catchmentCount, time.Since(start).Milliseconds())
	}()

	if site == nil {
		return nil
	}
	if h.gpkgStore == nil {
		return nil
	}
	if len(site.CatchmentIDs) == 0 {
		site.Catchments = nil
		return nil
	}

	indicatorsStart := time.Now()
	catchmentData, err := h.gpkgStore.GetCatchmentIndicatorsByIDs(site.CatchmentIDs)
	if err != nil {
		return err
	}
	log.Printf("[perf] populateSiteCatchmentDetails step=getIndicators site_id=%s catchments=%d rows=%d duration_ms=%d", site.ID, len(site.CatchmentIDs), len(catchmentData), time.Since(indicatorsStart).Milliseconds())
	// Catchment-created sites are dissolved from the selected catchments, so every
	// catchment is by definition 100% inside the boundary (AOIFraction = 1.0).
	// Skip the expensive geometry fetch + polyclip intersection in that case.
	if len(site.Geometry) > 0 && site.CreationMethod != "catchments" {
		aoiStart := time.Now()
		if err := h.gpkgStore.ApplyAOIFractions(catchmentData, site.Geometry); err != nil {
			return err
		}
		log.Printf("[perf] populateSiteCatchmentDetails step=applyAOIFractions site_id=%s catchments=%d duration_ms=%d", site.ID, len(site.CatchmentIDs), time.Since(aoiStart).Milliseconds())
	}

	persisted := make([]sites.SiteCatchment, 0, len(catchmentData))
	for _, c := range catchmentData {
		ideal := make(map[string]float64, len(c.Reference))
		for k, v := range c.Reference {
			ideal[k] = v
		}
		for k, v := range c.Current {
			ideal[k] = v
		}
		persisted = append(persisted, sites.SiteCatchment{
			ID:          c.ID,
			AreaKm2:     c.AreaKm2,
			AOIFraction: c.AOIFraction,
			Reference:   c.Reference,
			Current:     c.Current,
			Ideal:       ideal,
		})
	}

	site.Catchments = persisted
	return nil
}

func (h *Handler) populateSiteCatchmentDetailsDeferred(siteID string, catchmentIDs []string, geometry json.RawMessage) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] populateSiteCatchmentDetailsDeferred site_id=%s catchments=%d duration_ms=%d", siteID, len(catchmentIDs), time.Since(start).Milliseconds())
	}()

	if h.siteStore == nil || h.gpkgStore == nil || len(catchmentIDs) == 0 {
		return
	}

	transientSite := &sites.Site{
		ID:           siteID,
		CatchmentIDs: append([]string(nil), catchmentIDs...),
		Geometry:     append(json.RawMessage(nil), geometry...),
	}
	if err := h.populateSiteCatchmentDetails(transientSite); err != nil {
		log.Printf("Warning: deferred site catchment enrichment failed site_id=%s err=%v", siteID, err)
		return
	}

	if _, err := h.siteStore.Update(siteID, &sites.Site{Catchments: transientSite.Catchments}); err != nil {
		log.Printf("Warning: deferred site catchment persistence failed site_id=%s err=%v", siteID, err)
	}
}

func siteCatchmentsToIndicators(catchments []sites.SiteCatchment) []geodata.CatchmentIndicators {
	if len(catchments) == 0 {
		return nil
	}

	result := make([]geodata.CatchmentIndicators, 0, len(catchments))
	for _, c := range catchments {
		result = append(result, geodata.CatchmentIndicators{
			ID:          c.ID,
			AreaKm2:     c.AreaKm2,
			AOIFraction: c.AOIFraction,
			Reference:   c.Reference,
			Current:     c.Current,
			Ideal:       c.Ideal,
		})
	}

	return result
}

// handleCreateSite creates a new site
func (h *Handler) handleCreateSite(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] handleCreateSite duration_ms=%d", time.Since(start).Milliseconds())
	}()

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

	if len(created.CatchmentIDs) > 0 {
		catchmentIDs := append([]string(nil), created.CatchmentIDs...)
		geometry := append(json.RawMessage(nil), created.Geometry...)
		log.Printf("[perf] handleCreateSite step=deferCatchmentDetails site_id=%s catchments=%d", created.ID, len(catchmentIDs))
		done := make(chan struct{})
		h.pendingCatchments.Store(created.ID, done)
		go func() {
			defer func() {
				h.pendingCatchments.Delete(created.ID)
				close(done)
			}()
			h.populateSiteCatchmentDetailsDeferred(created.ID, catchmentIDs, geometry)
		}()
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
	if len(updates.CatchmentIDs) > 0 && len(updates.Geometry) == 0 && h.siteStore != nil {
		existing, getErr := h.siteStore.Get(id)
		if getErr == nil && existing != nil {
			updates.Geometry = existing.Geometry
		}
	}
	if err := h.populateSiteCatchmentDetails(&updates); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to build catchment details: "+err.Error())
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

type CatchmentsInBBoxRequest struct {
	MinX            float64 `json:"minX"`
	MinY            float64 `json:"minY"`
	MaxX            float64 `json:"maxX"`
	MaxY            float64 `json:"maxY"`
	Limit           int     `json:"limit"`
	IncludeGeometry *bool   `json:"includeGeometry,omitempty"`
}

type CatchmentsInBBoxResponse struct {
	Type         string                   `json:"type"`
	Features     []geodata.GeoJSONFeature `json:"features"`
	CatchmentIDs []string                 `json:"catchmentIds"`
	Truncated    bool                     `json:"truncated"`
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

// handleCatchmentsBounds returns the global bounding box for all catchments.
func (h *Handler) handleCatchmentsBounds(w http.ResponseWriter, r *http.Request) {
	if h.gpkgStore == nil {
		respondError(w, http.StatusServiceUnavailable, "geopackage store not available")
		return
	}

	bounds, err := h.gpkgStore.GetCatchmentsBounds()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, map[string]float64{
		"minX": bounds[0],
		"minY": bounds[1],
		"maxX": bounds[2],
		"maxY": bounds[3],
	})
}

// handleCatchmentsInBBox returns catchment features intersecting a map bounding box.
func (h *Handler) handleCatchmentsInBBox(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] handleCatchmentsInBBox duration_ms=%d", time.Since(start).Milliseconds())
	}()

	if h.gpkgStore == nil {
		respondError(w, http.StatusServiceUnavailable, "geopackage store not available")
		return
	}

	var req CatchmentsInBBoxRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.MinX > req.MaxX || req.MinY > req.MaxY {
		respondError(w, http.StatusBadRequest, "invalid bounding box")
		return
	}

	// A limit of 0 (or negative) means no limit — return every catchment in the bbox.
	limit := req.Limit
	if limit < 0 {
		limit = 0
	}
	includeGeometry := true
	if req.IncludeGeometry != nil {
		includeGeometry = *req.IncludeGeometry
	}

	if !includeGeometry {
		ids, err := h.gpkgStore.GetCatchmentIDsByBBox(req.MinX, req.MinY, req.MaxX, req.MaxY, limit)
		if err != nil {
			respondError(w, http.StatusInternalServerError, err.Error())
			return
		}

		response := CatchmentsInBBoxResponse{
			Type:         "FeatureCollection",
			Features:     []geodata.GeoJSONFeature{},
			CatchmentIDs: ids,
			Truncated:    limit > 0 && len(ids) >= limit,
		}

		respondJSON(w, http.StatusOK, response)
		return
	}

	features, err := h.gpkgStore.GetCatchmentsByBBox(req.MinX, req.MinY, req.MaxX, req.MaxY, limit)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	ids := make([]string, 0, len(features))
	for _, feature := range features {
		ids = append(ids, strconv.FormatInt(feature.ID, 10))
	}

	response := CatchmentsInBBoxResponse{
		Type:         "FeatureCollection",
		Features:     features,
		CatchmentIDs: ids,
		Truncated:    limit > 0 && len(features) >= limit,
	}

	respondJSON(w, http.StatusOK, response)
}

// ============================================================================
// Site Indicators Handlers
// ============================================================================

// ExtractIndicatorsRequest represents the request body for indicator extraction
type ExtractIndicatorsRequest struct {
	Runtime string                 `json:"runtime"`
	Site    map[string]interface{} `json:"site"`
}

// doSiteExtraction performs the full indicator extraction for a site and saves to disk.
// Called from a background goroutine for webview runtime.
func (h *Handler) doSiteExtraction(id string) error {
	start := time.Now()
	defer func() {
		log.Printf("[perf] doSiteExtraction site_id=%s duration_ms=%d", id, time.Since(start).Milliseconds())
	}()

	site, err := h.siteStore.Get(id)
	if err != nil {
		return fmt.Errorf("get site: %w", err)
	}

	catchmentIDs := site.CatchmentIDs
	if len(catchmentIDs) == 0 {
		return fmt.Errorf("site %s has no catchments", id)
	}

	// Wait for the deferred catchment goroutine so we use cache rather than competing for DB.
	if len(site.Catchments) == 0 {
		site = h.waitForPendingCatchments(site, 10*time.Second)
		catchmentIDs = site.CatchmentIDs
	}

	var catchmentData []geodata.CatchmentIndicators
	if len(site.Catchments) > 0 {
		catchmentData = siteCatchmentsToIndicators(site.Catchments)
		log.Printf("[perf] doSiteExtraction step=useCachedCatchments site_id=%s catchments=%d", id, len(catchmentData))
	} else {
		catchmentData, err = h.gpkgStore.GetCatchmentIndicatorsByIDs(catchmentIDs)
		if err != nil {
			return fmt.Errorf("get catchment data: %w", err)
		}
		if len(site.Geometry) > 0 && site.CreationMethod != "catchments" {
			if aoiErr := h.gpkgStore.ApplyAOIFractions(catchmentData, site.Geometry); aoiErr != nil {
				log.Printf("Warning: ApplyAOIFractions for %s: %v", id, aoiErr)
			}
		}
	}

	if len(catchmentData) == 0 {
		return fmt.Errorf("no catchment data for site %s", id)
	}

	indicators := computeAreaWeightedIndicators(catchmentData)
	indicators.CatchmentIDs = catchmentIDs
	site.Indicators = indicators

	freshCatchments := make([]sites.SiteCatchment, 0, len(catchmentData))
	for _, c := range catchmentData {
		ideal := make(map[string]float64, len(c.Reference))
		for k, v := range c.Reference {
			ideal[k] = v
		}
		for k, v := range c.Current {
			ideal[k] = v
		}
		freshCatchments = append(freshCatchments, sites.SiteCatchment{
			ID:          c.ID,
			AreaKm2:     c.AreaKm2,
			AOIFraction: c.AOIFraction,
			Reference:   c.Reference,
			Current:     c.Current,
			Ideal:       ideal,
		})
	}
	site.Catchments = freshCatchments

	if _, err := h.siteStore.Update(id, site); err != nil {
		return fmt.Errorf("update site: %w", err)
	}
	return nil
}

// handleGetSiteIndicators is the polling endpoint for async extraction.
// Returns 200 + site (without catchments) once indicators are ready, or 202 while pending.
func (h *Handler) handleGetSiteIndicators(w http.ResponseWriter, r *http.Request) {
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
	if site.Indicators != nil {
		site.Catchments = nil
		respondJSON(w, http.StatusOK, site)
		return
	}
	if _, pending := h.pendingExtractions.Load(id); pending {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"status":"extracting"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"status":"idle"}`))
}

// handleExtractIndicators starts async indicator extraction for a site.
// For webview: returns 202 immediately, runs extraction in background.
// For browser: runs synchronously, returns extracted site.
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

	var req ExtractIndicatorsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		log.Printf("Warning: failed to decode extraction request body: %v", err)
	}

	// ── Browser runtime: synchronous extraction, return site directly ──────────
	if req.Runtime == "browser" {
		if len(req.Site) == 0 {
			respondError(w, http.StatusBadRequest, "browser runtime requires site data in request body")
			return
		}
		siteJSON, marshalErr := json.Marshal(req.Site)
		if marshalErr != nil {
			respondError(w, http.StatusBadRequest, "invalid site data in request body")
			return
		}
		var site sites.Site
		if err := json.Unmarshal(siteJSON, &site); err != nil {
			respondError(w, http.StatusBadRequest, "invalid site data in request body")
			return
		}
		catchmentIDs := site.CatchmentIDs
		if len(catchmentIDs) == 0 {
			respondError(w, http.StatusBadRequest, "site has no associated catchments")
			return
		}
		catchmentData, err := h.gpkgStore.GetCatchmentIndicatorsByIDs(catchmentIDs)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to get catchment data: "+err.Error())
			return
		}
		if len(site.Geometry) > 0 && site.CreationMethod != "catchments" {
			if aoiErr := h.gpkgStore.ApplyAOIFractions(catchmentData, site.Geometry); aoiErr != nil {
				log.Printf("Warning: ApplyAOIFractions for browser site: %v", aoiErr)
			}
		}
		if len(catchmentData) == 0 {
			respondError(w, http.StatusNotFound, "no data found for catchments")
			return
		}
		indicators := computeAreaWeightedIndicators(catchmentData)
		indicators.CatchmentIDs = catchmentIDs
		site.Indicators = indicators
		// Strip catchments from browser response — large data, frontend uses separate endpoint
		site.Catchments = nil
		respondJSON(w, http.StatusOK, &site)
		return
	}

	// ── Webview runtime: async extraction ─────────────────────────────────────
	site, err := h.siteStore.Get(id)
	if err != nil {
		respondError(w, http.StatusNotFound, err.Error())
		return
	}
	if len(site.CatchmentIDs) == 0 {
		respondError(w, http.StatusBadRequest, "site has no associated catchments")
		return
	}

	// If extraction is already running for this site, just return 202.
	if _, alreadyRunning := h.pendingExtractions.Load(id); alreadyRunning {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"status":"extracting"}`))
		return
	}

	h.pendingExtractions.Store(id, struct{}{})
	go func() {
		defer h.pendingExtractions.Delete(id)
		if err := h.doSiteExtraction(id); err != nil {
			log.Printf("Async extraction failed for site %s: %v", id, err)
		}
	}()

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_, _ = w.Write([]byte(`{"status":"extracting"}`))
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

	// Step 1: Calculate valid AOI area for each catchment
	validAreas := make([]float64, len(catchments))
	totalValidArea := 0.0

	for i, c := range catchments {
		// Ensure frac_i exists and is between 0 and 1
		frac := c.AOIFraction // This should be provided per catchment
		if frac < 0 {
			frac = 0
		} else if frac > 1 {
			frac = 1
		}

		validAreas[i] = c.AreaKm2 * frac
		totalValidArea += validAreas[i]
	}

	// Step 2: Handle case where no valid area exists
	if totalValidArea == 0 {
		// Fallback: treat all catchments equally
		totalValidArea = float64(len(catchments))
		for i := range validAreas {
			validAreas[i] = 1.0
		}
	}

	indicators.TotalAreaKm2 = totalValidArea

	// Step 3: Collect all unique metric keys
	allKeys := make(map[string]bool)
	for _, c := range catchments {
		for k := range c.Reference {
			allKeys[k] = true
		}
		for k := range c.Current {
			allKeys[k] = true
		}
	}

	// Step 5: Compute AOI-weighted metrics.
	// The denominator is per-key (only the area of catchments that actually
	// have a value for this key), not the site's total valid area — otherwise
	// a catchment missing this one attribute still counts toward the
	// denominator with an implicit 0 numerator contribution, silently
	// diluting the average toward 0 for any attribute a few catchments lack
	// (matches the equivalent fix in the frontend's AggregateTable.tsx).
	for key := range allKeys {
		refSum := 0.0
		refArea := 0.0
		curSum := 0.0
		curArea := 0.0
		hadCur := false

		for i, c := range catchments {
			if val, ok := c.Reference[key]; ok {
				refSum += val * validAreas[i]
				refArea += validAreas[i]
			}
			if val, ok := c.Current[key]; ok {
				curSum += val * validAreas[i]
				curArea += validAreas[i]
				hadCur = true
			}
		}

		// Store the weighted values; only write Current when at least one catchment
		// had current data for this key — otherwise curSum stays 0 which is misleading
		// (e.g. a column that only exists in reference would appear as current=0).
		// Ideal starts as a copy of Current (falling back to Reference for keys with
		// no current data) since the target state is user-editable from that baseline.
		if refArea > 0 {
			indicators.Reference[key] = refSum / refArea
		}
		if hadCur && curArea > 0 {
			indicators.Current[key] = curSum / curArea
			indicators.Ideal[key] = curSum / curArea
		} else {
			indicators.Ideal[key] = indicators.Reference[key]
		}
	}

	// Recompute fire-cascade derived values (fuelload, intensity, percBurned, …)
	// from the aggregated inputs so all three scenarios are internally consistent.
	// These are derived quantities; the raw inputs (NPP, litter, DMI, lowTC_prop)
	// are the ground truth and must remain as aggregated from the GeoPackage.
	workflow4FireCascade(indicators.Reference)
	workflow4FireCascade(indicators.Ideal)
	if len(indicators.Current) > 0 {
		workflow4FireCascade(indicators.Current)
	}

	return indicators
}

// UpdateIndicatorsRequest represents a request to update indicator values
type UpdateIndicatorsRequest struct {
	Runtime        string                 `json:"runtime"`
	Site           map[string]interface{} `json:"site"`
	Ideal          map[string]float64     `json:"ideal"`
	IdealLower     map[string]float64     `json:"idealLower"`
	IdealUpper     map[string]float64     `json:"idealUpper"`
	Reference      map[string]float64     `json:"reference"`
	ReferenceLower map[string]float64     `json:"referenceLower"`
	ReferenceUpper map[string]float64     `json:"referenceUpper"`
	Current        map[string]float64     `json:"current"`
	CurrentLower   map[string]float64     `json:"currentLower"`
	CurrentUpper   map[string]float64     `json:"currentUpper"`
}

// handleUpdateIndicators updates the indicator values for a site.
// When a TargetInputsAllowed field (lowTC_prop or herbs_tot_kgkm2) is included
// in req.Ideal the handler runs the appropriate cascading recalculations before
// persisting, so that derived indicators remain ecologically consistent.
func (h *Handler) handleUpdateIndicators(w http.ResponseWriter, r *http.Request) {
	if h.siteStore == nil {
		respondError(w, http.StatusInternalServerError, "site store not initialized")
		return
	}

	id := mux.Vars(r)["id"]

	var req UpdateIndicatorsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	var site *sites.Site
	var err error

	if req.Runtime == "browser" {
		if len(req.Site) == 0 {
			respondError(w, http.StatusBadRequest, "browser runtime requires site data in request body")
			return
		}
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
		site, err = h.siteStore.Get(id)
		if err != nil {
			respondError(w, http.StatusNotFound, err.Error())
			return
		}
	}

	if site.Indicators == nil {
		respondError(w, http.StatusBadRequest, "site has no indicators - extract them first")
		return
	}

	mergeMap := func(dst *map[string]float64, src map[string]float64) {
		if len(src) == 0 {
			return
		}
		if *dst == nil {
			*dst = make(map[string]float64)
		}
		for k, v := range src {
			(*dst)[k] = v
		}
	}

	// Capture the full pre-merge ideal map so recalculations can derive
	// scale factors (e.g. per-capita biomass for species count changes).
	oldIdeal := make(map[string]float64, len(site.Indicators.Ideal))
	for k, v := range site.Indicators.Ideal {
		oldIdeal[k] = v
	}

	// Section 1.2: if highTC_prop was edited directly, derive lowTC_prop from it
	// so that workflow1TreeCover handles the cascade via the lowTC_prop path.
	if newHighTC, ok := req.Ideal[colHighTCProp]; ok && newHighTC != oldIdeal[colHighTCProp] {
		req.Ideal[colLowTCProp] = 1 - newHighTC
	}

	// Determine which primary target inputs changed.
	targetInputCols := []string{colLowTCProp, colHerbsTot, colNPP, colPropEarly, colMeanTC}
	changedTargets := make(map[string]bool)
	for _, col := range targetInputCols {
		if newVal, ok := req.Ideal[col]; ok && newVal != oldIdeal[col] {
			changedTargets[col] = true
		}
	}

	// Detect changed species counts (herbs_sp_counts_<Species>).
	changedSpeciesCounts := make(map[string]bool)
	for k, newVal := range req.Ideal {
		if strings.HasPrefix(k, colHerbsSpCountsPrefix) {
			if oldVal, exists := oldIdeal[k]; !exists || newVal != oldVal {
				changedSpeciesCounts[k] = true
			}
		}
	}

	// Detect changed per-species biomass (herbs_sp_kgkm2_<Species>).
	// Only treated as a direct biomass edit when no species counts also changed
	// (count changes already cascade through workflow2aSpeciesCounts).
	changedSpeciesBiomass := make(map[string]bool)
	if len(changedSpeciesCounts) == 0 {
		for k, newVal := range req.Ideal {
			if strings.HasPrefix(k, colHerbsSpKgkm2Prefix) {
				if oldVal, exists := oldIdeal[k]; !exists || newVal != oldVal {
					changedSpeciesBiomass[k] = true
				}
			}
		}
	}

	// Detect changes to any biomass-class proportion (prop_X*Mgha).
	// These feed into lowTC_prop / highTC_prop so workflow1 must rerun.
	propClassChanged := false
	for _, k := range allBiomassClasses {
		if newVal, ok := req.Ideal[k]; ok && newVal != oldIdeal[k] {
			propClassChanged = true
			break
		}
	}

	mergeMap(&site.Indicators.Ideal, req.Ideal)
	mergeMap(&site.Indicators.IdealLower, req.IdealLower)
	mergeMap(&site.Indicators.IdealUpper, req.IdealUpper)
	mergeMap(&site.Indicators.Reference, req.Reference)
	mergeMap(&site.Indicators.ReferenceLower, req.ReferenceLower)
	mergeMap(&site.Indicators.ReferenceUpper, req.ReferenceUpper)
	mergeMap(&site.Indicators.Current, req.Current)
	mergeMap(&site.Indicators.CurrentLower, req.CurrentLower)
	mergeMap(&site.Indicators.CurrentUpper, req.CurrentUpper)

	// Run cascading recalculations when any target inputs changed.
	if (len(changedTargets) > 0 || len(changedSpeciesCounts) > 0 || len(changedSpeciesBiomass) > 0 || propClassChanged) && site.Indicators.Ideal != nil {
		// Populate catchments before building lookup data so AOIFraction and
		// catchment IDs are available for site-level NPP/SOC aggregation.
		if len(site.Catchments) == 0 && h.gpkgStore != nil && len(site.CatchmentIDs) > 0 {
			if popErr := h.populateSiteCatchmentDetails(site); popErr != nil {
				log.Printf("Warning: could not populate catchments for ideal propagation site_id=%s: %v", id, popErr)
			}
		}
		lookup := h.getLookups().BuildLookupData(site)
		recalculateIdeal(site.Indicators.Ideal, changedTargets, oldIdeal, changedSpeciesCounts, changedSpeciesBiomass, propClassChanged, lookup)

		// If the recalculated target state violates ecological constraints,
		// revert the ideal and return with warnings — do not propagate or save.
		if warnings := collectTargetStateWarnings(site.Indicators.Ideal, site.Indicators.Reference, site.Indicators.Current); len(warnings) > 0 {
			site.Indicators.Ideal = oldIdeal
			site.Indicators.Warnings = warnings
			respondJSON(w, http.StatusOK, site)
			return
		}

		// Propagate updated ideal values back to individual catchments.
		if len(site.Catchments) > 0 {
			var siteRef map[string]float64
			if site.Indicators != nil {
				siteRef = site.Indicators.Reference
			}
			propagateIdealToCatchments(site.Catchments, oldIdeal, site.Indicators.Ideal, siteRef)
		}
	}

	if site.Indicators != nil {
		site.Indicators.Warnings = collectTargetStateWarnings(site.Indicators.Ideal, site.Indicators.Reference, site.Indicators.Current)
	}

	// For browser runtime, return the site directly without storing
	if req.Runtime == "browser" {
		respondJSON(w, http.StatusOK, site)
		return
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

	// Reset ideal to current values (falling back to reference for any key
	// with no current value) — the target's baseline is the current state.
	site.Indicators.Ideal = make(map[string]float64)
	for key, value := range site.Indicators.Reference {
		site.Indicators.Ideal[key] = value
	}
	for key, value := range site.Indicators.Current {
		site.Indicators.Ideal[key] = value
	}
	site.Indicators.Warnings = nil

	// Reset each catchment's ideal to its current values (same fallback).
	for i := range site.Catchments {
		ideal := make(map[string]float64, len(site.Catchments[i].Reference))
		for k, v := range site.Catchments[i].Reference {
			ideal[k] = v
		}
		for k, v := range site.Catchments[i].Current {
			ideal[k] = v
		}
		site.Catchments[i].Ideal = ideal
	}

	updated, err := h.siteStore.Update(id, site)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to update site: "+err.Error())
		return
	}

	respondJSON(w, http.StatusOK, updated)
}

// handleSiteCatchments returns per-catchment breakdown data for aggregate calculations
func (h *Handler) handleSiteCatchments(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] handleSiteCatchments method=%s duration_ms=%d", r.Method, time.Since(start).Milliseconds())
	}()

	if h.gpkgStore == nil {
		respondError(w, http.StatusServiceUnavailable, "geopackage store not available")
		return
	}

	vars := mux.Vars(r)
	id := vars["id"]

	var site *sites.Site
	var err error

	if r.Method == http.MethodPost {
		var req ExtractIndicatorsRequest
		if decodeErr := json.NewDecoder(r.Body).Decode(&req); decodeErr != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		if req.Runtime == "browser" {
			if len(req.Site) == 0 {
				respondError(w, http.StatusBadRequest, "browser runtime requires site data in request body")
				return
			}

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
			if h.siteStore == nil {
				respondError(w, http.StatusInternalServerError, "site store not initialized")
				return
			}
			site, err = h.siteStore.Get(id)
			if err != nil {
				respondError(w, http.StatusNotFound, err.Error())
				return
			}
		}
	} else {
		if h.siteStore == nil {
			respondError(w, http.StatusInternalServerError, "site store not initialized")
			return
		}
		site, err = h.siteStore.Get(id)
		if err != nil {
			respondError(w, http.StatusNotFound, err.Error())
			return
		}
	}

	if len(site.CatchmentIDs) == 0 && len(site.Catchments) == 0 {
		respondError(w, http.StatusBadRequest, "site has no associated catchments")
		return
	}

	// slim=true: return only id+areaKm2+aoiFraction — used by MapView for AOI filtering.
	// Avoids sending 100MB+ of indicator values the map view never reads.
	slim := r.URL.Query().Get("slim") == "true"

	if len(site.Catchments) > 0 && (len(site.CatchmentIDs) == 0 || len(site.Catchments) == len(site.CatchmentIDs)) {
		if slim {
			type slimCatchment struct {
				ID          string  `json:"id"`
				AreaKm2     float64 `json:"areaKm2"`
				AOIFraction float64 `json:"aoiFraction,omitempty"`
			}
			result := make([]slimCatchment, len(site.Catchments))
			for i, c := range site.Catchments {
				result[i] = slimCatchment{ID: c.ID, AreaKm2: c.AreaKm2, AOIFraction: c.AOIFraction}
			}
			respondJSON(w, http.StatusOK, result)
			return
		}
		respondJSON(w, http.StatusOK, siteCatchmentsToIndicators(site.Catchments))
		return
	}

	// Get indicator data for all catchments
	catchmentData, err := h.gpkgStore.GetCatchmentIndicatorsByIDs(site.CatchmentIDs)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to get catchment data: "+err.Error())
		return
	}
	if len(site.Geometry) > 0 && site.CreationMethod != "catchments" {
		if err := h.gpkgStore.ApplyAOIFractions(catchmentData, site.Geometry); err != nil {
			log.Printf("Warning: failed to compute AOI fractions for site %s: %v", id, err)
		}
	}

	if slim {
		type slimCatchment struct {
			ID          string  `json:"id"`
			AreaKm2     float64 `json:"areaKm2"`
			AOIFraction float64 `json:"aoiFraction,omitempty"`
		}
		result := make([]slimCatchment, len(catchmentData))
		for i, c := range catchmentData {
			result[i] = slimCatchment{ID: c.ID, AreaKm2: c.AreaKm2, AOIFraction: c.AOIFraction}
		}
		respondJSON(w, http.StatusOK, result)
		return
	}

	respondJSON(w, http.StatusOK, catchmentData)
}

// handleSiteWhiskers returns area-weighted upper/lower whisker bounds for a site's catchments.
// It supports both webview (GET, site looked up from store) and browser runtime (POST with site in body).
func (h *Handler) handleSiteWhiskers(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	defer func() {
		log.Printf("[perf] handleSiteWhiskers method=%s duration_ms=%d", r.Method, time.Since(start).Milliseconds())
	}()

	if h.gpkgStore == nil {
		respondError(w, http.StatusServiceUnavailable, "geopackage store not available")
		return
	}

	vars := mux.Vars(r)
	id := vars["id"]

	var site *sites.Site
	var err error

	if r.Method == http.MethodPost {
		var req ExtractIndicatorsRequest
		if decodeErr := json.NewDecoder(r.Body).Decode(&req); decodeErr != nil {
			respondError(w, http.StatusBadRequest, "invalid request body")
			return
		}

		if req.Runtime == "browser" {
			if len(req.Site) == 0 {
				respondError(w, http.StatusBadRequest, "browser runtime requires site data in request body")
				return
			}
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
			if h.siteStore == nil {
				respondError(w, http.StatusInternalServerError, "site store not initialized")
				return
			}
			site, err = h.siteStore.Get(id)
			if err != nil {
				respondError(w, http.StatusNotFound, err.Error())
				return
			}
		}
	} else {
		if h.siteStore == nil {
			respondError(w, http.StatusInternalServerError, "site store not initialized")
			return
		}
		site, err = h.siteStore.Get(id)
		if err != nil {
			respondError(w, http.StatusNotFound, err.Error())
			return
		}
	}

	if len(site.CatchmentIDs) == 0 && len(site.Catchments) == 0 {
		respondError(w, http.StatusBadRequest, "site has no associated catchments")
		return
	}

	// Return cached whisker bounds if already computed and stored in this site.
	if site.Indicators != nil && len(site.Indicators.ReferenceLower) > 0 {
		log.Printf("[perf] handleSiteWhiskers step=cached site_id=%s", id)
		bounds := geodata.WhiskerBounds{
			ReferenceLower: site.Indicators.ReferenceLower,
			ReferenceUpper: site.Indicators.ReferenceUpper,
			CurrentLower:   site.Indicators.CurrentLower,
			CurrentUpper:   site.Indicators.CurrentUpper,
		}
		respondJSON(w, http.StatusOK, bounds)
		return
	}

	catchmentData := []geodata.CatchmentIndicators(nil)
	if len(site.Catchments) > 0 && (len(site.CatchmentIDs) == 0 || len(site.Catchments) == len(site.CatchmentIDs)) {
		catchmentData = siteCatchmentsToIndicators(site.Catchments)
	} else {
		catchmentData, err = h.gpkgStore.GetCatchmentIndicatorsByIDs(site.CatchmentIDs)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to get catchment data: "+err.Error())
			return
		}
		if len(site.Geometry) > 0 && site.CreationMethod != "catchments" {
			if err := h.gpkgStore.ApplyAOIFractions(catchmentData, site.Geometry); err != nil {
				log.Printf("Warning: failed to compute AOI fractions for site %s: %v", id, err)
			}
		}
	}

	bounds := h.gpkgStore.ComputeWhiskerBounds(catchmentData)

	// Persist computed bounds into site indicators so subsequent requests are instant.
	if h.siteStore != nil && r.Method != http.MethodPost {
		if site.Indicators == nil {
			site.Indicators = &sites.SiteIndicators{}
		}
		site.Indicators.ReferenceLower = bounds.ReferenceLower
		site.Indicators.ReferenceUpper = bounds.ReferenceUpper
		site.Indicators.CurrentLower = bounds.CurrentLower
		site.Indicators.CurrentUpper = bounds.CurrentUpper
		if _, updateErr := h.siteStore.Update(id, site); updateErr != nil {
			log.Printf("Warning: failed to cache whisker bounds for site %s: %v", id, updateErr)
		}
	}

	respondJSON(w, http.StatusOK, bounds)
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

// normalizeUnionBoundaryGeometry removes interior rings from union results to avoid
// rendering artifacts (small internal loops/slivers) after repeated add-catchment edits.
func normalizeUnionBoundaryGeometry(geometry json.RawMessage) json.RawMessage {
	if len(geometry) == 0 {
		return geometry
	}

	var parsed struct {
		Type        string          `json:"type"`
		Coordinates json.RawMessage `json:"coordinates"`
	}
	if err := json.Unmarshal(geometry, &parsed); err != nil {
		return geometry
	}

	switch parsed.Type {
	case "Polygon":
		var coords [][][]float64
		if err := json.Unmarshal(parsed.Coordinates, &coords); err != nil {
			return geometry
		}
		if len(coords) <= 1 {
			return geometry
		}
		cleaned, err := json.Marshal(map[string]interface{}{
			"type":        "Polygon",
			"coordinates": coords[:1],
		})
		if err != nil {
			return geometry
		}
		return cleaned

	case "MultiPolygon":
		var coords [][][][]float64
		if err := json.Unmarshal(parsed.Coordinates, &coords); err != nil {
			return geometry
		}

		cleanedPolygons := make([][][][]float64, 0, len(coords))
		for _, polygon := range coords {
			if len(polygon) == 0 {
				continue
			}
			cleanedPolygons = append(cleanedPolygons, [][][]float64{polygon[0]})
		}

		cleaned, err := json.Marshal(map[string]interface{}{
			"type":        "MultiPolygon",
			"coordinates": cleanedPolygons,
		})
		if err != nil {
			return geometry
		}
		return cleaned
	}

	return geometry
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
	newGeometry = normalizeUnionBoundaryGeometry(newGeometry)

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
	if err := h.populateSiteCatchmentDetails(site); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to build catchment details: "+err.Error())
		return
	}

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
	if err := h.populateSiteCatchmentDetails(site); err != nil {
		respondError(w, http.StatusInternalServerError, "failed to build catchment details: "+err.Error())
		return
	}

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
