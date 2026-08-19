// Command dtbench measures the Decision Theatre HTTP API and compares one
// measurement against another.
//
//	dtbench run     --target http://127.0.0.1:8080 --label before
//	dtbench sweep   --from <rev> --data-dir ./data
//	dtbench report  --baseline <file> --current <file> --out report.html --pdf
//	dtbench list
//
// Results are JSON files under --results (default ./benchmarks/results). They are
// the point of the tool: a comparison against last month is only possible if last
// month's file is still readable, so the schema is versioned and the reader
// tolerates older versions.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/kartoza/decision-theatre/internal/bench"
)

const defaultResults = "benchmarks/results"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}

	// Ctrl-C should stop between requests and still write what it has, rather
	// than losing a sweep that has been running for half an hour.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	var err error
	switch os.Args[1] {
	case "run":
		err = cmdRun(ctx, os.Args[2:])
	case "sweep":
		err = cmdSweep(ctx, os.Args[2:])
	case "report":
		err = cmdReport(os.Args[2:])
	case "list":
		err = cmdList(os.Args[2:])
	case "-h", "--help", "help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "\nerror: %v\n", err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprint(os.Stderr, `dtbench — measure the Decision Theatre API and compare runs

  run      measure one target and save the result
  sweep    build each revision in a range, measure it, save the results
  report   render a branded HTML (and optionally PDF) report from two results
  list     show the stored results

Run any command with --help for its options.

Every result records what was measured, which build answered and how. A number
without that context is what this tool exists to replace.
`)
}

// ---------------------------------------------------------------------------

func cmdRun(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	target := fs.String("target", "http://127.0.0.1:8080", "base URL to measure")
	label := fs.String("label", "", "label for this run, e.g. before / after / prod")
	iterations := fs.Int("n", 20, "measured samples per scenario")
	warmup := fs.Int("warmup", 3, "discarded requests before measuring")
	heavy := fs.Bool("heavy", false, "include heavy scenarios (the 14 MB full-domain query)")
	heavyN := fs.Int("heavy-n", 3, "samples for heavy scenarios")
	timeout := fs.Duration("timeout", 120*time.Second, "per-request timeout")
	results := fs.String("results", defaultResults, "directory to save the result in")
	if err := fs.Parse(args); err != nil {
		return err
	}

	if *heavy && isRemote(*target) {
		fmt.Fprintf(os.Stderr,
			"note: --heavy against %s will transfer roughly %d MB. Running this against a shared server\n"+
				"      is a load test rather than a benchmark.\n\n", *target, 15**heavyN)
	}

	opts := bench.Options{
		Target:          *target,
		Label:           *label,
		Iterations:      *iterations,
		Warmup:          *warmup,
		IncludeHeavy:    *heavy,
		HeavyIterations: *heavyN,
		Timeout:         *timeout,
		Progress: func(done, total int, s bench.Scenario) {
			fmt.Printf("  [%2d/%2d] %s\n", done, total, s.Name)
		},
	}

	fmt.Printf("Measuring %s\n", *target)
	run, err := bench.Execute(ctx, opts)
	if err != nil {
		return err
	}

	path, err := run.Save(*results)
	if err != nil {
		return err
	}

	fmt.Printf("\n%s\n", summary(run))
	fmt.Printf("saved %s\n", path)
	return nil
}

// ---------------------------------------------------------------------------

func cmdSweep(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("sweep", flag.ExitOnError)
	repo := fs.String("repo", ".", "git checkout to take revisions from")
	from := fs.String("from", "", "revision to start after (exclusive), e.g. a commit or tag")
	to := fs.String("to", "HEAD", "revision to end at (inclusive)")
	max := fs.Int("max", 20, "maximum revisions to build")
	every := fs.Int("every", 1, "build every Nth revision")
	merges := fs.Bool("merges", true, "only merge commits — one point per pull request")
	dataDir := fs.String("data-dir", "data", "data directory each built server should use")
	resourcesDir := fs.String("resources-dir", "resources", "resources directory")
	port := fs.Int("port", 8099, "port each built server listens on, one at a time")
	iterations := fs.Int("n", 20, "measured samples per scenario")
	warmup := fs.Int("warmup", 3, "discarded requests before measuring")
	heavy := fs.Bool("heavy", false, "include heavy scenarios")
	results := fs.String("results", defaultResults, "directory to save results in")
	dryRun := fs.Bool("dry-run", false, "list the revisions that would be built, and stop")
	if err := fs.Parse(args); err != nil {
		return err
	}

	absData, err := filepath.Abs(*dataDir)
	if err != nil {
		return err
	}
	absResources, err := filepath.Abs(*resourcesDir)
	if err != nil {
		return err
	}

	opts := bench.SweepOptions{
		Repo:         *repo,
		From:         *from,
		To:           *to,
		Max:          *max,
		Every:        *every,
		MergesOnly:   *merges,
		DataDir:      absData,
		ResourcesDir: absResources,
		Port:         *port,
		Bench: bench.Options{
			Iterations:   *iterations,
			Warmup:       *warmup,
			IncludeHeavy: *heavy,
		},
		Log: func(format string, args ...any) {
			fmt.Printf(format+"\n", args...)
		},
	}

	revs, err := bench.Revisions(opts)
	if err != nil {
		return err
	}

	fmt.Printf("%d revision(s) to build and measure:\n", len(revs))
	for _, r := range revs {
		fmt.Printf("  %s  %s  %s\n", r.Commit[:8], r.Date, truncate(r.Title, 62))
	}
	if *dryRun {
		fmt.Println("\ndry run: nothing built.")
		return nil
	}
	fmt.Printf("\nEach one is a full build. Ctrl-C stops between revisions and keeps what is done.\n\n")

	runs, problems := bench.Sweep(ctx, opts, *results)

	fmt.Printf("\n%d revision(s) measured.\n", len(runs))
	for _, p := range problems {
		fmt.Fprintf(os.Stderr, "  problem: %v\n", p)
	}
	if len(runs) >= 2 {
		fmt.Printf("\nCompare the ends with:\n  dtbench report --baseline %s --current %s --out report.html --pdf\n",
			filepath.Join(*results, runs[0].Filename()),
			filepath.Join(*results, runs[len(runs)-1].Filename()))
	}
	return nil
}

// ---------------------------------------------------------------------------

func cmdReport(args []string) error {
	fs := flag.NewFlagSet("report", flag.ExitOnError)
	baseline := fs.String("baseline", "", "results file to compare against (required)")
	current := fs.String("current", "", "results file to report on (required)")
	out := fs.String("out", "benchmark-report.html", "HTML output path")
	pdf := fs.Bool("pdf", false, "also print to PDF with a headless browser")
	title := fs.String("title", "", "report title")
	subtitle := fs.String("subtitle", "", "report subtitle")
	mark := fs.String("mark", "docs/assets/brand/kartoza-symbol-color.svg", "brand mark to place on the cover")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *baseline == "" || *current == "" {
		return fmt.Errorf("--baseline and --current are both required; `dtbench list` shows what is stored")
	}

	base, err := bench.LoadRun(*baseline)
	if err != nil {
		return err
	}
	cur, err := bench.LoadRun(*current)
	if err != nil {
		return err
	}

	comparison := bench.Compare(base, cur)

	defaultTitle := "Performance report"
	defaultSubtitle := fmt.Sprintf("%s compared with %s", base.Describe(), cur.Describe())

	html, err := bench.RenderHTML(comparison, bench.ReportOptions{
		Title:    orDefault(*title, defaultTitle),
		Subtitle: orDefault(*subtitle, defaultSubtitle),
		MarkPath: *mark,
	})
	if err != nil {
		return err
	}

	if err := os.WriteFile(*out, html, 0o644); err != nil {
		return fmt.Errorf("write report: %w", err)
	}
	fmt.Printf("wrote %s\n", *out)

	if *pdf {
		pdfPath := strings.TrimSuffix(*out, filepath.Ext(*out)) + ".pdf"
		if err := bench.WritePDF(*out, pdfPath); err != nil {
			// The HTML is the artefact; the PDF is a convenience. Failing the
			// command because a browser is missing would be disproportionate.
			fmt.Fprintf(os.Stderr, "note: no PDF written (%v)\n", err)
		} else {
			fmt.Printf("wrote %s\n", pdfPath)
		}
	}

	fmt.Printf("\n%s\n", comparison.Summarise().Describe())
	return nil
}

// ---------------------------------------------------------------------------

func cmdList(args []string) error {
	fs := flag.NewFlagSet("list", flag.ExitOnError)
	results := fs.String("results", defaultResults, "results directory")
	if err := fs.Parse(args); err != nil {
		return err
	}

	runs, problems := bench.LoadRuns(*results)
	for _, p := range problems {
		fmt.Fprintf(os.Stderr, "  unreadable: %v\n", p)
	}
	if len(runs) == 0 {
		fmt.Printf("no results in %s yet\n", *results)
		return nil
	}

	fmt.Printf("%-34s %-9s %-22s %s\n", "FILE", "TARGET", "BUILD", "WHEN")
	for _, r := range runs {
		build := r.ServerVersion
		if r.Commit != "" {
			build = r.Commit[:8] + " " + build
		}
		fmt.Printf("%-34s %-9s %-22s %s\n",
			truncate(r.Filename(), 34), r.TargetKind, truncate(build, 22),
			r.StartedAt.Format("2006-01-02 15:04"))
	}
	return nil
}

// ---------------------------------------------------------------------------

func summary(run bench.Run) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s against %s\n", run.Describe(), run.Target)
	for _, s := range run.Scenarios {
		if s.Skipped {
			fmt.Fprintf(&b, "  %-32s skipped (%s)\n", s.Name, s.SkippedReason)
			continue
		}
		if s.Samples == 0 {
			fmt.Fprintf(&b, "  %-32s no successful samples\n", s.Name)
			continue
		}
		fmt.Fprintf(&b, "  %-32s p50 %8.2f ms   p90 %8.2f ms   %s\n",
			s.Name, s.TotalMs.P50, s.TotalMs.P90, humanBytes(s.BytesMax))
	}
	for _, n := range run.Notes {
		fmt.Fprintf(&b, "\nnote: %s\n", n)
	}
	return b.String()
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

func isRemote(target string) bool {
	return !strings.Contains(target, "127.0.0.1") && !strings.Contains(target, "localhost")
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if n <= 1 {
		return s[:n]
	}
	return s[:n-1] + "…"
}

func orDefault(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}
