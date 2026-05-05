package geodata

import (
	"encoding/csv"
	"fmt"
	"io"
	"log"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// WhiskerBounds holds area-weighted upper/lower bounds for all attribute columns.
type WhiskerBounds struct {
	ReferenceUpper map[string]float64 `json:"referenceUpper"`
	ReferenceLower map[string]float64 `json:"referenceLower"`
	CurrentUpper   map[string]float64 `json:"currentUpper"`
	CurrentLower   map[string]float64 `json:"currentLower"`
}

// WhiskerStore holds pre-loaded whisker data from the four bound CSV files.
// Keys are normalised catchment IDs (same as CatchmentIndicators.ID).
type WhiskerStore struct {
	currentUpper   map[string]map[string]float64
	currentLower   map[string]map[string]float64
	referenceUpper map[string]map[string]float64
	referenceLower map[string]map[string]float64
}

// NewWhiskerStore loads all four whisker CSV files from dataDir.
// Missing or unreadable files are logged as warnings and treated as empty.
func NewWhiskerStore(dataDir string) *WhiskerStore {
	load := func(filename string) map[string]map[string]float64 {
		data, err := loadWhiskerCSV(filepath.Join(dataDir, filename))
		if err != nil {
			log.Printf("Warning: could not load %s: %v", filename, err)
			return map[string]map[string]float64{}
		}
		log.Printf("Loaded %d catchments from %s", len(data), filename)
		return data
	}

	return &WhiskerStore{
		currentUpper:   load("current_upper.csv"),
		currentLower:   load("current_lower.csv"),
		referenceUpper: load("reference_upper.csv"),
		referenceLower: load("reference_lower.csv"),
	}
}

// ComputeBounds returns area-weighted whisker bounds across the given catchments.
// Each catchment's contribution is weighted by AreaKm2 * AOIFraction (clamped to [0,1]).
// Columns missing in some catchments are normalised by the valid area that did have data.
func (w *WhiskerStore) ComputeBounds(catchments []CatchmentIndicators) WhiskerBounds {
	computeWeighted := func(source map[string]map[string]float64) map[string]float64 {
		totalArea := 0.0
		for _, c := range catchments {
			frac := c.AOIFraction
			if frac <= 0 || frac > 1 {
				frac = 1
			}
			totalArea += c.AreaKm2 * frac
		}
		if totalArea <= 0 {
			return nil
		}

		weightedSums := make(map[string]float64)
		validAreas := make(map[string]float64)

		for _, c := range catchments {
			colData, ok := source[c.ID]
			if !ok {
				continue
			}
			frac := c.AOIFraction
			if frac <= 0 || frac > 1 {
				frac = 1
			}
			weight := (c.AreaKm2 * frac) / totalArea

			for col, val := range colData {
				weightedSums[col] += val * weight
				validAreas[col] += weight
			}
		}

		// Re-normalise per column so catchments missing a column do not dilute the average.
		result := make(map[string]float64, len(weightedSums))
		for col, ws := range weightedSums {
			if va := validAreas[col]; va > 0 {
				result[col] = ws / va
			}
		}
		return result
	}

	return WhiskerBounds{
		ReferenceUpper: computeWeighted(w.referenceUpper),
		ReferenceLower: computeWeighted(w.referenceLower),
		CurrentUpper:   computeWeighted(w.currentUpper),
		CurrentLower:   computeWeighted(w.currentLower),
	}
}

// loadWhiskerCSV parses a whisker CSV file and returns catchID -> column -> value.
// "NA" values are skipped. The catchID column is found by the lowercase name "catchid".
func loadWhiskerCSV(path string) (map[string]map[string]float64, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()

	r := csv.NewReader(f)
	r.TrimLeadingSpace = true
	r.LazyQuotes = true

	headers, err := r.Read()
	if err != nil {
		return nil, fmt.Errorf("read header: %w", err)
	}

	for i, h := range headers {
		headers[i] = strings.Trim(h, `"`)
	}

	catchIDIdx := -1
	for i, h := range headers {
		if strings.ToLower(h) == "catchid" {
			catchIDIdx = i
			break
		}
	}
	if catchIDIdx < 0 {
		return nil, fmt.Errorf("no catchID column found in %s", path)
	}

	data := make(map[string]map[string]float64)

	for {
		record, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			continue
		}
		if len(record) < len(headers) {
			continue
		}

		catchID := normalizeCatchmentID(strings.TrimSpace(record[catchIDIdx]))
		if catchID == "" || strings.ToUpper(catchID) == "NA" {
			continue
		}

		row := make(map[string]float64, len(headers)-1)
		for j, h := range headers {
			if j == catchIDIdx {
				continue
			}
			val := strings.TrimSpace(record[j])
			if val == "" || strings.ToUpper(val) == "NA" {
				continue
			}
			f64, parseErr := strconv.ParseFloat(val, 64)
			if parseErr != nil || math.IsNaN(f64) || math.IsInf(f64, 0) {
				continue
			}
			row[h] = f64
		}
		data[catchID] = row
	}

	return data, nil
}
