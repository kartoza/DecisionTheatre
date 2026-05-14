package api

import (
	"encoding/csv"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
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
	r.HandleFunc("/metadata/colors", h.handleMetadataColors).Methods("GET")
	r.HandleFunc("/metadata/details", h.handleMetadataDetails).Methods("GET")
	r.HandleFunc("/metadata/variabletypes", h.handleMetadataVariableTypes).Methods("GET")
	r.HandleFunc("/metadata/inputs", h.handleMetadataInputs).Methods("GET")
	r.HandleFunc("/metadata/targetinputs", h.handleMetadataTargetInputs).Methods("GET")
	r.HandleFunc("/metadata/canmap", h.handleMetadataCanMap).Methods("GET")
	r.HandleFunc("/metadata/cangraph", h.handleMetadataCanGraph).Methods("GET")
	r.HandleFunc("/metadata/axislabels", h.handleMetadataAxisLabels).Methods("GET")
	r.HandleFunc("/metadata/xaxislabels", h.handleMetadataXAxisLabels).Methods("GET")
	r.HandleFunc("/metadata/units", h.handleMetadataUnits).Methods("GET")
	r.HandleFunc("/metadata/charttypes", h.handleMetadataChartTypes).Methods("GET")
	r.HandleFunc("/metadata/groupingvariables", h.handleMetadataGroupingVariables).Methods("GET")
	r.HandleFunc("/metadata/groupingvalues", h.handleMetadataGroupingValues).Methods("GET")
	r.HandleFunc("/scenario/{scenario}/{attribute}", h.handleScenarioData).Methods("GET")
	r.HandleFunc("/aggregate", h.handleAggregateData).Methods("GET")
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
// It reads from metadata.csv in the data directory.
func (h *Handler) handleMetadataColors(w http.ResponseWriter, r *http.Request) {
	metadataPath := filepath.Join(h.cfg.DataDir, "metadata.csv")
	file, err := os.Open(metadataPath)
	if err != nil {
		log.Printf("Warning: metadata colors unavailable: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata headers: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	columnIdx := -1
	mapPreferredColorIdx := -1
	legacyColorIdx := -1
	for i, header := range headers {
		normalized := strings.TrimSpace(header)
		switch {
		case strings.EqualFold(normalized, "ColumnName"):
			columnIdx = i
		case strings.EqualFold(normalized, "MappreferredColour"):
			mapPreferredColorIdx = i
		case strings.EqualFold(normalized, "color"):
			legacyColorIdx = i
		}
	}

	colorIdx := mapPreferredColorIdx
	if colorIdx == -1 {
		colorIdx = legacyColorIdx
	}

	if columnIdx == -1 || colorIdx == -1 {
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	colors := make(map[string]string)
	for {
		record, err := reader.Read()
		if err != nil {
			break
		}
		if columnIdx >= len(record) || colorIdx >= len(record) {
			continue
		}
		column := strings.TrimSpace(record[columnIdx])
		color := normalizeMetadataColor(strings.TrimSpace(record[colorIdx]))
		if column == "" || color == "" {
			continue
		}
		colors[column] = color
		if normalized := normalizeMetadataColumn(column); normalized != "" {
			colors[normalized] = color
		}
	}

	respondJSON(w, http.StatusOK, colors)
}

// handleMetadataDetails returns a map of attribute column names to detailed names.
// It reads from metadata.csv in the data directory.
func (h *Handler) handleMetadataDetails(w http.ResponseWriter, r *http.Request) {
	metadataPath := filepath.Join(h.cfg.DataDir, "metadata.csv")
	file, err := os.Open(metadataPath)
	if err != nil {
		log.Printf("Warning: metadata details unavailable: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata headers: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	columnIdx := -1
	detailIdx := -1
	for i, header := range headers {
		normalized := strings.TrimSpace(header)
		switch normalized {
		case "ColumnName":
			columnIdx = i
		case "Detailed name":
			detailIdx = i
		}
	}

	if columnIdx == -1 || detailIdx == -1 {
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	details := make(map[string]string)
	for {
		record, err := reader.Read()
		if err != nil {
			break
		}
		if columnIdx >= len(record) || detailIdx >= len(record) {
			continue
		}
		column := strings.TrimSpace(record[columnIdx])
		detail := strings.TrimSpace(record[detailIdx])
		if column == "" || detail == "" {
			continue
		}
		details[column] = detail
		if normalized := normalizeMetadataColumn(column); normalized != "" {
			details[normalized] = detail
		}
	}

	respondJSON(w, http.StatusOK, details)
}

// handleMetadataVariableTypes returns a map of attribute column names to variable types.
// It reads from metadata.csv in the data directory.
func (h *Handler) handleMetadataVariableTypes(w http.ResponseWriter, r *http.Request) {
	metadataPath := filepath.Join(h.cfg.DataDir, "metadata.csv")
	file, err := os.Open(metadataPath)
	if err != nil {
		log.Printf("Warning: metadata variable types unavailable: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata headers: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	columnIdx := -1
	variableTypeIdx := -1
	for i, header := range headers {
		normalized := strings.TrimSpace(header)
		switch {
		case strings.EqualFold(normalized, "ColumnName"):
			columnIdx = i
		case strings.EqualFold(normalized, "VariableType_highest level of grouping"):
			variableTypeIdx = i
		case strings.EqualFold(normalized, "VariableType"):
			if variableTypeIdx == -1 {
				variableTypeIdx = i
			}
		}
	}

	if columnIdx == -1 || variableTypeIdx == -1 {
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	variableTypes := make(map[string]string)
	for {
		record, err := reader.Read()
		if err != nil {
			break
		}
		if columnIdx >= len(record) || variableTypeIdx >= len(record) {
			continue
		}
		column := strings.TrimSpace(record[columnIdx])
		variableType := strings.TrimSpace(record[variableTypeIdx])
		if column == "" || variableType == "" {
			continue
		}
		variableTypes[column] = variableType
		if normalized := normalizeMetadataColumn(column); normalized != "" {
			variableTypes[normalized] = variableType
		}
	}

	respondJSON(w, http.StatusOK, variableTypes)
}

// handleMetadataInputs returns a map of attribute column names to user input flags.
// It reads from metadata.csv in the data directory.
func (h *Handler) handleMetadataInputs(w http.ResponseWriter, r *http.Request) {
	metadataPath := filepath.Join(h.cfg.DataDir, "metadata.csv")
	file, err := os.Open(metadataPath)
	if err != nil {
		log.Printf("Warning: metadata inputs unavailable: %v", err)
		respondJSON(w, http.StatusOK, map[string]bool{})
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata headers: %v", err)
		respondJSON(w, http.StatusOK, map[string]bool{})
		return
	}

	columnIdx := -1
	inputIdx := -1
	for i, header := range headers {
		normalized := strings.TrimSpace(header)
		switch {
		case strings.EqualFold(normalized, "ColumnName"):
			columnIdx = i
		case strings.EqualFold(normalized, "CurrentInputsAllowed"):
			inputIdx = i
		case strings.EqualFold(normalized, "userInput"):
			// Backward compatibility with older metadata files.
			inputIdx = i
		}
	}

	if columnIdx == -1 || inputIdx == -1 {
		respondJSON(w, http.StatusOK, map[string]bool{})
		return
	}

	inputs := make(map[string]bool)
	for {
		record, err := reader.Read()
		if err != nil {
			break
		}
		if columnIdx >= len(record) || inputIdx >= len(record) {
			continue
		}
		column := strings.TrimSpace(record[columnIdx])
		flag := strings.TrimSpace(record[inputIdx])
		if column == "" || flag == "" {
			continue
		}
		allowed := flag == "1" || strings.EqualFold(flag, "true")
		inputs[column] = allowed
		if normalized := normalizeMetadataColumn(column); normalized != "" {
			inputs[normalized] = allowed
		}
	}

	respondJSON(w, http.StatusOK, inputs)
}

// handleMetadataTargetInputs returns a map of attribute column names to target input flags.
// It reads from metadata.csv in the data directory.
func (h *Handler) handleMetadataTargetInputs(w http.ResponseWriter, r *http.Request) {
	metadataPath := filepath.Join(h.cfg.DataDir, "metadata.csv")
	file, err := os.Open(metadataPath)
	if err != nil {
		log.Printf("Warning: metadata target inputs unavailable: %v", err)
		respondJSON(w, http.StatusOK, map[string]bool{})
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata headers: %v", err)
		respondJSON(w, http.StatusOK, map[string]bool{})
		return
	}

	columnIdx := -1
	inputIdx := -1
	for i, header := range headers {
		normalized := strings.TrimSpace(header)
		switch {
		case strings.EqualFold(normalized, "ColumnName"):
			columnIdx = i
		case strings.EqualFold(normalized, "TargetInputsAllowed"):
			inputIdx = i
		case strings.EqualFold(normalized, "targetInput"):
			// Backward compatibility with older metadata files.
			inputIdx = i
		}
	}

	if columnIdx == -1 || inputIdx == -1 {
		respondJSON(w, http.StatusOK, map[string]bool{})
		return
	}

	inputs := make(map[string]bool)
	for {
		record, err := reader.Read()
		if err != nil {
			break
		}
		if columnIdx >= len(record) || inputIdx >= len(record) {
			continue
		}
		column := strings.TrimSpace(record[columnIdx])
		flag := strings.TrimSpace(record[inputIdx])
		if column == "" || flag == "" {
			continue
		}
		allowed := flag == "1" || strings.EqualFold(flag, "true")
		inputs[column] = allowed
		if normalized := normalizeMetadataColumn(column); normalized != "" {
			inputs[normalized] = allowed
		}
	}

	respondJSON(w, http.StatusOK, inputs)
}

// handleMetadataCanMap returns a map of attribute column names to canMap flags.
// It reads from metadata.csv in the data directory.
func (h *Handler) handleMetadataCanMap(w http.ResponseWriter, r *http.Request) {
	metadataPath := filepath.Join(h.cfg.DataDir, "metadata.csv")
	file, err := os.Open(metadataPath)
	if err != nil {
		log.Printf("Warning: metadata canMap unavailable: %v", err)
		respondJSON(w, http.StatusOK, map[string]bool{})
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata headers: %v", err)
		respondJSON(w, http.StatusOK, map[string]bool{})
		return
	}

	columnIdx := -1
	canMapIdx := -1
	for i, header := range headers {
		normalized := strings.TrimSpace(header)
		switch {
		case strings.EqualFold(normalized, "ColumnName"):
			columnIdx = i
		case strings.EqualFold(normalized, "canMap"), strings.EqualFold(normalized, "MapthisYN"):
			canMapIdx = i
		}
	}

	if columnIdx == -1 || canMapIdx == -1 {
		respondJSON(w, http.StatusOK, map[string]bool{})
		return
	}

	canMap := make(map[string]bool)
	for {
		record, err := reader.Read()
		if err != nil {
			break
		}
		if columnIdx >= len(record) || canMapIdx >= len(record) {
			continue
		}
		column := strings.TrimSpace(record[columnIdx])
		flag := strings.TrimSpace(record[canMapIdx])
		if column == "" || flag == "" {
			continue
		}
		allowed := flag == "1" || strings.EqualFold(flag, "true")
		canMap[column] = allowed
		if normalized := normalizeMetadataColumn(column); normalized != "" {
			canMap[normalized] = allowed
		}
	}

	respondJSON(w, http.StatusOK, canMap)
}

// handleMetadataCanGraph returns a map of attribute column names to canGraph flags.
// It reads from metadata.csv in the data directory.
func (h *Handler) handleMetadataCanGraph(w http.ResponseWriter, r *http.Request) {
	metadataPath := filepath.Join(h.cfg.DataDir, "metadata.csv")
	file, err := os.Open(metadataPath)
	if err != nil {
		log.Printf("Warning: metadata canGraph unavailable: %v", err)
		respondJSON(w, http.StatusOK, map[string]bool{})
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata headers: %v", err)
		respondJSON(w, http.StatusOK, map[string]bool{})
		return
	}

	columnIdx := -1
	canGraphIdx := -1
	for i, header := range headers {
		normalized := strings.TrimSpace(header)
		switch {
		case strings.EqualFold(normalized, "ColumnName"):
			columnIdx = i
		case strings.EqualFold(normalized, "canGraph"), strings.EqualFold(normalized, "graphthisYN"):
			canGraphIdx = i
		}
	}

	if columnIdx == -1 || canGraphIdx == -1 {
		respondJSON(w, http.StatusOK, map[string]bool{})
		return
	}

	canGraph := make(map[string]bool)
	for {
		record, err := reader.Read()
		if err != nil {
			break
		}
		if columnIdx >= len(record) || canGraphIdx >= len(record) {
			continue
		}
		column := strings.TrimSpace(record[columnIdx])
		flag := strings.TrimSpace(record[canGraphIdx])
		if column == "" || flag == "" {
			continue
		}
		allowed := flag == "1" || strings.EqualFold(flag, "true")
		canGraph[column] = allowed
		if normalized := normalizeMetadataColumn(column); normalized != "" {
			canGraph[normalized] = allowed
		}
	}

	respondJSON(w, http.StatusOK, canGraph)
}

// handleMetadataAxisLabels returns a map of attribute column names to axis labels.
// It reads from metadata.csv in the data directory.
func (h *Handler) handleMetadataAxisLabels(w http.ResponseWriter, r *http.Request) {
	metadataPath := filepath.Join(h.cfg.DataDir, "metadata.csv")
	file, err := os.Open(metadataPath)
	if err != nil {
		log.Printf("Warning: metadata axis labels unavailable: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata headers: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	columnIdx := -1
	axisLabelIdx := -1
	for i, header := range headers {
		normalized := strings.TrimSpace(header)
		switch normalized {
		case "ColumnName":
			columnIdx = i
		case "axis label":
			axisLabelIdx = i
		}
	}

	if columnIdx == -1 || axisLabelIdx == -1 {
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	axisLabels := make(map[string]string)
	for {
		record, err := reader.Read()
		if err != nil {
			break
		}
		if columnIdx >= len(record) || axisLabelIdx >= len(record) {
			continue
		}
		column := strings.TrimSpace(record[columnIdx])
		axisLabel := strings.TrimSpace(record[axisLabelIdx])
		if column == "" || axisLabel == "" {
			continue
		}
		axisLabels[column] = axisLabel
		if normalized := normalizeMetadataColumn(column); normalized != "" {
			axisLabels[normalized] = axisLabel
		}
	}

	respondJSON(w, http.StatusOK, axisLabels)
}

// handleMetadataXAxisLabels returns a map of attribute column names to x-axis labels.
// It reads from metadata.csv in the data directory.
func (h *Handler) handleMetadataXAxisLabels(w http.ResponseWriter, r *http.Request) {
	metadataPath := filepath.Join(h.cfg.DataDir, "metadata.csv")
	file, err := os.Open(metadataPath)
	if err != nil {
		log.Printf("Warning: metadata x axis labels unavailable: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata headers: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	columnIdx := -1
	xAxisLabelIdx := -1
	detailedNameIdx := -1
	for i, header := range headers {
		normalized := strings.TrimSpace(header)
		switch {
		case strings.EqualFold(normalized, "ColumnName"):
			columnIdx = i
		case strings.EqualFold(normalized, "x axis"), strings.EqualFold(normalized, "x_axis"), strings.EqualFold(normalized, "x-axis"):
			xAxisLabelIdx = i
		case strings.EqualFold(normalized, "Detailed name"), strings.EqualFold(normalized, "Detailed_name"):
			detailedNameIdx = i
		}
	}

	if columnIdx == -1 || xAxisLabelIdx == -1 {
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	xAxisLabels := make(map[string]string)
	for {
		record, err := reader.Read()
		if err != nil {
			break
		}
		if columnIdx >= len(record) || xAxisLabelIdx >= len(record) {
			continue
		}
		column := strings.TrimSpace(record[columnIdx])
		xAxisLabel := strings.TrimSpace(record[xAxisLabelIdx])
		if xAxisLabel == "" && detailedNameIdx >= 0 && detailedNameIdx < len(record) {
			xAxisLabel = strings.TrimSpace(record[detailedNameIdx])
		}
		if column == "" || xAxisLabel == "" {
			continue
		}
		xAxisLabels[column] = xAxisLabel
		if normalized := normalizeMetadataColumn(column); normalized != "" {
			xAxisLabels[normalized] = xAxisLabel
		}
	}

	respondJSON(w, http.StatusOK, xAxisLabels)
}

// handleMetadataUnits returns a map of attribute column names to units.
// It reads from metadata.csv in the data directory.
func (h *Handler) handleMetadataUnits(w http.ResponseWriter, r *http.Request) {
	metadataPath := filepath.Join(h.cfg.DataDir, "metadata.csv")
	file, err := os.Open(metadataPath)
	if err != nil {
		log.Printf("Warning: metadata units unavailable: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata headers: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	columnIdx := -1
	unitsIdx := -1
	for i, header := range headers {
		normalized := strings.TrimSpace(header)
		switch {
		case strings.EqualFold(normalized, "ColumnName"):
			columnIdx = i
		case strings.EqualFold(normalized, "Units"):
			unitsIdx = i
		}
	}

	if columnIdx == -1 || unitsIdx == -1 {
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	units := make(map[string]string)
	for {
		record, err := reader.Read()
		if err != nil {
			break
		}
		if columnIdx >= len(record) || unitsIdx >= len(record) {
			continue
		}
		column := strings.TrimSpace(record[columnIdx])
		unit := strings.TrimSpace(record[unitsIdx])
		if column == "" || unit == "" {
			continue
		}
		units[column] = unit
		if normalized := normalizeMetadataColumn(column); normalized != "" {
			units[normalized] = unit
		}
	}

	respondJSON(w, http.StatusOK, units)
}

// handleMetadataChartTypes returns a map of attribute column names to chart types.
// It reads from metadata.csv in the data directory.
func (h *Handler) handleMetadataChartTypes(w http.ResponseWriter, r *http.Request) {
	metadataPath := filepath.Join(h.cfg.DataDir, "metadata.csv")
	file, err := os.Open(metadataPath)
	if err != nil {
		log.Printf("Warning: metadata chart types unavailable: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata headers: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	columnIdx := -1
	chartTypeIdx := -1
	for i, header := range headers {
		normalized := strings.TrimSpace(header)
		switch {
		case strings.EqualFold(normalized, "ColumnName"):
			columnIdx = i
		case strings.EqualFold(normalized, "chartType"), strings.EqualFold(normalized, "typeofgraph"):
			chartTypeIdx = i
		}
	}

	if columnIdx == -1 || chartTypeIdx == -1 {
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	chartTypes := make(map[string]string)
	for {
		record, err := reader.Read()
		if err != nil {
			break
		}
		if columnIdx >= len(record) || chartTypeIdx >= len(record) {
			continue
		}
		column := strings.TrimSpace(record[columnIdx])
		chartType := strings.TrimSpace(record[chartTypeIdx])
		if column == "" || chartType == "" {
			continue
		}
		chartTypes[column] = chartType
		if normalized := normalizeMetadataColumn(column); normalized != "" {
			chartTypes[normalized] = chartType
		}
	}

	respondJSON(w, http.StatusOK, chartTypes)
}

// handleMetadataGroupingVariables returns a map of attribute column names to Grouping variable values.
// It reads from metadata.csv in the data directory.
func (h *Handler) handleMetadataGroupingVariables(w http.ResponseWriter, r *http.Request) {
	metadataPath := filepath.Join(h.cfg.DataDir, "metadata.csv")
	file, err := os.Open(metadataPath)
	if err != nil {
		log.Printf("Warning: metadata grouping variables unavailable: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata headers: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	columnIdx := -1
	groupingVariableIdx := -1
	for i, header := range headers {
		normalized := strings.TrimSpace(header)
		switch {
		case strings.EqualFold(normalized, "ColumnName"):
			columnIdx = i
		case strings.EqualFold(normalized, "Grouping variable"):
			groupingVariableIdx = i
		}
	}

	if columnIdx == -1 || groupingVariableIdx == -1 {
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	groupingVariables := make(map[string]string)
	for {
		record, err := reader.Read()
		if err != nil {
			break
		}
		if columnIdx >= len(record) || groupingVariableIdx >= len(record) {
			continue
		}
		column := strings.TrimSpace(record[columnIdx])
		groupingVariable := strings.TrimSpace(record[groupingVariableIdx])
		if column == "" || groupingVariable == "" {
			continue
		}
		groupingVariables[column] = groupingVariable
		if normalized := normalizeMetadataColumn(column); normalized != "" {
			groupingVariables[normalized] = groupingVariable
		}
	}

	respondJSON(w, http.StatusOK, groupingVariables)
}

// handleMetadataGroupingValues returns a map of attribute column names to their GroupingValues.
// It reads from metadata.csv in the data directory.
func (h *Handler) handleMetadataGroupingValues(w http.ResponseWriter, r *http.Request) {
	metadataPath := filepath.Join(h.cfg.DataDir, "metadata.csv")
	file, err := os.Open(metadataPath)
	if err != nil {
		log.Printf("Warning: metadata grouping values unavailable: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}
	defer file.Close()

	reader := csv.NewReader(file)
	reader.TrimLeadingSpace = true

	headers, err := reader.Read()
	if err != nil {
		log.Printf("Warning: failed to read metadata headers: %v", err)
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	columnIdx := -1
	groupingValuesIdx := -1
	for i, header := range headers {
		normalized := strings.TrimSpace(header)
		switch {
		case strings.EqualFold(normalized, "ColumnName"):
			columnIdx = i
		case strings.EqualFold(normalized, "GroupingValues"):
			groupingValuesIdx = i
		}
	}

	if columnIdx == -1 || groupingValuesIdx == -1 {
		respondJSON(w, http.StatusOK, map[string]string{})
		return
	}

	groupingValues := make(map[string]string)
	for {
		record, err := reader.Read()
		if err != nil {
			break
		}
		if columnIdx >= len(record) || groupingValuesIdx >= len(record) {
			continue
		}
		column := strings.TrimSpace(record[columnIdx])
		groupingValue := strings.TrimSpace(record[groupingValuesIdx])
		if column == "" || groupingValue == "" {
			continue
		}
		groupingValues[column] = groupingValue
		if normalized := normalizeMetadataColumn(column); normalized != "" {
			groupingValues[normalized] = groupingValue
		}
	}

	respondJSON(w, http.StatusOK, groupingValues)
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

	agg, err := h.gpkgStore.GetScenarioAverages(scenario, attributes, bbox)
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, agg)
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
	if len(site.Geometry) > 0 {
		aoiStart := time.Now()
		if err := h.gpkgStore.ApplyAOIFractions(catchmentData, site.Geometry); err != nil {
			return err
		}
		log.Printf("[perf] populateSiteCatchmentDetails step=applyAOIFractions site_id=%s catchments=%d duration_ms=%d", site.ID, len(site.CatchmentIDs), time.Since(aoiStart).Milliseconds())
	}

	persisted := make([]sites.SiteCatchment, 0, len(catchmentData))
	for _, c := range catchmentData {
		persisted = append(persisted, sites.SiteCatchment{
			ID:          c.ID,
			AreaKm2:     c.AreaKm2,
			AOIFraction: c.AOIFraction,
			Reference:   c.Reference,
			Current:     c.Current,
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
		go h.populateSiteCatchmentDetailsDeferred(created.ID, catchmentIDs, geometry)
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

	limit := req.Limit
	if limit <= 0 {
		limit = 5000
	}
	if limit > 20000 {
		limit = 20000
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
			Truncated:    len(ids) >= limit,
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
		Truncated:    len(features) >= limit,
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
	if len(site.Geometry) > 0 {
		if err := h.gpkgStore.ApplyAOIFractions(catchmentData, site.Geometry); err != nil {
			log.Printf("Warning: failed to compute AOI fractions for site %s: %v", id, err)
		}
	}

	if len(catchmentData) == 0 {
		respondError(w, http.StatusNotFound, "no data found for catchments")
		return
	}

	// Compute area-weighted aggregations
	indicators := computeAreaWeightedIndicators(catchmentData, h.gpkgStore)
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

func computeAreaWeightedIndicators(catchments []geodata.CatchmentIndicators, gpkgStore *geodata.GpkgStore) *sites.SiteIndicators {
	indicators := &sites.SiteIndicators{
		Reference:      make(map[string]float64),
		ReferenceLower: make(map[string]float64),
		ReferenceUpper: make(map[string]float64),
		Current:        make(map[string]float64),
		CurrentLower:   make(map[string]float64),
		CurrentUpper:   make(map[string]float64),
		Ideal:          make(map[string]float64),
		IdealLower:     make(map[string]float64),
		IdealUpper:     make(map[string]float64),
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

	// Step 3: Compute whisker (upper/lower) bounds from GeoPackage tables
	var whiskerBounds geodata.WhiskerBounds
	if gpkgStore != nil {
		whiskerBounds = gpkgStore.ComputeWhiskerBounds(catchments)
	}

	// Step 4: Collect all unique metric keys
	allKeys := make(map[string]bool)
	for _, c := range catchments {
		for k := range c.Reference {
			allKeys[k] = true
		}
		for k := range c.Current {
			allKeys[k] = true
		}
	}

	// Step 5: Compute AOI-weighted metrics
	for key := range allKeys {
		refSum := 0.0
		curSum := 0.0
		hadCur := false

		for i, c := range catchments {
			weight := validAreas[i] / totalValidArea // AOI proportion

			if val, ok := c.Reference[key]; ok {
				refSum += val * weight
			}
			if val, ok := c.Current[key]; ok {
				curSum += val * weight
				hadCur = true
			}
		}

		// Store the weighted values; only write Current when at least one catchment
		// had current data for this key — otherwise curSum stays 0 which is misleading
		// (e.g. a column that only exists in reference would appear as current=0).
		indicators.Reference[key] = refSum
		indicators.Ideal[key] = refSum // Initialize Ideal same as Reference
		if hadCur {
			indicators.Current[key] = curSum
		}

		// Store whisker bounds if available
		if whiskerBounds.ReferenceLower != nil {
			if val, ok := whiskerBounds.ReferenceLower[key]; ok {
				indicators.ReferenceLower[key] = val
				indicators.IdealLower[key] = val // Initialize IdealLower same as ReferenceLower
			}
		}
		if whiskerBounds.ReferenceUpper != nil {
			if val, ok := whiskerBounds.ReferenceUpper[key]; ok {
				indicators.ReferenceUpper[key] = val
				indicators.IdealUpper[key] = val // Initialize IdealUpper same as ReferenceUpper
			}
		}
		if whiskerBounds.CurrentLower != nil {
			if val, ok := whiskerBounds.CurrentLower[key]; ok {
				indicators.CurrentLower[key] = val
			}
		}
		if whiskerBounds.CurrentUpper != nil {
			if val, ok := whiskerBounds.CurrentUpper[key]; ok {
				indicators.CurrentUpper[key] = val
			}
		}
	}

	return indicators
}

// UpdateIndicatorsRequest represents a request to update indicator values
type UpdateIndicatorsRequest struct {
	Ideal          map[string]float64 `json:"ideal"`
	IdealLower     map[string]float64 `json:"idealLower"`
	IdealUpper     map[string]float64 `json:"idealUpper"`
	Reference      map[string]float64 `json:"reference"`
	ReferenceLower map[string]float64 `json:"referenceLower"`
	ReferenceUpper map[string]float64 `json:"referenceUpper"`
	Current        map[string]float64 `json:"current"`
	CurrentLower   map[string]float64 `json:"currentLower"`
	CurrentUpper   map[string]float64 `json:"currentUpper"`
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

	// Determine which primary target inputs changed.
	targetInputCols := []string{colLowTCProp, colHerbsTot}
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
	if (len(changedTargets) > 0 || len(changedSpeciesCounts) > 0) && site.Indicators.Ideal != nil {
		recalculateIdeal(site.Indicators.Ideal, changedTargets, oldIdeal, changedSpeciesCounts)
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

	if len(site.Catchments) > 0 && (len(site.CatchmentIDs) == 0 || len(site.Catchments) == len(site.CatchmentIDs)) {
		respondJSON(w, http.StatusOK, siteCatchmentsToIndicators(site.Catchments))
		return
	}

	// Get indicator data for all catchments
	catchmentData, err := h.gpkgStore.GetCatchmentIndicatorsByIDs(site.CatchmentIDs)
	if err != nil {
		respondError(w, http.StatusInternalServerError, "failed to get catchment data: "+err.Error())
		return
	}
	if len(site.Geometry) > 0 {
		if err := h.gpkgStore.ApplyAOIFractions(catchmentData, site.Geometry); err != nil {
			log.Printf("Warning: failed to compute AOI fractions for site %s: %v", id, err)
		}
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

	catchmentData := []geodata.CatchmentIndicators(nil)
	if len(site.Catchments) > 0 && (len(site.CatchmentIDs) == 0 || len(site.Catchments) == len(site.CatchmentIDs)) {
		catchmentData = siteCatchmentsToIndicators(site.Catchments)
	} else {
		catchmentData, err = h.gpkgStore.GetCatchmentIndicatorsByIDs(site.CatchmentIDs)
		if err != nil {
			respondError(w, http.StatusInternalServerError, "failed to get catchment data: "+err.Error())
			return
		}
		if len(site.Geometry) > 0 {
			if err := h.gpkgStore.ApplyAOIFractions(catchmentData, site.Geometry); err != nil {
				log.Printf("Warning: failed to compute AOI fractions for site %s: %v", id, err)
			}
		}
	}

	bounds := h.gpkgStore.ComputeWhiskerBounds(catchmentData)
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
