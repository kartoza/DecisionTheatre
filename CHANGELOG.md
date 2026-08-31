# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Flat chart view** — a horizontal band as an alternative to the arc dial,
  chosen from the top bar next to Dial. Reference and current are drawn as
  vertical lines through the band, the target as a buckle around it: two are
  readings, one is a setting, so they are not three colours of the same shape.

- **Chart details side panel**, opened by a pane's info button. Shows how the
  scale was arrived at — every candidate range, the metadata bounds, each step,
  and which source each value came from. Anything not loaded says so rather than
  showing a plausible number. "Show calculations" swaps it for the target
  arithmetic that used to be a modal.

- **Reset to reference** and **Reset to current** in the target editor,
  confirmed in the panel rather than in a popup.

- The three right-hand panels are resizable from their edge and share one
  remembered width.

### Changed

- **A declared metadata bound is now the scale**, not a limit on it. Percent
  burned draws 0–100 because it is a percentage, not 45–97.5 because that is
  what one site happens to span. Where no bound is declared — 387 of 504
  columns — the range mode's own minima and maxima serve instead.

- **The target no longer stretches the axis.** Three separate places were
  widening the scale to fit it, which moved every other marker while the reading
  it stood for had not changed.

- Site range mode uses the site's actual spread across its catchments rather
  than a 10% pad around the three plotted values.

- One header for every view mode — scenario, factor, scenario — so cycling
  map, flat, dial and table changes what is drawn in the pane and not the frame
  around it. Table widgets are titled by their factor.

- Site area and catchment count are stated once in the header instead of once
  per table pane. The factor configuration opens in the side panel rather than
  as a modal over the grid.

- Removed as duplicates of controls the header already carries: the Zone Range
  panel, the range buttons on each dial, the per-widget shape toggle and help
  button, the scale lock, the Hide Table button and the Tiles badge.

### Fixed

- Dials no longer flicker while a target moves. Every value change replayed the
  reveal animation, which drives opacity across the whole widget.

- A dial whose own values did not change is no longer redrawn — one of sixty
  SVGs during a live drag, rather than all of them.

- The target marker is drawn even when it sits on the current value, so a reset
  to current lands on the line instead of vanishing.

- Dials no longer read N/A for every value in grid view.

- A reset lands exactly on the scenario it names. It went through the cascading
  edit path and only covered editable keys, so it landed near the scenario
  rather than on it.

- The factor panel's close button works. It was shown only on mobile and had no
  click handler at all.


- **Live update in the target editor, and an end to the redraw after every
  change.** Moving a slider used to disable every other slider, drop a spinner
  over the whole form, and re-enable them a moment later. Focus moved, the
  scroll position went with it, and the user had to find their place again
  after each edit. Sliders now stay live throughout and progress is a small
  indicator in the panel header.

  A new **Live update** checkbox decides *when* the recalculation runs. Ticked,
  the sliders and the charts behind them recalculate continuously as you drag;
  cleared, they wait for the drag to end. Because a recalculation rescores every
  catchment in the site, the default follows the site's size — on at or below 20
  catchments, off above it. An explicit tick or untick is remembered across
  sites and sessions and overrules the count from then on, so a large site can
  be dragged live on a machine that keeps up and a small one need not be.

  Live dragging never queues a backlog: at most one recalculation is in flight,
  and movement made while it runs collapses into a single follow-up, so the
  result converges on the value the pointer was released at rather than
  replaying every intermediate one.

- **The target editor is a docked side panel rather than a modal overlay.** It
  takes the same right-hand slot as the single-factor controls — opening either
  dismisses the other — and the views shrink to make room instead of being
  covered. The editor exists to show the dials answering a slider, and an
  overlay hid exactly what it was meant to show.

### Fixed

- **The dials no longer flicker while a target slider moves.** Every value
  change replayed the dial's *entry* animation, and the two progress values
  that animation drives are wired to `opacity` throughout the widget — so each
  change faded the whole dial out and back in. Under live editing that is
  several strobes a second. The reveal now runs only when a dial appears; a
  value change eases the needle to its new angle instead, and a rescale simply
  redraws at the new scale. Neither makes the dial disappear first.

  The needle's easing deliberately overshoots so it springs onto its mark, which
  meant the reveal briefly asked for a *negative* opacity. The overshoot now
  applies to the angle only.

- **A dial whose own values did not change is no longer redrawn.** Editing a
  target replaces the whole indicators object, so all six dials re-rendered on
  every recalculation even though at most one of them had changed. `DialChart`
  is memoised on its props, which are all primitives or stable callbacks.
  Measured on a live drag: one dial of the sixty SVGs on screen redrew, where
  previously the count of mutated attributes ran into the thousands.

- **Releasing a drag no longer throws focus onto another slider and scrolls the
  panel to it.** Chakra focuses a slider's thumb whenever its *value* changes,
  using a bare `.focus()` that scrolls the element into view. A recalculation
  cascades into the other sliders' values, so letting go of one slider sent the
  panel off to an unrelated one. Focus is now moved deliberately, on pointer
  down, to the slider actually being used, and without scrolling.

- **The target panel's heading no longer sits under the top bar.** The panel
  offset itself by a hard-coded 70px; the header is content-sized and is
  actually taller than that. It is now measured.

- **Dragging a target back to where it started now clears it.** The editor
  diffed against the values it opened with and skipped anything that matched, so
  a slider returned to its opening position submitted nothing and the target set
  a moment earlier stayed in place with no way to undo it. It now tracks which
  sliders were actually touched, and sends a touched slider's value whether or
  not it happens to equal the one it started at.

- **Deployment documentation for the published container image** — how to pull it
  from GHCR, how to run it with the data and resources directories mounted, and
  what to do about permissions. Covers the two failures that produce a confusing
  message rather than a useful one: GHCR's `denied` meaning both "you may not" and
  "no such package", and the uppercase image path failing as `denied` rather than
  `not found`. Records that a package is created private on first push and must be
  made public once by hand, and that a 403 on the first release push is usually the
  repository's Actions permissions rather than the package.

- **Every pull request now publishes the container image, its SBOM and its
  vulnerability scan**, and annotates the pull request with both tables. The image
  is a `container-image` artefact kept for 7 days, so a change can be run before it
  merges without building anything locally.

  It is tagged `decision-theatre:<flake version>-<commit>` rather than with the
  flake version alone. Every build previously came out as `decision-theatre:4.0.0`
  regardless of which commit produced it, so images from two pull requests were
  indistinguishable and loading one replaced the other. The pull request comment
  now carries the `gh run download` command that fetches it, says plainly that
  pull request builds are not pushed to a registry, and points at GHCR for the
  released images.

- **Every release publishes the image to GHCR** as
  `ghcr.io/kartoza/decisiontheatre:<version>`, and stable releases additionally
  move `:latest` to it, with the image tarball, SPDX SBOM and Grype scan attached
  as release assets and the same tables appended to the release notes. A
  pre-release tag — anything with a hyphen after the version, `v2.4.0-rc1` —
  publishes only its version tag and leaves `:latest` where it is, so an unpinned
  `docker pull` never lands on a release candidate. The release itself is marked as
  a pre-release on GitHub to match.

  The scan does not fail the build. A CVE in a system library is a fact to weigh,
  not automatically a defect here, and a gate that trips on every Negligible
  finding in glibc trains people to ignore it — gating belongs to an agreed
  severity policy. `scripts/sbom_table.py` and `scripts/cve_table.py` render the
  reports, with 18 tests covering deduplication, licence shapes, severity ordering
  and the empty cases.

### Removed

- **The `container-build` CI job.** Building the image from the flake is the only
  path now tested, so a pull request builds one image instead of two.
  `deployments/Dockerfile` remains for the moment because compose still builds
  from it and the nightly redeploy depends on the toolchain image beside it;
  it is no longer built or tested in CI.

