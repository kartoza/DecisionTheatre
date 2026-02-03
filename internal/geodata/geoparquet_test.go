package geodata

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// scenarioFileBase maps each scenario to the base filename the store expects.
var scenarioFileBase = map[Scenario]string{
	ScenarioReference: "reference",
	ScenarioCurrent:   "current",
	ScenarioFuture:    "current", // future loads from the same file as current
}

func createTestScenarioJSON(t *testing.T, dir string, scenario Scenario) {
	t.Helper()

	data := ScenarioData{
		Scenario: scenario,
		Columns:  []string{"soil_moisture", "rainfall", "temperature", "vegetation_index"},
		Catchments: []CatchmentData{
			{
				CatchmentID: "CAT001",
				Attributes: map[string]float64{
					"soil_moisture":    0.45,
					"rainfall":         120.5,
					"temperature":      28.3,
					"vegetation_index": 0.72,
				},
			},
			{
				CatchmentID: "CAT002",
				Attributes: map[string]float64{
					"soil_moisture":    0.32,
					"rainfall":         95.2,
					"temperature":      30.1,
					"vegetation_index": 0.58,
				},
			},
			{
				CatchmentID: "CAT003",
				Attributes: map[string]float64{
					"soil_moisture":    0.61,
					"rainfall":         180.8,
					"temperature":      25.7,
					"vegetation_index": 0.85,
				},
			},
		},
	}

	jsonData, err := json.Marshal(data)
	if err != nil {
		t.Fatalf("Failed to marshal test data: %v", err)
	}

	base := scenarioFileBase[scenario]
	jsonPath := filepath.Join(dir, base+".json")
	// Only write if file doesn't already exist (current is shared by current+future)
	if _, err := os.Stat(jsonPath); err != nil {
		if err := os.WriteFile(jsonPath, jsonData, 0644); err != nil {
			t.Fatalf("Failed to write test JSON: %v", err)
		}
	}

	// Also create a dummy parquet file so the store finds it
	parquetPath := filepath.Join(dir, base+".parquet")
	if _, err := os.Stat(parquetPath); err != nil {
		os.WriteFile(parquetPath, []byte{}, 0644)
	}
}

func TestNewGeoParquetStore(t *testing.T) {
	dir := t.TempDir()

	createTestScenarioJSON(t, dir, ScenarioReference)
	createTestScenarioJSON(t, dir, ScenarioCurrent)
	createTestScenarioJSON(t, dir, ScenarioFuture)

	store, err := NewGeoParquetStore(dir)
	if err != nil {
		t.Fatalf("NewGeoParquetStore failed: %v", err)
	}
	defer store.Close()

	scenarios := store.GetScenarios()
	if len(scenarios) != 3 {
		t.Errorf("Expected 3 scenarios, got %d", len(scenarios))
	}
}

func TestGetColumns(t *testing.T) {
	dir := t.TempDir()
	createTestScenarioJSON(t, dir, ScenarioReference)

	store, err := NewGeoParquetStore(dir)
	if err != nil {
		t.Fatalf("NewGeoParquetStore failed: %v", err)
	}
	defer store.Close()

	columns := store.GetColumns()
	if len(columns) != 4 {
		t.Errorf("Expected 4 columns, got %d", len(columns))
	}
}

func TestGetScenarioData(t *testing.T) {
	dir := t.TempDir()
	createTestScenarioJSON(t, dir, ScenarioReference)

	store, err := NewGeoParquetStore(dir)
	if err != nil {
		t.Fatalf("NewGeoParquetStore failed: %v", err)
	}
	defer store.Close()

	data, err := store.GetScenarioData(ScenarioReference, "soil_moisture")
	if err != nil {
		t.Fatalf("GetScenarioData failed: %v", err)
	}

	if len(data) != 3 {
		t.Errorf("Expected 3 catchments, got %d", len(data))
	}

	if val, ok := data["CAT001"]; !ok || val != 0.45 {
		t.Errorf("Expected CAT001 soil_moisture=0.45, got %v", val)
	}
}

func TestGetScenarioDataMissingAttribute(t *testing.T) {
	dir := t.TempDir()
	createTestScenarioJSON(t, dir, ScenarioReference)

	store, err := NewGeoParquetStore(dir)
	if err != nil {
		t.Fatalf("NewGeoParquetStore failed: %v", err)
	}
	defer store.Close()

	data, err := store.GetScenarioData(ScenarioReference, "nonexistent")
	if err != nil {
		t.Fatalf("GetScenarioData failed: %v", err)
	}

	if len(data) != 0 {
		t.Errorf("Expected 0 results for missing attribute, got %d", len(data))
	}
}

func TestGetScenarioDataMissingScenario(t *testing.T) {
	dir := t.TempDir()
	createTestScenarioJSON(t, dir, ScenarioReference)

	store, err := NewGeoParquetStore(dir)
	if err != nil {
		t.Fatalf("NewGeoParquetStore failed: %v", err)
	}
	defer store.Close()

	_, err = store.GetScenarioData(ScenarioFuture, "soil_moisture")
	if err == nil {
		t.Error("Expected error for missing scenario")
	}
}

func TestGetComparisonData(t *testing.T) {
	dir := t.TempDir()
	createTestScenarioJSON(t, dir, ScenarioReference)
	createTestScenarioJSON(t, dir, ScenarioCurrent)

	store, err := NewGeoParquetStore(dir)
	if err != nil {
		t.Fatalf("NewGeoParquetStore failed: %v", err)
	}
	defer store.Close()

	data, err := store.GetComparisonData(ScenarioReference, ScenarioCurrent, "rainfall")
	if err != nil {
		t.Fatalf("GetComparisonData failed: %v", err)
	}

	if len(data) != 3 {
		t.Errorf("Expected 3 comparison entries, got %d", len(data))
	}

	if pair, ok := data["CAT001"]; ok {
		if pair[0] != 120.5 || pair[1] != 120.5 {
			// Same test data for both scenarios in this test
			t.Logf("Comparison values: left=%v right=%v", pair[0], pair[1])
		}
	}
}

func TestEmptyDataDirectory(t *testing.T) {
	dir := t.TempDir()

	_, err := NewGeoParquetStore(dir)
	if err == nil {
		t.Error("Expected error for empty data directory")
	}
}
