// Command dtbench measures the Decision Theatre HTTP API and compares one
// measurement against another.
//
//	dtbench run     --target http://127.0.0.1:8080 --label before
//	dtbench sweep   --from <rev> --data-dir ./data
//	dtbench report  --baseline <run> --current <run> --out report.html --pdf
//	dtbench list
//
// Results are JSON files under --results (default ./benchmarks/results). They are
// the point of the tool: a comparison against last month is only possible if last
// month's file is still readable, so the schema is versioned and the reader
// tolerates older versions.
//
// Two conventions hold across every command, because scripts depend on them as
// much as people do:
//
//   - Results go to stdout; progress, notes and errors go to stderr. Piping a
//     command somewhere therefore yields data and nothing else.
//   - Exit status is 0 for success, 1 for a failure, 2 for a mistake in the
//     command itself, and 130 when interrupted. A partial result is never
//     reported as success.
//
// No colour is used anywhere. Meaning is carried by words — "error:", "warning:",
// "not run" — so the output survives a pipe, a log file, a screen reader and a
// reader who cannot distinguish red from green.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/kartoza/decision-theatre/internal/bench"
)

const defaultResults = "benchmarks/results"

// Exit statuses. Documented in the package comment and in `dtbench help`,
// because a benchmark is a thing people put in CI.
const (
	exitOK          = 0
	exitFailure     = 1
	exitUsage       = 2
	exitInterrupted = 130
)

// interrupted records that the user asked to stop. A run that stopped early is
// still saved — half an hour of sweep should not evaporate — but it must not
// report success, or a script will treat a partial measurement as a complete one.
var interrupted atomic.Bool

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usageText())
		fmt.Fprint(os.Stderr, "\nNothing to do. Pick a command above, or run `dtbench help`.\n")
		os.Exit(exitUsage)
	}

	ctx := watchForInterrupt()

	var err error
	switch os.Args[1] {
	case "run":
		err = cmdRun(ctx, os.Args[2:])
	case "sweep":
		err = cmdSweep(ctx, os.Args[2:])
	case "report":
		err = cmdReport(ctx, os.Args[2:])
	case "list":
		err = cmdList(os.Args[2:])
	case "-h", "--help", "help":
		_, _ = fmt.Fprint(os.Stdout, usageText())
		os.Exit(exitOK)
	default:
		fmt.Fprintf(os.Stderr, "error: %q is not a dtbench command.\n", os.Args[1])
		if near := nearestCommand(os.Args[1]); near != "" {
			fmt.Fprintf(os.Stderr, "       Did you mean `dtbench %s`?\n", near)
		}
		fmt.Fprintf(os.Stderr, "\n%s", usageText())
		os.Exit(exitUsage)
	}

	switch {
	case errors.Is(err, errStopped):
		// confirm has already said what happened and why; repeating it as an
		// error would imply something went wrong when nothing did.
		os.Exit(exitFailure)
	case err != nil && isUsageError(err):
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(exitUsage)
	case err != nil:
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(exitFailure)
	case interrupted.Load():
		os.Exit(exitInterrupted)
	}
}

// watchForInterrupt makes Ctrl-C mean something specific and says so.
//
// The first interrupt asks for a tidy stop: the work in progress finishes, what
// has been measured is written out, and the exit status says the result is
// partial. The second stops now.
//
// The second matters. Without it a user who has changed their mind is held
// hostage by a request with a two-minute timeout, with no way out but another
// terminal — and the first thing they learn about the tool is that it does not
// let go.
func watchForInterrupt() context.Context {
	ctx, cancel := context.WithCancel(context.Background())

	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)

	go func() {
		<-signals
		interrupted.Store(true)
		fmt.Fprint(os.Stderr,
			"\ninterrupt: finishing the step in progress, then saving what has been measured.\n"+
				"           Press Ctrl-C again to stop immediately and save nothing more.\n")
		cancel()

		<-signals
		fmt.Fprint(os.Stderr, "\ninterrupt: stopping now. Anything already written to disk is kept.\n")
		os.Exit(exitInterrupted)
	}()

	return ctx
}

func usageText() string {
	return `dtbench — measure the Decision Theatre API and compare runs

  run      measure one target and save the result
  sweep    build each revision in a range, measure it, save the results
  report   render an HTML (and optionally PDF) report from two results
  list     show the stored results

Start here, with the server running:

  dtbench run --target http://127.0.0.1:8080 --label before
  ... make the change you want to measure, restart the server ...
  dtbench run --target http://127.0.0.1:8080 --label after
  dtbench report --pdf

The last line needs no arguments: with nothing else said, report compares the
two most recent stored runs and names which ones it chose. Any command takes
--help for its own options.

Results are JSON files under ./benchmarks/results, one per run. They are the
point of the tool — a comparison against last month is only possible if last
month's file is still there — so nothing deletes them but you.

Every result records what was measured, which build answered and how. A number
without that context is what this tool exists to replace.

Exit status: 0 success, 1 failure, 2 mistake in the command, 130 interrupted.
`
}

func nearestCommand(given string) string {
	given = strings.ToLower(strings.TrimLeft(given, "-"))
	for _, known := range []string{"run", "sweep", "report", "list", "help"} {
		if strings.HasPrefix(known, given) || strings.HasPrefix(given, known) {
			return known
		}
	}
	// Common wrong guesses, mapped to what the tool actually calls the thing.
	switch given {
	case "bench", "benchmark", "measure", "test":
		return "run"
	case "compare", "diff", "html", "pdf":
		return "report"
	case "ls", "results", "history", "show":
		return "list"
	case "range", "revisions", "bisect":
		return "sweep"
	}
	return ""
}

// usageError marks a mistake in the command itself rather than a failure of the
// work, so main can exit 2 and a script can tell the two apart.
type usageError struct{ error }

func usagef(format string, args ...any) error {
	return usageError{fmt.Errorf(format, args...)}
}

func isUsageError(err error) bool {
	_, ok := err.(usageError)
	return ok
}

