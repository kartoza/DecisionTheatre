package bench

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// renderFor renders a comparison and fails the test if it cannot, so every test
// below can work with the markup directly.
func renderFor(t *testing.T, c Comparison, opts ReportOptions) string {
	t.Helper()
	out, err := RenderHTML(c, opts)
	if err != nil {
		t.Fatalf("RenderHTML: %v", err)
	}
	if len(out) == 0 {
		t.Fatal("RenderHTML produced an empty document")
	}
	return string(out)
}

// A report must render from a normal comparison and be a complete document.
// Guards against a template change that produces something a browser will not
// print to PDF.
func TestAReportRendersAsACompleteDocument(t *testing.T) {
	c := Compare(runOf(measured("health", 2), measured("choropleth", 400)),
		runOf(measured("health", 2), measured("choropleth", 120)))

	html := renderFor(t, c, ReportOptions{Title: "Performance report", Subtitle: "before against after"})

	for _, want := range []string{"<!doctype html", "<html", "</html>", "<title>", "Performance report"} {
		if !strings.Contains(strings.ToLower(html), strings.ToLower(want)) {
			t.Errorf("report does not contain %q", want)
		}
	}
}

// Every Kartoza artefact carries the credit, donate and GitHub triplet, and the
// report is the artefact a client actually sees.
func TestAReportCarriesTheKartozaCreditTriplet(t *testing.T) {
	html := renderFor(t, Compare(runOf(measured("a", 10)), runOf(measured("a", 10))), ReportOptions{})

	for _, want := range []string{"Kartoza", "https://kartoza.com", SponsorURL, RepoURL, "Donate!", "GitHub"} {
		if !strings.Contains(html, want) {
			t.Errorf("report does not carry %q", want)
		}
	}
}

// A broken scenario must be named in the report, not merely counted. Guards
// against a reader seeing "1 broken" with no way to know which endpoint stopped
// working.
func TestAReportNamesTheScenariosThatStoppedWorking(t *testing.T) {
	broken := measured("catchment-identify", 0)
	broken.Samples = 0
	broken.Errors = 20
	broken.TotalMs = Stats{}

	c := Compare(runOf(measured("health", 2), measured("catchment-identify", 300)),
		runOf(measured("health", 2), broken))

	html := renderFor(t, c, ReportOptions{})

	if !strings.Contains(html, "catchment-identify") {
		t.Error("the broken scenario is not named in the report")
	}
	if !strings.Contains(html, "stopped working") {
		t.Error("the report does not say that a scenario stopped working")
	}
	if !strings.Contains(html, "broken") {
		t.Error("the report does not carry the broken verdict")
	}
}

// The lede must lead with the breakage rather than with a win. Guards against a
// report that opens "the largest improvement was X" while an endpoint is down.
func TestTheLedeRefusesToLeadWithAWinWhenSomethingIsBroken(t *testing.T) {
	broken := measured("catchment-identify", 0)
	broken.Samples = 0
	broken.Errors = 20
	broken.TotalMs = Stats{}

	c := Compare(runOf(measured("health", 400), measured("catchment-identify", 300)),
		runOf(measured("health", 20), broken))

	h := c.Summarise()
	got := lede(c, h)

	if !strings.HasPrefix(got, "1 scenario(s) stopped working") {
		t.Errorf("lede = %q, want it to open with the breakage", got)
	}
	improvement := strings.Index(got, "largest improvement")
	breakage := strings.Index(got, "stopped working")
	if improvement >= 0 && improvement < breakage {
		t.Errorf("lede leads with the win before the breakage: %q", got)
	}
}

