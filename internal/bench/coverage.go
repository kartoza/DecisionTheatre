package bench

import (
	"fmt"
	"net/url"
	"sort"
	"strings"
)

// What the suite does not look at.
//
// This file exists because "the suite has 37 scenarios" says nothing about
// coverage, and the first person to check found that 14 of 35 registered route
// patterns were probed. A scenario count is a measure of effort; the only
// measure of coverage is the route table, and the only way it stays honest is
// if the tool computes it and prints it next to the results.
//
// Two rules shaped the design, and both are about not letting coverage become
// its own flattery metric:
//
//   - A route that cannot be called meaningfully is not covered by adding a
//     scenario that 404s. It is recorded as unprobeable, with the reason, and
//     it counts against neither total.
//   - Coverage is derived, never declared. Scenarios do not list the routes
//     they hit; the paths they actually request are matched against the
//     registered patterns. Bookkeeping rots; a derivation cannot.
//
// The inventory below is transcribed from internal/api/handler.go
// RegisterRoutes, registerDesktopSiteRoutes, and internal/server/server.go. It
// is the one piece here that must be maintained by hand, and TestRouteInventory
// checks what it can: that every pattern is well formed, that every unprobed
// route carries a reason, and that every scenario matches a route that exists.

// RouteStatus says why a registered route is or is not measured.
type RouteStatus string

const (
	// RouteProbed is expected to be matched by at least one scenario. If it is
	// not, that is a coverage gap and the run says so.
	RouteProbed RouteStatus = "probed"

	// RouteUnprobeable is a route that cannot produce a meaningful measurement
	// however it is called — it is broken, or answering it means transferring
	// gigabytes, or it opens a dialog and waits for a human.
	RouteUnprobeable RouteStatus = "unprobeable"

	// RouteExcluded is a route that could be measured but deliberately is not:
	// it mutates state, or it reaches a third party.
	RouteExcluded RouteStatus = "excluded"
)

// A Route is one registered pattern and this suite's position on it.
type Route struct {
	Method  string      `json:"method"`
	Pattern string      `json:"pattern"`
	Status  RouteStatus `json:"status"`

	// Reason is required for anything not RouteProbed. An unexplained gap is
	// the thing this file exists to prevent, so the test enforces it.
	Reason string `json:"reason,omitempty"`
}

