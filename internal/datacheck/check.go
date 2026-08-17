package datacheck

import (
	"database/sql"
	"encoding/csv"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"

	"github.com/kartoza/decision-theatre/internal/tiles"

	_ "github.com/mattn/go-sqlite3"
)

// Finding is one observation about the data directory.
type Finding struct {
	Severity Severity
	// Label names the thing checked, e.g. a table or file name.
	Label string
	// Message states the result in one line.
	Message string
	// Detail is an optional follow-up line: a suggestion, or the source
	// location that reads the thing being reported on.
	Detail string
}

// Section groups findings under one heading of the report.
type Section struct {
	Title string
	// Subject is the path or object the section is about.
	Subject string
	// Size in bytes of Subject, or 0 when not applicable.
	Size     int64
	Findings []Finding
}

// PathInfo is one entry found on disk, classified against the spec.
type PathInfo struct {
	Path      string
	Role      Role
	Size      int64
	FileCount int
	IsDir     bool
}

// Report is the outcome of checking a data directory.
type Report struct {
	DataDir   string
	TotalSize int64
	FileCount int
	Sections  []Section
	// Inventory lists every top-level entry found, classified.
	Inventory []PathInfo
}

// Errors counts findings that mean the application will not work correctly.
func (r *Report) Errors() int { return r.count(SeverityError) }

// Warnings counts findings that mean something is missing or degraded.
func (r *Report) Warnings() int { return r.count(SeverityWarn) }

func (r *Report) count(s Severity) int {
	n := 0
	for _, sec := range r.Sections {
		for _, f := range sec.Findings {
			if f.Severity == s {
				n++
			}
		}
	}
	return n
}

// OK reports whether the directory is usable by the application.
func (r *Report) OK() bool { return r.Errors() == 0 }

// Extraneous returns the entries that nothing in the project reads or produces.
func (r *Report) Extraneous() []PathInfo {
	var out []PathInfo
	for _, p := range r.Inventory {
		if p.Role == RoleExtraneous {
			out = append(out, p)
		}
	}
	return out
}

// PackablePaths returns the top-level entries a data pack should contain: the
// runtime files, and nothing else. Build inputs are excluded because the
// application never opens them and they are typically an order of magnitude
// larger than the pack; user data is excluded because it belongs to whoever
// installs the pack, not to whoever built it.
func (r *Report) PackablePaths() []string {
	var out []string
	for _, p := range r.Inventory {
		if p.Role == RoleRuntime {
			out = append(out, p.Path)
		}
	}
	sort.Strings(out)
	return out
}

// Run checks dataDir and returns a report. It returns an error only when the
// directory cannot be examined at all; everything else is a finding.
func Run(dataDir string) (*Report, error) {
	info, err := os.Stat(dataDir)
	if err != nil {
		return nil, fmt.Errorf("data directory not found: %w", err)
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("not a directory: %s", dataDir)
	}

	abs, err := filepath.Abs(dataDir)
	if err != nil {
		abs = dataDir
	}

	r := &Report{DataDir: abs}

	if err := r.buildInventory(); err != nil {
		return nil, err
	}

	// Columns come from the GeoPackage and are needed to check metadata.csv,
	// so the GeoPackage section runs first and hands its result along.
	columns := r.checkGeoPackage()
	r.checkTiles()
	r.checkMetadata(columns)
	r.checkLookups()
	r.checkInventory()

	return r, nil
}

// -----------------------------------------------------------------------------
// Inventory
// -----------------------------------------------------------------------------

// classify matches a top-level name against the spec.
func classify(name string, isDir bool) Role {
	if slices.Contains(IgnoredNames, name) {
		return RoleUserData // debris: neither content nor a fault
	}
	for _, e := range KnownEntries {
		want := strings.TrimSuffix(e.Path, "/")
		if name != want {
			continue
		}
		// A path declared as a directory that turns up as a file (or the
		// reverse) is not the thing the spec describes.
		if strings.HasSuffix(e.Path, "/") != isDir {
			return RoleExtraneous
		}
		return e.Role
	}
	// Editor and spreadsheet debris.
	if strings.HasPrefix(name, ".~lock.") || strings.HasSuffix(name, "~") {
		return RoleExtraneous
	}
	return RoleExtraneous
}

