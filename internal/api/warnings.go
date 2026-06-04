package api

// Warning message keys returned to the frontend. Keep these stable so the UI
// can attach field-level messaging to known indicators.
const (
	warningNPPGM2 = "NPP_gm2"
)

type targetStateWarningRule struct {
	message string
	check   func(ideal map[string]float64) bool
}

// targetStateWarningRules is the central registry for target-state warning
// conditions. Add new rules here as warning coverage expands.
var targetStateWarningRules = []targetStateWarningRule{
	{
		message: warningNPPGM2,
		check: func(ideal map[string]float64) bool {
			if ideal == nil {
				return false
			}
			herbs, hasHerbs := ideal["herbs_totGRAZING_DMI_kgkm2"]
			npp, hasNPP := ideal[colNPP]
			if !hasHerbs || !hasNPP {
				return false
			}
			return herbs > npp
		},
	},
}

func collectTargetStateWarnings(ideal map[string]float64) []string {
	if ideal == nil {
		return nil
	}

	warnings := make([]string, 0, len(targetStateWarningRules))
	for _, rule := range targetStateWarningRules {
		if rule.check != nil && rule.check(ideal) {
			warnings = append(warnings, rule.message)
		}
	}

	if len(warnings) == 0 {
		return nil
	}
	return warnings
}
