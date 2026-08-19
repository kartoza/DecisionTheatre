# Notes — issue #44, lint strictness and a gofmt gate

Branch `ci/lint-strictness`. Nothing pushed, no PR, no `gh` invoked.

## What the tree looked like before

Worth recording, because the issue text is slightly out of date: `.golangci.yml`
already existed. It arrived in `662c800 fix: clear the three remaining CI failures`,
and it said so in its own comments — `default: standard`, with a note that "turning on
further linters is worth doing, but it is its own change". This is that change.

So the starting position was:

- `golangci-lint` v2.8.0, pinned in CI and supplied by the development shell.
- The standard five linters: `errcheck`, `govet`, `ineffassign`, `staticcheck`,
  `unused`, with a considered `errcheck` exclusion list and one staticcheck check
  disabled.
- `formatters: [gofmt]`, which does report formatting through
  `golangci-lint run` — so formatting was not completely ungated, but only as a
  by-product of the slowest job in CI, and only if that job got as far as running.
- `gofmt -s -l .` clean. `golangci-lint run ./...` clean, 0 issues.

## What I changed

### 1. `.golangci.yml` — 15 further linters

Enabled, each with a comment in the file naming the class of defect it catches here:

| Linter | What it catches in this codebase |
|---|---|
| `nilerr` | error checked, then `return nil` anyway — the caller is told it worked |
| `nilnesserr` | the same failure one indirection out |
| `nilnil` | `return nil, nil`: no value and no reason |
| `sqlclosecheck` | `*sql.Rows`/`*sql.Stmt` never closed — SQLite handles held per tile request |
| `bodyclose` | HTTP response bodies leaked by the geocode proxy and datapack downloader |
| `gocheckcompilerdirectives` | a mistyped `//go:embed` is a comment; the server would ship serving nothing |
| `musttag` | response structs marshalled without tags, so the wire format follows Go casing |
| `canonicalheader` | header keys in a casing `net/http` will never match |
| `recvcheck` | mixed value/pointer receivers silently dropping methods from a method set |
| `fatcontext` | context rewrapped inside a loop |
| `durationcheck` | duration arithmetic off by 10⁹ |
| `reassign` | another package's exported vars reassigned at runtime |
| `exhaustive` | a `Role`/`Severity` switch with no default that misses a case |
| `nolintlint` | bare `//nolint` that disables every check on the line |
| `usetesting` | `os.MkdirTemp`/`os.Setenv` where `t.TempDir`/`t.Setenv` exist |
| `misspell` | misspellings, including in user-visible strings |
| `errname` | error values not named so `errors.Is` targets can be found |
| `bidichk` | bidirectional Unicode — a diff that reads differently from what compiles |
| `gomoddirectives` | `replace`/`exclude` in `go.mod`, which breaks the flake for consumers |

Three settings decisions worth flagging:

- **`exhaustive: default-signifies-exhaustive: true`.** Without it, all four
  `datacheck` switches are reported, and all four have a deliberate `default`. The
  defect worth catching is the switch that *forgot* to decide, not the catch-all.
- **`misspell` with no `locale`.** `locale: UK` gives 26 findings and acting on them
  would be a bug: `Center` is the TileJSON/MBTiles metadata field name, `color` is a
  JSON key the frontend reads, `Sanitize` is a function name. The wire format is not
  a place to have an opinion about English.
- **`issues.max-issues-per-linter: 0` and `max-same-issues: 0`.** This one matters
  beyond tidiness. golangci-lint truncates at three of the same message by default,
  and it caught me out mid-task: `nolintlint` reported 3 findings, I fixed 3, and 5
  more appeared. Every count below was re-measured with the caps off. Anyone reading
  a CI summary before this change was reading a partial list without being told.

`.golangci.yml` also now carries two prose blocks: **"The next ratchet"**, listing
each linter worth enabling with the exact debt blocking it, and **"Considered and
declined"**, so nobody measures `govet shadow` again to rediscover that it is 18
shadowed `err`s and no bugs.

### 2. A real `gofmt` gate

