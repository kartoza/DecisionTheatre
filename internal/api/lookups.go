package api

import (
	"encoding/csv"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/kartoza/decision-theatre/internal/sites"
)

// tcClassColNames maps TC class index (0–9) to the column header used in
// NPP_by_treecover.csv and deltaSOC_bytcc_Mgha.csv.
var tcClassColNames = [10]string{
	"X0_5", "X05_10", "X10_20", "X20_30", "X30_40",
	"X40_50", "X50_60", "X60_70", "X70_80", "X80_100",
}

// HerbTrait stores per-species herbivore traits from herb_traits_ready.csv.
// All rates are annual, per-individual values.
type HerbTrait struct {
	BodyMass     float64 // kg per individual
	Diet         string  // diet category, used for herbs_diet_* aggregation
	HFTBII       string  // functional type, used for herbs_fg_* aggregation
	PropGrass    float64 // fraction of diet that is grass (0–1)
	DMIKgIndivYr float64 // dry matter intake, kg/individual/year
	CH4KgIndivYr float64 // methane emission, kg CH4/individual/year
}

// LookupTables holds per-catchment NPP and SOC lookup arrays plus herbivore
// traits, loaded once at startup from the data directory CSVs.
type LookupTables struct {
	// nppByTC[catchID][i] = NPP (g/m²) for TC class i in catchment catchID.
	nppByTC map[string][10]float64
	// deltaSOCByTC[catchID][i] = deltaSOC (Mg/ha) for TC class i.
	deltaSOCByTC map[string][10]float64
	// herbTraits[Common_name] = species-level traits.
	herbTraits map[string]HerbTrait
}

// LookupData contains site-level aggregate lookup values pre-computed for a
// single PATCH request so that recalculateIdeal can work entirely on site-level
// maps without iterating over catchments.
type LookupData struct {
	// SiteNPPByTC[i] is the area-weighted mean NPP (g/m²) for TC class i across
	// all catchments in the site. Only valid when HasNPP is true.
	SiteNPPByTC [10]float64
	HasNPP      bool

	// SiteSOCByTC[i] is the area-weighted mean deltaSOC lookup value (Mg/ha)
	// for TC class i. Only valid when HasSOC is true.
	SiteSOCByTC [10]float64
	HasSOC      bool

	// CurrentProps[i] are the actual current-state TC class proportions,
	// used as the SOC baseline. Only valid when HasCurrentProps is true.
	CurrentProps    [10]float64
	HasCurrentProps bool

	// HerbTraits maps Common_name (e.g. "Impala") to species traits.
	// Nil when herb_traits_ready.csv was not available.
	HerbTraits map[string]HerbTrait
}

// LoadLookupTables reads the three lookup CSVs from dataDir. Missing files
// are treated as non-fatal: the corresponding map will be nil and
// proportional-scaling fallbacks will be used instead.
func LoadLookupTables(dataDir string) *LookupTables {
	lt := &LookupTables{}
	lt.nppByTC = loadTCLookup(filepath.Join(dataDir, "NPP_by_treecover.csv"), "catchID")
	lt.deltaSOCByTC = loadTCLookup(filepath.Join(dataDir, "deltaSOC_bytcc_Mgha.csv"), "catchID")
	lt.herbTraits = loadHerbTraits(filepath.Join(dataDir, "herb_traits_ready.csv"))
	return lt
}

