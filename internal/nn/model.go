//go:build cgo_gorgonia

package nn

import (
	"encoding/gob"
	"fmt"
	"math"
	"math/rand"
	"os"
	"sync"

	"gorgonia.org/gorgonia"
	"gorgonia.org/tensor"
)

// CatchmentModel is a neural network for predicting catchment attributes
// It uses a feed-forward network with configurable hidden layers
type CatchmentModel struct {
	g  *gorgonia.ExprGraph
	vm gorgonia.VM

	// Architecture
	inputDim  int
	hiddenDim int
	outputDim int
	numLayers int

	// Weights
	weights    []*gorgonia.Node
	biases     []*gorgonia.Node
	learnables gorgonia.Nodes

	// I/O nodes
	input  *gorgonia.Node
	output *gorgonia.Node
	loss   *gorgonia.Node

	// Training
	solver  gorgonia.Solver
	trained bool
	mu      sync.RWMutex
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
	return CatchmentModelConfig{
		InputDim:     64,
		HiddenDim:    128,
		OutputDim:    32,
		NumLayers:    3,
		LearningRate: 0.001,
	}
}

// NewCatchmentModel creates a new catchment prediction model
func NewCatchmentModel(cfg CatchmentModelConfig) *CatchmentModel {
	g := gorgonia.NewGraph()

	m := &CatchmentModel{
		g:         g,
		inputDim:  cfg.InputDim,
		hiddenDim: cfg.HiddenDim,
		outputDim: cfg.OutputDim,
		numLayers: cfg.NumLayers,
	}

	m.initWeights()
	m.solver = gorgonia.NewAdamSolver(gorgonia.WithLearnRate(cfg.LearningRate))

	return m
}

// initWeights initializes all model weights with Xavier initialization
func (m *CatchmentModel) initWeights() {
	m.weights = make([]*gorgonia.Node, m.numLayers)
	m.biases = make([]*gorgonia.Node, m.numLayers)

	// First layer: input -> hidden
	m.weights[0] = m.newWeight("w0", m.inputDim, m.hiddenDim)
	m.biases[0] = m.newBias("b0", m.hiddenDim)

	// Hidden layers
	for i := 1; i < m.numLayers-1; i++ {
		m.weights[i] = m.newWeight(fmt.Sprintf("w%d", i), m.hiddenDim, m.hiddenDim)
		m.biases[i] = m.newBias(fmt.Sprintf("b%d", i), m.hiddenDim)
	}

	// Output layer: hidden -> output
	m.weights[m.numLayers-1] = m.newWeight(fmt.Sprintf("w%d", m.numLayers-1), m.hiddenDim, m.outputDim)
	m.biases[m.numLayers-1] = m.newBias(fmt.Sprintf("b%d", m.numLayers-1), m.outputDim)

	// Collect learnables
	m.learnables = make(gorgonia.Nodes, 0, m.numLayers*2)
	for i := 0; i < m.numLayers; i++ {
		m.learnables = append(m.learnables, m.weights[i], m.biases[i])
	}
}

func (m *CatchmentModel) newWeight(name string, rows, cols int) *gorgonia.Node {
	scale := math.Sqrt(2.0 / float64(rows+cols))
	backing := make([]float64, rows*cols)
	for i := range backing {
		backing[i] = (rand.Float64()*2 - 1) * scale
	}

	t := tensor.New(
		tensor.WithShape(rows, cols),
		tensor.WithBacking(backing),
	)
	return gorgonia.NewMatrix(m.g, tensor.Float64,
		gorgonia.WithShape(rows, cols),
		gorgonia.WithName(name),
		gorgonia.WithValue(t),
	)
}

func (m *CatchmentModel) newBias(name string, size int) *gorgonia.Node {
	t := tensor.New(
		tensor.WithShape(size),
		tensor.WithBacking(make([]float64, size)),
	)
	return gorgonia.NewVector(m.g, tensor.Float64,
		gorgonia.WithShape(size),
		gorgonia.WithName(name),
		gorgonia.WithValue(t),
	)
}

// Forward performs a forward pass
func (m *CatchmentModel) Forward(inputData []float64) (*gorgonia.Node, error) {
	m.g = gorgonia.NewGraph()
	m.initWeights()

	// Create input node
	inputT := tensor.New(
		tensor.WithShape(1, m.inputDim),
		tensor.WithBacking(padOrTruncate(inputData, m.inputDim)),
	)
	m.input = gorgonia.NewMatrix(m.g, tensor.Float64,
		gorgonia.WithShape(1, m.inputDim),
		gorgonia.WithName("input"),
		gorgonia.WithValue(inputT),
	)

	// Forward through layers
	hidden := m.input
	var err error

	for i := 0; i < m.numLayers; i++ {
		// Linear: h = x * W + b
		hidden, err = gorgonia.Mul(hidden, m.weights[i])
		if err != nil {
			return nil, fmt.Errorf("layer %d mul: %w", i, err)
		}

		hidden, err = gorgonia.BroadcastAdd(hidden, m.biases[i], nil, []byte{0})
		if err != nil {
			return nil, fmt.Errorf("layer %d bias: %w", i, err)
		}

		// Activation: ReLU for hidden layers, none for output
		if i < m.numLayers-1 {
			hidden, err = gorgonia.Rectify(hidden)
			if err != nil {
				return nil, fmt.Errorf("layer %d relu: %w", i, err)
			}
		}
	}

	m.output = hidden
	return hidden, nil
}

