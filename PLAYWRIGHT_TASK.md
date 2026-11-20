# Tonight's task: Playwright E2E suite + `dt playback`

Scoping notes for implementing overnight task #4 from 2026-09-30: "write the
most comprehensive possible Playwright test suite for the site and give me a
`dt playback` command that will play a video of the last test suite run
through and give me a `dt` command to run the suite."

Not started yet. This file is the plan; implement against it directly rather
than re-deriving scope from scratch.

## Why Playwright, not the CDP harnesses already in the repo

This session built several zero-dependency CDP scripts (`scripts/
map-load-timeline.mjs` and throwaway scratchpad scripts) as a way to measure
and click without adding a dependency. Those stay — they're benchmarking
tools, not test suites. Playwright is a different, explicit ask: a real test
runner with retries, trace/video capture, assertions, and a `dt playback`
story that CDP scripts don't give you for free. Don't try to unify them.

## Dependency sourcing (per global CLAUDE.md priority order)

1. **Check nixpkgs first**: `playwright-driver`, `playwright-driver.browsers`,
   and the `playwright` Python/Node packages all exist in nixpkgs. The
   standard nix pattern for Playwright is:
   ```nix
   playwright-driver = pkgs.playwright-driver;
   # in shellHook or an app's env:
   PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
   PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
   ```
   This avoids Playwright's own browser-download step entirely (which would
   otherwise reach out to an external CDN mid-build/mid-test — exactly what
   the "never invoke npm" / nix-first rule exists to prevent).
2. The npm package itself (`@playwright/test`) still needs to land in
   `frontend/package.json` + `package-lock.json` for `import { test, expect }
   from '@playwright/test'` to resolve. **Per session memory, never run `npm`
   commands** — hand-edit `package.json` and `package-lock.json` directly
   (add the dependency entry and its lockfile subtree). If the lockfile
   entry can't be hand-authored confidently, flag it back rather than
   guessing a hash.
3. Confirm the nixpkgs version of `playwright-driver` and the npm
   `@playwright/test` version are compatible (nixpkgs pins a specific
   Playwright version; the npm package version must match exactly or the
   driver/browser pairing breaks). Check `pkgs.playwright-driver.version`
   in the pinned nixpkgs revision before choosing the npm version.

## Where it lives

