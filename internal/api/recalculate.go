package api

import (
	"math"
	"strings"

	"github.com/kartoza/decision-theatre/internal/sites"
)

// Target input column names — TargetInputsAllowed = 1 in metadata.csv.
const (
	colLowTCProp           = "lowTC_prop"
	colPercBurned          = "percBurned"
	colHerbsTot            = "herbs_tot_kgkm2"
	colNPP                 = "NPP_gm2"
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
	nppChanged := changedTargets[colNPP]
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
	if nppChanged && !treeCoverChanged {
		// NPP edited directly (e.g. via IndicatorEditorPage): update grazing
		// intensity then fall through to Workflow 4. Skip when Workflow 1
		// already ran — it recalculates NPP itself as part of tree-cover
		// redistribution and the grazing intensity is recomputed in Workflow 4.
		workflow3GrassNPP(ideal)
	}
	// All workflows feed into fire modelling (Workflow 4).
	if treeCoverChanged || herbivoresChanged || speciesCountsChanged || nppChanged {
		workflow4FireCascade(ideal)
	}
}

// agbMidpoints are the above-ground woody biomass midpoints (Mg/ha) for each
// of the 10 tree-cover classes (low-TC classes 1–6, high-TC classes 7–10).
// Source: DOCX Workflow 1, AGBvals.
var agbMidpoints = [10]float64{2.5, 7.5, 15, 25, 35, 45, 55, 65, 75, 90}

// litterMidpoints are the litter biomass midpoints (g/m²) per tree-cover class.
// Source: DOCX Workflow 1, LitterClasses.
var litterMidpoints = [10]float64{0.06, 0.18, 0.36, 0.70, 0.98, 1.44, 1.98, 2.60, 3.30, 4.32}

// treeCoverMidpoints are the tree-cover fraction midpoints (%) per class,
// used for meanTC. Source: DOCX Workflow 1, Treefracs.
var treeCoverMidpoints = [10]float64{2.5, 7.5, 15, 25, 35, 45, 55, 65, 75, 90}

