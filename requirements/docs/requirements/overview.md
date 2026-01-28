# Requirements Overview

## Requirement Template

Every requirement in this document follows a consistent template:

| Field | Description |
|-------|-------------|
| **Component** | The system component this requirement belongs to (Frontend, Backend, Data, Infrastructure) |
| **Author** | The person who expressed or identified the requirement |
| **User Story** | A single sentence: "As a _[role]_, when I _[action]_, I should _[outcome]_" |
| **Importance** | Critical, High, Medium, or Low |
| **Wireframe** | ASCII art or description of the visual layout (where applicable) |
| **Implementation Details** | Technical notes on how the requirement will be fulfilled |

## Component Categories

- **Frontend**: React UI, Chakra UI components, MapLibre map, user interactions
- **Backend**: Go HTTP server, API endpoints, data serving
- **Data**: MBTiles, GeoParquet, vector tiles, catchment attributes
- **AI/ML**: Embedded LLM (llama.cpp), neural network (Gorgonia)
- **Infrastructure**: Build system, packaging, testing, deployment

## Priority Levels

- **Critical**: Application cannot function without this
- **High**: Core feature that significantly impacts usability
- **Medium**: Important for complete experience but not blocking
- **Low**: Nice-to-have enhancement
