package bench

import (
	_ "embed"
	"fmt"
	"html/template"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

//go:embed report.html.tmpl
var reportTemplate string

// SponsorURL and RepoURL appear in the footer. Every Kartoza artefact carries
// the credit, donate and GitHub triplet.
const (
	SponsorURL = "https://github.com/sponsors/kartoza"
	RepoURL    = "https://github.com/kartoza/DecisionTheatre"
)

// ReportOptions configure rendering.
type ReportOptions struct {
	Title    string
	Subtitle string

	// MarkPath is the Kartoza symbol. Optional: a report produced outside a
	// checkout still has the palette and the type, which is most of the identity.
	MarkPath string

	// Brand overrides the default palette. Zero value means DefaultBrand.
	Brand *Brand

	// Changes is what merged between the two builds. A comparison says a number
	// moved; this is the only part of the report that offers any account of why.
	// Zero value renders no section, which is correct when the caller had no
	// checkout to read.
	Changes Changes
}

// reportData is the shape the template consumes. It exists so the template can
// stay declarative: every judgement — what is a win, how wide a bar is, how a
// duration should read — is made here in Go where it can be tested.
type reportData struct {
	Title, Subtitle string
	Mark            template.HTML
	Brand           Brand

	BaselineLabel, CurrentLabel, TargetLabel, GeneratedAt string
	Lede                                                  string

	Headline Headline

	// Findings are the supporting numbers in structured form, so they can be
	// drawn rather than written. Value fits on a chart label; Detail fits on an
	// axis caption.
	Findings []reportFinding

	// Warnings are the conditions that change how the whole report should be
	// read. Each is one short sentence: a warning nobody finishes reading is not
	// a warning.
	Warnings []string

	// Method is the "how this was measured" footnote, one short line each,
	// replacing the prose that used to be hard-coded in the template.
	Method []string

	Broken      []string
	BrokenNames string

	// NotRun counts scenarios skipped in one or both runs. They are deliberately
	// absent from Headline, which counts only scenarios that produced timings; a
	// scenario that did not run is not evidence of "no change".
	NotRun      int
	NotRunNames string

	Groups []reportGroup

	Iterations, Warmup int
	NoiseFloorPercent  int

	SponsorURL, RepoURL string

	// Changes attributes the difference to work that landed. It is deliberately
	// last in the document: it narrows the search for a cause, and a reader who
	// meets it before the measurements may read a correlation as a cause.
	Changes Changes
}

// reportFinding is one supporting number, sized for a card or a chart
// annotation rather than for a paragraph.
type reportFinding struct {
	Label  string // "Data per pass"
	Value  string // "1.8 MB" — short enough to sit on a bar
	Detail string // "was 5.7 MB" — short enough to sit under it
	Tone   string // good | bad | flat | warn, matching the card classes
}

type reportGroup struct {
	Name   string
	Deltas []reportDelta
}

type reportDelta struct {
	Name, Why string

	// Caveat is at most a few words, for the row itself. CaveatLong is the full
	// explanation, for a footnote or a tooltip — available, but never occupying
	// four lines under every row it applies to.
	Caveat, CaveatLong string

	BeforeMs, AfterMs string
	ChangeLabel       string
	BarWidth          int
	BarClass          string
	BytesLabel        string
	VerdictLabel      string
	VerdictClass      string
}

// RenderHTML produces the report.
func RenderHTML(c Comparison, opts ReportOptions) ([]byte, error) {
	brand := DefaultBrand()
	if opts.Brand != nil {
		brand = *opts.Brand
	}

	data := reportData{
		Title:             orDefault(opts.Title, "Performance report"),
		Subtitle:          opts.Subtitle,
		Brand:             brand,
		BaselineLabel:     c.Baseline.Describe(),
		CurrentLabel:      c.Current.Describe(),
		TargetLabel:       c.Current.Target,
		GeneratedAt:       time.Now().Format("2006-01-02 15:04"),
		Warnings:          append([]string(nil), c.Warnings...),
		Iterations:        c.Current.Iterations,
		Warmup:            c.Current.Warmup,
		NoiseFloorPercent: int(NoiseFloor * 100),
		SponsorURL:        SponsorURL,
		RepoURL:           RepoURL,
	}

	if opts.MarkPath != "" {
		if svg, err := os.ReadFile(opts.MarkPath); err == nil {
			// The mark is a local brand asset, not user input.
			data.Mark = template.HTML(svg) //nolint:gosec
		}
	}

	// Headline is recounted here rather than taken from Compare. Two of the
	// report's obligations need it: a scenario that did not run is not evidence
	// of "no change", and a difference below what the measurement can resolve is
	// not a win. Both would otherwise be counted as findings on the cover.
	data.Headline, data.NotRun = headline(c)
	data.NotRunNames = truncateList(notRunNames(c), 4)
	var said ledeKind
	data.Lede, said = lede(c, data.Headline)
	data.Warnings = append(data.Warnings, framingWarnings(c, said)...)
	data.Findings = findings(c, data.Headline, data.NotRun)
	data.Method = method(c)
	data.Changes = opts.Changes

	// The widest median in the comparison sets the bar scale, so bars are
	// comparable within the report and never against some invented maximum.
	widest := 0.0
	for _, d := range c.Deltas {
		widest = math.Max(widest, math.Max(d.Baseline.TotalMs.P50, d.Current.TotalMs.P50))
	}

	byGroup := map[string]*reportGroup{}
	var order []string
	for _, d := range ordered(c.Deltas) {
		if d.Verdict == Broken {
			data.Broken = append(data.Broken, d.Name)
		}
		g, ok := byGroup[d.Group]
		if !ok {
			g = &reportGroup{Name: orDefault(d.Group, "Other")}
			byGroup[d.Group] = g
			order = append(order, d.Group)
		}
		g.Deltas = append(g.Deltas, renderDelta(d, widest))
	}
	data.BrokenNames = strings.Join(data.Broken, ", ")
	for _, name := range order {
		data.Groups = append(data.Groups, *byGroup[name])
	}
	data.Warnings = append(data.Warnings, spreadWarning(c)...)

	tmpl, err := template.New("report").Parse(reportTemplate)
	if err != nil {
		return nil, fmt.Errorf("parse report template: %w", err)
	}

	var out strings.Builder
	if err := tmpl.Execute(&out, data); err != nil {
		return nil, fmt.Errorf("render report: %w", err)
	}
	return []byte(out.String()), nil
}

// resolutionFloorMs is the smallest difference in median time this report is
// willing to describe as a change.
//
// A scenario that answers in 0.08 ms and later in 0.11 ms has not become "38%
// slower" in any sense a reader can act on: that is 30 microseconds, well inside
// the scheduler jitter of a laptop with a browser open, and the percentage only
// looks large because the base is tiny. Reporting it as a regression is how a
// benchmark suite spends its credibility.
//
// One millisecond is a deliberately blunt floor, chosen to match the honesty of
// the relative NoiseFloor rather than to be defensible statistically.
//
// This lives in the report rather than in the comparison because it is a
// question of what may be *said*, not of what was measured. When an absolute
// floor lands in Compare, this and the overrides that use it can go.
const resolutionFloorMs = 1.0

// belowResolution reports whether a timing difference is too small to describe.
func belowResolution(d Delta) bool {
	if d.Baseline.Samples == 0 || d.Current.Samples == 0 {
		return false
	}
	return math.Abs(d.AbsoluteChangeMs()) < resolutionFloorMs
}

// notRun reports whether a scenario was skipped on either side. Such a delta is
// not a result in either direction and must not be counted as one.
func notRun(d Delta) bool { return d.Baseline.Skipped || d.Current.Skipped }

// effectiveVerdict is the verdict the report will stand behind, which is the
// measured verdict softened where the report cannot honestly repeat it.
func effectiveVerdict(d Delta) Verdict {
	switch {
	case notRun(d):
		return Unchanged
	case (d.Verdict == Faster || d.Verdict == Slower) && belowResolution(d):
		return Unchanged
	}
	return d.Verdict
}

func renderDelta(d Delta, widest float64) reportDelta {
	verdict := effectiveVerdict(d)
	r := reportDelta{
		Name:         d.Name,
		Why:          d.Why,
		Caveat:       shortCaveat(d),
		CaveatLong:   d.Caveat,
		BeforeMs:     durationLabel(d.Baseline),
		AfterMs:      durationLabel(d.Current),
		VerdictLabel: verdictLabel(d),
		VerdictClass: string(verdict),
		BytesLabel:   bytesLabel(d),
		ChangeLabel:  changeLabel(d),
	}

	switch verdict {
	case Faster:
		r.BarClass = "faster"
	case Slower, Broken:
		r.BarClass = "slower"
	default:
		// Every other verdict draws an uncoloured bar on purpose. A trade or an
		// absent endpoint is not a win or a regression, and tinting it as one
		// would be the report answering a question it was careful not to answer.
	}

	if widest > 0 && d.Current.TotalMs.P50 > 0 {
		r.BarWidth = int(math.Round(d.Current.TotalMs.P50 / widest * 100))
		if r.BarWidth < 1 {
			r.BarWidth = 1
		}
	}
	return r
}

func durationLabel(s ScenarioResult) string {
	if s.Skipped {
		return "not run"
	}
	if s.Samples == 0 {
		return "—"
	}
	return FormatMs(s.TotalMs.P50)
}

// FormatMs keeps the precision meaningful: sub-millisecond values need decimals,
// four-second ones do not, and reporting 4159.283 ms implies a resolution the
// measurement does not have.
//
// Exported so the command line prints the same number the report does. Two
// spellings of one measurement is one spelling too many.
func FormatMs(ms float64) string {
	switch {
	case ms == 0:
		return "—"
	case ms < 10:
		return fmt.Sprintf("%.2f ms", ms)
	case ms < 1000:
		return fmt.Sprintf("%.0f ms", ms)
	default:
		return fmt.Sprintf("%.2f s", ms/1000)
	}
}

// changeLabel says how much the time moved, in words rather than in signs.
//
// "-28%" is read as a loss by anyone who has not been told the convention, and
// this report is written for people who have not. Direction is spelled out, and
// a large change is given as a multiple, because "53× faster" lands where
// "-98%" does not.
func changeLabel(d Delta) string {
	switch d.Verdict {
	case Added:
		return "first result"
	case Removed:
		return "—"
	case Broken:
		return "—"
	default:
		// Everything else has a number worth quoting; fall through to it.
	}
	if d.Baseline.Samples == 0 || d.Current.Samples == 0 {
		return "—"
	}
	if notRun(d) {
		return "—"
	}

	// Below the floor there is a number, and quoting it would give it a standing
	// it has not earned. Say how small it is instead. Spelled out rather than
	// formatted, because "under 1.00 ms" implies a precision the floor does not
	// have and is two characters wider on a chart label.
	if belowResolution(d) {
		return "under 1 ms"
	}

	pct := d.RelativeChange * 100
	if math.Abs(pct) < 1 {
		return "no change"
	}

	speedup := d.Speedup()
	if speedup >= 2 {
		return fmt.Sprintf("%.1f× faster", speedup)
	}
	if speedup > 0 && speedup <= 0.5 {
		return fmt.Sprintf("%.1f× slower", 1/speedup)
	}
	if pct < 0 {
		return fmt.Sprintf("%.0f%% faster", -pct)
	}
	return fmt.Sprintf("%.0f%% slower", pct)
}

// bytesLabel gives the response size, and its change when there is one to show.
//
// Two sizes are only shown as a transition when they read differently: "1.7 MB
// → 1.7 MB" is a rounding artefact presented as a finding, and a reader who
// notices it stops trusting the rest of the column.
func bytesLabel(d Delta) string {
	if d.Current.BytesMax == 0 && d.Baseline.BytesMax == 0 {
		return "—"
	}
	cur := HumanBytes(d.Current.BytesMax)
	if d.Baseline.BytesMax == 0 || d.Current.BytesMax == 0 {
		return cur
	}
	before := HumanBytes(d.Baseline.BytesMax)
	if before == cur {
		return cur
	}
	return fmt.Sprintf("%s → %s", before, cur)
}

// HumanBytes renders a byte count for a reader rather than for a machine.
// Exported so the command line and the report agree.
func HumanBytes(n int64) string {
	switch {
	case n <= 0:
		return "—"
	case n < 1024:
		return fmt.Sprintf("%d B", n)
	case n < 1024*1024:
		return fmt.Sprintf("%.1f KB", float64(n)/1024)
	default:
		return fmt.Sprintf("%.1f MB", float64(n)/(1024*1024))
	}
}

// verdictLabel says whether the number beside it counts. It answers that and
// nothing else, so it never repeats the change label, and every value is short
// enough to sit on a bar or an axis without wrapping.
//
// The pair of columns carries more than either alone. "6% slower / no change"
// is a difference that was measured and is inside the noise; "under 1 ms / no
// change" is a difference too small for this tool to resolve at all. Both are
// honest, both are short, and a reader can tell them apart.
func verdictLabel(d Delta) string {
	if notRun(d) {
		return "not run"
	}
	switch effectiveVerdict(d) {
	case Faster:
		return "faster"
	case Slower:
		return "slower"
	case Unchanged:
		return "no change"
	case Broken:
		return "stopped working"
	case Added:
		return "not in baseline"
	case Removed:
		return "not in this build"
	default:
		return string(d.Verdict)
	}
}

// lede is the one sentence a client reads before deciding whether to read
// anything else. It is held to two sentences and about thirty words.
//
// Three rules survive the length budget, because they are the difference
// between a report and an advertisement:
//
//   - It leads with whatever actually moved. Counting faster and slower first
//     presumes the story is latency; when the payloads changed by multiples and
//     the times did not, "3 faster, 7 slower" is not a summary, it is a wrong
//     answer.
//   - It will not lead with a win when something is broken, or when both runs
//     measured the same build and there is nothing to attribute.
//   - Short is not the same as vague. "Not present in this build" is four words
//     and complete; "roughly comparable" is two words and says nothing.
//
// Everything that used to pad this out is now in Findings and Method, where a
// designer can hang it on a chart instead of on a paragraph. The count of
// scenarios that did not run is one of those: important, and not important
// enough to spend a quarter of the opening sentence on.
func lede(c Comparison, h Headline) (text string, said ledeKind) {
	if same, what := sameBuild(c); same {
		return fmt.Sprintf("Both runs measured build %s, so every difference below is measurement noise "+
			"rather than a change in the code.", what), ledeSameBuild
	}

	if h.Broken > 0 {
		return fmt.Sprintf("%s stopped working between these runs, and the timings exclude them: "+
			"a request that fails returns sooner than one that succeeds.",
			countOf(h.Broken, "scenario", "scenarios")), ledeBroken
	}

	size := biggestSizeChange(c)
	totalMoved := h.TotalBytesBaseline > 0 && h.TotalBytesCurrent > 0 &&
		HumanBytes(h.TotalBytesBaseline) != HumanBytes(h.TotalBytesCurrent)
	timeMoved := h.Faster+h.Slower > 0

	// The payload is the finding when the sizes moved and the times did not.
	if !timeMoved && (totalMoved || size != nil) {
		lead := "The change here is in how much data the API sends, not in how long it takes."
		if totalMoved {
			lead = fmt.Sprintf("One pass of the suite now moves %s, down from %s%s.",
				HumanBytes(h.TotalBytesCurrent), HumanBytes(h.TotalBytesBaseline),
				multipleSuffix(h.TotalBytesBaseline, h.TotalBytesCurrent))
		}
		return lead + " No time changed by more than this suite can separate from noise.", ledeSize
	}

	switch {
	case h.Faster+h.Slower+h.Unchanged == 0:
		return "No scenario produced comparable timings in both runs.", ledeNothing
	case !timeMoved:
		return fmt.Sprintf("None of the %d scenarios measured changed by more than this suite can separate "+
			"from noise.", h.Faster+h.Slower+h.Unchanged), ledeNothing
	}

	var b strings.Builder
	fmt.Fprintf(&b, "%d of %d scenarios got faster and %d got slower.",
		h.Faster, h.Faster+h.Slower+h.Unchanged, h.Slower)
	if biggest := largestTimeChange(h); biggest != nil {
		fmt.Fprintf(&b, " The largest change is %s, %s.", biggest.Name, changeLabel(*biggest))
	}
	return b.String(), ledeTime
}

// ledeKind records which sentence the lede chose, so the rest of the report can
// avoid saying the same thing twice. A warning band that repeats the opening
// line teaches a reader to skip the warning band.
type ledeKind int

const (
	ledeTime ledeKind = iota
	ledeSize
	ledeSameBuild
	ledeBroken
	ledeNothing
)

// largestTimeChange is whichever extreme is larger, so the lede names one thing
// rather than two.
func largestTimeChange(h Headline) *Delta {
	switch {
	case h.BiggestWin == nil:
		return h.BiggestRegression
	case h.BiggestRegression == nil:
		return h.BiggestWin
	case -h.BiggestWin.RelativeChange >= h.BiggestRegression.RelativeChange:
		return h.BiggestWin
	default:
		return h.BiggestRegression
	}
}

// multipleSuffix adds " — 3.2× less" when the multiple is worth stating, and
// nothing when it is not.
func multipleSuffix(before, after int64) string {
	m := ratio(before, after)
	switch {
	case m >= 1.15:
		return fmt.Sprintf(" — %.1f× less", m)
	case m > 0 && m <= 0.87:
		return fmt.Sprintf(" — %.1f× more", 1/m)
	}
	return ""
}

// findings are the supporting numbers, structured rather than written out, so
// they can sit on a card, an axis or a bar instead of in a paragraph.
//
// Value is short enough to be a chart label; Detail is short enough to be an
// axis caption. Neither is a sentence.
func findings(c Comparison, h Headline, notRunCount int) []reportFinding {
	var out []reportFinding

	if h.TotalBytesBaseline > 0 && h.TotalBytesCurrent > 0 {
		f := reportFinding{Label: "Data per pass", Value: HumanBytes(h.TotalBytesCurrent), Tone: "flat"}
		if HumanBytes(h.TotalBytesBaseline) != HumanBytes(h.TotalBytesCurrent) {
			f.Detail = "was " + HumanBytes(h.TotalBytesBaseline)
			if h.TotalBytesCurrent < h.TotalBytesBaseline {
				f.Tone = "good"
			} else {
				f.Tone = "bad"
			}
		}
		out = append(out, f)
	}

	if d := biggestSizeChange(c); d != nil {
		m := ratio(d.Baseline.BytesMax, d.Current.BytesMax)
		word, tone := "smaller", "good"
		if m < 1 {
			m, word, tone = 1/m, "larger", "bad"
		}
		out = append(out, reportFinding{
			Label: "Largest payload change",
			Value: fmt.Sprintf("%.1f× %s", m, word),
			Detail: fmt.Sprintf("%s · %s → %s", d.Name,
				HumanBytes(d.Baseline.BytesMax), HumanBytes(d.Current.BytesMax)),
			Tone: tone,
		})
	}

	if d := largestTimeChange(h); d != nil {
		tone := "good"
		if effectiveVerdict(*d) == Slower {
			tone = "bad"
		}
		out = append(out, reportFinding{
			Label:  "Largest time change",
			Value:  changeLabel(*d),
			Detail: fmt.Sprintf("%s · %s → %s", d.Name, durationLabel(d.Baseline), durationLabel(d.Current)),
			Tone:   tone,
		})
	}

	if notRunCount > 0 {
		out = append(out, reportFinding{
			Label: "Not run", Value: fmt.Sprint(notRunCount),
			Detail: truncateList(notRunNames(c), 3), Tone: "warn",
		})
	}

	return out
}

// method replaces two paragraphs of prose with four lines a reader can skim, or
// a designer can set as a compact footnote under a chart.
func method(c Comparison) []string {
	return []string{
		fmt.Sprintf("%d samples per scenario, %d warmup requests discarded, one request at a time.",
			c.Current.Iterations, c.Current.Warmup),
		"Times are medians: half the requests were quicker, half slower.",
		fmt.Sprintf("Changes under %d%% or under 1 ms are reported as no change.",
			int(NoiseFloor*100)),
		"Sizes are bytes on the wire, with compression negotiated as a browser would.",
	}
}

// truncateList keeps a list of names short enough to sit under a number.
func truncateList(names []string, limit int) string {
	if len(names) <= limit {
		return strings.Join(names, ", ")
	}
	return fmt.Sprintf("%s and %d more", strings.Join(names[:limit], ", "), len(names)-limit)
}

// biggestSizeChange finds the delta whose response size moved most, as a
// multiple.
//
// Only scenarios that succeeded on both sides are eligible. An endpoint that
// answered with a 16-byte fallback page because it does not exist on one build
// is a 4000× "improvement" in size, and quoting it would be the most misleading
// sentence in the report.
func biggestSizeChange(c Comparison) *Delta {
	const worthSaying = 1.5

	var best *Delta
	bestScore := worthSaying
	for i := range c.Deltas {
		d := &c.Deltas[i]
		if notRun(*d) || d.Verdict == Broken || d.Verdict == Added || d.Verdict == Removed {
			continue
		}
		if d.Baseline.BytesMax <= 0 || d.Current.BytesMax <= 0 {
			continue
		}
		m := ratio(d.Baseline.BytesMax, d.Current.BytesMax)
		score := math.Max(m, 1/m)
		if score > bestScore {
			best, bestScore = d, score
		}
	}
	return best
}

// ratio is before/after, so a number above 1 means "smaller now".
func ratio(before, after int64) float64 {
	if before <= 0 || after <= 0 {
		return 0
	}
	return float64(before) / float64(after)
}

// sameBuild reports whether both runs measured the same binary, and what to
// call it.
//
// This is the comparison most likely to be run by mistake — two measurements of
// whatever happened to be running — and the one whose output looks most like a
// finding. Saying so is the difference between a report and a horoscope.
func sameBuild(c Comparison) (bool, string) {
	b, cur := c.Baseline, c.Current
	if b.Commit != "" && b.Commit == cur.Commit {
		return true, shortCommit(b.Commit)
	}
	if b.Commit == "" && cur.Commit == "" && b.ServerVersion != "" && b.ServerVersion == cur.ServerVersion {
		return true, b.ServerVersion
	}
	return false, ""
}

// framingWarnings are the conditions the report itself must disclose, as
// distinct from the ones the comparison found.
func framingWarnings(c Comparison, said ledeKind) []string {
	var out []string
	if same, what := sameBuild(c); same && said != ledeSameBuild {
		out = append(out, fmt.Sprintf(
			"Both runs measured build %s: the differences below are noise, not code.", what))
	}

	// Whatever each run recorded about itself — an interrupted suite, a target
	// that could not name its build — belongs next to the numbers. It was
	// written down at measurement time precisely so that a later reader would
	// see it, and a report that keeps it in the JSON has not delivered it.
	for _, side := range []struct {
		who string
		run Run
	}{{"Baseline", c.Baseline}, {"Current", c.Current}} {
		for _, note := range side.run.Notes {
			out = append(out, side.who+": "+note)
		}
	}
	return out
}

// ReportHeadline is headline, exported so the command line can print the same
// counts the report does. A tool that says "3 faster" on the terminal and "0
// faster" in the PDF has taught the reader not to trust either.
func ReportHeadline(c Comparison) (counts Headline, notRun int) { return headline(c) }

// ChangeLabel is changeLabel, exported for the same reason: one set of words
// for one measurement.
func ChangeLabel(d Delta) string { return changeLabel(d) }

// VerdictLabel is verdictLabel, exported for the same reason.
func VerdictLabel(d Delta) string { return verdictLabel(d) }

// headline recounts the comparison in the terms the report will stand behind,
// and returns the number of scenarios that did not run.
//
// Compare counts a skipped scenario as unchanged, which is defensible for a
// scoreboard and wrong for a cover: "12 unchanged" invites a reader to conclude
// that twelve things were checked and found the same.
func headline(c Comparison) (Headline, int) {
	var h Headline
	var skipped int

	for i := range c.Deltas {
		d := &c.Deltas[i]
		if notRun(*d) {
			skipped++
			continue
		}
		switch effectiveVerdict(*d) {
		case Faster:
			h.Faster++
			if h.BiggestWin == nil || d.RelativeChange < h.BiggestWin.RelativeChange {
				h.BiggestWin = d
			}
		case Slower:
			h.Slower++
			if h.BiggestRegression == nil || d.RelativeChange > h.BiggestRegression.RelativeChange {
				h.BiggestRegression = d
			}
		case Unchanged:
			h.Unchanged++
		case Broken:
			h.Broken++
		case Added:
			h.Added++
		case Removed:
			h.Removed++
		case Traded:
			h.Traded++
		case Absent:
			h.Absent++
		}
		h.TotalBytesBaseline += d.Baseline.BytesMax
		h.TotalBytesCurrent += d.Current.BytesMax
	}
	return h, skipped
}

func notRunNames(c Comparison) []string {
	var names []string
	for i := range c.Deltas {
		if notRun(c.Deltas[i]) {
			names = append(names, c.Deltas[i].Name)
		}
	}
	sort.Strings(names)
	return names
}

// ordered puts the deltas back into the order the suite declares them in.
//
// Compare sorts alphabetically, which puts Baseline before Choropleth before
// Metadata for no reason a reader can see. Scenarios() states an order —
// groundwork first, then what is built on it — and that is the order a reader
// should meet them in.
func ordered(deltas []Delta) []Delta {
	rank := map[string]int{}
	for i, s := range Scenarios() {
		rank[s.Name] = i
	}
	// A scenario no longer in the suite still has to appear; it goes last, in a
	// stable order, rather than being silently dropped or wedged in arbitrarily.
	place := func(d Delta) int {
		if r, ok := rank[d.Name]; ok {
			return r
		}
		return len(rank)
	}

	out := append([]Delta(nil), deltas...)
	sort.SliceStable(out, func(i, j int) bool {
		pi, pj := place(out[i]), place(out[j])
		if pi != pj {
			return pi < pj
		}
		return out[i].Name < out[j].Name
	})
	return out
}

// shortCaveat is the row's own warning, in at most a handful of words.
//
// The full sentence the comparison produces is correct and far too long to
// repeat under every row it applies to: forty words on six consecutive rows is
// not caution, it is wallpaper, and it is skipped exactly like wallpaper. The
// short form goes inline and the long form goes in CaveatLong.
//
// It is derived from the measurements rather than from the comparison's wording,
// so rephrasing that sentence cannot silently empty this one.
func shortCaveat(d Delta) string {
	base, cur := d.Baseline, d.Current

	switch {
	case notRun(d):
		return "" // The verdict column already says "not run".

	case cur.Samples == 0 && base.Samples == 0:
		return "no samples either run"
	case cur.Samples == 0:
		return "every request failed"
	case base.Samples == 0:
		return "no baseline to compare"
	case cur.Errors > 0 && base.Errors == 0:
		return fmt.Sprintf("%d of %d requests failed", cur.Errors, cur.Errors+cur.Samples)
	}

	if effectiveVerdict(d) == Unchanged && math.Abs(d.BytesChange) >= NoiseFloor {
		return "size moved, time did not"
	}
	// The overlap check this used to call was replaced by the rank-sum test, so
	// the hedge now comes from what the test could establish rather than from
	// comparing two medians against two ranges. A verdict the test could not
	// reach is still worth flagging; one it confirmed no longer needs hedging.
	if effectiveVerdict(d) != Unchanged && !d.Test.Possible {
		return "no rank-sum test"
	}
	if effectiveVerdict(d) != Unchanged && d.Test.Possible && !d.Test.Significant {
		return "not separated"
	}
	return ""
}

// spreadWarning explains "spreads overlap" once, for however many rows carry it.
func spreadWarning(c Comparison) []string {
	var affected []string
	for _, d := range c.Deltas {
		if shortCaveat(d) == "spreads overlap" {
			affected = append(affected, d.Name)
		}
	}
	if len(affected) == 0 {
		return nil
	}
	sort.Strings(affected)
	return []string{fmt.Sprintf(
		"\u201cSpreads overlap\u201d means the medians differ but individual samples do not separate cleanly: "+
			"treat the direction as indicative and rerun if it matters. Affects %s.",
		truncateList(affected, 6))}
}

// countOf renders "1 scenario" / "3 scenarios" rather than "1 scenario(s)".
func countOf(n int, singular, plural string) string {
	if n == 1 {
		return "1 " + singular
	}
	return fmt.Sprintf("%d %s", n, plural)
}

func orDefault(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

// WritePDF prints an HTML report to PDF using a headless Chromium.
//
// Chromium rather than a Go PDF library, deliberately: a library would mean a new
// module, which means go.mod, go.sum and the flake's vendorHash all move and the
// lock-step check fails — a large cost for a report generator. Chromium is
// already present for the desktop build, and it renders the same CSS the
// documentation uses.
//
// A missing browser is not an error. The HTML is the artefact; the PDF is a
// convenience, and failing the whole run because a browser is absent would be
// disproportionate.
func WritePDF(htmlPath, pdfPath string) error {
	browser := findBrowser()
	if browser == "" {
		return fmt.Errorf("no chromium or chrome on PATH")
	}

	abs, err := filepath.Abs(htmlPath)
	if err != nil {
		return err
	}

	profile, err := os.MkdirTemp("", "dtbench-chrome-")
	if err != nil {
		return fmt.Errorf("create browser profile: %w", err)
	}
	defer func() { _ = os.RemoveAll(profile) }()

	cmd := exec.Command(browser,
		"--headless",
		"--disable-gpu",
		"--no-sandbox",
		"--user-data-dir="+profile,
		"--no-pdf-header-footer",
		"--print-to-pdf="+pdfPath,
		"file://"+abs,
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("print to pdf: %w: %s", err, strings.TrimSpace(string(out)))
	}
	if _, err := os.Stat(pdfPath); err != nil {
		return fmt.Errorf("the browser reported success but wrote no PDF")
	}
	return nil
}

func findBrowser() string {
	for _, name := range []string{"chromium", "chromium-browser", "google-chrome", "google-chrome-stable"} {
		if path, err := exec.LookPath(name); err == nil {
			return path
		}
	}
	return ""
}
