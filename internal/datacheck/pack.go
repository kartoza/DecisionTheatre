package datacheck

import (
	"archive/zip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// ManifestFormat identifies the archive layout. Bump it only for a change the
// installer in internal/server/datapack.go cannot read.
const ManifestFormat = "decision-theatre-datapack"

// ManifestFile is the name of the manifest inside the archive. The installer
// looks for exactly this name.
const ManifestFile = "manifest.json"

// ManifestEntry records one packed file, so an installation can be verified
// against the manifest without unpacking the whole archive.
type ManifestEntry struct {
	Path   string `json:"path"`
	Size   int64  `json:"size_bytes"`
	SHA256 string `json:"sha256"`
}

// Manifest describes a data pack: what it holds, when it was built, and from
// what. It is written into the archive and also alongside it.
type Manifest struct {
	Format  string `json:"format"`
	Version string `json:"version"`
	// Created is the packaging timestamp, in UTC and RFC 3339.
	Created     string `json:"created"`
	Description string `json:"description"`
	// BuiltBy records the tool and version that produced the pack.
	BuiltBy string `json:"built_by"`
	// SourceDir is the directory the pack was assembled from.
	SourceDir string `json:"source_dir"`

	// CheckSummary records the state of the data directory at packaging time,
	// so a pack always carries evidence that it was validated.
	CheckSummary CheckSummary `json:"check"`

	TotalSize int64           `json:"total_size_bytes"`
	FileCount int             `json:"file_count"`
	Files     []ManifestEntry `json:"files"`

	// Excluded lists what was deliberately left out and why, so the absence of
	// a 250 MB CSV is never mistaken for an accident.
	Excluded []ExclusionNote `json:"excluded,omitempty"`
}

// CheckSummary is the checker's verdict, embedded in the manifest.
type CheckSummary struct {
	OK       bool `json:"ok"`
	Errors   int  `json:"errors"`
	Warnings int  `json:"warnings"`
	// Forced is true when the pack was built despite errors.
	Forced bool `json:"forced,omitempty"`
}

// ExclusionNote explains one omission.
type ExclusionNote struct {
	Path   string `json:"path"`
	Role   string `json:"role"`
	Reason string `json:"reason"`
	Size   int64  `json:"size_bytes"`
}

// PackOptions configures BuildPack.
type PackOptions struct {
	// DataDir is the directory to pack.
	DataDir string
	// OutPath is the .zip to write.
	OutPath string
	// Version labels the pack, and names the directory inside the archive.
	Version string
	// Force builds the pack even when the checker reports errors.
	Force bool
	// Now is the packaging timestamp. Zero means time.Now().
	Now time.Time
	// Progress, when non-nil, receives one line per step.
	Progress io.Writer
}

// ErrCheckFailed is returned when the data directory has errors and Force is
// not set. A pack that cannot be loaded should never leave the machine that
// built it.
var ErrCheckFailed = errors.New("data directory check failed")

// BuildPack validates DataDir and, if it is usable, assembles it into a zip.
//
// It returns the report in all cases — including the failure case — so a caller
// can render the reason the pack was refused.
func BuildPack(opts PackOptions) (*Report, *Manifest, error) {
	report, err := Run(opts.DataDir)
	if err != nil {
		return nil, nil, err
	}

	if !report.OK() && !opts.Force {
		return report, nil, fmt.Errorf("%w: %d error(s) — fix them, or pass --force to package anyway",
			ErrCheckFailed, report.Errors())
	}

	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}

	version := opts.Version
	if version == "" {
		version = "dev"
	}
	// Everything in the archive sits under one directory, so unpacking never
	// scatters files into the current directory.
	packRoot := "decision-theatre-data-v" + version

	manifest := &Manifest{
		Format:      ManifestFormat,
		Version:     version,
		Created:     now.UTC().Format(time.RFC3339),
		Description: "Decision Theatre Data Pack — catchment scenario data and map tiles",
		BuiltBy:     "decision-theatre pack-data " + version,
		SourceDir:   report.DataDir,
		CheckSummary: CheckSummary{
			OK:       report.OK(),
			Errors:   report.Errors(),
			Warnings: report.Warnings(),
			Forced:   !report.OK() && opts.Force,
		},
	}

	for _, p := range report.Inventory {
		if p.Role == RoleRuntime {
			continue
		}
		manifest.Excluded = append(manifest.Excluded, ExclusionNote{
			Path:   p.Path,
			Role:   p.Role.String(),
			Reason: exclusionReason(p.Role),
			Size:   p.Size,
		})
	}

	if err := os.MkdirAll(filepath.Dir(opts.OutPath), 0o755); err != nil {
		return report, nil, fmt.Errorf("cannot create output directory: %w", err)
	}

	// Write to a temporary file and rename on success, so an interrupted run
	// never leaves a half-written archive that looks complete.
	tmpPath := opts.OutPath + ".partial"
	out, err := os.Create(tmpPath)
	if err != nil {
		return report, nil, fmt.Errorf("cannot create archive: %w", err)
	}
	// Best-effort cleanup; on the success path the file has been renamed away.
	defer func() { _ = os.Remove(tmpPath) }()
	defer func() { _ = out.Close() }()

	zw := zip.NewWriter(out)

	for _, rel := range report.PackablePaths() {
		src := filepath.Join(report.DataDir, rel)
		progressf(opts.Progress, "  adding %s", rel)
		if err := addPath(zw, src, packRoot+"/data/"+rel, manifest); err != nil {
			_ = zw.Close()
			return report, nil, fmt.Errorf("packing %s: %w", rel, err)
		}
	}

	sort.Slice(manifest.Files, func(i, j int) bool {
		return manifest.Files[i].Path < manifest.Files[j].Path
	})
	for _, f := range manifest.Files {
		manifest.TotalSize += f.Size
	}
	manifest.FileCount = len(manifest.Files)

	// The manifest goes in last, once it knows everything it describes.
	progressf(opts.Progress, "  writing %s", ManifestFile)
	mw, err := zw.Create(packRoot + "/" + ManifestFile)
	if err != nil {
		_ = zw.Close()
		return report, nil, fmt.Errorf("cannot write manifest: %w", err)
	}
	enc := json.NewEncoder(mw)
	enc.SetIndent("", "  ")
	if err := enc.Encode(manifest); err != nil {
		_ = zw.Close()
		return report, nil, fmt.Errorf("cannot encode manifest: %w", err)
	}

	if err := zw.Close(); err != nil {
		return report, nil, fmt.Errorf("cannot finalise archive: %w", err)
	}
	if err := out.Close(); err != nil {
		return report, nil, fmt.Errorf("cannot close archive: %w", err)
	}
	if err := os.Rename(tmpPath, opts.OutPath); err != nil {
		return report, nil, fmt.Errorf("cannot finalise archive: %w", err)
	}

	// A checksum beside the archive, in the format sha256sum -c expects.
	sum, err := fileSHA256(opts.OutPath)
	if err != nil {
		return report, manifest, fmt.Errorf("cannot checksum archive: %w", err)
	}
	sumLine := fmt.Sprintf("%s  %s\n", sum, filepath.Base(opts.OutPath))
	if err := os.WriteFile(opts.OutPath+".sha256", []byte(sumLine), 0o644); err != nil {
		return report, manifest, fmt.Errorf("cannot write checksum: %w", err)
	}

	// And the manifest beside the archive too, so a download page can read the
	// contents without fetching gigabytes.
	manifestBytes, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return report, manifest, fmt.Errorf("cannot encode manifest: %w", err)
	}
	if err := os.WriteFile(opts.OutPath+".manifest.json", append(manifestBytes, '\n'), 0o644); err != nil {
		return report, manifest, fmt.Errorf("cannot write manifest file: %w", err)
	}

	return report, manifest, nil
}

