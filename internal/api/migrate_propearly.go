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
		log.Printf("propEarly migration: patched %d of %d site(s) (current/ideal to %.2f, reference to %.2f)", migrated, len(siteList), defaultPropEarly, referencePropEarly)
	}
}

// patchPropEarlyDefault overrides propEarly to its fixed value in each of a
// site's Reference/Current/Ideal maps and recomputes the fire-cascade outputs
// that depend on it, leaving every other field (including the user's own
// target edits) untouched. Reports whether anything changed.
//
// Reference gets referencePropEarly (0), not defaultPropEarly (0.45):
// Reference's own fire assumptions have no early-season component (see
// referencePropEarly's comment), and setting it to Current's 0.45 here is
// exactly the site-vs-catchment-level propEarly mismatch this whole fix
// exists to avoid — a target reset to reference would land on 0.45 at the
// site level while every catchment's own (untouched by this migration)
// Reference propEarly is already 0.
func patchPropEarlyDefault(site *sites.Site) bool {
	if site.Indicators == nil {
		return false
	}

	changed := false
	for _, scenario := range []struct {
		m    map[string]float64
		want float64
	}{
		{site.Indicators.Reference, referencePropEarly},
		{site.Indicators.Current, defaultPropEarly},
		{site.Indicators.Ideal, defaultPropEarly},
	} {
		if scenario.m == nil {
			continue
		}
		if v, ok := scenario.m[colPropEarly]; ok && v == scenario.want {
			continue
		}
		scenario.m[colPropEarly] = scenario.want
		workflow4FireCascade(scenario.m)
		changed = true
	}
	return changed
}
