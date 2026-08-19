package bench

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// closeTo reports whether two millisecond figures agree to within a tolerance
// far tighter than anything the tool claims, so a genuine arithmetic mistake
// still fails while float representation does not.
func closeTo(t *testing.T, what string, got, want float64) {
	t.Helper()
	if math.Abs(got-want) > 1e-9 {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

// A single sample has no distribution, and every percentile of it is that
// sample. Guards against an off-by-one in the nearest-rank index that would
// return sorted[1] and panic, or sorted[0] for the max and quietly lie.
func TestSummariseOfOneSampleReportsThatSampleAtEveryPercentile(t *testing.T) {
	s := Summarise([]float64{42})

	if s.N != 1 {
		t.Errorf("N = %d, want 1", s.N)
	}
	for _, c := range []struct {
		name string
		got  float64
	}{{"Min", s.Min}, {"P50", s.P50}, {"P90", s.P90}, {"P99", s.P99}, {"Max", s.Max}, {"Mean", s.Mean}} {
		closeTo(t, c.name, c.got, 42)
	}
}

// Two samples are the smallest case where nearest-rank has a choice to make.
// Guards against rounding the rank down, which would report the fast sample as
// the p90 and make every two-sample scenario look better than it is.
func TestSummariseOfTwoSamplesTakesTheSlowerOneForTheUpperPercentiles(t *testing.T) {
	s := Summarise([]float64{20, 10})

	closeTo(t, "Min", s.Min, 10)
	closeTo(t, "P50", s.P50, 10) // ceil(0.50 * 2) = 1 -> sorted[0]
	closeTo(t, "P90", s.P90, 20) // ceil(0.90 * 2) = 2 -> sorted[1]
	closeTo(t, "P99", s.P99, 20)
	closeTo(t, "Max", s.Max, 20)
	closeTo(t, "Mean", s.Mean, 15)
}

// Identical samples must not produce a spread out of nothing. Guards against a
// mean or percentile computed over the wrong slice length, which shows up here
// as a value that is not the sample.
func TestSummariseOfIdenticalSamplesReportsNoSpread(t *testing.T) {
	s := Summarise([]float64{7, 7, 7, 7, 7})

	if s.Min != s.Max || s.Min != s.P50 || s.P50 != s.P99 || s.Mean != 7 {
		t.Errorf("identical samples produced a spread: %+v", s)
	}
}

// Odd and even counts take different branches of the ceiling. Guards against a
// percentile that is correct for one parity and off by one for the other, which
// is the classic way this arithmetic goes wrong.
func TestSummariseUsesNearestRankForOddAndEvenCounts(t *testing.T) {
	odd := Summarise([]float64{30, 10, 20})
	closeTo(t, "odd P50", odd.P50, 20) // ceil(1.5) = 2 -> sorted[1]
	closeTo(t, "odd P90", odd.P90, 30) // ceil(2.7) = 3 -> sorted[2]
	closeTo(t, "odd Mean", odd.Mean, 20)

	even := Summarise([]float64{40, 10, 30, 20})
	closeTo(t, "even P50", even.P50, 20) // ceil(2.0) = 2 -> sorted[1]
	closeTo(t, "even P90", even.P90, 40) // ceil(3.6) = 4 -> sorted[3]
	closeTo(t, "even Mean", even.Mean, 25)
}

// A hundred samples is where a percentile is meant to be readable at a glance.
// Guards against interpolation creeping in: nearest-rank over 1..100 must land
// exactly on the labelled sample, not between two of them.
func TestSummariseOverAHundredSamplesLandsOnTheLabelledSample(t *testing.T) {
	samples := make([]float64, 100)
	for i := range samples {
		samples[i] = float64(i + 1)
	}
	s := Summarise(samples)

	closeTo(t, "P50", s.P50, 50)
	closeTo(t, "P90", s.P90, 90)
	closeTo(t, "P99", s.P99, 99)
	closeTo(t, "Min", s.Min, 1)
	closeTo(t, "Max", s.Max, 100)
	closeTo(t, "Mean", s.Mean, 50.5)
}

// No samples must be the zero value rather than a panic or a NaN mean. Guards
// against a division by zero reaching a report as "NaN ms".
func TestSummariseOfNoSamplesIsZeroRatherThanNaN(t *testing.T) {
	s := Summarise(nil)

	if s != (Stats{}) {
		t.Fatalf("Summarise(nil) = %+v, want the zero value", s)
	}
	if math.IsNaN(s.Mean) {
		t.Error("mean of no samples is NaN, which would render as NaN in a report")
	}
}

// Summarise must not reorder its caller's slice. Guards against the sort being
// applied in place: the runner keeps its raw samples, and silently sorting them
// would corrupt anything computed from them afterwards.
func TestSummariseDoesNotReorderTheCallersSamples(t *testing.T) {
	samples := []float64{3, 1, 2}
	Summarise(samples)

	if samples[0] != 3 || samples[1] != 1 || samples[2] != 2 {
		t.Errorf("Summarise sorted the caller's slice in place: %v", samples)
	}
}

// A percentile outside 0..100 must clamp rather than index out of range.
// Guards against a caller (or a future sweep option) panicking the whole tool.
func TestPercentileClampsRanksOutsideTheSample(t *testing.T) {
	sorted := []float64{1, 2, 3}

	closeTo(t, "p0", percentile(sorted, 0), 1)
	closeTo(t, "p100", percentile(sorted, 100), 3)
	closeTo(t, "p-10", percentile(sorted, -10), 1)
	closeTo(t, "p1000", percentile(sorted, 1000), 3)
	closeTo(t, "empty", percentile(nil, 50), 0)
}

// ---------------------------------------------------------------------------
// Storage

// sampleRun is a run with every field populated, so a round-trip test actually
// exercises the fields rather than the handful a minimal fixture would carry.
func sampleRun() Run {
	return Run{
		SchemaVersion: ResultsVersion,
		Label:         "before",
		Target:        "http://127.0.0.1:8080",
		TargetKind:    "local",
		StartedAt:     time.Date(2026, 8, 19, 9, 30, 0, 0, time.UTC),
		Duration:      93 * time.Second,
		ServerVersion: "0.4.0-211-g7fb8f6b",
		Commit:        "7fb8f6b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7",
		CommitDate:    "2026-08-18",
		CommitTitle:   "perf: aggregate at the zoom tier",
		Iterations:    20,
		Warmup:        3,
		Host:          "workstation",
		// This fixture stands for a run that was taken properly, so it carries
		// the settle evidence a real run carries. Without it the comparison
		// warns that the target had not finished starting up.
		Settled: true,
		Notes:   []string{"The target reports its version as \"dev\"."},
		Scenarios: []ScenarioResult{
			{
				Name: "health", Group: "Baseline", Why: "Round-trip with no work behind it.",
				URL: "http://127.0.0.1:8080/api/health", Samples: 20, Errors: 0,
				StatusCounts: map[int]int{200: 20},
				TotalMs:      Summarise([]float64{1, 2, 3, 4}),
				TTFBMs:       Summarise([]float64{1, 1, 2, 2}),
				BytesMin:     18, BytesMax: 18,
				ContentEncoding: "gzip", ETag: `W/"abc"`, CacheControl: "no-cache",
			},
			{
				Name: "heavy", Group: "Statistics", Skipped: true,
				SkippedReason: "heavy scenario; run with --heavy to include it",
			},
		},
	}
}

// Saving and loading must give back the same run: a comparison against last
// month is the point of the tool, and a field lost in the round-trip is a field
// that silently stops being part of history.
func TestARunSurvivesBeingSavedAndLoadedUnchanged(t *testing.T) {
	dir := t.TempDir()
	want := sampleRun()

	path, err := want.Save(dir)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}

	got, err := LoadRun(path)
	if err != nil {
		t.Fatalf("LoadRun: %v", err)
	}

	if !got.StartedAt.Equal(want.StartedAt) {
		t.Errorf("StartedAt = %v, want %v", got.StartedAt, want.StartedAt)
	}
	if got.Duration != want.Duration {
		t.Errorf("Duration = %v, want %v", got.Duration, want.Duration)
	}

	// Field-by-field comparison via the encoding itself: anything that failed to
	// survive the trip shows up as a difference here without the test needing to
	// be updated every time a field is added.
	wantJSON, _ := json.Marshal(want)
	gotJSON, _ := json.Marshal(got)
	if string(wantJSON) != string(gotJSON) {
		t.Errorf("round trip changed the run\n saved: %s\nloaded: %s", wantJSON, gotJSON)
	}
}

// A saved and reloaded run must compare as identical to itself. Guards against
// a round-trip that preserves the JSON but loses precision the comparison then
// reads as a change — the failure that would make every report suspect.
func TestARunComparedWithItsOwnReloadedCopyShowsNoChange(t *testing.T) {
	dir := t.TempDir()
	original := sampleRun()

	path, err := original.Save(dir)
	if err != nil {
		t.Fatalf("Save: %v", err)
	}
	reloaded, err := LoadRun(path)
	if err != nil {
		t.Fatalf("LoadRun: %v", err)
	}

	c := Compare(original, reloaded)
	if len(c.Warnings) != 0 {
		t.Errorf("a run compared with itself produced warnings: %v", c.Warnings)
	}
	for _, d := range c.Deltas {
		if d.Verdict != Unchanged {
			t.Errorf("scenario %s compared with itself is %q, want unchanged", d.Name, d.Verdict)
		}
		if d.RelativeChange != 0 {
			t.Errorf("scenario %s compared with itself moved by %v", d.Name, d.RelativeChange)
		}
	}
}

// Save must not leave the temporary file behind, and must not leave a partial
// file where a later load would read it. Guards against a permanent, silent
// corruption of the history the tool exists to keep.
func TestSaveLeavesOnlyTheFinishedFileBehind(t *testing.T) {
	dir := t.TempDir()
	if _, err := sampleRun().Save(dir); err != nil {
		t.Fatalf("Save: %v", err)
	}

	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("Save left %d files behind, want 1: %v", len(entries), entries)
	}
	if strings.HasSuffix(entries[0].Name(), ".tmp") {
		t.Errorf("Save left a temporary file as the result: %s", entries[0].Name())
	}
}