// newFlagSet builds a flag set whose --help says what the command is for, not
// only which flags it takes. `Usage of run:` followed by an alphabetical list
// tells somebody who already knows the tool what they already know.
func newFlagSet(name, summary, examples string) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)

	// The flag package prints its own message and then dumps the whole option
	// list on any parse error. A typo in one option should produce one sentence,
	// not three screens, so both are suppressed and parse says it once.
	fs.SetOutput(io.Discard)
	fs.Usage = func() {}

	helpFor[fs] = func() {
		fmt.Fprintf(os.Stderr, "dtbench %s — %s\n\n", name, summary)
		fmt.Fprint(os.Stderr, "Options:\n")
		fs.SetOutput(os.Stderr)
		fs.PrintDefaults()
		fs.SetOutput(io.Discard)
		if examples != "" {
			fmt.Fprintf(os.Stderr, "\n%s", examples)
		}
	}
	return fs
}

// helpFor holds each command's own help text. It is kept beside the flag set
// rather than in flag.Usage because flag calls Usage on every parse error, and
// this text is wanted only when it was asked for.
var helpFor = map[*flag.FlagSet]func(){}

// parse runs the flag set and turns its failures into usage errors, so that a
// mistyped flag exits 2 rather than 1 and says one thing rather than three.
func parse(fs *flag.FlagSet, args []string) error {
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			helpFor[fs]()
			os.Exit(exitOK)
		}
		message := err.Error()
		if alias := nearestFlag(err); alias != "" {
			message += fmt.Sprintf("\n       The option for that is %s.", alias)
		}
		return usagef("%s\n       `dtbench %s --help` lists the options for this command.",
			message, fs.Name())
	}
	return nil
}

// nearestFlag maps the names people reach for onto the names this tool uses.
// Being told an option does not exist, without being told what does, leaves
// somebody guessing at a vocabulary they cannot see.
func nearestFlag(err error) string {
	const prefix = "flag provided but not defined: -"
	name := strings.TrimPrefix(strings.TrimPrefix(err.Error(), prefix), "-")
	if name == err.Error() {
		return ""
	}
	switch strings.ToLower(name) {
	case "iterations", "samples", "count", "runs", "repeat":
		return "-n"
	case "url", "host", "server", "endpoint", "address":
		return "--target"
	case "name", "tag", "title":
		return "--label"
	case "output", "o", "outfile", "file":
		return "--out"
	case "dir", "directory", "output-dir":
		return "--results"
	case "before", "old":
		return "--baseline"
	case "after", "new":
		return "--current"
	case "force", "y", "assume-yes", "noconfirm":
		return "--yes"
	case "verbose", "quiet", "v":
		return "" // Neither exists; do not invent one.
	}
	return ""
}

// ---------------------------------------------------------------------------

func cmdRun(ctx context.Context, args []string) error {
	fs := newFlagSet("run", "measure one target and save the result",
		`Examples:
  dtbench run --label before
  dtbench run --target https://decision-theatre.example.org --label prod -n 50
  dtbench run --heavy --heavy-n 3        # includes the 14 MB full-domain query

The label is free text and is what you will recognise the run by later, so
"before-cache-work" beats "test2".
`)
	target := fs.String("target", "http://127.0.0.1:8080", "base URL to measure")
	label := fs.String("label", "", "label for this run, e.g. before / after / prod")
	iterations := fs.Int("n", 20, "measured samples per scenario")
	warmup := fs.Int("warmup", 3, "discarded requests before measuring")
	heavy := fs.Bool("heavy", false, "include heavy scenarios (the 14 MB full-domain query)")
	heavyN := fs.Int("heavy-n", 3, "samples for heavy scenarios")
	timeout := fs.Duration("timeout", 120*time.Second, "per-request timeout")
	results := fs.String("results", defaultResults, "directory to save the result in")
	yes := fs.Bool("yes", false, "answer yes to the cost confirmation, for unattended use")
	if err := parse(fs, args); err != nil {
		return err
	}

	normalised, err := checkTarget(*target)
	if err != nil {
		return err
	}
	if *iterations < 1 {
		return usagef("-n must be at least 1; got %d", *iterations)
	}
	if *heavyN < 1 {
		return usagef("--heavy-n must be at least 1; got %d", *heavyN)
	}
	if *timeout <= 0 {
		return usagef("--timeout must be positive; got %s", *timeout)
	}
	if *warmup < 0 {
		return usagef("--warmup cannot be negative; got %d", *warmup)
	}

	// The cost is stated before it is paid, not after.
	if *heavy {
		if err := confirmHeavy(normalised, *heavyN, *yes); err != nil {
			return err
		}
	}

	if err := reachable(ctx, normalised, *timeout); err != nil {
		return err
	}

	opts := bench.Options{
		Target:          normalised,
		Label:           *label,
		Iterations:      *iterations,
		Warmup:          *warmup,
		IncludeHeavy:    *heavy,
		HeavyIterations: *heavyN,
		Timeout:         *timeout,
		Progress: func(done, total int, s bench.Scenario) {
			fmt.Fprintf(os.Stderr, "  [%2d/%2d] %s\n", done, total, s.Name)
		},
	}

	fmt.Fprintf(os.Stderr, "Measuring %s, %d samples per scenario.\n", normalised, *iterations)
	run, err := bench.Execute(ctx, opts)
	if err != nil {
		return err
	}

	attempted, succeeded := coverage(run)
	if attempted > 0 && succeeded == 0 {
		// Saving this would put a file in the history that looks like a run and
		// contains no measurement, and the next person to pick a baseline from
		// `list` would pick it. Refusing is kinder than keeping it.
		return fmt.Errorf(`every request failed, so there is nothing worth saving.

The target answered when checked, so something between then and now is wrong:
  - the server may have stopped or restarted mid-run
  - it may be answering 4xx or 5xx for the API paths this suite uses
  - a proxy in front of it may be rejecting the requests

Status codes seen: %s
Check the server's log, then try one scenario by hand:
  curl -i %s/api/health`, statusSummary(run), normalised)
	}

	path, err := run.Save(*results)
	if err != nil {
		return err
	}

	fmt.Fprintf(os.Stderr, "\n%s", summary(run))
	if succeeded < attempted {
		fmt.Fprintf(os.Stderr, "\nwarning: %d of %d scenarios produced no usable samples. "+
			"They will read as \"stopped working\" in a report.\n", attempted-succeeded, attempted)
	}
	fmt.Println(path)

	if interrupted.Load() {
		fmt.Fprint(os.Stderr, "\nThis run was interrupted, so it covers only part of the suite. "+
			"It is saved and usable, but do not compare it with a complete run.\n")
		return nil
	}
	suggestNext(*results)
	return nil
}

