package api

import (
	"encoding/json"
	"log"
	"net/http"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/llm"
	"github.com/kartoza/decision-theatre/internal/nn"
	"github.com/kartoza/decision-theatre/internal/tiles"
)

// Handler provides HTTP API endpoints
type Handler struct {
	tileStore *tiles.MBTilesStore
	geoStore  *geodata.GeoParquetStore
	llmEngine *llm.EmbeddedLLM
	nnModel   *nn.CatchmentModel
	cfg       config.Config
}

// NewHandler creates a new API handler
func NewHandler(
	tileStore *tiles.MBTilesStore,
	geoStore *geodata.GeoParquetStore,
	llmEngine *llm.EmbeddedLLM,
	nnModel *nn.CatchmentModel,
	cfg config.Config,
) *Handler {
	return &Handler{
		tileStore: tileStore,
		geoStore:  geoStore,
		llmEngine: llmEngine,
		nnModel:   nnModel,
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

	// LLM endpoints
	r.HandleFunc("/llm/status", h.handleLLMStatus).Methods("GET")
	r.HandleFunc("/llm/query", h.handleLLMQuery).Methods("POST")

	// Neural network endpoints
	r.HandleFunc("/nn/predict", h.handleNNPredict).Methods("POST")
	r.HandleFunc("/nn/status", h.handleNNStatus).Methods("GET")
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
		"version":       h.cfg.Version,
		"tiles_loaded":  h.tileStore != nil,
		"geo_loaded":    h.geoStore != nil,
		"llm_available": h.llmEngine != nil && h.llmEngine.IsLoaded(),
		"nn_available":  h.nnModel != nil,
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
	if h.geoStore == nil {
		respondJSON(w, http.StatusOK, []string{})
		return
	}
	respondJSON(w, http.StatusOK, h.geoStore.GetColumns())
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

// handleLLMStatus returns LLM status
func (h *Handler) handleLLMStatus(w http.ResponseWriter, r *http.Request) {
	if h.llmEngine == nil {
		respondJSON(w, http.StatusOK, map[string]interface{}{
			"available": false,
			"message":   "No LLM model loaded. Start with --model flag to enable.",
		})
		return
	}

	respondJSON(w, http.StatusOK, h.llmEngine.GetModelInfo())
}

// handleLLMQuery processes an LLM query
func (h *Handler) handleLLMQuery(w http.ResponseWriter, r *http.Request) {
	if h.llmEngine == nil {
		respondError(w, http.StatusServiceUnavailable, "LLM not available")
		return
	}

	var req struct {
		Query   string `json:"query"`
		Context string `json:"context,omitempty"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	response, err := h.llmEngine.Generate(req.Query, req.Context)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, map[string]string{"response": response})
}

// handleNNPredict processes a neural network prediction
func (h *Handler) handleNNPredict(w http.ResponseWriter, r *http.Request) {
	if h.nnModel == nil {
		respondError(w, http.StatusServiceUnavailable, "Neural network not available")
		return
	}

	var req struct {
		Inputs []float64 `json:"inputs"`
	}

	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	predictions, err := h.nnModel.Predict(req.Inputs)
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{"predictions": predictions})
}

// handleNNStatus returns neural network status
func (h *Handler) handleNNStatus(w http.ResponseWriter, r *http.Request) {
	if h.nnModel == nil {
		respondJSON(w, http.StatusOK, map[string]interface{}{
			"available": false,
		})
		return
	}

	respondJSON(w, http.StatusOK, map[string]interface{}{
		"available": true,
		"trained":   h.nnModel.IsTrained(),
		"config":    h.nnModel.GetConfig(),
	})
}
