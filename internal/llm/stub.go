//go:build !cgo_llama

package llm

// Stub implementation when llama.cpp is not available.
// Build with -tags cgo_llama to enable the real implementation.

// EmbeddedLLM is a stub when built without cgo_llama tag
type EmbeddedLLM struct {
	loaded bool
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
	return EmbeddedLLMConfig{}
}

// NewEmbeddedLLM returns a stub (llama.cpp not compiled in)
func NewEmbeddedLLM(_ EmbeddedLLMConfig) (*EmbeddedLLM, error) {
	return &EmbeddedLLM{}, nil
}

// LoadModel is a no-op without llama.cpp
func (e *EmbeddedLLM) LoadModel(_ string) error {
	return nil
}

// IsLoaded always returns false without llama.cpp
func (e *EmbeddedLLM) IsLoaded() bool {
	return false
}

// Generate is unavailable without llama.cpp
func (e *EmbeddedLLM) Generate(_, _ string) (string, error) {
	return "", nil
}

// GetModelInfo returns stub info
func (e *EmbeddedLLM) GetModelInfo() map[string]interface{} {
	return map[string]interface{}{
		"available": false,
		"message":   "Built without cgo_llama tag. Rebuild with: go build -tags cgo_llama",
	}
}

// Close is a no-op
func (e *EmbeddedLLM) Close() {}
