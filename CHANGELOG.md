# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
