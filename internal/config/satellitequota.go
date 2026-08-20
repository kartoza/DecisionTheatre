package config

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/kartoza/decision-theatre/internal/fsutil"
)

// satelliteUsageFile is the persisted counter's name, stored alongside
// settings.json in SettingsDir().
const satelliteUsageFile = "satellite_usage.json"

// SatelliteUsage tracks how many satellite tiles have been fetched from the
// configured upstream provider this calendar month.
//
// Most raster imagery providers' free tiers are conditioned on a monthly tile
// count (see DefaultSatelliteQuotaLimit for the default provider's). Persisting
// this rather than keeping it only in memory means a restart of the desktop app
// does not reset what the provider considers a running total.
type SatelliteUsage struct {
	mu sync.Mutex

	// dir is where satellite_usage.json is read from and written to. A field
	// rather than always SettingsDir(), so a test can point it at a temporary
	// directory instead of the real per-user config location.
	dir string

	year  int
	month time.Month
	count int
}

// satelliteUsageFileData is the on-disk shape.
type satelliteUsageFileData struct {
	Year  int        `json:"year"`
	Month time.Month `json:"month"`
	Count int        `json:"count"`
}

// LoadSatelliteUsage reads the persisted counter from dir. A missing file is
// not an error: it means no tiles have been fetched yet this run, the same
// starting state as config.LoadSettings gives a first-ever launch.
func LoadSatelliteUsage(dir string) (*SatelliteUsage, error) {
	now := time.Now().UTC()
	usage := &SatelliteUsage{dir: dir, year: now.Year(), month: now.Month()}

	data, err := os.ReadFile(filepath.Join(dir, satelliteUsageFile))
	if err != nil {
		if os.IsNotExist(err) {
			return usage, nil
		}
		return usage, err
	}

	var stored satelliteUsageFileData
	if err := json.Unmarshal(data, &stored); err != nil {
		// A corrupt file starts the count over rather than failing startup:
		// losing track of a month's tile count is far less costly than the
		// satellite basemap refusing to work at all.
		log.Printf("Warning: satellite usage file is corrupt, resetting count: %v", err)
		return usage, nil
	}
	if stored.Year == usage.year && stored.Month == usage.month {
		usage.count = stored.Count
	}
	return usage, nil
}

// Increment records one upstream tile fetch, rolling the count over first if
// the calendar month has changed since it was last touched. It returns the new
// count and whether limit has been reached or exceeded.
//
// Persisted synchronously on every call. At desktop-app tile volumes an atomic
// local write per tile is not a performance concern, and surviving an unclean
// shutdown without losing count matters more than shaving milliseconds off a
// tile fetch.
func (u *SatelliteUsage) Increment(limit int) (count int, exceeded bool) {
	u.mu.Lock()
	defer u.mu.Unlock()

	u.rolloverLocked()
	u.count++
	u.saveLocked()
	return u.count, u.count >= limit
}

// Snapshot reports the current count without incrementing it, applying the
// same month rollover Increment does. Used to answer "is satellite imagery
// still available" without counting the question as a tile fetch.
func (u *SatelliteUsage) Snapshot(limit int) (count int, exceeded bool) {
	u.mu.Lock()
	defer u.mu.Unlock()

	u.rolloverLocked()
	return u.count, u.count >= limit
}

func (u *SatelliteUsage) rolloverLocked() {
	now := time.Now().UTC()
	if now.Year() != u.year || now.Month() != u.month {
		u.year = now.Year()
		u.month = now.Month()
		u.count = 0
	}
}

// saveLocked persists the counter. A failure only means next month's count
// might start from zero a little early after a crash; it is logged rather than
// propagated so a full disk cannot break tile serving.
func (u *SatelliteUsage) saveLocked() {
	data, err := json.Marshal(satelliteUsageFileData{Year: u.year, Month: u.month, Count: u.count})
	if err != nil {
		log.Printf("Warning: could not encode satellite usage: %v", err)
		return
	}
	if err := os.MkdirAll(u.dir, 0o755); err != nil {
		log.Printf("Warning: could not create %s: %v", u.dir, err)
		return
	}
	path := filepath.Join(u.dir, satelliteUsageFile)
	if err := fsutil.WriteFileAtomic(path, data, 0o644); err != nil {
		log.Printf("Warning: could not save satellite usage: %v", err)
	}
}