// Save must create a results directory that does not exist yet, including
// intermediate components. Guards against a first run failing on a fresh
// checkout, where benchmarks/results has never existed.
func TestSaveCreatesAResultsDirectoryThatDoesNotExistYet(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "benchmarks", "results")

	path, err := save(t, dir)
	if err != nil {
		t.Fatalf("Save into a missing directory: %v", err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Errorf("Save reported %s but it is not there: %v", path, err)
	}
}

func save(t *testing.T, dir string) (string, error) {
	t.Helper()
	return sampleRun().Save(dir)
}

// A results directory that cannot be written must say so, not lose the run
// silently. Guards against a benchmark that takes twenty minutes reporting
// success and leaving nothing on disk.
func TestSaveIntoAReadOnlyDirectoryReportsAComprehensibleError(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("running as root: permission bits do not deny writes")
	}
	parent := t.TempDir()
	if err := os.Chmod(parent, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(parent, 0o700) })

	_, err := sampleRun().Save(filepath.Join(parent, "results"))
	if err == nil {
		t.Fatal("Save into a read-only directory succeeded, want an error")
	}
	if !strings.Contains(err.Error(), "results directory") {
		t.Errorf("error %q does not say which step failed", err)
	}
}

// A file written by a newer version of the tool must be refused, and the message
// must say what happened. Guards against a future schema being read with today's
// field meanings and producing numbers that look plausible and are wrong.
func TestARunFromANewerSchemaIsRefusedWithAMessageThatExplainsWhy(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "future.json")
	if err := os.WriteFile(path, []byte(`{"schemaVersion":99,"target":"http://x"}`), 0o600); err != nil {
		t.Fatal(err)
	}

	_, err := LoadRun(path)
	if err == nil {
		t.Fatal("a newer schema loaded without complaint")
	}
	for _, want := range []string{"newer version", "99"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %q", err, want)
		}
	}
}

