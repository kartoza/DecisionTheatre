// Package datacheck validates a Decision Theatre data directory against what
// the application actually reads, and renders the result as a report.
//
// The contract below is the single declaration of that expectation. It is
// consumed by the checker, by the data-pack builder (which refuses to ship a
// directory the checker rejects), and by spec_test.go, which reads the runtime
// packages back and fails if any of them reference a file or table this spec
// does not describe. That test is what stops the two drifting apart.
package datacheck

// Severity ranks a finding. Errors mean the application will not work
// correctly against this directory; warnings mean it will run with something
// missing or degraded.
type Severity int

const (
	// SeverityOK records something that is present and valid. Kept in the
	// report because "which of the optional tables do I actually have" is a
	// question the summary should answer without the reader guessing.
	SeverityOK Severity = iota
	// SeverityWarn marks a degraded but usable directory.
	SeverityWarn
	// SeverityError marks a directory the application cannot use correctly.
	SeverityError
	// SeverityNote elaborates on the finding above it — the individual
	// examples under a summary line. Notes are never counted, so listing ten
	// examples of one fault does not report itself as ten faults.
	SeverityNote
)

func (s Severity) String() string {
	switch s {
	case SeverityError:
		return "error"
	case SeverityWarn:
		return "warning"
	case SeverityNote:
		return "note"
	default:
		return "ok"
	}
}

// Role classifies every entry found in the data directory. The distinction
// matters because a data directory in a developer checkout legitimately holds
// hundreds of megabytes of source CSVs that the application never opens: those
// are build inputs, not stray files, and a pack should exclude them rather than
// report them as faults.
type Role int

const (
	// RoleRuntime is read by the running application.
	RoleRuntime Role = iota
	// RoleBuildInput is consumed by scripts/build-geopackage.sh to produce
	// datapack.gpkg. Not needed at runtime and excluded from a data pack.
	RoleBuildInput
	// RoleUserData is written by the application at runtime (saved sites,
	// uploaded images). Preserved across upgrades, excluded from a pack.
	RoleUserData
	// RoleExtraneous is neither read nor produced by anything in the project.
	RoleExtraneous
)

func (r Role) String() string {
	switch r {
	case RoleRuntime:
		return "runtime"
	case RoleBuildInput:
		return "build input"
	case RoleUserData:
		return "user data"
	default:
		return "extraneous"
	}
}

// Entry describes one file or directory the project knows about.
type Entry struct {
	// Path is relative to the data directory. A trailing slash marks a
	// directory whose whole subtree carries this role.
	Path string
	Role Role
	// Required is true when the application cannot work without it. Only
	// meaningful for RoleRuntime.
	Required bool
	// ReadBy cites the source location that opens this path, so a reader of
	// the report can go and check the claim.
	ReadBy string
	// Why explains, in the report, what breaks without it.
	Why string
}

// KnownEntries is the full inventory of paths the project reads or produces.
// Anything in the data directory that matches none of these is extraneous.
var KnownEntries = []Entry{
	{
		Path:     "datapack.gpkg",
		Role:     RoleRuntime,
		Required: true,
		ReadBy:   "internal/geodata/gpkg_store.go:NewGpkgStore",
		Why:      "the scenario and catchment data; the filename is hardcoded and no other name is discovered",
	},
	{
		Path:     "metadata.csv",
		Role:     RoleRuntime,
		Required: false,
		ReadBy:   "internal/api/metadata_cache.go:loadMetadataCache",
		Why:      "indicator labels, units and chart settings; without it the metadata endpoints return empty responses",
	},
	{
		Path:     "NPP_by_treecover.csv",
		Role:     RoleRuntime,
		Required: false,
		ReadBy:   "internal/api/lookups.go:LoadLookupTables",
		Why:      "net primary productivity by tree cover; without it proportional scaling is used instead",
	},
	{
		Path:     "deltaSOC_bytcc_Mgha.csv",
		Role:     RoleRuntime,
		Required: false,
		ReadBy:   "internal/api/lookups.go:LoadLookupTables",
		Why:      "soil organic carbon change by tree cover; without it proportional scaling is used instead",
	},
	{
		Path:     "herb_traits_ready.csv",
		Role:     RoleRuntime,
		Required: false,
		ReadBy:   "internal/api/lookups.go:LoadLookupTables",
		Why:      "herbivore traits used by the species calculations",
	},
	{
		Path:     "mbtiles/",
		Role:     RoleRuntime,
		Required: true,
		ReadBy:   "internal/tiles/mbtiles.go:NewMBTilesStore",
		Why:      "the vector basemap tiles",
	},
	{
		Path:     "walkthroughs/",
		Role:     RoleRuntime,
		Required: false,
		ReadBy:   "internal/server/server.go (/data/walkthroughs/)",
		Why:      "the guided walkthrough site definitions",
	},
	{
		Path:     "demo/",
		Role:     RoleRuntime,
		Required: false,
		ReadBy:   "internal/server/server.go (/data/demo/)",
		Why:      "demo site definitions offered in the setup guide",
	},
	{
		Path:     "images/",
		Role:     RoleUserData,
		Required: false,
		ReadBy:   "internal/sites/sites.go, internal/server/server.go (/data/images/)",
		Why:      "images attached to saved sites",
	},
	{
		Path:     "sites/",
		Role:     RoleUserData,
		Required: false,
		ReadBy:   "internal/sites/sites.go",
		Why:      "sites saved by the user; never distributed in a data pack",
	},

	// Build inputs: read by scripts/build-geopackage.sh to produce
	// datapack.gpkg, and by nothing at runtime.
	{Path: "catchments.gpkg", Role: RoleBuildInput, ReadBy: "scripts/build-geopackage.sh", Why: "catchment geometries"},
	{Path: "current.csv", Role: RoleBuildInput, ReadBy: "scripts/build-geopackage.sh", Why: "current scenario metrics"},
	{Path: "current_lower.csv", Role: RoleBuildInput, ReadBy: "scripts/build-geopackage.sh", Why: "current scenario lower whisker bounds"},
	{Path: "current_upper.csv", Role: RoleBuildInput, ReadBy: "scripts/build-geopackage.sh", Why: "current scenario upper whisker bounds"},
	{Path: "reference.csv", Role: RoleBuildInput, ReadBy: "scripts/build-geopackage.sh", Why: "reference scenario metrics"},
	{Path: "reference_lower.csv", Role: RoleBuildInput, ReadBy: "scripts/build-geopackage.sh", Why: "reference scenario lower whisker bounds"},
	{Path: "reference_upper.csv", Role: RoleBuildInput, ReadBy: "scripts/build-geopackage.sh", Why: "reference scenario upper whisker bounds"},
}

