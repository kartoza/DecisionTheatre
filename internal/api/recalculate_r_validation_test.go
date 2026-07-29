package api

import (
	"bytes"
	"encoding/json"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// recalculate_r_validation_test.go checks that recalculateIdeal (the Go
// reimplementation of the "edit a factor in the model editor" cascade) still
// agrees with the R model equations in "data/R scripts/validate_cascade.R".
//
// This is a dev/CI-only safety net, not something the shipped app runs: it
// requires Rscript plus the jsonlite package, so it is skipped automatically
// when either is unavailable. Set DT_REQUIRE_R_VALIDATION=1 to make a missing
// R toolchain a hard test failure instead (used by the CI job that installs R
// specifically to run this check).

const rValidationScript = "../../data/R scripts/validate_cascade.R"

// rHerbTrait mirrors HerbTrait using the snake_case field names that
// validate_cascade.R expects.
type rHerbTrait struct {
	BodyMass     float64 `json:"body_mass"`
	Diet         string  `json:"diet"`
	HFTBII       string  `json:"hft_bii"`
	PropGrass    float64 `json:"prop_grass"`
	DMIKgIndivYr float64 `json:"dmi_kg_indiv_yr"`
	CH4KgIndivYr float64 `json:"ch4_kg_indiv_yr"`
}

// rLookup mirrors LookupData using the snake_case field names that
// validate_cascade.R expects.
type rLookup struct {
	SiteNPPByTC     []float64             `json:"site_npp_by_tc,omitempty"`
	HasNPP          bool                  `json:"has_npp"`
	SiteSOCByTC     []float64             `json:"site_soc_by_tc,omitempty"`
	HasSOC          bool                  `json:"has_soc"`
	CurrentProps    []float64             `json:"current_props,omitempty"`
	HasCurrentProps bool                  `json:"has_current_props"`
	HerbTraits      map[string]rHerbTrait `json:"herb_traits"`
}

// rCascadeRequest is the JSON payload sent to validate_cascade.R on stdin.
type rCascadeRequest struct {
	Ideal                 map[string]float64 `json:"ideal"`
	OldIdeal              map[string]float64 `json:"old_ideal"`
	ChangedTargets        []string            `json:"changed_targets"`
	ChangedSpeciesCounts  []string            `json:"changed_species_counts"`
	ChangedSpeciesBiomass []string            `json:"changed_species_biomass"`
	PropClassChanged      bool                `json:"prop_class_changed"`
	Lookup                *rLookup            `json:"lookup,omitempty"`
}

func toRLookup(l *LookupData) *rLookup {
	if l == nil {
		return nil
	}
	rl := &rLookup{
		HasNPP:          l.HasNPP,
		HasSOC:          l.HasSOC,
		HasCurrentProps: l.HasCurrentProps,
		HerbTraits:      make(map[string]rHerbTrait, len(l.HerbTraits)),
	}
	if l.HasNPP {
		rl.SiteNPPByTC = l.SiteNPPByTC[:]
	}
	if l.HasSOC {
		rl.SiteSOCByTC = l.SiteSOCByTC[:]
	}
	if l.HasCurrentProps {
		rl.CurrentProps = l.CurrentProps[:]
	}
	for name, trait := range l.HerbTraits {
		rl.HerbTraits[name] = rHerbTrait{
			BodyMass:     trait.BodyMass,
			Diet:         trait.Diet,
			HFTBII:       trait.HFTBII,
			PropGrass:    trait.PropGrass,
			DMIKgIndivYr: trait.DMIKgIndivYr,
			CH4KgIndivYr: trait.CH4KgIndivYr,
		}
	}
	return rl
}

func setKeys(keys ...string) map[string]bool {
	set := make(map[string]bool, len(keys))
	for _, k := range keys {
		set[k] = true
	}
	return set
}

func keysOf(set map[string]bool) []string {
	keys := make([]string, 0, len(set))
	for k := range set {
		keys = append(keys, k)
	}
	return keys
}

func cloneFloatMap(m map[string]float64) map[string]float64 {
	out := make(map[string]float64, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// runRCascade invokes validate_cascade.R with req on stdin and returns the
// resulting indicator map. It skips the test (or fails it, if
// DT_REQUIRE_R_VALIDATION=1) when Rscript or jsonlite are unavailable.
func runRCascade(t *testing.T, req rCascadeRequest) map[string]float64 {
	t.Helper()

	requireR := os.Getenv("DT_REQUIRE_R_VALIDATION") == "1"

	if _, err := exec.LookPath("Rscript"); err != nil {
		if requireR {
			t.Fatalf("Rscript not found in PATH, but DT_REQUIRE_R_VALIDATION=1: %v", err)
		}
		t.Skip("Rscript not found in PATH; skipping R cascade validation")
	}

	scriptPath, err := filepath.Abs(rValidationScript)
	if err != nil {
		t.Fatalf("resolving %s: %v", rValidationScript, err)
	}

	payload, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshaling R cascade request: %v", err)
	}

	cmd := exec.Command("Rscript", scriptPath)
	cmd.Stdin = bytes.NewReader(payload)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		msg := err.Error() + "\n" + stderr.String()
		if requireR {
			t.Fatalf("running validate_cascade.R: %s", msg)
		}
		t.Skipf("could not run validate_cascade.R (likely missing jsonlite): %s", msg)
	}

	var result map[string]float64
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("parsing validate_cascade.R output %q: %v", stdout.String(), err)
	}
	return result
}

