# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The flake can no longer fall out of step with the Go and npm manifests.** `flake.nix`
  pins two fixed-output hashes — `vendorHash` from `go.mod`/`go.sum`, `npmDepsHash` from
  `frontend/package-lock.json`. A fixed-output derivation is only revalidated when its
  output path changes, so a hash that has fallen behind keeps building on the machine that
  broke it and fails for everyone importing the flake. `nix/manifest-lock.json` now records
  a digest of each manifest at the moment its hash was computed, which makes the drift
  check instant and offline:
    - `dt check-flake` — fast offline check; what the pre-commit hook runs.
    - `dt sync-flake` — recompute both hashes, write them into `flake.nix`, record the
      digests. `--adopt` bootstraps the record from hashes already known good.
    - `dt verify-flake` — authoritative; recomputes the real hashes.
    - CI runs the fast check *and* the deep verify as its **first** job, then builds the
      flake the way an external consumer would, from a cold store.
- **`dt` — one command for every task.** `dt <task>` == `make <task>` == `<leader>p<key>`
  in neovim == `nix run .#<task>` for the tasks that must work without the shell. It reads
  the task list out of the Makefile, so it cannot offer a task that does not exist nor miss
  one that was just added, and a mistyped task suggests the closest real names.
- **`dt doctor`** — one command that answers "why isn't this working": toolchain, flake
  lock step, version consistency across `flake.nix` and the npm manifests, build staleness,
  data directory, and repository hygiene including untracked files that a nix build cannot
  see. It reports and never changes anything; every finding names the command that fixes
  it. `dt doctor-deep` additionally recomputes the real nix hashes.
- **`.pre-commit-config.yaml` and `dt hooks`** — the flake lock-step check, gofmt, go vet,
  the data-contract drift test, shellcheck, nixpkgs-fmt, gitleaks and general hygiene. The
  hook body lives in `scripts/hooks/pre-commit`, tracked and reviewable, rather than
  untracked inside `.git`. A plain-git fallback runs the critical checks for contributors
  without `pre-commit` installed.
- **`nix develop .#tooling`** — the checks without the build toolchain, so CI and a
  contributor who only wants to run them do not first realise Go, Node and GDAL.
- **`scripts/lib-ui.sh`** — shared terminal output, so `doctor`, `sync-flake`, the hook and
  the data checker all report in the same shape.
- **[Keeping the Flake Importable](docs/developer-guide/flake-lock-step.md)** — why the
  failure is invisible locally, and what to run.
- **`devbin/`**, put on `PATH` by both `.envrc` and the development shell, so `dt` and `hp`
  are real executables. They were shell functions at first, which meant they did not exist
  for anyone entering through direnv: `use flake` carries back the environment, not the
  shell state, so a function defined in the flake's `shellHook` is silently absent — and
  `which dt` had nothing to find. `dt doctor` now checks for it.

### Changed

- **Nothing reaches `main` with failing checks any more.** `dt protect-branch`
  requires every pull-request check to pass, requires the branch to be up to date,
  and **applies to administrators** — pull requests had been merged red, which
  makes every guard in the repository advisory. Changes must go through a pull
  request, with zero approvals required by default so a single-maintainer day is
  not blocked. The required list is derived from the workflow files rather than
  typed into the script, so it cannot drift from what CI runs, and jobs gated to
  a push on `main` are excluded rather than left pending forever. `claude.sh`
  offers to apply it as part of submitting work.
- **`hp` is gone; `dt` is the only command.** `dt` prints the table, `dt <group>` gives the
  detail for one group, `dt <task>` runs a task. Two commands that did the same job was one
  too many. Where a word names both a task and a group — `run`, `build`, `test`, `docs`,
  `release` — the task wins, because `dt test` should run the tests; `dt help <name>` is
  the unambiguous form.
- **The command table is rendered with `gum`** as a grid of cards that reflows to two or
  one column on a narrow terminal — and `dt <group>` renders the same panels with a row per
  command, so the two views share one visual language. There is a plain fallback wherever
  gum is unavailable, and
  an icon per group — nix's snowflake on `FLAKE`. The icons are single-width Unicode rather
  than emoji so the grid cannot tear; `DT_HELP_ICONS=0` turns them off. A header spanning
  the grid carries the version and the current branch, marked when the tree is dirty. The
  previous rendering was a sixty-line wall of undifferentiated text.
