package sites

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Thumbnail references arrive from the client. They used to be stored verbatim
// and later joined onto the data directory and passed to os.Remove, so any
// string the caller chose became a file the process would delete: two requests,
// one PUT and one DELETE, removed anything the process could reach.
//
// These tests cover the shapes that made that work, and the legitimate ones that
// must keep working — a client sends a path back unchanged when a thumbnail is
// not being replaced.

func TestValidThumbnailPathAcceptsWhatSaveThumbnailWrites(t *testing.T) {
	// Exactly the forms saveThumbnail produces, one per extension it derives
	// from the data URL's MIME type.
	for _, p := range []string{
		"/data/images/site-abc123.jpg",
		"/data/images/site-abc123.jpeg",
		"/data/images/site-abc123.png",
		"/data/images/site-abc123.gif",
		"/data/images/site-abc123.webp",
		"/data/images/site-with-dashes_and_underscores.png",
		"/data/images/site-3f2504e0-4f89-11d3-9a0c-0305e82c3301.jpg",
	} {
		if !validThumbnailPath(p) {
			t.Errorf("rejected a path this store writes: %q", p)
		}
	}
}

func TestValidThumbnailPathRejectsEscapes(t *testing.T) {
	cases := map[string]string{
		"parent traversal":            "/data/images/../../etc/passwd",
		"traversal inside the name":   "/data/images/..%2f..%2fetc%2fpasswd",
		"single parent":               "/data/images/../secret.png",
		"absolute path":               "/etc/passwd",
		"absolute masquerading":       "/data/images//etc/passwd",
		"nested directory":            "/data/images/sub/dir.png",
		"wrong directory":             "/data/sites/site-a.json",
		"sibling directory prefix":    "/data/images-backup/site-a.png",
		"no extension":                "/data/images/site-a",
		"disallowed extension":        "/data/images/site-a.json",
		"double extension":            "/data/images/site-a.png.json",
		"empty":                       "",
		"relative":                    "data/images/site-a.png",
		"backslash traversal":         `/data/images/..\..\windows\system32`,
		"null byte":                   "/data/images/site-a.png\x00.json",
		"trailing slash":              "/data/images/site-a.png/",
		"just the directory":          "/data/images/",
		"dot segment":                 "/data/images/./site-a.png",
		"leading whitespace":          " /data/images/site-a.png",
		"scheme":                      "file:///data/images/site-a.png",
		"remote url":                  "https://example.com/data/images/a.png",
		"data url handled separately": "data:image/png;base64,AAAA",
	}

	for name, p := range cases {
		if validThumbnailPath(p) {
			t.Errorf("%s: accepted %q, which this store never writes", name, p)
		}
	}
}

// resolveThumbnailFile is the second gate: it must not return a path outside the
// images directory even if a value slipped past validation, because values
// written before the validation existed are still in the site files on disk.
func TestResolveThumbnailFileConfinesToImagesDir(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	resolved, err := store.resolveThumbnailFile("/data/images/site-a.png")
	if err != nil {
		t.Fatalf("rejected a valid thumbnail: %v", err)
	}

	imagesDir, err := filepath.Abs(filepath.Join(dir, "images"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(resolved, imagesDir+string(filepath.Separator)) {
		t.Errorf("resolved to %q, which is not inside %q", resolved, imagesDir)
	}

	for _, bad := range []string{
		"/data/images/../../etc/passwd",
		"/data/sites/site-a.json",
		"/data/images-backup/site-a.png",
		"/etc/passwd",
	} {
		if got, err := store.resolveThumbnailFile(bad); err == nil {
			t.Errorf("resolved %q to %q instead of refusing", bad, got)
		}
	}
}

// The end-to-end shape of the original attack: store a traversing thumbnail via
// Update, then delete the site and see whether the unrelated file survives.
func TestDeleteCannotRemoveFileOutsideImagesDir(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	// A file that has nothing to do with thumbnails.
	victim := filepath.Join(dir, "victim.txt")
	if err := os.WriteFile(victim, []byte("do not delete me"), 0o644); err != nil {
		t.Fatal(err)
	}

	site, err := store.Create(&Site{Title: "target"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// The write gate should refuse this outright.
	traversal := "/data/images/../victim.txt"
	if _, err := store.Update(site.ID, &Site{Thumbnail: &traversal}); err == nil {
		t.Error("Update accepted a traversing thumbnail path")
	}

	// And even with the value forced into the stored record — as it would be in
	// a site file written before this validation existed — Delete must not act
	// on it.
	stored, err := store.Get(site.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	stored.Thumbnail = &traversal
	if err := store.saveSite(stored); err != nil {
		t.Fatalf("save: %v", err)
	}

	if err := store.Delete(site.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}

	if _, err := os.Stat(victim); err != nil {
		t.Errorf("deleting the site removed an unrelated file: %v", err)
	}
}

// A legitimate thumbnail must still be cleaned up, or every deleted site leaves
// an orphan behind.
func TestDeleteRemovesItsOwnThumbnail(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	site, err := store.Create(&Site{Title: "with thumbnail"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// A one-pixel PNG, so saveThumbnail writes a real file.
	dataURL := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+3TZ9AAAAAElFTkSuQmCC"
	updated, err := store.Update(site.ID, &Site{Thumbnail: &dataURL})
	if err != nil {
		t.Fatalf("Update: %v", err)
	}
	if updated.Thumbnail == nil {
		t.Fatal("no thumbnail was stored")
	}

	onDisk, err := store.resolveThumbnailFile(*updated.Thumbnail)
	if err != nil {
		t.Fatalf("saveThumbnail produced a path its own validator rejects: %v", err)
	}
	if _, err := os.Stat(onDisk); err != nil {
		t.Fatalf("thumbnail was not written: %v", err)
	}

	if err := store.Delete(site.ID); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if _, err := os.Stat(onDisk); !os.IsNotExist(err) {
		t.Errorf("thumbnail survived the site being deleted: %v", err)
	}
}

// An unchanged thumbnail round-trips: the client sends back the path it was
// given, and that must not be treated as an attack.
func TestUpdateAcceptsItsOwnThumbnailPathUnchanged(t *testing.T) {
	dir := t.TempDir()
	store, err := NewStore(dir)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}

	site, err := store.Create(&Site{Title: "round trip"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	dataURL := "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AL+3TZ9AAAAAElFTkSuQmCC"
	withThumb, err := store.Update(site.ID, &Site{Thumbnail: &dataURL})
	if err != nil {
		t.Fatalf("Update with data URL: %v", err)
	}

	again, err := store.Update(site.ID, &Site{Thumbnail: withThumb.Thumbnail})
	if err != nil {
		t.Fatalf("Update with the stored path: %v", err)
	}
	if again.Thumbnail == nil || *again.Thumbnail != *withThumb.Thumbnail {
		t.Errorf("thumbnail changed on a no-op update: %v", again.Thumbnail)
	}
}