func (r *Report) buildInventory() error {
	entries, err := os.ReadDir(r.DataDir)
	if err != nil {
		return fmt.Errorf("cannot read data directory: %w", err)
	}

	for _, e := range entries {
		p := PathInfo{
			Path:  e.Name(),
			IsDir: e.IsDir(),
			Role:  classify(e.Name(), e.IsDir()),
		}

		if e.IsDir() {
			size, count := dirSize(filepath.Join(r.DataDir, e.Name()))
			p.Size, p.FileCount = size, count
		} else if fi, err := e.Info(); err == nil {
			p.Size, p.FileCount = fi.Size(), 1
		}

		r.TotalSize += p.Size
		r.FileCount += p.FileCount
		r.Inventory = append(r.Inventory, p)
	}

	sort.Slice(r.Inventory, func(i, j int) bool {
		return r.Inventory[i].Path < r.Inventory[j].Path
	})
	return nil
}

func dirSize(dir string) (int64, int) {
	var total int64
	var count int
	// Walk errors are ignored deliberately: an unreadable subdirectory should
	// not abort the whole report, and the inventory section reports what it
	// managed to see.
	_ = filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if d.IsDir() {
			return nil
		}
		if fi, err := d.Info(); err == nil {
			total += fi.Size()
			count++
		}
		return nil
	})
	return total, count
}

func (r *Report) checkInventory() {
	sec := Section{Title: "Directory contents", Subject: r.DataDir, Size: r.TotalSize}

	var extraneous []PathInfo
	for _, p := range r.Inventory {
		if p.Role == RoleExtraneous {
			extraneous = append(extraneous, p)
		}
	}

	if len(extraneous) == 0 {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityOK,
			Label:    "no extraneous content",
			Message:  "every entry is read by the application or is a known build input",
		})
	}
	for _, p := range extraneous {
		what := "file"
		if p.IsDir {
			what = fmt.Sprintf("directory, %d files", p.FileCount)
		}
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityWarn,
			Label:    p.Path,
			Message:  fmt.Sprintf("not read by the application (%s, %s)", what, humanSize(p.Size)),
			Detail:   "it will be left out of a data pack; remove it if it does not belong here",
		})
	}

	// Required runtime entries that are absent entirely.
	present := make(map[string]bool, len(r.Inventory))
	for _, p := range r.Inventory {
		present[p.Path] = true
	}
	for _, e := range KnownEntries {
		if e.Role != RoleRuntime || !e.Required {
			continue
		}
		name := strings.TrimSuffix(e.Path, "/")
		if !present[name] {
			sec.Findings = append(sec.Findings, Finding{
				Severity: SeverityError,
				Label:    e.Path,
				Message:  "missing — " + e.Why,
				Detail:   "read by " + e.ReadBy,
			})
		}
	}

	r.Sections = append(r.Sections, sec)
}

// -----------------------------------------------------------------------------
// GeoPackage
// -----------------------------------------------------------------------------

