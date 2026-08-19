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
	"context"
	"fmt"
	"net/http"
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

	// ContentType is the media type a genuine response carries. It exists
	// because of a failure mode that is worse than any timing error this tool
	// could make.
	//
	// An unrouted /api path on this server does not 404. It falls through to the
	// single-page-application handler and returns 200 OK with an HTML document.
	// So a scenario measuring an endpoint that did not exist yet in an older
	// revision records fast, successful, small samples — and a comparison then
	// reports that a newly added endpoint used to be several times faster before
	// the work that introduced it. That is a flattering-but-wrong number aimed
	// squarely at the claim the tool exists to test.
	//
	// Checking the media type catches it cleanly: index.html is text/html, and
	// no scenario here wants text/html. When empty, expectedContentType infers
	// one from the path, so the default is safe rather than absent.
	ContentType string

	// MinBytes is a plausibility floor on the response body, in wire bytes.
	//
	// A second line of defence for the case where a stub or an error page
	// happens to carry the right media type — a JSON error object is
	// application/json and perfectly well formed. Zero means no floor. Keep
	// these generously below the real size: the point is to catch a response
	// that is obviously not the payload, not to assert an exact size, and a
	// floor set too close to the truth would break the day a payload shrinks,
	// which is the outcome this suite is hoping for.
	MinBytes int64

	// Conditional makes this scenario measure a revalidation rather than a
	// fetch: the first request captures the response's validator (ETag, falling
	// back to Last-Modified) and every measured request replays it, so what is
	// timed is a conditional GET.
	//
	// A scenario like this only produces a number if the server actually
	// answers 304. If it offers no validator, or answers 200 anyway, the
	// scenario reports itself unsupported rather than quietly timing a full
	// response — which would understate the win by exactly the amount the
	// feature is worth.
	Conditional bool

	// Prepare builds the request body at run time, once, before measuring.
	//
	// Needed because the most interesting POST bodies in this application are
	// not constants: opening a tour posts the whole site document back to the
	// server, and the Africa tour's document carries 147,837 catchment ids and
	// is roughly 1.8 MB. Embedding that in this source file is absurd; fetching
	// it from the target is what the browser does, so it is also the faithful
	// thing to do.
	//
	// A Prepare that fails marks the scenario absent rather than broken. On an
	// older revision the document it fetches may not exist, and "this tour was
	// not in the datapack yet" is a fact about the range being swept, not a
	// fault in the build.
	Prepare func(ctx context.Context, client *http.Client, base string) (string, error)
}

// expectedContentType is ContentType, or an inference from the path.
//
// Inferring keeps the suite readable — fourteen scenarios do not each need an
// annotation to state that the JSON API returns JSON — while still giving every
// scenario a check. The inference is deliberately coarse: it only has to
// distinguish a real response from an HTML page.
func (s Scenario) expectedContentType() string {
	if s.ContentType != "" {
		return s.ContentType
	}
	switch {
	case strings.HasSuffix(s.Path, ".pbf"):
		return "application/x-protobuf"
	case strings.HasPrefix(s.Path, "/api/"), strings.HasSuffix(s.Path, ".json"):
		return "application/json"
	default:
		return ""
	}
}

// checkResponse decides whether a response is a sample of this scenario at all.
//
// The distinction it draws is between three states that the previous version of
// this tool collapsed into one:
//
//   - a genuine response, which is a sample;
//   - a response for a route that does not exist on this build, which is not a
//     regression, an improvement or a breakage but an absence, and is the
//     expected state for a scenario introduced partway through a sweep's range;
//   - a response that is present and wrong, which is a breakage.
//
// Only the first is timed. The other two are reported in their own words,
// because "this endpoint did not exist yet" and "this endpoint is broken" are
// different sentences and a reader who confuses them draws the wrong conclusion
// about a week's work.
func (s Scenario) checkResponse(status int, contentType string, bytes int64) (ok bool, absent bool, reason string) {
	if status >= 400 {
		return false, false, fmt.Sprintf("HTTP %d", status)
	}

	want := s.expectedContentType()
	got := mediaType(contentType)

	// An HTML body from a JSON or tile route is the single-page application
	// answering for a route that was never registered. Name that precisely: it
	// is the difference between "you removed this" and "you had not written it
	// yet".
	if want != "" && got != want {
		if got == "text/html" {
			return false, true, fmt.Sprintf(
				"the server answered %d with an HTML page rather than %s, which is what this server does for a "+
					"route it does not have: this endpoint does not exist on this build", status, want)
		}
		return false, false, fmt.Sprintf("expected %s, got %s", want, orNone(got))
	}

	if s.MinBytes > 0 && bytes < s.MinBytes {
		return false, true, fmt.Sprintf(
			"the response was %d bytes, below the %d this scenario needs to be a real payload; treating it as a "+
				"stub rather than a fast result", bytes, s.MinBytes)
	}

	return true, false, ""
}

// mediaType strips parameters and normalises case: "application/json;
// charset=utf-8" and "Application/JSON" are the same type.
func mediaType(header string) string {
	t := header
	if i := strings.IndexByte(t, ';'); i >= 0 {
		t = t[:i]
	}
	return strings.ToLower(strings.TrimSpace(t))
}

