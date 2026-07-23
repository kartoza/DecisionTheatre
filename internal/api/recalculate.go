package api

import (
	"math"
	"strings"

	"github.com/kartoza/decision-theatre/internal/sites"
)

// Target input column names — TargetInputsAllowed = 1 in metadata.csv.
const (
	colLowTCProp           = "lowTC_prop"
	colHighTCProp          = "highTC_prop"
	colMeanTC              = "meanTC"
	colPropEarly           = "propEarly"
	colPercBurned          = "percBurned"
	colHerbsTot            = "herbs_tot_kgkm2"
	colNPP                 = "NPP_gm2"
	colHerbsSpCountsPrefix = "herbs_sp_counts_"
	colHerbsSpKgkm2Prefix  = "herbs_sp_kgkm2_"
)

// lowTCBiomassClasses are the proportion columns for open/grassy areas
// (above-ground woody biomass < 50 Mg/ha), in TC class order (1–6).
var lowTCBiomassClasses = []string{
	"prop_X0_5Mgha", "prop_X05_10Mgha", "prop_X10_20Mgha",
	"prop_X20_30Mgha", "prop_X30_40Mgha", "prop_X40_50Mgha",
}

// highTCBiomassClasses are the proportion columns for closed-canopy areas
// (above-ground woody biomass ≥ 50 Mg/ha), in TC class order (7–10).
var highTCBiomassClasses = []string{
	"prop_X50_60Mgha", "prop_X60_70Mgha", "prop_X70_80Mgha", "prop_X80_100Mgha",
}

// allBiomassClasses is the ordered union of low- and high-TC proportion
// columns; index i corresponds to agbMidpoints[i] / litterMidpoints[i] /
// treeCoverMidpoints[i] and to LookupData.SiteNPPByTC[i].
var allBiomassClasses = append(append([]string{}, lowTCBiomassClasses...), highTCBiomassClasses...)

// recalculateIdeal applies cascading ecological recalculations to the ideal
// indicator map after the user edits one or more TargetInputsAllowed fields.
//
// lookup carries pre-aggregated site-level lookup data from the external CSVs.
// When lookup is nil or the relevant sub-fields are absent, proportional
// scaling is used as a fallback.
func recalculateIdeal(ideal map[string]float64, changedTargets map[string]bool, oldIdeal map[string]float64, changedSpeciesCounts map[string]bool, changedSpeciesBiomass map[string]bool, propClassChanged bool, lookup *LookupData) {
	treeCoverChanged := changedTargets[colLowTCProp]
	herbivoresChanged := changedTargets[colHerbsTot]
	nppChanged := changedTargets[colNPP]
	propEarlyChanged := changedTargets[colPropEarly]
	meanTCChanged := changedTargets[colMeanTC]
	speciesCountsChanged := len(changedSpeciesCounts) > 0
	speciesBiomassChanged := len(changedSpeciesBiomass) > 0

	// §1.3 — meanTC edited directly.
	if meanTCChanged && !treeCoverChanged && !propClassChanged {
		workflowMeanTC(ideal, oldIdeal, lookup)
	}
	// §1.2 — individual prop_X*Mgha columns edited.
	if propClassChanged && !treeCoverChanged {
		workflow0PropClasses(ideal, oldIdeal, lookup)
	}
	// §1.1 — lowTC_prop edited directly.
	if treeCoverChanged {
		workflow1TreeCover(ideal, oldIdeal, lookup)
	}

	if herbivoresChanged {
		workflow2Herbivores(ideal, oldIdeal, lookup)
	} else if speciesCountsChanged {
		workflow2aSpeciesCounts(ideal, changedSpeciesCounts, oldIdeal, lookup)
	} else if speciesBiomassChanged {
		workflow2bSpeciesBiomass(ideal, oldIdeal, lookup)
	}

	// §3 Branch 2 — recompute deltaSOC_Mgha_grazers whenever NPP or grazing
	// DMI changes.
	if treeCoverChanged || meanTCChanged || propClassChanged || herbivoresChanged || speciesCountsChanged || speciesBiomassChanged || nppChanged {
		workflowSOCGrazing(ideal, oldIdeal)
	}

	if nppChanged && !treeCoverChanged && !propClassChanged && !meanTCChanged {
		workflow3GrassNPP(ideal)
	}

	if treeCoverChanged || meanTCChanged || propClassChanged || herbivoresChanged || speciesCountsChanged || speciesBiomassChanged || nppChanged || propEarlyChanged {
		workflow4FireCascade(ideal)
	}
}