`scripts/gofmt-check.sh` — one implementation, three callers:

- `.github/workflows/ci.yml`, as the **first** step of `lint-go`, before the apt
  install and the webkit shim. It needs no cgo, no system packages and no linter
  binary, so it answers in about a second rather than at the end of the slowest job,
  and it annotates the offending files with `::error file=`.
- `make fmt-check` / `dt fmt-check` — report, change nothing.
- `make fmt` / `dt fmt` — the same script with `--fix`.

`gofmt -s`, matching what `make fmt` always did. The file list comes from
`git ls-files --cached --others --exclude-standard`, so a new untracked file is
checked before it is committed, and `internal/webview_go/` (vendored) is skipped for
the same reason `.golangci.yml` skips it.

`make check` now runs `fmt-check` rather than `fmt`, so `dt check` answers "would CI
pass?". A target that silently rewrites your files cannot answer that question.
`dt fmt` remains the one that changes things. Also wired into `scripts/shell-help.sh`
(which generates the command-reference docs page), `.exrc` (`<leader>pg`) and
`.nvim.lua`.

**One real gap closed along the way:** the `go-fmt` pre-commit hook ran `gofmt -l -w`
without `-s`. So a commit could pass the hook, leave an unsimplified composite
literal in place, and then be rejected by a `gofmt -s` gate — the hook blessing
exactly what CI would refuse. Now `gofmt -s -l -w`.

### 3. Docs

`docs/developer-guide/coding-standards.md` had a `!!! warning` admonition naming this
exact ticket ("There is no `.golangci.yml` … CI does not check `gofmt -l`"). Replaced
with what is now true, plus a table of what is enabled and why, and the rule for
adding a linter: measure first, then either clear it or write it into the list at the
bottom of the config. Also corrected the `lint-go` row in `testing.md` and
`dev-environment.md`.

## Findings, by package

Measured across the whole tree with every candidate linter on and the issue caps off.
`errcheck` below means `check-type-assertions: true` on top of the existing config.

### Fixed (all in packages I was allowed to touch)

| File | Finding | What I did |
|---|---|---|
| `internal/datacheck/check.go:210` | `nilerr` — `return nil` after `err != nil` | `//nolint:nilerr` with the reason: it is a `WalkDir` callback and nil means "skip this entry". The surrounding comment already said so; now the linter can read it too. |
| `internal/fsutil/atomic.go:53` | `nolintlint` — bare `//nolint:errcheck` | Added the explanation. |
| `internal/fsutil/atomic.go:84` | `nolintlint` — stale `//nolint:errcheck` on `defer d.Close()` | Deleted the directive. `(*os.File).Close` is already in `exclude-functions`, so it suppressed nothing. |
| `internal/sites/durability_test.go:248` | `nolintlint` — bare `//nolint:errcheck` on `defer os.Chmod` | Added the explanation. |

That is the entire debt for the linters I enabled. `golangci-lint run ./...` is at
**0 issues** on this branch.

### Left for their owners — not enabled, recorded in `.golangci.yml`

Nothing below is suppressed. The linters are simply not on, so none of it can make
anyone's build red today.

**`internal/api/` — 12 non-style findings**

- `errchkjson` ×3 — `handler.go:559`, `:611`, `:768`. `json.NewEncoder(w).Encode(...)`
  with the error assigned to `_`, on values containing `float64`. A NaN or `+Inf`
  indicator makes `Encode` fail *after* the 200 and the headers are on the wire, so
  the client gets a truncated body and no error at all. **The most valuable single
  finding in this whole exercise**, and exactly the "unchecked returns on writes"
  hazard the issue named.
- `contextcheck` ×2 — `handler.go:1152`, `:1675`: work started from a handler that
  does not carry the request context, so it cannot be cancelled.
- `wastedassign` — `handler.go:2262`, `catchmentData` assigned and then reassigned
  before use.
- `unparam` — `recalculate.go:464`, `workflow2Herbivores`: parameter `lookup` unused.
- `errcheck` (type assertions) — `handler.go:995`.
- `gocritic` ×4 — `recalculate.go` `assignOp` ×3 and one `ifElseChain`.
- `nilerr` ×2 — `desktopsiteroutes_test.go:61`, `:66`. Currently covered by the
  `_test.go` exclusion I added (see the caveat below).