// Caveats must survive into the markup. Guards against a report that shows a
// confident number while the reason to doubt it is dropped at render time.
func TestCaveatsSurviveIntoTheRenderedReport(t *testing.T) {
	base := spread(measured("choropleth", 100), 10, 400)
	cur := spread(measured("choropleth", 60), 10, 400)

	c := Compare(runOf(base), runOf(cur))
	if c.Deltas[0].Caveat == "" {
		t.Fatal("the fixture produced no caveat, so this test proves nothing")
	}

	html := renderFor(t, c, ReportOptions{})

	if !strings.Contains(html, "spreads overlap") {
		t.Error("the overlap caveat did not reach the report")
	}
}

// Warnings about mismatched runs must appear next to the numbers, which is the
// only place they can do their job.
func TestWarningsAppearInTheRenderedReport(t *testing.T) {
	base := runOf(measured("a", 10))
	cur := runOf(measured("a", 200))
	cur.TargetKind = "remote"
	cur.Target = "https://dt.kartoza.com"
	cur.Iterations = 5

	c := Compare(base, cur)
	html := renderFor(t, c, ReportOptions{})

	if !strings.Contains(html, "Read with care") {
		t.Error("the report has no warnings block")
	}
	for _, w := range c.Warnings {
		// The first few words are enough: html/template will have escaped the rest.
		fragment := strings.SplitN(w, ".", 2)[0]
		fragment = strings.SplitN(fragment, "(", 2)[0]
		if !strings.Contains(html, strings.TrimSpace(fragment)) {
			t.Errorf("warning %q did not reach the report", w)
		}
	}
}

// The numbers in the report must be the numbers in the comparison. Guards
// against a rendering layer that rounds, rescales or reorders its way into
// disagreeing with the data it was given — the failure that would make the
// report worse than useless.
func TestTheNumbersInTheReportAreTheNumbersInTheComparison(t *testing.T) {
	c := Compare(
		runOf(measured("health", 2.345), measured("choropleth", 412), measured("stats", 4159.283)),
		runOf(measured("health", 1.111), measured("choropleth", 98), measured("stats", 2010.5)))

	html := renderFor(t, c, ReportOptions{})

	for _, d := range c.Deltas {
		for what, want := range map[string]string{
			"before": formatMs(d.Baseline.TotalMs.P50),
			"after":  formatMs(d.Current.TotalMs.P50),
			"change": changeLabel(d),
		} {
			if !strings.Contains(html, want) {
				t.Errorf("scenario %s: %s value %q is not in the report", d.Name, what, want)
			}
		}
	}

	h := c.Summarise()
	if !strings.Contains(html, h.BiggestWin.Name) {
		t.Errorf("the biggest win %q is not named in the report", h.BiggestWin.Name)
	}
}

// Every scenario in the comparison must appear as a row. Guards against a group
// being dropped by the grouping logic, which would silently shorten the report.
func TestEveryScenarioInTheComparisonGetsARow(t *testing.T) {
	a := measured("alpha", 10)
	a.Group = "Baseline"
	b := measured("bravo", 20)
	b.Group = "Tiles"
	d := measured("charlie", 30)
	d.Group = "" // no group at all

	c := Compare(runOf(a, b, d), runOf(a, b, d))
	html := renderFor(t, c, ReportOptions{})

	for _, name := range []string{"alpha", "bravo", "charlie"} {
		if !strings.Contains(html, name) {
			t.Errorf("scenario %q has no row in the report", name)
		}
	}
	for _, group := range []string{"Baseline", "Tiles", "Other"} {
		if !strings.Contains(html, group) {
			t.Errorf("group %q is missing; an ungrouped scenario must still be filed somewhere", group)
		}
	}
}

// An empty comparison must still produce a readable document rather than a
// half-written page or an error. Guards against `dtbench report` on two
// interrupted runs producing something that cannot be sent to anyone.
func TestAnEmptyComparisonStillRendersAReadableReport(t *testing.T) {
	html := renderFor(t, Compare(Run{}, Run{}), ReportOptions{})

	if !strings.Contains(html, "</html>") {
		t.Error("the document is not complete")
	}
	if !strings.Contains(html, "Of 0 scenarios measured") {
		t.Error("the report does not state plainly that nothing was measured")
	}
}

