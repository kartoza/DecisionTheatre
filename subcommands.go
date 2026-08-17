package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"github.com/kartoza/decision-theatre/internal/datacheck"
)

// Subcommands live in the same binary as the application so that the checker
// runs against the very packages the application loads with. A separate tool
// would have to restate the runtime's expectations, which is exactly the drift
// scripts/validate-data.sh used to suffer from.

// usage prints the top-level help.
func usage() {
	fmt.Fprintf(os.Stderr, `Decision Theatre v%s

Usage:
  decision-theatre [flags]              Run the application
  decision-theatre check-data [dir]     Check a data directory and report on it
  decision-theatre pack-data [dir]      Check, then build a distributable pack

Run flags:
  --port N              HTTP port (default 8080)
  --data-dir DIR        Data directory. Defaults to saved settings, then ./data,
                        then the per-user data directory.
  --resources-dir DIR   Resources directory (default ./resources)
  --headless            Run as a web server with no desktop window
  --version             Print the version and exit

Run "decision-theatre check-data --help" for that subcommand's flags.
`, version)
}

// runSubcommand dispatches argv[1] when it names a subcommand. It reports
// whether it handled the arguments, and the process exit code.
func runSubcommand(args []string) (handled bool, code int) {
	if len(args) < 2 {
		return false, 0
	}

	switch args[1] {
	case "check-data":
		return true, cmdCheckData(args[2:])
	case "pack-data":
		return true, cmdPackData(args[2:])
	case "help", "--help", "-h":
		usage()
		return true, 0
	}
	return false, 0
}

// defaultDataDir mirrors the application's own preference for ./data, so the
// checker examines the directory the app would actually open.
const defaultDataDir = "./data"

func cmdCheckData(args []string) int {
	fs := flag.NewFlagSet("check-data", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "Emit the report as JSON instead of text")
	quiet := fs.Bool("quiet", false, "Print nothing; report the result through the exit status only")
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, `Usage: decision-theatre check-data [flags] [DIR]

Checks a data directory against what the application actually reads: the
GeoPackage tables and their columns, the tileset name, metadata.csv
cross-referenced against the columns that really exist, the lookup tables, and
any content that nothing in the project reads.

DIR defaults to %s.

Exit status:
  0  no errors (warnings may still be present)
  1  one or more errors — the application will not work correctly
  2  the directory could not be examined at all

Flags:
`, defaultDataDir)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}

	dir := defaultDataDir
	if fs.NArg() > 0 {
		dir = fs.Arg(0)
	}

	report, err := datacheck.Run(dir)
	if err != nil {
		fmt.Fprintf(os.Stderr, "decision-theatre check-data: %v\n", err)
		return 2
	}

	switch {
	case *quiet:
	case *asJSON:
		if err := report.RenderJSON(os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "decision-theatre check-data: %v\n", err)
			return 2
		}
	default:
		if err := report.Render(os.Stdout); err != nil {
			fmt.Fprintf(os.Stderr, "decision-theatre check-data: %v\n", err)
			return 2
		}
	}

	if !report.OK() {
		return 1
	}
	return 0
}

func cmdPackData(args []string) int {
	fs := flag.NewFlagSet("pack-data", flag.ExitOnError)
	out := fs.String("out", "", "Output .zip path (default dist/decision-theatre-data-v<version>.zip)")
	packVersion := fs.String("pack-version", "", "Version label for the pack (default: this binary's version)")
	force := fs.Bool("force", false, "Build the pack even when the check reports errors")
	skipReport := fs.Bool("quiet", false, "Do not print the full check report, only the outcome")
	fs.Usage = func() {
		fmt.Fprintf(os.Stderr, `Usage: decision-theatre pack-data [flags] [DIR]

Checks a data directory and, if it is usable, assembles the runtime files into
a distributable zip. Build inputs, saved user data and extraneous content are
excluded, and the manifest records what was left out and why.

The pack carries a manifest with the packaging date, the version, a per-file
SHA-256 inventory, and the checker's verdict at the time it was built.

DIR defaults to %s.

Exit status:
  0  the pack was built
  1  the check failed and --force was not given
  2  the directory could not be examined, or the pack could not be written

Flags:
`, defaultDataDir)
		fs.PrintDefaults()
	}
	if err := fs.Parse(args); err != nil {
		return 2
	}

	dir := defaultDataDir
	if fs.NArg() > 0 {
		dir = fs.Arg(0)
	}

	label := *packVersion
	if label == "" {
		label = version
	}

	outPath := *out
	if outPath == "" {
		outPath = filepath.Join("dist", "decision-theatre-data-v"+label+".zip")
	}

	fmt.Printf("Building data pack from %s\n", dir)

	report, manifest, err := datacheck.BuildPack(datacheck.PackOptions{
		DataDir:  dir,
		OutPath:  outPath,
		Version:  label,
		Force:    *force,
		Progress: os.Stdout,
	})

	// The report is worth showing whether or not the pack was built: on success
	// it is the evidence, on failure it is the explanation.
	if report != nil && !*skipReport {
		_ = report.Render(os.Stdout)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "decision-theatre pack-data: %v\n", err)
		if errors.Is(err, datacheck.ErrCheckFailed) {
			return 1
		}
		return 2
	}

	if err := datacheck.RenderManifest(os.Stdout, manifest, outPath); err != nil {
		fmt.Fprintf(os.Stderr, "decision-theatre pack-data: %v\n", err)
		return 2
	}
	return 0
}
