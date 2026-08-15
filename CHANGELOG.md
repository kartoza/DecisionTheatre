# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] — 2026-08-15

### Added

- **`validate-data` tool** (`scripts/validate-data.sh`, `nix run .#validate-data`,
  `make validate-data`) — checks a data directory against what the Go runtime actually
  reads: GeoPackage tables and join keys, tileset naming, `metadata.csv` cross-checked
  against real columns, lookup tables, runtime directories, walkthrough integrity, and
  content that does not belong. Exit status makes it usable as a deployment gate.
- **Administrator Guide** — documents the data directory layout cross-referenced to the
  code that reads each path, and the validation tool.
- **`data-readme.md`** — a tracked description of the untracked `data/` directory.
- **Client/Server Boundary** developer guide — the rule for what may be computed and
  stored in the browser, with the two site-creation paths as worked examples.
- **Build-time diagram generation** — 31 brand-consistent SVG diagrams, of which 12 are
  parsed from live project state (routes, package graph, CI pipeline, test coverage,
  version declarations, storage keys and more) so they cannot drift from the code.
- **Guided user path** — 14 atomic step pages, each with a goal, background, context
  diagram, steps, screenshots, achievements and a next-step link.
- **`CHANGELOG.md`** — this file.

### Changed

- **User documentation restructured around the hosted dashboard.** Installing locally is
  now an Advanced Topic rather than the first two steps, reflecting that most users reach
  the tool at <https://africanlandscapefutures.wits.ac.za/>.
- **User Manual and User Guide consolidated.** The two sections duplicated each other —
  every screenshot appeared twice. Content is now a single guided path plus an interface
  reference.
- **Documentation theme aligned with the Kartoza brand pack**, matching
  kartoza/InfrastructureMapper: Nunito, flat surfaces, charcoal primary with blue and amber
  accents, hero and grid-card landing page.
- **Attribution corrected throughout.** Landscape Decision Theatre is a research tool of
  the University of the Witwatersrand, developed within Future Ecosystems for Africa in
  partnership with Rewild Capital; Kartoza is the contracted software developer. All
  fifteen research and implementation partners are now credited.
- **"Quad view" renamed to "grid view"** in all documentation and user-visible strings.
- Developer documentation is now Nix-centric, covering the shell, every `nix run` and
  `nix build` target, the everyday `make` commands, CI, and the diagram pipeline.
- Documentation now marks each diagram as generated or hand-authored with an icon, rather
  than exposing build-process notes to readers.

### Fixed

- **`docs/about/funders-and-partners.md` named the wrong institution** — it credited the
  University of the Western Cape rather than the University of the Witwatersrand.
- **`architecture.md` described a renderer the project does not use** (deck.gl) and listed
  Go packages that do not exist.
- **`api.md` documented a `/api/projects` CRUD surface** that has been `/api/sites` for
  some time, along with an incorrect tile route and style path.
- **`testing.md` referenced a test file in a package that was removed.**
- Numerous stale references to "Projects" (renamed to Sites) across the documentation.

### Known issues

Documented inline where relevant, and tracked as issues:

- CI's `file-checks` job fails on every run because `frontend/.env` is tracked.
- `nix flake check` cannot pass — `checks.frontend-tests` has an empty `npmDepsHash`.
- The version number is declared in several places that disagree; the production
  deployment reports `dev`.
- No `LICENSE` file exists, though GPL-3.0 is declared in three manifests.
- `--resources-dir` and the `style.json` fallback are slated for removal.

[Unreleased]: https://github.com/kartoza/DecisionTheatre/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/kartoza/DecisionTheatre/releases/tag/v0.3.0
