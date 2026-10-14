package api

import (
	"testing"

	"github.com/kartoza/decision-theatre/internal/geodata"
)

// On a brand new site, Ideal must start out identical to Current for every
// key — there has been no edit yet for them to differ over.
//
// This broke for fire-cascade outputs (percBurned, CH4_both_kg_km2, …) when a
// site's catchments have the "current" scenario value NULL in the GeoPackage
// for a key that IS present under "reference" (this happens for a real
// minority of catchments — see gpkg's scenario_current vs scenario_reference
// NULL counts). The aggregation loop fell back to the catchment's own
// Reference-scenario value for Ideal, but left Current unset for that key;
// Current then got backfilled from its own raw inputs via
// fillMissingCascadeOutputs *after* Ideal had already been pinned to
// Reference's (differently-derived) value — so Current and Ideal disagreed
// right at creation, before any edit was made.
func TestComputeAreaWeightedIndicators_IdealMatchesCurrentAtCreation(t *testing.T) {
	catchments := []geodata.CatchmentIndicators{
		{
			ID:      "1",
			AreaKm2: 10,
			Reference: map[string]float64{
				"flamNPP_gm2":              200,
				"LitterBiomass_gm2":        50,
				"lowTC_prop":               0.8,
				"herbs_totGRAZING_DMI_gm2": 10,
				"herbs_tot_CH4_kgkm2":      100,
				"percBurned":               40, // present under reference
				"CH4_both_kg_km2":          500,
			},
			Current: map[string]float64{
				"flamNPP_gm2":              210,
				"LitterBiomass_gm2":        55,
				"lowTC_prop":               0.75,
				"herbs_totGRAZING_DMI_gm2": 12,
				"herbs_tot_CH4_kgkm2":      110,
				// percBurned / CH4_both_kg_km2 deliberately absent here,
				// simulating a NULL "current" scenario row in the GeoPackage.
			},
		},
		{
			ID:      "2",
			AreaKm2: 10,
			Reference: map[string]float64{
				"flamNPP_gm2":              180,
				"LitterBiomass_gm2":        45,
				"lowTC_prop":               0.7,
				"herbs_totGRAZING_DMI_gm2": 8,
				"herbs_tot_CH4_kgkm2":      90,
				"percBurned":               35,
				"CH4_both_kg_km2":          450,
			},
			Current: map[string]float64{
				"flamNPP_gm2":              190,
				"LitterBiomass_gm2":        48,
				"lowTC_prop":               0.72,
				"herbs_totGRAZING_DMI_gm2": 9,
				"herbs_tot_CH4_kgkm2":      95,
				// Likewise absent for this catchment.
			},
		},
	}

	indicators := computeAreaWeightedIndicators(catchments)

	for _, key := range []string{"percBurned", "CH4_both_kg_km2"} {
		cur, curOK := indicators.Current[key]
		ideal, idealOK := indicators.Ideal[key]
		if !curOK || !idealOK {
			t.Fatalf("%s: expected both Current and Ideal to be set, got current ok=%v ideal ok=%v", key, curOK, idealOK)
		}
		if cur != ideal {
			t.Errorf("%s: Current (%v) != Ideal (%v) at creation, before any edit", key, cur, ideal)
		}
	}
}

// Reference and Current each get their own fixed propEarly, not the same
// one. Forcing both to defaultPropEarly (0.45, Current's own fixed
// assumption) made a target reset to reference land on 0.45 at the site
// level while every catchment's own Reference propEarly — untouched by this
// aggregation, and uniformly 0 in the real GeoPackage — stayed 0, producing
// the exact non-linear percBurned jump between the site dial and the map
// that this whole fixed-propEarly approach exists to avoid.
func TestComputeAreaWeightedIndicators_ReferenceAndCurrentPropEarlyDiffer(t *testing.T) {
	catchments := []geodata.CatchmentIndicators{
		{
			ID:      "1",
			AreaKm2: 10,
			Reference: map[string]float64{
				"propEarly": 0,
			},
			Current: map[string]float64{
				"propEarly": 0, // real per-catchment 0/1 flag
			},
		},
		{
			ID:      "2",
			AreaKm2: 10,
			Reference: map[string]float64{
				"propEarly": 0,
			},
			Current: map[string]float64{
				"propEarly": 1, // real per-catchment 0/1 flag
			},
		},
	}

	indicators := computeAreaWeightedIndicators(catchments)

	if got := indicators.Reference[colPropEarly]; got != referencePropEarly {
		t.Errorf("Reference propEarly = %v, want %v", got, referencePropEarly)
	}
	if got := indicators.Current[colPropEarly]; got != defaultPropEarly {
		t.Errorf("Current propEarly = %v, want %v", got, defaultPropEarly)
	}
	if got := indicators.Ideal[colPropEarly]; got != defaultPropEarly {
		t.Errorf("Ideal propEarly = %v, want %v (Ideal starts as a copy of Current)", got, defaultPropEarly)
	}
}
