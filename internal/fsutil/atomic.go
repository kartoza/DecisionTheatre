// Package fsutil holds small filesystem helpers shared across the application.
package fsutil

import (
	"fmt"
	"os"
	"path/filepath"
)

// WriteFileAtomic writes data to path so that a reader sees either the previous
// contents or the new ones, never a partial file.
//
// os.WriteFile truncates the destination and then writes into it. A crash, a full
// disk or a power loss between those two steps leaves an empty or half-written
// file — which for a site means losing the whole site rather than losing one edit.
// The window is small and the consequence is total, which is the combination worth
// removing.
//
// The write goes to a temporary file in the same directory, is flushed to disk,
// and is then renamed over the target. Rename within a directory is atomic on
// POSIX and on Windows via MoveFileEx, so the destination is only ever the old
// file or the complete new one.
//
// The directory itself is flushed afterwards where the platform supports it, so
// that the rename survives a power loss rather than merely a process crash. That
// step is best-effort: it is not supported everywhere, and failing it does not
// make the write any less complete than os.WriteFile left it.
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)

	// Same directory as the target, or the rename would cross filesystems and
	// stop being atomic.
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return fmt.Errorf("creating a temporary file next to %s: %w", path, err)
	}
	tmpName := tmp.Name()

	// Remove the temporary file on any failure. Harmless once the rename has
	// succeeded, since the name no longer exists.
	defer func() {
		_ = os.Remove(tmpName)
	}()

	if _, err := tmp.Write(data); err != nil {
		tmp.Close() //nolint:errcheck // the write error is the one worth reporting
		return fmt.Errorf("writing %s: %w", tmpName, err)
	}

	// Flush before the rename. Without this the rename can be durable while the
	// contents are not, which is the failure this function exists to prevent.
	if err := tmp.Sync(); err != nil {
		tmp.Close() //nolint:errcheck // the flush error is the one worth reporting
		return fmt.Errorf("flushing %s: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("closing %s: %w", tmpName, err)
	}

	// CreateTemp makes the file 0600; the caller's permissions are applied before
	// it becomes visible under the target name.
	if err := os.Chmod(tmpName, perm); err != nil {
		return fmt.Errorf("setting permissions on %s: %w", tmpName, err)
	}

	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replacing %s: %w", path, err)
	}

	syncDir(dir)
	return nil
}

// syncDir flushes a directory entry so a rename survives power loss.
//
// Best-effort by design: opening a directory for sync is not portable, and on
// platforms where it fails the write is still no worse off than a plain
// os.WriteFile would have left it.
func syncDir(dir string) {
	d, err := os.Open(dir)
	if err != nil {
		return
	}
	defer d.Close()
	_ = d.Sync()
}