// suggestNext tells somebody who has just made a measurement what to do with
// it, which is the question they are about to have.
func suggestNext(resultsDir string) {
	runs, _ := bench.LoadRuns(resultsDir)
	if len(runs) < 2 {
		fmt.Fprint(os.Stderr, "\nNext: measure again after your change, then `dtbench report --pdf` "+
			"to compare the two.\n")
		return
	}
	fmt.Fprint(os.Stderr, "\nNext: `dtbench report --pdf` compares this with the run before it. "+
		"`dtbench list` shows everything stored.\n")
}

// coverage counts scenarios that were attempted and how many produced samples.
func coverage(run bench.Run) (attempted, succeeded int) {
	for _, s := range run.Scenarios {
		if s.Skipped {
			continue
		}
		attempted++
		if s.Samples > 0 {
			succeeded++
		}
	}
	return attempted, succeeded
}

// statusSummary renders the HTTP statuses seen across a run, which is the first
// thing worth knowing when everything failed.
func statusSummary(run bench.Run) string {
	counts := map[int]int{}
	for _, s := range run.Scenarios {
		for code, n := range s.StatusCounts {
			counts[code] += n
		}
	}
	if len(counts) == 0 {
		return "none — no request completed, which usually means the connection was refused or timed out"
	}
	codes := make([]int, 0, len(counts))
	for code := range counts {
		codes = append(codes, code)
	}
	sort.Ints(codes)

	parts := make([]string, 0, len(codes))
	for _, code := range codes {
		parts = append(parts, fmt.Sprintf("%d × %d", counts[code], code))
	}
	return strings.Join(parts, ", ")
}

// checkTarget rejects the target strings that otherwise measure nothing at all.
//
// This exists because of a specific, silent failure: "http//127.0.0.1:8080" —
// one missing colon — parses cleanly as a relative URL, is classified remote,
// and produces a complete run in which every single request failed, saved to
// disk, reported as success. The typo has to be caught here, where it can still
// be explained.
func checkTarget(target string) (string, error) {
	trimmed := strings.TrimSpace(target)
	if trimmed == "" {
		return "", usagef("--target is empty; give a base URL such as http://127.0.0.1:8080")
	}

	u, err := url.Parse(trimmed)
	if err != nil || u.Scheme == "" || u.Host == "" {
		suggestion := trimmed
		if !strings.Contains(trimmed, "://") {
			// The two ways people write this: a missing scheme entirely, and a
			// scheme with its colon lost.
			suggestion = "http://" + strings.TrimPrefix(strings.TrimPrefix(trimmed, "http//"), "https//")
		}
		return "", usagef("--target %q is not a usable base URL: it needs a scheme and a host.\n"+
			"       Try: --target %s", trimmed, suggestion)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", usagef("--target %q uses the %q scheme; this tool measures HTTP, so use http:// or https://",
			trimmed, u.Scheme)
	}
	if u.Path != "" && u.Path != "/" {
		fmt.Fprintf(os.Stderr, "note: --target includes the path %q. Scenario paths are appended to it, "+
			"which is rarely what is wanted.\n", u.Path)
	}
	return strings.TrimRight(trimmed, "/"), nil
}

// reachable checks the target answers before spending minutes proving that it
// does not.
//
// Without this, a target that is not running produces a full suite of failures,
// a saved results file and exit status 0 — the tool's worst behaviour, because
// it is indistinguishable from success.
func reachable(ctx context.Context, target string, timeout time.Duration) error {
	client := &http.Client{Timeout: min(timeout, 10*time.Second)}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target+"/api/health", nil)
	if err != nil {
		return usagef("cannot build a request for %s: %v", target, err)
	}

	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil // Interrupted before we started; main reports that.
		}
		return fmt.Errorf(`nothing answered at %s, so there is nothing to measure. No results file was written.

  %v

Check that:
  - the server is running        (dt --headless --port %s)
  - the port is the right one    (--target is %s)
  - the host is reachable        (curl -sS %s/api/health)`,
			target, err, portOf(target), target, target)
	}
	defer func() { _ = resp.Body.Close() }()
	_, _ = io.Copy(io.Discard, resp.Body)

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr,
			"warning: %s/api/health answered %d, not 200. This may not be a Decision Theatre server, "+
				"or it may be starting up. Measuring anyway; scenarios that fail will be reported as such.\n",
			target, resp.StatusCode)
	}
	return nil
}

func portOf(target string) string {
	if u, err := url.Parse(target); err == nil && u.Port() != "" {
		return u.Port()
	}
	return "8080"
}

// confirmHeavy states what --heavy will cost before it is spent.
//
// The full-domain query is roughly 14 MB per request. Against a shared server
// that is a load test, and the person running it should know that before the
// first request rather than from a graph on somebody else's dashboard.
func confirmHeavy(target string, heavyN int, assumeYes bool) error {
	const heavyMB = 14
	total := heavyMB * heavyN

	fmt.Fprintf(os.Stderr,
		"\n--heavy includes the full-domain statistics query: about %d MB per request, %d requests,\n"+
			"roughly %d MB pulled from %s. Warmup requests add to that.\n",
		heavyMB, heavyN, total, target)

	if !isRemote(target) {
		fmt.Fprint(os.Stderr, "The target is local, so this costs disk and CPU rather than bandwidth.\n\n")
		return nil
	}

	fmt.Fprint(os.Stderr,
		"This target is not local. Repeating that request against a shared server is a load test\n"+
			"rather than a benchmark, and everybody else using it will feel it.\n\n")

	return confirm("Continue?", assumeYes,
		"Re-run with --yes to confirm, or drop --heavy to measure everything else.")
}

