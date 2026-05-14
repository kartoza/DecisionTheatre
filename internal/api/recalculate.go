package api

import (
	"math"
	"strings"
)

// Target input column names — TargetInputsAllowed = 1 in metadata.csv.
const (
	colLowTCProp          = "lowTC_prop"
	colPercBurned         = "percBurned"
	colHerbsTot           = "herbs_tot_kgkm2"
	colHerbsSpCountsPrefix = "herbs_sp_counts_"
)

// lowTCBiomassClasses are the biomass-class proportion columns that correspond
// to open/grassy areas (above-ground woody biomass < 50 Mg/ha).
var lowTCBiomassClasses = []string{
	"prop_X0_5Mgha", "prop_X05_10Mgha", "prop_X10_20Mgha",
	"prop_X20_30Mgha", "prop_X30_40Mgha", "prop_X40_50Mgha",
}

// highTCBiomassClasses are the proportion columns for closed-canopy areas
// (above-ground woody biomass >= 50 Mg/ha).
var highTCBiomassClasses = []string{
	"prop_X50_60Mgha", "prop_X60_70Mgha", "prop_X70_80Mgha", "prop_X80_100Mgha",
}

// recalculateIdeal applies cascading ecological recalculations to the ideal
// indicator map after the user edits one or more TargetInputsAllowed fields.
//
// changedTargets lists which primary target-input keys (lowTC_prop,
// herbs_tot_kgkm2) changed. changedSpeciesCounts lists which
// herbs_sp_counts_<Species> keys changed. oldIdeal holds the full ideal map
// captured before the PATCH was merged so scale factors can be computed.
func recalculateIdeal(ideal map[string]float64, changedTargets map[string]bool, oldIdeal map[string]float64, changedSpeciesCounts map[string]bool) {
	treeCoverChanged := changedTargets[colLowTCProp]
	herbivoresChanged := changedTargets[colHerbsTot]
	speciesCountsChanged := len(changedSpeciesCounts) > 0

	if treeCoverChanged {
		workflow1TreeCover(ideal, oldIdeal)
	}
	if herbivoresChanged {
		workflow2Herbivores(ideal, oldIdeal)
	} else if speciesCountsChanged {
		// Species count edits cascade up to herbs_tot_kgkm2 then through fire.
		// Skip if herbs_tot_kgkm2 was directly edited (workflow2Herbivores
		// already handles that path).
		workflow2aSpeciesCounts(ideal, changedSpeciesCounts, oldIdeal)
	}
	// All workflows feed into fire modelling (Workflow 4).
	if treeCoverChanged || herbivoresChanged || speciesCountsChanged {
		workflow4FireCascade(ideal)
	}
}

// workflow1TreeCover recalculates biomass metrics when lowTC_prop changes.
//
// Developer guide Workflow 1:
//  1. Redistribute tree-cover biomass class proportions so they sum to 1.
//  2. Recalculate NPP_gm2 and flamNPP_gm2 (scale with grassy/low-TC area).
//  3. Recalculate AGBwd_Mgha, LitterBiomass_gm2, deltaSOC_Mgha
//     (scale with tree/high-TC area).
//  4. Proceeds to Workflow 4 (called by the caller after this returns).
func workflow1TreeCover(ideal, oldIdeal map[string]float64) {
	newLowTC := math.Max(0, math.Min(1, ideal[colLowTCProp]))
	oldLowTC := oldIdeal[colLowTCProp]
	newHighTC := 1.0 - newLowTC
	oldHighTC := 1.0 - oldLowTC

	ideal[colLowTCProp] = newLowTC
	ideal["highTC_prop"] = newHighTC

	// Redistribute low-TC biomass class proportions.
	if oldLowTC > 0 {
		f := newLowTC / oldLowTC
		for _, k := range lowTCBiomassClasses {
			if v, ok := ideal[k]; ok {
				ideal[k] = v * f
			}
		}
	} else {
		for _, k := range lowTCBiomassClasses {
			ideal[k] = 0
		}
	}

	// Redistribute high-TC biomass class proportions.
	if oldHighTC > 0 {
		f := newHighTC / oldHighTC
		for _, k := range highTCBiomassClasses {
			if v, ok := ideal[k]; ok {
				ideal[k] = v * f
			}
		}
	} else {
		for _, k := range highTCBiomassClasses {
			ideal[k] = 0
		}
	}

	// Grass NPP and flammable NPP scale with the grassy (low-TC) fraction.
	if oldLowTC > 0 {
		f := newLowTC / oldLowTC
		scaleIdealKey(ideal, "NPP_gm2", f)
		scaleIdealKey(ideal, "flamNPP_gm2", f)
	} else {
		ideal["NPP_gm2"] = 0
		ideal["flamNPP_gm2"] = 0
	}

	// Woody biomass, litter, and delta-SOC scale with the tree (high-TC) fraction.
	if oldHighTC > 0 {
		f := newHighTC / oldHighTC
		scaleIdealKey(ideal, "AGBwd_Mgha", f)
		scaleIdealKey(ideal, "LitterBiomass_gm2", f)
		scaleIdealKey(ideal, "deltaSOC_Mgha", f)
	} else {
		ideal["AGBwd_Mgha"] = 0
		ideal["LitterBiomass_gm2"] = 0
		ideal["deltaSOC_Mgha"] = 0
	}
}

