package api

import (
	"encoding/json"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/kartoza/decision-theatre/internal/geodata"
)

// CatchmentValuesResponse is the wire format for `valuesOnly=1` choropleth
// requests: parallel arrays rather than one GeoJSON Feature per catchment.
//
// The shape it replaced was a FeatureCollection of 147,837 features, each
// carrying `"geometry": null` and a properties object repeating the attribute
// name, to deliver one int64 and one float64 per catchment - 16.1 MB for a
// full-domain request that no caller ever rendered. `type` is deliberately not
// "FeatureCollection": a response with no geometry is not one, and the
// discriminant is what lets the client tell the two apart.
//
// Exactly one of Values and Series is present. Values answers the common
// single-scenario request; Series answers a request that named several, and
// its arrays are all aligned to the same IDs, which is the point - the two
// scenarios of a comparison share one copy of the ID column instead of sending
// it twice from two concurrent requests.
type CatchmentValuesResponse struct {
	Type      string                             `json:"type"`
	Attribute string                             `json:"attribute"`
	Scenarios []string                           `json:"scenarios"`
	IDs       []int64                            `json:"ids"`
	Values    *geodata.ScenarioValues            `json:"values,omitempty"`
	Series    map[string]*geodata.ScenarioValues `json:"series,omitempty"`
	DomainMin float64                            `json:"domain_min"`
	DomainMax float64                            `json:"domain_max"`
}

// CatchmentValuesType is the `type` discriminant on a columnar values response.
const CatchmentValuesType = "CatchmentValues"

// knownScenarios are the scenario names a values request may ask for. The
// render path is lenient here (anything unrecognised reads scenario_current),
// but this path accepts a caller-supplied list, so an unknown name is rejected
// rather than silently answered with the wrong table.
var knownScenarios = map[string]bool{"current": true, "reference": true, "future": true}

// parseScenarioList splits the comma-separated `scenario` parameter, dropping
// blanks and repeats while preserving the caller's order. An empty parameter
// means "current", matching handleChoropleth.
func parseScenarioList(raw string) ([]string, error) {
	scenarios := []string{}
	seen := map[string]bool{}
	for _, part := range strings.Split(raw, ",") {
		name := strings.TrimSpace(part)
		if name == "" {
			continue
		}
		if !knownScenarios[name] {
			return nil, &badScenarioError{name: name}
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		scenarios = append(scenarios, name)
	}
	if len(scenarios) == 0 {
		scenarios = []string{"current"}
	}
	return scenarios, nil
}

type badScenarioError struct{ name string }

func (e *badScenarioError) Error() string { return "unknown scenario: " + e.name }

// respondCatchmentValues answers a `valuesOnly=1` choropleth request with the
// columnar format. It is a separate handler from the FeatureCollection path
// because the two have almost nothing in common past bbox parsing: there is no
// zoom tier to select, no geometry to simplify or aggregate, and no feature
// wrapper to build.
func (h *Handler) respondCatchmentValues(w http.ResponseWriter, q url.Values, attribute string, minx, miny, maxx, maxy float64) {
	scenarios, err := parseScenarioList(q.Get("scenario"))
	if err != nil {
		respondError(w, http.StatusBadRequest, err.Error())
		return
	}

	queryStart := time.Now()
	values, err := h.gpkgStore.QueryCatchmentValues(scenarios, attribute, minx, miny, maxx, maxy)
	if err != nil {
		status := http.StatusInternalServerError
		if strings.HasPrefix(err.Error(), "invalid attribute:") ||
			strings.HasPrefix(err.Error(), "no scenario requested") ||
			strings.HasPrefix(err.Error(), "too many scenarios requested:") {
			status = http.StatusBadRequest
		}
		respondError(w, status, err.Error())
		return
	}
	log.Printf("[perf] handleChoropleth step=queryCatchmentValues scenarios=%s attribute=%s catchments=%d duration_ms=%d",
		strings.Join(scenarios, "+"), attribute, len(values.IDs), time.Since(queryStart).Milliseconds())

	// Overlay the site's per-catchment ideal values onto the future series, the
	// same substitution the FeatureCollection path makes on feature properties.
	// Only "future" carries edited targets; the other series read the datapack
	// as-is, which is why QueryCatchmentValues hands out an independent series
	// per scenario even when two of them read the same table.
	if series, wantsFuture := values.Series["future"]; wantsFuture {
		if overrides := h.idealOverridesFor(q.Get("siteId"), attribute); len(overrides) > 0 {
			positionOf := values.BuildIDIndex()
			for id, ideal := range overrides {
				if i, ok := positionOf[id]; ok {
					series.Set(i, ideal)
				}
			}
		}
	}

	// The domain range is scenario-dependent (see choroplethDomainRange), and a
	// multi-scenario request has no single answer. The first scenario named
	// wins; no caller of this endpoint colours anything from it - they compute
	// min/max/mean from the values themselves - but dropping the fields would
	// be a gratuitous break.
	domainRange := h.choroplethDomainRange(attribute, scenarios[0])

	response := CatchmentValuesResponse{
		Type:      CatchmentValuesType,
		Attribute: attribute,
		Scenarios: scenarios,
		IDs:       values.IDs,
		DomainMin: domainRange.Min,
		DomainMax: domainRange.Max,
	}
	if len(scenarios) == 1 {
		response.Values = values.Series[scenarios[0]]
	} else {
		response.Series = values.Series
	}

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "public, max-age=300")
	_ = json.NewEncoder(w).Encode(response)
}