// checkGeoPackage validates datapack.gpkg and returns the column names of
// scenario_current, which are the authoritative indicator list.
func (r *Report) checkGeoPackage() []string {
	path := filepath.Join(r.DataDir, "datapack.gpkg")
	sec := Section{Title: "GeoPackage", Subject: "datapack.gpkg"}

	fi, err := os.Stat(path)
	if err != nil {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityError,
			Label:    "datapack.gpkg",
			Message:  "missing — the filename is hardcoded in NewGpkgStore and no other name is discovered",
			Detail:   "build it with 'make geopackage'",
		})
		r.Sections = append(r.Sections, sec)
		return nil
	}
	sec.Size = fi.Size()

	// Opened exactly as internal/geodata does — read-only and immutable — so a
	// file this check can read is a file the application can read.
	db, err := sql.Open("sqlite3", path+"?mode=ro&immutable=1")
	if err == nil {
		err = db.Ping()
	}
	if err != nil {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityError,
			Label:    "datapack.gpkg",
			Message:  "is not a readable SQLite database: " + err.Error(),
		})
		r.Sections = append(r.Sections, sec)
		return nil
	}
	defer func() { _ = db.Close() }()

	tables, err := tableNames(db)
	if err != nil {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityError,
			Label:    "datapack.gpkg",
			Message:  "cannot list tables: " + err.Error(),
		})
		r.Sections = append(r.Sections, sec)
		return nil
	}

	var columns []string
	for _, t := range GeoPackageTables {
		if !tables[t.Name] {
			sev := SeverityWarn
			msg := "missing — " + t.Why
			if t.Required {
				sev = SeverityError
			}
			sec.Findings = append(sec.Findings, Finding{
				Severity: sev,
				Label:    t.Name,
				Message:  msg,
				Detail:   "read by " + t.ReadBy,
			})
			continue
		}

		rowCount, err := countRows(db, t.Name)
		switch {
		case err != nil:
			sec.Findings = append(sec.Findings, Finding{
				Severity: SeverityError,
				Label:    t.Name,
				Message:  "present but unreadable: " + err.Error(),
			})
			continue
		case rowCount == 0 && t.Required:
			sec.Findings = append(sec.Findings, Finding{
				Severity: SeverityError,
				Label:    t.Name,
				Message:  "is empty — " + t.Why,
			})
			continue
		}

		cols, err := tableColumns(db, t.Name)
		if err != nil {
			sec.Findings = append(sec.Findings, Finding{
				Severity: SeverityError,
				Label:    t.Name,
				Message:  "cannot read its columns: " + err.Error(),
			})
			continue
		}
		if t.Name == "scenario_current" {
			columns = cols
		}

		colSet := make(map[string]bool, len(cols))
		for _, c := range cols {
			colSet[c] = true
		}
		var missing []string
		for _, want := range t.Columns {
			if !colSet[want] {
				missing = append(missing, want)
			}
		}
		if len(missing) > 0 {
			sec.Findings = append(sec.Findings, Finding{
				Severity: SeverityError,
				Label:    t.Name,
				Message: fmt.Sprintf("%s rows, but missing column(s): %s",
					humanCount(rowCount), strings.Join(missing, ", ")),
				Detail: "read by " + t.ReadBy,
			})
			continue
		}

		msg := fmt.Sprintf("%s rows", humanCount(rowCount))
		if len(cols) > 0 {
			msg += fmt.Sprintf(" · %d columns", len(cols))
		}
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityOK,
			Label:    t.Name,
			Message:  msg,
		})
	}

	r.Sections = append(r.Sections, sec)
	return columns
}

func tableNames(db *sql.DB) (map[string]bool, error) {
	rows, err := db.Query(`SELECT name FROM sqlite_master WHERE type IN ('table','view')`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	out := make(map[string]bool)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out[name] = true
	}
	return out, rows.Err()
}

func countRows(db *sql.DB, table string) (int64, error) {
	var n int64
	// The table name comes from the spec, never from user input, so it cannot
	// be parameterised and does not need to be.
	err := db.QueryRow(`SELECT COUNT(*) FROM "` + table + `"`).Scan(&n)
	return n, err
}

