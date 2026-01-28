# REQ-012: Embedded LLM

| Field | Value |
|-------|-------|
| **Component** | AI/ML (Backend) |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a user, when I query the embedded LLM, I should receive AI-generated responses about the catchment data without requiring internet connectivity, powered by a locally loaded GGUF model via llama.cpp. |
| **Importance** | High |

## Wireframe

```
Architecture:
┌────────────────┐
│  Go Backend    │
│  ┌───────────┐ │
│  │ CGO Bridge│ │
│  │           │ │    ┌──────────────┐
│  │ go-llama  │◄├───►│  llama.cpp   │
│  │  .cpp     │ │    │  C++ Library │
│  │           │ │    │              │
│  └───────────┘ │    │  GGUF Model  │
│                │    │  (~4-8 GB)   │
│  API: POST     │    └──────────────┘
│  /api/llm/query│
└────────────────┘
```

## Implementation Details

- Uses `github.com/go-skynet/go-llama.cpp` for CGO binding to llama.cpp
- GGUF model format support (compatible with various open-source LLMs)
- Model loaded at startup if `--model` flag is provided
- Thread-safe inference with `sync.RWMutex`
- Configurable parameters: threads, context size, temperature, top-p, top-k, max tokens
- Default temperature: 0.7 (balanced creativity/determinism)
- API endpoints:
  - `GET /api/llm/status` - Model info and availability
  - `POST /api/llm/query` - Submit query, receive response
- CGO build requirements: C/C++ compiler, openblas, llama.cpp binding library
- The LLM is optional - application functions without it if no model is provided

### Key Files

- `internal/llm/embedded.go` - LLM wrapper
- `Makefile` - CGO configuration and `build-llama` target