// confirm asks a yes/no question, and refuses to guess when nobody answers.
//
// An answer piped in is honoured — `echo y | dtbench sweep` is somebody saying
// yes on purpose. Silence is not: a prompt that reads EOF as consent turns a
// safety check into a decoration, so an unattended caller has to pass --yes and
// mean it.
func confirm(question string, assumeYes bool, howToProceed string) error {
	if assumeYes {
		fmt.Fprintf(os.Stderr, "%s yes (--yes)\n\n", question)
		return nil
	}
	fmt.Fprintf(os.Stderr, "%s [y/N] ", question)
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && strings.TrimSpace(line) == "" {
		// stdin exists but has nothing to say — /dev/null, a closed pipe, a CI
		// runner. The safe reading of silence is "no", and the way to say yes is
		// worth repeating here rather than leaving them with a read error.
		fmt.Fprintln(os.Stderr)
		return usagef("stopped: no answer was available on stdin, and silence is not consent.\n       %s",
			howToProceed)
	}
	switch strings.ToLower(strings.TrimSpace(line)) {
	case "y", "yes":
		fmt.Fprintln(os.Stderr)
		return nil
	default:
		fmt.Fprint(os.Stderr, "Stopped. Nothing was run and nothing was written.\n")
		return errStopped
	}
}

// errStopped is a user declining, which is not a failure of the tool. It is
// reported as a plain message and exit 1, so a script can still tell that the
// work did not happen.
var errStopped = fmt.Errorf("stopped at your request")

// ---------------------------------------------------------------------------

func cmdSweep(ctx context.Context, args []string) error {
	fs := newFlagSet("sweep", "build each revision in a range, measure it, save the results",
		`Examples:
  dtbench sweep --dry-run --from v0.4.0     # see the plan and the cost, build nothing
  dtbench sweep --from v0.4.0 --every 5     # every fifth merge, to find roughly where
  dtbench sweep --from HEAD~20 --max 6

Every revision is a full build of the server from source. Six of them is a
coffee; twenty is most of a morning. Start with --dry-run.

Ctrl-C stops after the revision in progress. Revisions already measured stay
saved, and the sweep can be resumed by narrowing --from.
`)
	repo := fs.String("repo", ".", "git checkout to take revisions from")
	from := fs.String("from", "", "revision to start after (exclusive), e.g. a commit or tag")
	to := fs.String("to", "HEAD", "revision to end at (inclusive)")
	max := fs.Int("max", 20, "maximum revisions to build")
	every := fs.Int("every", 1, "build every Nth revision")
	merges := fs.Bool("merges", true, "only merge commits — one point per pull request (--merges=false for all)")
	dataDir := fs.String("data-dir", "data", "data directory each built server should use")
	resourcesDir := fs.String("resources-dir", "resources", "resources directory")
	port := fs.Int("port", 8099, "port each built server listens on, one at a time")
	iterations := fs.Int("n", 20, "measured samples per scenario")
	warmup := fs.Int("warmup", 3, "discarded requests before measuring")
	heavy := fs.Bool("heavy", false, "include heavy scenarios")
	results := fs.String("results", defaultResults, "directory to save results in")
	dryRun := fs.Bool("dry-run", false, "list the revisions that would be built, and stop")
	yes := fs.Bool("yes", false, "start without asking, for unattended use")
	if err := parse(fs, args); err != nil {
		return err
	}

	if *iterations < 1 {
		return usagef("-n must be at least 1; got %d", *iterations)
	}
	if *every < 1 {
		return usagef("--every must be at least 1; got %d", *every)
	}
	if *max < 1 {
		return usagef("--max must be at least 1; got %d", *max)
	}
	if err := checkRepo(*repo, *from, *to); err != nil {
		return err
	}
	if err := checkDir(*dataDir, "--data-dir"); err != nil {
		return err
	}
	if err := checkDir(*resourcesDir, "--resources-dir"); err != nil {
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
	}

	revs, err := bench.Revisions(opts)
	if err != nil {
		return fmt.Errorf("could not work out which revisions to build: %w\n\n"+
			"Check that --from %q and --to %q both exist in %s:\n  git -C %s log --oneline -1 %s",
			err, *from, *to, *repo, *repo, *to)
	}

	// How many revisions the range holds, before --max trims it. A sweep that
	// silently measures the last 20 of 60 is answering a different question from
	// the one asked, and the difference has to be visible in the plan.
	uncapped := opts
	uncapped.Max = 1 << 20
	all, _ := bench.Revisions(uncapped)

	// The cost goes above the list, not below it. A wall of twenty commit
	// subjects followed by "this will take an hour" is an hour disclosed after
	// the reader has already stopped reading.
	fmt.Fprintf(os.Stderr, "%s to build and measure — roughly %s of full builds.\nListed oldest first:\n\n",
		plural(len(revs), "revision", "revisions"), estimateSweep(len(revs)))
	for i, r := range revs {
		fmt.Fprintf(os.Stderr, "  %2d. %s  %s  %s\n", i+1, r.Commit[:8], r.Date, truncate(r.Title, 58))
	}

	fmt.Fprintf(os.Stderr, "\n%s\n", sweepPlanNotes(opts, len(revs), len(all)))

	if *dryRun {
		fmt.Fprint(os.Stderr, "Dry run: nothing was built and nothing was written.\n"+
			"To do it for real, repeat the command without --dry-run.\n")
		return nil
	}

	if err := confirm(fmt.Sprintf("Build and measure %s?", plural(len(revs), "revision", "revisions")),
		*yes, "Re-run with --yes, or with --dry-run to see the plan only."); err != nil {
		return err
	}

	fmt.Fprint(os.Stderr, "Ctrl-C stops after the revision in progress. Revisions already measured stay saved.\n\n")

	tracker := newSweepProgress(len(revs))
	opts.Log = tracker.log

	runs, problems := bench.Sweep(ctx, opts, *results)

	fmt.Fprintf(os.Stderr, "\n%s measured in %s.\n",
		plural(len(runs), "revision", "revisions"), roundDuration(tracker.elapsed()))
	for _, p := range problems {
		fmt.Fprintf(os.Stderr, "  problem: %v\n", p)
	}
	if len(problems) > 0 && len(runs) > 0 {
		fmt.Fprint(os.Stderr, "  Those revisions were skipped; the ones that built are saved and usable.\n")
	}

	switch {
	case len(runs) == 0:
		return fmt.Errorf("no revision was measured, so there is nothing to report on")
	case len(runs) >= 2:
		fmt.Fprintf(os.Stderr, "\nCompare the ends of the sweep with:\n"+
			"  dtbench report --baseline %s --current %s --pdf\n",
			runs[0].Filename(), runs[len(runs)-1].Filename())
	}
	return nil
}