// ── Tree-cover midpoint arrays ────────────────────────────────────────────────

// agbMidpoints are the above-ground woody biomass midpoints (Mg/ha) for TC
// classes 1–10. Source: §1 AGBvals.
var agbMidpoints = [10]float64{2.5, 7.5, 15, 25, 35, 45, 55, 65, 75, 90}

// litterMidpoints are the litter biomass midpoints in g/m². Source: §1 LitterClasses.
// R formula: (1-evergreenFrac)*LMF*AGBvals*100 — the ×100 converts Mg/ha to g/m².
var litterMidpoints = [10]float64{6.0, 18.0, 36.0, 70.0, 98.0, 144.0, 198.0, 260.0, 330.0, 432.0}

// treeCoverMidpoints are the tree-cover fraction midpoints (%) used for meanTC.
// Source: §1 Treefracs.
var treeCoverMidpoints = [10]float64{2.5, 7.5, 15, 25, 35, 45, 55, 65, 75, 90}

// ── Shared helper: recompute metrics after prop classes change ────────────────

// recomputePropDerivedMetrics updates AGBwd, LitterBiomass, meanTC, NPP,
// flamNPP, deltaSOC_Mgha_trees, and the combined deltaSOC_Mgha after the
// prop_X*Mgha values (or lowTC_prop) change.
//
// oldLowTC / oldHighTC are the zone fractions before the edit, used for
// proportional-scaling fallbacks when lookup tables are unavailable.
//
// If lookup.HasNPP, NPP and flamNPP are computed from the site-level weighted
// NPP lookup array (§1 steps 1–2). Otherwise proportional scaling is used.
//
// If lookup.HasSOC and lookup.HasCurrentProps, deltaSOC_Mgha_trees is computed
// as lookup_weighted(target_props) − lookup_weighted(current_props) per §3
// Branch 1. Otherwise proportional scaling is used.
func recomputePropDerivedMetrics(ideal map[string]float64, oldLowTC, oldHighTC float64, lookup *LookupData) {
	newLowTC := ideal[colLowTCProp]
	newHighTC := ideal[colHighTCProp]

	// AGBwd, litter, meanTC — always from midpoint weighted sums.
	var agbwd, litter, meanTC float64
	for i, k := range allBiomassClasses {
		p := ideal[k]
		agbwd += p * agbMidpoints[i]
		litter += p * litterMidpoints[i]
		meanTC += p * treeCoverMidpoints[i]
	}
	ideal["AGBwd_Mgha"] = agbwd
	ideal["LitterBiomass_gm2"] = litter
	ideal["meanTC"] = meanTC

	// NPP and flamNPP.
	if lookup != nil && lookup.HasNPP {
		// §1 step 1: grassNPP = sum_i(NPP_by_treecover[i] * prop[i])
		// §1 step 2: flamNPP  = sum_i=0..5(NPP_by_treecover[i] * prop[i])
		var npp, flamNPP float64
		for i, k := range allBiomassClasses {
			p := ideal[k]
			contrib := p * lookup.SiteNPPByTC[i]
			npp += contrib
			if i < 6 { // low TC classes only
				flamNPP += contrib
			}
		}
		ideal["NPP_gm2"] = npp
		ideal["flamNPP_gm2"] = flamNPP
	} else {
		// Fallback: proportional scaling with the low-TC fraction.
		if oldLowTC > 0 {
			f := newLowTC / oldLowTC
			scaleIdealKey(ideal, "NPP_gm2", f)
			scaleIdealKey(ideal, "flamNPP_gm2", f)
		} else {
			ideal["NPP_gm2"] = 0
			ideal["flamNPP_gm2"] = 0
		}
	}

	// deltaSOC_Mgha_trees — §3 Branch 1.
	if lookup != nil && lookup.HasSOC && lookup.HasCurrentProps {
		// deltaSOC_trees = SOC(target_props) − SOC(current_props)
		var socTarget, socCurrent float64
		for i, k := range allBiomassClasses {
			socTarget += ideal[k] * lookup.SiteSOCByTC[i]
			socCurrent += lookup.CurrentProps[i] * lookup.SiteSOCByTC[i]
		}
		ideal["deltaSOC_Mgha_trees"] = socTarget - socCurrent
	} else {
		// Fallback: proportional scaling with the high-TC fraction.
		if oldHighTC > 0 {
			f := newHighTC / oldHighTC
			scaleIdealKey(ideal, "deltaSOC_Mgha_trees", f)
		} else {
			ideal["deltaSOC_Mgha_trees"] = 0
		}
	}
	ideal["deltaSOC_Mgha"] = ideal["deltaSOC_Mgha_trees"] + ideal["deltaSOC_Mgha_grazers"]

	// Recompute grazing intensity — NPP may have changed, DMI is unchanged.
	// R scripts (0_5, fefa_ppp_v3 §4.8) always derive GI = DMI / (NPP × 1000)
	// after any tree-cover or NPP update.
	if npp := ideal["NPP_gm2"]; npp > 0 {
		ideal["grazing_intensity"] = grazingIntensity(ideal["herbs_totGRAZING_DMI_kgkm2"], npp)
	}
}