// Routes is the server's registered route table, as this suite understands it.
func Routes() []Route {
	const (
		mutates  = "Mutates server state. A benchmark that changes the data underneath itself stops being repeatable, and this suite is pointed at live servers."
		desktop  = "Desktop-only, and needs a site registered in the server's own store. A walkthrough is not one, and a hosted target does not register the route at all."
		external = "Reaches a third party. Measuring it would measure somebody else's service and send them traffic every time this suite runs."
	)

	r := []Route{
		// Baseline and metadata.
		{"GET", "/api/health", RouteProbed, ""},
		{"GET", "/api/info", RouteProbed, ""},
		{"GET", "/api/scenarios", RouteProbed, ""},
		{"GET", "/api/columns", RouteProbed, ""},

		// Tile metadata.
		{"GET", "/api/tilesets", RouteProbed, ""},
		{"GET", "/api/tilesets/{name}/metadata", RouteProbed, ""},

		// Data.
		{"GET", "/api/aggregate", RouteProbed, ""},
		{"GET", "/api/precalculate/full", RouteProbed, ""},
		{"GET", "/api/catchment/{id}", RouteProbed, ""},
		{"GET", "/api/choropleth", RouteProbed, ""},
		{"GET", "/api/catchment-values", RouteProbed, ""},
		{"GET", "/api/catchments/bounds", RouteProbed, ""},
		{"GET", "/api/catchments/geometry/{id}", RouteProbed, ""},
		{"POST", "/api/catchments/in-bbox", RouteProbed, ""},
		{"POST", "/api/sites/dissolve-catchments", RouteProbed, ""},
		{"POST", "/api/sites/{id}/catchments", RouteProbed, ""},
		{"POST", "/api/sites/{id}/whiskers", RouteProbed, ""},

		// Both of these answer 404 with "no such column: catchment_id" against
		// the real datapack, for every combination of parameters tried. They
		// are not slow or fast; they do not work. A scenario that can only ever
		// fail is noise in a report rather than coverage, so they are recorded
		// here instead — which also means the day somebody fixes them, this
		// file is where it says they were broken.
		{"GET", "/api/scenario/{scenario}/{attribute}", RouteUnprobeable,
			`Answers 404 "no such column: catchment_id" against the real datapack for both scenario names. ` +
				"GetScenarioData hardcodes the id column while resolveScenarioIDColumn, which already handles " +
				"this, sits unused beside it."},
		{"GET", "/api/compare", RouteUnprobeable,
			`Answers 404 "no such column: l.catchment_id" for every parameter combination tried, including the ` +
				"documented left/right/attribute. Same root cause as /api/scenario/{scenario}/{attribute}."},

		// Site reads and writes.
		{"GET", "/api/sites/{id}/catchments", RouteExcluded,
			"The GET form looks the site up in the server's own store, which holds no record of a walkthrough, " +
				"so it 404s. The POST form carries the site inline and is what the browser uses; that is probed."},
		{"GET", "/api/sites/{id}/whiskers", RouteExcluded,
			"As for the catchments GET: the POST form is the one the browser uses, and is probed."},
		{"GET", "/api/sites/{id}/indicators", RouteExcluded, desktop},
		{"POST", "/api/sites/{id}/indicators", RouteExcluded, mutates},
		{"PATCH", "/api/sites/{id}/indicators", RouteExcluded, mutates},
		{"POST", "/api/sites", RouteExcluded, mutates},
		{"GET", "/api/sites", RouteExcluded, desktop},
		{"GET", "/api/sites/{id}", RouteExcluded, desktop},
		{"PUT", "/api/sites/{id}", RouteExcluded, mutates},
		{"PATCH", "/api/sites/{id}", RouteExcluded, mutates},
		{"DELETE", "/api/sites/{id}", RouteExcluded, mutates},
		{"POST", "/api/sites/{id}/indicators/reset", RouteExcluded, mutates},
		{"POST", "/api/sites/{id}/boundary/union/{catchmentId}", RouteExcluded, mutates},
		{"POST", "/api/sites/{id}/boundary/difference/{catchmentId}", RouteExcluded, mutates},

		// Deployment management.
		{"GET", "/api/datapack/status", RouteProbed, ""},
		{"GET", "/api/datapack/download-info", RouteProbed, ""},
		{"GET", "/api/executables/info", RouteProbed, ""},
		{"GET", "/api/datapack/download", RouteUnprobeable,
			"Serves the datapack itself, which is 3.45 GB. Twenty iterations of that is not a benchmark, it is " +
				"69 GB of disk and network."},
		{"GET", "/api/executables/download/{platform}", RouteUnprobeable,
			"Serves an installer, and reports none available on this build. Measuring a file copy would say " +
				"nothing about the application."},
		{"POST", "/api/datapack/install", RouteExcluded,
			"Replaces the entire contents of the data directory. Running this against a live server during a " +
				"benchmark would destroy the thing being measured."},
		{"POST", "/api/dialog/open-file", RouteUnprobeable,
			"Opens a native file picker and blocks until a human answers it."},

		// Map surface.
		{"GET", "/tiles/{name}/{z}/{x}/{y}.pbf", RouteProbed, ""},
		{"GET", "/data/style.json", RouteProbed, ""},
		{"GET", "/data/tiles.json", RouteProbed, ""},
		{"GET", "/data/walkthroughs/", RouteProbed, ""},
		{"GET", "/api/geocode", RouteExcluded, external},
		{"GET", "/fonts/{fontstack}/{range}.pbf", RouteExcluded,
			external + " The proxy fetches from a CDN on first use and caches, so a measurement would be either " +
				"somebody else's latency or a memory read, depending on timing."},
		{"GET", "/data/images/", RouteExcluded,
			"A static file server over the data directory. It measures the filesystem, not the application."},
		{"GET", "/data/demo/", RouteExcluded,
			"As for /data/images/: a static file server over demo assets."},
		{"GET", "/docs/", RouteExcluded,
			"The embedded documentation site. Static files compiled into the binary; nothing here varies with " +
				"the datapack or the query path."},
	}

	// The metadata endpoints, which are the largest single block and the one
	// most likely to be waved through.
	//
	// The suite used to probe exactly one of the fifteen — colors — and let it
	// stand for the rest. Measured, that assumption does not hold: colors is
	// 930 bytes and 0.58 ms, while details is 6,558 bytes and 1.95 ms, seven
	// times the payload and three times the time. They are not one cache behind
	// one shape of response, so one probe cannot speak for the others.
	//
	// They are covered by a single sequence scenario rather than fifteen
	// individual ones, and that is a deliberate trade explained in
	// scenario.go's metadata-all entry: individually they are all below this
	// harness's resolution and could never produce a verdict, while together
	// they are the ~15 ms the client actually spends on first paint.
	for _, m := range MetadataEndpoints {
		r = append(r, Route{"GET", "/api/metadata/" + m, RouteProbed, ""})
	}
	return r
}

