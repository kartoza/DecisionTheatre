package geodata

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
)

// Scenario represents one of the three geoparquet datasets
type Scenario string

const (
	ScenarioReference Scenario = "reference"
	ScenarioCurrent   Scenario = "current"
	ScenarioFuture    Scenario = "future"
)

// CatchmentData represents the data for a single catchment
type CatchmentData struct {
	CatchmentID string             `json:"catchment_id"`
	Attributes  map[string]float64 `json:"attributes"`
}

// ScenarioData holds all catchment data for a single scenario
type ScenarioData struct {
	Scenario   Scenario        `json:"scenario"`
	Columns    []string        `json:"columns"`
	Catchments []CatchmentData `json:"catchments"`
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
		ScenarioReference: {"reference.parquet"},
		ScenarioCurrent:   {"current.parquet"},
		// Future starts off based on current data
		ScenarioFuture: {"current.parquet"},
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

// loadFromParquet loads scenario data from a parquet file.
// Falls back to reading a companion CSV file with the same base name.
func (store *GeoParquetStore) loadFromParquet(scenario Scenario, path string) error {
	// Try CSV fallback (same base name with .csv extension)
	csvPath := strings.TrimSuffix(path, filepath.Ext(path)) + ".csv"
	if _, err := os.Stat(csvPath); err == nil {
		log.Printf("Loading %s scenario from CSV fallback: %s", scenario, csvPath)
		return store.loadFromCSV(scenario, csvPath)
	}

	return fmt.Errorf("parquet file %s exists but no parquet reader or CSV fallback available", path)
}

// loadFromCSV loads scenario data from a CSV file.
// First column is the catchment ID, remaining columns are numeric attributes.
func (store *GeoParquetStore) loadFromCSV(scenario Scenario, path string) error {
	f, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("failed to open CSV: %w", err)
	}
	defer f.Close()

	reader := csv.NewReader(f)

	// Read header
	header, err := reader.Read()
	if err != nil {
		return fmt.Errorf("failed to read CSV header: %w", err)
	}

	if len(header) < 2 {
		return fmt.Errorf("CSV must have at least 2 columns (id + attributes)")
	}

	// First column is the catchment ID, rest are attribute columns
	columns := make([]string, len(header)-1)
	for i := 1; i < len(header); i++ {
		columns[i-1] = strings.Trim(header[i], "\" ")
	}

	var catchments []CatchmentData
	for {
		record, err := reader.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return fmt.Errorf("CSV read error: %w", err)
		}

		if len(record) < 2 {
			continue
		}

		catchmentID := strings.Trim(record[0], "\" ")
		attrs := make(map[string]float64, len(columns))
		for i, col := range columns {
			if i+1 < len(record) {
				val, err := strconv.ParseFloat(strings.TrimSpace(record[i+1]), 64)
				if err == nil {
					attrs[col] = val
				}
			}
		}

		catchments = append(catchments, CatchmentData{
			CatchmentID: catchmentID,
			Attributes:  attrs,
		})
	}

	scenarioData := &ScenarioData{
		Scenario:   scenario,
		Columns:    columns,
		Catchments: catchments,
	}

	store.mu.Lock()
	defer store.mu.Unlock()

	store.scenarios[scenario] = scenarioData

	if len(columns) > 0 {
		store.columns = columns
	}

	log.Printf("Loaded %s scenario: %d catchments, %d columns from CSV", scenario, len(catchments), len(columns))
	return nil
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

// AttributeStats holds summary statistics for an attribute in a scenario
type AttributeStats struct {
	Scenario  string  `json:"scenario"`
	Attribute string  `json:"attribute"`
	Count     int     `json:"count"`
	Min       float64 `json:"min"`
	Max       float64 `json:"max"`
	Mean      float64 `json:"mean"`
	StdDev    float64 `json:"std_dev"`
}

// GetAttributeStats returns summary statistics for an attribute across a scenario
func (store *GeoParquetStore) GetAttributeStats(scenario Scenario, attribute string) (*AttributeStats, error) {
	store.mu.RLock()
	defer store.mu.RUnlock()

	data, ok := store.scenarios[scenario]
	if !ok {
		return nil, fmt.Errorf("scenario %s not loaded", scenario)
	}

	var vals []float64
	for _, c := range data.Catchments {
		if v, ok := c.Attributes[attribute]; ok {
			vals = append(vals, v)
		}
	}

	if len(vals) == 0 {
		return nil, fmt.Errorf("no data for attribute %s in scenario %s", attribute, scenario)
	}

	minV, maxV := vals[0], vals[0]
	sum := 0.0
	for _, v := range vals {
		sum += v
		if v < minV {
			minV = v
		}
		if v > maxV {
			maxV = v
		}
	}
	mean := sum / float64(len(vals))

	var sumSq float64
	for _, v := range vals {
		d := v - mean
		sumSq += d * d
	}
	stddev := math.Sqrt(sumSq / float64(len(vals)))

	return &AttributeStats{
		Scenario:  string(scenario),
		Attribute: attribute,
		Count:     len(vals),
		Min:       minV,
		Max:       maxV,
		Mean:      mean,
		StdDev:    stddev,
	}, nil
}

// Close releases resources
func (store *GeoParquetStore) Close() {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.scenarios = nil
}
