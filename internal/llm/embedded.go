//go:build cgo_llama

package llm

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/go-skynet/go-llama.cpp"
)

// EmbeddedLLM provides embedded LLM inference using llama.cpp
type EmbeddedLLM struct {
	model     *llama.LLama
	modelPath string
	loaded    bool
	mu        sync.RWMutex

	// Generation parameters
	threads     int
	contextSize int
	temperature float64
	topP        float64
	topK        int
	maxTokens   int
}

// EmbeddedLLMConfig holds configuration for the embedded LLM
type EmbeddedLLMConfig struct {
	ModelPath   string
	Threads     int
	ContextSize int
	Temperature float64
	TopP        float64
	TopK        int
	MaxTokens   int
}

// DefaultEmbeddedLLMConfig returns default configuration
func DefaultEmbeddedLLMConfig() EmbeddedLLMConfig {
	return EmbeddedLLMConfig{
		ModelPath:   "",
		Threads:     4,
		ContextSize: 2048,
		Temperature: 0.7,
		TopP:        0.9,
		TopK:        40,
		MaxTokens:   512,
	}
}

// NewEmbeddedLLM creates a new embedded LLM instance
func NewEmbeddedLLM(cfg EmbeddedLLMConfig) (*EmbeddedLLM, error) {
	e := &EmbeddedLLM{
		modelPath:   cfg.ModelPath,
		threads:     cfg.Threads,
		contextSize: cfg.ContextSize,
		temperature: cfg.Temperature,
		topP:        cfg.TopP,
		topK:        cfg.TopK,
		maxTokens:   cfg.MaxTokens,
		loaded:      false,
	}

	if e.threads <= 0 {
		e.threads = 4
	}
	if e.contextSize <= 0 {
		e.contextSize = 2048
	}
	if e.maxTokens <= 0 {
		e.maxTokens = 512
	}

	return e, nil
}

// LoadModel loads the GGUF model from disk
func (e *EmbeddedLLM) LoadModel(modelPath string) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.model != nil {
		e.model.Free()
		e.model = nil
		e.loaded = false
	}

	if strings.HasPrefix(modelPath, "~") {
		home, err := os.UserHomeDir()
		if err != nil {
			return fmt.Errorf("failed to get home directory: %w", err)
		}
		modelPath = filepath.Join(home, modelPath[1:])
	}

	if _, err := os.Stat(modelPath); os.IsNotExist(err) {
		return fmt.Errorf("model file not found: %s", modelPath)
	}

	model, err := llama.New(modelPath,
		llama.SetContext(e.contextSize),
		llama.EnableF16Memory,
		llama.SetMMap(true),
		llama.SetNBatch(512),
	)
	if err != nil {
		return fmt.Errorf("failed to load model: %w", err)
	}

	e.model = model
	e.modelPath = modelPath
	e.loaded = true

	return nil
}

// IsLoaded returns whether a model is currently loaded
func (e *EmbeddedLLM) IsLoaded() bool {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return e.loaded
}

// Generate produces text from a query with optional context
func (e *EmbeddedLLM) Generate(query, context string) (string, error) {
	e.mu.RLock()
	defer e.mu.RUnlock()

	if !e.loaded || e.model == nil {
		return "", fmt.Errorf("model not loaded")
	}

	prompt := e.buildPrompt(query, context)

	response, err := e.model.Predict(prompt,
		llama.SetThreads(e.threads),
		llama.SetTokens(e.maxTokens),
		llama.SetTemperature(float32(e.temperature)),
		llama.SetTopP(float32(e.topP)),
		llama.SetTopK(e.topK),
		llama.SetStopWords("\n\n\n", "USER:", "User:"),
	)
	if err != nil {
		return "", fmt.Errorf("prediction failed: %w", err)
	}

	return strings.TrimSpace(response), nil
}

func (e *EmbeddedLLM) buildPrompt(query, context string) string {
	var sb strings.Builder
	sb.WriteString("You are an expert assistant for the Decision Theatre application, ")
	sb.WriteString("which helps users explore catchment data across Africa under different scenarios.\n\n")
	if context != "" {
		sb.WriteString("Context:\n")
		sb.WriteString(context)
		sb.WriteString("\n\n")
	}
	sb.WriteString("USER: " + query + "\n")
	sb.WriteString("ASSISTANT: ")
	return sb.String()
}

// GetModelInfo returns information about the loaded model
func (e *EmbeddedLLM) GetModelInfo() map[string]interface{} {
	e.mu.RLock()
	defer e.mu.RUnlock()

	info := map[string]interface{}{
		"available":    e.loaded,
		"model_path":   e.modelPath,
		"threads":      e.threads,
		"context_size": e.contextSize,
		"temperature":  e.temperature,
		"max_tokens":   e.maxTokens,
	}
	if e.modelPath != "" {
		info["model_name"] = filepath.Base(e.modelPath)
	}
	return info
}

// Close releases the model resources
func (e *EmbeddedLLM) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.model != nil {
		e.model.Free()
		e.model = nil
		e.loaded = false
	}
}
