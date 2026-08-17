package datacheck

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// openPack reads the archive and returns its entries keyed by archive path.
func openPack(t *testing.T, path string) map[string]*zip.File {
	t.Helper()
	zr, err := zip.OpenReader(path)
	if err != nil {
		t.Fatalf("opening pack: %v", err)
	}
	t.Cleanup(func() { _ = zr.Close() })

	out := make(map[string]*zip.File, len(zr.File))
	for _, f := range zr.File {
		out[f.Name] = f
	}
	return out
}

func readPackFile(t *testing.T, f *zip.File) []byte {
	t.Helper()
	rc, err := f.Open()
	if err != nil {
		t.Fatalf("opening %s: %v", f.Name, err)
	}
	defer func() { _ = rc.Close() }()
	b, err := io.ReadAll(rc)
	if err != nil {
		t.Fatalf("reading %s: %v", f.Name, err)
	}
	return b
}

func TestBuildPackProducesArchiveManifestAndChecksum(t *testing.T) {
	dir := buildFixture(t)
	out := filepath.Join(t.TempDir(), "pack.zip")

	stamp := time.Date(2026, 8, 16, 12, 0, 0, 0, time.UTC)
	report, manifest, err := BuildPack(PackOptions{
		DataDir: dir,
		OutPath: out,
		Version: "1.2.3",
		Now:     stamp,
	})
	if err != nil {
		t.Fatalf("BuildPack: %v", err)
	}
	if !report.OK() {
		t.Fatal("fixture should have passed the check")
	}

	for _, side := range []string{out, out + ".sha256", out + ".manifest.json"} {
		if _, err := os.Stat(side); err != nil {
			t.Errorf("expected %s to exist: %v", filepath.Base(side), err)
		}
	}
	if _, err := os.Stat(out + ".partial"); err == nil {
		t.Error("the temporary .partial file was left behind")
	}

	if manifest.Created != "2026-08-16T12:00:00Z" {
		t.Errorf("manifest Created = %q, want the supplied timestamp", manifest.Created)
	}
	if manifest.Version != "1.2.3" {
		t.Errorf("manifest Version = %q", manifest.Version)
	}
	if manifest.Format != ManifestFormat {
		t.Errorf("manifest Format = %q, want %q", manifest.Format, ManifestFormat)
	}
	if manifest.FileCount == 0 || manifest.TotalSize == 0 {
		t.Error("manifest records no files")
	}
	if !manifest.CheckSummary.OK || manifest.CheckSummary.Forced {
		t.Error("manifest should record a clean, unforced check")
	}
}

func TestPackContainsRuntimeFilesUnderOneRoot(t *testing.T) {
	dir := buildFixture(t)
	out := filepath.Join(t.TempDir(), "pack.zip")

	if _, _, err := BuildPack(PackOptions{DataDir: dir, OutPath: out, Version: "9.9.9"}); err != nil {
		t.Fatalf("BuildPack: %v", err)
	}

	files := openPack(t, out)

	root := "decision-theatre-data-v9.9.9"
	for name := range files {
		if !strings.HasPrefix(name, root+"/") {
			t.Errorf("archive entry %q escapes the pack root %q", name, root)
		}
	}

	for _, want := range []string{
		root + "/" + ManifestFile,
		root + "/data/datapack.gpkg",
		root + "/data/metadata.csv",
		root + "/data/mbtiles/africa.mbtiles",
	} {
		if files[want] == nil {
			t.Errorf("archive is missing %q", want)
		}
	}
}

func TestPackExcludesBuildInputsUserDataAndJunk(t *testing.T) {
	dir := buildFixture(t)
	writeFile(t, filepath.Join(dir, "current.csv"), "a,b\n1,2\n")
	writeFile(t, filepath.Join(dir, "notes.txt"), "scratch\n")
	if err := os.MkdirAll(filepath.Join(dir, "sites"), 0o755); err != nil {
		t.Fatal(err)
	}
	writeFile(t, filepath.Join(dir, "sites", "mine.json"), "{}\n")

	out := filepath.Join(t.TempDir(), "pack.zip")
	_, manifest, err := BuildPack(PackOptions{DataDir: dir, OutPath: out, Version: "1.0.0"})
	if err != nil {
		t.Fatalf("BuildPack: %v", err)
	}

	files := openPack(t, out)
	for name := range files {
		for _, unwanted := range []string{"current.csv", "notes.txt", "sites/"} {
			if strings.Contains(name, unwanted) {
				t.Errorf("archive contains %q, which should have been excluded (entry %q)", unwanted, name)
			}
		}
	}

	// And the manifest must say so, rather than leaving the omission silent.
	excluded := map[string]string{}
	for _, e := range manifest.Excluded {
		excluded[e.Path] = e.Reason
	}
	for _, want := range []string{"current.csv", "notes.txt", "sites"} {
		if excluded[want] == "" {
			t.Errorf("manifest does not explain why %q was excluded", want)
		}
	}
}

