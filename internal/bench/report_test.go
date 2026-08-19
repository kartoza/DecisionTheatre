package bench

import (
	"strings"
	"testing"
	"time"
)

// These tests are about wording rather than arithmetic. Every one of them
// encodes a sentence the report must not produce, drawn from a real comparison
// where it did: a 0.03 ms difference called a win, a size drop of 5.7 MB to
// 1.8 MB buried under a count of verdicts, two runs of the same binary reported
// as a week's progress.

func scenario(name, group string, p50, spread float64, bytes int64) ScenarioResult {
	return ScenarioResult{
		Name: name, Group: group, Samples: 20,
		TotalMs:  Stats{N: 20, Min: p50 - spread, P50: p50, P90: p50 + spread, Max: p50 + spread},
		BytesMin: bytes, BytesMax: bytes,
	}
}

func run(label string, version string, scenarios ...ScenarioResult) Run {
	return Run{
		SchemaVersion: ResultsVersion, Label: label, Target: "http://127.0.0.1:8080",
		TargetKind: "local", ServerVersion: version, Iterations: 20, Warmup: 3,
		StartedAt: time.Date(2026, 8, 14, 9, 0, 0, 0, time.UTC), Scenarios: scenarios,
	}
}

func renderFor(t *testing.T, c Comparison) string {
	t.Helper()
	html, err := RenderHTML(c, ReportOptions{Title: "t"})
	if err != nil {
		t.Fatalf("RenderHTML: %v", err)
	}
	return string(html)
}

// The finding in the coordinator's real comparison was that payloads shrank by
// multiples while times did not move. A lede that opens with a count of
// faster/slower verdicts answers a question nobody asked.
func TestLedeLeadsWithSizeWhenOnlySizeMoved(t *testing.T) {
	base := run("14 aug", "0.3.0",
		scenario("choropleth-viewport", "Choropleth", 18, 1, 179*1024),
		scenario("choropleth-domain-aggregated", "Choropleth", 4300, 50, 5500*1024))
	cur := run("today", "0.4.0",
		scenario("choropleth-viewport", "Choropleth", 18, 1, 36*1024),
		scenario("choropleth-domain-aggregated", "Choropleth", 4300, 50, 1700*1024))

	text, kind := lede(Compare(base, cur), mustHeadline(Compare(base, cur)))
	if kind != ledeSize {
		t.Fatalf("expected the size branch, got kind %v: %s", kind, text)
	}
	for _, want := range []string{"1.7 MB", "5.5 MB", "×"} {
		if !strings.Contains(text, want) {
			t.Errorf("lede should quote %q; got: %s", want, text)
		}
	}
	if words := len(strings.Fields(text)); words > 35 {
		t.Errorf("lede is %d words; the budget is about 30: %s", words, text)
	}
}

// Two measurements of the same binary is the comparison most likely to be run
// by accident and the one whose output looks most like a finding.
func TestLedeSaysWhenBothRunsAreTheSameBuild(t *testing.T) {
	base := run("a", "0.4.0-211-g7fb8f6b", scenario("health", "Baseline", 0.08, 0.01, 16))
	cur := run("b", "0.4.0-211-g7fb8f6b", scenario("health", "Baseline", 0.11, 0.01, 16))

	c := Compare(base, cur)
	text, kind := lede(c, mustHeadline(c))
	if kind != ledeSameBuild {
		t.Fatalf("expected the same-build branch, got: %s", text)
	}
	if !strings.Contains(text, "noise") {
		t.Errorf("a same-build comparison must say the differences are noise; got: %s", text)
	}

	// And it must not then repeat itself in the warning band.
	html := renderFor(t, c)
	if strings.Count(html, "0.4.0-211-g7fb8f6b, so every difference") != 1 {
		t.Error("the same-build sentence should appear once, in the lede")
	}
}

// 0.08 ms to 0.11 ms is 38% and thirty microseconds. Only one of those is worth
// printing.
func TestSubMillisecondDifferencesAreNotVerdicts(t *testing.T) {
	base := run("a", "0.3.0", scenario("health", "Baseline", 0.08, 0.005, 16))
	cur := run("b", "0.4.0", scenario("health", "Baseline", 0.11, 0.005, 16))
	c := Compare(base, cur)

	if got := c.Deltas[0].Verdict; got != Slower {
		t.Fatalf("precondition: the comparison should still call this %q, got %q", Slower, got)
	}
	if got := effectiveVerdict(c.Deltas[0]); got != Unchanged {
		t.Errorf("the report should not stand behind that verdict; got %q", got)
	}
	if got := changeLabel(c.Deltas[0]); got != "under 1 ms" {
		t.Errorf("change label = %q, want %q", got, "under 1 ms")
	}
	if got := verdictLabel(c.Deltas[0]); got != "no change" {
		t.Errorf("verdict label = %q, want %q", got, "no change")
	}

	h, _ := headline(c)
	if h.Slower != 0 || h.Unchanged != 1 {
		t.Errorf("headline counted it as a regression: %+v", h)
	}
	if h.BiggestRegression != nil {
		t.Error("a 30 microsecond difference must never be named as the biggest regression")
	}
}

