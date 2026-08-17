<p align="center">
  <img src="screenshot.png" alt="Decision Theatre" width="100%">
</p>

<h1 align="center">Landscape Decision Theatre</h1>

<p align="center">
  <strong>Interactive visualization platform for comparing environmental scenarios across African catchments</strong>
</p>

<p align="center">
  <a href="https://github.com/kartoza/DecisionTheatre/actions"><img src="https://img.shields.io/github/actions/workflow/status/kartoza/DecisionTheatre/ci.yml?branch=main&style=flat-square&logo=github&label=CI" alt="CI Status"></a>
  <a href="https://github.com/kartoza/DecisionTheatre/releases/latest"><img src="https://img.shields.io/github/v/release/kartoza/DecisionTheatre?style=flat-square&logo=github&label=Release" alt="Latest Release"></a>
  <a href="https://github.com/kartoza/DecisionTheatre/releases"><img src="https://img.shields.io/github/downloads/kartoza/DecisionTheatre/total?style=flat-square&logo=github&label=Downloads" alt="Downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/kartoza/DecisionTheatre?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Go-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go">
  <img src="https://img.shields.io/badge/React-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React">
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/MapLibre_GL-396CB2?style=flat-square&logo=maplibre&logoColor=white" alt="MapLibre GL">
  <img src="https://img.shields.io/badge/Nix-5277C3?style=flat-square&logo=nixos&logoColor=white" alt="Nix">
</p>

---

## Overview

Decision Theatre is a desktop application for exploring and comparing environmental scenarios across watershed catchments. Built for researchers, policymakers, and stakeholders who need to visualize complex spatial data and understand the impacts of different land management decisions.

**Key Features**

- **Swiper Comparison** — Slide between reference and current scenarios with synchronized 3D terrain
- **Choropleth Mapping** — Visualize any indicator across ~148,000 catchments with consistent color scaling
- **Grid View** — Up to six independent panes, each with its own factor, scenario and view mode
- **Four View Modes** — Map choropleth, line and boxplot charts, dial gauges, and an aggregate catchment table
- **Editable Targets** — Set ideal indicator values and watch the ecological recalculation cascade through dependent factors
- **Identify Tool** — Click any catchment for detailed attribute inspection
- **Zone Statistics** — Real-time min/max/mean for visible catchments
- **Sites** — Define a study area once by drawing, uploading a shapefile or GeoJSON, or selecting catchments, then reuse it everywhere
- **Guided Tours** — Four read-only demo sites that walk new users through the workflow

## Quick Start

Download the latest release for your platform from [Releases](https://github.com/kartoza/DecisionTheatre/releases), or build with Nix:

```bash
nix run github:kartoza/DecisionTheatre
```

Useful flags: `--data-dir` (tiles, GeoPackage, metadata and lookups — the one that matters),
`--port` (default `8080`), `--headless`, `--version`. There is also a `--resources-dir`,
but its only effect is to supply `mbtiles/style.json` when the data directory has none.

A **data pack** containing map tiles and scenario data is distributed separately — the
application shows a setup guide on first launch if it cannot find one. See
[Data Setup](https://kartoza.github.io/DecisionTheatre/user-manual/data-setup/).

## Documentation

| Resource | Description |
|----------|-------------|
| [User Guide](https://kartoza.github.io/DecisionTheatre/) | Complete documentation |
| [Developer Guide](README.dev.md) | Get started contributing |
| [Architecture](https://kartoza.github.io/DecisionTheatre/developer-guide/architecture/) | How the pieces fit together |
| [Client/Server Boundary](https://kartoza.github.io/DecisionTheatre/developer-guide/client-server-boundary/) | What belongs in the browser and what belongs in Go |
| [Data Preparation](https://kartoza.github.io/DecisionTheatre/developer-guide/data-preparation/) | Prepare scenario data |

---

<p align="center">
  <strong>Funders and Partners</strong>
</p>

<p align="center">
  <a href="https://www.wits.ac.za/"><img src="https://upload.wikimedia.org/wikipedia/en/c/c7/Logo_for_the_University_of_the_Witwatersrand%2C_Johannesburg_%28new_logo_as_of_2015%29.jpg" alt="University of the Witwatersrand" height="80"></a>
</p>

<p align="center">
  <strong>Credits</strong>
</p>

<p align="center">
  <a href="https://kartoza.com"><img src="https://kartoza.com/static/img/kartoza-logo.a27c37c9d728.svg" alt="Kartoza" height="40"></a>
</p>

<p align="center">
  <strong>
    A research tool of the <a href="https://www.wits.ac.za/">University of the Witwatersrand</a>,<br>
    developed within <a href="https://futureecosystemsafrica.org/">Future Ecosystems for Africa</a>
    in partnership with <a href="https://www.rewildcapital.com/">Rewild Capital</a>.
  </strong>
</p>

<p align="center">
  <sub>
    Software made with 💗 by <a href="https://kartoza.com">Kartoza</a> under contract to Wits
    &middot; <a href="https://github.com/sponsors/kartoza">Donate!</a>
    &middot; <a href="https://github.com/kartoza/DecisionTheatre">GitHub</a>
  </sub>
</p>