// ── Tree-cover workflows ──────────────────────────────────────────────────────

// workflow0PropClasses handles §1.2 — individual prop_X*Mgha classes edited.
// Normalises the classes to sum to 1, derives zone proportions, then
// recomputes all dependent metrics via recomputePropDerivedMetrics.
func workflow0PropClasses(ideal, oldIdeal map[string]float64, lookup *LookupData) {
	var total float64
	for _, k := range allBiomassClasses {
		total += ideal[k]
	}
	if total > 0 && math.Abs(total-1) > 1e-9 {
		for _, k := range allBiomassClasses {
			ideal[k] /= total
		}
	}

	var newLowTC, newHighTC float64
	for _, k := range lowTCBiomassClasses {
		newLowTC += ideal[k]
	}
	for _, k := range highTCBiomassClasses {
		newHighTC += ideal[k]
	}

	oldLowTC := oldIdeal[colLowTCProp]
	oldHighTC := 1.0 - oldLowTC
	ideal[colLowTCProp] = newLowTC
	ideal[colHighTCProp] = newHighTC

	recomputePropDerivedMetrics(ideal, oldLowTC, oldHighTC, lookup)
}

// workflow1TreeCover handles §1.1 — lowTC_prop edited directly.
// Redistributes classes equally within each TC zone then recomputes metrics.
func workflow1TreeCover(ideal, oldIdeal map[string]float64, lookup *LookupData) {
	newLowTC := math.Max(0, math.Min(1, ideal[colLowTCProp]))
	oldLowTC := oldIdeal[colLowTCProp]
	newHighTC := 1.0 - newLowTC
	oldHighTC := 1.0 - oldLowTC

	ideal[colLowTCProp] = newLowTC
	ideal[colHighTCProp] = newHighTC

	for _, k := range lowTCBiomassClasses {
		ideal[k] = newLowTC / float64(len(lowTCBiomassClasses))
	}
	for _, k := range highTCBiomassClasses {
		ideal[k] = newHighTC / float64(len(highTCBiomassClasses))
	}

	recomputePropDerivedMetrics(ideal, oldLowTC, oldHighTC, lookup)
}

// workflowMeanTC handles §1.3 — meanTC edited directly.
// Computes diffMeanTC = oldMeanTC − newMeanTC (on meanTC's 0–100 percentage
// scale), converts it to the 0–1 fraction scale used by prop_X*Mgha, and
// shifts each of the 10 classes by ±diffMeanTC/100/10 (first 5 low-TC classes
// increase, last 5 decrease), preserving the total sum at 1. Classes are
// clamped to [0,1] then lowTC_prop / highTC_prop and all downstream metrics
// are recomputed.
func workflowMeanTC(ideal, oldIdeal map[string]float64, lookup *LookupData) {
	diffMeanTC := (oldIdeal[colMeanTC] - ideal[colMeanTC]) / 100.0
	shift := diffMeanTC / 10.0

	increasing := []string{
		"prop_X0_5Mgha", "prop_X05_10Mgha", "prop_X10_20Mgha",
		"prop_X20_30Mgha", "prop_X30_40Mgha",
	}
	decreasing := append([]string{"prop_X40_50Mgha"}, highTCBiomassClasses...)

	for _, k := range increasing {
		ideal[k] = math.Max(0, ideal[k]+shift)
	}
	for _, k := range decreasing {
		ideal[k] = math.Max(0, ideal[k]-shift)
	}

	var newLowTC, newHighTC float64
	for _, k := range lowTCBiomassClasses {
		newLowTC += ideal[k]
	}
	for _, k := range highTCBiomassClasses {
		newHighTC += ideal[k]
	}

	oldLowTC := oldIdeal[colLowTCProp]
	oldHighTC := 1.0 - oldLowTC
	ideal[colLowTCProp] = newLowTC
	ideal[colHighTCProp] = newHighTC

	recomputePropDerivedMetrics(ideal, oldLowTC, oldHighTC, lookup)
}