// A skipped scenario is not evidence of "no change", and counting it as one
// invites a reader to conclude that it was checked.
func TestSkippedScenariosAreNotCountedAsUnchanged(t *testing.T) {
	skipped := ScenarioResult{Name: "choropleth-full-domain-values", Group: "Statistics",
		Skipped: true, SkippedReason: "heavy scenario; run with --heavy to include it"}

	base := run("a", "0.3.0", scenario("health", "Baseline", 5, 1, 16), skipped)
	cur := run("b", "0.4.0", scenario("health", "Baseline", 5, 1, 16), skipped)
	c := Compare(base, cur)

	h, notRun := headline(c)
	if notRun != 1 {
		t.Errorf("not-run count = %d, want 1", notRun)
	}
	if h.Unchanged != 1 {
		t.Errorf("unchanged = %d, want 1 (the skipped one must not be in here)", h.Unchanged)
	}
	if got := verdictLabel(c.Deltas[1]); got != "not run" {
		t.Errorf("verdict label for a skipped scenario = %q, want %q", got, "not run")
	}
	if got := durationLabel(skipped); got != "not run" {
		t.Errorf("duration label = %q, want %q", got, "not run")
	}
}

func TestChangeLabelSpellsOutDirection(t *testing.T) {
	cases := []struct {
		name            string
		beforeMs, after float64
		want            string
	}{
		{"large improvement reads as a multiple", 5300, 100, "53.0× faster"},
		{"moderate improvement reads as a percentage", 100, 72, "28% faster"},
		{"regression says slower, not plus", 100, 133, "33% slower"},
		{"large regression reads as a multiple", 100, 300, "3.0× slower"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			base := run("a", "0.3.0", scenario("s", "g", tc.beforeMs, 0.1, 100))
			cur := run("b", "0.4.0", scenario("s", "g", tc.after, 0.1, 100))
			got := changeLabel(Compare(base, cur).Deltas[0])
			if got != tc.want {
				t.Errorf("changeLabel = %q, want %q", got, tc.want)
			}
			if strings.ContainsAny(got, "+") {
				t.Errorf("changeLabel %q uses a sign; the audience reads signs as losses", got)
			}
		})
	}
}

// "1.7 MB → 1.7 MB" is a rounding artefact presented as a change, and a reader
// who spots one stops believing the column.
func TestBytesLabelDoesNotShowAChangeThatIsNotVisible(t *testing.T) {
	base := run("a", "0.3.0", scenario("s", "g", 10, 1, 1_800_000))
	cur := run("b", "0.4.0", scenario("s", "g", 10, 1, 1_800_100))
	if got := bytesLabel(Compare(base, cur).Deltas[0]); strings.Contains(got, "→") {
		t.Errorf("bytesLabel = %q; both sides render identically, so there is nothing to show", got)
	}
}

// The suite declares an order — groundwork first, then what is built on it —
// and the comparison sorts it alphabetically. The report puts it back.
func TestDeltasFollowTheDeclaredScenarioOrder(t *testing.T) {
	base := run("a", "0.3.0",
		scenario("tilejson", "Tiles", 1, 0.1, 10),
		scenario("health", "Baseline", 1, 0.1, 10),
		scenario("columns", "Metadata", 1, 0.1, 10))
	cur := base
	cur.Label = "b"

	got := ordered(Compare(base, cur).Deltas)
	want := []string{"health", "columns", "tilejson"}
	for i, name := range want {
		if got[i].Name != name {
			t.Fatalf("order = %s, want %s", names(got), strings.Join(want, ", "))
		}
	}
}

// Caveats have to be short enough to sit inline without becoming wallpaper, and
// specific enough to still mean something.
func TestShortCaveatsStayShort(t *testing.T) {
	broken := scenario("s", "g", 10, 1, 100)
	broken.Samples, broken.Errors = 0, 20

	base := run("a", "0.3.0", scenario("s", "g", 10, 1, 100))
	cur := run("b", "0.4.0", broken)

	got := shortCaveat(Compare(base, cur).Deltas[0])
	if got != "every request failed" {
		t.Errorf("shortCaveat = %q", got)
	}
	if words := len(strings.Fields(got)); words > 5 {
		t.Errorf("shortCaveat is %d words; it has to fit on a row", words)
	}
}

func TestFindingsCarryTheSupportingNumbers(t *testing.T) {
	base := run("a", "0.3.0", scenario("choropleth-viewport", "Choropleth", 18, 1, 179*1024))
	cur := run("b", "0.4.0", scenario("choropleth-viewport", "Choropleth", 18, 1, 36*1024))
	c := Compare(base, cur)
	h, notRun := headline(c)

	found := findings(c, h, notRun)
	if len(found) == 0 {
		t.Fatal("expected findings")
	}
	for _, f := range found {
		if len(strings.Fields(f.Value)) > 3 {
			t.Errorf("finding value %q is too long to sit on a chart label", f.Value)
		}
	}
}

func mustHeadline(c Comparison) Headline {
	h, _ := headline(c)
	return h
}

func names(deltas []Delta) string {
	var out []string
	for _, d := range deltas {
		out = append(out, d.Name)
	}
	return strings.Join(out, ", ")
}
