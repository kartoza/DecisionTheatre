# Overview

Landscape Decision Theatre is a research tool built to support decision-making around freshwater catchment management in Africa. It allows researchers, policy makers, and stakeholders to visually compare how catchment attributes change across different temporal scenarios (reference, current, and projected future).

## Background

Freshwater catchments across Africa face growing pressure from climate change, land-use transformation, and population growth. Understanding how these factors interact across time requires tools that can present complex geospatial data in an accessible, interactive format.

Landscape Decision Theatre addresses this by providing:

- **Project-based workflow** -- create, save, and organize multiple analysis projects with custom thumbnails and descriptions
- **Temporal comparison** -- side-by-side swipe-based comparison of catchment attributes across scenarios
- **Offline operation** -- designed for use in field settings, workshops, and environments without reliable internet
- **Single-binary deployment** -- no installation of databases, web servers, or runtime dependencies beyond the binary itself
- **Beautiful landing experience** -- welcoming landing page with easy access to projects and about information

## How It Works

The application bundles a Go HTTP server with an embedded React frontend. On startup it:

1. Opens a native desktop window (WebView) displaying the landing page
2. Loads vector map tiles from an MBTiles file (African countries, rivers, lakes, ecoregions, catchment boundaries, populated places)
3. Loads scenario data from GeoParquet files (reference, current, future catchment attributes)
4. Provides project management for organizing multiple analyses
5. All processing happens locally -- no data leaves the user's machine

## Technology Stack

| Layer | Technology |
|-------|-----------|
| Backend | Go 1.24, Gorilla Mux, go-sqlite3 |
| Frontend | React 18, TypeScript, Chakra UI, Framer Motion, MapLibre GL JS |
| Map Data | MBTiles (vector), MapBox GL Style JSON |
| Scenario Data | GeoParquet |
| Desktop Window | webview_go (WebKit2GTK on Linux, WebView2 on Windows, WKWebView on macOS) |
| Build System | Nix flakes, GitHub Actions |
