package bench

import (
	_ "embed"
	"fmt"
	"html/template"
	"math"
	"os"
	"os/exec"
	"path/filepath"
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
	Warnings []string

	Broken      []string
	BrokenNames string

	Groups []reportGroup

	Iterations, Warmup int
	NoiseFloorPercent  int

	SponsorURL, RepoURL string
}

type reportGroup struct {
	Name   string
	Deltas []reportDelta
}

type reportDelta struct {
	Name, Why, Caveat string
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
		Headline:          c.Summarise(),
		Warnings:          c.Warnings,
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

	data.Lede = lede(c, data.Headline)

	// The widest median in the comparison sets the bar scale, so bars are
	// comparable within the report and never against some invented maximum.
	widest := 0.0
	for _, d := range c.Deltas {
		widest = math.Max(widest, math.Max(d.Baseline.TotalMs.P50, d.Current.TotalMs.P50))
	}

	byGroup := map[string]*reportGroup{}
	var order []string
	for _, d := range c.Deltas {
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

func renderDelta(d Delta, widest float64) reportDelta {
	r := reportDelta{
		Name:         d.Name,
		Why:          d.Why,
		Caveat:       d.Caveat,
		BeforeMs:     durationLabel(d.Baseline),
		AfterMs:      durationLabel(d.Current),
		VerdictLabel: verdictLabel(d),
		VerdictClass: string(d.Verdict),
		BytesLabel:   bytesLabel(d),
		ChangeLabel:  changeLabel(d),
	}

	switch d.Verdict {
	case Faster:
		r.BarClass = "faster"
	case Slower, Broken:
		r.BarClass = "slower"
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
		return "skipped"
	}
	if s.Samples == 0 {
		return "—"
	}
	return formatMs(s.TotalMs.P50)
}

// formatMs keeps the precision meaningful: sub-millisecond values need decimals,
// four-second ones do not, and reporting 4159.283 ms implies a resolution the
// measurement does not have.
func formatMs(ms float64) string {
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

func changeLabel(d Delta) string {
	switch d.Verdict {
	case Added:
		return "new"
	case Removed:
		return "gone"
	case Broken:
		return "—"
	}
	if d.Baseline.Samples == 0 || d.Current.Samples == 0 {
		return "—"
	}

	pct := d.RelativeChange * 100
	if math.Abs(pct) < 1 {
		return "±0%"
	}

	// A large improvement reads better as a multiple than as a percentage:
	// "53×" lands where "-98%" does not.
	speedup := d.Speedup()
	if speedup >= 2 {
		return fmt.Sprintf("%.1f× faster", speedup)
	}
	if speedup > 0 && speedup <= 0.5 {
		return fmt.Sprintf("%.1f× slower", 1/speedup)
	}
	return fmt.Sprintf("%+.0f%%", pct)
}

func bytesLabel(d Delta) string {
	if d.Current.BytesMax == 0 && d.Baseline.BytesMax == 0 {
		return "—"
	}
	cur := humanBytes(d.Current.BytesMax)
	if d.Baseline.BytesMax == d.Current.BytesMax || d.Baseline.BytesMax == 0 {
		return cur
	}
	return fmt.Sprintf("%s → %s", humanBytes(d.Baseline.BytesMax), cur)
}

func humanBytes(n int64) string {
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

func verdictLabel(d Delta) string {
	switch d.Verdict {
	case Faster:
		return "faster"
	case Slower:
		return "slower"
	case Unchanged:
		return "no change"
	case Broken:
		return "broken"
	case Added:
		return "new"
	case Removed:
		return "removed"
	}
	return string(d.Verdict)
}

// lede is the paragraph a reader sees first. It states what happened in plain
// terms, and refuses to lead with a win when something is broken.
func lede(c Comparison, h Headline) string {
	var b strings.Builder

	if h.Broken > 0 {
		fmt.Fprintf(&b, "%d scenario(s) stopped working between these two runs, which matters more than any "+
			"timing here. ", h.Broken)
	}

	measured := h.Faster + h.Slower + h.Unchanged
	fmt.Fprintf(&b, "Of %d scenarios measured, %d got faster, %d got slower and %d were unchanged. ",
		measured, h.Faster, h.Slower, h.Unchanged)

	if h.BiggestWin != nil {
		fmt.Fprintf(&b, "The largest improvement was %s (%s). ",
			h.BiggestWin.Name, changeLabel(*h.BiggestWin))
	}
	if h.BiggestRegression != nil {
		fmt.Fprintf(&b, "The largest regression was %s (%s). ",
			h.BiggestRegression.Name, changeLabel(*h.BiggestRegression))
	}

	if h.TotalBytesBaseline > 0 && h.TotalBytesCurrent != h.TotalBytesBaseline {
		fmt.Fprintf(&b, "One pass of the suite transferred %s, against %s before.",
			humanBytes(h.TotalBytesCurrent), humanBytes(h.TotalBytesBaseline))
	}

	return strings.TrimSpace(b.String())
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
