package api

import "testing"

// metadata.csv is exported from R, whose make.names() rewrites spaces and hyphens
// to dots. The GeoPackage keeps the original names, so `Obligate grazer` in the
// data is `Obligate.grazer` in the metadata — and the lookup is an exact string
// comparison. Against the supplied datapack that hid 344 of 505 columns: no
// colour, no detailed name, no units, no axis label, no chart type.

func fixtureCache() *MetadataCache {
	mc := &MetadataCache{
		Colors:            map[string]string{},
		Details:           map[string]string{},
		VariableTypes:     map[string]string{},
		Inputs:            map[string]bool{},
		TargetInputs:      map[string]bool{},
		TargetRanges:      map[string]TargetRange{},
		CanMap:            map[string]bool{},
		CanGraph:          map[string]bool{},
		AxisLabels:        map[string]string{},
		XAxisLabels:       map[string]string{},
		Units:             map[string]string{},
		ChartTypes:        map[string]string{},
		GroupingVariables: map[string]string{},
		GroupingValues:    map[string]string{},
		Dial0Middle:       map[string]bool{},
		IgnoreXGrouping:   map[string]bool{},
		MaxValCurrent:     map[string]float64{},
		MaxValReference:   map[string]float64{},
	}
	// As metadata.csv spells it.
	mc.Details["herbs_diet_kgkm2_Obligate.grazer"] = "Obligate grazer biomass"
	mc.Units["herbs_diet_kgkm2_Obligate.grazer"] = "kg/km2"
	mc.CanGraph["herbs_diet_kgkm2_Obligate.grazer"] = true
	return mc
}

func TestAliasMakesASpacedColumnResolvable(t *testing.T) {
	mc := fixtureCache()
	real := "herbs_diet_kgkm2_Obligate grazer"

	if mc.Details[real] != "" {
		t.Fatal("the fixture already resolves; the test proves nothing")
	}

	mc.AddColumnAliases([]string{real})

	if got := mc.Details[real]; got != "Obligate grazer biomass" {
		t.Errorf("Details[%q] = %q, want the metadata row's value", real, got)
	}
	if got := mc.Units[real]; got != "kg/km2" {
		t.Errorf("Units[%q] = %q", real, got)
	}
	if !mc.CanGraph[real] {
		t.Errorf("CanGraph[%q] is false; the indicator stays out of the selector", real)
	}
}

// make.names maps both ' ' and '-' to '.', so reversing the substitution is
// ambiguous. Building the alias from the real column forward has one answer.
func TestAliasHandlesAHyphenatedColumn(t *testing.T) {
	mc := fixtureCache()
	mc.Details["herbs_diet_kgkm2_Browser.grazer.intermediate"] = "Browser-grazer intermediate"

	real := "herbs_diet_kgkm2_Browser-grazer intermediate"
	mc.AddColumnAliases([]string{real})

	if got := mc.Details[real]; got != "Browser-grazer intermediate" {
		t.Errorf("a column with both a hyphen and a space did not resolve: %q", got)
	}
}

// A name that already matches must not be rewritten by the alias pass.
func TestAliasDoesNotOverwriteAnExistingEntry(t *testing.T) {
	mc := fixtureCache()
	mc.Details["plain_column"] = "the CSV's own value"

	mc.AddColumnAliases([]string{"plain_column"})

	if got := mc.Details["plain_column"]; got != "the CSV's own value" {
		t.Errorf("Details[plain_column] = %q, want the original", got)
	}
}

// Only true entries in the boolean sets are worth aliasing: those maps carry
// meaning by presence, and copying a false would assert something the CSV did not.
func TestAliasDoesNotInventFalseFlags(t *testing.T) {
	mc := fixtureCache()
	mc.CanMap["herbs_diet_kgkm2_Obligate.grazer"] = false

	real := "herbs_diet_kgkm2_Obligate grazer"
	mc.AddColumnAliases([]string{real})

	if _, exists := mc.CanMap[real]; exists {
		t.Error("a false flag was aliased; presence in this map is what is read")
	}
}

func TestAliasIgnoresColumnsThatNeedNoAlias(t *testing.T) {
	mc := fixtureCache()
	before := len(mc.Details)

	mc.AddColumnAliases([]string{"lowTC_prop", "meanTC", "NPP_gm2"})

	if len(mc.Details) != before {
		t.Errorf("Details grew from %d to %d for columns with no dotted counterpart",
			before, len(mc.Details))
	}
}

// The count is the report a caller logs; it must reflect real work.
func TestAliasReportsHowManyItFixed(t *testing.T) {
	mc := fixtureCache()

	n := mc.AddColumnAliases([]string{
		"herbs_diet_kgkm2_Obligate grazer", // aliased
		"lowTC_prop",                       // nothing to alias
	})

	if n != 1 {
		t.Errorf("reported %d aliases, want 1", n)
	}
}
