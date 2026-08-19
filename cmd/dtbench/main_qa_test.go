package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/kartoza/decision-theatre/internal/bench"
)

// captureStdout runs f with os.Stdout redirected, so a test can assert on what a
// command prints without the test log filling with report output.
func captureStdout(t *testing.T, f func()) string {
	t.Helper()

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	saved := os.Stdout
	os.Stdout = w

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
			os.Stdout = saved
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
func healthyRun(label string, p50 float64) bench.Run {
	return bench.Run{
		SchemaVersion: 1,
		Label:         label,
		Target:        "http://127.0.0.1:8080",
		TargetKind:    "local",
		StartedAt:     time.Date(2026, 8, 19, 9, 0, 0, 0, time.UTC),
		ServerVersion: "0.4.0",
		Iterations:    20,
		Warmup:        3,
		Host:          "workstation",
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
func TestReportRefusesToRunWithoutBothSidesAndSaysHowToFindThem(t *testing.T) {
	err := cmdReport([]string{"--current", "somewhere.json"})
	if err == nil {
		t.Fatal("report ran with no baseline")
	}
	if !strings.Contains(err.Error(), "dtbench list") {
		t.Errorf("error = %q, want it to point at `dtbench list`", err)
	}

	if err := cmdReport(nil); err == nil {
		t.Error("report ran with neither side given")
	}
}

// A results file that does not exist must be named in the error, not reported as
// a parse failure with no context.
func TestReportNamesAResultsFileItCannotRead(t *testing.T) {
	dir := t.TempDir()
	good := writeRun(t, dir, healthyRun("before", 2))
	missing := filepath.Join(dir, "not-there.json")

	err := cmdReport([]string{"--baseline", missing, "--current", good})
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

	stdout := captureStdout(t, func() {
		if err := cmdReport([]string{"--baseline", base, "--current", cur, "--out", out}); err != nil {
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

	err := cmdReport([]string{"--baseline", base, "--current", cur,
		"--out", filepath.Join(dir, "no-such-dir", "report.html")})

	if err == nil {
		t.Fatal("report succeeded writing into a directory that does not exist")
	}
	if !strings.Contains(err.Error(), "write report") {
		t.Errorf("error = %q, want it to say which step failed", err)
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

	err := cmdReport([]string{"--baseline", good, "--current", future,
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

	out := filepath.Join(dir, "report.html")
	stdout := captureStdout(t, func() {
		if err := cmdReport([]string{
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
	if !strings.Contains(string(html), "Of 0 scenarios measured") {
		t.Error("the report does not say that nothing was actually compared")
	}
	if !strings.Contains(stdout, "0 faster, 0 slower, 0 unchanged") {
		t.Errorf("the summary claims a comparison that did not happen: %q", stdout)
	}
}

// A run with no scenarios at all must not crash the report.
func TestReportOnARunWithZeroScenariosDoesNotCrash(t *testing.T) {
	dir := t.TempDir()

	empty := healthyRun("empty", 0)
	empty.Scenarios = nil

	out := filepath.Join(dir, "report.html")
	captureStdout(t, func() {
		if err := cmdReport([]string{
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
	out := captureStdout(t, func() {
		if err := cmdList([]string{"--results", filepath.Join(t.TempDir(), "never-created")}); err != nil {
			t.Errorf("cmdList: %v", err)
		}
	})

	if !strings.Contains(out, "no results in") {
		t.Errorf("list output = %q, want it to say the directory holds nothing yet", out)
	}
}

// The listing must show every stored run with enough identity to pick one for a
// report.
func TestListShowsEveryStoredRunWithEnoughIdentityToChooseOne(t *testing.T) {
	dir := t.TempDir()
	writeRun(t, dir, healthyRun("before", 10))
	after := healthyRun("after", 5)
	after.StartedAt = after.StartedAt.Add(time.Hour)
	writeRun(t, dir, after)

	out := captureStdout(t, func() {
		if err := cmdList([]string{"--results", dir}); err != nil {
			t.Errorf("cmdList: %v", err)
		}
	})

	for _, want := range []string{"FILE", "TARGET", "BUILD", "WHEN", "before", "after", "local", "0.4.0"} {
		if !strings.Contains(out, want) {
			t.Errorf("listing does not contain %q:\n%s", want, out)
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

	captureStdout(t, func() {
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

	out := captureStdout(t, func() {
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

	out := captureStdout(t, func() {
		err := cmdRun(t.Context(), []string{"--target", "http://[::1", "--results", dir, "-n", "1"})
		if err == nil {
			t.Error("run accepted a target that is not a URL")
		} else if !strings.Contains(err.Error(), "not a URL") {
			t.Errorf("error = %q, want it to say the target is not a URL", err)
		}
	})
	_ = out

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 0 {
		t.Errorf("a failed run left %d files in the results directory", len(entries))
	}
}

// A run against a target with nothing listening must still save its result, so
// the failure is on the record rather than lost with the invocation.
func TestRunAgainstAnUnreachableTargetStillSavesAnHonestResult(t *testing.T) {
	dir := t.TempDir()

	captureStdout(t, func() {
		// Port 1 on loopback: reserved, and nothing will be listening.
		err := cmdRun(t.Context(), []string{
			"--target", "http://127.0.0.1:1", "--results", dir,
			"-n", "1", "--warmup", "1", "--timeout", "2s", "--label", "unreachable",
		})
		if err != nil {
			t.Errorf("cmdRun: %v", err)
		}
	})

	runs, problems := bench.LoadRuns(dir)
	if len(problems) != 0 {
		t.Errorf("problems reading back the saved run: %v", problems)
	}
	if len(runs) != 1 {
		t.Fatalf("saved %d runs, want 1", len(runs))
	}
	for _, s := range runs[0].Scenarios {
		if !s.Skipped && s.Samples != 0 {
			t.Errorf("scenario %s recorded samples against a closed port", s.Name)
		}
	}
}

// The saved file must be valid JSON with the schema version stamped in it, since
// everything downstream depends on being able to read it back.
func TestASavedRunIsValidJSONWithItsSchemaVersion(t *testing.T) {
	dir := t.TempDir()

	captureStdout(t, func() {
		if err := cmdRun(t.Context(), []string{
			"--target", "http://127.0.0.1:1", "--results", dir,
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

	for _, want := range []string{
		"health", "412", "heavy", "skipped", "run with --heavy",
		"dead", "no successful samples", "note:", "did not report a version",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("summary does not contain %q:\n%s", want, got)
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

// Sizes on the command line must read the same way they do in the report.
// Guards against the two implementations of this drifting apart and a run
// summary disagreeing with the report generated from it.
func TestCommandLineSizesReadTheSameWayTheReportsDo(t *testing.T) {
	for in, want := range map[int64]string{
		-1: "—", 0: "—", 512: "512 B", 1024: "1.0 KB", 14 * 1024 * 1024: "14.0 MB",
	} {
		if got := humanBytes(in); got != want {
			t.Errorf("humanBytes(%d) = %q, want %q", in, got, want)
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
