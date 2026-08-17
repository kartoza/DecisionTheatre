package datacheck

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// repoRoot walks up from this package to the module root.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := filepath.Abs(".")
	if err != nil {
		t.Fatalf("cannot resolve working directory: %v", err)
	}
	for range 6 {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		dir = filepath.Dir(dir)
	}
	t.Fatal("could not find go.mod above the test working directory")
	return ""
}

// readRuntimeSources returns the concatenated non-test Go source of the
// packages that open files in the data directory.
func readRuntimeSources(t *testing.T) string {
	t.Helper()
	root := repoRoot(t)

	var sb strings.Builder
	for _, pkg := range []string{"internal/geodata", "internal/api", "internal/server", "internal/tiles", "internal/sites"} {
		dir := filepath.Join(root, pkg)
		entries, err := os.ReadDir(dir)
		if err != nil {
			t.Fatalf("cannot read %s: %v", pkg, err)
		}
		for _, e := range entries {
			name := e.Name()
			if e.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			b, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				t.Fatalf("cannot read %s/%s: %v", pkg, name, err)
			}
			sb.Write(b)
			sb.WriteByte('\n')
		}
	}
	return sb.String()
}

// TestSpecCoversGeoPackageTablesInSQL is the anti-drift guard. If someone adds
// a query against a new scenario_* or catchments_* table without describing it
// in GeoPackageTables, the checker would pass a directory the application then
// fails on. This test fails instead.
//
// It cannot see table names assembled at runtime — internal/geodata builds
// several as "scenario_" + scenario — so it scans two forms: names written
// literally after FROM/JOIN, and names appearing as bare string literals (which
// is how the dynamically-selected ones are enumerated). Between them the only
// blind spot left is a name built from a fragment that never appears whole in
// the source.
func TestSpecCoversGeoPackageTablesInSQL(t *testing.T) {
	src := readRuntimeSources(t)

	patterns := []*regexp.Regexp{
		// FROM/JOIN followed by a literal identifier.
		regexp.MustCompile(`(?i)\b(?:FROM|JOIN)\s+"?((?:scenario|catchments|rtree)_[a-z0-9_]+)"?`),
		// A whole table name written as a Go string literal, e.g. the slice in
		// ComputeWhiskerBounds listing the four whisker tables.
		regexp.MustCompile(`"((?:scenario|catchments|rtree)_[a-z0-9_]+)"`),
	}

	declared := make(map[string]bool, len(GeoPackageTables))
	for _, tbl := range GeoPackageTables {
		declared[tbl.Name] = true
	}

	seen := map[string]bool{}
	for _, re := range patterns {
		for _, m := range re.FindAllStringSubmatch(src, -1) {
			name := m[1]
			if seen[name] {
				continue
			}
			seen[name] = true
			if !declared[name] {
				t.Errorf("table %q is referenced by the runtime but is not declared in GeoPackageTables (spec.go).\n"+
					"Add it there so `check-data` verifies it, or the checker will pass directories the app cannot use.", name)
			}
		}
	}

	// The four whisker tables are only reachable through the string-literal
	// pattern, so their presence proves both patterns are still matching.
	for _, want := range []string{"catchments_lev12", "scenario_current", "scenario_reference_upper"} {
		if !seen[want] {
			t.Errorf("expected to find %q in the runtime sources but did not — the patterns have probably stopped matching", want)
		}
	}
}

// TestSpecCoversDataFilesOpenedByRuntime checks the other half of the contract:
// every filename joined onto a data directory must be described in KnownEntries.
func TestSpecCoversDataFilesOpenedByRuntime(t *testing.T) {
	src := readRuntimeSources(t)

	// filepath.Join(dataDir, "name.ext") and the DataDir/ResourcesDir variants.
	re := regexp.MustCompile(`filepath\.Join\([^,)]*(?:dataDir|DataDir)[^,)]*,\s*"([^"]+)"`)

	declared := make(map[string]bool, len(KnownEntries))
	for _, e := range KnownEntries {
		declared[strings.TrimSuffix(e.Path, "/")] = true
	}

	seen := map[string]bool{}
	for _, m := range re.FindAllStringSubmatch(src, -1) {
		name := m[1]
		if seen[name] {
			continue
		}
		seen[name] = true
		if !declared[name] {
			t.Errorf("the runtime opens %q inside the data directory, but KnownEntries (spec.go) does not describe it.\n"+
				"Add it, or `check-data` will report it as extraneous and a data pack will omit it.", name)
		}
	}

	if len(seen) == 0 {
		t.Fatal("found no data-directory filenames in the runtime sources — the regexp has probably stopped matching")
	}
}

// TestSpecCoversTilesetName pins the hardcoded tileset name to the spec.
func TestSpecCoversTilesetName(t *testing.T) {
	root := repoRoot(t)
	b, err := os.ReadFile(filepath.Join(root, "internal/server/server.go"))
	if err != nil {
		t.Fatalf("cannot read server.go: %v", err)
	}
	if !strings.Contains(string(b), `"`+RequiredTilesetName+`"`) {
		t.Errorf("server.go no longer mentions the tileset name %q that spec.go requires;\n"+
			"if the server now requests a different name, update RequiredTilesetName", RequiredTilesetName)
	}
}

// TestKnownEntriesAreWellFormed catches spec typos that would otherwise make
// the checker quietly classify a real file as extraneous.
func TestKnownEntriesAreWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, e := range KnownEntries {
		if e.Path == "" {
			t.Error("an entry has an empty Path")
			continue
		}
		if seen[e.Path] {
			t.Errorf("duplicate entry for %q", e.Path)
		}
		seen[e.Path] = true

		if strings.Contains(e.Path, "\\") {
			t.Errorf("%q uses a backslash; paths in the spec are slash-separated", e.Path)
		}
		if e.Role == RoleRuntime && e.ReadBy == "" {
			t.Errorf("%q is a runtime entry but does not cite what reads it", e.Path)
		}
		if e.Why == "" {
			t.Errorf("%q has no Why, so the report cannot explain what breaks without it", e.Path)
		}
	}
}

// TestGeoPackageTablesAreWellFormed does the same for the table declarations.
func TestGeoPackageTablesAreWellFormed(t *testing.T) {
	seen := map[string]bool{}
	for _, tbl := range GeoPackageTables {
		if seen[tbl.Name] {
			t.Errorf("duplicate table declaration for %q", tbl.Name)
		}
		seen[tbl.Name] = true

		if tbl.ReadBy == "" {
			t.Errorf("table %q does not cite what reads it", tbl.Name)
		}
		if tbl.Why == "" {
			t.Errorf("table %q has no Why", tbl.Name)
		}
	}

	for _, required := range []string{"catchments_lev12", "scenario_current", "scenario_reference"} {
		if !seen[required] {
			t.Errorf("the spec no longer declares %q, which the application cannot start without", required)
		}
	}
}