- **Typefaces are committed rather than fetched.** Inter and Source Sans 3 come from
  nixpkgs (`dt vendor-fonts`, `--check` to verify) and are bundled by Vite. `index.html` no
  longer contacts `fonts.googleapis.com` — a request that either failed or blocked first
  paint in the offline desktop application, and announced every launch to a third party.
  Both families are OFL-1.1.

### Fixed

- **The desktop window laid the whole application out at a million times scale, and hung
  the machine doing it.** `--diag` reported a layout viewport of 1 268 000 000 CSS pixels
  for a 1268-pixel window, a root font size of `9000000px`, and a `window.innerWidth` that
  had overflowed to `-121728`. The factor is exactly 10⁶ — the signature of a `%f`-formatted
  float such as `"1.000000"` being read with the dot taken as a thousands separator.

  The cause is a locale that glibc cannot load. GTK calls `setlocale(LC_ALL, "")` at
  startup, and where `LANG` names a locale that was never built into the system — routine
  on NixOS — it falls back to `C` while WebKit's parsing does not follow, so the two
  disagree about what a decimal point means. The application now pins `LC_NUMERIC=C` before
  GTK initialises (`locale.go`), which fixes the parsing without touching the character
  encoding or date formats. `dt doctor` reports a locale that is set but not installed, and
  the development shell sets `LOCALE_ARCHIVE`.

- **`dt run --diag`** — the desktop window reports what it actually resolved: viewport,
  media queries, font loading and the measured geometry of each element and its ancestors.
  A rendering fault that appears only in the WebKitGTK window cannot be reproduced by
  opening the same URL in a browser, and this replaces guessing at the difference.

- **The desktop window rendered the whole application shrunk and mis-wrapped.**
  `frontend/index.html` carries `<meta name="viewport" content="width=device-width">`,
  which the hosted dashboard needs for phones. Desktop Chrome and Firefox ignore the tag,
  so it is free there — but WebKitGTK, which renders the desktop window, honours it and
  laid the page out against a narrow device-width viewport scaled to fit. Everything
  downstream followed: Chakra's media queries resolved to their phone-sized base branch, so
  the tour popover took `calc(100vw - 24px)`; percentage widths resolved against the narrow
  viewport, so the hero paragraph wrapped one character per line; and the page rendered
  small because it was being scaled down. The webview now removes the tag on load, in
  `main.go`, so the hosted dashboard keeps the tag it legitimately needs.

- **Three tracked Go files were not gofmt-clean** (`internal/api/handler.go` and two test
  files). Now formatted, and the pre-commit hook keeps them that way.
- **Every shell script under `scripts/` is now shellcheck-clean** at warning severity.
- **Starting a demo tour tried to write a multi-megabyte site to localStorage and blew
  the quota.** The tour resets the walkthrough's ideal targets to current, then
  persisted the whole site object into the `dt-sites` key "so it is available for the
  rest of the session". The Africa walkthrough is 4,026,496 characters — roughly
  7.7 MB in UTF-16 against a typical 5 MB per-origin quota — so the write could never
  succeed, and it happened on a completely fresh profile before the user had created
  anything of their own. The return value was ignored, so it failed silently.

  The reset is presentation state for the current session and never needed to be
  durable, so it now lives in an in-memory map that cannot fail and is gone on reload
  — which is the intended lifetime, since the tour resets the targets again next time
  it runs.

  `getSite` gained a fallback to the session store and then the static walkthrough
  JSON, because a demo site previously resolved *only* as a side effect of that
  localStorage write; removing the write without this would have broken the tours.
  The fallback is limited to known walkthrough ids so that looking up a deleted site
  does not cost a 404. `DemoTour` also had its own copy of the fetch-and-normalise
  logic `getSite` already implements, along with a progress step for a fetch that no
  longer happens; both are gone rather than left as an unreachable branch.

