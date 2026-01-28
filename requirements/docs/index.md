# Decision Theatre - System Requirements

## Introduction

Decision Theatre is a self-contained desktop application for exploring and comparing African catchment data across different temporal scenarios. The application combines geospatial visualization, artificial intelligence, and scenario analysis into a single offline-capable binary.

## Purpose

The application enables decision-makers, researchers, and environmental scientists to:

- Compare catchment-level environmental data across **past**, **present**, and **ideal future** scenarios
- Visualize approximately 150,000 African catchments with attribute-based choropleth styling
- Use a map swiper interface to directly compare two scenarios side by side
- Leverage embedded AI capabilities for data analysis without requiring internet connectivity

## Scope

The system encompasses:

- **Backend**: Go application with embedded HTTP server, vector tile serving, geoparquet data access, and AI inference (LLM via llama.cpp, neural network via Gorgonia)
- **Frontend**: React single-page application with Chakra UI styling and MapLibre GL JS map rendering
- **Data**: MBTiles vector tile storage for basemap and catchment geometries, GeoParquet files for attribute data
- **Deployment**: Single self-contained binary with all web assets embedded, targeting Windows, macOS, and Linux

## Stakeholders

| Role | Interest |
|------|----------|
| Environmental Scientist | Primary user; explores catchment scenarios and factors |
| Decision Maker | Views comparisons to inform policy decisions |
| Developer | Maintains and extends the application |
| System Administrator | Deploys and configures the application |

## Technology Stack

| Component | Technology |
|-----------|-----------|
| Backend Language | Go 1.24+ |
| Frontend Framework | React 18 + TypeScript |
| CSS Framework | Chakra UI v2 |
| Map Library | MapLibre GL JS |
| Tile Storage | MBTiles (SQLite) |
| Data Format | GeoParquet |
| LLM Engine | llama.cpp (via CGO) |
| Neural Network | Gorgonia |
| Build System | Nix Flake (primary), Make (dev convenience) |
| CI/CD | GitHub Actions (native builds per platform) |
| Documentation | MkDocs Material |

## Build Philosophy

This is a **nix-first** project. All dependencies - Go modules, npm packages, C libraries - are fetched into the nix store with cryptographic hashes, producing a fully reproducible and auditable build.

- `nix develop` - opens a shell with all development tools
- `nix build` - builds the complete application (frontend + backend) in a hermetic sandbox with no network access
- `nix flake check` - runs all tests (Go + frontend)
- `nix run` - builds and runs the application

No CDN, no runtime package fetching, no external requests at build time or runtime. The `flake.lock` + pinned hashes constitute a complete SBOM. Platform-specific release binaries are built natively in CI, not cross-compiled.

## Requirements Index

All requirements follow a consistent template with: Component, Author, User Story, Importance, Wireframe, and Implementation Details.

See the Requirements section in the navigation for the full list.