const floatTolerance = 1e-6

func assertCascadesMatch(t *testing.T, goResult, rResult map[string]float64) {
	t.Helper()

	seen := make(map[string]bool, len(goResult)+len(rResult))
	for k := range goResult {
		seen[k] = true
	}
	for k := range rResult {
		seen[k] = true
	}

	for key := range seen {
		goVal, goOK := goResult[key]
		rVal, rOK := rResult[key]
		if goOK != rOK {
			t.Errorf("key %q present in Go=%v but R=%v", key, goOK, rOK)
			continue
		}
		tolerance := floatTolerance * math.Max(1, math.Max(math.Abs(goVal), math.Abs(rVal)))
		if math.Abs(goVal-rVal) > tolerance {
			t.Errorf("key %q: Go=%v R=%v (diff %v > tolerance %v)", key, goVal, rVal, math.Abs(goVal-rVal), tolerance)
		}
	}
}

// baseCascadeIdeal returns a representative indicator map covering every
// cascade branch (tree cover, herbivores incl. two species, fire, SOC).
func baseCascadeIdeal() map[string]float64 {
	return map[string]float64{
		"prop_X0_5Mgha": 0.05, "prop_X05_10Mgha": 0.05, "prop_X10_20Mgha": 0.1,
		"prop_X20_30Mgha": 0.1, "prop_X30_40Mgha": 0.1, "prop_X40_50Mgha": 0.1,
		"prop_X50_60Mgha": 0.1, "prop_X60_70Mgha": 0.1, "prop_X70_80Mgha": 0.15, "prop_X80_100Mgha": 0.15,
		"lowTC_prop": 0.5, "highTC_prop": 0.5, "meanTC": 40,
		"AGBwd_Mgha": 40, "LitterBiomass_gm2": 150,
		"NPP_gm2": 300, "flamNPP_gm2": 200,
		"deltaSOC_Mgha_trees": 1, "deltaSOC_Mgha_grazers": 0.5, "deltaSOC_Mgha": 1.5,
		"SOC_Mgha_0_30": 50,
		"herbs_tot_kgkm2": 1000, "herbs_tot_DMI_kgkm2": 500, "herbs_tot_CH4_kgkm2": 5,
		"herbs_totGRAZING_kgkm2": 700, "herbs_totGRAZING_DMI_kgkm2": 350, "herbs_totGRAZING_CH4_kgkm2": 3,
		"fracGrazing": 0.7, "grazing_intensity": 0.1,
		"propEarly": 0.45, "MAR": 800,
		"herbs_sp_counts_Impala": 100, "herbs_sp_kgkm2_Impala": 4000,
		"herbs_sp_DMI_kgkm2_Impala": 200, "herbs_sp_CH4_kgkm2_Impala": 2,
		"herbs_sp_counts_Zebra": 20, "herbs_sp_kgkm2_Zebra": 5000,
		"herbs_sp_DMI_kgkm2_Zebra": 150, "herbs_sp_CH4_kgkm2_Zebra": 1,
	}
}