- **The container image can be built from the flake.** `nix build .#container`,
  `./scripts/build-container.sh` or `make container` produce a Docker image whose
  contents are the runtime closure of the binary the flake already builds.

  `deployments/Dockerfile` names its runtime packages by hand, which means two
  statements of what the application needs with nothing keeping them in step. They
  did fall out of step: it installed WebKit 4.0 while the flake, CI and the Debian
  packaging all targeted 4.1, and it omitted a plugin `mkdocs.yml` requires, so for
  a while no image could be built at all. An image derived from the flake has no
  second list to drift.

  Both paths still work and both are built in CI. `docker-compose.yaml` gained a
  `DT_IMAGE` override, defaulting to what compose builds today, so an existing
  deployment is unaffected until it opts in.

- **The frontend is linted.** The repository has shipped an eslint dependency, a
  `lint` script and a CI job called `lint-frontend` since it was written, and none
  of them ever linted anything: there was no configuration file, so eslint exited
  with an error rather than a result, and the CI job ran `npx tsc --noEmit` alone.
  No TypeScript in this project had ever been linted.

  `frontend/eslint.config.js` is built from the `@typescript-eslint` parser and
  plugin already in `package.json` rather than the `typescript-eslint`
  meta-package, so linting the code we have costs no new npm dependency. The rule
  set is deliberately narrow — faults rather than style — because enabling
  everything at once produces findings that get silenced rather than fixed. CI
  runs it, and `--report-unused-disable-directives` means a suppression left
  behind after a fix fails the build.

  The first run found 25 problems, including a **conditionally called hook**:
  `useColorModeValue` inside a `viewMode !== 'chart'` branch in `ControlPanel`,
  which changes the number of hooks between renders — React's "rendered fewer
  hooks than expected". It now uses the value the component already computes.

  Also fixed: a `!=` that should be `!==`, five deliberately-unused destructuring
  bindings that now say so with an underscore instead of a `void` statement, and
  two dependencies a hook never used. The remaining fifteen
  `react-hooks/exhaustive-deps` findings are recorded in place with a reason and
  tracked, rather than fixed blind: adding a dependency changes when an effect
  runs, and in a 4,000-line component with no rendering tests that can produce a
  render loop nothing here would catch.

- **`scripts/protect-branch.sh --no-strict`**, for batch merges. Strict protection
  requires a branch to be up to date with `main` before it can merge, so with several
  green pull requests waiting, merging the first makes every other one stale: five
  ready pull requests become five sequential update-and-wait-for-CI cycles.

  `--no-strict` drops only the up-to-dateness requirement. Every check is still
  required and must still have passed — the only thing given up is the demand that it
  passed against the newest `main`. That is a real if small risk, since two changes can
  each be green alone and broken together, so it is meant for a deliberate batch with
  `main` checked afterwards, never as a standing setting. Running the script with no
  arguments restores strictness, which is what the batch caller relies on.

  `--help` no longer reads a hardcoded line range, which the new paragraph would have
  silently truncated.

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

- **The control panel reads as one surface instead of a stack of boxes.** Reviewing
  the panel against the map showed it drawing a frame around each section — the
  factor card and both scenario cards — inside a panel that is already a container,
  so every section carried a second edge that said nothing. Those frames are gone,
  along with the rules between the factor and the scenarios, above the colour
  scale, and above each scenario's min/mean/max row; the last of these had the
  scenario description sitting on top of it. Three labels went with them: the
  "Choose a factor to display in this view" hint under Indicator, the "COLOR SCALE
  (Full)" heading whose only companion was a button group commented out some time
  ago, and "Full Zone Statistics", which each scenario printed with the same
  catchment count as the other and which repeated the zone the control above it
  already names. That count now sits beside the Zone Range control it belongs to,
  once. Zone Range is set as a heading like Indicator rather than as small grey
  all-caps, and its Full/Extent/Site switch spans the panel instead of huddling at
  the left edge under a full-width heading. The pane number moved off the panel
  heading onto the factor card, which is the thing the pane number identifies.

- **Each cluster of header controls carries the accent of what it acts on.** View,
  colour range and map display sat in one row painted a single brand blue, which
  made three separate decisions look like one long strip of icons. View keeps the
  blue; colour range takes the Create Site orange; the map toggles take the site
  green. Both new accents are set with dark text, because white on either falls
  below the AA contrast floor.

- **Buttons have one corner radius, set once.** The theme's default was `full`,
  which made pills of controls that sit in dense rows, so individual controls had
  begun overriding it one at a time — the header icon bar first, then Create Site,
  the range switch and the aggregate table's toggle. The default is now `md` and
  the seven overrides restating it are deleted, so a button is consistent by
  inheriting rather than by remembering.

### Fixed
- **The Windows installer, for the first time.** No release has ever carried an
  `.msi` — not since v0.2.0 — and until now the failure was invisible, hidden
  behind the macOS and documentation faults that stopped the run earlier. With
  those gone it became the only thing standing between a tagged release and its
  artefacts, and the cause turned out not to be the packaging at all:

      error WIX7015: You must accept the Open Source Maintenance Fee (OSMF)
      EULA to use WiX Toolset v7

  `dotnet tool install --global wix` names no version, so the job installed
  whatever was newest on the day it ran. WiX v6 introduced the maintenance fee
  and v7 enforces it by refusing every command until the EULA is accepted, so
  the build broke without a commit — and no commit could have prevented it.
  WiX is now pinned to 5.0.2, the last release before the fee, which reads the
  v4 schema `packaging/windows/product.wxs` is already written against.

  Adopting v6 or v7 later is a licensing decision rather than a version bump:
  organisations over $10,000 in annual revenue must sponsor the wixtoolset
  GitHub organisation to satisfy the fee.


- **The table view no longer offers a screen it cannot fill.** Table view is a
  per-site breakdown, so with no site selected it renders "No catchment data
  available" and nothing else. The icon is now disabled in that state, with a
  tooltip saying why, in the same way the Site range option already was.

- **A disabled view could take the header's control groups out of the tab order.**
  Each segmented group puts its single tab stop on the selected option, which is
  correct until that option is itself disabled — reachable now that the table view
  can be, by clearing the site while table view is open. The tab stop falls back to
  the first enabled option, so the group stays reachable by keyboard.

- **The scenario badge in the aggregate table was unreadable.** It asked Chakra for
  a `colorScheme`, which in dark mode renders the subtle variant as muted olive and
  grey rather than the brand's orange, green and blue. It now takes its colour from
  the palette directly, as the scenario badges in the control panel already did.

