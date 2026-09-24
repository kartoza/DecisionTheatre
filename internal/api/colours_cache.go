package api

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
)

// ScenarioColours holds the reference/current/target colours drawn on every
// dial, chart, and map panel label. Defaults mirror
// frontend/src/lib/dialScale.ts's SCENARIO_COLORS -- keep the two in sync.
type ScenarioColours struct {
	Reference string `json:"reference"`
	Current   string `json:"current"`
	Target    string `json:"target"`
}

var defaultScenarioColours = ScenarioColours{
	Reference: "#4caf50",
	Current:   "#2bb0ed",
	Target:    "#d946ef",
}

// loadScenarioColours reads colours.json, if present, and overlays any
// non-empty field onto the defaults. A missing file, malformed JSON, or a
// blank field is non-fatal: that field (or all of them) keeps its default.
func loadScenarioColours(dataDir string) ScenarioColours {
	colours := defaultScenarioColours

	path := filepath.Join(dataDir, "colours.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Printf("Warning: could not read colours.json at %s; using default scenario colours (%v)", path, err)
		}
		return colours
	}

	var overrides ScenarioColours
	if err := json.Unmarshal(data, &overrides); err != nil {
		log.Printf("Warning: colours.json at %s is not valid JSON; using default scenario colours (%v)", path, err)
		return colours
	}

	if overrides.Reference != "" {
		colours.Reference = overrides.Reference
	}
	if overrides.Current != "" {
		colours.Current = overrides.Current
	}
	if overrides.Target != "" {
		colours.Target = overrides.Target
	}

	log.Printf("Loaded colours.json overrides from %s", path)
	return colours
}