// GeoPackageTable describes one table the runtime expects inside datapack.gpkg.
type GeoPackageTable struct {
	Name     string
	Required bool
	// Columns that must exist on the table.
	Columns []string
	ReadBy  string
	Why     string
}

// GeoPackageTables is what internal/geodata queries. The names are hardcoded in
// its SQL, so a differently named table is simply never read.
var GeoPackageTables = []GeoPackageTable{
	{
		Name:     "catchments_lev12",
		Required: true,
		Columns:  []string{"HYBAS_ID", "HYBAS_ID_int"},
		ReadBy:   "internal/geodata/gpkg_store.go",
		Why:      "catchment geometries and the join key every scenario query uses",
	},
	{
		Name:     "scenario_current",
		Required: true,
		Columns:  []string{"catchment_id_int"},
		ReadBy:   "internal/geodata/gpkg_store.go:loadColumns",
		Why:      "the current scenario; also the source of the authoritative column list",
	},
	{
		Name:     "scenario_reference",
		Required: true,
		Columns:  []string{"catchment_id_int"},
		ReadBy:   "internal/geodata/gpkg_store.go",
		Why:      "the reference scenario",
	},
	{
		Name:     "rtree_catchments_lev12_geom",
		Required: true,
		ReadBy:   "internal/geodata/gpkg_store.go",
		Why:      "the spatial index; without it every viewport query falls back to a full table scan",
	},
	{
		Name:     "scenario_current_lower",
		Required: false,
		ReadBy:   "internal/geodata/whisker_store.go:ComputeWhiskerBounds",
		Why:      "lower whisker bounds for the current scenario",
	},
	{
		Name:     "scenario_current_upper",
		Required: false,
		ReadBy:   "internal/geodata/whisker_store.go:ComputeWhiskerBounds",
		Why:      "upper whisker bounds for the current scenario",
	},
	{
		Name:     "scenario_reference_lower",
		Required: false,
		ReadBy:   "internal/geodata/whisker_store.go:ComputeWhiskerBounds",
		Why:      "lower whisker bounds for the reference scenario",
	},
	{
		Name:     "scenario_reference_upper",
		Required: false,
		ReadBy:   "internal/geodata/whisker_store.go:ComputeWhiskerBounds",
		Why:      "upper whisker bounds for the reference scenario",
	},
}

// RequiredTilesetName is the tileset the server asks for by name. It is derived
// from the .mbtiles filename, so a file called anything else registers a
// tileset nothing ever requests and the map renders blank.
const RequiredTilesetName = "africa"

// MetadataColumnName is the one metadata.csv column without which the whole
// file is discarded.
const MetadataColumnName = "ColumnName"

// IgnoredNames are entries that are neither content nor a fault: editor and
// filesystem debris that should simply be left out of a pack.
var IgnoredNames = []string{
	".DS_Store",
	"Thumbs.db",
	".gitkeep",
	".gitignore",
}
