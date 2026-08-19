// Package bench measures the HTTP surface of a Decision Theatre server and
// compares one measurement against another.
//
// It exists because the performance work in this repository is argued with
// numbers, and those numbers were being produced by hand, one curl at a time,
// against whatever happened to be running. That is fine for a single claim and
// useless for a trend: there was no way to ask "is this release faster than the
// last one" or "did the change that landed on Tuesday help production".
//
// Two things follow from that purpose, and they shape the whole package:
//
//   - A measurement is only meaningful with its context. Every result records
//     what was measured, which build answered, and how — see Run. A number
//     without its provenance is the thing this replaces, not the thing it
//     produces.
//   - The tool must be able to point at a server it did not build, including
//     production. So it measures over HTTP only. Nothing here imports the
//     application.
package bench

import (
	"fmt"
	"net/url"
	"strings"
)

// A Scenario is one named request, repeated to produce a distribution.
//
// Scenarios are deliberately declared rather than discovered. An automatically
// enumerated route list would drift into measuring whatever is cheapest to call,
// and the interesting requests here are the specific expensive ones — a
// full-domain statistics query is four seconds and 14 MB, while a metadata
// lookup is a few hundred microseconds, and averaging them together would say
// nothing about either.
type Scenario struct {
	// Name identifies the scenario in results and reports, and is the key used
	// to line up one run against another. Changing it breaks comparison with
	// history, so treat it as an identifier rather than a label.
	Name string

	// Group orders the report and separates concerns: a slow tile is a different
	// conversation from a slow statistics query.
	Group string

	// Method defaults to GET.
	Method string

	// Path is relative to the target's base URL.
	Path string

	// Query is appended to Path. Kept separate so that a scenario can be varied
	// programmatically without string surgery.
	Query url.Values

	// Body, for the POST scenarios.
	Body string

	// Why records what this scenario is evidence about. It is printed in the
	// report next to the number, because a reader who does not already know the
	// codebase cannot otherwise tell whether 400 ms is good.
	Why string

	// Heavy marks a scenario expensive enough that it should not be run at the
	// default iteration count, nor against production without deliberate
	// consent. The full-domain statistics query is 14 MB per request.
	Heavy bool
}

// URL builds the absolute URL for this scenario against a base.
func (s Scenario) URL(base string) (string, error) {
	base = strings.TrimRight(base, "/")
	u, err := url.Parse(base + s.Path)
	if err != nil {
		return "", fmt.Errorf("scenario %q: %w", s.Name, err)
	}
	if len(s.Query) > 0 {
		u.RawQuery = s.Query.Encode()
	}
	return u.String(), nil
}

// HTTPMethod is Method, defaulting to GET.
func (s Scenario) HTTPMethod() string {
	if s.Method == "" {
		return "GET"
	}
	return s.Method
}

// bbox is the viewport a user actually looks at: roughly the whole African
// domain. Using one shared viewport keeps scenarios comparable with each other.
func bbox(minx, miny, maxx, maxy string) url.Values {
	return url.Values{"minx": {minx}, "miny": {miny}, "maxx": {maxx}, "maxy": {maxy}}
}

func with(base url.Values, kv ...string) url.Values {
	out := url.Values{}
	for k, v := range base {
		out[k] = append([]string(nil), v...)
	}
	for i := 0; i+1 < len(kv); i += 2 {
		out.Set(kv[i], kv[i+1])
	}
	return out
}

// Domain-wide and a single-catchment-scale viewport. The pair matters: the
// aggregation tier the server picks depends on zoom, so measuring only one hides
// half the behaviour.
var (
	fullDomain = bbox("-17.5", "-34.8", "51.4", "15.1")
	closeIn    = bbox("25", "-26", "26", "-25")
)

// Scenarios is the suite. Order within a group is the order reported.
//
// Adding one is cheap and safe. Removing or renaming one silently orphans the
// history recorded under that name, so prefer marking it obsolete elsewhere.
func Scenarios() []Scenario {
	return []Scenario{
		{
			Name:  "health",
			Group: "Baseline",
			Path:  "/api/health",
			Why:   "Round-trip with no work behind it. Everything else should be read as this plus the work.",
		},
		{
			Name:  "info",
			Group: "Baseline",
			Path:  "/api/info",
			Why:   "Also reports the build that answered, which is what lets a result be attributed to a version.",
		},
		{
			Name:  "metadata-colors",
			Group: "Metadata",
			Path:  "/api/metadata/colors",
			Why:   "Served from an in-memory cache. A regression here means the cache stopped working.",
		},
		{
			Name:  "columns",
			Group: "Metadata",
			Path:  "/api/columns",
			Why:   "The attribute list the whole interface is built from; fetched on first paint.",
		},
		{
			Name:  "scenarios",
			Group: "Metadata",
			Path:  "/api/scenarios",
			Why:   "Small, and on the critical path for the scenario switcher.",
		},
		{
			Name:  "choropleth-viewport",
			Group: "Choropleth",
			Path:  "/api/choropleth",
			Query: with(closeIn, "scenario", "current", "attribute", "NPP_gm2", "zoom", "9"),
			Why:   "The request a pan or zoom produces. This is what 'the map feels slow' means.",
		},
		{
			Name:  "choropleth-domain-aggregated",
			Group: "Choropleth",
			Path:  "/api/choropleth",
			Query: with(fullDomain, "scenario", "current", "attribute", "NPP_gm2", "zoom", "4"),
			Why:   "Continental view, served from the zoom-tier grid aggregation rather than per-catchment.",
		},
		{
			Name:  "catchment-values-viewport",
			Group: "Choropleth",
			Path:  "/api/catchment-values",
			Query: with(closeIn, "scenario", "current", "attribute", "NPP_gm2"),
			Why:   "Values for the vector-tile join: geometry comes from tiles, only the numbers over HTTP.",
		},
		{
			Name:  "choropleth-full-domain-values",
			Group: "Statistics",
			Heavy: true,
			Path:  "/api/choropleth",
			Query: with(fullDomain, "scenario", "current", "attribute", "NPP_gm2",
				"zoom", "0", "valuesOnly", "1"),
			Why: "Every catchment, no aggregation, by design — the statistics need the true dataset. " +
				"The most expensive request the API serves, and the one most worth watching.",
		},
		{
			Name:  "catchments-bounds",
			Group: "Statistics",
			Path:  "/api/catchments/bounds",
			Why:   "The extent of the dataset, asked for once on load before the map can frame itself.",
		},
		{
			Name:  "catchment-identify",
			Group: "Statistics",
			Path:  "/api/catchment/1121879850",
			Why:   "One catchment's full record — what a click on the map produces.",
		},
		// Not in the suite: /api/scenario/{scenario}/{attribute}. It answers 404
		// with "no such column: catchment_id" against the real datapack, for both
		// scenario names, so there is nothing to measure. Found by this tool's
		// first run against a live server and reported separately; a scenario that
		// can only ever fail is noise in a report, not coverage.
		{
			Name:  "tile-z8",
			Group: "Tiles",
			Path:  "/tiles/africa/8/145/151.pbf",
			Why:   "A vector tile at the zoom where catchment geometry starts being tiled.",
		},
		{
			Name:  "tile-z5",
			Group: "Tiles",
			Path:  "/tiles/africa/5/18/18.pbf",
			Why:   "A low-zoom basemap tile, served from the pre-warmed cache.",
		},
		{
			Name:  "tilejson",
			Group: "Tiles",
			Path:  "/data/tiles.json",
			Why:   "Declares which layers are tiled and at what zooms — the client decides tiles-or-GeoJSON from this.",
		},
	}
}
