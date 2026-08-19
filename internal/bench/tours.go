package bench

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// The four guided tours, measured as a user experiences them.
//
// Why these belong in the suite at all: everything else here is the map. The
// application has four view modes — map, chart, dial and table — and three of
// them were unmeasured, which is unfortunate given that they are the three that
// consume the per-catchment breakdown, the data the recent work changed most.
// A benchmark that covers only the part of the application that changed least
// will report that nothing much happened.
//
// Why all four tours rather than one: they span four orders of magnitude.
//
//	Shai Hills           2 catchments      168 KB document
//	Viphya               7 catchments      456 KB document
//	Munywana            11 catchments      374 KB document
//	Africa         147,837 catchments      2.1 MB document
//
// The recent work traded per-request cost against payload size — vector tiles
// instead of GeoJSON, a columnar values endpoint, dropping the client-side
// breakdown. Changes of that shape do not scale uniformly: a change that helps
// a two-catchment tour can ruin a 147,837-catchment one, and measuring either
// alone would hide it. The spread is the point, so the catchment count travels
// with the name into the report rather than being folklore.

// A tour is one walkthrough site and the requests that opening it produces.
type tour struct {
	slug  string
	id    string
	title string

	// catchments is the site's catchment count, carried into the group label
	// because "Africa" and "Shai Hills" mean nothing to a reader who does not
	// already know that one is 147,837 catchments and the other is 2.
	catchments int

	// bbox is the site's own extent, taken from the boundingBox field of its
	// walkthrough document. Every other choropleth scenario in this suite uses
	// one shared viewport; a tour has to be measured over its own, because the
	// aggregation tier the server picks depends on how much is in view and a
	// tour that spans a continent and one that spans a nature reserve land on
	// different code paths.
	minX, minY, maxX, maxY float64

	// heavy marks the tour whose breakdown is expensive enough that it should
	// not run at full sample counts, nor against production without consent.
	// Marked per tour rather than per endpoint: it is the size of the site that
	// makes a request expensive, not which endpoint it is.
	heavy bool
}

// The four tours, with extents and counts read from the walkthrough documents
// in data/walkthroughs/. They are transcribed rather than derived so that the
// suite's shape does not depend on the datapack the tool happens to be pointed
// at; the documents themselves are fetched at run time where a request needs
// their contents.
func tours() []tour {
	return []tour{
		{
			slug: "shai-hills", id: "d4061726-167d-4074-9f58-4a0de0ed534b",
			title: "Shai Hills", catchments: 2,
			minX: 0.038171401617991, minY: 5.85360201503534,
			maxX: 0.089923411645459, maxY: 5.964493660014832,
		},
		{
			slug: "viphya", id: "165bcb54-71aa-49de-8e80-bb3142f16eb7",
			title: "Viphya Complex Forest Reserve", catchments: 7,
			minX: 33.536156841295735, minY: -12.143648868944268,
			maxX: 33.73194375683016, maxY: -11.998891025912485,
		},
		{
			slug: "munywana", id: "fb1066ef-978e-4744-ac62-570a7cb366ed",
			title: "Munywana", catchments: 11,
			minX: 32.13731315561924, minY: -27.91448324898962,
			maxX: 32.44083980170812, maxY: -27.679540335148133,
		},
		{
			slug: "africa", id: "6dede7c6-8eb3-47a8-a678-16c610b551e6",
			title: "Africa", catchments: 147837,
			minX: -17.499999999999996, minY: -34.82195403399993,
			maxX: 51.397508902000084, maxY: 15.1,
			heavy: true,
		},
	}
}

// group is the report heading for a tour, with its scale attached.
func (t tour) group() string {
	return fmt.Sprintf("Tour: %s (%s catchments)", t.title, thousands(t.catchments))
}

