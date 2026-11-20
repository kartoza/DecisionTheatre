package api

import (
	"math"
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

// propEarly is now a real per-catchment fraction (not a 0/1 flag), so it is
// area-weighted like any other indicator — no fixed override — and Ideal
// starts as a copy of Current.
func TestComputeAreaWeightedIndicators_PropEarlyIsAreaWeighted(t *testing.T) {
	catchments := []geodata.CatchmentIndicators{
		{
			ID:      "1",
			AreaKm2: 10,
			Reference: map[string]float64{
				"propEarly": 0.2,
			},
			Current: map[string]float64{
				"propEarly": 0.3,
			},
		},
		{
			ID:      "2",
			AreaKm2: 10,
			Reference: map[string]float64{
				"propEarly": 0.4,
			},
			Current: map[string]float64{
				"propEarly": 0.7,
			},
		},
	}

	indicators := computeAreaWeightedIndicators(catchments)

	const tolerance = 1e-9
	if got, want := indicators.Reference[colPropEarly], 0.3; math.Abs(got-want) > tolerance {
		t.Errorf("Reference propEarly = %v, want %v", got, want)
	}
	if got, want := indicators.Current[colPropEarly], 0.5; math.Abs(got-want) > tolerance {
		t.Errorf("Current propEarly = %v, want %v", got, want)
	}
	if got, want := indicators.Ideal[colPropEarly], 0.5; math.Abs(got-want) > tolerance {
		t.Errorf("Ideal propEarly = %v, want %v (Ideal starts as a copy of Current)", got, want)
	}
}