// ── SOC helper ────────────────────────────────────────────────────────────────

// grazingIntensity returns the dimensionless grazing intensity (clamped 0–1).
// herbs_totGRAZING_DMI_kgkm2 (kg/km²) and NPP_gm2 (g/m²) use different units;
// multiplying NPP by 1000 converts g/m² → kg/km² (§3 Branch 2).
func grazingIntensity(dmiKgKm2, nppGm2 float64) float64 {
	if nppGm2 <= 0 {
		return 0
	}
	return math.Min(1, dmiKgKm2/(nppGm2*1000))
}

// workflowSOCGrazing recomputes deltaSOC_Mgha_grazers (§3 Branch 2) using
// the quadratic relationship between grazing intensity and SOC change:
//
//	percChange = a + b·(GI×100) + c·(GI×100)²
//
// The delta is the difference between the target and the pre-edit (oldIdeal)
// grazing-intensity SOC effect, using SOC_Mgha_0_30 as the stock.
func workflowSOCGrazing(ideal, oldIdeal map[string]float64) {
	const (
		socPolyA = -5.91593
		socPolyB = 0.586766
		socPolyC = -0.00935509
	)

	soc0_30 := ideal["SOC_Mgha_0_30"]
	if soc0_30 == 0 {
		return
	}

	percSOCChange := func(gi float64) float64 {
		gi100 := gi * 100
		return socPolyA + socPolyB*gi100 + socPolyC*gi100*gi100
	}

	giTarget := grazingIntensity(ideal["herbs_totGRAZING_DMI_kgkm2"], ideal["NPP_gm2"])
	giBaseline := grazingIntensity(oldIdeal["herbs_totGRAZING_DMI_kgkm2"], oldIdeal["NPP_gm2"])

	diffSOCTarget := soc0_30 * percSOCChange(giTarget) / 100
	diffSOCBaseline := soc0_30 * percSOCChange(giBaseline) / 100

	ideal["deltaSOC_Mgha_grazers"] = diffSOCTarget - diffSOCBaseline
	ideal["deltaSOC_Mgha"] = ideal["deltaSOC_Mgha_trees"] + ideal["deltaSOC_Mgha_grazers"]
}

// ── Herbivore workflows ───────────────────────────────────────────────────────