func (t tour) bbox() url.Values {
	f := func(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
	return bbox(f(t.minX), f(t.minY), f(t.maxX), f(t.maxY))
}

// documentPath is where the tour's site document is served from. It is a static
// file behind http.FileServer, not an API route.
func (t tour) documentPath() string { return "/data/walkthroughs/" + t.id + ".json" }

// tourScenarios builds every tour's scenarios.
//
// Five per tour, one for each thing opening it actually does: fetch its
// document, then the map, table, dial and chart views' requests.
func tourScenarios() []Scenario {
	var out []Scenario

	// The manifest first. It is one scenario rather than four because it is
	// fetched once per session for the whole list.
	//
	// It earns its place as a banked win: the sites list used to fetch all four
	// tour documents — 5,025,346 bytes — purely to render four titles, and the
	// manifest replaced that with 1,184 bytes. The suite could not see that
	// before, which means it could not see one of the clearest improvements in
	// the range it is meant to assess.
	out = append(out, Scenario{
		Name:     "tour-manifest",
		Group:    "Tours",
		Path:     "/data/walkthroughs/manifest.json",
		MinBytes: 200,
		Why: "The list of guided tours, fetched on the sites view. It exists so that rendering four titles no " +
			"longer requires downloading four full tour documents — 1.2 KB in place of 4.8 MB.",
	})

	for _, t := range tours() {
		out = append(out,
			// The document itself. A static file, and a measurable, already
			// banked win: the Africa document halved from 4.0 MB to 2.01 MB
			// when a duplicated catchmentIds array was removed from it.
			Scenario{
				Name:     "tour-" + t.slug + "-document",
				Group:    t.group(),
				Path:     t.documentPath(),
				MinBytes: 10000,
				Why: fmt.Sprintf(
					"The tour document, fetched when the tour is opened. %s catchments; this file is the whole "+
						"site definition and is downloaded in full before anything renders.",
					thousands(t.catchments)),
			},

			// Map view over the tour's own extent.
			Scenario{
				Name:     "tour-" + t.slug + "-choropleth",
				Group:    t.group(),
				Path:     "/api/choropleth",
				Query:    with(t.bbox(), "scenario", "current", "attribute", "NPP_gm2", "zoom", zoomFor(t)),
				MinBytes: 20,
				Heavy:    t.heavy,
				Why:      "The map view framed on this tour's own extent, rather than the shared viewport the rest of the suite uses.",
			},

			// Table view.
			//
			// POST, not GET, and the distinction is load-bearing. GET
			// /api/sites/{id}/catchments looks up the site in the server's own
			// store, which has no record of a walkthrough, so it 404s — and an
			// unrouted or failing path on an older build answers 200 with an
			// HTML page. A scenario using GET would measure a fallback rather
			// than the feature. The browser posts the site inline with
			// runtime:"browser"; this mirrors that exactly.
			Scenario{
				Name:     "tour-" + t.slug + "-catchments",
				Group:    t.group(),
				Method:   "POST",
				Path:     "/api/sites/" + t.id + "/catchments",
				Prepare:  siteBody(t, stripIndicators),
				MinBytes: 20,
				Heavy:    t.heavy,
				Why: "What the table view asks for: the per-catchment breakdown for this tour. Posted with the site " +
					"inline, which is what the browser does, because the server holds no record of a walkthrough site.",
			},

			// Dial view.
			//
			// The indicators block is stripped from the posted site
			// deliberately. The handler short-circuits and echoes cached bounds
			// back when the request already carries indicators.referenceLower,
			// so leaving them in would measure a JSON round trip and report it
			// as the cost of computing whisker bounds — a flattering number for
			// work the server never did.
			Scenario{
				Name:    "tour-" + t.slug + "-whiskers",
				Group:   t.group(),
				Method:  "POST",
				Path:    "/api/sites/" + t.id + "/whiskers",
				Prepare: siteBody(t, stripIndicators),
				// 200 rather than 20, and the difference is a real finding.
				// This endpoint answers 200 with
				// {"referenceUpper":null,"referenceLower":null,...} — 86 bytes
				// of nothing — for the Africa tour, while a tour that works
				// returns tens of kilobytes. A floor of 20 would have recorded
				// that as a fast success. See NOTES-performance.md: a size
				// floor catches an empty response, and an all-null response is
				// only caught if the floor is set above it.
				MinBytes: 200,
				Heavy:    t.heavy,
				Why: "What the dial view asks for: the whisker bounds for this tour. The cached indicators are " +
					"stripped from the request so this measures the computation rather than an echo of it.",
			},

			// Chart view.
			//
			// Twelve attributes in one call because that is the batch size the
			// chart uses, and the chart fires six of these in parallel per
			// render. One batch is measured rather than six: this tool times
			// one request at a time by design, and six concurrent requests
			// would measure the machine's ability to saturate the server
			// instead of how long the work takes.
			Scenario{
				Name:  "tour-" + t.slug + "-aggregate",
				Group: t.group(),
				Path:  "/api/aggregate",
				Query: with(t.bbox(), "scenario", "current", "attributes", strings.Join(chartBatch, ",")),
				// The response is a small map of attribute to number, so the
				// floor here is genuinely tiny; the cost is all server side.
				MinBytes: 20,
				Heavy:    t.heavy,
				Why: fmt.Sprintf(
					"What the chart view asks for: %d attributes aggregated over this tour's extent. The chart "+
						"issues six of these in parallel per render, so the figure here is one sixth of what a "+
						"chart render costs in requests, though not in wall-clock time.", len(chartBatch)),
			},
		)
	}
	return out
}

// chartBatch is one of the chart view's attribute batches.
//
// Twelve names, taken from the head of the real column list, matching the batch
// size the chart uses. The specific attributes matter less than the count — the
// server aggregates each one over the same row set — but they must be real, or
// the request is a 400 and measures nothing.
var chartBatch = []string{
	"lowTC_prop", "highTC_prop", "meanTC", "AGBwd_Mgha",
	"LitterBiomass_gm2", "NPP_gm2", "flamNPP_gm2", "SOC_Mgha_0_30",
	"deltaSOC_Mgha_trees", "deltaSOC_Mgha_grazers", "deltaSOC_Mgha", "prop_X0_5Mgha",
}

// zoomFor picks a zoom consistent with the tour's extent.
//
// The server chooses between per-catchment detail and grid aggregation from how
// much is in view, so a zoom that does not match the extent would measure a code
// path the user never reaches for this tour. Continental gets the aggregated
// path; a reserve gets the detailed one.
func zoomFor(t tour) string {
	if t.maxX-t.minX > 10 {
		return "4"
	}
	return "9"
}

// siteBody returns a Prepare that fetches the tour's document from the target
// and wraps it the way the browser does.
//
// Fetching rather than embedding is what keeps this faithful: the body posted is
// byte for byte the document that build serves, so a change to the document is
// reflected in the measurement instead of being hidden behind a copy that was
// current when somebody last edited this file.
func siteBody(t tour, transform func(map[string]any)) func(context.Context, *http.Client, string) (string, error) {
	return func(ctx context.Context, client *http.Client, base string) (string, error) {
		target := strings.TrimRight(base, "/") + t.documentPath()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			return "", err
		}
		resp, err := client.Do(req)
		if err != nil {
			return "", fmt.Errorf("fetch %s: %w", t.documentPath(), err)
		}
		defer func() { _ = resp.Body.Close() }()

		if resp.StatusCode != http.StatusOK {
			return "", fmt.Errorf("this build does not serve %s (HTTP %d), so the %s tour is not present in its "+
				"datapack", t.documentPath(), resp.StatusCode, t.title)
		}
		if ct := mediaType(resp.Header.Get("Content-Type")); ct != "application/json" {
			return "", fmt.Errorf("%s returned %s rather than JSON, so this build has no %s tour document",
				t.documentPath(), orNone(ct), t.title)
		}

		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			return "", err
		}
		var site map[string]any
		if err := json.Unmarshal(raw, &site); err != nil {
			return "", fmt.Errorf("parse %s: %w", t.documentPath(), err)
		}
		if transform != nil {
			transform(site)
		}

		body, err := json.Marshal(map[string]any{"runtime": "browser", "site": site})
		if err != nil {
			return "", err
		}
		return string(body), nil
	}
}

