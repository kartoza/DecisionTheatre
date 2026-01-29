# Overview

Decision Theatre is a research tool built to support decision-making around freshwater catchment management in Africa. It allows researchers, policy makers, and stakeholders to visually compare how catchment attributes change across different temporal scenarios (past, present, and projected future).

## Background

Freshwater catchments across Africa face growing pressure from climate change, land-use transformation, and population growth. Understanding how these factors interact across time requires tools that can present complex geospatial data in an accessible, interactive format.

Decision Theatre addresses this by providing:

- **Temporal comparison** -- side-by-side or swipe-based comparison of catchment attributes across scenarios
- **Offline operation** -- designed for use in field settings, workshops, and environments without reliable internet
- **Embedded intelligence** -- optional locally-running LLM and neural network models for data interpretation and prediction
- **Single-binary deployment** -- no installation of databases, web servers, or runtime dependencies beyond the binary itself

## How It Works

The application bundles a Go HTTP server with an embedded React frontend. On startup it:

1. Loads vector map tiles from an MBTiles file (African countries, rivers, lakes, ecoregions, catchment boundaries, populated places)
2. Loads scenario data from GeoParquet files (past, present, future catchment attributes)
3. Optionally loads a GGUF language model for interactive chat
4. Optionally loads a trained neural network for catchment predictions
5. Opens a native desktop window (WebView) or listens on a local port in headless mode

All processing happens locally. No data leaves the user's machine.

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Backend | Go 1.24, Gorilla Mux, go-sqlite3, Gorgonia |
| Frontend | React 18, TypeScript, Chakra UI, MapLibre GL JS |
| Map Data | MBTiles (vector), MapBox GL Style JSON |
| Scenario Data | GeoParquet |
| LLM | llama.cpp (via go-llama.cpp), GGUF models |
| Neural Network | Gorgonia (pure Go) |
| Desktop Window | webview_go (WebKit2GTK on Linux, WebView2 on Windows, WKWebView on macOS) |
| Build System | Nix flakes, GitHub Actions |