// MetadataEndpoints are the metadata lookups the client fetches on first paint.
//
// Order matters only in that it is the order the sequence scenario requests
// them in; keeping it stable keeps that scenario comparable across runs.
var MetadataEndpoints = []string{
	"colors", "details", "variabletypes", "inputs", "targetinputs",
	"targetranges", "canmap", "cangraph", "axislabels", "xaxislabels",
	"units", "charttypes", "groupingvariables", "groupingvalues", "dial0middle",
	"ignorexgrouping",
}

// Coverage is what fraction of the server's routes this suite looked at.
//
// Recorded in every run so that a report can state it. A reader has no other
// way to know what the suite did not examine, and a number that is not printed
// is a number that rots.
type Coverage struct {
	// Registered is every route pattern the suite knows the server has.
	Registered int `json:"registered"`

	// Probed is how many were actually requested by a scenario in this run.
	Probed int `json:"probed"`

	// Unprobeable and Excluded are the routes deliberately not measured, each
	// carrying a reason in the inventory.
	Unprobeable int `json:"unprobeable"`
	Excluded    int `json:"excluded"`

	// Gaps are routes the inventory expects to be probed that no scenario
	// actually reached. A non-empty list here is a bug in the suite, not a
	// property of the server, which is why it is reported separately from the
	// counts rather than quietly reducing them.
	Gaps []string `json:"gaps,omitempty"`
}

// Describe is the sentence a report can print.
func (c Coverage) Describe() string {
	var b strings.Builder
	fmt.Fprintf(&b, "%d of %d registered routes probed", c.Probed, c.Registered)
	if c.Unprobeable > 0 || c.Excluded > 0 {
		fmt.Fprintf(&b, "; %d cannot be measured meaningfully and %d are deliberately left alone, each with a "+
			"recorded reason", c.Unprobeable, c.Excluded)
	}
	if len(c.Gaps) > 0 {
		fmt.Fprintf(&b, ". %d route(s) the suite intends to cover were not reached by any scenario: %s",
			len(c.Gaps), strings.Join(c.Gaps, ", "))
	}
	return b.String() + "."
}

// MeasureCoverage matches the paths the scenarios actually request against the
// registered route patterns.
//
// Derived rather than declared: a scenario says which URL it fetches, and this
// works out which pattern that URL lands on. Nothing has to be kept in step by
// hand, so nothing can fall out of step silently.
func MeasureCoverage(scenarios []Scenario) Coverage {
	var c Coverage
	routes := Routes()

	probed := map[string]bool{}
	for _, s := range scenarios {
		for _, p := range s.allPaths() {
			for _, rt := range routes {
				if rt.Method == s.HTTPMethod() && routeMatches(rt.Pattern, p) {
					probed[rt.Method+" "+rt.Pattern] = true
				}
			}
		}
	}

	for _, rt := range routes {
		c.Registered++
		key := rt.Method + " " + rt.Pattern
		switch rt.Status {
		case RouteUnprobeable:
			c.Unprobeable++
		case RouteExcluded:
			c.Excluded++
		default:
			if probed[key] {
				c.Probed++
			} else {
				c.Gaps = append(c.Gaps, key)
			}
		}
	}
	sort.Strings(c.Gaps)
	return c
}

// allPaths is every path a scenario requests, including its sequence.
func (s Scenario) allPaths() []string {
	out := []string{s.Path}
	out = append(out, s.Sequence...)
	return out
}

// routeMatches reports whether a concrete path lands on a registered pattern.
//
// Handles the two forms mux uses — {name} and {name:regexp} — and treats a
// pattern ending in "/" as a prefix, which is how PathPrefix routes are
// registered. Segment counts must agree otherwise, so /api/catchment/123
// matches /api/catchment/{id} and not /api/catchments/bounds.
func routeMatches(pattern, path string) bool {
	if i := strings.IndexByte(path, '?'); i >= 0 {
		path = path[:i]
	}
	if u, err := url.Parse(path); err == nil && u.Path != "" {
		path = u.Path
	}

	if strings.HasSuffix(pattern, "/") {
		return strings.HasPrefix(path, pattern)
	}

	pp := strings.Split(strings.Trim(pattern, "/"), "/")
	ps := strings.Split(strings.Trim(path, "/"), "/")
	if len(pp) != len(ps) {
		return false
	}
	for i := range pp {
		seg := pp[i]
		if strings.HasPrefix(seg, "{") {
			continue // a placeholder matches any single segment
		}
		// The tile route's last segment is "{y:[0-9]+}.pbf": a placeholder with
		// a literal suffix.
		if j := strings.IndexByte(seg, '{'); j >= 0 {
			if k := strings.LastIndexByte(seg, '}'); k >= 0 {
				if !strings.HasPrefix(ps[i], seg[:j]) || !strings.HasSuffix(ps[i], seg[k+1:]) {
					return false
				}
				continue
			}
		}
		if seg != ps[i] {
			return false
		}
	}
	return true
}