func tableColumns(db *sql.DB, table string) ([]string, error) {
	rows, err := db.Query(`PRAGMA table_info("` + table + `")`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	var out []string
	for rows.Next() {
		var (
			cid        int
			name, typ  string
			notNull    int
			dflt       sql.NullString
			primaryKey int
		)
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &primaryKey); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// -----------------------------------------------------------------------------
// Tiles
// -----------------------------------------------------------------------------

func (r *Report) checkTiles() {
	dir := filepath.Join(r.DataDir, "mbtiles")
	sec := Section{Title: "Map tiles", Subject: "mbtiles/"}

	if fi, err := os.Stat(dir); err != nil || !fi.IsDir() {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityError,
			Label:    "mbtiles/",
			Message:  "missing — the map will not render",
			Detail:   "read by internal/tiles/mbtiles.go:NewMBTilesStore",
		})
		r.Sections = append(r.Sections, sec)
		return
	}
	sec.Size, _ = dirSize(dir)

	// The real loader, so anything it rejects is reported exactly as the
	// application would experience it.
	store, err := tiles.NewMBTilesStore(dir)
	if err != nil {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityError,
			Label:    "mbtiles/",
			Message:  "no valid .mbtiles files found: " + err.Error(),
		})
		r.Sections = append(r.Sections, sec)
		return
	}
	defer store.Close()

	names := store.ListTilesets()
	sort.Strings(names)

	found := false
	for _, n := range names {
		if n == RequiredTilesetName {
			found = true
		}
	}

	if !found {
		msg := fmt.Sprintf("no tileset named %q", RequiredTilesetName)
		detail := "the server requests this name in internal/server/server.go; the name comes from the filename, so rename the file to " + RequiredTilesetName + ".mbtiles"
		if len(names) > 0 {
			msg += fmt.Sprintf(" — found %s instead", strings.Join(quoteAll(names), ", "))
		}
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityError,
			Label:    RequiredTilesetName + ".mbtiles",
			Message:  msg,
			Detail:   detail,
		})
	}

	for _, n := range names {
		meta, err := store.GetMetadata(n)
		if err != nil || meta == nil {
			sec.Findings = append(sec.Findings, Finding{
				Severity: SeverityWarn,
				Label:    n,
				Message:  "opens, but has no readable metadata table",
			})
			continue
		}
		sev := SeverityOK
		if n != RequiredTilesetName {
			// A tileset nothing asks for is dead weight in a pack.
			sev = SeverityWarn
		}
		msg := fmt.Sprintf("zoom %d–%d", meta.MinZoom, meta.MaxZoom)
		if meta.Format != "" {
			msg += " · " + meta.Format
		}
		if sev == SeverityWarn {
			msg += " · not requested by the server"
		}
		sec.Findings = append(sec.Findings, Finding{Severity: sev, Label: n, Message: msg})
	}

	// style.json: the server prefers the data directory and falls back to
	// resources, so its absence here is not by itself a fault.
	if _, err := os.Stat(filepath.Join(dir, "style.json")); err == nil {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityOK,
			Label:    "style.json",
			Message:  "present — overrides the built-in style",
		})
	}

	r.Sections = append(r.Sections, sec)
}

func quoteAll(in []string) []string {
	out := make([]string, len(in))
	for i, s := range in {
		out[i] = fmt.Sprintf("%q", s)
	}
	return out
}

// -----------------------------------------------------------------------------
// metadata.csv
// -----------------------------------------------------------------------------