func TestBuildPackRefusesWhenCheckFails(t *testing.T) {
	dir := buildFixture(t)
	if err := os.Remove(filepath.Join(dir, "datapack.gpkg")); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "pack.zip")

	report, manifest, err := BuildPack(PackOptions{DataDir: dir, OutPath: out, Version: "1.0.0"})
	if !errors.Is(err, ErrCheckFailed) {
		t.Fatalf("expected ErrCheckFailed, got %v", err)
	}
	if manifest != nil {
		t.Error("no manifest should be produced for a refused pack")
	}
	if report == nil {
		t.Fatal("the report must still be returned so the caller can explain the refusal")
	}
	if _, err := os.Stat(out); err == nil {
		t.Error("a refused pack must not leave an archive behind")
	}
}

func TestBuildPackForceOverridesAndRecordsIt(t *testing.T) {
	dir := buildFixture(t)
	if err := os.Remove(filepath.Join(dir, "datapack.gpkg")); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "pack.zip")

	_, manifest, err := BuildPack(PackOptions{
		DataDir: dir, OutPath: out, Version: "1.0.0", Force: true,
	})
	if err != nil {
		t.Fatalf("BuildPack with Force: %v", err)
	}
	if _, err := os.Stat(out); err != nil {
		t.Fatalf("forced pack was not written: %v", err)
	}
	if !manifest.CheckSummary.Forced {
		t.Error("the manifest must record that the pack was forced past errors")
	}
	if manifest.CheckSummary.Errors == 0 {
		t.Error("the manifest must record how many errors were overridden")
	}
}

func TestManifestChecksumsMatchArchiveContents(t *testing.T) {
	dir := buildFixture(t)
	out := filepath.Join(t.TempDir(), "pack.zip")

	_, manifest, err := BuildPack(PackOptions{DataDir: dir, OutPath: out, Version: "1.0.0"})
	if err != nil {
		t.Fatalf("BuildPack: %v", err)
	}

	files := openPack(t, out)
	root := "decision-theatre-data-v1.0.0"

	if len(manifest.Files) == 0 {
		t.Fatal("manifest lists no files")
	}
	for _, entry := range manifest.Files {
		f := files[root+"/data/"+entry.Path]
		if f == nil {
			t.Errorf("manifest names %q but the archive has no such entry", entry.Path)
			continue
		}
		content := readPackFile(t, f)
		if int64(len(content)) != entry.Size {
			t.Errorf("%s: manifest size %d, archive holds %d", entry.Path, entry.Size, len(content))
		}
		if entry.SHA256 == "" {
			t.Errorf("%s: manifest carries no checksum", entry.Path)
		}
	}
}

func TestManifestInsideArchiveMatchesTheOneBesideIt(t *testing.T) {
	dir := buildFixture(t)
	out := filepath.Join(t.TempDir(), "pack.zip")

	if _, _, err := BuildPack(PackOptions{DataDir: dir, OutPath: out, Version: "2.0.0"}); err != nil {
		t.Fatalf("BuildPack: %v", err)
	}

	files := openPack(t, out)
	inner := files["decision-theatre-data-v2.0.0/"+ManifestFile]
	if inner == nil {
		t.Fatal("archive has no manifest")
	}

	var fromArchive, fromDisk Manifest
	if err := json.Unmarshal(readPackFile(t, inner), &fromArchive); err != nil {
		t.Fatalf("manifest in archive is not valid JSON: %v", err)
	}
	b, err := os.ReadFile(out + ".manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &fromDisk); err != nil {
		t.Fatalf("manifest beside archive is not valid JSON: %v", err)
	}

	if fromArchive.Created != fromDisk.Created || fromArchive.FileCount != fromDisk.FileCount {
		t.Error("the two copies of the manifest disagree")
	}
}

func TestChecksumFileIsInSha256sumFormat(t *testing.T) {
	dir := buildFixture(t)
	out := filepath.Join(t.TempDir(), "pack.zip")

	if _, _, err := BuildPack(PackOptions{DataDir: dir, OutPath: out, Version: "1.0.0"}); err != nil {
		t.Fatalf("BuildPack: %v", err)
	}

	b, err := os.ReadFile(out + ".sha256")
	if err != nil {
		t.Fatal(err)
	}
	line := strings.TrimSpace(string(b))
	parts := strings.Fields(line)
	if len(parts) != 2 {
		t.Fatalf("checksum line %q is not '<hash>  <filename>'", line)
	}
	if len(parts[0]) != 64 {
		t.Errorf("hash %q is not a 64-character SHA-256", parts[0])
	}
	if parts[1] != filepath.Base(out) {
		t.Errorf("checksum names %q, want %q", parts[1], filepath.Base(out))
	}

	// And it must agree with the archive as written.
	want, err := fileSHA256(out)
	if err != nil {
		t.Fatal(err)
	}
	if parts[0] != want {
		t.Error("the recorded checksum does not match the archive")
	}
}

func TestRenderManifestMentionsTheEssentials(t *testing.T) {
	dir := buildFixture(t)
	out := filepath.Join(t.TempDir(), "pack.zip")

	_, manifest, err := BuildPack(PackOptions{DataDir: dir, OutPath: out, Version: "3.1.4"})
	if err != nil {
		t.Fatalf("BuildPack: %v", err)
	}

	var sb strings.Builder
	if err := RenderManifest(&sb, manifest, out); err != nil {
		t.Fatalf("RenderManifest: %v", err)
	}
	got := sb.String()

	for _, want := range []string{"Data pack built", "3.1.4", "packaged", "check", "passed"} {
		if !strings.Contains(got, want) {
			t.Errorf("summary is missing %q\n---\n%s", want, got)
		}
	}
}