- **One set of map controls, in the header, instead of thirty-six buttons.** Three
  bands of controls competed for the most space-starved screen in the application.
  A full-width bar above the panes held the view-mode, range-mode, add-pane and
  target controls; each pane carried a vertical stack of six circular buttons — 3D,
  choropleth, identify, satellite, swiper and zoom-to-site; and the header had a
  `Spacer` between the site title and the navigation holding nothing at all.

  Every one of those per-pane buttons already acted on *all* panes: they were one
  setting drawn six times, and clicking any copy moved all six. A six-pane grid drew
  36 buttons for 6 settings. They are drawn once now, in the space the header was
  wasting, and the bar is deleted rather than hidden — returning a full horizontal
  band of vertical space to the widgets.

  The controls that genuinely belong to one pane — focus, configure factor, remove,
  calculation details — stay in that pane. Six panes legitimately need six focus
  buttons, and that is not duplication.

  State moved to `App`, which is where it always belonged given what it did.
  `MapView` now reads these as props and applies them through effects; only the
  basemap still reports back, because the satellite-quota revert happens down
  there. Zoom-to-site is a `dt:zoom-to-site` window event — the header cannot reach
  a pane's MapLibre instance, and the guided tour's existing listener already
  handled the readiness and deferral cases.

  What is left on a pane — focus it, configure its factor, remove it, drag its
  compare swiper — **appears on mouse over** rather than sitting on top of the data
  all the time. Those controls could not move to the header the way the global
  toggles did: they act on one pane, so six panes legitimately need six of them.
  They get out of the way instead. One stylesheet covers both halves of that
  chrome, the React toolbar and the imperatively-built swiper handle, so their
  timing cannot drift apart. The swiper's divider line stays visible: it marks
  which side of the comparison is which, and is information rather than a control.
  It does thin from 12px to 3px at rest, though, and widens with everything else
  on hover — most of that width exists to be grabbed, which only matters once the
  pointer is on the pane. Its width, fill and shadow used to be set inline from
  JavaScript in six places across two duplicated blocks; they are one CSS rule
  now, and `MapView` sets a `data-docked` attribute and nothing else.

  **One zoom cluster for the grid, not six.** Every map drew its own zoom in /
  zoom out / compass control at the bottom left. They were not six controls: every
  map registers with `useMapSync`, and moving any one moves all the others, so all
  six did the same thing to the same six maps. It now appears on the bottom-left
  map only — resolved against what is actually showing a map, so a grid whose
  bottom-left widget is a chart still has a zoom control, one row up or one column
  across. The choice is recomputed rather than fixed, because panes are removable,
  the columns toggle between two and three, and a pane can switch view at any time.

  The hiding is scoped to `@media (hover: hover) and (pointer: fine)`, because on a
  touch screen there is no hover to bring a control back with; it lifts on
  `:focus-within` as well as `:hover`, so a keyboard user can see where they are;
  and it lifts entirely while a guided tour is running, since two of these
  elements are tour spotlight targets and a ring drawn around something invisible
  is worse than no ring.

  **The pane labels hang from the top edge instead of floating over the data.**
  The two scenario names and the factor between them sat inset 12px from the top
  corners as rounded pills, six panes' worth. They are pulled flush now — left into
  the top-left corner with only its bottom-right corner rounded, the factor
  centred under the top edge with both bottom corners rounded, the scenario on the
  right into the top-right corner with only its bottom-left — so they read as part
  of the pane frame rather than as objects on top of the map. The two scenario
  labels are also about half the size — 13px type at 6px padding becomes 10px at
  2px, roughly 28px tall down to 16px. The factor label keeps its original type
  and padding: it names what the pane is showing, where the scenario names either
  side are supporting text.

  **And the scenario labels collapse to their colour accent at rest**, expanding
  again on hover or focus. The question they answer — which side of the swiper is
  which — only matters once someone is looking at that pane, and the answer
  survives the collapse: what is left is a 9px tick filled with that scenario's
  own colour, text hidden, so the coding that made the label useful is the part
  that stays. A six-pane grid goes from eighteen pills to
  six titles and twelve coloured ticks. The factor label is deliberately not in
  the set: a grid of six unlabelled maps is the thing worth avoiding, and it has
  no accent to be left with. The three were three copies of the same twelve declarations and now share
  one base, with each supplying only its position and its exposed corners. The
  scenario colour accent on the left label moved to that label's right edge, so
  both accents face the map between them: with the label flush in the corner, an
  accent on its outer edge reads as part of the pane frame rather than as the
  scenario's colour.

  Accessibility along the way: the view and range switches are `radiogroup`s with
  one tab stop, arrow-key traversal and `aria-checked`, where they had been
  independent `IconButton`s conveying selection through background colour alone;
  the toggles carry `aria-pressed` and an underline as well as a fill. Below `xl`
  the full set collapses to the view switch plus the toggles, and below `md` into an
  overflow menu that carries every control — not `display: none`.

- **The sites list no longer downloads five megabytes of demo content to show a
  list of titles.** `listSites` fetched and parsed all four walkthrough documents —
  **5,025,346 bytes**, one of them 4 MB — on the path to first render, for demos
  the user may never open, to display a title, description, thumbnail and date.

  It now reads `data/walkthroughs/manifest.json`, which carries exactly those
  fields in **1,184 bytes**. The full document is still fetched when a site is
  actually opened, which is where the AOI-weighted aggregate is recomputed, so
  nothing that reads indicators is affected.

  The manifest is generated by `make walkthrough-manifest` and a test regenerates
  it and compares, so a committed manifest cannot drift from the documents it
  summarises. Another test fails if a future edit starts embedding catchments,
  geometry or indicators in it, which would quietly restore the 5 MB first render.
  A datapack without a manifest falls back to the old path rather than showing no
  demos.

- **Map rendering is capped at 1.5x device pixel ratio.** Both MapLibre instances
  were created without `pixelRatio`, so each rendered at the display's native
  ratio. Fragment shading cost scales with the *square* of that: a 2x display does
  four times the per-pixel work, a 3x display nine times — and quad view keeps up
  to twelve map instances live. The clamp only ever lowers the ratio, so a 1x
  display is untouched, and 1.5x is visually near-indistinguishable on a map at
  these zoom levels. The existing `fadeDuration: 0` is left alone.

- **`prefers-reduced-motion` is honoured.** There are 157 framer-motion call sites
  across 14 files and not one consulted the setting, which the project's WCAG 2.2
  AA target requires independently of the performance argument. A single
  `<MotionConfig reducedMotion="user">` at the root covers all of them, and covers
  any animation added later without anyone having to remember. It sits outside the
  error boundary so the guided tours, which animate too, are included.

- **The application shipped 6.85 MB of JavaScript before first paint, and 18 MB of
  images.** plotly was imported statically at the top of the chart component, so
  every visitor downloaded roughly 4.6 MB of plotting library whether or not they
  ever opened a chart.

  It is now imported with `React.lazy` behind a `Suspense` boundary. The critical
  path drops from **6.85 MB to 1.96 MB** of JavaScript — the entry chunk alone goes
  from 5.50 MB to 0.61 MB — and plotly is fetched when a chart is first rendered.
  Total JavaScript is unchanged at ~6.97 MB; this moves weight off first paint
  rather than removing it. Both figures come from building this branch and current
  `main` from the same base, so the comparison is not confounded by other work.

  Naming plotly in `manualChunks` looked like the right accompaniment and is
  actively wrong: it puts the module back in the static graph, Vite emits a
  `<link rel="modulepreload">` for it, and the browser fetches all 4.6 MB before
  first paint regardless of the lazy import. Measured both ways; the entry is
  deliberately absent, with a comment saying why.

  Eight referenced images were converted from PNG to webp — **7.63 MB to 0.90 MB**,
  an 88% reduction, at quality 82 for photographs and 90 for screenshots where
  text legibility matters. `frontend/src/image.png` is deleted: 1.6 MB, imported by
  nothing, and byte-identical to `assets/Map_screenshot.png`. Two superseded logos
  went with it.

  Repository image weight falls from 18.65 MB to 5.31 MB — 71% — measured
  against git's tracked blobs rather than a filesystem walk.


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