// checkMetadata validates metadata.csv and cross-checks every row it names
// against the columns that actually exist in the GeoPackage.
func (r *Report) checkMetadata(gpkgColumns []string) {
	path := filepath.Join(r.DataDir, "metadata.csv")
	sec := Section{Title: "Indicator metadata", Subject: "metadata.csv"}

	fi, err := os.Stat(path)
	if err != nil {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityWarn,
			Label:    "metadata.csv",
			Message:  "missing — the metadata endpoints will return empty responses",
			Detail:   "read by internal/api/metadata_cache.go",
		})
		r.Sections = append(r.Sections, sec)
		return
	}
	sec.Size = fi.Size()

	headers, records, err := readCSV(path)
	if err != nil {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityError,
			Label:    "metadata.csv",
			Message:  "cannot be parsed as CSV: " + err.Error(),
		})
		r.Sections = append(r.Sections, sec)
		return
	}

	nameIdx := indexOf(headers, MetadataColumnName)
	if nameIdx < 0 {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityError,
			Label:    MetadataColumnName,
			Message:  "column is absent — the whole file is discarded and every metadata endpoint returns empty",
			Detail:   "read by internal/api/metadata_cache.go",
		})
		r.Sections = append(r.Sections, sec)
		return
	}

	sec.Findings = append(sec.Findings, Finding{
		Severity: SeverityOK,
		Label:    "parsed",
		Message:  fmt.Sprintf("%s rows · %d columns", humanCount(int64(len(records))), len(headers)),
	})

	if len(gpkgColumns) == 0 {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityWarn,
			Label:    "cross-check",
			Message:  "skipped — the GeoPackage column list could not be read",
		})
		r.Sections = append(r.Sections, sec)
		return
	}

	known := make(map[string]bool, len(gpkgColumns))
	for _, c := range gpkgColumns {
		known[c] = true
	}

	var orphans []string
	seen := make(map[string]bool, len(records))
	var duplicates []string

	for _, rec := range records {
		if nameIdx >= len(rec) {
			continue
		}
		name := strings.TrimSpace(rec[nameIdx])
		if name == "" {
			continue
		}
		if seen[name] {
			duplicates = append(duplicates, name)
			continue
		}
		seen[name] = true
		if !known[name] {
			orphans = append(orphans, name)
		}
	}

	if len(orphans) == 0 {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityOK,
			Label:    "cross-check",
			Message:  "every row names a column that exists in scenario_current",
		})
	} else {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityError,
			Label:    "cross-check",
			Message: fmt.Sprintf("%d row(s) name a column that does not exist in scenario_current — those indicators never appear in the UI, and nothing is logged",
				len(orphans)),
		})
		// Suggest the near-matches. The common cause is a metadata.csv
		// exported from R, where make.names() has replaced spaces with dots.
		// These are notes, not errors: they are examples of the one fault
		// reported above, and counting each of them would say "344 errors"
		// about a single mistake.
		recoverable := 0
		for _, o := range orphans {
			if nearest(o, gpkgColumns) != "" {
				recoverable++
			}
		}

		for _, o := range limit(orphans, 10) {
			if suggestion := nearest(o, gpkgColumns); suggestion != "" {
				sec.Findings = append(sec.Findings, Finding{
					Severity: SeverityNote,
					Label:    "  " + o,
					Message:  "did you mean " + fmt.Sprintf("%q", suggestion) + "?",
				})
			} else {
				sec.Findings = append(sec.Findings, Finding{
					Severity: SeverityNote,
					Label:    "  " + o,
					Message:  "no similar column in scenario_current",
				})
			}
		}
		if len(orphans) > 10 {
			sec.Findings = append(sec.Findings, Finding{
				Severity: SeverityNote,
				Label:    "  …",
				Message:  fmt.Sprintf("and %d more", len(orphans)-10),
			})
		}
		if recoverable > 0 {
			sec.Findings = append(sec.Findings, Finding{
				Severity: SeverityNote,
				Label:    "  fix",
				Message:  fmt.Sprintf("%d of the %d differ from a real column by punctuation only", recoverable, len(orphans)),
				Detail:   "typically metadata.csv was exported from R, where make.names() replaces spaces with dots; re-export with check.names = FALSE",
			})
		}
	}

	if len(duplicates) > 0 {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityWarn,
			Label:    "duplicates",
			Message: fmt.Sprintf("%d repeated ColumnName value(s); the last row wins: %s",
				len(duplicates), strings.Join(limit(duplicates, 5), ", ")),
		})
	}

	// Columns present in the data but undescribed: they render with raw names.
	undescribed := 0
	for _, c := range gpkgColumns {
		if !seen[c] && !isStructuralColumn(c) {
			undescribed++
		}
	}
	if undescribed > 0 {
		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityWarn,
			Label:    "undescribed",
			Message: fmt.Sprintf("%d GeoPackage column(s) have no metadata row; they appear with raw names and no units",
				undescribed),
		})
	}

	r.Sections = append(r.Sections, sec)
}

// isStructuralColumn reports whether a column is plumbing rather than an
// indicator, and so is not expected to have a metadata row.
func isStructuralColumn(name string) bool {
	switch name {
	case "fid", "catchment_id", "catchment_id_int", "HYBAS_ID", "HYBAS_ID_int", "geom", "geometry":
		return true
	}
	return false
}

// nearest finds the closest candidate to name, or "" when nothing is close.
// It is deliberately narrow: the failure it exists to explain is punctuation
// substitution (R's make.names turning "Obligate grazer" into
// "Obligate.grazer"), not arbitrary typos.
func nearest(name string, candidates []string) string {
	normalise := func(s string) string {
		s = strings.ToLower(s)
		r := strings.NewReplacer(".", "", " ", "", "_", "", "-", "")
		return r.Replace(s)
	}
	target := normalise(name)
	for _, c := range candidates {
		if normalise(c) == target {
			return c
		}
	}
	return ""
}

// -----------------------------------------------------------------------------
// Lookup tables
// -----------------------------------------------------------------------------

// lookupFile describes one optional CSV and the column it is keyed on.
type lookupFile struct {
	name   string
	keyCol string
	why    string
}

