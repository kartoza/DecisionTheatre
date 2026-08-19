package main

import (
	"encoding/json"
	stdhtml "html"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/kartoza/decision-theatre/internal/bench"
)

// captureOutput runs f with both standard streams redirected, so a test can
// assert on what a command said without the test log filling with report output.
//
// Both streams, deliberately. The command line separates them — stdout carries
// data, stderr carries everything said to a person — and these tests assert on
// what was said, which now arrives on stderr. An earlier version captured only
// stdout, which turned every message assertion into a comparison against an
// empty string.
func captureOutput(t *testing.T, f func()) string {
	t.Helper()

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	savedOut, savedErr := os.Stdout, os.Stderr
	os.Stdout, os.Stderr = w, w

	done := make(chan string, 1)
	go func() {
		var b strings.Builder
		buf := make([]byte, 4096)
		for {
			n, err := r.Read(buf)
			if n > 0 {
				b.Write(buf[:n])
			}
			if err != nil {
				break
			}
		}
		done <- b.String()
	}()

	func() {
		defer func() {
			os.Stdout, os.Stderr = savedOut, savedErr
			_ = w.Close()
		}()
		f()
	}()

	out := <-done
	_ = r.Close()
	return out
}

// writeRun stores a run in dir and returns its path, for the command tests.
func writeRun(t *testing.T, dir string, run bench.Run) string {
	t.Helper()
	path, err := run.Save(dir)
	if err != nil {
		t.Fatal(err)
	}
	return path
}

// healthyRun is a small, complete run for the command tests.
// runStart hands out a distinct start time per run, in the order the fixtures
// are built.
//
// Runs used to share one timestamp, which was never realistic — runs are
// sequential, so two of them cannot begin in the same instant — and the report
// command now rejects a pair with the same start time against the same target as
// the same run compared with itself. Distinct times make the fixtures stand for
// something that could actually have happened.
var runStart = time.Date(2026, 8, 19, 9, 0, 0, 0, time.UTC)

func nextRunStart() time.Time {
	runStart = runStart.Add(11 * time.Minute)
	return runStart
}

func healthyRun(label string, p50 float64) bench.Run {
	return bench.Run{
		SchemaVersion: bench.ResultsVersion,
		Label:         label,
		Target:        "http://127.0.0.1:8080",
		TargetKind:    "local",
		StartedAt:     nextRunStart(),
		ServerVersion: "0.4.0",
		Iterations:    20,
		Warmup:        3,
		Host:          "workstation",
		Settled:       true,
		Scenarios: []bench.ScenarioResult{{
			Name: "health", Group: "Baseline", Why: "Round-trip with no work behind it.",
			URL: "http://127.0.0.1:8080/api/health", Samples: 20,
			StatusCounts: map[int]int{200: 20},
			TotalMs:      bench.Stats{N: 20, Min: p50, P50: p50, P90: p50, P99: p50, Max: p50, Mean: p50},
			BytesMax:     18,
		}},
	}
}

// ---------------------------------------------------------------------------
// report

// The report command must refuse to run without both sides and say how to find
// them. Guards against a bare `dtbench report` producing a report comparing
// nothing with nothing.
// A user who gets the arguments wrong must be told what to do instead, and must
// never be left with a report built from something they did not ask for.
//
// The original form of this test asserted that no arguments is an error. Ux
// decided that no arguments means "the two most recent runs", which is what
// somebody who has just measured twice means, and that is the better design — so
// the guarantee is restated rather than the decision overruled. What survives is
// that every wrong or unsatisfiable invocation ends in guidance, and that the
// convenience path says out loud which two runs it picked.
func TestReportRefusesToRunWithoutBothSidesAndSaysHowToFindThem(t *testing.T) {
	dir := t.TempDir()

	// Half an instruction is still an error: silently pairing one named run with
	// a guess would produce a comparison the user did not ask for.
	err := cmdReport(t.Context(), []string{"--results", dir, "--current", "somewhere.json"})
	if err == nil {
		t.Fatal("report ran with a current but no baseline")
	}
	if !strings.Contains(err.Error(), "--baseline") || !strings.Contains(err.Error(), "--current") {
		t.Errorf("error = %q, want it to state the rule about the two flags", err)
	}

	// Nothing given and nothing stored: an error that says how to get started.
	err = cmdReport(t.Context(), []string{"--results", dir})
	if err == nil {
		t.Fatal("report ran with neither side given and no runs stored")
	}
	if !strings.Contains(err.Error(), "dtbench run") {
		t.Errorf("error = %q, want it to say how to produce a run", err)
	}

	// Nothing given and two runs stored: it proceeds, and says which two.
	writeRun(t, dir, healthyRun("before", 400))
	writeRun(t, dir, healthyRun("after", 40))

	out := captureOutput(t, func() {
		if err := cmdReport(t.Context(), []string{"--results", dir, "--out", filepath.Join(dir, "r.html")}); err != nil {
			t.Errorf("report with no arguments and two runs stored: %v", err)
		}
	})
	if !strings.Contains(out, "two most recent") {
		t.Errorf("the tool chose two runs without saying so: %q", out)
	}
}