- `GOPATH` is set from the project root rather than `$PWD`, so running a Go command after
  `cd`-ing into a subdirectory no longer creates a second module cache there. Two had
  accumulated, under `frontend/` and `resources/mbtiles/`.

## [0.4.0] — 2026-08-16

### Added

- **`scripts/run-app.sh` — one launcher for every entry point.** `make run`, `nix run` and
  the neovim `<leader>pr` mapping now all call this script, so how the application starts
  is defined in exactly one place. The script owns the launch policy (desktop WebView mode,
  flags, data directory resolution); the build stays where it belongs, with nix supplying a
  pre-built store binary via `DT_BIN` and the local path rebuilding only what is stale.
- **`make run`** — the canonical way to launch the desktop application locally. It rebuilds
  the frontend, docs and binary only when their sources are newer, then opens the window.
- **`.dt-env`** (gitignored, see `.dt-env.example`) — per-machine launch settings read by
  every entry point, so machine-specific choices such as `DT_DATA_DIR=./data` no longer
  require any launcher to grow its own copy of the logic. Explicit environment variables
  and command-line flags still override it.
- **`.nvim.lua` and `.exrc`** — project-local editor configuration with `<leader>p`
  mappings for run, build, test, lint, format, docs and data validation, each shelling out
  to the Makefile rather than reimplementing anything.
- **`scripts/version.sh`** — one definition of the version string for local builds,
  replacing five separate copies of the same `git describe` invocation.
- **`scripts/lib-build.sh`** — the staleness checks and build steps, shared by the
  launcher and both data tools, so "how do I get a current binary" has one answer.
- **A grouped command table in the development shell.** `nix develop` now greets you with
  every command grouped by intent — run, live development, build, test, diagnose, data
  pack, documentation, release, shortcuts — and **`hp`** re-renders it at any time.
  `hp run`, `hp data`, `hp diagnose` filter to one group. It adapts to the terminal width,
  drops colour when piped, and pipes cleanly into `head` or `less`.
- **`scripts/shell-help.sh`** — that table, and the only place commands are listed: the
  shell greeting, `hp` and `make help` all render it (`make help GROUP=data` filters), so
  none of them can list different commands. Adding a command is one line.
- **`scripts/dev-shell.sh`** — the whole shell environment as ordinary shell. `flake.nix`'s
  `shellHook` now does nothing but source it, honouring the project's rule that Nix files
  carry no embedded code; the previous hook held 60 lines of `echo` that had to be edited
  in a Nix string and duplicated what `make help` said.
- **Two named run modes.** The application has always been able to run either as a
  desktop window or as a plain web server; the choice is now explicit and available from
  every entry point: `make run` / `nix run` for desktop, `make serve` / `nix run .#serve`
  for the server, or `DT_MODE=desktop|server` for either. `DT_HEADLESS=1` still works.
- **`decision-theatre check-data [DIR]`** — checks a data directory against what the
  application actually reads and renders a report: what each GeoPackage table holds, what
  the tilesets contain, whether every `metadata.csv` row names a column that really
  exists, and a classification of every file in the directory as read-by-the-app, a build
  input, user data, or extraneous. `--json` for CI gates. Exit `0` clean, `1` errors,
  `2` unreadable — so it can gate a deployment.
- **`decision-theatre pack-data [DIR]`** — runs the check, then assembles the runtime
  files into a distributable zip. **Refuses to build the pack when the check reports
  errors** (`--force` overrides, and the manifest records that it was forced), so a pack
  that cannot be loaded never reaches a user. Build inputs and saved user data are
  excluded, and the manifest explains every omission.
- **Data pack manifests now carry provenance**: the packaging timestamp, the tool and
  version that built it, the source directory, the checker's verdict, a per-file SHA-256
  inventory, and the exclusion list. Written both inside the archive and beside it as
  `<pack>.zip.manifest.json`, so a download page can describe a pack without fetching it.
  The four fields the installer reads are unchanged, so old and new packs both install.
- **`internal/datacheck/spec.go`** — the data contract in one place: every file and table
  the runtime reads, whether it is required, the source location that reads it, and what
  breaks without it. `spec_test.go` reads the runtime packages back and **fails the build**
  if the code starts referencing something the spec does not describe.