// sweepPlanNotes states the cost before it is paid, and explains any way in
// which the plan differs from what was asked for.
func sweepPlanNotes(opts bench.SweepOptions, planned, available int) string {
	var b strings.Builder

	b.WriteString("Each revision is checked out into a throwaway worktree, built with `go build`,\n")
	b.WriteString("started, measured, and torn down. A build is one to three minutes on a warm\n")
	b.WriteString("cache and longer on a cold one. Nothing else should be competing for the\n")
	b.WriteString("machine while it runs, or the numbers measure the machine rather than the code.\n")

	if available > planned {
		fmt.Fprintf(&b, "\n--max %d is trimming this: the range holds %d revisions, and the %d most recent\n"+
			"were kept. Raise --max, or narrow --from, to measure the rest.\n", opts.Max, available, planned)
	}
	if opts.MergesOnly {
		b.WriteString("\n--merges is on, so this counts merge commits — one point per pull request.\n" +
			"Merges bring whole branches with them, which is why a short --from range can\n" +
			"still list many. Use --merges=false for individual commits.\n")
	}
	fmt.Fprintf(&b, "\nThe built servers listen on port %d in turn. Your checkout is not modified,\n"+
		"and the data directory is opened read-only.\n", opts.Port)

	return b.String()
}

// estimateSweep is deliberately a range and deliberately vague. A single number
// here would be wrong, and being precisely wrong about an hour of somebody's
// afternoon is worse than being roughly right.
func estimateSweep(revisions int) string {
	low := time.Duration(revisions) * 90 * time.Second
	high := time.Duration(revisions) * 4 * time.Minute
	return fmt.Sprintf("%s to %s", roundDuration(low), roundDuration(high))
}

// sweepProgress puts elapsed time and a projection on every line of a sweep, so
// that a long silence is legible as progress rather than as a hang, and so that
// the decision to abandon it can be taken on evidence.
type sweepProgress struct {
	started time.Time
	total   int
	done    int
}

var revisionHeader = regexp.MustCompile(`^\[(\d+)/(\d+)\]`)

func newSweepProgress(total int) *sweepProgress {
	return &sweepProgress{started: time.Now(), total: total}
}

func (p *sweepProgress) elapsed() time.Duration { return time.Since(p.started) }

func (p *sweepProgress) log(format string, args ...any) {
	line := fmt.Sprintf(format, args...)

	// The measurement code announces each revision as "[i/n] …". Recognising it
	// gives a projection; not recognising it costs only the projection, so a
	// change to that format degrades this rather than breaking it.
	if m := revisionHeader.FindStringSubmatch(line); m != nil {
		if n, err := strconv.Atoi(m[1]); err == nil {
			p.done = n - 1
		}
	}

	fmt.Fprintf(os.Stderr, "[%7s] %s\n", roundDuration(p.elapsed()), line)

	if p.done > 0 && p.done < p.total {
		perRevision := p.elapsed() / time.Duration(p.done)
		remaining := perRevision * time.Duration(p.total-p.done)
		fmt.Fprintf(os.Stderr, "[%7s] about %s left at this rate\n",
			roundDuration(p.elapsed()), roundDuration(remaining))
	}
}

// checkRepo fails early and specifically on the mistakes that otherwise surface
// as "exit status 128".
func checkRepo(repo, from, to string) error {
	if err := exec.Command("git", "-C", repo, "rev-parse", "--git-dir").Run(); err != nil {
		return usagef("--repo %s is not a git checkout, so there are no revisions to sweep", repo)
	}
	for flagName, rev := range map[string]string{"--from": from, "--to": to} {
		if rev == "" {
			continue
		}
		if err := exec.Command("git", "-C", repo, "rev-parse", "--verify", "--quiet", rev+"^{commit}").Run(); err != nil {
			return usagef("%s %q does not name a commit in %s.\n"+
				"       Tags, branches and things like HEAD~10 all work; `git -C %s log --oneline -10` "+
				"shows what is there.", flagName, rev, repo, repo)
		}
	}
	return nil
}

func checkDir(path, flagName string) error {
	info, err := os.Stat(path)
	if err != nil {
		return usagef("%s %s cannot be read: %v.\n"+
			"       Every built server is given this directory; the sweep would fail on the first revision.",
			flagName, path, err)
	}
	if !info.IsDir() {
		return usagef("%s %s is a file, not a directory", flagName, path)
	}
	return nil
}

// ---------------------------------------------------------------------------