// workflow2Herbivores scales all herbivore metrics proportionally when the
// total herbivore biomass (herbs_tot_kgkm2) is changed.
//
// Developer guide Workflow 2:
//  1. Scale per-species / per-diet / per-functional-group biomass.
//  2. Scale corresponding DMI and CH4 metrics.
//  3. Scale aggregate totals (herbs_totGRAZING_DMI_kgkm2 etc.).
//  4. Proceeds to Workflow 4 (called by the caller after this returns).
func workflow2Herbivores(ideal, oldIdeal map[string]float64) {
	newTotal := ideal[colHerbsTot]
	oldTotal := oldIdeal[colHerbsTot]
	if oldTotal == 0 {
		// Cannot proportionally scale from zero; fire cascade still runs
		// with whatever grazing DMI is already in ideal.
		return
	}
	scale := newTotal / oldTotal

	for k := range ideal {
		if strings.HasPrefix(k, "herbs_") && k != colHerbsTot {
			ideal[k] = ideal[k] * scale
		}
	}

	if npp, ok := ideal["NPP_gm2"]; ok && npp > 0 {
		ideal["grazing_intensity"] = ideal["herbs_totGRAZING_DMI_kgkm2"] / npp
	}
}

// workflow2aSpeciesCounts updates derived herbivore fields when one or more
// herbs_sp_counts_<Species> target inputs are edited.
//
// Developer guide Workflow 2 (species-count entry point):
//  1. Scale per-species biomass, DMI, and CH4 by the count ratio.
//  2. Recompute herbs_tot_kgkm2, herbs_tot_DMI_kgkm2, herbs_tot_CH4_kgkm2
//     by summing all species fields.
//  3. Scale diet-group and functional-group aggregates by the overall
//     biomass ratio (same proportional simplification as workflow2Herbivores).
//  4. Recompute grazing_intensity.
//  Proceeds to Workflow 4 (called by the caller after this returns).
func workflow2aSpeciesCounts(ideal map[string]float64, changedSpecies map[string]bool, oldIdeal map[string]float64) {
	// Step 1: update per-species fields for each changed species.
	for key := range changedSpecies {
		sp := strings.TrimPrefix(key, colHerbsSpCountsPrefix)
		oldCount := oldIdeal[key]
		newCount := ideal[key]
		if oldCount > 0 {
			scale := newCount / oldCount
			scaleIdealKey(ideal, "herbs_sp_kgkm2_"+sp, scale)
			scaleIdealKey(ideal, "herbs_sp_DMI_kgkm2_"+sp, scale)
			scaleIdealKey(ideal, "herbs_sp_CH4_kgkm2_"+sp, scale)
		}
		// If oldCount == 0, per-capita is unknown; leave species biomass at 0.
	}

	// Step 2: recompute aggregate totals by summing all species fields.
	var newTotKg, newTotDMI, newTotCH4 float64
	for k, v := range ideal {
		switch {
		case strings.HasPrefix(k, "herbs_sp_kgkm2_"):
			newTotKg += v
		case strings.HasPrefix(k, "herbs_sp_DMI_kgkm2_"):
			newTotDMI += v
		case strings.HasPrefix(k, "herbs_sp_CH4_kgkm2_"):
			newTotCH4 += v
		}
	}

	oldTotal := oldIdeal[colHerbsTot]
	ideal[colHerbsTot] = newTotKg
	ideal["herbs_tot_DMI_kgkm2"] = newTotDMI
	ideal["herbs_tot_CH4_kgkm2"] = newTotCH4

	// Step 3: scale diet-group, functional-group, and grazing aggregates by
	// the overall biomass ratio (consistent with workflow2Herbivores).
	if oldTotal > 0 {
		scale := newTotKg / oldTotal
		for k := range ideal {
			if strings.HasPrefix(k, "herbs_diet_") || strings.HasPrefix(k, "herbs_fg_") {
				ideal[k] = ideal[k] * scale
			}
		}
		scaleIdealKey(ideal, "herbs_totGRAZING_DMI_kgkm2", scale)
	}

	// Step 4: recompute grazing intensity.
	if npp, ok := ideal["NPP_gm2"]; ok && npp > 0 {
		ideal["grazing_intensity"] = ideal["herbs_totGRAZING_DMI_kgkm2"] / npp
	}
}