func exclusionReason(r Role) string {
	switch r {
	case RoleBuildInput:
		return "input to scripts/build-geopackage.sh; not read at runtime"
	case RoleUserData:
		return "belongs to the installation, not to the pack"
	case RoleExtraneous:
		return "nothing in the project reads it"
	default:
		return ""
	}
}

// addPath writes one file, or a directory tree, into the archive.
func addPath(zw *zip.Writer, src, dest string, manifest *Manifest) error {
	info, err := os.Stat(src)
	if err != nil {
		return err
	}

	if !info.IsDir() {
		return addFile(zw, src, dest, info, manifest)
	}

	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		fi, err := d.Info()
		if err != nil {
			return err
		}
		// Zip paths are always slash-separated, whatever the host filesystem.
		return addFile(zw, path, dest+"/"+filepath.ToSlash(rel), fi, manifest)
	})
}

func addFile(zw *zip.Writer, src, dest string, info os.FileInfo, manifest *Manifest) error {
	f, err := os.Open(src)
	if err != nil {
		return err
	}
	defer f.Close()

	header, err := zip.FileInfoHeader(info)
	if err != nil {
		return err
	}
	header.Name = dest
	// Deflate on multi-gigabyte SQLite files costs a great deal of CPU for very
	// little gain — mbtiles hold already-compressed tiles. Store them instead
	// and let the smaller text files compress.
	if shouldStore(src) {
		header.Method = zip.Store
	} else {
		header.Method = zip.Deflate
	}

	w, err := zw.CreateHeader(header)
	if err != nil {
		return err
	}

	// Hash while copying, so the file is read once rather than twice.
	h := sha256.New()
	written, err := io.Copy(io.MultiWriter(w, h), f)
	if err != nil {
		return err
	}

	manifest.Files = append(manifest.Files, ManifestEntry{
		// Paths in the manifest are relative to the data directory, which is
		// what an installer needs; the archive prefix is an archive detail.
		Path:   strings.TrimPrefix(dest, manifestPrefix(dest)),
		Size:   written,
		SHA256: hex.EncodeToString(h.Sum(nil)),
	})
	return nil
}