// ---------------------------------------------------------------------------
// Escaping

// scriptTag finds an unescaped script element that the fixtures below inject.
// Matching the opening tag rather than the whole payload catches a partial
// escape as well as no escape at all.
var scriptTag = regexp.MustCompile(`(?i)<script[^>]*>alert`)

// Untrusted text must never become markup. A scenario name, a label, a target or
// a caveat all come from files on disk or from command-line flags, and a results
// file is exactly the kind of artefact that gets passed between people. A report
// that executes what is in it is a report that cannot be opened safely.
func TestUntrustedTextInAReportIsEscapedRatherThanRendered(t *testing.T) {
	payload := `<script>alert('xss')</script>`

	hostile := measured(payload, 100)
	hostile.Group = payload
	hostile.Why = payload

	base := runOf(hostile)
	base.Label = payload
	base.Target = "http://" + payload
	base.Host = payload

	after := hostile
	after.TotalMs.P50 = 400
	after.TotalMs.Min = 400
	after.TotalMs.Max = 400
	cur := runOf(after)
	cur.Label = payload
	cur.Target = "https://" + payload
	cur.Host = "elsewhere"
	cur.Iterations = 5

	c := Compare(base, cur)
	c.Warnings = append(c.Warnings, payload)

	html := renderFor(t, c, ReportOptions{Title: payload, Subtitle: payload})

	if scriptTag.MatchString(html) {
		t.Errorf("a <script> element from untrusted text survived into the report; "+
			"the document is executable. First occurrence near: %s", excerptAround(html, "<script>alert"))
	}
	if strings.Contains(html, "alert('xss')") && !strings.Contains(html, "alert(&#39;xss&#39;)") {
		t.Error("the payload appears unescaped in the report")
	}
	// The escaped form must be there: escaping is not the same as dropping the
	// text, and a scenario whose name is hostile still has to be identifiable.
	if !strings.Contains(html, "&lt;script&gt;") {
		t.Error("the hostile text was dropped rather than escaped, so the row cannot be identified")
	}
}

// The same, through the whole path a real invocation takes: a results file on
// disk carrying hostile text, loaded and rendered. Guards against escaping that
// works on a hand-built comparison and not on one that came off disk.
func TestHostileTextInAStoredResultsFileIsStillEscapedWhenRendered(t *testing.T) {
	dir := t.TempDir()

	payload := `"><script>alert(1)</script>`
	run := sampleRun()
	run.Label = payload
	run.Scenarios[0].Name = payload
	run.Scenarios[0].Why = payload

	path, err := run.Save(dir)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadRun(path)
	if err != nil {
		t.Fatal(err)
	}

	html := renderFor(t, Compare(loaded, loaded), ReportOptions{})

	if scriptTag.MatchString(html) {
		t.Errorf("a stored results file injected a script element into the report: %s",
			excerptAround(html, "<script>alert"))
	}
}

// The bar width is a CSS length built from a measurement. Guards against a
// number reaching the style attribute in a form that breaks out of it, and
// against a bar wider than its container.
func TestBarWidthsStayWithinTheirContainerAndInsideTheStyleAttribute(t *testing.T) {
	c := Compare(runOf(measured("tiny", 0.01), measured("huge", 14000)),
		runOf(measured("tiny", 0.01), measured("huge", 14000)))

	widest := 14000.0
	for _, d := range c.Deltas {
		r := renderDelta(d, widest)
		if r.BarWidth < 0 || r.BarWidth > 100 {
			t.Errorf("scenario %s has a bar width of %d%%", d.Name, r.BarWidth)
		}
		if d.Current.TotalMs.P50 > 0 && r.BarWidth < 1 {
			t.Errorf("scenario %s has a measurable time but an invisible bar", d.Name)
		}
	}

	html := renderFor(t, c, ReportOptions{})
	if regexp.MustCompile(`width:\s*(\d+)%`).FindString(html) == "" {
		t.Error("no bar width reached the markup")
	}
	for _, m := range regexp.MustCompile(`width:(\d+)%`).FindAllStringSubmatch(html, -1) {
		if len(m[1]) > 3 {
			t.Errorf("bar width %s%% is out of range", m[1])
		}
	}
}

