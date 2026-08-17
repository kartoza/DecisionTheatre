package datacheck

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "github.com/mattn/go-sqlite3"
)

// buildFixture writes a minimal but genuinely valid data directory: a real
// SQLite GeoPackage with the required tables, a real MBTiles file, and the
// CSVs. Tests then remove or corrupt one piece at a time.
func buildFixture(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()

	writeGeoPackage(t, filepath.Join(dir, "datapack.gpkg"))
	if err := os.MkdirAll(filepath.Join(dir, "mbtiles"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeMBTiles(t, filepath.Join(dir, "mbtiles", "africa.mbtiles"), "africa")

	writeFile(t, filepath.Join(dir, "metadata.csv"),
		"ColumnName,Detailed name,Units\nNPP,Net primary productivity,gC/m2\nSOC,Soil organic carbon,Mg/ha\n")
	writeFile(t, filepath.Join(dir, "NPP_by_treecover.csv"), "catchID,tc,value\n1,10,5.5\n")
	writeFile(t, filepath.Join(dir, "deltaSOC_bytcc_Mgha.csv"), "catchID,tc,value\n1,10,2.5\n")
	writeFile(t, filepath.Join(dir, "herb_traits_ready.csv"), "species,mass\nzebra,300\n")

	return dir
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}

// writeGeoPackage creates a SQLite file with the tables and columns the spec
// requires, populated with one row each.
func writeGeoPackage(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()

	stmts := []string{
		`CREATE TABLE catchments_lev12 (fid INTEGER PRIMARY KEY, HYBAS_ID TEXT, HYBAS_ID_int INTEGER, geom BLOB)`,
		`INSERT INTO catchments_lev12 (HYBAS_ID, HYBAS_ID_int) VALUES ('1000', 1000)`,
		`CREATE TABLE scenario_current (catchment_id_int INTEGER, NPP REAL, SOC REAL)`,
		`INSERT INTO scenario_current VALUES (1000, 1.0, 2.0)`,
		`CREATE TABLE scenario_reference (catchment_id_int INTEGER, NPP REAL, SOC REAL)`,
		`INSERT INTO scenario_reference VALUES (1000, 1.5, 2.5)`,
		`CREATE TABLE rtree_catchments_lev12_geom (id INTEGER, minx REAL, maxx REAL, miny REAL, maxy REAL)`,
		`INSERT INTO rtree_catchments_lev12_geom VALUES (1, 0, 1, 0, 1)`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("fixture geopackage: %s: %v", s, err)
		}
	}
}

// writeMBTiles creates a valid MBTiles file whose metadata names the tileset.
func writeMBTiles(t *testing.T, path, name string) {
	t.Helper()
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = db.Close() }()

	stmts := []string{
		`CREATE TABLE metadata (name TEXT, value TEXT)`,
		`CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)`,
		`INSERT INTO metadata VALUES ('name', '` + name + `')`,
		`INSERT INTO metadata VALUES ('format', 'pbf')`,
		`INSERT INTO metadata VALUES ('minzoom', '0')`,
		`INSERT INTO metadata VALUES ('maxzoom', '14')`,
		`INSERT INTO tiles VALUES (0, 0, 0, x'00')`,
	}
	for _, s := range stmts {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("fixture mbtiles: %s: %v", s, err)
		}
	}
}

// findingsFor returns all findings in the named section.
func findingsFor(r *Report, section string) []Finding {
	for _, s := range r.Sections {
		if s.Title == section {
			return s.Findings
		}
	}
	return nil
}

// hasFinding reports whether any finding in the section has the given severity
// and a message or label containing substr.
func hasFinding(r *Report, section string, sev Severity, substr string) bool {
	for _, f := range findingsFor(r, section) {
		if f.Severity == sev &&
			(strings.Contains(f.Message, substr) || strings.Contains(f.Label, substr)) {
			return true
		}
	}
	return false
}

func TestValidDirectoryHasNoErrors(t *testing.T) {
	dir := buildFixture(t)

	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	if !r.OK() {
		for _, s := range r.Sections {
			for _, f := range s.Findings {
				if f.Severity == SeverityError {
					t.Logf("unexpected error in %s: %s %s", s.Title, f.Label, f.Message)
				}
			}
		}
		t.Fatalf("a valid fixture reported %d error(s)", r.Errors())
	}
}

func TestMissingGeoPackageIsAnError(t *testing.T) {
	dir := buildFixture(t)
	if err := os.Remove(filepath.Join(dir, "datapack.gpkg")); err != nil {
		t.Fatal(err)
	}

	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if r.OK() {
		t.Error("a directory with no datapack.gpkg was reported as usable")
	}
	if !hasFinding(r, "GeoPackage", SeverityError, "missing") {
		t.Error("expected a GeoPackage 'missing' error")
	}
}