// A file written by an older version must still load: history is the point, and
// refusing last month's file defeats it.
func TestAnOlderRunStillLoads(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "old.json")
	body := `{"schemaVersion":0,"target":"http://127.0.0.1:8080","targetKind":"local",
	          "scenarios":[{"name":"health","group":"Baseline","samples":5,
	          "totalMs":{"n":5,"min":1,"p50":2,"p90":3,"p99":3,"max":3,"mean":2}}]}`
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}

	run, err := LoadRun(path)
	if err != nil {
		t.Fatalf("an older schema was refused: %v", err)
	}
	s, ok := run.Scenario("health")
	if !ok {
		t.Fatal("the scenario from the older file did not survive the load")
	}
	closeTo(t, "p50", s.TotalMs.P50, 2)
}

// Unreadable and unparseable files must name themselves. Guards against an
// error that says "unexpected end of JSON input" with no clue which of forty
// files in the directory is the broken one.
func TestLoadRunNamesTheFileItCouldNotRead(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "corrupt.json")
	if err := os.WriteFile(bad, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := LoadRun(bad); err == nil || !strings.Contains(err.Error(), "corrupt.json") {
		t.Errorf("parse error = %v, want it to name corrupt.json", err)
	}
	missing := filepath.Join(dir, "nope.json")
	if _, err := LoadRun(missing); err == nil || !strings.Contains(err.Error(), "nope.json") {
		t.Errorf("read error = %v, want it to name nope.json", err)
	}
}

