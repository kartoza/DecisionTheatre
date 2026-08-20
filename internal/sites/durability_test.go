package sites

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

// Two faults in the site persistence path.
//
// Every write is a read-modify-write with no lock, so two concurrent updates both
// read the original and the second silently discards the first — a user editing
// indicators in two panes loses one panel's recalculation, with no error to say
// so.
//
// And every write used os.WriteFile, which truncates the destination before
// writing. A crash between those two steps leaves an empty file: the whole site
// gone, rather than one edit.

func newStore(t *testing.T) *Store {
	t.Helper()

	store, err := NewStore(t.TempDir())
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	return store
}

// Concurrent updates to different fields must all survive. Under the old code the
// last writer won and the rest were lost.
func TestConcurrentUpdatesDoNotLoseEachOther(t *testing.T) {
	store := newStore(t)

	site, err := store.Create(&Site{Title: "start"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	// Each goroutine appends one distinct catchment id, so a lost update is
	// visible as a missing entry rather than as a coincidence.
	const writers = 8
	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()

			unlock := store.LockSite(site.ID)
			defer unlock()

			current, err := store.Get(site.ID)
			if err != nil {
				t.Errorf("Get: %v", err)
				return
			}
			ids := append(current.CatchmentIDs, string(rune('a'+n)))
			if _, err := store.UpdateLocked(site.ID, &Site{CatchmentIDs: ids}); err != nil {
				t.Errorf("UpdateLocked: %v", err)
			}
		}(i)
	}
	wg.Wait()

	final, err := store.Get(site.ID)
	if err != nil {
		t.Fatalf("Get: %v", err)
	}
	if len(final.CatchmentIDs) != writers {
		t.Errorf("%d of %d updates survived; the rest were silently discarded",
			len(final.CatchmentIDs), writers)
	}
}

// Two updates to *different* fields, through the exported Update. Each does its
// own read-modify-write internally, so without a lock both read the original,
// each sets its own field, and the second write discards the other's — one field
// silently reverts.
func TestConcurrentUpdatesToDifferentFieldsBothLand(t *testing.T) {
	store := newStore(t)

	// Repeated because a lost update is a race: one round may happen to interleave
	// safely, and the point is that it cannot.
	for round := 0; round < 40; round++ {
		site, err := store.Create(&Site{Title: "before", Description: "before"})
		if err != nil {
			t.Fatalf("Create: %v", err)
		}

		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			if _, err := store.Update(site.ID, &Site{Title: "after"}); err != nil {
				t.Errorf("Update title: %v", err)
			}
		}()
		go func() {
			defer wg.Done()
			if _, err := store.Update(site.ID, &Site{Description: "after"}); err != nil {
				t.Errorf("Update description: %v", err)
			}
		}()
		wg.Wait()

		final, err := store.Get(site.ID)
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if final.Title != "after" || final.Description != "after" {
			t.Fatalf("round %d: title=%q description=%q — one update was discarded",
				round, final.Title, final.Description)
		}
	}
}

// The same through the exported Update, which takes the lock itself.
func TestConcurrentUpdateCallsAreSerialised(t *testing.T) {
	store := newStore(t)

	site, err := store.Create(&Site{Title: "start"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			title := strings.Repeat("x", n+1)
			if _, err := store.Update(site.ID, &Site{Title: title}); err != nil {
				t.Errorf("Update: %v", err)
			}
		}(i)
	}
	wg.Wait()

	// Whichever won, the file must be one complete site rather than a mixture.
	final, err := store.Get(site.ID)
	if err != nil {
		t.Fatalf("Get after concurrent updates: %v", err)
	}
	if final.Title == "" {
		t.Error("the surviving site has no title")
	}
}

// Locks are per site: work on one must not wait on another.
func TestLocksAreIndependentPerSite(t *testing.T) {
	store := newStore(t)

	first, err := store.Create(&Site{Title: "first"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	second, err := store.Create(&Site{Title: "second"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}

	unlock := store.LockSite(first.ID)
	defer unlock()

	// Would block forever on a single global lock.
	done := make(chan struct{})
	go func() {
		defer close(done)
		if _, err := store.Update(second.ID, &Site{Title: "changed"}); err != nil {
			t.Errorf("Update on an unrelated site: %v", err)
		}
	}()

	<-done
}

// A site file must never be observed empty or half-written.
func TestSaveIsAtomic(t *testing.T) {
	store := newStore(t)

	site, err := store.Create(&Site{Title: "original"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	path := filepath.Join(store.sitesDir, site.ID+".json")

	// Read the file continuously while it is rewritten. Every read must parse.
	stop := make(chan struct{})
	var readerWG sync.WaitGroup
	readerWG.Add(1)
	go func() {
		defer readerWG.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			data, err := os.ReadFile(path)
			if err != nil {
				continue // the file is never absent, but a read may race the rename
			}
			var parsed Site
			if err := json.Unmarshal(data, &parsed); err != nil {
				t.Errorf("read a partial site file (%d bytes): %v", len(data), err)
				return
			}
			if parsed.ID == "" {
				t.Errorf("read a site file with no id: %s", string(data))
				return
			}
		}
	}()

	for i := 0; i < 200; i++ {
		if _, err := store.Update(site.ID, &Site{Title: strings.Repeat("t", i%50+1)}); err != nil {
			t.Fatalf("Update: %v", err)
		}
	}
	close(stop)
	readerWG.Wait()
}

// The previous contents survive a failed write, rather than the file being
// truncated first and the failure leaving nothing.
func TestAFailedWriteLeavesThePreviousFileIntact(t *testing.T) {
	store := newStore(t)

	site, err := store.Create(&Site{Title: "keep me"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	path := filepath.Join(store.sitesDir, site.ID+".json")

	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading the site: %v", err)
	}

	// Make the directory read-only so the temporary file cannot be created. The
	// write must fail without touching what is already there.
	if err := os.Chmod(store.sitesDir, 0o555); err != nil {
		t.Skipf("cannot make the directory read-only: %v", err)
	}
	// Restore the permissions so the test's t.TempDir cleanup can remove the
	// directory; a failure here would only mask the assertion below.
	defer os.Chmod(store.sitesDir, 0o755) //nolint:errcheck // best-effort cleanup, see above

	if _, err := store.Update(site.ID, &Site{Title: "should not land"}); err == nil {
		t.Skip("the write succeeded despite a read-only directory (running as root?)")
	}

	after, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the site file is gone after a failed write: %v", err)
	}
	if string(after) != string(before) {
		t.Errorf("a failed write changed the file:\nbefore %s\nafter  %s", before, after)
	}
}

// No temporary files are left behind on success.
func TestNoTemporaryFilesRemain(t *testing.T) {
	store := newStore(t)

	site, err := store.Create(&Site{Title: "one"})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	for i := 0; i < 5; i++ {
		if _, err := store.Update(site.ID, &Site{Title: "two"}); err != nil {
			t.Fatalf("Update: %v", err)
		}
	}

	entries, err := os.ReadDir(store.sitesDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp-") || strings.HasPrefix(entry.Name(), ".") {
			t.Errorf("temporary file left behind: %s", entry.Name())
		}
	}
}