func TestMissingRequiredTableIsAnError(t *testing.T) {
	dir := buildFixture(t)

	db, err := sql.Open("sqlite3", filepath.Join(dir, "datapack.gpkg"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`DROP TABLE scenario_reference`); err != nil {
		t.Fatal(err)
	}
	db.Close()

	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if r.OK() {
		t.Error("a GeoPackage missing scenario_reference was reported as usable")
	}
	if !hasFinding(r, "GeoPackage", SeverityError, "scenario_reference") {
		t.Error("expected an error naming scenario_reference")
	}
}

func TestMissingOptionalTableIsOnlyAWarning(t *testing.T) {
	dir := buildFixture(t)
	// The fixture never creates the whisker tables.
	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !r.OK() {
		t.Error("absent whisker tables should not make the directory unusable")
	}
	if !hasFinding(r, "GeoPackage", SeverityWarn, "scenario_current_lower") {
		t.Error("expected a warning about the missing whisker table")
	}
}

func TestWrongTilesetNameIsAnError(t *testing.T) {
	dir := buildFixture(t)
	old := filepath.Join(dir, "mbtiles", "africa.mbtiles")
	renamed := filepath.Join(dir, "mbtiles", "africa-002.mbtiles")
	if err := os.Rename(old, renamed); err != nil {
		t.Fatal(err)
	}

	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if r.OK() {
		t.Error("a tileset the server never requests should be an error — the map renders blank")
	}
	if !hasFinding(r, "Map tiles", SeverityError, "africa") {
		t.Error("expected an error about the tileset name")
	}
}

func TestMetadataOrphanIsAnErrorWithSuggestion(t *testing.T) {
	dir := buildFixture(t)
	// The R make.names() failure: a dot where the GeoPackage has none.
	writeFile(t, filepath.Join(dir, "metadata.csv"),
		"ColumnName,Units\nN.P.P,gC/m2\n")

	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if r.OK() {
		t.Error("metadata naming a nonexistent column should be an error")
	}
	// One error for the fault itself...
	if !hasFinding(r, "Indicator metadata", SeverityError, "cross-check") {
		t.Error("expected a cross-check error")
	}
	// ...and the individual examples as notes, so N examples of one mistake are
	// not counted as N mistakes.
	if !hasFinding(r, "Indicator metadata", SeverityNote, "did you mean") {
		t.Error("expected a near-match suggestion for the punctuation-mangled name")
	}
	if got := r.Errors(); got != 1 {
		t.Errorf("one orphaned metadata row should report exactly 1 error, got %d", got)
	}
}

// TestManyOrphansStillCountAsOneError pins the behaviour that made the real
// report unreadable: 344 examples of one mistake read as "344 errors".
func TestManyOrphansStillCountAsOneError(t *testing.T) {
	dir := buildFixture(t)

	var sb strings.Builder
	sb.WriteString("ColumnName,Units\n")
	for i := range 50 {
		fmt.Fprintf(&sb, "Nonexistent.Column.%d,unit\n", i)
	}
	writeFile(t, filepath.Join(dir, "metadata.csv"), sb.String())

	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if got := r.Errors(); got != 1 {
		t.Errorf("50 orphaned rows are one fault; expected 1 error, got %d", got)
	}
}

func TestMetadataWithoutColumnNameIsAnError(t *testing.T) {
	dir := buildFixture(t)
	writeFile(t, filepath.Join(dir, "metadata.csv"), "Name,Units\nNPP,gC/m2\n")

	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !hasFinding(r, "Indicator metadata", SeverityError, MetadataColumnName) {
		t.Errorf("expected an error about the absent %s column", MetadataColumnName)
	}
}

func TestLookupMissingKeyColumnIsAnError(t *testing.T) {
	dir := buildFixture(t)
	writeFile(t, filepath.Join(dir, "NPP_by_treecover.csv"), "wrongkey,tc,value\n1,10,5.5\n")

	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !hasFinding(r, "Lookup tables", SeverityError, "catchID") {
		t.Error("expected an error about the missing catchID column")
	}
}

func TestExtraneousFilesAreReportedNotFatal(t *testing.T) {
	dir := buildFixture(t)
	writeFile(t, filepath.Join(dir, "notes.txt"), "scratch\n")
	if err := os.MkdirAll(filepath.Join(dir, "R scripts"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "R scripts", "model.R"), "# model\n")

	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !r.OK() {
		t.Error("extraneous files should warn, not fail the directory")
	}

	extraneous := map[string]bool{}
	for _, p := range r.Extraneous() {
		extraneous[p.Path] = true
	}
	for _, want := range []string{"notes.txt", "R scripts"} {
		if !extraneous[want] {
			t.Errorf("expected %q to be classified as extraneous", want)
		}
	}
}

func TestBuildInputsAreNotExtraneous(t *testing.T) {
	dir := buildFixture(t)
	writeFile(t, filepath.Join(dir, "current.csv"), "a,b\n1,2\n")
	writeFile(t, filepath.Join(dir, "catchments.gpkg"), "not really a gpkg\n")

	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	for _, p := range r.Extraneous() {
		if p.Path == "current.csv" || p.Path == "catchments.gpkg" {
			t.Errorf("%q is an input to build-geopackage.sh and must not be called extraneous", p.Path)
		}
	}
}

func TestPackablePathsExcludeEverythingButRuntime(t *testing.T) {
	dir := buildFixture(t)
	writeFile(t, filepath.Join(dir, "current.csv"), "a,b\n1,2\n") // build input
	writeFile(t, filepath.Join(dir, "notes.txt"), "scratch\n")    // extraneous
	if err := os.MkdirAll(filepath.Join(dir, "sites"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "sites", "a.json"), "{}\n") // user data

	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	packable := map[string]bool{}
	for _, p := range r.PackablePaths() {
		packable[p] = true
	}

	for _, want := range []string{"datapack.gpkg", "metadata.csv", "mbtiles"} {
		if !packable[want] {
			t.Errorf("%q should be packed", want)
		}
	}
	for _, unwanted := range []string{"current.csv", "notes.txt", "sites"} {
		if packable[unwanted] {
			t.Errorf("%q must not be packed", unwanted)
		}
	}
}

func TestRunRejectsMissingDirectory(t *testing.T) {
	if _, err := Run(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Error("expected an error for a nonexistent data directory")
	}
}

func TestRenderProducesReadableOutput(t *testing.T) {
	dir := buildFixture(t)
	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	var buf bytes.Buffer
	if err := r.Render(&buf); err != nil {
		t.Fatalf("Render: %v", err)
	}
	out := buf.String()

	for _, want := range []string{"Data Directory Report", "GEOPACKAGE", "catchments_lev12", "INVENTORY", "no errors"} {
		if !strings.Contains(out, want) {
			t.Errorf("rendered report is missing %q\n---\n%s", want, out)
		}
	}
	// Not a terminal, so no escape sequences should be emitted.
	if strings.Contains(out, "\033[") {
		t.Error("ANSI escapes leaked into non-terminal output")
	}
}

func TestRenderJSONIsValidAndComplete(t *testing.T) {
	dir := buildFixture(t)
	r, err := Run(dir)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	var buf bytes.Buffer
	if err := r.RenderJSON(&buf); err != nil {
		t.Fatalf("RenderJSON: %v", err)
	}

	var decoded map[string]any
	if err := json.Unmarshal(buf.Bytes(), &decoded); err != nil {
		t.Fatalf("output is not valid JSON: %v", err)
	}
	for _, key := range []string{"data_dir", "errors", "warnings", "ok", "sections", "inventory"} {
		if _, present := decoded[key]; !present {
			t.Errorf("JSON report has no %q field", key)
		}
	}
	if decoded["ok"] != true {
		t.Error("a valid fixture should report ok=true")
	}
}

func TestHumanSizeAndCount(t *testing.T) {
	sizes := []struct {
		in   int64
		want string
	}{
		{512, "512 B"},
		{1024, "1.0 KiB"},
		{1536, "1.5 KiB"},
		{1024 * 1024, "1.0 MiB"},
	}
	for _, c := range sizes {
		if got := humanSize(c.in); got != c.want {
			t.Errorf("humanSize(%d) = %q, want %q", c.in, got, c.want)
		}
	}

	counts := []struct {
		in   int64
		want string
	}{
		{5, "5"},
		{1234, "1234"},
		{154394, "154 394"},
		{1000000, "1 000 000"},
	}
	for _, c := range counts {
		if got := humanCount(c.in); got != c.want {
			t.Errorf("humanCount(%d) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestNearestMatchesPunctuationVariants(t *testing.T) {
	candidates := []string{"Obligate grazer", "NPP", "Soil_organic carbon"}

	cases := map[string]string{
		"Obligate.grazer":     "Obligate grazer",
		"obligate_grazer":     "Obligate grazer",
		"Soil.organic.carbon": "Soil_organic carbon",
		"CompletelyDifferent": "",
	}
	for in, want := range cases {
		if got := nearest(in, candidates); got != want {
			t.Errorf("nearest(%q) = %q, want %q", in, got, want)
		}
	}
}