func (r *Report) checkLookups() {
	sec := Section{Title: "Lookup tables", Subject: "*.csv"}

	files := []lookupFile{
		{"NPP_by_treecover.csv", "catchID", "net primary productivity by tree cover"},
		{"deltaSOC_bytcc_Mgha.csv", "catchID", "soil organic carbon change by tree cover"},
		{"herb_traits_ready.csv", "", "herbivore traits"},
	}

	for _, lf := range files {
		path := filepath.Join(r.DataDir, lf.name)
		fi, err := os.Stat(path)
		if err != nil {
			sec.Findings = append(sec.Findings, Finding{
				Severity: SeverityWarn,
				Label:    lf.name,
				Message:  "missing — " + lf.why + "; proportional scaling is used instead",
				Detail:   "read by internal/api/lookups.go:LoadLookupTables",
			})
			continue
		}

		headers, records, err := readCSV(path)
		if err != nil {
			sec.Findings = append(sec.Findings, Finding{
				Severity: SeverityError,
				Label:    lf.name,
				Message:  "cannot be parsed as CSV: " + err.Error(),
			})
			continue
		}

		if lf.keyCol != "" && indexOf(headers, lf.keyCol) < 0 {
			sec.Findings = append(sec.Findings, Finding{
				Severity: SeverityError,
				Label:    lf.name,
				Message: fmt.Sprintf("has no %q column, so every lookup misses and the table is silently unused",
					lf.keyCol),
				Detail: "read by internal/api/lookups.go:LoadLookupTables",
			})
			continue
		}

		if len(records) == 0 {
			sec.Findings = append(sec.Findings, Finding{
				Severity: SeverityWarn,
				Label:    lf.name,
				Message:  "has a header but no rows",
			})
			continue
		}

		sec.Findings = append(sec.Findings, Finding{
			Severity: SeverityOK,
			Label:    lf.name,
			Message: fmt.Sprintf("%s rows · %d columns · %s",
				humanCount(int64(len(records))), len(headers), humanSize(fi.Size())),
		})
	}

	r.Sections = append(r.Sections, sec)
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

// readCSV returns the header row and the data rows. Rows with an unexpected
// field count are tolerated, matching encoding/csv with FieldsPerRecord = -1,
// because the application's own readers do not reject them either.
func readCSV(path string) ([]string, [][]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()

	cr := csv.NewReader(f)
	cr.TrimLeadingSpace = true
	cr.FieldsPerRecord = -1
	cr.ReuseRecord = false

	headers, err := cr.Read()
	if err != nil {
		if errors.Is(err, io.EOF) {
			return nil, nil, errors.New("file is empty")
		}
		return nil, nil, err
	}
	// Strip a UTF-8 BOM, which spreadsheet exports routinely prepend and which
	// would otherwise corrupt the first header name.
	if len(headers) > 0 {
		headers[0] = strings.TrimPrefix(headers[0], "\ufeff")
	}
	for i := range headers {
		headers[i] = strings.TrimSpace(headers[i])
	}

	var records [][]string
	for {
		rec, err := cr.Read()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return headers, records, err
		}
		records = append(records, rec)
	}
	return headers, records, nil
}

func indexOf(haystack []string, needle string) int {
	for i, h := range haystack {
		if h == needle {
			return i
		}
	}
	return -1
}

func limit(in []string, n int) []string {
	if len(in) <= n {
		return in
	}
	return in[:n]
}

// humanSize renders a byte count the way a person reads it.
func humanSize(b int64) string {
	const unit = 1024
	if b < unit {
		return fmt.Sprintf("%d B", b)
	}
	div, exp := int64(unit), 0
	for n := b / unit; n >= unit; n /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(b)/float64(div), "KMGTPE"[exp])
}

// humanCount groups thousands with a thin space, so 154394 reads as 154 394.
func humanCount(n int64) string {
	s := fmt.Sprintf("%d", n)
	if len(s) <= 4 {
		return s
	}
	var out []byte
	for i, c := range []byte(s) {
		if i > 0 && (len(s)-i)%3 == 0 {
			out = append(out, ' ')
		}
		out = append(out, c)
	}
	return string(out)
}