- **The release workflow shipped no platform artefacts and no container image,
  for every release.** Seven release runs, none of them green. Two faults in the
  macOS legs of the build matrix, each enough on its own to stop everything
  downstream, because `release` needs all six packaging jobs and `container`
  needed `release`.

  The first: `Package (unix)` checksums its tarball with `sha256sum`, which is
  GNU coreutils and is not on a macOS runner — macOS ships `shasum`. The step
  passed on Linux and failed on both Darwin legs. It now uses whichever of the
  two is present; they print the same format, so the checksum file is
  unchanged.

  The second: `macos-13` has been withdrawn, so no runner ever matches the
  label. The job was never scheduled, sat queued, and was cancelled at
  GitHub's 24-hour limit — which is why a release looked like it failed the
  following day. `macos-14` is deprecated and was heading the same way, so both
  Darwin legs move to the current GA pair, `macos-15-intel` and `macos-15`.

  Neither fault was visible until recently: before `fail-fast: false` was set,
  the documentation failure cancelled the macOS legs within two minutes, so the
  packaging failure underneath it never had the chance to report.

  macOS is disabled for now rather than fixed and left to prove itself on a real
  tag: the Linux packages, the Windows installer and the container image have
  been unshippable for four releases, and they should not wait on it. Every
  macOS block is commented out behind a `--- macOS: DISABLED ---` marker, with
  the corrected runner labels preserved, so restoring it is uncommenting rather
  than re-diagnosing.

- **`ghcr.io/kartoza/decisiontheatre:latest` stopped moving after v2.3.0.** The
  container job was sequenced after `release` so their release-body writes could
  not race, but `needs` also means "only if that job succeeded", which put the
  image behind every platform package. v2.4.0, v2.5.0 and v2.5.1 published no
  image at all, leaving `:latest` on the v2.3.0 build — indistinguishable, to
  anyone pulling it, from a release that had been reverted. The server image
  does not depend on a `.dmg` or an `.msi` existing, so the ordering stays and
  the gate goes.


- **Blank map panes, and fifteen seconds of spinner, on a server with no imagery
  provider.** Maps were constructed against `/api/satellite-style.json` whenever
  the runtime was a browser, without waiting to learn whether satellite was
  configured. On a deployment with no key that endpoint returns **404 text/plain**,
  MapLibre cannot load the style, and a map whose style never loads **never fires
  its `load` event** — so the pane sat behind its spinner until the 15-second
  safety net gave up, six panes at a time, on every load.

  `satelliteConfirmed()` now answers the question a style URL actually depends on:
  has the server *said yes*, rather than *not yet said no*. The optimism that is
  right for whether to enable the control is wrong for whether a URL is safe to
  fetch, and the two differ for exactly the window in which a map is built.

  The recovery is symmetric now, too. The listener only handled satellite
  *becoming* unavailable, so a map built before `/api/info` resolved stayed on the
  built-in style for the rest of the session even once a key was confirmed. It
  re-applies what the user asked for against what is currently possible, which
  covers both directions in one call. Intent is kept separate from what is on the
  map, so "we do not know yet" can no longer be mistaken for a choice; only a real
  loss switches the toggle off and says so.

- **No release since v0.2.0 has carried a single platform artefact, and the cause
  was a hand-written `pip install` list.** Each of the five platform builds built
  the documentation itself from `pip install mkdocs mkdocs-material
  mkdocs-minify-plugin pygments pymdown-extensions`, which omits
  mkdocs-macros-plugin — and `mkdocs.yml` declares the `macros` plugin. So
  `mkdocs build` aborted with `Config value 'plugins': The "macros" plugin is not
  installed` on the first runner to reach it, `fail-fast` cancelled the other
  four, and the `release` job — which needs all five — never ran. v2.3.0 carries
  three assets: the container image, its SBOM and its scan, published by the one
  job that did not depend on any of this.

  The documentation is now built once by a `docs` job running `nix build .#docs`,
  the derivation `docs.yml` and the container image already used, and each
  platform build downloads and embeds it. `flake.nix` had the correct set in
  `mkdocsEnv` all along. This is the same failure the hand-maintained Dockerfile
  had — a second dependency list drifting from the first — in the last place
  still keeping one. No runner in the release workflow installs Python now.

  The build matrix also no longer fails fast, so a broken platform no longer
  hides the state of the other four.

- **The release workflow now refuses to publish an incomplete release.** It checks
  that every artefact `docs/developer-guide/releasing.md` promises is present —
  five archives, two `.deb`, two `.rpm`, two `.AppImage`, one `.flatpak`, one
  `.snap`, two `.dmg`, one `.msi` — and fails with the name of whatever is missing.
  The checksum step previously ended in `2>/dev/null ... || true`, so a packaging
  job that produced nothing surfaced only as a release quietly short a platform,
  and nothing else looked.

- **The AppImages were not being built.** `appimagetool` is itself a type-2
  AppImage and mounts itself with libfuse2, which the `ubuntu-24.04` runner images
  no longer carry, so it died on `dlopen(): libfuse.so.2` before doing any work.
  It now runs with `APPIMAGE_EXTRACT_AND_RUN=1`, which needs neither root nor an
  extra package.

- **The arm64 AppImage was built with the x86_64 `appimagetool`**, passing
  `ARCH=aarch64` to a tool that embeds a runtime of its own architecture. It is now
  built on an `ubuntu-24.04-arm` runner with the aarch64 tool.

- **The AppImage icon was a zero-byte file.** `Icon=decision-theatre` in the
  desktop entry pointed at an empty placeholder, so the AppImage carried no icon at
  all. It now uses the brand favicon already in the repository.

- **The snap was versioned `git`.** `version: git` is a core20-era keyword that
  `core24` does not interpret, so the literal three characters were taken as the
  version. The release tag is now substituted in at build time.

- **The container job could silently erase its own section from the release
  notes.** It appends to a release body that the `release` job sets outright, and
  the two ran concurrently — whichever finished last won. It now runs after it.


- **A walkthrough's charts, dials and aggregate table emptied thirty seconds after
  opening it.** The per-catchment breakdown ships embedded in the walkthrough
  document and is primed into an in-memory cache on load. That cache expires after
  30 seconds, and the refetch cannot work: the server has never heard of a
  walkthrough site, so `GET /api/sites/{id}/catchments` answers 404 — "failed to
  read site file" — and the caller turns that into an empty array.

  It only became reachable when the client stopped persisting the breakdown
  alongside the site, which had made the copy permanent. The embedded copy is now
  marked sticky: it is not a cached copy of something fetchable, it is the only
  copy, so neither the TTL check nor the eviction sweep may discard it.


- **A client that gave up did not stop the work it had started.** No database call
  took a `context.Context`, so when a user closed a tab, panned the map again, or
  a proxy timed out, the query ran to completion against SQLite — holding a
  connection and CPU for an answer nobody would read. The most expensive query in
  the application takes over four seconds and the map issues one on every pan, so
  abandoned work accumulated exactly when the server was already busy.

  Every SQLite-touching method now takes a context and uses the `Context` query
  variants, and a cancelled request is logged as cancelled rather than as a
  failure. Cancellation is detected from both shapes it arrives in: `database/sql`
  reports `context.Canceled`, while go-sqlite3 reports its own `SQLITE_INTERRUPT`
  when a statement is stopped mid-flight. A blown deadline is deliberately *not*
  treated as a cancellation — that is a real failure.

  Some work is deliberately not cancellable, because it is started on behalf of
  one request and serves all of them: the grid geometry cache build is guarded by
  a `sync.Once`, so a cancellation would tear it down and nothing would restart
  it, leaving the aggregated map path broken for the life of the process. What is
  now cancellable there is the *wait*, not the build.

  Ten result loops gained the `rows.Err()` check they lacked. This was required
  rather than tidy: a cancelled scan ends iteration early, so without it a partial
  choropleth or a partial statistics set would have been returned as complete —
  threading a context would have created a new silent-failure path while closing
  another.

