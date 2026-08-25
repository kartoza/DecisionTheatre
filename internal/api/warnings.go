package api

// Warning message keys returned to the frontend. Keep these stable so the UI
// can attach field-level messaging to known indicators.
const (
	warningNPPGM2 = "NPP_gm2"
)

type targetStateWarningRule struct {
	message string
	check   func(ideal, reference, current map[string]float64) bool
}

// targetStateWarningRules is the central registry for target-state warning
// conditions. Add new rules here as warning coverage expands.
var targetStateWarningRules = []targetStateWarningRule{
	{
		message: warningNPPGM2,
		// Fires when target grazing DMI (g/m²) exceeds the current NPP
		// capacity (g/m²) — both are in the same units, so no conversion
		// is needed.
		check: func(ideal, reference, current map[string]float64) bool {
			if ideal == nil || current == nil {
				return false
			}
			herbs, hasHerbs := ideal[colHerbsTotGrazingDMI]
			herbsCurrent, hasHerbsCurrent := current[colHerbsTotGrazingDMI]
			if !hasHerbs || !hasHerbsCurrent {
				return false
			}

			npp, hasNPP := ideal[colNPP]

			if !hasHerbs || !hasNPP {
				return false
			}

			if herbsCurrent != herbs {
				return herbs > npp
			}
			return false
		},
	},
}

func collectTargetStateWarnings(ideal, reference, current map[string]float64) []string {
	if ideal == nil {
		return nil
	}

	warnings := make([]string, 0, len(targetStateWarningRules))
	for _, rule := range targetStateWarningRules {
		if rule.check != nil && rule.check(ideal, reference, current) {
			warnings = append(warnings, rule.message)
		}
	}

	if len(warnings) == 0 {
		return nil
	}
	return warnings
}
