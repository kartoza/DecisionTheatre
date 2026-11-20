// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

package geodata

// WhiskerBounds holds area-weighted upper/lower bounds for all attribute columns.
type WhiskerBounds struct {
	ReferenceUpper map[string]float64 `json:"referenceUpper"`
	ReferenceLower map[string]float64 `json:"referenceLower"`
	CurrentUpper   map[string]float64 `json:"currentUpper"`
	CurrentLower   map[string]float64 `json:"currentLower"`
}
