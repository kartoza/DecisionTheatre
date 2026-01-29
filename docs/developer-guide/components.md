# Software Components, Libraries, and Licenses

## Backend (Go)

| Library | Purpose | License |
|---------|---------|---------|
| [Go](https://go.dev/) 1.24 | Language runtime | BSD-3-Clause |
| [gorilla/mux](https://github.com/gorilla/mux) | HTTP router | BSD-3-Clause |
| [go-sqlite3](https://github.com/mattn/go-sqlite3) | SQLite driver for MBTiles | MIT |
| [webview_go](https://github.com/webview/webview_go) | Native desktop window (WebView) | MIT |
| [go-llama.cpp](https://github.com/go-skynet/go-llama.cpp) | LLM inference (llama.cpp binding) | MIT |
| [Gorgonia](https://github.com/gorgonia/gorgonia) | Neural network framework | Apache-2.0 |
| [Gorgonia Tensor](https://github.com/gorgonia/tensor) | N-dimensional arrays | Apache-2.0 |
| [OpenBLAS](https://www.openblas.net/) | Linear algebra (CGO) | BSD-3-Clause |

## Frontend (TypeScript/React)

| Library | Purpose | License |
|---------|---------|---------|
| [React](https://react.dev/) 18 | UI framework | MIT |
| [TypeScript](https://www.typescriptlang.org/) 5.7 | Type-safe JavaScript | Apache-2.0 |
| [Chakra UI](https://chakra-ui.com/) 2.8 | Component library | MIT |
| [MapLibre GL JS](https://maplibre.org/) 4.7 | Map rendering engine | BSD-3-Clause |
| [Framer Motion](https://www.framer.com/motion/) | Animation library | MIT |
| [React Icons](https://react-icons.github.io/react-icons/) | Icon library | MIT |
| [Vite](https://vitejs.dev/) 6 | Build tool | MIT |
| [Vitest](https://vitest.dev/) | Test framework | MIT |

## Desktop Runtime

| Platform | WebView Engine | License |
|----------|---------------|---------|
| Linux | WebKit2GTK 4.1 | LGPL-2.1 |
| macOS | WKWebView (system) | Apple EULA |
| Windows | Edge WebView2 | Microsoft EULA |

## Build System

| Tool | Purpose | License |
|------|---------|---------|
| [Nix](https://nixos.org/) | Reproducible builds | LGPL-2.1 |
| [GitHub Actions](https://github.com/features/actions) | CI/CD | Proprietary |
| [tippecanoe](https://github.com/felt/tippecanoe) | Vector tile creation | BSD-2-Clause |
| [GDAL](https://gdal.org/) | Geospatial data conversion | MIT |

## Data Formats

| Format | Purpose | Specification |
|--------|---------|---------------|
| MBTiles | Vector tile storage | [MBTiles Spec](https://github.com/mapbox/mbtiles-spec) |
| GeoParquet | Scenario attribute data | [GeoParquet Spec](https://geoparquet.org/) |
| GGUF | LLM model weights | [GGUF Format](https://github.com/ggerganov/ggml/blob/master/docs/gguf.md) |
| MapBox GL Style | Map styling | [Style Spec](https://docs.mapbox.com/style-spec/) |