// A results file that does not exist must be named in the error, not reported as
// a parse failure with no context.
func TestReportNamesAResultsFileItCannotRead(t *testing.T) {
	dir := t.TempDir()
	good := writeRun(t, dir, healthyRun("before", 2))
	missing := filepath.Join(dir, "not-there.json")

	err := cmdReport(t.Context(), []string{"--baseline", missing, "--current", good})
	if err == nil {
		t.Fatal("report succeeded with a missing baseline")
	}
	if !strings.Contains(err.Error(), "not-there.json") {
		t.Errorf("error = %q, want it to name the missing file", err)
	}
}

// The report command must write the HTML where it was told and produce a
// document with the comparison in it. This is the whole command, end to end,
// without a browser.
func TestReportWritesTheHTMLItWasAskedFor(t *testing.T) {
	dir := t.TempDir()
	base := writeRun(t, dir, healthyRun("before", 400))
	cur := writeRun(t, dir, healthyRun("after", 40))
	out := filepath.Join(dir, "report.html")

	stdout := captureOutput(t, func() {
		if err := cmdReport(t.Context(), []string{"--baseline", base, "--current", cur, "--out", out}); err != nil {
			t.Errorf("cmdReport: %v", err)
		}
	})

	html, err := os.ReadFile(out)
	if err != nil {
		t.Fatalf("the report was not written: %v", err)
	}
	for _, want := range []string{"</html>", "health", "10.0× faster"} {
		if !strings.Contains(string(html), want) {
			t.Errorf("the report does not contain %q", want)
		}
	}
	if !strings.Contains(stdout, out) {
		t.Errorf("the command did not say where it wrote the report: %q", stdout)
	}
	if !strings.Contains(stdout, "faster") {
		t.Errorf("the command did not print the finding: %q", stdout)
	}
}

// Writing the report into a directory that does not exist must be an explained
// error rather than a silent success. Guards against a twenty-minute comparison
// producing nothing anybody can find.
func TestReportIntoAMissingDirectoryExplainsItself(t *testing.T) {
	dir := t.TempDir()
	base := writeRun(t, dir, healthyRun("before", 400))
	cur := writeRun(t, dir, healthyRun("after", 40))

	out := filepath.Join(dir, "no-such-dir", "report.html")

	var err error
	captureOutput(t, func() {
		err = cmdReport(t.Context(), []string{"--baseline", base, "--current", cur, "--out", out})
	})

	// Ux made the command create the directory rather than refuse, which is the
	// better answer to "I typed a path that does not exist yet". The guarantee
	// this test exists for is unchanged and is the one that matters: the command
	// must never report success it has not earned. Either it fails and says
	// which step failed, or it succeeds and the file is really there.
	if err != nil {
		if !strings.Contains(err.Error(), "write report") {
			t.Errorf("error = %q, want it to say which step failed", err)
		}
		return
	}
	info, statErr := os.Stat(out)
	if statErr != nil {
		t.Fatalf("cmdReport reported success but wrote no report: %v", statErr)
	}
	if info.Size() == 0 {
		t.Error("cmdReport reported success and wrote an empty file")
	}
}

