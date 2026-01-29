# AI Chat

Decision Theatre can optionally run a language model locally for interactive conversation about the catchment data.

## Requirements

- A GGUF-format language model file (e.g., from the llama.cpp ecosystem)
- Pass the model path at startup: `--model ./path/to/model.gguf`

## Usage

When an LLM model is loaded, the header will show a green "LLM" status indicator. The chat interface allows you to ask questions about the data and receive AI-generated responses.

All inference runs locally on your machine. No data is sent to external services.

!!! note
    The LLM feature requires the `go-llama.cpp` binding and a CGO-enabled build with OpenBLAS. The Nix build and release binaries include this automatically.

## Neural Network Predictions

Separately from the LLM, the application can load a trained Gorgonia neural network model for catchment attribute prediction. When available, the header shows a green "NN" indicator.