- **The container images built against a different WebKit than everything else ships.**
  `deployments/Dockerfile`, `deployments/Dockerfile.cross` and
  `deployments/Dockerfile.builder` all installed `libwebkit2gtk-4.0-dev`, while the
  flake, CI, the Debian
  packaging and the documented runtime dependency all target 4.1. The container was
  therefore the one build nobody else's environment matched, and WebKit 4.0 has been
  dropped from current Debian, so it was borrowed time rather than a stable choice.

  All three now install 4.1 and run `scripts/webkit-compat.sh`, the same shim the
  flake and CI use, which derives a `webkit2gtk-4.0.pc` from the installed 4.1 one so
  that `webview_go`'s hardcoded `#cgo pkg-config: webkit2gtk-4.0` resolves. Verified
  by building both files: the binary links `libwebkit2gtk-4.1.so.0`, the container
  serves `/`, `/api/health` and `/docs/`, and `--build-arg VERSION` reaches
  `--version`.

- **`mkdocs build` failed in both container files.** `mkdocs.yml` has declared the
  `macros` plugin since the documentation rebuild, and neither Dockerfile installed
  `mkdocs-macros-plugin`, so every image build died at
  `Config value 'plugins': The "macros" plugin is not installed`. This was already
  broken on `main`.

  No workflow built either container file, which is how a Dockerfile that could not
  succeed came to sit on `main` unnoticed. CI now has a `container-build` job that
  builds `deployments/Dockerfile`, runs it, and checks that it reports the version it
  was built with, links `libwebkit2gtk-4.1.so`, and serves `/`, `/api/health` and
  `/docs/`. A one-second grep in front of it fails the job immediately if any
  container file reintroduces WebKit 4.0.

- **`SPECIFICATION.md` documented fixed vulnerabilities as present.** Its "known gaps"
  section still said the server binds all interfaces, that `POST /api/datapack/install`
  accepts an arbitrary filesystem path, that `POST /api/dialog/open-file` is registered
  in server mode, that thumbnail paths are unvalidated, that there are no request body
  size limits and no response compression. Five of those seven were closed on `main`
  weeks ago. A specification that describes fixed defects as current is worse than one
  that omits them: it is read as a threat assessment.

  Each claim was rechecked against the code and the section rewritten to what is
  actually true. Two gaps remain and are stated as such: there is still no
  authentication on any endpoint and `deployments/nginx.conf` still proxies every path
  without a denylist, and there is still no `context.Context` on database calls.

- **The endpoint list did not say which routes are desktop-only.** A user's sites live
  in their browser — the design brief, and what the client does — so the server's site
  CRUD exists only in the desktop build, where the WebView has no persistent storage of
  its own. The specification listed those routes as ordinary API, which reads as though
  a hosted deployment stores users' sites. All seven gated routes are now marked, and
  the reason is stated where the list begins.

- **A local build and a nix build of the same commit reported different release
  numbers.** `scripts/version.sh` — which the Makefile and every packaging script
  use, so that they cannot disagree — reported `git describe` alone, and
  `git describe` names the newest *tag*. `flake.nix` declares **0.4.0** and the
  newest tag is **v0.2.2**, so `make build` produced a binary calling itself
  `0.2.2-115-g1311b8a` while `nix build`, which takes its version from
  `flake.nix`, called the identical source `0.4.0`.

  The declared version now leads and git's position follows it —
  `0.4.0-115-g1311b8a`, `0.4.0-115-g1311b8a-dirty`, or plain `0.4.0` on a clean
  checkout of the matching tag or outside a git checkout entirely. `flake.nix`
  remains the one place a release number is written; `version.sh --declared`
  reports it without the suffix, and `scripts/doctor.sh` now asks for it rather
  than growing a second grep of `flake.nix`.

  `dt doctor` also reports when the declared version has no tag — the condition
  that caused this, and one that is otherwise invisible until two binaries are
  compared. `scripts/tests/version-test.sh` covers the behaviour in throwaway
  repositories; 8 of its 11 cases fail against the previous script.

- **Switching sites coloured the map from the previous site.** `applyColors` was
  memoised on `[colorScaleMode, colorScaleType]` while its body read the `siteId`
  prop in ten places — the choropleth fetch for both panes, the browser-runtime
  ideal overrides, and three per-site caches. The effect that calls it does list
  `siteId`, so on a site switch it invoked a callback still bound to the previous
  site's id, and the stale value persisted until an unrelated colour-scale change
  happened to recreate the callback.

  `siteId` is now declared. Everything else the callback reads goes through a ref,
  which is why it was the only value that could go stale.

  `react-hooks/exhaustive-deps` is the tool for this and the repository has no
  eslint configuration at all, so nothing would catch a recurrence. A test now
  asserts, for this one identifier in this one file, that a hook reading it also
  declares it — and the analyser it uses is itself tested against known input,
  because a source-level check that is silently broken reports success either way.
  An audit with it found exactly one genuine case: an earlier throwaway version
  reported two, the second a false positive from matching a later hook's
  dependency array.

- **The production page injected stack traces into itself.** `index.html`
  installed `window.onerror` and `unhandledrejection` handlers that appended a
  fixed, full-width red block containing the message, file, line, column and full
  stack to the live document — internal paths and frame details shown to whoever
  happened to be using the application, in every build.

  The handlers now live in `src/main.tsx` behind `import.meta.env.DEV`, which is a
  compile-time constant, so the block is **removed from a production bundle**
  rather than merely skipped — verified by grepping the built assets. In
  production the React error boundary is the recovery path, and anything outside
  React reaches the console.

- **Analytics loaded unconditionally in the desktop application.** The Google tag
  sat three lines below a comment in the same file saying nothing there may fetch
  from a third party, because in the offline desktop build an external request
  either fails or blocks first paint. It also reported desktop usage to Google as
  though it were a web visit.

  It now loads only when `__DECISION_THEATRE_WEBVIEW__` is absent — a marker the
  webview injects before any page script runs, so the check is reliable rather
  than a guess — and is appended by script rather than being a bare tag that
  executes before any guard can run. This is **not** consent: opt-in telemetry
  with a visible toggle, and supplying the measurement ID at runtime, both remain
  open.

- **Two thirds of the indicators were invisible.** `metadata.csv` is exported from
  R, whose `make.names()` rewrites spaces and hyphens to dots, so
  `herbs_diet_kgkm2_Obligate grazer` in the GeoPackage is
  `herbs_diet_kgkm2_Obligate.grazer` in the metadata. The lookup is an exact string
  comparison, and a row matching nothing was silently discarded — nothing logged
  it, and the indicator simply never appeared.

  Measured against the supplied datapack: of **502** GeoPackage columns, **158**
  carried metadata and **344** did not, so two thirds of the dataset had no colour,
  no detailed name, no units, no axis label and no chart type, and was missing from
  every selector that reads those maps. After the fix, **502 of 502**.

  Each metadata entry is now also keyed by the real column name. The alias is built
  from the GeoPackage side rather than by reversing the substitution, because the
  reverse is ambiguous — `make.names()` maps both `' '` and `'-'` to `'.'`, so
  `Browser.grazer.intermediate` could be either, and in this dataset it is
  `Browser-grazer intermediate`. Normalising the real column forward has exactly
  one answer. An entry the CSV already provides is never overwritten, and a `false`
  flag is not aliased, because those maps carry meaning by presence.


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
- **Place-name search called Nominatim directly from the browser, outside the OSM
  usage policy.** That policy requires a `User-Agent` naming the application with a
  contact, asks that results be cached, and caps traffic at one request per second.
  None of it was achievable where the code sat: `User-Agent` is a forbidden header
  name for `fetch`, so the browser silently cannot send one, and a 400 ms input
  debounce is not a rate limit — several open tabs are several times the traffic.

  Searches now go through `GET /api/geocode`, which sends
  `DecisionTheatre/<version> (+https://github.com/kartoza/DecisionTheatre)`, holds
  upstream calls a second apart for the whole deployment, and caches answers for
  15 minutes. An upstream failure returns an empty list rather than an error, so
  the client keeps its bundled gazetteer matches and search still works offline.
  The response shape is normalised, so the client no longer knows which geocoder
  answered and swapping it is a change to one file.

