# Decision Theatre

**Offline catchment data exploration with embedded AI**

Decision Theatre is a cross-platform desktop application for exploring African catchment data across past, present, and future scenarios. It runs entirely offline with an embedded web server, vector map tiles, and optional AI capabilities.

## Key Features

- **Side-by-side scenario comparison** -- compare catchment attributes across past, present, and future scenarios using a map swipe interface
- **Offline-first** -- all data is served locally from MBTiles and GeoParquet files; no internet connection required
- **Embedded AI** -- optional LLM chat and neural network predictions run locally on your hardware
- **Cross-platform** -- runs on Linux, macOS, and Windows as a single binary with an embedded WebView window
- **Beautiful cartography** -- vector tiles rendered with MapLibre GL JS, styled with a custom MapBox-compatible style

## Quick Start

```bash
# Using Nix (recommended)
nix run github:kartoza/DecisionTheatre

# Or download a release binary
./decision-theatre --data-dir ./data --resources-dir ./resources
```

See the [Installation](user-manual/installation.md) guide for full setup instructions.

## Documentation Sections

| Section | Description |
|---------|-------------|
| [About](about/overview.md) | Project background, funders, license |
| [User Manual](user-manual/index.md) | How to install and use the application |
| [User Guide](user-guide/index.md) | Tutorials and UI reference |
| [Developer Guide](developer-guide/architecture.md) | Architecture, setup, contributing |