// workflow4FireCascade recalculates fire metrics from current NPP, litter,
// and total grazing DMI values in ideal.
//
// Developer guide Workflow 4 (terminal workflow):
//  1. Fuel load = NPP + Litter - Grazing DMI (≥ 0).
//  2. Fireline Intensity (early and late season).
//  3. Area Burned (early and late, then combined with propEarly).
//  4. Fuel consumption and methane emissions.
func workflow4FireCascade(ideal map[string]float64) {
	npp := ideal["NPP_gm2"]               // g/m²
	litter := ideal["LitterBiomass_gm2"]  // g/m²
	propEarly := ideal["propEarly"]        // fraction [0,1]

	// herbs_totGRAZING_DMI_kgkm2 is in kg/km²; convert to g/m² (÷ 1000).
	grazingDMI := ideal["herbs_totGRAZING_DMI_kgkm2"] / 1000.0

	// Step 1 — Fuel load (g/m²).
	fuelload := math.Max(0, npp+litter-grazingDMI)
	ideal["fuelload_gm2"] = fuelload

	// Step 2 — Fireline intensity (kW/m), capped at 17 000.
	// Early season: lower multiplier (less intense but larger area).
	// Late season: higher multiplier (more intense, drier fuel).
	intensityEarly := math.Min(17000, math.Exp(6.65747+0.0011896*fuelload))
	intensityLate := math.Min(17000, math.Exp(6.65747+0.0035350*fuelload))
	ideal["Intensity_early_kW_m"] = intensityEarly
	ideal["Intensity_late_kW_m"] = intensityLate

	// Step 3 — Area burned (%).
	// Source: modified Dick Williams (1989) relationship.
	percBurnedEarly := math.Max(0, 98.24-97.95*math.Exp(-0.001122*intensityEarly))
	percBurnedLate := math.Max(0, 98.24-97.95*math.Exp(-0.001122*intensityLate))
	ideal["percBurned_early"] = percBurnedEarly
	ideal["percBurned_late"] = percBurnedLate
	ideal[colPercBurned] = propEarly*percBurnedEarly + (1-propEarly)*percBurnedLate

	// Step 4 — Combustion completeness (grass fuel type: a=1, b=0.004, I₀=100).
	fracCEarly := combustionCompleteness(intensityEarly, 1.0, 0.004, 100)
	fracCLate := combustionCompleteness(intensityLate, 1.0, 0.004, 100)

	// Fuel available per season (proportioned by propEarly).
	fuelEarly := fuelload * propEarly
	fuelLate := fuelload * (1 - propEarly)

	// Fuel consumed (g/m²) = combustion completeness × seasonal fuel × burn fraction.
	fconsEarly := fracCEarly * fuelEarly * percBurnedEarly / 100
	fconsLate := fracCLate * fuelLate * percBurnedLate / 100
	ideal["fuelConsumption_early_gm2"] = fconsEarly
	ideal["fuelConsumption_late_gm2"] = fconsLate
	ideal["fuelConsumption_gm2"] = fconsEarly + fconsLate

	// Methane emission factors (g CH4 / kg dry matter):
	//   EFCH4 = 66 × (1 − MCE) − 2
	//   Early MCE = 0.92 → EFCH4_early = 3.28 g/kg
	//   Late  MCE = 0.96 → EFCH4_late  = 0.64 g/kg
	const efch4Early = 66*(1-0.92) - 2 // 3.28 g/kg
	const efch4Late = 66*(1-0.96) - 2  // 0.64 g/kg

	// CH4 from fire (kg/km²):
	//   fuelCons [g/m²] × EFCH4 [g/kg] = kg/km²
	//   (unit identity: g/m² × g/kg × 1 kg/1000 g × 1 000 000 m²/km² = g·m⁻² × 1000 kg·km⁻²·g⁻¹·m² = kg/km²)
	ch4Early := fconsEarly * efch4Early
	ch4Late := fconsLate * efch4Late
	ideal["CH4_early_kg_km2"] = ch4Early
	ideal["CH4_late_kg_km2"] = ch4Late
	fireCH4 := ch4Early + ch4Late
	ideal["CH4_kg_km2"] = fireCH4

	// Total CH4 = fire + herbivore enteric emissions.
	ideal["CH4_both_kg_km2"] = fireCH4 + ideal["herbs_tot_CH4_kgkm2"]
}

// combustionCompleteness returns the fraction of fuel consumed:
//
//	FracC = a × (1 − exp(−b × (intensity − I0)))
//
// Returns 0 when intensity ≤ I0.
func combustionCompleteness(intensity, a, b, I0 float64) float64 {
	if intensity <= I0 {
		return 0
	}
	return a * (1 - math.Exp(-b*(intensity-I0)))
}

// scaleIdealKey multiplies ideal[key] by factor if the key is present.
func scaleIdealKey(ideal map[string]float64, key string, factor float64) {
	if v, ok := ideal[key]; ok {
		ideal[key] = v * factor
	}
}
