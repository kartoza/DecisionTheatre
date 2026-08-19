package bench

import "testing"

// The case these tests exist for: this server answers an unrouted /api path
// with 200 and an HTML page rather than a 404. Before checkResponse existed,
// that produced fast successful samples for endpoints that did not exist, and a
// comparison reported a newly added endpoint as having been four times faster
// before it was written.

func TestCheckResponseAcceptsGenuineResponse(t *testing.T) {
	s := Scenario{Name: "columns", Path: "/api/columns", MinBytes: 200}
	ok, absent, reason := s.checkResponse(200, "application/json", 2779)
	if !ok || absent || reason != "" {
		t.Fatalf("genuine response rejected: ok=%v absent=%v reason=%q", ok, absent, reason)
	}
}

func TestCheckResponseTreatsSPAFallbackAsAbsentNotFast(t *testing.T) {
	s := Scenario{Name: "catchment-values", Path: "/api/catchment-values", MinBytes: 100}
	// What an older build actually returns for a route it does not have.
	ok, absent, reason := s.checkResponse(200, "text/html; charset=utf-8", 16)
	if ok {
		t.Fatal("an HTML page was accepted as a sample of a JSON endpoint; this is the bug that made a new " +
			"endpoint look like a regression")
	}
	if !absent {
		t.Fatal("an HTML fallback must be reported as absent, not broken: on an older revision it is the " +
			"expected state and not a fault")
	}
	if reason == "" {
		t.Fatal("absence must carry a reason a reader can act on")
	}
}

func TestCheckResponseRejectsImplausiblySmallPayload(t *testing.T) {
	s := Scenario{Name: "tile-z8", Path: "/tiles/a/8/1/1.pbf", MinBytes: 1000}
	ok, absent, _ := s.checkResponse(200, "application/x-protobuf", 12)
	if ok {
		t.Fatal("a 12-byte tile was accepted; a stub that happens to carry the right media type must not be timed")
	}
	if !absent {
		t.Fatal("a stub-sized response is an absence rather than a breakage")
	}
}

func TestCheckResponseCountsErrorStatusAsBreakageNotAbsence(t *testing.T) {
	s := Scenario{Name: "x", Path: "/api/x"}
	ok, absent, _ := s.checkResponse(500, "application/json", 40)
	if ok {
		t.Fatal("a 500 was accepted as a sample")
	}
	if absent {
		t.Fatal("a server error is a breakage, not an absence; conflating them hides a real regression")
	}
}

func TestExpectedContentTypeInference(t *testing.T) {
	// Verified against the live server: every /api route returns
	// application/json and every tile returns application/x-protobuf.
	for _, c := range []struct{ path, want string }{
		{"/api/health", "application/json"},
		{"/api/choropleth", "application/json"},
		{"/data/tiles.json", "application/json"},
		{"/tiles/africa/8/145/151.pbf", "application/x-protobuf"},
	} {
		if got := (Scenario{Path: c.path}).expectedContentType(); got != c.want {
			t.Errorf("%s: expected %q, got %q", c.path, c.want, got)
		}
	}
}

func TestMediaTypeIgnoresParametersAndCase(t *testing.T) {
	if got := mediaType("Application/JSON; charset=utf-8"); got != "application/json" {
		t.Fatalf("got %q", got)
	}
}

func TestEverySuiteScenarioIsCheckable(t *testing.T) {
	// A scenario with no expected content type and no size floor has no defence
	// against the SPA fallback at all, which is how the original bug got in.
	for _, s := range Scenarios() {
		if s.Conditional {
			continue // checked by its 304 status instead
		}
		if s.expectedContentType() == "" && s.MinBytes == 0 {
			t.Errorf("scenario %q can neither check its content type nor its size, so a build that does not "+
				"have this route would produce plausible samples for it", s.Name)
		}
	}
}

func TestToursCoverTheFullRangeOfSizes(t *testing.T) {
	// The spread is the reason all four tours are measured rather than one: a
	// change that helps two catchments can ruin 147,837.
	all := tours()
	if len(all) != 4 {
		t.Fatalf("expected the four guided tours, got %d", len(all))
	}
	smallest, largest := all[0].catchments, all[0].catchments
	for _, x := range all {
		if x.catchments < smallest {
			smallest = x.catchments
		}
		if x.catchments > largest {
			largest = x.catchments
		}
	}
	if largest/smallest < 10000 {
		t.Fatalf("the tours span only %dx in catchment count; the point of measuring all four is the range",
			largest/smallest)
	}
}

func TestThousandsSeparates(t *testing.T) {
	for _, c := range []struct {
		in   int
		want string
	}{{2, "2"}, {11, "11"}, {147837, "147,837"}, {1000, "1,000"}} {
		if got := thousands(c.in); got != c.want {
			t.Errorf("thousands(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}