// A results file from a newer schema must stop the report rather than being
// read with today's field meanings.
func TestReportRefusesAResultsFileFromANewerSchema(t *testing.T) {
	dir := t.TempDir()
	good := writeRun(t, dir, healthyRun("before", 2))
	future := filepath.Join(dir, "future.json")
	if err := os.WriteFile(future, []byte(`{"schemaVersion":99,"target":"http://x"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	err := cmdReport(t.Context(), []string{"--baseline", good, "--current", future,
		"--out", filepath.Join(dir, "r.html")})

	if err == nil {
		t.Fatal("report accepted a file from a newer schema")
	}
	if !strings.Contains(err.Error(), "newer version") {
		t.Errorf("error = %q, want it to explain the schema mismatch", err)
	}
}

// Two runs with nothing in common must still produce a report, and it must say
// that nothing was compared rather than implying everything was fine.
func TestReportOnTwoRunsWithNothingInCommonStillSaysSomethingTrue(t *testing.T) {
	dir := t.TempDir()

	before := healthyRun("before", 10)
	after := healthyRun("after", 10)
	after.Scenarios[0].Name = "something-else"
	// Different builds, because otherwise the report quite correctly leads with
	// "both runs measured the same build" and never reaches the question this
	// test is asking.
	after.ServerVersion = "0.5.0"

	out := filepath.Join(dir, "report.html")
	stdout := captureOutput(t, func() {
		if err := cmdReport(t.Context(), []string{
			"--baseline", writeRun(t, dir, before),
			"--current", writeRun(t, dir, after),
			"--out", out,
		}); err != nil {
			t.Errorf("cmdReport: %v", err)
		}
	})

	html, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}

	// The wording moved from "Of 0 scenarios measured" to "No scenario produced
	// comparable timings in both runs". Asserted on the claim rather than the
	// sentence: the document must say outright that nothing was compared, and
	// must not report a win, a regression or a count of unchanged scenarios that
	// were never measured against each other.
	plain := stdhtml.UnescapeString(string(html))
	if !strings.Contains(plain, "No scenario produced comparable timings") &&
		!strings.Contains(plain, "Of 0 scenarios measured") {
		t.Error("the report does not say that nothing was actually compared")
	}
	for _, claim := range []string{"faster", "slower"} {
		if strings.Contains(strings.ToLower(stdout), "1 "+claim) {
			t.Errorf("the summary claims a comparison that did not happen: %q", stdout)
		}
	}
	if strings.Contains(stdout, "biggest improvement") || strings.Contains(stdout, "biggest regression") {
		t.Errorf("the summary named an extreme among scenarios that were never compared: %q", stdout)
	}
}

// A run with no scenarios at all must not crash the report.
func TestReportOnARunWithZeroScenariosDoesNotCrash(t *testing.T) {
	dir := t.TempDir()

	empty := healthyRun("empty", 0)
	empty.Scenarios = nil

	out := filepath.Join(dir, "report.html")
	captureOutput(t, func() {
		if err := cmdReport(t.Context(), []string{
			"--baseline", writeRun(t, dir, empty),
			"--current", writeRun(t, dir, healthyRun("after", 10)),
			"--out", out,
		}); err != nil {
			t.Errorf("cmdReport: %v", err)
		}
	})

	if _, err := os.Stat(out); err != nil {
		t.Errorf("no report was written: %v", err)
	}
}

// ---------------------------------------------------------------------------
// list

// An empty or missing results directory must say so in a way a first-time user
// understands, rather than printing an empty table.
func TestListSaysPlainlyWhenThereIsNothingStored(t *testing.T) {
	out := captureOutput(t, func() {
		if err := cmdList([]string{"--results", filepath.Join(t.TempDir(), "never-created")}); err != nil {
			t.Errorf("cmdList: %v", err)
		}
	})

	// The wording grew from "no results in ..." into an explanation with the
	// commands to run next, which is better. What has to hold is that a
	// first-time user is told the directory is empty and told what to do about
	// it, rather than being shown an empty table.
	lower := strings.ToLower(out)
	if !strings.Contains(lower, "no results") {
		t.Errorf("list output does not say the directory holds nothing yet: %q", out)
	}
	if !strings.Contains(out, "dtbench run") {
		t.Errorf("list output does not say how to produce a result: %q", out)
	}
}

// The listing must show every stored run with enough identity to pick one for a
// report.
func TestListShowsEveryStoredRunWithEnoughIdentityToChooseOne(t *testing.T) {
	dir := t.TempDir()
	healthy := healthyRun("before", 10)
	writeRun(t, dir, healthy)
	later := healthyRun("after", 5)
	writeRun(t, dir, later)

	out := captureOutput(t, func() {
		if err := cmdList([]string{"--results", dir}); err != nil {
			t.Errorf("cmdList: %v", err)
		}
	})

	// The FILE column became NAME and gained LABEL and SCENARIOS. Asserted on
	// what a reader needs in order to pick a run for a report — its name, its
	// label, what it measured and when — rather than on the column headings,
	// which are the designer's to arrange.
	for _, want := range []string{"before", "after", "local", "0.4.0"} {
		if !strings.Contains(out, want) {
			t.Errorf("listing does not contain %q:\n%s", want, out)
		}
	}
	for _, r := range []bench.Run{healthy, later} {
		if !strings.Contains(out, r.Filename()) {
			t.Errorf("listing does not name the stored file %q, so it cannot be copied into a report "+
				"command:\n%s", r.Filename(), out)
		}
		if !strings.Contains(out, r.StartedAt.Format("2006-01-02 15:04")) {
			t.Errorf("listing does not say when %s ran:\n%s", r.Filename(), out)
		}
	}
}

// A results file carrying a commit shorter than eight characters must not crash
// the listing. This is a real panic: cmdList slices Commit[:8] unguarded, while
// the rest of the package uses a length-checked helper. A hand-edited file, or
// one from a repository with short revisions, takes down `dtbench list` and with
// it any chance of finding the other results.
func TestListSurvivesAResultsFileWithAShortCommit(t *testing.T) {
	dir := t.TempDir()
	run := healthyRun("short", 10)
	run.Commit = "abc"
	writeRun(t, dir, run)

	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("cmdList panicked on a short commit: %v", r)
		}
	}()

	captureOutput(t, func() {
		if err := cmdList([]string{"--results", dir}); err != nil {
			t.Errorf("cmdList: %v", err)
		}
	})
}

// One unreadable file must not hide the rest of the history.
func TestListReportsACorruptFileAndStillShowsTheRest(t *testing.T) {
	dir := t.TempDir()
	writeRun(t, dir, healthyRun("before", 10))
	if err := os.WriteFile(filepath.Join(dir, "corrupt.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}

	out := captureOutput(t, func() {
		if err := cmdList([]string{"--results", dir}); err != nil {
			t.Errorf("cmdList: %v", err)
		}
	})

	if !strings.Contains(out, "before") {
		t.Errorf("a corrupt file hid the readable results:\n%s", out)
	}
}

// ---------------------------------------------------------------------------
// run

// A target that is not a URL must fail before any measuring starts, with the
// target named.
func TestRunRefusesATargetThatIsNotAURL(t *testing.T) {
	dir := t.TempDir()

	captureOutput(t, func() {
		err := cmdRun(t.Context(), []string{"--target", "http://[::1", "--results", dir, "-n", "1"})
		if err == nil {
			t.Error("run accepted a target that is not a URL")
		} else if !strings.Contains(err.Error(), "usable base URL") {
			t.Errorf("error = %q, want it to say the target is not a usable URL", err)
		}
	})

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("a failed run left %d files in the results directory", len(entries))
	}
}

// A run against a target with nothing listening must NOT be saved.
//
// This test used to assert the opposite — that the failure was recorded "so it
// is on the record". That turned out to be the worst usability defect in the
// tool: a run measuring nothing was saved, appeared in `list`, and could then be
// chosen as a baseline, so a comparison could rest on a run that never reached a
// server. Refusing to save it is the fix, and this guards the fix.
func TestRunAgainstAnUnreachableTargetIsNotSaved(t *testing.T) {
	dir := t.TempDir()

	captureOutput(t, func() {
		// Port 1 on loopback: reserved, and nothing will be listening.
		err := cmdRun(t.Context(), []string{
			"--target", "http://127.0.0.1:1", "--results", dir,
			"-n", "1", "--warmup", "1", "--timeout", "2s", "--label", "unreachable",
		})
		if err == nil {
			t.Error("a run that reached nothing reported success")
		} else if !strings.Contains(err.Error(), "127.0.0.1:1") {
			// Refusing is right; refusing without naming what could not be
			// reached leaves the user guessing which of target, port or server
			// was wrong.
			t.Errorf("error = %q, want it to name the target that could not be reached", err)
		}
	})

	runs, _ := bench.LoadRuns(dir)
	if len(runs) != 0 {
		t.Errorf("saved %d runs against a closed port, want 0", len(runs))
	}
}

// The saved file must be valid JSON with the schema version stamped in it, since
// everything downstream depends on being able to read it back.
func TestASavedRunIsValidJSONWithItsSchemaVersion(t *testing.T) {
	dir := t.TempDir()

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	captureOutput(t, func() {
		if err := cmdRun(t.Context(), []string{
			"--target", srv.URL, "--results", dir,
			"-n", "1", "--warmup", "1", "--timeout", "2s",
		}); err != nil {
			t.Errorf("cmdRun: %v", err)
		}
	})

	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected one saved file, got %v (%v)", entries, err)
	}

	data, err := os.ReadFile(filepath.Join(dir, entries[0].Name()))
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("the saved run is not valid JSON: %v", err)
	}
	if raw["schemaVersion"] == nil {
		t.Error("the saved run has no schemaVersion, so a future reader cannot tell how to read it")
	}
}

// ---------------------------------------------------------------------------
// Presentation helpers

// The command-line summary must name every scenario and explain the blanks, so a
// reader does not have to open the JSON to find out what happened.
func TestTheCommandLineSummaryExplainsBlanksRatherThanLeavingThem(t *testing.T) {
	run := healthyRun("before", 412)
	run.Scenarios = append(run.Scenarios,
		bench.ScenarioResult{Name: "heavy", Skipped: true, SkippedReason: "run with --heavy to include it"},
		bench.ScenarioResult{Name: "dead", Errors: 20},
	)
	run.Notes = []string{"The target did not report a version."}

	got := summary(run)

	// "skipped" is now "not run". Asserted on what the line has to tell a
	// reader: which scenario, that it produced no number, and why — so that a
	// blank in the output is always explained rather than merely blank.
	for _, want := range []string{
		"health", "412",
		"heavy", "run with --heavy",
		"dead", "no successful samples",
		"did not report a version",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("summary does not contain %q:\n%s", want, got)
		}
	}
	for _, line := range strings.Split(got, "\n") {
		if strings.Contains(line, "heavy") && !strings.Contains(line, "(") {
			t.Errorf("the heavy scenario's line gives no reason for the blank: %q", line)
		}
	}
}

// KNOWN BUG (dtbench), fixed here: truncate sliced by bytes, so a commit title
// containing any non-ASCII character — an accented name, a dash a Mac inserted,
// an emoji — could be cut through the middle of a rune and printed as a
// replacement character. `dtbench sweep` truncates every commit title to 62
// characters, so this was reachable from ordinary use of the tool.
func TestTruncateCutsOnRuneBoundariesNotByteBoundaries(t *testing.T) {
	for _, c := range []struct {
		name string
		in   string
		n    int
	}{
		{"an accented title", "perf: café aggregation for naïve catchments", 12},
		{"a title with an em dash", "fix: tiles — cache them properly", 10},
		{"an emoji", "feat: 🎉 ship the dial", 9},
		{"cyrillic", "докладна записка про продуктивність", 11},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := truncate(c.in, c.n)

			if !utf8.ValidString(got) {
				t.Errorf("truncate(%q, %d) = %q, which is not valid UTF-8", c.in, c.n, got)
			}
			if strings.ContainsRune(got, utf8.RuneError) {
				t.Errorf("truncate(%q, %d) = %q, which contains a replacement character", c.in, c.n, got)
			}
			if utf8.RuneCountInString(got) > c.n {
				t.Errorf("truncate(%q, %d) = %q, which is %d runes",
					c.in, c.n, got, utf8.RuneCountInString(got))
			}
		})
	}
}

// Truncation must leave short strings alone and must not fall over at the
// degenerate widths.
func TestTruncateLeavesShortStringsAloneAndSurvivesTinyWidths(t *testing.T) {
	if got := truncate("short", 34); got != "short" {
		t.Errorf("truncate did not leave a short string alone: %q", got)
	}
	for _, n := range []int{0, 1, 2} {
		got := truncate("a longer string", n)
		if utf8.RuneCountInString(got) > n {
			t.Errorf("truncate(_, %d) = %q, longer than asked for", n, got)
		}
		if !utf8.ValidString(got) {
			t.Errorf("truncate(_, %d) = %q, not valid UTF-8", n, got)
		}
	}
}

// The command line must discard warmup requests unless told not to.
//
// The guarantee used to live on Options: an unset Warmup defaulted to three, so
// a programmatic caller could not accidentally measure a cold server. Perf made
// zero mean zero so that "--warmup 0" could express "measure the first
// request", which is a real question worth asking. The consequence is that the
// zero value of Options now performs no warmup at all, and the only thing
// standing between a user and a startup measurement is this flag default.
func TestTheCommandLineDefaultsToDiscardingWarmupRequests(t *testing.T) {
	var requests int64
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt64(&requests, 1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	dir := t.TempDir()
	captureOutput(t, func() {
		if err := cmdRun(t.Context(), []string{
			"--target", srv.URL, "--results", dir, "-n", "1", "--timeout", "5s",
		}); err != nil {
			t.Errorf("cmdRun: %v", err)
		}
	})

	runs, _ := bench.LoadRuns(dir)
	if len(runs) != 1 {
		t.Fatalf("saved %d runs, want 1", len(runs))
	}
	if runs[0].Warmup < 1 {
		t.Errorf("a run with no --warmup given recorded Warmup = %d; the first request to a cold server "+
			"would become a sample", runs[0].Warmup)
	}
	if atomic.LoadInt64(&requests) == 0 {
		t.Error("no requests were made at all, so this test proved nothing")
	}
}

// Asking for no warmup must be honoured, and must not be contradicted.
//
// The CLI used to print "warning: --warmup 0 is not honoured by the measurement
// code; 3 warmup requests will still be made." That was true when ux wrote it
// and false by the time the branches merged, because perf had fixed the
// promotion in the meantime. A tool that tells a user their flag was ignored
// when it was obeyed is worse than one that says nothing, so the warning is
// gone and this stops it, or anything like it, coming back.
func TestAskingForNoWarmupIsHonouredAndNotContradicted(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()

	dir := t.TempDir()
	out := captureOutput(t, func() {
		if err := cmdRun(t.Context(), []string{
			"--target", srv.URL, "--results", dir, "-n", "1", "--warmup", "0",
			"--timeout", "5s",
		}); err != nil {
			t.Errorf("cmdRun: %v", err)
		}
	})

	if strings.Contains(strings.ToLower(out), "not honoured") {
		t.Errorf("the tool told the user their flag was ignored: %q", out)
	}

	runs, _ := bench.LoadRuns(dir)
	if len(runs) != 1 {
		t.Fatalf("saved %d runs, want 1", len(runs))
	}
	if runs[0].Warmup != 0 {
		t.Errorf("Warmup recorded as %d after --warmup 0; the flag was not honoured", runs[0].Warmup)
	}
}

// Sizes on the command line must read the same way they do in the report.
// Guards against the two implementations of this drifting apart and a run
// summary disagreeing with the report generated from it.
func TestCommandLineSizesReadTheSameWayTheReportsDo(t *testing.T) {
	for in, want := range map[int64]string{
		-1: "—", 0: "—", 512: "512 B", 1024: "1.0 KB", 14 * 1024 * 1024: "14.0 MB",
	} {
		if got := bench.HumanBytes(in); got != want {
			t.Errorf("bench.HumanBytes(%d) = %q, want %q", in, got, want)
		}
	}
}

// The heavy-against-production warning depends on this, and getting it wrong
// means either a spurious warning or 45 MB pulled from a shared server without
// one.
func TestRemoteTargetsAreRecognisedForTheHeavyWarning(t *testing.T) {
	for target, want := range map[string]bool{
		"http://127.0.0.1:8080":  false,
		"http://localhost:8080":  false,
		"https://dt.kartoza.com": true,
		"http://192.168.1.10":    true,
	} {
		if got := isRemote(target); got != want {
			t.Errorf("isRemote(%q) = %v, want %v", target, got, want)
		}
	}
}

// A blank title or subtitle must fall back rather than producing a report with
// an empty cover.
func TestBlankTitlesFallBack(t *testing.T) {
	if got := orDefault("   ", "Performance report"); got != "Performance report" {
		t.Errorf("orDefault(whitespace) = %q, want the fallback", got)
	}
	if got := orDefault("Given", "Fallback"); got != "Given" {
		t.Errorf("orDefault overrode a given value: %q", got)
	}
}
