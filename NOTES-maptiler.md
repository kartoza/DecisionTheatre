# MapTiler key — issue #31

Working notes for the code half of "Rotate the MapTiler API key committed to
source". The key is out of the tree and now comes from run-time configuration.
**It has not been rotated, and only the MapTiler account holder can do that.**

---

## 1. Every occurrence of the key

The key is written here as `cc4Ppmm…` — the first seven characters, which
is enough to pick it out of the list in the MapTiler console. The full
literal is deliberately not repeated in this file: it would put the secret
back into a tracked file and fail the repository's own gitleaks gate. Read
it from any of the historical commits listed below, or from the MapTiler
account itself.

### In the working tree, before this change (three, all now removed)

| File | Line | What it was |
|---|---|---|
| `internal/server/server.go` | 517 | `"https://api.maptiler.com/fonts/%s/%s.pbf?key=cc4Ppmm…"` — the only occurrence that was actually used |
| `resources/mbtiles/style.json` | 14 | `"glyphs": "https://api.maptiler.com/fonts/{fontstack}/{range}.pbf?key=…"` |
| `data/mbtiles/style.json` | 14 | byte-identical file (`diff` reports no difference) |

Both `style.json` files are **tracked**. `data/` is mostly gitignored, but
`.gitignore:72` carries an explicit `!data/mbtiles/style.json` exception, so that
copy is committed too. `git ls-files` confirms both.

After the change, grepping the tree for the key returns nothing outside this
file.

### In git history (permanent — not rewritten, as instructed)

`git log --all -S"<the key>"` finds seven commits:

| Commit | Date | File | Note |
|---|---|---|---|
| `cd698f3` | 2026-01-28 | `internal/server/server.go`, `resources/mbtiles/uow_tiles.json` | initial commit; the key has been public since day one |
| `aa38bd4` | 2026-02-16 | `data/mbtiles/style.json` | added |
| `3ac8333` | 2026-05-28 | `data/mbtiles/style.json` | deleted (also the commit that leaked `deployments/certs/tls.key`) |
| `e5f0ac7` | 2026-06-01 | `data/mbtiles/style.json` | re-added |
| `062ff0a` | 2026-05-26 | `internal/server/server.go` | moved during the performance rework |
| `d7cd03d` | 2026-08-19 | `internal/server/server.go` | **on `origin/ticket_174` only** — replaced the literal with `%s`; see §5 |
| `ceee4ea` | 2026-08-19 | `internal/server/server.go` | **on `origin/ticket_174` only** |

### Outside the repository

- **Every released binary.** The literal was compiled into `decision-theatre`,
  so every desktop package ever published contains it. `strings` finds it.
- **Every data pack.** `scripts/pack-data.sh` builds the pack from the local
  `data/` directory via `decision-theatre pack-data`, and `data/mbtiles/style.json`
  is part of what it packs. Every `decision-theatre-data-v*.zip` distributed so
  far carries the key.
- **The public GitHub repository**, in all of the above commits.

### Related, and already known

`.gitleaksignore` carried four fingerprints exempting these findings, with a
comment arguing the key was "public by design". That argument was wrong on its
own terms — the server proxies the glyph fetches, so the browser never saw the
key; it was disclosed by being committed. I rewrote that comment block to say so
and to record that the key must be revoked. The fingerprints stay: they pin
historical commits, which cannot be edited.

---

## 2. What the key actually does

Less than it looks like. MapTiler supplies **the fonts the map labels are drawn
with, and nothing else**. Vector tiles come from the local `.mbtiles` file,
catchment geometry from the local GeoPackage, every number in the interface from
the local data pack. The application is designed to run offline.

The browser never sees the key, before or after this change:

1. The client loads `/data/style.json`.
2. `handleStyleJSON` (`internal/server/server.go`) rewrites the style's `glyphs`
   field to `<base>/fonts/{fontstack}/{range}.pbf` — **unconditionally**, whatever
   the file on disk said. The style cache in `internal/server/state.go` holds the
   rewritten bytes.
3. The browser asks the server for glyphs; `handleGlyphProxy` fetches them from
   `api.maptiler.com` with the key attached, and caches them in-process.

So the key in the two `style.json` files was **dead data** — never served,
never used. Only `server.go` mattered. That is why there is exactly one
injection point now, and it is the proxy.

---

## 3. What changed

**`internal/config/config.go`**

- `Config.MapTilerKey` — new field, no default, nothing compiled in. Documented
  alongside `SatelliteTileURL`, which is the pattern this follows.