// manifestPrefix returns the "<pack>/data/" prefix of an archive path, so the
// manifest can record paths relative to the data directory.
func manifestPrefix(dest string) string {
	if i := strings.Index(dest, "/data/"); i >= 0 {
		return dest[:i+len("/data/")]
	}
	return ""
}

// shouldStore reports whether a file is already compressed and should be
// stored rather than deflated.
func shouldStore(path string) bool {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mbtiles", ".gpkg", ".png", ".jpg", ".jpeg", ".webp", ".zip", ".gz":
		return true
	}
	return false
}

func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// progressf reports one step. Progress output is advisory, so a failed write
// is deliberately ignored rather than aborting a pack that is otherwise fine.
func progressf(w io.Writer, format string, args ...any) {
	if w == nil {
		return
	}
	_, _ = fmt.Fprintf(w, format+"\n", args...)
}

// RenderManifest writes a human-readable summary of a built pack.
func RenderManifest(w io.Writer, m *Manifest, archivePath string) error {
	s := style{enabled: isTerminal(w)}
	out := &errWriter{w: w}

	fi, err := os.Stat(archivePath)
	var archiveSize int64
	if err == nil {
		archiveSize = fi.Size()
	}

	out.nl()
	out.println("  " + s.bold("Data pack built"))
	out.nl()
	out.printf("    %-14s %s\n", "archive", archivePath)
	out.printf("    %-14s %s\n", "size", humanSize(archiveSize))
	out.printf("    %-14s %s\n", "version", m.Version)
	out.printf("    %-14s %s\n", "packaged", m.Created)
	out.printf("    %-14s %d\n", "files", m.FileCount)
	out.printf("    %-14s %s\n", "uncompressed", humanSize(m.TotalSize))

	verdict := s.green("passed")
	if m.CheckSummary.Forced {
		verdict = s.red(fmt.Sprintf("FORCED past %d error(s)", m.CheckSummary.Errors))
	} else if m.CheckSummary.Warnings > 0 {
		verdict = s.green("passed") + s.dim(fmt.Sprintf(" (%d warning%s)",
			m.CheckSummary.Warnings, plural(m.CheckSummary.Warnings)))
	}
	out.printf("    %-14s %s\n", "check", verdict)

	if len(m.Excluded) > 0 {
		var excludedSize int64
		for _, e := range m.Excluded {
			excludedSize += e.Size
		}
		out.nl()
		out.printf("    %s %s\n", s.dim("excluded"),
			s.dim(fmt.Sprintf("%d entries · %s", len(m.Excluded), humanSize(excludedSize))))
		for _, e := range m.Excluded {
			out.printf("      %-26s %s\n", e.Path, s.dim(e.Reason))
		}
	}

	out.nl()
	out.printf("    %s\n", s.dim("checksum: "+filepath.Base(archivePath)+".sha256"))
	out.printf("    %s\n", s.dim("manifest: "+filepath.Base(archivePath)+".manifest.json"))
	out.nl()
	return out.err
}
