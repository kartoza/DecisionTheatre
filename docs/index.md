# Landscape Decision Theatre

**Exploring the possibilities of sustainable land use practices**

Landscape Decision Theatre is a cross-platform desktop application for exploring African catchment data across reference, current, and future scenarios. It runs entirely offline with an embedded web server, vector map tiles, and project-based workflow for organizing your analyses.

## Key Features

- **Project-based workflow** -- create, save, and organize multiple analysis projects with custom thumbnails and descriptions
- **Side-by-side scenario comparison** -- compare catchment attributes across reference, current, and future scenarios using a map swipe interface
- **Offline-first** -- all data is served locally from MBTiles and GeoParquet files; no internet connection required
- **Beautiful landing experience** -- welcoming landing page with easy access to projects and about information
- **Cross-platform** -- runs on Linux, macOS, and Windows as a single binary with an embedded WebView window
- **Beautiful cartography** -- vector tiles rendered with MapLibre GL JS, styled with a custom MapBox-compatible style

## Quick Start

```bash
# Using Nix (recommended)
nix run github:kartoza/DecisionTheatre

# Or download a release binary
./decision-theatre --data-dir ./data --resources-dir ./resources
```

When the application starts, you'll see the **Landing Page** with options to:

1. Learn **About** the project
2. Access your **Projects** to create or open analyses

See the [Installation](user-manual/installation.md) guide for full setup instructions.

## Documentation Sections

| Section | Description |
|---------|-------------|
| [About](about/overview.md) | Project background, funders, license |
| [User Manual](user-manual/index.md) | How to install and use the application |
| [User Guide](user-guide/index.md) | Tutorials and UI reference |
| [Developer Guide](developer-guide/architecture.md) | Architecture, setup, contributing |