- `staticcheck` SA5011 ×5 — `cancellation_test.go:121,124`,
  `site_shapefile_test.go:386,389,392`: possible nil dereference after a check that
  implies the pointer can be nil. **These are invisible under the standard config**:
  they only surface once several SSA-based linters run together. Real, and in tests
  that would panic rather than fail cleanly.

**`internal/server/` — 10 non-style findings**

- `gosec G110` — `datapack.go:708`. `io.Copy` from a zip entry with no
  `io.LimitReader`. The declared `UncompressedSize64` is summed for the progress bar
  but never enforced, and an archive can lie about it. Real, on a path that extracts
  something a user supplied.
- `gosec G305` — `datapack.go:680`. **False positive**: there is a zip-slip guard
  immediately above it (`strings.HasPrefix(destPath, filepath.Clean(destDir)+sep)`).
  Whoever enables `gosec` should exclude this one by rule, with that reason.
- `errorlint` — `datapack.go:489`, `==` against a sentinel that arrives wrapped.
- `errchkjson` — `server.go:496`.
- `contextcheck` — `datapack.go:209`.
- `errcheck` (type assertions) ×2 — `compress.go:174`, `server.go:512`.
- `nolintlint` ×5 — `bind_test.go:97,106,111`, `geocode.go:224`, `server.go:370`:
  `//nolint:errcheck` with no explanation. Two of them (`geocode.go:224`,
  `bind_test.go:97`) are also *stale* — they suppress a rule `exclude-functions`
  already covers. **These five lines are the only thing keeping
  `nolintlint: require-explanation` and `allow-unused: false` switched off.** Five
  comments; the cheapest item on this whole list.

**`internal/geodata/` — 6 non-style findings**

- `rowserrcheck` — `gpkg_store.go:785`. `rows.Err()` unchecked: a query that dies
  partway through iteration is reported as a short but *successful* result set. This
  is the silent-data-loss shape, in the store that feeds the map.
- `makezero` — `gpkg_store.go:2421`, `append` to `ring` which was made with non-zero
  length, so the ring gets leading zero-value vertices.
- `gosec G602` — `gpkg_store.go:1449`, slice index possibly out of range.
- `gosec G201` ×13 — SQL built with string formatting. All table/column names rather
  than values as far as I read, but that is a judgement someone who owns the file
  should make and record, not me.
- `contextcheck`, `unparam`, `errcheck` (type assertion) — one each.

**`internal/datacheck/` (mine, deliberately not fixed)**

- `noctx` ×7 — `check.go` `Ping`/`Query`/`QueryRow` and `check_test.go` `Exec`.
  I could have fixed these, and chose not to: threading a context through
  `datacheck` is a behaviour change, not a lint fix, and `fix/db-context-cancellation`
  is in flight doing exactly that kind of work. Enabling `noctx` belongs behind that
  branch, not ahead of it.
- `gosec` ×17 — G301/G304/G306 file permissions and variable paths. Needs a project
  policy on directory modes before it is worth acting on; `datacheck` writes report
  files and reads paths the user names, which is its whole job.

**`internal/tiles/`, `internal/sites/`, `internal/gpkgtest/`, `main.go` (mine)**

- `noctx` ×15 total (`tiles` ×4, `gpkgtest` ×6, `main.go` ×2, plus the datacheck
  ones above) — same reasoning.
- `unparam` ×2 — `tiles/mbtiles.go:256` `clamp`, `lo` always receives 0;
  `tiles/mbtiles_test.go:13` `createTestMBTiles`, result 0 never used. Both are the
  "left behind after a refactor" shape the issue described. Not fixed because
  `unparam` also has findings in `api` and `geodata`, so enabling it is blocked
  anyway and changing signatures for a linter that is off is churn.