// idealOverridesFor builds a HYBAS_ID to ideal-value lookup for one site's
// stored per-catchment targets, so the future/target scenario shows what the
// user edited rather than the datapack's reference values. Returns an empty
// map when there is no site, no site store, or nothing stored for the attribute.
func (h *Handler) idealOverridesFor(siteID, attribute string) map[int64]float64 {
	overrides := map[int64]float64{}
	if siteID == "" || h.siteStore == nil {
		return overrides
	}
	site, err := h.siteStore.Get(siteID)
	if err != nil {
		return overrides
	}
	for _, c := range site.Catchments {
		if c.Ideal == nil {
			continue
		}
		val, ok := c.Ideal[attribute]
		if !ok {
			continue
		}
		if idF, parseErr := strconv.ParseFloat(c.ID, 64); parseErr == nil {
			overrides[int64(idF)] = val
		}
	}
	return overrides
}

// choroplethDomainRange returns the colour-scale bounds for an attribute in a
// scenario.
//
// It prefers metadata.csv's curated maxval_curr/maxval_ref over the scanned
// domain_maxima table for the max bound - these are authoritative per-scenario
// ceilings rather than a value derived from scanning every catchment. "future"
// (target) values are edited starting from current, so they share current's
// ceiling. Falls back to the scanned max when a column is missing/blank for
// this attribute, and to a zero range when the domain tables are absent.
func (h *Handler) choroplethDomainRange(attribute, scenario string) *geodata.DomainRange {
	domainStart := time.Now()
	domainRange, err := h.gpkgStore.GetDomainRange(attribute)
	log.Printf("[perf] handleChoropleth step=getDomainRange attribute=%s duration_ms=%d", attribute, time.Since(domainStart).Milliseconds())
	if err != nil {
		log.Printf("Warning: could not get domain range for %s: %v", attribute, err)
		domainRange = &geodata.DomainRange{Min: 0, Max: 0}
	}

	maxvalByScenario := h.metaCache.MaxValReference
	if scenario != "reference" {
		maxvalByScenario = h.metaCache.MaxValCurrent
	}
	if metaMax, ok := maxvalByScenario[attribute]; ok {
		domainRange.Max = metaMax
	}
	return domainRange
}