func baseCascadeLookup() *LookupData {
	return &LookupData{
		SiteNPPByTC:     [10]float64{400, 380, 360, 340, 320, 300, 280, 260, 240, 220},
		HasNPP:          true,
		SiteSOCByTC:     [10]float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
		HasSOC:          true,
		CurrentProps:    [10]float64{0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1, 0.1},
		HasCurrentProps: true,
		HerbTraits: map[string]HerbTrait{
			"Impala": {BodyMass: 40, Diet: "Grazer", HFTBII: "Small", PropGrass: 0.9, DMIKgIndivYr: 2, CH4KgIndivYr: 0.02},
			"Zebra":  {BodyMass: 250, Diet: "Grazer", HFTBII: "Large", PropGrass: 0.95, DMIKgIndivYr: 3, CH4KgIndivYr: 0.05},
		},
	}
}

// cascadeCase describes a single "user edited factor X" scenario.
type cascadeCase struct {
	name                  string
	edit                  func(ideal map[string]float64)
	changedTargets        map[string]bool
	changedSpeciesCounts  map[string]bool
	changedSpeciesBiomass map[string]bool
	propClassChanged      bool
}

func cascadeCases() []cascadeCase {
	return []cascadeCase{
		{
			name:           "tree_cover_edit",
			edit:           func(ideal map[string]float64) { ideal["lowTC_prop"] = 0.7 },
			changedTargets: setKeys("lowTC_prop"),
		},
		{
			name:           "mean_tc_edit",
			edit:           func(ideal map[string]float64) { ideal["meanTC"] = 25 },
			changedTargets: setKeys("meanTC"),
		},
		{
			// A target far outside what the current classes can reach without
			// clamping — locks in that the shift is applied uncapped (some
			// classes go negative) rather than clamped at zero.
			name:           "mean_tc_edit_unreachable_target",
			edit:           func(ideal map[string]float64) { ideal["meanTC"] = 5 },
			changedTargets: setKeys("meanTC"),
		},
		{
			name:             "prop_class_edit",
			edit:             func(ideal map[string]float64) { ideal["prop_X0_5Mgha"] = 0.15 },
			changedTargets:   setKeys(),
			propClassChanged: true,
		},
		{
			name:           "herbivore_total_edit",
			edit:           func(ideal map[string]float64) { ideal["herbs_tot_kgkm2"] = 1500 },
			changedTargets: setKeys("herbs_tot_kgkm2"),
		},
		{
			name:                 "species_counts_edit",
			edit:                 func(ideal map[string]float64) { ideal["herbs_sp_counts_Impala"] = 150 },
			changedTargets:       setKeys(),
			changedSpeciesCounts: setKeys("herbs_sp_counts_Impala"),
		},
		{
			name:                  "species_biomass_edit",
			edit:                  func(ideal map[string]float64) { ideal["herbs_sp_kgkm2_Zebra"] = 6000 },
			changedTargets:        setKeys(),
			changedSpeciesBiomass: setKeys("herbs_sp_kgkm2_Zebra"),
		},
		{
			name:           "npp_direct_edit",
			edit:           func(ideal map[string]float64) { ideal["NPP_gm2"] = 350 },
			changedTargets: setKeys("NPP_gm2"),
		},
		{
			name:           "prop_early_edit",
			edit:           func(ideal map[string]float64) { ideal["propEarly"] = 0.6 },
			changedTargets: setKeys("propEarly"),
		},
	}
}

// TestRecalculateMatchesRCascade runs recalculateIdeal (Go) and
// validate_cascade.R (R) on identical inputs for a representative set of
// "user edited factor X in the model editor" scenarios, and asserts the two
// engines produce the same indicator values. See the package comment above
// for why this exists instead of shipping R in the app.
func TestRecalculateMatchesRCascade(t *testing.T) {
	lookup := baseCascadeLookup()

	for _, tc := range cascadeCases() {
		t.Run(tc.name, func(t *testing.T) {
			oldIdeal := baseCascadeIdeal()
			ideal := cloneFloatMap(oldIdeal)
			tc.edit(ideal)

			goResult := cloneFloatMap(ideal)
			recalculateIdeal(goResult, tc.changedTargets, oldIdeal, tc.changedSpeciesCounts, tc.changedSpeciesBiomass, tc.propClassChanged, lookup)

			req := rCascadeRequest{
				Ideal:                 ideal,
				OldIdeal:              oldIdeal,
				ChangedTargets:        keysOf(tc.changedTargets),
				ChangedSpeciesCounts:  keysOf(tc.changedSpeciesCounts),
				ChangedSpeciesBiomass: keysOf(tc.changedSpeciesBiomass),
				PropClassChanged:      tc.propClassChanged,
				Lookup:                toRLookup(lookup),
			}
			rResult := runRCascade(t, req)

			assertCascadesMatch(t, goResult, rResult)
		})
	}
}
