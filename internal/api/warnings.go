package api

// Warning message keys returned to the frontend. Keep these stable so the UI
// can attach field-level messaging to known indicators.
const (
	warningNPPGM2 = "NPP_gm2"
)

type targetStateWarningRule struct {
	message string
	check   func(ideal, reference map[string]float64) bool
}

// targetStateWarningRules is the central registry for target-state warning
// conditions. Add new rules here as warning coverage expands.
var targetStateWarningRules = []targetStateWarningRule{
	{
		message: warningNPPGM2,
		// Fires when target grazing DMI (kg/km²) exceeds the reference NPP
		// capacity. NPP_gm2 (g/m²) × 1000 converts to kg/km² for comparison.
		check: func(ideal, reference map[string]float64) bool {
			if ideal == nil || reference == nil {
				return false
			}
			herbs, hasHerbs := ideal["herbs_totGRAZING_DMI_kgkm2"]
			npp, hasNPP := reference[colNPP]
			if !hasHerbs || !hasNPP {
				return false
			}
			return herbs > npp*1000
		},
	},
}

func collectTargetStateWarnings(ideal, reference map[string]float64) []string {
	if ideal == nil {
		return nil
	}

	warnings := make([]string, 0, len(targetStateWarningRules))
	for _, rule := range targetStateWarningRules {
		if rule.check != nil && rule.check(ideal, reference) {
			warnings = append(warnings, rule.message)
		}
	}

	if len(warnings) == 0 {
		return nil
	}
	return warnings
}