func cmdReport(ctx context.Context, args []string) error {
	fs := newFlagSet("report", "render an HTML (and optionally PDF) report from two results",
		`Examples:
  dtbench report --pdf                              # the two most recent runs
  dtbench report --baseline before --current after  # by label
  dtbench report --baseline last-3 --current last   # by position, newest is "last"

--baseline and --current each accept a label, a filename, a path, or one of
"first", "last", "last-1", "last-2" … With neither given, the two most recent
runs are compared and the report says which ones they were.
`)
	baseline := fs.String("baseline", "", `run to compare against: label, filename, path, or "last-1"`)
	current := fs.String("current", "", `run to report on: label, filename, path, or "last"`)
	out := fs.String("out", "benchmark-report.html", "HTML output path")
	pdf := fs.Bool("pdf", false, "also print to PDF with a headless browser")
	open := fs.Bool("open", false, "open the report when it is written")
	title := fs.String("title", "", "report title")
	subtitle := fs.String("subtitle", "", "report subtitle")
	mark := fs.String("mark", "docs/assets/brand/kartoza-symbol-color.svg", "brand mark to place on the cover")
	results := fs.String("results", defaultResults, "results directory to resolve names in")
	repo := fs.String("repo", ".", "git checkout to read the merged pull requests from")
	noChanges := fs.Bool("no-changes", false, "omit the list of what merged between the two builds")
	if err := parse(fs, args); err != nil {
		return err
	}

	base, cur, err := chooseRuns(*results, *baseline, *current)
	if err != nil {
		return err
	}

	fmt.Fprintf(os.Stderr, "Baseline: %s\nCurrent:  %s\n\n", base.Describe(), cur.Describe())

	comparison := bench.Compare(base, cur)

	// What merged between the two builds. Read from git, so it works with no
	// network and no credentials; when the range cannot be established, Changes
	// carries the reason and the report prints that instead of an empty section.
	var changes bench.Changes
	if !*noChanges {
		changes = bench.ChangesBetween(ctx, *repo, bench.CommitOf(base), bench.CommitOf(cur))
		switch {
		case len(changes.PRs) > 0:
			fmt.Fprintf(os.Stderr, "%d pull request(s) merged between these builds.\n\n", len(changes.PRs))
		case changes.Unavailable != "":
			fmt.Fprintf(os.Stderr, "Not attributing changes: %s\n\n", changes.Unavailable)
		}
	}

	defaultTitle := "Performance report"
	defaultSubtitle := fmt.Sprintf("%s compared with %s", base.Describe(), cur.Describe())

	html, err := bench.RenderHTML(comparison, bench.ReportOptions{
		Title:    orDefault(*title, defaultTitle),
		Subtitle: orDefault(*subtitle, defaultSubtitle),
		MarkPath: *mark,
		Changes:  changes,
	})
	if err != nil {
		return err
	}

	// Creating the parent directory rather than failing on it: the user asked
	// for a report at a path, and "no such file or directory" is a chore, not a
	// decision they need to be involved in.
	if dir := filepath.Dir(*out); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create the directory for %s: %w", *out, err)
		}
	}
	if err := os.WriteFile(*out, html, 0o644); err != nil {
		return fmt.Errorf("write report: %w", err)
	}

	written := []string{*out}
	if *pdf {
		pdfPath := strings.TrimSuffix(*out, filepath.Ext(*out)) + ".pdf"
		// Printing spawns a headless browser and takes several seconds. Silence
		// for several seconds after the last line of output reads as a hang.
		fmt.Fprint(os.Stderr, "Printing to PDF with a headless browser...\n")
		if err := bench.WritePDF(*out, pdfPath); err != nil {
			// The HTML is the artefact; the PDF is a convenience. Failing the
			// command because a browser is missing would be disproportionate, but
			// saying nothing about why would leave the user waiting for a file
			// that is never coming.
			fmt.Fprintf(os.Stderr,
				"warning: no PDF was written: %v.\n"+
					"         The HTML report is complete and can be printed from any browser,\n"+
					"         or install chromium and repeat the command.\n", err)
		} else {
			written = append(written, pdfPath)
		}
	}

	fmt.Fprintf(os.Stderr, "%s\n", reportDigest(comparison))

	// The PDF when there is one: it is the artefact meant for a reader, and the
	// HTML beside it is the same content. Opening is off by default because this
	// runs in CI, where launching a viewer is at best noise.
	target := *out
	for _, path := range written {
		if strings.HasSuffix(path, ".pdf") {
			target = path
		}
	}
	if *open {
		if err := openInViewer(target); err != nil {
			// Not fatal: the report exists and its path is on stdout. Failing the
			// command because no viewer is installed would be disproportionate.
			fmt.Fprintf(os.Stderr, "note: could not open %s (%v)\n", target, err)
			fmt.Fprintf(os.Stderr, "Open it with:  xdg-open %s\n", target)
		}
	} else {
		fmt.Fprintf(os.Stderr, "\nOpen it with:  xdg-open %s\n", target)
	}

	for _, path := range written {
		fmt.Println(path)
	}
	return nil
}

// openInViewer hands a path to the desktop's handler.
//
// Detached deliberately: xdg-open on some desktops does not return until the
// viewer exits, and a benchmark command that appears to hang until the reader
// closes a PDF is worse than one that prints a path.
func openInViewer(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		abs = path
	}

	opener := "xdg-open"
	if runtime.GOOS == "darwin" {
		opener = "open"
	}
	bin, err := exec.LookPath(opener)
	if err != nil {
		return fmt.Errorf("%s is not on PATH", opener)
	}

	cmd := exec.Command(bin, abs)
	cmd.Stdout, cmd.Stderr = nil, nil
	if err := cmd.Start(); err != nil {
		return err
	}
	// Not waited on, so the viewer outlives this process; Release lets the child
	// be reparented rather than left as a zombie.
	return cmd.Process.Release()
}

// reportDigest is the finding, on the terminal, in the same words the report
// uses. Somebody who ran the comparison to answer a question should not have to
// open a browser to find the answer.
func reportDigest(c bench.Comparison) string {
	h, notRun := bench.ReportHeadline(c)

	var b strings.Builder
	fmt.Fprintf(&b, "%d faster, %d slower, %d too small to call", h.Faster, h.Slower, h.Unchanged)
	if h.Broken > 0 {
		fmt.Fprintf(&b, ", %d STOPPED WORKING", h.Broken)
	}
	if notRun > 0 {
		fmt.Fprintf(&b, ", %d not run", notRun)
	}
	if h.BiggestWin != nil {
		fmt.Fprintf(&b, "\n  biggest improvement: %s, %s", h.BiggestWin.Name, bench.ChangeLabel(*h.BiggestWin))
	}
	if h.BiggestRegression != nil {
		fmt.Fprintf(&b, "\n  biggest regression:  %s, %s",
			h.BiggestRegression.Name, bench.ChangeLabel(*h.BiggestRegression))
	}
	if h.TotalBytesBaseline > 0 && bench.HumanBytes(h.TotalBytesBaseline) != bench.HumanBytes(h.TotalBytesCurrent) {
		fmt.Fprintf(&b, "\n  data transferred:    %s, was %s",
			bench.HumanBytes(h.TotalBytesCurrent), bench.HumanBytes(h.TotalBytesBaseline))
	}
	for _, w := range c.Warnings {
		fmt.Fprintf(&b, "\n  read with care: %s", w)
	}
	return b.String()
}

