package bench

import (
	"strings"
	"testing"
)

// The check that keeps the inventory honest. A scenario count looks like
// coverage and is not: when this was first measured, the suite reported 37
// scenarios and probed 14 of 35 registered route patterns.

func TestEveryUnprobedRouteCarriesAReason(t *testing.T) {
	// The rule that stops "coverage" being achieved by moving routes into the
	// excluded column. Anything not probed has to say why, in words a reader
	// can disagree with.
	for _, r := range Routes() {
		if r.Status == RouteProbed {
			continue
		}
		if strings.TrimSpace(r.Reason) == "" {
			t.Errorf("%s %s is %s with no reason given", r.Method, r.Pattern, r.Status)
		}
		if len(r.Reason) < 40 {
			t.Errorf("%s %s: the reason %q is too short to be an argument", r.Method, r.Pattern, r.Reason)
		}
	}
}

func TestNoRouteIsListedTwice(t *testing.T) {
	seen := map[string]bool{}
	for _, r := range Routes() {
		key := r.Method + " " + r.Pattern
		if seen[key] {
			t.Errorf("%s appears twice in the inventory, which would double-count it in the coverage figure", key)
		}
		seen[key] = true
	}
}

func TestTheSuiteReachesEveryRouteItClaimsToProbe(t *testing.T) {
	// The anti-rot check. A route marked probed that no scenario actually
	// requests is a silent gap, and this is what makes it loud.
	c := MeasureCoverage(Scenarios())
	if len(c.Gaps) > 0 {
		t.Errorf("these routes are marked probed but no scenario reaches them:\n  %s",
			strings.Join(c.Gaps, "\n  "))
	}
}

func TestCoverageCountsAddUp(t *testing.T) {
	c := MeasureCoverage(Scenarios())
	if got := c.Probed + c.Unprobeable + c.Excluded + len(c.Gaps); got != c.Registered {
		t.Fatalf("coverage does not account for every route: %d probed + %d unprobeable + %d excluded + %d gaps "+
			"= %d, but %d are registered", c.Probed, c.Unprobeable, c.Excluded, len(c.Gaps), got, c.Registered)
	}
	if c.Registered < 45 {
		t.Fatalf("only %d routes in the inventory; the server registers more than that, so the inventory has "+
			"fallen behind", c.Registered)
	}
}

func TestEveryMetadataEndpointIsReached(t *testing.T) {
	// Fifteen routes covered by one sequence scenario. If the sequence and the
	// endpoint list drift apart, some of them stop being probed and the only
	// visible symptom would be a coverage number nobody reads.
	c := MeasureCoverage(Scenarios())
	for _, g := range c.Gaps {
		if strings.Contains(g, "/api/metadata/") {
			t.Errorf("metadata endpoint not reached by any scenario: %s", g)
		}
	}
	var seq []string
	for _, s := range Scenarios() {
		if s.Name == "metadata-all" {
			seq = s.allPaths()
		}
	}
	if len(seq) != len(MetadataEndpoints) {
		t.Fatalf("metadata-all requests %d paths but there are %d metadata endpoints",
			len(seq), len(MetadataEndpoints))
	}
}

func TestRouteMatchingHandlesPlaceholders(t *testing.T) {
	for _, c := range []struct {
		pattern, path string
		want          bool
	}{
		{"/api/catchment/{id}", "/api/catchment/1121879850", true},
		{"/api/catchment/{id}", "/api/catchments/bounds", false},
		{"/api/catchments/bounds", "/api/catchments/bounds", true},
		{"/api/choropleth", "/api/choropleth?zoom=4&scenario=current", true},
		{"/api/tilesets/{name}/metadata", "/api/tilesets/africa/metadata", true},
		{"/api/tilesets", "/api/tilesets/africa/metadata", false},
		// The tile route's last segment is a placeholder with a literal suffix.
		{"/tiles/{name}/{z}/{x}/{y}.pbf", "/tiles/africa/8/145/151.pbf", true},
		{"/tiles/{name}/{z}/{x}/{y}.pbf", "/tiles/africa/8/145.pbf", false},
		// Trailing slash means prefix, which is how PathPrefix routes register.
		{"/data/walkthroughs/", "/data/walkthroughs/6dede7c6.json", true},
		{"/data/walkthroughs/", "/data/tiles.json", false},
		{"/api/sites/{id}/whiskers", "/api/sites/fb1066ef/whiskers", true},
		{"/api/sites/dissolve-catchments", "/api/sites/fb1066ef/whiskers", false},
	} {
		if got := routeMatches(c.pattern, c.path); got != c.want {
			t.Errorf("routeMatches(%q, %q) = %v, want %v", c.pattern, c.path, got, c.want)
		}
	}
}

func TestUnprobeableRoutesAreNotJustBrokenScenarios(t *testing.T) {
	// A route that cannot be called meaningfully must be recorded as such, not
	// given a scenario that fails every run. Both known-broken endpoints are in
	// the inventory and neither has a scenario.
	broken := []string{"/api/compare", "/api/scenario/{scenario}/{attribute}"}
	for _, want := range broken {
		var found bool
		for _, r := range Routes() {
			if r.Pattern == want {
				found = true
				if r.Status != RouteUnprobeable {
					t.Errorf("%s answers 404 against the real datapack but is marked %s", want, r.Status)
				}
			}
		}
		if !found {
			t.Errorf("%s is missing from the inventory", want)
		}
	}
	for _, s := range Scenarios() {
		for _, b := range broken {
			if s.Path == b {
				t.Errorf("scenario %q probes %s, which can only ever fail; that is noise, not coverage",
					s.Name, b)
			}
		}
	}
}

func TestCoverageDescribesItself(t *testing.T) {
	d := MeasureCoverage(Scenarios()).Describe()
	if !strings.Contains(d, "registered routes probed") {
		t.Fatalf("coverage sentence does not state the figure: %q", d)
	}
}
