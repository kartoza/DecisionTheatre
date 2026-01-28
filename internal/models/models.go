package models

// ComparisonRequest represents a request to compare two scenarios
type ComparisonRequest struct {
	LeftScenario  string `json:"left_scenario"`
	RightScenario string `json:"right_scenario"`
	Attribute     string `json:"attribute"`
}

// ComparisonResponse contains the comparison data for the map
type ComparisonResponse struct {
	Left      map[string]float64 `json:"left"`
	Right     map[string]float64 `json:"right"`
	Attribute string             `json:"attribute"`
	MinValue  float64            `json:"min_value"`
	MaxValue  float64            `json:"max_value"`
}

// LLMQueryRequest represents an LLM query
type LLMQueryRequest struct {
	Query   string `json:"query"`
	Context string `json:"context,omitempty"`
}

// LLMQueryResponse contains the LLM response
type LLMQueryResponse struct {
	Response string `json:"response"`
}

// NNPredictRequest represents a neural network prediction request
type NNPredictRequest struct {
	Inputs []float64 `json:"inputs"`
}

// NNPredictResponse contains neural network predictions
type NNPredictResponse struct {
	Predictions []float64 `json:"predictions"`
}