// chooseRuns resolves the two runs to compare.
//
// Copying two thirty-character filenames out of `list` to answer "is it faster
// than last time" is a chore the tool can do itself. With nothing given it takes
// the two most recent runs, which is what somebody who has just measured twice
// means, and it always says which two it chose.
func chooseRuns(resultsDir, baselineSpec, currentSpec string) (base, cur bench.Run, err error) {
	runs, problems := bench.LoadRuns(resultsDir)
	for _, p := range problems {
		if os.IsNotExist(underlying(p)) {
			continue
		}
		fmt.Fprintf(os.Stderr, "warning: %v\n", p)
	}

	if baselineSpec == "" && currentSpec == "" {
		if len(runs) < 2 {
			return base, cur, usagef("%s", noRunsAdvice(resultsDir, len(runs)))
		}
		base, cur = runs[len(runs)-2], runs[len(runs)-1]
		fmt.Fprint(os.Stderr, "No runs named, so comparing the two most recent.\n")
		return base, cur, nil
	}
	if baselineSpec == "" || currentSpec == "" {
		return base, cur, usagef("give both --baseline and --current, or neither " +
			"(neither compares the two most recent runs)")
	}

	base, err = resolveRun(resultsDir, runs, baselineSpec, "--baseline")
	if err != nil {
		return base, cur, err
	}
	cur, err = resolveRun(resultsDir, runs, currentSpec, "--current")
	if err != nil {
		return base, cur, err
	}

	if base.StartedAt.Equal(cur.StartedAt) && base.Target == cur.Target {
		return base, cur, usagef("--baseline and --current resolved to the same run (%s); "+
			"comparing it with itself says nothing", base.Describe())
	}
	if cur.StartedAt.Before(base.StartedAt) {
		fmt.Fprintf(os.Stderr, "note: --current (%s) is older than --baseline (%s). "+
			"The report will read as though time ran backwards; swap them if that was not deliberate.\n",
			cur.StartedAt.Format("2006-01-02 15:04"), base.StartedAt.Format("2006-01-02 15:04"))
	}
	return base, cur, nil
}

// resolveRun turns what somebody typed into a stored run, trying the forms
// people actually use before giving up.
func resolveRun(resultsDir string, runs []bench.Run, spec, flagName string) (bench.Run, error) {
	var zero bench.Run

	// Positions, counted from the newest, which is how people talk about runs
	// they have just made.
	if idx, ok := positionSpec(spec, len(runs)); ok {
		if idx < 0 || idx >= len(runs) {
			return zero, usagef("%s %q asks for a run that is not there: only %s stored",
				flagName, spec, plural(len(runs), "run is", "runs are"))
		}
		return runs[idx], nil
	}

	// An explicit path, or a filename inside the results directory.
	for _, candidate := range []string{spec, filepath.Join(resultsDir, spec), filepath.Join(resultsDir, spec+".json")} {
		if info, err := os.Stat(candidate); err == nil && !info.IsDir() {
			run, err := bench.LoadRun(candidate)
			if err != nil {
				return zero, fmt.Errorf("%s %s could not be read: %w\n"+
					"       A results file is JSON written by `dtbench run`; this one is not, "+
					"or was truncated", flagName, candidate, err)
			}
			return run, nil
		}
	}

	// A label, newest first: `--baseline before` is what somebody who labelled
	// their runs will type.
	for i := len(runs) - 1; i >= 0; i-- {
		if runs[i].Label == spec {
			return runs[i], nil
		}
	}

	// A distinctive fragment of a filename or a commit.
	var matches []bench.Run
	for _, r := range runs {
		if strings.Contains(r.Filename(), spec) || (r.Commit != "" && strings.HasPrefix(r.Commit, spec)) {
			matches = append(matches, r)
		}
	}
	switch len(matches) {
	case 1:
		return matches[0], nil
	case 0:
		return zero, usagef("%s %q matches nothing stored in %s.\n%s", flagName, spec, resultsDir,
			availableRuns(runs, resultsDir))
	default:
		return zero, usagef("%s %q matches %d stored runs; say which:\n%s",
			flagName, spec, len(matches), listOf(matches))
	}
}

// positionSpec understands "last", "last-2", "first" and a plain number.
func positionSpec(spec string, n int) (index int, ok bool) {
	switch spec {
	case "last", "latest", "newest":
		return n - 1, true
	case "first", "oldest":
		return 0, true
	case "previous", "prev":
		return n - 2, true
	}
	if back, err := strconv.Atoi(strings.TrimPrefix(spec, "last-")); err == nil &&
		strings.HasPrefix(spec, "last-") {
		return n - 1 - back, true
	}
	return 0, false
}

func availableRuns(runs []bench.Run, resultsDir string) string {
	if len(runs) == 0 {
		return noRunsAdvice(resultsDir, 0)
	}
	return "Stored runs, oldest first:\n" + listOf(runs) +
		"\nA label, a filename, or \"last\" / \"last-1\" all work."
}

func listOf(runs []bench.Run) string {
	var b strings.Builder
	for _, r := range runs {
		fmt.Fprintf(&b, "  %-34s %s\n", r.Filename(), r.Describe())
	}
	return b.String()
}

// noRunsAdvice is the empty state. Somebody arriving here has nothing stored
// and needs the next command, not a diagnosis.
func noRunsAdvice(resultsDir string, have int) string {
	switch have {
	case 0:
		return fmt.Sprintf("there are no stored runs in %s yet, so there is nothing to compare.\n\n"+
			"Make one, change something, make another:\n"+
			"  dtbench run --label before\n"+
			"  dtbench run --label after\n"+
			"  dtbench report --pdf", resultsDir)
	default:
		return fmt.Sprintf("only one run is stored in %s, and a comparison needs two.\n\n"+
			"Measure again — after your change, or against a different target — and then\n"+
			"`dtbench report --pdf` will compare the two most recent.", resultsDir)
	}
}

// underlying digs a wrapped os error out for os.IsNotExist.
func underlying(err error) error {
	for {
		unwrapped, ok := err.(interface{ Unwrap() error })
		if !ok {
			return err
		}
		err = unwrapped.Unwrap()
	}
}

// ---------------------------------------------------------------------------