// stripIndicators removes the fields that would let the server answer from the
// request instead of doing the work, and the thumbnail the browser also drops.
func stripIndicators(site map[string]any) {
	delete(site, "indicators")
	delete(site, "thumbnail")
}

// thousands formats a count with separators, so 147837 reads as 147,837 at a
// glance beside a 2.
func thousands(n int) string {
	s := strconv.Itoa(n)
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	pre := len(s) % 3
	if pre > 0 {
		b.WriteString(s[:pre])
	}
	for i := pre; i < len(s); i += 3 {
		if b.Len() > 0 {
			b.WriteByte(',')
		}
		b.WriteString(s[i : i+3])
	}
	return b.String()
}

// metadataSequence is the metadata endpoints after the first, which the
// scenario's Path already covers.
func metadataSequence() []string {
	out := make([]string, 0, len(MetadataEndpoints)-1)
	for _, m := range MetadataEndpoints[1:] {
		out = append(out, "/api/metadata/"+m)
	}
	return out
}

// dissolveBody builds the body for the dissolve scenario from a tour's
// catchment ids.
//
// Munywana's eleven, fetched from the target rather than transcribed, for the
// same reason the site-posting scenarios fetch theirs: the ids have to exist in
// the datapack being measured, and a build whose datapack lacks that tour
// should report the scenario absent rather than time a 400.
func dissolveBody() func(context.Context, *http.Client, string) (string, error) {
	const munywana = "fb1066ef-978e-4744-ac62-570a7cb366ed"
	return func(ctx context.Context, client *http.Client, base string) (string, error) {
		var t tour
		for _, candidate := range tours() {
			if candidate.id == munywana {
				t = candidate
			}
		}
		raw, err := siteBody(t, nil)(ctx, client, base)
		if err != nil {
			return "", err
		}
		var wrapper struct {
			Site struct {
				CatchmentIDs []string `json:"catchmentIds"`
			} `json:"site"`
		}
		if err := json.Unmarshal([]byte(raw), &wrapper); err != nil {
			return "", err
		}
		if len(wrapper.Site.CatchmentIDs) == 0 {
			return "", fmt.Errorf("the %s tour document on this build carries no catchment ids, so there is "+
				"nothing to dissolve", t.title)
		}
		body, err := json.Marshal(map[string]any{"catchmentIds": wrapper.Site.CatchmentIDs})
		if err != nil {
			return "", err
		}
		return string(body), nil
	}
}