- **Page backgrounds were hotlinked from `images.unsplash.com` on every page
  load**, making three pages depend on a third-party host at runtime that can
  rate-limit, change what a URL returns, or see the IP of every visitor. Both
  images are vendored (668 KB total, webp) with their provenance and licence
  recorded in `frontend/src/assets/backgrounds/README.md`.

- **The satellite tile URL was written out twice** and pointed at Google's
  undocumented `mt0.google.com` endpoint. It is now defined once, in
  `frontend/src/lib/satelliteBasemap.ts`, and supplied at runtime via `/api/info`
  from `--satellite-tile-url` / `--satellite-attribution` — not through
  `import.meta.env`, which Vite inlines at build time. The default endpoint is
  unchanged for now, so **this does not resolve the terms-of-use question**; it
  makes answering it a deployment change rather than a code change. Attribution
  travels with the URL, since crediting Google for another provider's imagery
  would be worse than crediting nobody.

- **Three external links opened with `target="_blank"` and no
  `rel="noopener noreferrer"`**, while partner cards higher in the same file set it
  correctly. All now carry it.

- **The documentation iframe had no `sandbox` attribute.** It now runs with only
  what MkDocs Material needs — scripts, same-origin, and popups that escape the
  sandbox — withholding top-level navigation, forms, modals and downloads.

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

- **localStorage failures were discarded, so saves appeared to succeed and did
  not.** Every write path ended in an empty catch block. Once the quota was
  exhausted the user saw their change reflected in React state and lost it on
  reload — which reaches us as "the app is flaky" or "it lost my work" rather than
  as a storage complaint, and hid the underlying problem from anyone debugging it.

  Writes now go through `frontend/src/lib/storage.ts`, which reports rather than
  swallows. `QuotaExceededError` is told apart from a blocked store (private
  browsing, a privacy setting) because the advice differs: delete something, versus
  nothing you save will survive this tab.

  The two kinds of write are treated differently on purpose. Losing a **site** is
  losing the user's work, and `saveLocalSites` already reported that so the caller
  could say so. Losing a **pane layout** is losing a preference, and a toast per
  failed write would be several a minute about something the user cannot act on
  per-write — so preference failures surface **once per kind of failure per
  session**, and always log.

  A startup health check warns at 80% of the typical 5 MB quota, while writes still
  succeed, rather than after something is lost. It probes with a real
  write-read-remove round trip, because in private mode some browsers expose a
  `localStorage` whose `setItem` throws — testing that the object exists proves
  nothing.

  The duplicate `isQuotaExceededError` in `hooks/useApi.ts` now comes from the same
  module, and the two `sessionStorage` catch blocks in `types/index.ts` were
  converted too, so nothing in that file swallows a storage error any more.

- `GOPATH` is set from the project root rather than `$PWD`, so running a Go command after
  `cd`-ing into a subdirectory no longer creates a second module cache there. Two had
  accumulated, under `frontend/` and `resources/mbtiles/`.

### Performance

- **Guided-tour documents were gzipped again for every visitor.** The compression
  middleware pools gzip writers, not their output, so each static document under
  `/data/walkthroughs/` was recompressed on every request. Measured on the real
  datapack against the whole-of-Africa tour — 2,104,591 bytes — the same file
  requested five times in a row cost 0.119, 0.111, 0.108, 0.096 and 0.085 s, with
  no warm-up effect because there was nothing to warm. Requested uncompressed, the
  same file served in 0.0022 s: roughly 2.5 ms of that is serving the file, and the
  rest is gzip level 5 repeated for every visitor.

  Compressing is the right trade — 2.01 MB down to 456 KB on the wire is worth far
  more than 64 ms on any real connection. The waste was compressing the *same
  bytes* over and over, for files that change only when the datapack does. They are
  now compressed once and reused: the same five requests cost 0.084, 0.001, 0.002,
  0.001 and 0.001 s, serving byte-identical content with unchanged `Content-Type`,
  `Content-Encoding`, `Vary` and `Last-Modified`, and `If-Modified-Since` still
  answering 304.

  Cached bytes are keyed on the file's own size and modification time, and the
  handler is rebuilt when a datapack is installed, so a swap cannot serve the
  previous datapack's body. API responses are deliberately not cached: they vary
  with query parameters and site state, and a cache keyed on path alone would serve
  one user another's answer. Retention is capped at 32 MB, past which responses are
  still compressed and served correctly and simply not retained.
- **Saving one site cost as much as saving all of them.** The three bulk callers
  loaded every stored site, changed one, and wrote them all back, so `JSON.parse`
  and `JSON.stringify` ran across the whole store on the main thread for every
  edit — and the cost grew with everything a user had ever saved rather than with
  what changed.

  A record cache now keeps, per site, the object last handed out and the exact
  string it serialises to. Reads re-parse only when the stored string differs, an
  untouched site is recognised by reference and never re-serialised, and the index
  is rewritten only when membership or order actually changed.

  Measured in jsdom, editing one site out of 200 with the store at 4,091,627
  characters — 78% of this machine's measured 5,241,856-character localStorage
  ceiling — **saving fell from 24.94 ms to 0.28 ms and reloading from 17.90 ms to
  0.60 ms**. The figure that matters is that the new cost barely moves between a
  807,000-character store (0.21 ms) and a 4.1-million one (0.28 ms): it is now
  proportional to the edit, not to the store.

  Nothing is deferred, debounced or batched, so no durability window is
  introduced — these records are the user's only copy of their work. A cache entry
  is written only when the underlying write succeeded and is dropped when it
  failed, so a quota exception can never leave the application believing a site is
  stored.