func cmdList(args []string) error {
	fs := newFlagSet("list", "show the stored results",
		`Examples:
  dtbench list
  dtbench list --json | jq -r '.[].path'

The names in the first column are what --baseline and --current accept, along
with labels and "last", "last-1" and so on.
`)
	results := fs.String("results", defaultResults, "results directory")
	asJSON := fs.Bool("json", false, "print the listing as JSON for scripts")
	if err := parse(fs, args); err != nil {
		return err
	}

	runs, problems := bench.LoadRuns(*results)

	missing := false
	for _, p := range problems {
		if os.IsNotExist(underlying(p)) {
			missing = true
			continue
		}
		fmt.Fprintf(os.Stderr, "warning: %v\n", p)
	}

	if *asJSON {
		return printRunsJSON(*results, runs)
	}

	if len(runs) == 0 {
		// An empty results directory is the normal state on day one, not a
		// failure. It gets the getting-started path, not an error.
		if missing {
			fmt.Fprintf(os.Stderr, "No results yet: %s does not exist, and will be created "+
				"by the first run.\n\n", *results)
		} else {
			fmt.Fprintf(os.Stderr, "No results yet in %s.\n\n", *results)
		}
		fmt.Fprint(os.Stderr, "  dtbench run --label before\n"+
			"  ... make your change, restart the server ...\n"+
			"  dtbench run --label after\n"+
			"  dtbench report --pdf\n")
		return nil
	}

	fmt.Fprintf(os.Stderr, "%s in %s, oldest first.\n\n",
		plural(len(runs), "run", "runs"), *results)

	fmt.Printf("%-32s %-14s %-7s %-22s %-16s %s\n",
		"NAME", "LABEL", "TARGET", "BUILD", "WHEN", "SCENARIOS")
	for _, r := range runs {
		build := r.ServerVersion
		if r.Commit != "" {
			// Length-checked: a results file is data read off disk, and a run
			// whose commit is shorter than eight characters used to panic the
			// whole listing, taking every other result down with it.
			build = shortCommit(r.Commit) + " " + build
		}
		attempted, succeeded := coverage(r)
		fmt.Printf("%-32s %-14s %-7s %-22s %-16s %d of %d measured\n",
			truncate(r.Filename(), 32), truncate(orDefault(r.Label, "—"), 14), r.TargetKind,
			truncate(orDefault(build, "unknown"), 22),
			r.StartedAt.Format("2006-01-02 15:04"), succeeded, attempted)
	}

	if len(runs) >= 2 {
		fmt.Fprintf(os.Stderr, "\n`dtbench report --pdf` with no arguments compares the last two:\n"+
			"  %s  →  %s\n", runs[len(runs)-2].Filename(), runs[len(runs)-1].Filename())
	} else {
		fmt.Fprint(os.Stderr, "\nOne more run and `dtbench report --pdf` will have something to compare.\n")
	}
	return nil
}

// writeJSON emits indented JSON, which is what somebody reads when they pipe
// this into a file and open it, and jq does not care either way.
func writeJSON(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

// printRunsJSON writes the listing in a shape a script can consume, so that
// piping this command produces data rather than a table meant for eyes.
func printRunsJSON(dir string, runs []bench.Run) error {
	type row struct {
		Path          string    `json:"path"`
		Name          string    `json:"name"`
		Label         string    `json:"label,omitempty"`
		Target        string    `json:"target"`
		TargetKind    string    `json:"targetKind"`
		ServerVersion string    `json:"serverVersion,omitempty"`
		Commit        string    `json:"commit,omitempty"`
		StartedAt     time.Time `json:"startedAt"`
		Iterations    int       `json:"iterations"`
		Measured      int       `json:"scenariosMeasured"`
		Attempted     int       `json:"scenariosAttempted"`
	}

	rows := make([]row, 0, len(runs))
	for _, r := range runs {
		attempted, succeeded := coverage(r)
		rows = append(rows, row{
			Path: filepath.Join(dir, r.Filename()), Name: r.Filename(), Label: r.Label,
			Target: r.Target, TargetKind: r.TargetKind, ServerVersion: r.ServerVersion,
			Commit: r.Commit, StartedAt: r.StartedAt, Iterations: r.Iterations,
			Measured: succeeded, Attempted: attempted,
		})
	}
	return writeJSON(os.Stdout, rows)
}

// ---------------------------------------------------------------------------

// summary is the run's own numbers on the terminal, in the same words and the
// same precision the report uses.
func summary(run bench.Run) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s against %s\n", run.Describe(), run.Target)
	for _, s := range run.Scenarios {
		switch {
		case s.Skipped:
			fmt.Fprintf(&b, "  %-32s not run (%s)\n", s.Name, s.SkippedReason)
		case s.Samples == 0:
			fmt.Fprintf(&b, "  %-32s no successful samples out of %d attempts\n", s.Name, s.Errors)
		default:
			fmt.Fprintf(&b, "  %-32s median %10s   9 in 10 under %10s   %s\n",
				s.Name, bench.FormatMs(s.TotalMs.P50), bench.FormatMs(s.TotalMs.P90),
				bench.HumanBytes(s.BytesMax))
		}
	}
	for _, n := range run.Notes {
		fmt.Fprintf(&b, "\nnote: %s\n", n)
	}
	return b.String()
}

func isRemote(target string) bool {
	u, err := url.Parse(target)
	if err != nil {
		return true
	}
	host := u.Hostname()
	return host != "127.0.0.1" && host != "localhost" && host != "::1"
}

// truncate shortens a string to n characters, marking the cut with an ellipsis.
//
// Counted and cut in runes, not bytes. Commit titles routinely carry accented
// names, typographic dashes and the occasional emoji, and `dtbench sweep`
// truncates every one of them to 62 characters; a byte-wise cut could land in
// the middle of a rune and print a replacement character.
func truncate(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	if n == 1 {
		return "…"
	}
	return string([]rune(s)[:n-1]) + "…"
}

// shortCommit abbreviates a revision without slicing past its end.
func shortCommit(c string) string {
	if len(c) > 8 {
		return c[:8]
	}
	return c
}

func orDefault(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

// plural renders "1 revision" / "3 revisions" rather than "1 revision(s)".
func plural(n int, singular, many string) string {
	if n == 1 {
		return "1 " + singular
	}
	return fmt.Sprintf("%d %s", n, many)
}

// roundDuration drops precision nobody is going to act on: "42m" and "1h20m"
// are what a person needs from an estimate, and "1h19m47.3s" is not.
func roundDuration(d time.Duration) string {
	if d < time.Minute {
		return d.Round(time.Second).String()
	}
	// Go renders a rounded hour as "1h20m0s"; the trailing zero seconds are
	// precision nobody asked for in an estimate measured in coffee breaks.
	return strings.TrimSuffix(d.Round(time.Minute).String(), "0s")
}
