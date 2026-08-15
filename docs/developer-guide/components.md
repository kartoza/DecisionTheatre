# Software Components, Libraries, and Licenses

Versions below are the declared constraints in `go.mod` and `frontend/package.json`. For
resolved versions, consult `go.sum` and `frontend/package-lock.json`.

## Backend (Go)

| Library | Version | Purpose | License |
|---------|---------|---------|---------|
| [Go](https://go.dev/) | 1.24.2 | Language runtime | BSD-3-Clause |
| [gorilla/mux](https://github.com/gorilla/mux) | 1.8.1 | HTTP router | BSD-3-Clause |
| [go-sqlite3](https://github.com/mattn/go-sqlite3) | 1.14.24 | SQLite driver for MBTiles and GeoPackage | MIT |
| [webview_go](https://github.com/webview/webview_go) | untagged commit | Native desktop window | MIT |
| [polyclip-go](https://github.com/ctessum/polyclip-go) | 1.1.0 | Polygon union, intersection, difference | MIT |
| [sevenzip](https://github.com/bodgit/sevenzip) | 1.6.1 | `.7z` data pack extraction | BSD-3-Clause |
| [zenity](https://github.com/ncruces/zenity) | 0.10.14 | Native file dialogs | MIT |
| [google/uuid](https://github.com/google/uuid) | 1.6.0 | Site identifiers | BSD-3-Clause |

!!! note "Dependency observations"
    `webview_go` is pinned to an untagged commit rather than a release. `polyclip-go` is a
    single-maintainer library on which all geometry correctness depends, and which the
    codebase treats as panic-prone (two `recover()` sites). `go-sqlite3` is cgo-based and
    vendors the SQLite C amalgamation, so its CVE exposure is not visible to `govulncheck`
    at the Go level.

## Frontend (TypeScript/React)

<figure markdown>
  ![The twelve largest frontend components by line count](../assets/diagrams/generated/frontend-modules.svg)
  <figcaption class="gen">
    Line counts read from <code>frontend/src/components</code> at build time.
  </figcaption>
</figure>


| Library | Version | Purpose | License |
|---------|---------|---------|---------|
| [React](https://react.dev/) | 18.3 | UI framework | MIT |
| [TypeScript](https://www.typescriptlang.org/) | 5.7 | Type-safe JavaScript | Apache-2.0 |
| [Chakra UI](https://chakra-ui.com/) | 2.8 | Component library | MIT |
| [Emotion](https://emotion.sh/) | 11.13 | CSS-in-JS, required by Chakra | MIT |
| [MapLibre GL JS](https://maplibre.org/) | 4.7 | Map rendering engine | BSD-3-Clause |
| [Framer Motion](https://www.framer.com/motion/) | 11.15 | Animation library | MIT |
| [React Icons](https://react-icons.github.io/react-icons/) | 5.4 | Icon library | MIT |
| [react-plotly.js](https://github.com/plotly/react-plotly.js) | 2.6 | Chart rendering | MIT |
| [turf](https://turfjs.org/) | 7.3 | Client-side geometry operations | MIT |
| [shpjs](https://github.com/calvinmetcalf/shapefile-js) | 6.2 | Shapefile parsing for site upload | MIT |
| [Vite](https://vitejs.dev/) | 6 | Build tool | MIT |
| [Vitest](https://vitest.dev/) | 2.1 | Test framework | MIT |

!!! warning "Dependencies expected to be removed"
    Several declared dependencies have no imports anywhere in `frontend/src`:
    `deck.gl` and `@deck.gl/core`, `@deck.gl/layers`, `@deck.gl/mapbox`, and
    `fast-xml-parser`. `matter-js` and `@types/matter-js` are required only by a physics
    hook that is never called.

    `@turf/turf` is expected to go too, once the geometry operations it performs move to
    the Go backend where equivalent implementations already exist.

    `plotly.js` is **not** a direct dependency — it is present only as
    `react-plotly.js`'s peer, so its version is unpinned by `package.json`.

    Tickets: *Delete dead frontend code and unused dependencies*, *Move drawn-polygon
    catchment membership from turf to the existing Go implementation*, *Bundle and
    repository weight*.

## Desktop Runtime

| Platform | WebView Engine | License |
|----------|---------------|---------|
| Linux | WebKit2GTK 4.1 | LGPL-2.1 |
| macOS | WKWebView (system) | Apple EULA |
| Windows | Edge WebView2 | Microsoft EULA |

!!! warning "Version mismatch in the container build"
    `deployments/Dockerfile` installs `libwebkit2gtk-4.0-dev`, while the flake, CI and the
    Debian packaging all target 4.1.
    Ticket: *Docker image installs webkit 4.0 while flake, CI and packaging all use 4.1*.

## Build System

| Tool | Purpose | License |
|------|---------|---------|
| [Nix](https://nixos.org/) | Reproducible builds | LGPL-2.1 |
| [GitHub Actions](https://github.com/features/actions) | CI/CD | Proprietary |
| [tippecanoe](https://github.com/felt/tippecanoe) | Vector tile creation | BSD-2-Clause |
| [GDAL](https://gdal.org/) | Geospatial data conversion | MIT |
| [nfpm](https://nfpm.goreleaser.com/) | `.deb` / `.rpm` packaging | MIT |
| [Trivy](https://trivy.dev/) | Vulnerability scanning in CI | Apache-2.0 |
| [Gitleaks](https://github.com/gitleaks/gitleaks) / [TruffleHog](https://trufflesecurity.com/trufflehog) | Secret scanning in CI | MIT / AGPL-3.0 |

## Data Formats

| Format | Purpose | Specification |
|--------|---------|---------------|
| MBTiles | Vector tile storage | [MBTiles Spec](https://github.com/mapbox/mbtiles-spec) |
| GeoPackage | Scenario attribute data | [GeoPackage Spec](https://www.geopackage.org/) |
| MapLibre GL Style | Map styling | [Style Spec](https://maplibre.org/maplibre-style-spec/) |
| GeoJSON | Site boundaries, choropleth transport | [RFC 7946](https://datatracker.ietf.org/doc/html/rfc7946) |

## Project License

Decision Theatre is distributed under GPL-3.0.

!!! bug "No LICENSE file in the repository"
    GPL-3.0 is asserted in `flake.nix`, `packaging/nfpm.yaml` and the
    [License](../about/license.md) page, but no `LICENSE` file exists at the repository
    root, and no source file carries an SPDX header.
    Ticket: *No LICENSE file and no SPDX headers, though GPL-3.0 is asserted in three
    manifests*.