- **The application held twelve WebGL contexts in grid view and never gave one
  back.** Each `MapView` built two MapLibre instances — left and right — whether or
  not the user was comparing anything, and a pane latched "has shown a map" on first
  display and kept the map mounted behind `opacity: 0` for the rest of the session.
  Six panes, two contexts each, permanently. Browsers cap simultaneous contexts at
  around sixteen and silently drop the oldest past that ("Too many active WebGL
  contexts"), and integrated GPUs run out of memory well before that count.

  The right map is now created on entering compare mode and removed on leaving it,
  and a pane releases its maps once it has stopped displaying one. MapLibre
  instances constructed by a six-pane grid, counted under the test harness:

  | grid view, six panes | before | after |
  |---|---:|---:|
  | all on a map, compare off | 12 | **6** |
  | all on a map, compare on | 12 | 12 |
  | two on a map, four on chart/dial/table | 12 | **4** |

  The compare swiper defaults to on, so the worst case is unchanged; what has gone
  is paying for maps nothing is displaying.

  Releasing a map is not free, so a pane keeps its map for fifteen seconds after
  switching away — flipping to a chart and straight back does not reload anything.
  The sync registry now remembers the last view any map reported, and a new
  instance opens there rather than at the default world view, so a release and
  recreate does not move the map under the user.

- **Panning the map re-asked questions whose answers could not have changed.**
  `ViewPane` and `ChartView` both listed the map extent as an effect dependency
  regardless of range mode, and the extent is a fresh object on every move — so a
  pan re-issued full-domain queries that do not depend on the extent at all. At
  4.77 seconds per full-domain `/api/aggregate` request, a scripted six-pane
  session of one mount and five pans issued **216 chart-pane requests where 6 were
  needed, and 72 dial-pane requests where 2 were** — roughly 1,030 seconds of
  server work reduced to about 29.

  Overlapping work is now ordered as well as reduced. `applyColors` is called from
  sixteen places and is asynchronous throughout, so runs routinely overlapped and
  nothing sequenced them: whichever response arrived last painted the map,
  regardless of which viewport, scenario or attribute the user had asked for. Each
  run now carries a monotonic ticket that is checked after every await, and
  superseding a run aborts the requests it no longer needs.

  A shared-request primitive replaces two hand-rolled promise caches. It shares one
  in-flight request per key, cancels it when nothing wants it, and counts
  subscribers — so one pane navigating away cannot cancel a request the other
  eleven are waiting on.

  The choropleth request count is deliberately unchanged: the existing cache
  already deduplicated those across panes. What changed there is that superseded
  requests are now cancelled rather than merely ignored, which frees the
  connection instead of leaving both ends busy.

- **A transient server error was cached as "no data" for a full minute.** The
  choropleth cache stored a promise that swallowed its own errors and resolved to
  `null`, so a single 500 response left the map blank for the whole 60-second TTL
  even after the server recovered. Rejections are no longer cached.

- **The choropleth is served as vector tiles instead of a GeoJSON source.** The tile
  pipeline already carried the catchment polygons — `gpkg_to_mbtiles.sh` tiles
  `catchments_lev12` alongside the basemap layers — but the layer users actually look
  at was not using them. It refetched the same geometry as GeoJSON on every viewport
  change and handed it to `setData`, so every pan paid for a fresh parse, tessellation
  and GPU upload, once per map instance, twelve instances live in grid view.

  From the tiled zoom range up, geometry now comes from the tiles: MapLibre fetches and
  tessellates each tile once and reuses it for every later pan, zoom and indicator
  change. The values are fetched separately from the new geometry-free
  `GET /api/catchment-values` and joined onto the tiles as feature state, which is why
  switching indicator no longer moves geometry at all.

  | one viewport's payload, 5,000 catchments, modelled at the ~1.5 KB/catchment the server records | raw | gzip (level 5) | main-thread `JSON.parse` |
  |---|---:|---:|---:|
  | `/api/choropleth` GeoJSON | 7,810,860 B | 2,448,201 B | 79.2 ms |
  | `/api/catchment-values` | 146,017 B | 55,494 B | 0.53 ms |

  Colouring is unchanged: the same data-driven `fill-color` expression, evaluated on the
  GPU, with no per-feature JavaScript. Only where the expression reads a catchment's
  value from differs — feature properties on the GeoJSON path, feature state on the tile
  path — and the two are asserted to be identical expressions bar that accessor.

  Below the tiled zoom range nothing changes: the server returns grid-aggregated cells
  there, which have no tiled equivalent, and the GeoJSON path still serves them. The
  choice is made from the served TileJSON, so a datapack whose tiles predate catchment
  tiling stays on the GeoJSON path at every zoom rather than rendering nothing.

- **The browser stored three to eight times more than it needed to, and rewrote all
  of it on every save.** A user's sites live in their browser — that is the design
  brief — so this is the system of record, not a cache. Three things made it
  expensive, and they had one cause: everything lived in a single `dt-sites` blob.

  Sites are now stored one record per site, so a save touches one record:

  | parse + serialise per save | |
  |---|---:|
  | the whole store, as it was | 38.8 ms |
  | the largest single record | 14.8 ms |
  | a typical record (65,691 B) | **0.51 ms** |

  The full per-catchment breakdown is no longer persisted at all. At 27–56 KB per
  catchment against a ~5 MB quota, a site of 90–185 catchments filled the browser on
  its own — and it is not the client's to hold: the server computes it, and
  `getSiteCatchments` already refetched it behind a 30-second cache whenever it was
  missing. It now goes to that cache and never to disk.

  `catchmentIds` was also stored twice, once on the site and once inside
  `indicators`. For the Africa walkthrough those were byte-identical arrays of
  147,837 IDs — 3.84 MB of a 4.0 MB document.

  | stored bytes, walkthrough documents as representative sites | before | after | |
  |---|---:|---:|---:|
  | 7 catchments | 455,923 | 65,691 | −86% |
  | 2 catchments | 168,539 | 57,879 | −66% |
  | 11 catchments | 374,388 | 78,448 | −79% |
  | the 147,837-id site | 4,026,496 | 2,104,598 | −48% |
  | **total** | **5,025,346** | **2,306,616** | **−54%** |

  `lib/siteStore.ts` owns the format and migrates an existing blob on first read,
  normalising as it goes so an old record cannot resurrect either the breakdown or
  the duplicated ID list. If any record fails to write the blob is left alone, so a
  full quota cannot lose data. Five places that read the whole list to change one
  site now call `saveLocalSite`.

- **No API response was compressed.** Searching the server for compression found
  exactly one hit — the tile handler, where MBTiles blobs are already gzipped on
  disk and the header merely declares it. GeoJSON is close to a best case for
  deflate, and the full-Africa choropleth against the real datapack is 5,760,913
  bytes.

  Responses are now gzipped in server mode. Measured on that payload:

  | | bytes | ratio |
  |---|---|---|
  | before | 5,760,913 | — |
  | after | 1,794,404 | **3.21x** |

  `/api/columns` goes from 16,642 to 2,779 bytes (6.0x). The compression level was
  chosen by measurement rather than by default: level 1 gives 2.78x for 100ms of
  CPU and level 9 gives 3.25x for 294ms, but the level here has to beat nginx's
  existing `gzip_comp_level 6` — which produced 1,810,329 bytes — because nginx
  passes a body through untouched once `Content-Encoding` is set. Level 5 does, at
  230ms, with the remaining levels buying under 2%.

  Small responses (below the 1024-byte threshold, matching `gzip_min_length` in
  `deployments/nginx.conf`), already-encoded responses such as tiles, and
  non-text content types are left alone. A test asserts the two thresholds agree.

  **Not applied in desktop mode**, deliberately: the desktop build binds loopback
  and opens its own WebView onto it, so there is no bandwidth to save and
  compressing the choropleth would spend 230ms of CPU per request to speed up a
  transfer that already takes milliseconds.

### Fixed

- **A datapack install mutated the live server from a background goroutine, with no
  lock held.** It reassigned the tile store, the geopackage store, the site store,
  two config directories, the router and the running `http.Server`'s `Handler` —
  one field at a time — while request goroutines were reading them. That was three
  faults at once: a data race on every field; a nil dereference, because the stores
  were set to nil first and the tile handler called `GetTile` on whatever it found;
  and a torn update, because a request arriving mid-swap could see the new tile
  store alongside the old data directory.

  Everything that changes together is now one immutable value published with a
  single atomic store. A request reads the pointer once and works from a consistent
  snapshot for its whole life, so a swap cannot be observed half-applied. The
  replaced stores are closed after a grace period rather than immediately, so a
  request already using them finishes against the data it started with.

  Specifics:

    - `handleTileRequest` checks for a missing store and answers **503 with
      `Retry-After`** instead of dereferencing nil. Removing that check makes the
      test suite panic with `invalid memory address or nil pointer dereference` —
      the original crash, reproduced.
    - The running server's `Handler` is never reassigned. `net/http` reads it for
      every connection it accepts, so that assignment was itself a race; the
      handler installed at startup reads the current router through an atomic
      pointer instead.
    - The three `http.Dir` file servers for images, walkthroughs and demo assets
      resolve the data directory **per request**. They were rooted at startup, so
      after an install they served the replaced datapack's files, or nothing if
      that directory had been removed.
    - The auxiliary tile listeners are started once at boot and were never
      revisited by a route rebuild, so their tile route was missing entirely when
      no datapack existed at startup and stale afterwards. The route is now
      registered unconditionally and resolves the current store per request, so
      there is nothing left for a rebuild to fix.
    - The style-JSON cache no longer reassigns a `sync.Once` to invalidate itself —
      which was done from a request goroutine while others could be inside `Do`,
      and which `sync.Once` must never have done to it. A mutex and an explicit
      valid flag say the same thing; a failed build is still not cached, so one
      missing file does not make the style unloadable until restart.

  Twelve tests, run under `-race`, cover concurrent tile requests during a store
  swap, concurrent routing during a rebuild, and concurrent style requests
  interleaved with invalidation.

- **Concurrent indicator saves lost each other, and site writes were not atomic.**

  Every write is a read-modify-write — load the JSON, change part of it, write the
  whole thing back — with no lock. Two concurrent requests both read the original,
  and the second write silently discarded the first: a user editing indicators in
  two panes lost one panel's recalculation, with nothing anywhere saying so. A test
  reproduces it on the first attempt: `title="after" description="before"`.

  Writes are now serialised per site, so unrelated sites do not wait on each other.
  The lock is exported as `LockSite`, because the read-modify-write that matters is
  not in the store: the indicator handler loads a site, recalculates cascading
  targets across a hundred lines, and writes it back — locking only inside `Update`
  would have left that cycle unprotected.

  Separately, every write used `os.WriteFile`, which truncates the destination
  before writing. A crash, a full disk or a power loss in between left an empty
  file — losing the whole site rather than one edit. Site files, thumbnails and
  `settings.json` are now written to a temporary file in the same directory,
  flushed, and renamed over the target, so a reader sees either the old contents or
  the complete new ones. Against the old code a reader polling during rewrites
  caught it directly: `read a partial site file (0 bytes)`.

- **The dissolved-catchment area was always zero.** `polyclipPolygonToGeoJSON`
  returned a hardcoded `0`, `DissolveCatchments` passed it through unchanged, and
  the API handed it to the frontend — so the `area` field in every dissolve
  response has been 0 since the function was written.

  It is computed with a spherical-excess formula over the WGS84 authalic radius,
  in km², subtracting holes. Neither existing helper was usable: `signedRingArea`
  is a planar shoelace whose unit is degrees², and `calculatePolygonArea` converts
  degrees² to km² by assuming a degree of longitude is 111 km everywhere, which
  overstates east-west distance by up to 20% across this dataset's latitude range.
  That one is left where it is, because the AOI-overlap code divides one of its
  results by another and a consistent bias cancels.

- **A panicking grid-geometry worker hung every later low-zoom request.** The
  dissolve workers had no `recover()`, unlike the two other polyclip call sites in
  the same file, and a panic there did not merely lose a cell: the goroutine died
  without sending, so `wg.Wait` never returned, the results channel was never
  closed, and the tier's ready channel never closed either. Requests block on that
  channel with no timeout, so every subsequent low-zoom request blocked forever,
  accumulating goroutines until the process died.

  The workers now recover per cell; the build closes every tier's channel from a
  `defer`, so an early return or a panic cannot leave anyone waiting; closing is
  idempotent, so the failure path cannot panic on a channel that already closed;
  and a tier that failed is recorded and reported rather than serving an empty map
  that looks like a study area with no catchments in it. A partial failure leaves
  tiers that already built still serving.

  The wait itself is now bounded three ways — the ready channel, the request's
  context, and a 60-second timeout — so a client that goes away, or a build that is
  simply never going to finish, ends the wait instead of holding a goroutine.

- **An unrouted `/api` path answered 200 with the SPA's HTML.** A client asking for
  an endpoint that does not exist — or one gated to the desktop build — got a page
  it could not parse and no indication anything was wrong. Unmatched `/api` paths
  now return a JSON 404.

### Security

- **The server bound every network interface while claiming it bound only localhost.**
  `Addr: fmt.Sprintf(":%d", port)` listens on `0.0.0.0`, and the comment three lines
  below asserted the opposite — then used that false claim to justify disabling
  `WriteTimeout` entirely. Every endpoint is unauthenticated, so on a desktop install
  this published the whole API, including the routes that write to disk, to everyone
  on the user's network. The three auxiliary tile listeners did the same, and set
  neither a read nor a write timeout.

  The bind address is now `config.Config.BindAddress`, defaulting to `127.0.0.1` for
  every build, with `--bind` (or `DT_BIND`) to change it. The container deployment
  passes `--bind 0.0.0.0` explicitly, which is safe there because the `app` service
  only `expose`s its ports on the Docker network and Nginx is the single way in.
  Verified with `ss -tlnp`: the default now shows `127.0.0.1` on the main port and all
  three auxiliary ports.

  All three timeouts are set on every listener. `WriteTimeout` is bounded on its own
  merits rather than on the old false premise: datapack extraction, the original
  reason for disabling it, answers 202 immediately and reports progress through
  `/api/datapack/status`, so no handler blocks on it. The two handlers that genuinely
  stream a large file lift their own deadline with `http.NewResponseController`
  instead of leaving every request unbounded.

  Also fixed in passing: the port probe now binds the interface it is about to use,
  rather than answering a different question, and `--help` for `run-app.sh` derives
  its line range instead of hardcoding it — adding these knobs to the header had
  silently truncated the Options section.

- **The hosted deployment exposed an unauthenticated write-to-disk API that nothing
  called.** A user's own sites belong in their browser, and the client honours that: in
  browser runtime every site create, read, update and delete goes to the `dt-sites`
  localStorage key, with no fallthrough to the API. The server registered the site CRUD
  for everyone anyway, and nginx proxies every path.

  Nine site routes plus `POST /api/datapack/install` are now registered **only** in the
  desktop build, gated on `config.Config.DesktopMode`. Seven of the nine reach
  `sites.Store` Create/Update/Delete; two are reads that disclosed every site on the
  host; `datapack/install` replaced the contents of the data directory with whatever it
  found at a caller-supplied path. In server mode they are absent from the route table
  entirely, so no handler code is reachable.

  This was the door behind two other reported faults — arbitrary file deletion via a
  thumbnail path, and the datapack install — which is why it is recorded here rather than
  under *Fixed*. The routes a browser session genuinely calls (`/indicators`,
  `/catchments`, `/whiskers`, `/dissolve-catchments`, `/boundary/*`) are unchanged and
  stay public: they take `runtime: "browser"` with the site in the request body and
  return before touching the store.

  The gate depends on `--headless`, which is a launch flag rather than code, so a test
  asserts that `deployments/Dockerfile` and `deployments/docker-compose.yaml` still pass
  it. `docs/developer-guide/client-server-boundary.md` now states the persistence split
  alongside the computation split it already covered — the gap that let this drift.

- **A thumbnail path from the client could delete any file the process could reach.**
  `Store.Update` stored the string verbatim and `Store.Delete` later joined it onto the
  data directory and called `os.Remove`, guarded only by a `/data/images/` prefix check
  that `/data/images/../../etc/passwd` satisfies. The `os.Remove` error was discarded, so
  nothing was logged either. Paths are now validated against the only shape the store
  writes, on write and again on delete, and resolved through `filepath.Rel` rather than a
  string prefix.

- **A file dialog could be opened on the host's desktop by an HTTP request.**
  `POST /api/dialog/open-file` called `zenity.SelectFile`, which opens a native picker on
  whatever session the process is attached to and blocks until a human answers, holding a
  goroutine meanwhile. It is now desktop-only, and bounded by a two-minute timeout tied to
  the request context.

- **No request body size limits on any JSON handler**, with nginx passing bodies up to
  2 GB, so one POST could make the process buffer two gigabytes. Every request is now
  capped — 1 MiB by default, 32 MiB for the handlers carrying geometry or an inline image
  — and `client_max_body_size` drops to `40m` to match, with a test asserting the
  application limit stays below the proxy's.

- **A TLS private key was committed** because `certs/` was commented out in
  `deployments/.gitignore`. The pattern is active again, alongside `*.key`, `*.pem`,
  `*.crt`, `*.p12` and `*.pfx`, and secret scanning runs in pre-commit and CI.

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