// One corrupt file must not make the rest of the history unreadable, and the
// runs must come back oldest first so a listing reads as a timeline.
func TestLoadRunsSkipsACorruptFileAndReturnsTheRestOldestFirst(t *testing.T) {
	dir := t.TempDir()

	later := sampleRun()
	later.Label = "after"
	later.StartedAt = later.StartedAt.Add(time.Hour)
	if _, err := later.Save(dir); err != nil {
		t.Fatal(err)
	}
	if _, err := sampleRun().Save(dir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "corrupt.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	// A non-JSON file in the directory must be ignored entirely rather than
	// reported as a problem: reports and PDFs get written next to results.
	if err := os.WriteFile(filepath.Join(dir, "report.html"), []byte("<html>"), 0o600); err != nil {
		t.Fatal(err)
	}

	runs, problems := LoadRuns(dir)
	if len(runs) != 2 {
		t.Fatalf("loaded %d runs, want 2", len(runs))
	}
	if runs[0].Label != "before" || runs[1].Label != "after" {
		t.Errorf("runs are not oldest first: %q then %q", runs[0].Label, runs[1].Label)
	}
	if len(problems) != 1 {
		t.Errorf("reported %d problems, want exactly the corrupt file: %v", len(problems), problems)
	}
}

// A missing results directory must be an explained error rather than an empty
// listing that reads as "you have never run this".
func TestLoadRunsFromAMissingDirectoryExplainsItself(t *testing.T) {
	runs, problems := LoadRuns(filepath.Join(t.TempDir(), "never-created"))

	if len(runs) != 0 {
		t.Errorf("loaded %d runs from a missing directory", len(runs))
	}
	if len(problems) != 1 || !strings.Contains(problems[0].Error(), "results directory") {
		t.Errorf("problems = %v, want one that names the results directory", problems)
	}
}

// ---------------------------------------------------------------------------
// Identity

// The filename must be sortable by time and carry enough identity to be
// recognised. Guards against two runs in the same second overwriting each other
// unnoticed, and against a label with a slash in it escaping the directory.
func TestFilenameIsSortableAndCannotEscapeTheResultsDirectory(t *testing.T) {
	r := sampleRun()
	r.Label = "prod/friday ☺"

	name := r.Filename()
	if strings.ContainsAny(name, `/\`) {
		t.Errorf("filename %q contains a path separator", name)
	}
	if !strings.HasPrefix(name, "20260819-093000-") {
		t.Errorf("filename %q does not start with a sortable UTC timestamp", name)
	}
	if !strings.HasSuffix(name, ".json") {
		t.Errorf("filename %q is not a .json file", name)
	}
	if !strings.Contains(name, "7fb8f6b1") {
		t.Errorf("filename %q does not carry the short commit", name)
	}
}

// A run with no label falls back to the target kind, so an unlabelled run is
// still identifiable in a directory listing rather than being called "-.json".
func TestFilenameFallsBackToTheTargetKindWhenThereIsNoLabel(t *testing.T) {
	r := sampleRun()
	r.Label = ""
	r.Commit = ""

	if got, want := r.Filename(), "20260819-093000-local.json"; got != want {
		t.Errorf("Filename() = %q, want %q", got, want)
	}
}

// Describe is the one line a reader uses to tell two results apart, so it must
// carry the label, the build and the time.
func TestDescribeCarriesEnoughToTellTwoRunsApart(t *testing.T) {
	got := sampleRun().Describe()

	for _, want := range []string{"before", "7fb8f6b1", "2026-08-19 09:30"} {
		if !strings.Contains(got, want) {
			t.Errorf("Describe() = %q, want it to contain %q", got, want)
		}
	}
}

// A run with no commit falls back to the server version, so a measurement of
// production is still attributed to a build.
func TestDescribeFallsBackToTheServerVersionWhenThereIsNoCommit(t *testing.T) {
	r := sampleRun()
	r.Commit = ""

	if got := r.Describe(); !strings.Contains(got, "0.4.0-211-g7fb8f6b") {
		t.Errorf("Describe() = %q, want the server version", got)
	}
}

// shortCommit must not slice past the end of a short revision string. Guards
// against a panic on a hand-written or abbreviated results file.
func TestShortCommitDoesNotSlicePastAShortRevision(t *testing.T) {
	for _, in := range []string{"", "abc", "abcdefgh", "abcdefghij"} {
		got := shortCommit(in)
		if len(got) > 8 {
			t.Errorf("shortCommit(%q) = %q, longer than 8", in, got)
		}
	}
}

// Scenario lookup must report absence rather than returning a zero result that
// the comparison would read as a measurement of zero milliseconds.
func TestScenarioLookupReportsAbsenceRatherThanAZeroResult(t *testing.T) {
	r := sampleRun()

	if _, ok := r.Scenario("health"); !ok {
		t.Error("a scenario that is present was reported missing")
	}
	got, ok := r.Scenario("no-such-scenario")
	if ok {
		t.Error("a scenario that is absent was reported present")
	}
	if !reflect.DeepEqual(got, ScenarioResult{}) {
		t.Errorf("absent scenario returned %+v, want the zero value", got)
	}
}