// The brand mark is embedded as raw markup by design, because it is an SVG asset
// from the repository rather than user input. This test records that decision so
// that anybody who later points --mark at something untrusted finds it written
// down; see NOTES-qa.md.
func TestTheBrandMarkIsEmbeddedAsRawMarkupByDesign(t *testing.T) {
	dir := t.TempDir()
	mark := filepath.Join(dir, "mark.svg")
	if err := os.WriteFile(mark, []byte(`<svg id="kartoza-mark"><circle r="1"/></svg>`), 0o600); err != nil {
		t.Fatal(err)
	}

	html := renderFor(t, Compare(runOf(measured("a", 1)), runOf(measured("a", 1))),
		ReportOptions{MarkPath: mark})

	if !strings.Contains(html, `<svg id="kartoza-mark">`) {
		t.Error("the brand mark was not embedded, so the report is unbranded")
	}
}

// A missing brand mark must not fail the report. The palette and the type are
// most of the identity, and a report produced outside a checkout still has both.
func TestAMissingBrandMarkDoesNotFailTheReport(t *testing.T) {
	html := renderFor(t, Compare(runOf(measured("a", 1)), runOf(measured("a", 1))),
		ReportOptions{MarkPath: filepath.Join(t.TempDir(), "absent.svg")})

	if !strings.Contains(html, "</html>") {
		t.Error("a missing mark truncated the report")
	}
}

// A caller who supplies no title must still get one. Guards against a report
// whose browser tab and cover both read as empty.
func TestAReportWithNoTitleFallsBackToAUsableOne(t *testing.T) {
	html := renderFor(t, Compare(runOf(measured("a", 1)), runOf(measured("a", 1))), ReportOptions{})

	if !strings.Contains(html, "<title>Performance report</title>") {
		t.Error("a report with no title given has no usable title")
	}
}

// ---------------------------------------------------------------------------
// Number formatting

// Precision must match what the measurement can support. Guards against
// "4159.283 ms", which implies a resolution the tool does not have, and against
// "0 ms" for a sub-millisecond response.
func TestDurationsAreFormattedToThePrecisionTheMeasurementSupports(t *testing.T) {
	for in, want := range map[float64]string{
		0:        "—",
		0.114:    "0.11 ms",
		9.999:    "10.00 ms",
		10:       "10 ms",
		412.4:    "412 ms",
		999.4:    "999 ms",
		1000:     "1.00 s",
		4159.283: "4.16 s",
	} {
		if got := formatMs(in); got != want {
			t.Errorf("formatMs(%v) = %q, want %q", in, got, want)
		}
	}
}

// A large improvement reads better as a multiple than as a percentage, and a
// change under one percent must not be dressed up as a result.
func TestChangeLabelsReadTheWayAHumanWouldQuoteThem(t *testing.T) {
	for _, c := range []struct {
		name       string
		base, curr float64
		want       string
	}{
		{"a fifty-fold win reads as a multiple", 5000, 100, "50.0× faster"},
		{"a doubling reads as a multiple", 200, 100, "2.0× faster"},
		{"a halving reads as a multiple", 100, 200, "2.0× slower"},
		{"a modest change reads as a percentage", 100, 130, "+30%"},
		{"a modest win reads as a percentage", 100, 80, "-20%"},
		{"a change under one percent reads as none", 100, 100.5, "±0%"},
	} {
		t.Run(c.name, func(t *testing.T) {
			d := onlyDelta(t, Compare(runOf(measured("a", c.base)), runOf(measured("a", c.curr))))
			if got := changeLabel(d); got != c.want {
				t.Errorf("changeLabel = %q, want %q", got, c.want)
			}
		})
	}
}

