# REQ-013: Embedded Neural Network

| Field | Value |
|-------|-------|
| **Component** | AI/ML (Backend) |
| **Author** | Tim Sketcher (Product Owner) |
| **User Story** | As a developer, when I integrate prediction capabilities, I should have access to an embedded feed-forward neural network built with Gorgonia that can predict catchment attributes without external dependencies. |
| **Importance** | High |

## Wireframe

```
Neural Network Architecture:
┌─────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐
│ Input   │──►│ Hidden 1 │──►│ Hidden 2 │──►│ Output   │
│ (64)    │   │ (128)    │   │ (128)    │   │ (32)     │
│         │   │ ReLU     │   │ ReLU     │   │ Linear   │
└─────────┘   └──────────┘   └──────────┘   └──────────┘

Built with Gorgonia (Go neural network framework)
```

## Implementation Details

- Feed-forward neural network built with Gorgonia and tensor operations
- Configurable architecture: input dim, hidden dim, output dim, number of layers
- Xavier weight initialization for stable training
- Adam optimizer for gradient descent
- ReLU activation for hidden layers, linear for output
- MSE loss function for regression tasks
- Thread-safe inference with `sync.RWMutex`
- Model persistence via Go's `encoding/gob`
- API endpoints:
  - `GET /api/nn/status` - Model availability and configuration
  - `POST /api/nn/predict` - Run inference on input data
- Follows the same architectural pattern as `kartoza-pg-ai`'s neural network
- Input padding/truncation for flexible input sizes

### Key Files

- `internal/nn/model.go` - CatchmentModel implementation
- `internal/nn/model_test.go` - Unit tests