// workflow1TreeCover recalculates biomass metrics when lowTC_prop changes.
//
// Developer guide Workflow 1:
//  1. Redistribute prop_X classes equally within each zone:
//     each low-TC class = lowTCprop/6, each high-TC class = highTCprop/4.
//  2. Recalculate AGBwd_Mgha, LitterBiomass_gm2, and meanTC as class-midpoint
//     weighted sums over all 10 prop classes.
//  3. Recalculate NPP_gm2 and flamNPP_gm2 by proportional scaling with low-TC
//     fraction (lookup table not available at runtime).
//  4. Recalculate deltaSOC_Mgha by proportional scaling with high-TC fraction
//     (lookup table not available at runtime).
//  5. Proceeds to Workflow 4 (called by the caller after this returns).
func workflow1TreeCover(ideal, oldIdeal map[string]float64) {
	newLowTC := math.Max(0, math.Min(1, ideal[colLowTCProp]))
	oldLowTC := oldIdeal[colLowTCProp]
	newHighTC := 1.0 - newLowTC
	oldHighTC := 1.0 - oldLowTC

	ideal[colLowTCProp] = newLowTC
	ideal["highTC_prop"] = newHighTC

	// Redistribute biomass class proportions equally within each zone.
	for _, k := range lowTCBiomassClasses {
		ideal[k] = newLowTC / float64(len(lowTCBiomassClasses))
	}
	for _, k := range highTCBiomassClasses {
		ideal[k] = newHighTC / float64(len(highTCBiomassClasses))
	}

	// Recompute AGBwd, litter biomass, and mean tree cover as weighted sums
	// over all 10 class midpoints.
	allClasses := append(lowTCBiomassClasses, highTCBiomassClasses...)
	var agbwd, litter, meanTC float64
	for i, k := range allClasses {
		p := ideal[k]
		agbwd += p * agbMidpoints[i]
		litter += p * litterMidpoints[i]
		meanTC += p * treeCoverMidpoints[i]
	}
	ideal["AGBwd_Mgha"] = agbwd
	ideal["LitterBiomass_gm2"] = litter
	ideal["meanTC"] = meanTC

	// Grass NPP and flammable NPP scale with the grassy (low-TC) fraction
	// (per-catchment NPP lookup table is not available at runtime).
	if oldLowTC > 0 {
		f := newLowTC / oldLowTC
		scaleIdealKey(ideal, "NPP_gm2", f)
		scaleIdealKey(ideal, "flamNPP_gm2", f)
	} else {
		ideal["NPP_gm2"] = 0
		ideal["flamNPP_gm2"] = 0
	}

	// Delta SOC scales with the tree (high-TC) fraction
	// (per-catchment SOC lookup table is not available at runtime).
	if oldHighTC > 0 {
		f := newHighTC / oldHighTC
		scaleIdealKey(ideal, "deltaSOC_Mgha", f)
	} else {
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

// workflow3GrassNPP recalculates grazing intensity when NPP_gm2 is edited
// directly (e.g. simulating rainfall or fertilisation changes).
//
// Developer guide Workflow 3:
//  1. Recalculate grazing_intensity = Total DMI / New Grass NPP.
//  2. Proceeds to Workflow 4 (called by the caller after this returns).
func workflow3GrassNPP(ideal map[string]float64) {
	if npp := ideal[colNPP]; npp > 0 {
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
//  2. Fireline intensity (early and late season). Late capped at 17 000;
//     early uncapped. Late overrides to early where MAR > 1500.
//  3. Raw area burned (Dick Williams 1989).
//  4. Constrain to flammable area by multiplying by lowTC_prop.
//  5. Fuel consumption per season = fuelload × percBurned / 100.
//  6. CH4 emissions per season using MCE-derived emission factors.
//  7. Blend early and late outputs by propEarly (default 0.45).
func workflow4FireCascade(ideal map[string]float64) {
	npp := ideal["NPP_gm2"]              // g/m²
	litter := ideal["LitterBiomass_gm2"] // g/m²
	lowTCProp := ideal[colLowTCProp]

	// propEarly defaults to 0.45 when absent (per DOCX Step 7).
	propEarly := ideal["propEarly"]
	if propEarly == 0 {
		propEarly = 0.45
	}

	// herbs_totGRAZING_DMI_kgkm2 is in kg/km²; convert to g/m² (÷ 1000).
	grazingDMI := ideal["herbs_totGRAZING_DMI_kgkm2"] / 1000.0

	// Step 1 — Fuel load (g/m²).
	fuelload := math.Max(0, npp+litter-grazingDMI)
	ideal["fuelload_gm2"] = fuelload

	// Step 2 — Fireline intensity (kW/m).
	// Only late season is capped at 17 000; early season is uncapped.
	// Where MAR > 1500 (high-rainfall catchments), late season intensity
	// reverts to the early season value.
	intensityEarly := math.Exp(6.65747 + 0.0011896*fuelload)
	intensityLate := math.Min(17000, math.Exp(6.65747+0.0035350*fuelload))
	if mar, ok := ideal["MAR"]; ok && mar > 1500 {
		intensityLate = intensityEarly
	}
	ideal["Intensity_early_kW_m"] = intensityEarly
	ideal["Intensity_late_kW_m"] = intensityLate

	// Step 3 — Raw area burned (%).
	// Source: modified Dick Williams (1989) relationship.
	areaBurnedEarly := math.Max(0, 98.24-97.95*math.Exp(-0.001122*intensityEarly))
	areaBurnedLate := math.Max(0, 98.24-97.95*math.Exp(-0.001122*intensityLate))

	// Step 4 — Constrain to flammable area (lowTC_prop).
	percBurnedEarly := areaBurnedEarly * lowTCProp
	percBurnedLate := areaBurnedLate * lowTCProp
	ideal["percBurned_early"] = percBurnedEarly
	ideal["percBurned_late"] = percBurnedLate

	// Step 5 — Fuel consumption per season (g/m²).
	fuelConsEarly := fuelload * percBurnedEarly / 100
	fuelConsLate := fuelload * percBurnedLate / 100
	ideal["fuelConsumption_early_gm2"] = fuelConsEarly
	ideal["fuelConsumption_late_gm2"] = fuelConsLate

	// Methane emission factors (g CH4 / kg dry matter):
	//   EFCH4 = 66 × (1 − MCE) − 2
	//   Early MCE = 0.92 → EFCH4_early = 3.28 g/kg
	//   Late  MCE = 0.96 → EFCH4_late  = 0.64 g/kg
	const efch4Early = 66*(1-0.92) - 2 // 3.28 g/kg
	const efch4Late = 66*(1-0.96) - 2  // 0.64 g/kg

	// Step 6 — CH4 per season (kg/km²):
	//   fuelCons [g/m²] × EFCH4 [g/kg] = kg/km²
	ch4Early := fuelConsEarly * efch4Early
	ch4Late := fuelConsLate * efch4Late
	ideal["CH4_early_kg_km2"] = ch4Early
	ideal["CH4_late_kg_km2"] = ch4Late

	// Step 7 — Blend early and late outputs by propEarly.
	ideal[colPercBurned] = propEarly*percBurnedEarly + (1-propEarly)*percBurnedLate
	ideal["fuelConsumption_gm2"] = fuelConsEarly*propEarly + fuelConsLate*(1-propEarly)
	fireCH4 := ch4Early*propEarly + ch4Late*(1-propEarly)
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

// propagateIdealToCatchments updates each catchment's Ideal map so that the
// area-weighted average across catchments matches the updated site-level ideal.
//
// Reverse of the area-weighted formula: when the site ideal for key k changes
// by scale = newSiteIdeal[k] / oldSiteIdeal[k], every catchment's ideal for k
// is multiplied by the same factor, which preserves the spatial distribution
// while keeping the site average equal to newSiteIdeal[k].
//
// Edge cases:
//   - Catchment Ideal is nil → initialised from its Reference map.
//   - oldSiteIdeal[k] == 0 but siteReference[k] != 0 → distribute
//     proportionally to per-catchment reference values.
//   - Both zero → each catchment ideal is set to newSiteIdeal[k].
func propagateIdealToCatchments(
	catchments []sites.SiteCatchment,
	oldSiteIdeal, newSiteIdeal, siteReference map[string]float64,
) {
	for i := range catchments {
		if catchments[i].Ideal == nil {
			catchments[i].Ideal = make(map[string]float64, len(catchments[i].Reference))
			for k, v := range catchments[i].Reference {
				catchments[i].Ideal[k] = v
			}
		}
		for key, newSiteVal := range newSiteIdeal {
			oldSiteVal := oldSiteIdeal[key]
			switch {
			case oldSiteVal != 0:
				catchments[i].Ideal[key] *= newSiteVal / oldSiteVal
			case siteReference[key] != 0:
				catchments[i].Ideal[key] = (catchments[i].Reference[key] / siteReference[key]) * newSiteVal
			default:
				catchments[i].Ideal[key] = newSiteVal
			}
		}
	}
}