- `Config.MapTilerGlyphURL(fontstack, glyphRange) (string, bool)` — builds the
  upstream URL, returning `false` when no key is set. `fontstack` and `range`
  come off the request path and are now `url.PathEscape`d, so a crafted font
  name cannot append its own query parameters; the key is `url.QueryEscape`d.
- `ResolveMapTilerKey(flag, settings)` — flag, then `DT_MAPTILER_API_KEY`, then
  `settings.json`. Trims whitespace, because a key pasted into a `.env` or a JSON
  file picks up a newline easily and MapTiler rejects that exactly like a wrong key.
- `Settings.MapTilerKey` (`"maptiler_key"`, `omitempty`) — the only route
  available to a desktop install that was launched by double-clicking an icon.

**`internal/server/server.go`**

- The literal is gone; `handleGlyphProxy` asks `MapTilerGlyphURL` for the URL.
- No key ⇒ **no request is made at all**, one log line via `sync.Once`, and the
  same empty-`200` response the proxy already returns when the CDN is
  unreachable. See §4.
- `writeEmptyGlyphs` — the empty-`200` response was written out four times; now
  once, with the reasoning attached.

**`main.go`** — `--maptiler-key` flag; `config.LoadSettings()` now runs
unconditionally (it was inside an `if` that only cared about the data pack path)
so the saved key is read whether or not `--data-dir` was given.

**`resources/mbtiles/style.json`, `data/mbtiles/style.json`** — `glyphs` is now
the relative `/fonts/{fontstack}/{range}.pbf`, which is what the server rewrites
it to anyway. A `kartoza:glyphs` note in the style's `metadata` block says why,
and says not to put a key back — that file is copied into every data pack.

**Deployment and docs** — `DT_MAPTILER_API_KEY` in `deployments/.env.example`
and passed through `docker-compose.yaml` as an `environment:` entry (not a
`command:` flag: the compose file is tracked, and a flag is visible in `ps`).
Documented in `docs/developer-guide/server-deployment.md` (new variable section
plus a troubleshooting entry for "the map has no labels"),
`docs/advanced/install-the-application.md` (desktop, three ways),
`docs/developer-guide/api.md` and `SPECIFICATION.md`. `frontend/.env.example`
gained a comment saying the key must **not** go there, since every `VITE_`
variable is compiled into the bundle.

---

## 4. The judgement call: what happens with no key

**Chosen: start normally, disable glyph fetching, say so once.** Not "refuse to
start", and definitely not "send `key=` with nothing after it".

- Refusing to start would be wrong for what this application is. It is an
  offline desktop tool for a data pack; place labels on the basemap are a
  cosmetic layer over data that is entirely local. Making an optional font CDN
  a startup requirement would mean an existing user who upgrades gets an
  application that will not open.
- Sending an empty key would be the worst option and is what the naive fix does.
  MapTiler answers `403`, the proxy already swallows non-`200` into an empty
  response, and the operator sees a map with no labels and no clue that a
  setting is missing. `MapTilerGlyphURL` returning `(string, bool)` exists
  specifically to make that unrepresentable.
- The empty-`200` response is not new behaviour. It is exactly what the proxy
  already did when the machine had no internet, and MapLibre handles it: it
  treats it as "no glyphs in this range" and draws the map without those labels.
  An error status would make it retry.

The log line names all three places the key can be set:

```
Glyph proxy: no MapTiler key configured, so map labels will not be drawn.
Set DT_MAPTILER_API_KEY, pass --maptiler-key, or add "maptiler_key" to
settings.json. Everything else works without it.
```

Once per process, not per request — a single map pane asks for a dozen ranges
and grid view multiplies that by four.

---

## 5. ⚠️ Overlapping work already on the remote: `origin/ticket_174`

Found while searching history. **This needs a decision before either branch
merges.** `origin/ticket_174` (commits `d7cd03d`, `ceee4ea`, both 2026-08-19)
already removes the same literal from `server.go`, and goes further: it points
the satellite basemap at MapTiler too, with a request quota
(`internal/config/satellitequota.go`).

| | this branch | `origin/ticket_174` |
|---|---|---|
| Env var | `DT_MAPTILER_API_KEY` (renamed to match theirs) | `DT_MAPTILER_API_KEY` |
| Mechanism | `Config.MapTilerKey` field + `ResolveMapTilerKey` | package-level `config.MapTilerAPIKey()` reading `os.Getenv` at each call |
| Other sources | flag, `settings.json` | none |
| Scope of the key | glyphs only | glyphs **and** the satellite basemap style |
| `style.json` files | key removed | not addressed (still committed there) |