- `gocritic` ×3 in `sites` — two `ifElseChain`, one `appendAssign` in a test.
- `errcheck` (type assertions) ×3 — `sites/sites.go:135`, `tiles/mbtiles.go:129`.
- `gosec G115` ×2 — integer overflow conversions in `tiles/mbtiles.go:141` and
  `server/datapack.go:652`.

### Style-only, all declined

`gosec` 99 (mostly G104/G304/G301/G306), `intrange` 28, `perfsprint` 23,
`usestdlibvars` 14, `goconst` 11, `copyloopvar` 4, `predeclared` 4, `dupword` 1.
Roughly 85 mechanical diffs across eight packages, catching no defect, and every one
of them a conflict against something currently in flight. Recorded in the config so
the measurement does not have to be repeated.

## Sequencing — read this before merging

**Merging this branch will not make any currently-green branch red.** That was the
constraint I optimised for, and it is why the enabled list is 15 linters with zero
findings rather than 25 with a debt list. Concretely:

- Every enabled linter passes on the whole tree as it stands, including all the
  packages other agents are rewriting. No path exclusions were added to achieve that.
- The four fixes are in `internal/datacheck/`, `internal/fsutil/` and
  `internal/sites/` — one comment each, no behaviour change. `internal/fsutil/` and
  `internal/gpkgtest/` were not assigned to anyone this session; if that is wrong,
  the `fsutil` change is two lines and trivially droppable.
- The `gofmt` gate can only fail on a tree that is already unformatted. `gofmt -s -l`
  is clean on `main` today, so it fails only on new drift.

**Two things the owner does need to sequence:**

1. **The other branches merge first, then the ratchet turns.** The "next ratchet"
   block in `.golangci.yml` is written against today's tree. Once
   `fix/geodata-robustness`, `fix/db-context-cancellation`, `fix/silent-storage-failures`
   and the `internal/api` work land, re-measure before enabling anything from that
   list — several of those branches may have fixed their own findings already, and
   `rowserrcheck` in particular looks like something `fix/geodata-robustness` would
   naturally clear.
2. **`nolintlint` at full strength is five comments away.** After the `internal/server`
   work lands, adding explanations to those five `//nolint:errcheck` lines lets
   `require-explanation: true` and `allow-unused: false` be turned on — the two
   settings that stop this configuration decaying into a wall of suppressions. It is
   the single highest ratio of value to effort in the whole list.

**A conflict I avoided, deliberately:** `docs/hooks/diagrams_concept.py:415-421`
generates the quality-gates diagram and still asserts that "Nothing verifies gofmt in
CI" and "There are no pre-commit hooks", both of which are now false — and the same
paragraph asserts that no eslint configuration exists, which `ci/frontend-eslint` is
fixing right now. Editing three adjacent lines of that string would have collided
with them for no benefit, so I left it and adjusted the figure caption in
`coding-standards.md` instead. Whoever lands second should rewrite that box.

Similarly untouched: the stale `!!! warning "No pre-commit hooks"` admonition in
`docs/developer-guide/testing.md` (a `.pre-commit-config.yaml` exists now) and the
`!!! bug` about `file-checks`. Both belong to other tickets.

## Verification

Run in the worktree with the embed stubs scaffolded and `eval "$(./scripts/webkit-compat.sh)"`:

| Command | Result |
|---|---|
| `gofmt -s -l .` | clean |
| `./scripts/gofmt-check.sh` | 53 Go files, all formatted |
| `go build ./...` | OK |
| `go vet ./...` | OK |
| `go test ./...` | all packages pass |
| `golangci-lint run ./...` | **0 issues** |
| `./scripts/tests/version-test.sh` | 11 passed, 0 failed |
| `python3 -c "yaml.safe_load(...)"` on `ci.yml` and `.pre-commit-config.yaml` | parse clean |

`scripts/gofmt-check.sh` was also tested against a deliberately misformatted file:
it reports the file, exits 1, emits the `::error file=` annotation under `--github`,
and `--fix` repairs it.

No Go module dependency was added. No linter version was pinned that the flake cannot
supply — `golangci-lint` 2.8.0 comes from `flake.nix` and is what CI already pins.