### Changed

- **The data directory now defaults to `./data`** when one exists in the working
  directory, sitting between the saved data-pack path and the per-user directory in the
  resolution chain. Running from a checkout picks up the repository's own `data/` with no
  flags. The existence test is deliberate: an unconditional default previously created an
  empty `data` folder next to the executable on Windows.
- **`validate-data` is now `check-data`, and is written in Go rather than shell.** The
  394-line shell implementation restated the runtime's expectations, so it could fall
  behind the code that actually reads the files — the same class of drift as the launcher.
  The checker is now a subcommand of the application and opens the data through the very
  packages the server uses. `make validate-data`, `nix run .#validate-data` and the
  renamed `scripts/check-data.sh` all still work.
- **`make datapack` is now `make pack-data`**, with `datapack` kept as an alias, and
  `scripts/package-data.sh` renamed to `scripts/pack-data.sh`. Both are thin wrappers over
  the Go subcommand.
- **The metadata cross-check no longer inflates the error count.** 344 examples of one
  mistake were reported as 344 errors; they are now one error with the examples listed
  beneath it as notes, and a line naming the fix.
- **`make dev` is now an alias for `make run`.** It previously ran `build-backend` alone and
  launched with `--port 8080 --data-dir ./data`, so it could serve a months-old embedded
  frontend from a different data directory than `nix run` used. There is deliberately no
  second launch path any more.
- The `nix develop` banner and `make help` lead with the equivalent ways to run.
- The `gor` shell alias now runs `make run` rather than `go run .`, which would have
  launched with whatever stale frontend happened to be embedded in the tree.

### Fixed

- **Local builds reported their version as `vv0.2.1-…`.** `git describe` returns the
  leading `v` from the tag and `main.go` prefixes its own, so the two doubled up. The
  version is now normalised once, in `scripts/version.sh`. Nix builds were unaffected.
- **Unresolved merge conflict markers** left in `CHANGELOG.md` and
  `docs/hooks/diagrams_state.py` by commits `8777454` and `f74bebd`. The `licences`
  diagram generator had been left syntactically broken.
- **The frontend test suite failed to render the app at all.** jsdom provides neither
  `IntersectionObserver` nor `ResizeObserver`, which framer-motion and Chakra require on
  mount; both are now stubbed in the test setup. `App.test.tsx` also asserted on a
  "Decision Theatre" text node that the header rebrand replaced with partner logos — it now
  asserts on the header landmark, which is what "renders without crashing" actually means.

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
- **Documentation publishing** (`.github/workflows/docs.yml`) — builds the site with
  `nix build .#docs` on every pull request and publishes it to GitHub Pages on merge to
  `main`.

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

- The docs derivation now runs `mkdocs --strict`, and its source filter includes
  `.github/` and `go.mod` — without them the CI-pipeline diagram could not be generated
  and the dependency diagram silently reported zero Go modules under Nix.
- `npmDepsHash` updated for the version bump, and the previously empty hash in
  `checks.frontend-tests` filled in — that check can now fetch its dependencies.
- **`vendorHash` corrected.** The committed value did not match `go.sum` and had been
  stale on `main`. It went unnoticed because a fixed-output derivation is only refetched
  when its output path changes, and that path embeds the version — so the cached 0.2.0
  output was reused and never revalidated. `nix build` now works from a clean store.
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
- `nix flake check` still cannot pass: `checks.go-tests` omits the webkit build inputs the
  package needs, and `go test` requires the frontend embed target to exist first. The
  `frontend-tests` half is fixed in this release.
- `main.go` still defaults its version to `dev`, so any build outside Nix or CI reports
  `vdev` — the production deployment currently does. `flake.nix` and
  `frontend/package.json` now agree at 0.3.0.
- No `LICENSE` file exists, though GPL-3.0 is declared in three manifests.
- `--resources-dir` and the `style.json` fallback are slated for removal.

[Unreleased]: https://github.com/kartoza/DecisionTheatre/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/kartoza/DecisionTheatre/releases/tag/v0.4.0
[0.3.0]: https://github.com/kartoza/DecisionTheatre/releases/tag/v0.3.0