I named my variable `DT_MAPTILER_API_KEY` **to match theirs**, so whichever
merges first the operator-facing name is the same and the documentation stays
true. The Go APIs still conflict and `internal/server/server.go` will conflict
textually. My preference, for what it is worth: keep the `Config` field (it is
testable without touching the process environment, and it is the only shape that
can serve the desktop build's `settings.json`) and port ticket_174's satellite
work onto it. But this is the owner's call, and it is the one thing here I would
not decide alone.

---

## 6. 🔴 Handover — what only the account holder can do

### The one thing that matters

**Revoke the key beginning `cc4Ppmm` in the MapTiler console** (Account → API keys)
and issue a replacement. Removing it from the tree does not un-leak it: it is in
the public git history, in every published binary and in every published data
pack. Anyone can still use it, and it bills the Kartoza/Wits MapTiler account.

Before revoking, check the account's usage graph. Anomalous traffic against this
key is the evidence of whether it has been abused, and it disappears once the
key is deleted.

### Then set the new key in each place the application runs

| How it runs | Where the key goes | Effect if not set |
|---|---|---|
| **Hosted deployment** (`deployments/docker-compose.yaml` + nginx) | `DT_MAPTILER_API_KEY=…` in `deployments/.env` — gitignored — then `docker compose up -d --force-recreate app`. Compose only reads `.env` when the container is created; `restart` is not enough. | Public dashboard maps draw with no place labels. Nothing else breaks. |
| **Container, run directly** | `docker run -e DT_MAPTILER_API_KEY=… …` | as above |
| **Desktop, launched from an icon** | `"maptiler_key": "…"` in `settings.json` — `~/.config/decision-theatre/` (Linux), `~/Library/Application Support/decision-theatre/` (macOS), `%APPDATA%\decision-theatre\` (Windows). Restart afterwards. | Labels missing for every desktop user. **This is the regression to weigh**: released builds had the key baked in, so desktop users who upgrade lose labels until they do this, and there is no UI for it (see below). |
| **Desktop, from a terminal** | `DT_MAPTILER_API_KEY=… ./decision-theatre`, or `--maptiler-key …` | as above |
| **Developer checkout** | either of the above | labels missing while developing; tests do not need a key |

### Restrict the new key

In the MapTiler console, restrict it to the deployment's own domains. The
server proxies the font requests so the key is not exposed to browsers, but a
restricted key limits the damage if it leaks again. Note that a domain
restriction only helps for browser-originated requests — this server sends them
itself, so confirm with MapTiler support that the restriction does not block the
proxy's own traffic before relying on it. **I have not verified this.**

### Do not

- Rewrite git history to remove the key. Every clone and fork keeps it, every
  commit hash downstream changes, and the key is disclosed either way. Revoke
  instead.
- Put the key in `frontend/.env`. `VITE_` variables are substituted into the
  JavaScript bundle and would publish it again, to everyone, permanently.
- Re-add it to either `style.json`. It is never used from there, and
  `data/mbtiles/style.json` is copied into every data pack you distribute.

### Also outstanding from the same commits

`3ac8333` leaked `deployments/certs/tls.key` as well. `.gitleaksignore` records
it as rotated. That claim predates me and I have not verified it.

---

## 7. What I would not vouch for

- **Whether the key was abused.** Only the MapTiler usage graph can say, and I
  cannot see it.
- **Whether the domain restriction the old `.gitleaksignore` comment claimed
  exists actually exists.** I have no console access. Treat the key as
  unrestricted until someone checks.
- **The desktop upgrade path.** There is no UI for entering the key — the
  frontend was out of scope for this change — so a desktop user's only option is
  to hand-edit `settings.json`. That is a poor experience and probably wants a
  follow-up issue (a field in the settings panel, which is where the Kartoza
  credit triplet already lives). What I would *not* do is inject the key at
  build time via `-ldflags`: that puts it back in the binary, which is how it
  leaked in the first place.
- **Whether any other published artefact embeds the key.** I checked the tree,
  the history, the data pack path and the release build path. I have not
  inspected the actual published binaries or the contents of already-distributed
  `.zip` packs, or any copy of the style hosted elsewhere (Google Drive is used
  for data distribution — see `scripts/check-drive-updates.sh`).
- **`origin/ticket_174`.** I read its diff for the key handling only. I have not
  reviewed its satellite quota work, and I do not know its merge status or
  intent.
- **The frontend.** `frontend/src/` was another agent's territory. I confirmed by
  grep that nothing there references MapTiler or a key — the components fetch
  `/data/style.json` and nothing else — but I did not change or test any of it.
