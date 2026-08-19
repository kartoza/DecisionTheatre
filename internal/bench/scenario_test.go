package bench

import (
	"net/http"
	"net/url"
	"strings"
	"testing"
)

// A scenario name is the key history is stored under, so two scenarios sharing
// one would silently merge two different measurements. Guards against a copied
// entry keeping the name it was copied from.
func TestEveryScenarioInTheSuiteHasAUniqueName(t *testing.T) {
	seen := map[string]bool{}

	for _, s := range Scenarios() {
		if s.Name == "" {
			t.Errorf("a scenario has no name: %+v", s)
			continue
		}
		if seen[s.Name] {
			t.Errorf("two scenarios are named %q; comparison lines runs up by name", s.Name)
		}
		seen[s.Name] = true
	}
}

// Every scenario must say what it is evidence about, because the report prints
// that next to the number and a reader who does not know the codebase cannot
// otherwise tell whether 400 ms is good.
func TestEveryScenarioSaysWhatItIsEvidenceAbout(t *testing.T) {
	for _, s := range Scenarios() {
		if strings.TrimSpace(s.Why) == "" {
			t.Errorf("scenario %q has no Why, so its row in the report is a bare number", s.Name)
		}
		if strings.TrimSpace(s.Group) == "" {
			t.Errorf("scenario %q has no Group, so it is filed under Other", s.Name)
		}
		if !strings.HasPrefix(s.Path, "/") {
			t.Errorf("scenario %q has path %q, which is not rooted", s.Name, s.Path)
		}
	}
}

// The heavy scenarios must stay marked. Guards against the 14 MB full-domain
// query losing its flag and being run twenty times against production by anyone
// who types `dtbench run`.
func TestTheExpensiveScenarioIsStillMarkedHeavy(t *testing.T) {
	s, ok := scenarioByName("choropleth-full-domain-values")
	if !ok {
		t.Fatal("the full-domain statistics scenario has been removed from the suite")
	}
	if !s.Heavy {
		t.Error("the 14 MB full-domain query is no longer marked Heavy; it will run at the default sample count")
	}
}

func scenarioByName(name string) (Scenario, bool) {
	for _, s := range Scenarios() {
		if s.Name == name {
			return s, true
		}
	}
	return Scenario{}, false
}

// A base URL must join to a scenario path without a doubled or missing slash,
// however the target was typed. Guards against `--target http://host:8080/`
// producing //api/health.
func TestScenarioURLsJoinCleanlyHoweverTheTargetWasTyped(t *testing.T) {
	s := Scenario{Name: "health", Path: "/api/health"}

	for _, base := range []string{
		"http://127.0.0.1:8080",
		"http://127.0.0.1:8080/",
		"http://127.0.0.1:8080///",
	} {
		got, err := s.URL(base)
		if err != nil {
			t.Errorf("URL(%q): %v", base, err)
			continue
		}
		if got != "http://127.0.0.1:8080/api/health" {
			t.Errorf("URL(%q) = %q, want a single slash before the path", base, got)
		}
	}
}

// A target with a path prefix — a server behind a reverse proxy at /dt — must
// keep the prefix rather than having the scenario path replace it.
func TestATargetWithAPathPrefixKeepsThePrefix(t *testing.T) {
	s := Scenario{Name: "health", Path: "/api/health"}

	got, err := s.URL("https://example.org/dt")
	if err != nil {
		t.Fatal(err)
	}
	if got != "https://example.org/dt/api/health" {
		t.Errorf("URL = %q, want the /dt prefix preserved", got)
	}
}

// A base the URL parser rejects must produce an error naming the scenario, so a
// suite of fifteen failures points at the cause rather than repeating itself.
func TestAnUnparseableTargetProducesAnErrorNamingTheScenario(t *testing.T) {
	s := Scenario{Name: "health", Path: "/api/health"}

	_, err := s.URL("http://[::1")
	if err == nil {
		t.Fatal("an unparseable base produced a URL")
	}
	if !strings.Contains(err.Error(), "health") {
		t.Errorf("error = %q, want it to name the scenario", err)
	}
}

// Query parameters must be encoded, not concatenated. Guards against a bounding
// box with a negative coordinate or a scenario name with a space breaking the
// request.
func TestScenarioQueriesAreEncodedRatherThanConcatenated(t *testing.T) {
	s := Scenario{
		Name:  "choropleth",
		Path:  "/api/choropleth",
		Query: url.Values{"minx": {"-17.5"}, "attribute": {"NPP gm2"}, "scenario": {"a&b"}},
	}

	raw, err := s.URL("http://127.0.0.1:8080")
	if err != nil {
		t.Fatal(err)
	}
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("the scenario produced a URL that will not parse: %v", err)
	}

	q := u.Query()
	if q.Get("minx") != "-17.5" {
		t.Errorf("minx round-tripped as %q", q.Get("minx"))
	}
	if q.Get("attribute") != "NPP gm2" {
		t.Errorf("a space in a parameter did not survive encoding: %q", q.Get("attribute"))
	}
	if q.Get("scenario") != "a&b" {
		t.Errorf("an ampersand in a parameter split the query: %q", q.Get("scenario"))
	}
}

// The method defaults to GET so a scenario declaring nothing is still a valid
// request rather than one with an empty method.
func TestTheScenarioMethodDefaultsToGET(t *testing.T) {
	if got := (Scenario{}).HTTPMethod(); got != http.MethodGet {
		t.Errorf("HTTPMethod() = %q, want GET", got)
	}
	if got := (Scenario{Method: http.MethodPost}).HTTPMethod(); got != http.MethodPost {
		t.Errorf("HTTPMethod() = %q, want POST", got)
	}
}

// The two viewports must genuinely differ, because the aggregation tier the
// server picks depends on zoom and measuring only one hides half the behaviour.
func TestTheTwoViewportsAreActuallyDifferent(t *testing.T) {
	if fullDomain.Encode() == closeIn.Encode() {
		t.Error("the domain-wide and close-in viewports are the same bounding box")
	}
	for _, key := range []string{"minx", "miny", "maxx", "maxy"} {
		if fullDomain.Get(key) == "" || closeIn.Get(key) == "" {
			t.Errorf("a viewport is missing %s", key)
		}
	}
}

// The helper that varies a viewport must not mutate the shared one. Guards
// against one scenario's zoom leaking into every other scenario built from the
// same bounding box — which would make several rows in the report measure
// something other than what they say.
func TestVaryingAViewportDoesNotMutateTheSharedOne(t *testing.T) {
	before := fullDomain.Encode()

	varied := with(fullDomain, "zoom", "4", "minx", "0")

	if fullDomain.Encode() != before {
		t.Errorf("the shared viewport was mutated: %q became %q", before, fullDomain.Encode())
	}
	if varied.Get("zoom") != "4" || varied.Get("minx") != "0" {
		t.Errorf("the varied viewport did not take the overrides: %v", varied)
	}
	if varied.Get("maxy") != fullDomain.Get("maxy") {
		t.Error("the varied viewport lost a value it was supposed to inherit")
	}
}
