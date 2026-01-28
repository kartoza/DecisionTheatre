//go:build !cgo_gorgonia

package nn

// Stub implementation when Gorgonia is not available.
// Build with -tags cgo_gorgonia to enable the real implementation.

// CatchmentModel is a stub when built without cgo_gorgonia tag
type CatchmentModel struct {
	inputDim  int
	hiddenDim int
	outputDim int
	numLayers int
	trained   bool
}

// CatchmentModelConfig holds model configuration
type CatchmentModelConfig struct {
	InputDim     int
	HiddenDim    int
	OutputDim    int
	NumLayers    int
	LearningRate float64
}

// DefaultCatchmentModelConfig returns sensible defaults
func DefaultCatchmentModelConfig() CatchmentModelConfig {
	return CatchmentModelConfig{}
}

// NewCatchmentModel returns a stub (Gorgonia not compiled in)
func NewCatchmentModel(_ CatchmentModelConfig) *CatchmentModel {
	return &CatchmentModel{}
}

// Predict is unavailable without Gorgonia
func (m *CatchmentModel) Predict(_ []float64) ([]float64, error) {
	return nil, nil
}

// Train is unavailable without Gorgonia
func (m *CatchmentModel) Train(_, _ [][]float64, _ int) error {
	return nil
}

// IsTrained always returns false without Gorgonia
func (m *CatchmentModel) IsTrained() bool {
	return false
}

// GetConfig returns stub config
func (m *CatchmentModel) GetConfig() map[string]interface{} {
	return map[string]interface{}{
		"available": false,
		"message":   "Built without cgo_gorgonia tag. Rebuild with: go build -tags cgo_gorgonia",
	}
}

// Save is a no-op
func (m *CatchmentModel) Save(_ string) error {
	return nil
}

// Load is a no-op
func (m *CatchmentModel) Load(_ string) error {
	return nil
}
