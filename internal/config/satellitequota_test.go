package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestSatelliteUsageIncrementsAndReportsExceeded(t *testing.T) {
	usage, err := LoadSatelliteUsage(t.TempDir())
	if err != nil {
		t.Fatalf("LoadSatelliteUsage: %v", err)
	}

	for i := 1; i <= 2; i++ {
		count, exceeded := usage.Increment(3)
		if count != i {
			t.Errorf("count = %d, want %d", count, i)
		}
		if exceeded {
			t.Errorf("exceeded = true at count %d, want false", count)
		}
	}

	count, exceeded := usage.Increment(3)
	if count != 3 {
		t.Errorf("count = %d, want 3", count)
	}
	if !exceeded {
		t.Error("exceeded = false at the limit, want true")
	}
}

func TestSatelliteUsagePersistsAcrossLoad(t *testing.T) {
	dir := t.TempDir()

	usage, err := LoadSatelliteUsage(dir)
	if err != nil {
		t.Fatalf("LoadSatelliteUsage: %v", err)
	}
	usage.Increment(1_000_000)
	usage.Increment(1_000_000)

	reloaded, err := LoadSatelliteUsage(dir)
	if err != nil {
		t.Fatalf("LoadSatelliteUsage (reload): %v", err)
	}
	count, _ := reloaded.Snapshot(1_000_000)
	if count != 2 {
		t.Errorf("count after reload = %d, want 2", count)
	}
}

func TestSatelliteUsageMissingFileStartsAtZero(t *testing.T) {
	usage, err := LoadSatelliteUsage(t.TempDir())
	if err != nil {
		t.Fatalf("LoadSatelliteUsage: %v", err)
	}

	count, exceeded := usage.Snapshot(1)
	if count != 0 {
		t.Errorf("count = %d, want 0", count)
	}
	if exceeded {
		t.Error("exceeded = true with zero usage and a limit of 1, want false")
	}
}

func TestSatelliteUsageRollsOverOnMonthChange(t *testing.T) {
	dir := t.TempDir()

	// Simulate a count left over from a previous month.
	stale := satelliteUsageFileData{Year: 2000, Month: time.January, Count: 999}
	data, err := json.Marshal(stale)
	if err != nil {
		t.Fatalf("marshal stale usage: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, satelliteUsageFile), data, 0o644); err != nil {
		t.Fatalf("write stale usage: %v", err)
	}

	usage, err := LoadSatelliteUsage(dir)
	if err != nil {
		t.Fatalf("LoadSatelliteUsage: %v", err)
	}

	count, exceeded := usage.Snapshot(10)
	if count != 0 {
		t.Errorf("count = %d, want 0 for a stale month", count)
	}
	if exceeded {
		t.Error("exceeded = true for a rolled-over count, want false")
	}
}

func TestSatelliteUsageCorruptFileStartsOver(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, satelliteUsageFile), []byte("not json"), 0o644); err != nil {
		t.Fatalf("write corrupt usage: %v", err)
	}

	usage, err := LoadSatelliteUsage(dir)
	if err != nil {
		t.Fatalf("LoadSatelliteUsage: %v", err)
	}
	count, _ := usage.Snapshot(10)
	if count != 0 {
		t.Errorf("count = %d, want 0 after a corrupt file", count)
	}
}