// recomputeHerbTotals rebuilds all aggregate herbivore fields from the current
// per-species kgkm2 / counts / DMI / CH4 values in ideal, using herb traits
// for Prop_Grass and grouping variables. This is the §4 full recomputation.
func recomputeHerbTotals(ideal map[string]float64, traits map[string]HerbTrait) {
	var totKg, totDMI, totCH4 float64
	var totGrazingKg, totGrazingDMI, totGrazingCH4 float64

	fgKg := make(map[string]float64)
	fgCounts := make(map[string]float64)
	fgDMI := make(map[string]float64)
	fgCH4 := make(map[string]float64)
	dietKg := make(map[string]float64)
	dietCounts := make(map[string]float64)
	dietDMI := make(map[string]float64)
	dietCH4 := make(map[string]float64)

	for k, spKg := range ideal {
		if !strings.HasPrefix(k, colHerbsSpKgkm2Prefix) {
			continue
		}
		commonName := strings.TrimPrefix(k, colHerbsSpKgkm2Prefix)
		trait, ok := traits[commonName]
		if !ok {
			continue
		}
		spCounts := ideal[colHerbsSpCountsPrefix+commonName]
		spDMI := ideal["herbs_sp_DMI_kgkm2_"+commonName]
		spCH4 := ideal["herbs_sp_CH4_kgkm2_"+commonName]

		totKg += spKg
		totDMI += spDMI
		totCH4 += spCH4
		totGrazingKg += spKg * trait.PropGrass
		totGrazingDMI += spDMI * trait.PropGrass
		totGrazingCH4 += spCH4 * trait.PropGrass

		fg := trait.HFTBII
		fgKg[fg] += spKg
		fgCounts[fg] += spCounts
		fgDMI[fg] += spDMI
		fgCH4[fg] += spCH4

		diet := trait.Diet
		dietKg[diet] += spKg
		dietCounts[diet] += spCounts
		dietDMI[diet] += spDMI
		dietCH4[diet] += spCH4
	}

	ideal[colHerbsTot] = totKg
	ideal["herbs_tot_DMI_kgkm2"] = totDMI
	ideal["herbs_tot_CH4_kgkm2"] = totCH4
	ideal["herbs_totGRAZING_kgkm2"] = totGrazingKg
	ideal["herbs_totGRAZING_DMI_kgkm2"] = totGrazingDMI
	ideal["herbs_totGRAZING_CH4_kgkm2"] = totGrazingCH4
	if totKg > 0 {
		ideal["fracGrazing"] = totGrazingKg / totKg
	}

	for fg, v := range fgKg {
		ideal["herbs_fg_kgkm2_"+fg] = v
	}
	for fg, v := range fgCounts {
		ideal["herbs_fg_counts_"+fg] = v
	}
	for fg, v := range fgDMI {
		ideal["herbs_fg_DMI_kgkm2_"+fg] = v
	}
	for fg, v := range fgCH4 {
		ideal["herbs_fg_CH4_kgkm2_"+fg] = v
	}
	for diet, v := range dietKg {
		ideal["herbs_diet_kgkm2_"+diet] = v
	}
	for diet, v := range dietCounts {
		ideal["herbs_diet_counts_"+diet] = v
	}
	for diet, v := range dietDMI {
		ideal["herbs_diet_DMI_kgkm2_"+diet] = v
	}
	for diet, v := range dietCH4 {
		ideal["herbs_diet_CH4_kgkm2_"+diet] = v
	}

	if npp := ideal["NPP_gm2"]; npp > 0 {
		ideal["grazing_intensity"] = grazingIntensity(totGrazingDMI, npp)
	}
}

// workflow2Herbivores handles a direct edit of herbs_tot_kgkm2.
// Without knowing which species changed, proportional scaling is the best
// available approximation. fracGrazing is preserved as a ratio.
func workflow2Herbivores(ideal, oldIdeal map[string]float64, lookup *LookupData) {
	newTotal := ideal[colHerbsTot]
	oldTotal := oldIdeal[colHerbsTot]
	if oldTotal == 0 {
		return
	}
	scale := newTotal / oldTotal

	for k := range ideal {
		if strings.HasPrefix(k, "herbs_") && k != colHerbsTot && k != "fracGrazing" {
			ideal[k] = ideal[k] * scale
		}
	}
	if newTotal > 0 {
		ideal["fracGrazing"] = ideal["herbs_totGRAZING_kgkm2"] / newTotal
	}
	if npp := ideal["NPP_gm2"]; npp > 0 {
		ideal["grazing_intensity"] = grazingIntensity(ideal["herbs_totGRAZING_DMI_kgkm2"], npp)
	}
}

// workflow3GrassNPP handles a direct edit of NPP_gm2.
func workflow3GrassNPP(ideal map[string]float64) {
	if npp := ideal[colNPP]; npp > 0 {
		ideal["grazing_intensity"] = grazingIntensity(ideal["herbs_totGRAZING_DMI_kgkm2"], npp)
	}
}