func orNone(s string) string {
	if s == "" {
		return "no content type at all"
	}
	return s
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
	base := []Scenario{
		{
			Name:     "health",
			MinBytes: 8,
			Group:    "Baseline",
			Path:     "/api/health",
			Why:      "Round-trip with no work behind it. Everything else should be read as this plus the work.",
		},
		{
			Name:     "info",
			MinBytes: 50,
			Group:    "Baseline",
			Path:     "/api/info",
			Why:      "Also reports the build that answered, which is what lets a result be attributed to a version.",
		},
		{
			Name:     "metadata-colors",
			MinBytes: 100,
			Group:    "Metadata",
			Path:     "/api/metadata/colors",
			Why:      "Served from an in-memory cache. A regression here means the cache stopped working.",
		},
		{
			Name:     "columns",
			MinBytes: 200,
			Group:    "Metadata",
			Path:     "/api/columns",
			Why:      "The attribute list the whole interface is built from; fetched on first paint.",
		},
		{
			Name:     "scenarios",
			MinBytes: 8,
			Group:    "Metadata",
			Path:     "/api/scenarios",
			Why:      "Small, and on the critical path for the scenario switcher.",
		},
		{
			Name:     "choropleth-viewport",
			MinBytes: 1000,
			Group:    "Choropleth",
			Path:     "/api/choropleth",
			Query:    with(closeIn, "scenario", "current", "attribute", "NPP_gm2", "zoom", "9"),
			Why:      "The request a pan or zoom produces. This is what 'the map feels slow' means.",
		},
		{
			Name:     "choropleth-domain-aggregated",
			MinBytes: 10000,
			Group:    "Choropleth",
			Path:     "/api/choropleth",
			Query:    with(fullDomain, "scenario", "current", "attribute", "NPP_gm2", "zoom", "4"),
			Why:      "Continental view, served from the zoom-tier grid aggregation rather than per-catchment.",
		},
		{
			Name:     "catchment-values-viewport",
			MinBytes: 100,
			Group:    "Choropleth",
			Path:     "/api/catchment-values",
			Query:    with(closeIn, "scenario", "current", "attribute", "NPP_gm2"),
			Why:      "Values for the vector-tile join: geometry comes from tiles, only the numbers over HTTP.",
		},
		{
			Name:     "choropleth-full-domain-values",
			MinBytes: 10000,
			Group:    "Statistics",
			Heavy:    true,
			Path:     "/api/choropleth",
			Query: with(fullDomain, "scenario", "current", "attribute", "NPP_gm2",
				"zoom", "0", "valuesOnly", "1"),
			Why: "Every catchment, no aggregation, by design — the statistics need the true dataset. " +
				"The most expensive request the API serves, and the one most worth watching.",
		},
		{
			Name:     "catchments-bounds",
			MinBytes: 40,
			Group:    "Statistics",
			Path:     "/api/catchments/bounds",
			Why:      "The extent of the dataset, asked for once on load before the map can frame itself.",
		},
		{
			Name:     "catchment-identify",
			MinBytes: 100,
			Group:    "Statistics",
			Path:     "/api/catchment/1121879850",
			Why:      "One catchment's full record — what a click on the map produces.",
		},
		// Not in the suite: /api/scenario/{scenario}/{attribute}. It answers 404
		// with "no such column: catchment_id" against the real datapack, for both
		// scenario names, so there is nothing to measure. Found by this tool's
		// first run against a live server and reported separately; a scenario that
		// can only ever fail is noise in a report, not coverage.
		{
			Name:     "tile-z8",
			MinBytes: 1000,
			Group:    "Tiles",
			Path:     "/tiles/africa/8/145/151.pbf",
			Why:      "A vector tile at the zoom where catchment geometry starts being tiled.",
		},
		{
			Name:     "tile-z5",
			MinBytes: 500,
			Group:    "Tiles",
			Path:     "/tiles/africa/5/18/18.pbf",
			Why:      "A low-zoom basemap tile, served from the pre-warmed cache.",
		},
		{
			Name:     "tilejson",
			MinBytes: 100,
			Group:    "Tiles",
			Path:     "/data/tiles.json",
			Why:      "Declares which layers are tiled and at what zooms — the client decides tiles-or-GeoJSON from this.",
		},

		// Revalidation. These two are the cheapest large win available to this
		// server and, at the time of writing, one it does not collect: no handler
		// sets an ETag, and none answers 304. The scenarios are here anyway,
		// deliberately.
		//
		// The alternative — leaving conditional requests unmeasured because they
		// do not work yet — is how a missing feature stays missing. A scenario
		// that reports "unsupported on this build" every run is a standing,
		// dated, machine-checked statement that the win is still on the table,
		// and it starts producing a number the day somebody sets a header. The
		// implementation refuses to time a 200 as though it were a 304, so it
		// cannot silently start reporting a non-existent saving.
		{
			Name:        "tile-z8-revalidate",
			Group:       "Revalidation",
			Path:        "/tiles/africa/8/145/151.pbf",
			Conditional: true,
			Why: "A browser returning to the map already holds this tile and only needs to know it is still current. " +
				"The tile is 35 KB and declares max-age=86400, so a 304 would replace almost all of it with headers.",
		},
		{
			Name:        "choropleth-viewport-revalidate",
			Group:       "Revalidation",
			Path:        "/api/choropleth",
			Query:       with(closeIn, "scenario", "current", "attribute", "NPP_gm2", "zoom", "9"),
			Conditional: true,
			Why: "The pan-and-zoom request, revalidated rather than refetched. It declares max-age=300 but offers no " +
				"validator, so a client that has it and wants to check cannot, and pays the full query again.",
		},
	}

	// The guided tours, and with them the chart, dial and table views. See
	// tours.go for why all four tours are measured rather than one.
	return append(base, tourScenarios()...)
}