// BuildLookupData aggregates catchment-level data into site-level lookup
// vectors for a single recalculation request.
func (lt *LookupTables) BuildLookupData(site *sites.Site) *LookupData {
	ld := &LookupData{}
	if lt != nil {
		ld.HerbTraits = lt.herbTraits
	}

	if lt == nil || site == nil {
		return ld
	}

	catchments := site.Catchments

	// Aggregate NPP per TC class as an area-weighted mean across catchments.
	if lt.nppByTC != nil && len(catchments) > 0 {
		var totalFrac float64
		for _, c := range catchments {
			vals, ok := lt.nppByTC[c.ID]
			if !ok {
				continue
			}
			for i := range ld.SiteNPPByTC {
				ld.SiteNPPByTC[i] += c.AOIFraction * vals[i]
			}
			totalFrac += c.AOIFraction
		}
		if totalFrac > 0 {
			for i := range ld.SiteNPPByTC {
				ld.SiteNPPByTC[i] /= totalFrac
			}
		}
		ld.HasNPP = true
	}

	// Aggregate deltaSOC per TC class.
	if lt.deltaSOCByTC != nil && len(catchments) > 0 {
		var totalFrac float64
		for _, c := range catchments {
			vals, ok := lt.deltaSOCByTC[c.ID]
			if !ok {
				continue
			}
			for i := range ld.SiteSOCByTC {
				ld.SiteSOCByTC[i] += c.AOIFraction * vals[i]
			}
			totalFrac += c.AOIFraction
		}
		if totalFrac > 0 {
			for i := range ld.SiteSOCByTC {
				ld.SiteSOCByTC[i] /= totalFrac
			}
		}
		ld.HasSOC = true
	}

	// Current-state TC class proportions for SOC baseline computation.
	if site.Indicators != nil && site.Indicators.Current != nil {
		curr := site.Indicators.Current
		for i, k := range allBiomassClasses {
			ld.CurrentProps[i] = curr[k]
		}
		ld.HasCurrentProps = true
	}

	return ld
}

// loadTCLookup reads a two-column CSV (catchID + 10 TC class columns) and
// returns a map of catchID → [10]float64. The idCol parameter names the
// identifier column.
func loadTCLookup(path, idCol string) map[string][10]float64 {
	f, err := os.Open(path)
	if err != nil {
		log.Printf("Info: %s not found; proportional scaling will be used (%v)", path, err)
		return nil
	}
	defer f.Close()

	r := csv.NewReader(f)
	headers, err := r.Read()
	if err != nil {
		return nil
	}

	idIdx := -1
	var classIdxs [10]int
	for i := range classIdxs {
		classIdxs[i] = -1
	}
	for i, h := range headers {
		if strings.TrimSpace(h) == idCol {
			idIdx = i
		}
		for j, cn := range tcClassColNames {
			if strings.TrimSpace(h) == cn {
				classIdxs[j] = i
			}
		}
	}
	if idIdx == -1 {
		log.Printf("Warning: %s has no %q column", path, idCol)
		return nil
	}

	result := make(map[string][10]float64, 160000)
	for {
		rec, err := r.Read()
		if err != nil {
			break
		}
		if idIdx >= len(rec) {
			continue
		}
		catchID := strings.TrimSpace(rec[idIdx])
		var vals [10]float64
		for j, idx := range classIdxs {
			if idx >= 0 && idx < len(rec) {
				vals[j], _ = strconv.ParseFloat(strings.TrimSpace(rec[idx]), 64)
			}
		}
		result[catchID] = vals
	}
	log.Printf("Loaded %s: %d catchments", path, len(result))
	return result
}

// loadHerbTraits reads herb_traits_ready.csv and returns a map of
// Common_name → HerbTrait.
func loadHerbTraits(path string) map[string]HerbTrait {
	f, err := os.Open(path)
	if err != nil {
		log.Printf("Info: %s not found; proportional scaling will be used (%v)", path, err)
		return nil
	}
	defer f.Close()

	r := csv.NewReader(f)
	headers, err := r.Read()
	if err != nil {
		return nil
	}

	idx := make(map[string]int, len(headers))
	for i, h := range headers {
		idx[strings.TrimSpace(h)] = i
	}

	get := func(rec []string, col string) string {
		i, ok := idx[col]
		if !ok || i >= len(rec) {
			return ""
		}
		return strings.TrimSpace(rec[i])
	}
	getF := func(rec []string, col string) float64 {
		v, _ := strconv.ParseFloat(get(rec, col), 64)
		return v
	}

	result := make(map[string]HerbTrait)
	for {
		rec, err := r.Read()
		if err != nil {
			break
		}
		name := get(rec, "Common_name")
		if name == "" {
			continue
		}
		result[name] = HerbTrait{
			BodyMass:     getF(rec, "Body_mass"),
			Diet:         get(rec, "Diet"),
			HFTBII:       get(rec, "HFT_BII"),
			PropGrass:    getF(rec, "Prop_Grass"),
			DMIKgIndivYr: getF(rec, "DMI_kg_indiv_yr"),
			CH4KgIndivYr: getF(rec, "CH4_kg_indiv_yr"),
		}
	}
	log.Printf("Loaded %s: %d species", path, len(result))
	return result
}