// Predict runs inference on the model
func (m *CatchmentModel) Predict(inputData []float64) ([]float64, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()

	output, err := m.Forward(inputData)
	if err != nil {
		return nil, err
	}

	vm := gorgonia.NewTapeMachine(m.g)
	defer vm.Close()

	if err := vm.RunAll(); err != nil {
		return nil, fmt.Errorf("vm run failed: %w", err)
	}

	outVal := output.Value()
	if outVal == nil {
		return nil, fmt.Errorf("no output value")
	}

	data := outVal.Data().([]float64)
	result := make([]float64, len(data))
	copy(result, data)
	return result, nil
}

// Train trains the model on provided data
func (m *CatchmentModel) Train(inputs [][]float64, targets [][]float64, epochs int) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	for epoch := 0; epoch < epochs; epoch++ {
		totalLoss := 0.0

		for i := range inputs {
			output, err := m.Forward(inputs[i])
			if err != nil {
				return fmt.Errorf("forward failed: %w", err)
			}

			// Compute MSE loss
			targetT := tensor.New(
				tensor.WithShape(1, m.outputDim),
				tensor.WithBacking(padOrTruncate(targets[i], m.outputDim)),
			)
			targetNode := gorgonia.NewMatrix(m.g, tensor.Float64,
				gorgonia.WithShape(1, m.outputDim),
				gorgonia.WithName("target"),
				gorgonia.WithValue(targetT),
			)

			diff, err := gorgonia.Sub(output, targetNode)
			if err != nil {
				return err
			}
			sq, err := gorgonia.Square(diff)
			if err != nil {
				return err
			}
			loss, err := gorgonia.Mean(sq)
			if err != nil {
				return err
			}
			m.loss = loss

			vm := gorgonia.NewTapeMachine(m.g)
			if err := vm.RunAll(); err != nil {
				vm.Close()
				return fmt.Errorf("vm run failed: %w", err)
			}

			if m.loss != nil {
				if scalar, ok := m.loss.Value().Data().(float64); ok {
					totalLoss += scalar
				}
			}

			if _, err := gorgonia.Grad(m.loss, m.learnables...); err != nil {
				vm.Close()
				return fmt.Errorf("gradient failed: %w", err)
			}

			if err := m.solver.Step(gorgonia.NodesToValueGrads(m.learnables)); err != nil {
				vm.Close()
				return fmt.Errorf("solver step failed: %w", err)
			}

			vm.Reset()
			vm.Close()
		}

		if epoch%10 == 0 {
			avgLoss := totalLoss / float64(len(inputs))
			fmt.Printf("Epoch %d, Loss: %.6f\n", epoch, avgLoss)
		}
	}

	m.trained = true
	return nil
}

// IsTrained returns whether the model has been trained
func (m *CatchmentModel) IsTrained() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.trained
}

// GetConfig returns the model configuration
func (m *CatchmentModel) GetConfig() map[string]interface{} {
	return map[string]interface{}{
		"input_dim":  m.inputDim,
		"hidden_dim": m.hiddenDim,
		"output_dim": m.outputDim,
		"num_layers": m.numLayers,
	}
}

// Save saves the model to disk
func (m *CatchmentModel) Save(path string) error {
	m.mu.RLock()
	defer m.mu.RUnlock()

	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()

	data := struct {
		InputDim  int
		HiddenDim int
		OutputDim int
		NumLayers int
		Trained   bool
	}{
		InputDim:  m.inputDim,
		HiddenDim: m.hiddenDim,
		OutputDim: m.outputDim,
		NumLayers: m.numLayers,
		Trained:   m.trained,
	}

	return gob.NewEncoder(f).Encode(data)
}

// Load loads a model from disk
func (m *CatchmentModel) Load(path string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	var data struct {
		InputDim  int
		HiddenDim int
		OutputDim int
		NumLayers int
		Trained   bool
	}

	if err := gob.NewDecoder(f).Decode(&data); err != nil {
		return err
	}

	m.inputDim = data.InputDim
	m.hiddenDim = data.HiddenDim
	m.outputDim = data.OutputDim
	m.numLayers = data.NumLayers
	m.trained = data.Trained

	return nil
}

// padOrTruncate ensures a slice is exactly the right length
func padOrTruncate(data []float64, length int) []float64 {
	if len(data) == length {
		return data
	}
	result := make([]float64, length)
	copy(result, data)
	return result
}