// workflow2aSpeciesCounts handles §4 trigger: herbs_sp_counts_* edited.
// With herb traits: converts new counts to biomass/DMI/CH4 per species, then
// calls recomputeHerbTotals for the full aggregation.
// Without traits: falls back to count-ratio scaling.
func workflow2aSpeciesCounts(ideal map[string]float64, changedSpecies map[string]bool, oldIdeal map[string]float64, lookup *LookupData) {
	if lookup != nil && lookup.HerbTraits != nil {
		// §4 Step 1 (counts → biomass/DMI/CH4) for each changed species.
		for key := range changedSpecies {
			commonName := strings.TrimPrefix(key, colHerbsSpCountsPrefix)
			trait, ok := lookup.HerbTraits[commonName]
			if !ok {
				continue
			}
			newCount := ideal[key]
			ideal[colHerbsSpKgkm2Prefix+commonName] = newCount * trait.BodyMass
			ideal["herbs_sp_DMI_kgkm2_"+commonName] = newCount * trait.DMIKgIndivYr
			ideal["herbs_sp_CH4_kgkm2_"+commonName] = newCount * trait.CH4KgIndivYr
		}
		// §4 Steps 3–5: recompute all aggregates.
		recomputeHerbTotals(ideal, lookup.HerbTraits)
		return
	}

	// Fallback: proportional scaling by count ratio.
	for key := range changedSpecies {
		sp := strings.TrimPrefix(key, colHerbsSpCountsPrefix)
		oldCount := oldIdeal[key]
		newCount := ideal[key]
		if oldCount > 0 {
			scale := newCount / oldCount
			scaleIdealKey(ideal, colHerbsSpKgkm2Prefix+sp, scale)
			scaleIdealKey(ideal, "herbs_sp_DMI_kgkm2_"+sp, scale)
			scaleIdealKey(ideal, "herbs_sp_CH4_kgkm2_"+sp, scale)
		}
	}
	var newTotKg, newTotDMI, newTotCH4 float64
	for k, v := range ideal {
		switch {
		case strings.HasPrefix(k, colHerbsSpKgkm2Prefix):
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
	if oldTotal > 0 {
		scale := newTotKg / oldTotal
		for k := range ideal {
			if strings.HasPrefix(k, "herbs_diet_") || strings.HasPrefix(k, "herbs_fg_") {
				ideal[k] = ideal[k] * scale
			}
		}
		scaleIdealKey(ideal, "herbs_totGRAZING_kgkm2", scale)
		scaleIdealKey(ideal, "herbs_totGRAZING_DMI_kgkm2", scale)
		scaleIdealKey(ideal, "herbs_totGRAZING_CH4_kgkm2", scale)
	}
	if newTotKg > 0 {
		ideal["fracGrazing"] = ideal["herbs_totGRAZING_kgkm2"] / newTotKg
	}
	if npp := ideal["NPP_gm2"]; npp > 0 {
		ideal["grazing_intensity"] = grazingIntensity(ideal["herbs_totGRAZING_DMI_kgkm2"], npp)
	}
}

// workflow2bSpeciesBiomass handles §4 trigger: herbs_sp_kgkm2_* edited.
// With herb traits: derives counts from biomass/Body_mass, recomputes
// DMI/CH4, then calls recomputeHerbTotals.
// Without traits: falls back to summing totals and proportional scaling.
func workflow2bSpeciesBiomass(ideal map[string]float64, oldIdeal map[string]float64, lookup *LookupData) {
	if lookup != nil && lookup.HerbTraits != nil {
		// §4 Step 1 (biomass → counts → DMI/CH4) for all species.
		for k, spKg := range ideal {
			if !strings.HasPrefix(k, colHerbsSpKgkm2Prefix) {
				continue
			}
			commonName := strings.TrimPrefix(k, colHerbsSpKgkm2Prefix)
			trait, ok := lookup.HerbTraits[commonName]
			if !ok {
				continue
			}
			var newCount float64
			if trait.BodyMass > 0 {
				newCount = spKg / trait.BodyMass
			}
			ideal[colHerbsSpCountsPrefix+commonName] = newCount
			ideal["herbs_sp_DMI_kgkm2_"+commonName] = newCount * trait.DMIKgIndivYr
			ideal["herbs_sp_CH4_kgkm2_"+commonName] = newCount * trait.CH4KgIndivYr
		}
		recomputeHerbTotals(ideal, lookup.HerbTraits)
		return
	}

	// Fallback.
	var newTotKg, newTotDMI, newTotCH4 float64
	for k, v := range ideal {
		switch {
		case strings.HasPrefix(k, colHerbsSpKgkm2Prefix):
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
	if oldTotal > 0 {
		scale := newTotKg / oldTotal
		for k := range ideal {
			if strings.HasPrefix(k, "herbs_diet_") || strings.HasPrefix(k, "herbs_fg_") {
				ideal[k] = ideal[k] * scale
			}
		}
		scaleIdealKey(ideal, "herbs_totGRAZING_kgkm2", scale)
		scaleIdealKey(ideal, "herbs_totGRAZING_DMI_kgkm2", scale)
		scaleIdealKey(ideal, "herbs_totGRAZING_CH4_kgkm2", scale)
	}
	if newTotKg > 0 {
		ideal["fracGrazing"] = ideal["herbs_totGRAZING_kgkm2"] / newTotKg
	}
	if npp := ideal["NPP_gm2"]; npp > 0 {
		ideal["grazing_intensity"] = grazingIntensity(ideal["herbs_totGRAZING_DMI_kgkm2"], npp)
	}
}

// ── Fire workflow (§2) ────────────────────────────────────────────────────────

// workflow4FireCascade recalculates fire metrics from current NPP, litter,
// and total grazing DMI.
func workflow4FireCascade(ideal map[string]float64) {
	npp := ideal["NPP_gm2"]
	litter := ideal["LitterBiomass_gm2"]
	lowTCProp := ideal[colLowTCProp]

	propEarly := ideal["propEarly"]
	if propEarly == 0 {
		propEarly = 0.45
	}

	grazingDMI := ideal["herbs_totGRAZING_DMI_kgkm2"] / 1000.0

	// Step 1 — Fuel load (g/m²).
	fuelload := math.Max(0, npp+litter-grazingDMI)
	ideal["fuelload_gm2"] = fuelload

	// Step 2 — Fireline intensity.
	// Spec: Intensity = exp(6.65747 + coeff*fuelload) - min(Intensity)
	// min(Intensity) = exp(6.65747) at fuelload=0, so both seasons share the same offset.
	minIntensity := math.Exp(6.65747)
	intensityEarly := math.Exp(6.65747+0.0011896*fuelload) - minIntensity
	intensityLate := math.Min(17000, math.Exp(6.65747+0.0035350*fuelload)-minIntensity)
	if mar, ok := ideal["MAR"]; ok && mar > 1500 {
		intensityLate = intensityEarly
	}
	ideal["Intensity_early_kW_m"] = intensityEarly
	ideal["Intensity_late_kW_m"] = intensityLate

	// Step 3 — Raw area burned (%).
	areaBurnedEarly := math.Max(0, 98.24-97.95*math.Exp(-0.001122*intensityEarly))
	areaBurnedLate := math.Max(0, 98.24-97.95*math.Exp(-0.001122*intensityLate))

	// Step 4 — Constrain to flammable area.
	percBurnedEarly := areaBurnedEarly * lowTCProp
	percBurnedLate := areaBurnedLate * lowTCProp
	ideal["percBurned_early"] = percBurnedEarly
	ideal["percBurned_late"] = percBurnedLate

	// Step 5 — Fuel consumption (g/m²).
	fuelConsEarly := fuelload * percBurnedEarly / 100
	fuelConsLate := fuelload * percBurnedLate / 100
	ideal["fuelConsumption_early_gm2"] = fuelConsEarly
	ideal["fuelConsumption_late_gm2"] = fuelConsLate

	// Methane emission factors (g CH4 / kg dry matter):
	//   EFCH4 = 66×(1−MCE)−2; Early MCE=0.92 → 3.28; Late MCE=0.96 → 0.64
	const efch4Early = 66*(1-0.92) - 2
	const efch4Late = 66*(1-0.96) - 2

	// Step 6 — CH4 per season (kg/km²).
	ch4Early := fuelConsEarly * efch4Early
	ch4Late := fuelConsLate * efch4Late
	ideal["CH4_early_kg_km2"] = ch4Early
	ideal["CH4_late_kg_km2"] = ch4Late

	// Step 7 — Blend by propEarly.
	ideal[colPercBurned] = propEarly*percBurnedEarly + (1-propEarly)*percBurnedLate
	ideal["fuelConsumption_gm2"] = fuelConsEarly*propEarly + fuelConsLate*(1-propEarly)
	fireCH4 := ch4Early*propEarly + ch4Late*(1-propEarly)
	ideal["CH4_kg_km2"] = fireCH4

	// Step 8 — Total CH4 = fire + herbivore enteric.
	ideal["CH4_both_kg_km2"] = fireCH4 + ideal["herbs_tot_CH4_kgkm2"]
}

// ── Utilities ─────────────────────────────────────────────────────────────────

// scaleIdealKey multiplies ideal[key] by factor if the key is present.
func scaleIdealKey(ideal map[string]float64, key string, factor float64) {
	if v, ok := ideal[key]; ok {
		ideal[key] = v * factor
	}
}

// propagateIdealToCatchments updates each catchment's Ideal map so that the
// area-weighted average across catchments matches the updated site-level ideal.
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
