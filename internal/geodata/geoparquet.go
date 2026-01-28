package geodata

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// Scenario represents one of the three geoparquet datasets
type Scenario string

const (
	ScenarioPast   Scenario = "past"
	ScenarioPresent Scenario = "present"
	ScenarioFuture Scenario = "future"
)

// CatchmentData represents the data for a single catchment
type CatchmentData struct {
	CatchmentID string             `json:"catchment_id"`
	Attributes  map[string]float64 `json:"attributes"`
}

// ScenarioData holds all catchment data for a single scenario
type ScenarioData struct {
	Scenario   Scenario         `json:"scenario"`
	Columns    []string         `json:"columns"`
	Catchments []CatchmentData  `json:"catchments"`
}

// GeoParquetStore manages the three scenario datasets
type GeoParquetStore struct {
	dataDir   string
	scenarios map[Scenario]*ScenarioData
	columns   []string // shared column list
	mu        sync.RWMutex
}

// NewGeoParquetStore creates and loads the geoparquet store
func NewGeoParquetStore(dataDir string) (*GeoParquetStore, error) {
	store := &GeoParquetStore{
		dataDir:   dataDir,
		scenarios: make(map[Scenario]*ScenarioData),
	}

	// Try to load each scenario file
	scenarioFiles := map[Scenario][]string{
		ScenarioPast:    {"past.parquet", "past.geoparquet"},
		ScenarioPresent: {"present.parquet", "present.geoparquet"},
		ScenarioFuture:  {"future.parquet", "future.geoparquet", "ideal_future.parquet", "ideal_future.geoparquet"},
	}

	loaded := 0
	for scenario, filenames := range scenarioFiles {
		for _, filename := range filenames {
			path := filepath.Join(dataDir, filename)
			if _, err := os.Stat(path); err == nil {
				if err := store.loadScenario(scenario, path); err != nil {
					log.Printf("Warning: Failed to load %s scenario from %s: %v", scenario, path, err)
				} else {
					loaded++
					log.Printf("Loaded %s scenario from %s", scenario, path)
					break
				}
			}
		}
	}

	if loaded == 0 {
		return store, fmt.Errorf("no geoparquet files found in %s", dataDir)
	}

	return store, nil
}

// loadScenario loads a single geoparquet file into memory
func (store *GeoParquetStore) loadScenario(scenario Scenario, path string) error {
	// For now, we'll implement a placeholder that expects pre-processed JSON
	// The actual parquet reading will use xitongsys/parquet-go
	jsonPath := strings.TrimSuffix(path, filepath.Ext(path)) + ".json"
	if _, err := os.Stat(jsonPath); err == nil {
		return store.loadFromJSON(scenario, jsonPath)
	}

	// Try loading actual parquet file
	return store.loadFromParquet(scenario, path)
}

// loadFromJSON loads scenario data from a pre-processed JSON file
func (store *GeoParquetStore) loadFromJSON(scenario Scenario, path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		return fmt.Errorf("failed to read JSON file: %w", err)
	}

	var scenarioData ScenarioData
	if err := json.Unmarshal(data, &scenarioData); err != nil {
		return fmt.Errorf("failed to parse JSON: %w", err)
	}

	scenarioData.Scenario = scenario

	store.mu.Lock()
	defer store.mu.Unlock()

	store.scenarios[scenario] = &scenarioData

	// Update shared column list
	if len(scenarioData.Columns) > 0 {
		store.columns = scenarioData.Columns
	}

	return nil
}

// loadFromParquet loads scenario data from a parquet file using parquet-go
func (store *GeoParquetStore) loadFromParquet(scenario Scenario, path string) error {
	// Parquet reading implementation
	// This uses xitongsys/parquet-go to read the geoparquet files
	log.Printf("Parquet loading for %s: %s (will be available when data files are provided)", scenario, path)
	return fmt.Errorf("parquet file %s exists but parquet reader not yet configured - provide pre-processed JSON or actual parquet files", path)
}

// GetScenarioData returns data for a specific scenario and attribute
func (store *GeoParquetStore) GetScenarioData(scenario Scenario, attribute string) (map[string]float64, error) {
	store.mu.RLock()
	defer store.mu.RUnlock()

	data, ok := store.scenarios[scenario]
	if !ok {
		return nil, fmt.Errorf("scenario %s not loaded", scenario)
	}

	result := make(map[string]float64, len(data.Catchments))
	for _, catchment := range data.Catchments {
		if val, ok := catchment.Attributes[attribute]; ok {
			result[catchment.CatchmentID] = val
		}
	}

	return result, nil
}

// GetColumns returns the list of available attribute columns
func (store *GeoParquetStore) GetColumns() []string {
	store.mu.RLock()
	defer store.mu.RUnlock()
	return store.columns
}

// GetScenarios returns the list of loaded scenarios
func (store *GeoParquetStore) GetScenarios() []Scenario {
	store.mu.RLock()
	defer store.mu.RUnlock()

	scenarios := make([]Scenario, 0, len(store.scenarios))
	for s := range store.scenarios {
		scenarios = append(scenarios, s)
	}
	return scenarios
}

// GetComparisonData returns data for two scenarios for a given attribute
// This is the primary API for the map swiper comparison view
func (store *GeoParquetStore) GetComparisonData(left, right Scenario, attribute string) (map[string][2]float64, error) {
	store.mu.RLock()
	defer store.mu.RUnlock()

	leftData, ok := store.scenarios[left]
	if !ok {
		return nil, fmt.Errorf("left scenario %s not loaded", left)
	}

	rightData, ok := store.scenarios[right]
	if !ok {
		return nil, fmt.Errorf("right scenario %s not loaded", right)
	}

	result := make(map[string][2]float64, len(leftData.Catchments))

	// Index right data for fast lookup
	rightIndex := make(map[string]float64, len(rightData.Catchments))
	for _, c := range rightData.Catchments {
		if val, ok := c.Attributes[attribute]; ok {
			rightIndex[c.CatchmentID] = val
		}
	}

	for _, c := range leftData.Catchments {
		leftVal, hasLeft := c.Attributes[attribute]
		rightVal, hasRight := rightIndex[c.CatchmentID]
		if hasLeft && hasRight {
			result[c.CatchmentID] = [2]float64{leftVal, rightVal}
		}
	}

	return result, nil
}

// Close releases resources
func (store *GeoParquetStore) Close() {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.scenarios = nil
}