// Added, removed and broken scenarios have no change to state, and must not
// borrow a number from the one side that has data.
func TestScenariosWithOnlyOneSideHaveNoChangeToState(t *testing.T) {
	for _, c := range []struct {
		verdict Verdict
		want    string
	}{
		{Added, "new"},
		{Removed, "gone"},
		{Broken, "—"},
	} {
		got := changeLabel(Delta{Verdict: c.verdict, Baseline: measured("a", 100), Current: measured("a", 1)})
		if got != c.want {
			t.Errorf("changeLabel for %q = %q, want %q", c.verdict, got, c.want)
		}
	}
}

// Byte figures must be readable and must show a change as a transition rather
// than only the current value.
func TestByteLabelsShowAChangeRatherThanOnlyTheCurrentValue(t *testing.T) {
	base := measured("a", 10)
	base.BytesMax = 14 * 1024 * 1024
	cur := measured("a", 10)
	cur.BytesMax = 512

	d := Delta{Baseline: base, Current: cur}
	if got, want := bytesLabel(d), "14.0 MB → 512 B"; got != want {
		t.Errorf("bytesLabel = %q, want %q", got, want)
	}

	same := Delta{Baseline: base, Current: base}
	if got, want := bytesLabel(same), "14.0 MB"; got != want {
		t.Errorf("bytesLabel with no change = %q, want %q", got, want)
	}

	none := Delta{}
	if got := bytesLabel(none); got != "—" {
		t.Errorf("bytesLabel with no bytes = %q, want an em dash", got)
	}
}

// Sizes must be rendered in units a reader can hold in their head, and a zero or
// negative size must never render as "0 B" or "-1 B".
func TestSizesAreRenderedInReadableUnits(t *testing.T) {
	for in, want := range map[int64]string{
		-1:                "—",
		0:                 "—",
		512:               "512 B",
		1024:              "1.0 KB",
		1536:              "1.5 KB",
		14 * 1024 * 1024:  "14.0 MB",
		1024 * 1024 * 100: "100.0 MB",
	} {
		if got := humanBytes(in); got != want {
			t.Errorf("humanBytes(%d) = %q, want %q", in, got, want)
		}
	}
}

// Every verdict must have a label a reader understands. Guards against a raw
// enum value appearing in a client-facing document.
func TestEveryVerdictHasAReadableLabel(t *testing.T) {
	for _, v := range []Verdict{Faster, Slower, Unchanged, Broken, Added, Removed} {
		got := verdictLabel(Delta{Verdict: v})
		if got == "" {
			t.Errorf("verdict %q has no label", v)
		}
	}
	if got := verdictLabel(Delta{Verdict: Unchanged}); got != "no change" {
		t.Errorf("unchanged label = %q, want the plainer phrasing", got)
	}
}

// A scenario that was skipped or never sampled must show a placeholder rather
// than a zero that reads as an instantaneous response.
func TestASkippedOrUnsampledScenarioShowsAPlaceholderRatherThanZero(t *testing.T) {
	skipped := ScenarioResult{Skipped: true}
	if got := durationLabel(skipped); got != "skipped" {
		t.Errorf("durationLabel for a skipped scenario = %q, want %q", got, "skipped")
	}
	if got := durationLabel(ScenarioResult{}); got != "—" {
		t.Errorf("durationLabel with no samples = %q, want an em dash", got)
	}
}

// excerptAround gives a short window of the document around a marker, so a
// failure message points at the problem instead of dumping the whole report.
func excerptAround(doc, marker string) string {
	i := strings.Index(doc, marker)
	if i < 0 {
		return "(marker not found)"
	}
	start := max(0, i-60)
	end := min(len(doc), i+120)
	return doc[start:end]
}
