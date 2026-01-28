//go:build cgo_gorgonia

package nn

import (
	"os"
	"path/filepath"
	"testing"
)

func TestNewCatchmentModel(t *testing.T) {
	cfg := DefaultCatchmentModelConfig()
	model := NewCatchmentModel(cfg)

	if model == nil {
		t.Fatal("Expected non-nil model")
	}

	if model.IsTrained() {
		t.Error("New model should not be trained")
	}
}

func TestDefaultConfig(t *testing.T) {
	cfg := DefaultCatchmentModelConfig()

	if cfg.InputDim != 64 {
		t.Errorf("Expected InputDim=64, got %d", cfg.InputDim)
	}
	if cfg.HiddenDim != 128 {
		t.Errorf("Expected HiddenDim=128, got %d", cfg.HiddenDim)
	}
	if cfg.OutputDim != 32 {
		t.Errorf("Expected OutputDim=32, got %d", cfg.OutputDim)
	}
	if cfg.NumLayers != 3 {
		t.Errorf("Expected NumLayers=3, got %d", cfg.NumLayers)
	}
}

func TestPredict(t *testing.T) {
	cfg := CatchmentModelConfig{
		InputDim:     4,
		HiddenDim:    8,
		OutputDim:    2,
		NumLayers:    2,
		LearningRate: 0.001,
	}
	model := NewCatchmentModel(cfg)

	input := []float64{1.0, 2.0, 3.0, 4.0}
	output, err := model.Predict(input)
	if err != nil {
		t.Fatalf("Predict failed: %v", err)
	}

	if len(output) != 2 {
		t.Errorf("Expected output length 2, got %d", len(output))
	}
}

func TestPredictShortInput(t *testing.T) {
	cfg := CatchmentModelConfig{
		InputDim:     4,
		HiddenDim:    8,
		OutputDim:    2,
		NumLayers:    2,
		LearningRate: 0.001,
	}
	model := NewCatchmentModel(cfg)

	// Input shorter than inputDim - should be padded
	input := []float64{1.0, 2.0}
	output, err := model.Predict(input)
	if err != nil {
		t.Fatalf("Predict with short input failed: %v", err)
	}

	if len(output) != 2 {
		t.Errorf("Expected output length 2, got %d", len(output))
	}
}

func TestGetConfig(t *testing.T) {
	cfg := DefaultCatchmentModelConfig()
	model := NewCatchmentModel(cfg)

	info := model.GetConfig()
	if info["input_dim"] != 64 {
		t.Errorf("Expected input_dim=64 in config, got %v", info["input_dim"])
	}
}

func TestSaveLoad(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "model.gob")

	cfg := CatchmentModelConfig{
		InputDim:     4,
		HiddenDim:    8,
		OutputDim:    2,
		NumLayers:    2,
		LearningRate: 0.001,
	}
	model := NewCatchmentModel(cfg)

	// Save
	if err := model.Save(path); err != nil {
		t.Fatalf("Save failed: %v", err)
	}

	// Verify file exists
	if _, err := os.Stat(path); os.IsNotExist(err) {
		t.Fatal("Model file was not created")
	}

	// Load into new model
	model2 := NewCatchmentModel(DefaultCatchmentModelConfig())
	if err := model2.Load(path); err != nil {
		t.Fatalf("Load failed: %v", err)
	}

	if model2.inputDim != 4 {
		t.Errorf("Loaded model inputDim=%d, expected 4", model2.inputDim)
	}
	if model2.hiddenDim != 8 {
		t.Errorf("Loaded model hiddenDim=%d, expected 8", model2.hiddenDim)
	}
}

func TestPadOrTruncate(t *testing.T) {
	tests := []struct {
		name     string
		input    []float64
		length   int
		expected int
	}{
		{"exact", []float64{1, 2, 3}, 3, 3},
		{"pad", []float64{1, 2}, 5, 5},
		{"truncate", []float64{1, 2, 3, 4, 5}, 3, 3},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := padOrTruncate(tt.input, tt.length)
			if len(result) != tt.expected {
				t.Errorf("Expected length %d, got %d", tt.expected, len(result))
			}
		})
	}
}