New top-level directory, `e2e/` (sibling to `frontend/`, not inside it —
these tests drive the built app over HTTP, they are not frontend unit
tests and don't belong under `frontend/src`):

```
e2e/
├── playwright.config.ts     # baseURL, video: 'on', trace: 'retain-on-failure'
├── fixtures/
│   └── server.ts            # spins up a real decision-theatre --headless
│                             # server against a test data pack, tears down
│                             # after the run — mirrors how dtbench.py and
│                             # map-load-timeline.mjs already launch servers
├── tests/
│   ├── explore.spec.ts
│   ├── site-creation.spec.ts
│   ├── identify.spec.ts
│   ├── debug-overlay.spec.ts
│   ├── views.spec.ts        # grid/quad/dial/table/belt-chart switching
│   ├── compare-swiper.spec.ts
│   └── tours.spec.ts
└── test-results/            # gitignored — videos, traces, screenshots
```

## Coverage scope ("most comprehensive possible", scoped to what exists)

Derive the flow list from `SPECIFICATION.md`'s feature sections and
`frontend/src/components/` rather than guessing. At minimum:

- **Explore mode**: landing page → explore, map loads and renders a
  choropleth, zoom/pan, scenario switch, attribute switch, range mode
  (Full/Visible/Custom).
- **Site creation**, all methods mentioned in the codebase
  (`SiteCreationMap.tsx` / the method-selection cards) — catchment-click
  selection, draw-polygon, address search, coordinate entry (whichever
  subset actually exists — read the component, don't assume).
- **Identify tool**: click a catchment at a detail zoom and at a coarse
  zoom (lev12 vs lev04/06/08 — this is the exact regression fixed earlier
  tonight, a test here would have caught it), dock opens with the right
  granularity label, highlight renders.
- **Debug overlay** (`dt serve-debug` equivalent — launch the test server
  with `--debug-overlay`): wrench toggle shows/hides it, info box shows
  live zoom/band, catchment outlines + labels render.
- **View switching**: grid/quad/dial/table/belt-chart, pane add/remove up
  to each view's cap (the belt-chart 15-pane ceiling, the 6-pane cap on
  map/dial/table — see CHANGELOG's "Grid view no longer overflows" entry
  for the exact caps to assert against).
- **Compare swiper**: toggle on, drag, scenario-vs-scenario rendering.
  single-map mode still renders correctly (regression surface from
  tonight's "single-map mode no longer downloads the scenario it isn't
  showing" fix).
- **Guided tours**: the four explore tours + the onboarding tour, "Skip
  tour", last-step CTAs ("Back to main page" / "Create a site").
- **Control panel collapse/expand**: chevron round-trip, Fitts's-law
  position check if feasible (collapse and expand chevrons at matching Y).
- **`--legacy` mode** (tonight's new flag): launch a second fixture server
  with `--legacy` and assert catchments render at a low zoom using real
  lev12 geometry rather than a blank/aggregate choropleth — direct coverage
  for the feature just shipped.

Explicitly out of scope unless trivial: desktop-webview-specific behavior
(`webview.go`, `DT_WEBVIEW_DIAG`) — Playwright drives a real browser, not
WebKitGTK, so anything gated on `window.__DECISION_THEATRE_WEBVIEW__` needs
either a page-init script stub or a documented skip.

## Test data

Needs a small, fast, checked-in fixture data pack (not the production
multi-GB pack) so `dt test-e2e` is fast enough to run routinely. Check
whether `internal/gpkgtest` (used by the Go test suite) or a trimmed
`data/` subset can be reused/exported rather than building a third data
generation path.

## Wiring (mirror the `serve-debug` pattern exactly)

- `Makefile`: add `test-e2e` and `playback` to the `.PHONY` line, plus
  targets:
  ```make
  test-e2e:
  	cd e2e && npx playwright test $(ARGS)

  playback:
  	cd e2e && npx playwright show-report   # or: open the last run's video directly
  ```
- `scripts/shell-help.sh`: add entries alongside the existing
  `"RUN|dt serve-debug|..."` line, e.g.
  `"TEST|dt test-e2e|Run the Playwright end-to-end suite"` and
  `"TEST|dt playback|Play back the last E2E run's recorded video"`.
  This is the single source that drives `dt`, `make help`, `nix develop`'s
  greeting, and the generated `command-reference.md` table — one edit, not
  four.
- `flake.nix`: a `nix run .#test-e2e` app (`mkScriptTool`-style, matching
  `benchmark`'s pattern at the bottom of the file) so CI can run it without
  the dev shell, per this project's standard. Needs `playwright-driver` and
  `playwright-driver.browsers` in `runtimeInputs`, with
  `PLAYWRIGHT_BROWSERS_PATH` set in the script.
- `.nvim.lua`: add the matching whichkey entries under `<leader>p`, per
  project convention for every dt command.
- CI: same checks as local, wired the same way other checks are (see
  `checks.go-tests` / `checks.frontend-tests` in `flake.nix` for the
  pattern) — but E2E suites are usually too slow/flaky for a `nix flake
  check` gate; more likely a separate CI job, not a `checks.*` derivation.
  Decide and document the choice rather than silently skipping CI wiring.

## `dt playback`

"Play a video of the last test suite run" — Playwright's own `video: 'on'`
config (in `playwright.config.ts`) writes one webm per test into
`test-results/<test-name>/video.webm`. Two reasonable interpretations,
pick one explicitly rather than guessing silently:

1. Playwright's built-in HTML reporter (`npx playwright show-report`)
   already stitches results + embedded video playback into a browsable
   report — `dt playback` could just open that.
2. If the ask is literally "play the video" (not "show me a report"), find
   the most recent `video.webm` under `test-results/` (or the last failed
   test's, if the point is debugging a failure) and hand it to `xdg-open`
   — needs `xdg-utils` in the app's `runtimeInputs`, same as `benchmark`
   already does for its own report-opening step.

Given the phrasing ("play a video of the last test suite run through"),
lean toward (2) as the primary behavior, with the HTML report as a
`--report` flag or separate `dt playback-report` if both turn out useful —
don't build both unasked.

## Test plan for this task itself

- `dt test-e2e` passes clean on a fresh `nix develop` shell (no npm
  commands run by a human to get there).
- `dt playback` actually opens something after a run — verify by running
  the suite once and confirming the command works, not just that it's
  wired.
- `nix flake check` still passes (confirms the new flake additions don't
  break evaluation).
- Full existing Go + frontend suites stay green — this task only adds, it
  shouldn't touch existing app code.
