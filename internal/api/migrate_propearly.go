package api

import (
	"log"

	"github.com/kartoza/decision-theatre/internal/sites"
)

// MigratePropEarlyDefault patches already-persisted sites whose propEarly
// (Proportion early-season fires) still carries the real area-weighted
// catchment average instead of the fixed defaultPropEarly that
// computeAreaWeightedIndicators now forces on every new site/re-extraction.
//
// Without this, a site created or extracted before that fix landed would
// keep showing its old, data-derived propEarly — an odd-precision fraction
// from averaging the GeoPackage's per-catchment 0/1 flag, which made
// percBurned move non-linearly as the target slider dragged — instead of the
// fixed 0.45, and its fire-cascade outputs (percBurned, CH4_both_kg_km2, …)
// would stay computed from that stale value.
//
// Safe to run on every startup: a site already on the fixed default is left
// untouched (and unsaved), so repeated runs cost one map lookup per site
// after the first migration.
func MigratePropEarlyDefault(store *sites.Store) {
	if store == nil {
		return
	}

	siteList, err := store.List()
	if err != nil {
		log.Printf("propEarly migration: failed to list sites: %v", err)
		return
	}

	migrated := 0
	for _, site := range siteList {
		id := site.ID
		patchedThisSite := false
		err := store.WithSite(id, func() error {
			current, err := store.Get(id)
			if err != nil {
				return err
			}
			if !patchPropEarlyDefault(current) {
				return nil
			}
			if _, err := store.UpdateLocked(id, current); err != nil {
				return err
			}
			patchedThisSite = true
			return nil
		})
		if err != nil {
			log.Printf("propEarly migration: site %s: %v", id, err)
			continue
		}
		if patchedThisSite {
			migrated++
		}
	}

	if migrated > 0 {
		log.Printf("propEarly migration: patched %d of %d site(s) to the %.2f default", migrated, len(siteList), defaultPropEarly)
	}
}

// patchPropEarlyDefault overrides propEarly to defaultPropEarly in each of a
// site's Reference/Current/Ideal maps and recomputes the fire-cascade outputs
// that depend on it, leaving every other field (including the user's own
// target edits) untouched. Reports whether anything changed.
func patchPropEarlyDefault(site *sites.Site) bool {
	if site.Indicators == nil {
		return false
	}

	changed := false
	for _, scenario := range []map[string]float64{
		site.Indicators.Reference,
		site.Indicators.Current,
		site.Indicators.Ideal,
	} {
		if scenario == nil {
			continue
		}
		if v, ok := scenario[colPropEarly]; ok && v == defaultPropEarly {
			continue
		}
		scenario[colPropEarly] = defaultPropEarly
		workflow4FireCascade(scenario)
		changed = true
	}
	return changed
}
