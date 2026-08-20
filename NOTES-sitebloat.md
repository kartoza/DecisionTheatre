# What a stored site costs — issues #69 and #68

Sites live in browser storage by design; the brief forbids uploading them. So
`localStorage` is the user's only copy of their work, and the ceiling on this
machine was measured at **5,241,856 characters** — not `navigator.storage.estimate()`,
which reports the origin quota (10 GB here) and has nothing to do with the Web
Storage limit.

Everything below is characters, because that is the unit the ceiling is in.

## Method

`data/walkthroughs/*.json` are the only real documents in the tree with real
attribute maps in them (`data/sites/` is empty on this machine). Walkthrough
sites are deliberately never persisted — `source: 'walkthrough'` goes to an
in-memory `_sessionSites` map — so measuring one would have measured nothing.
Instead a **user-created** site was synthesised from each walkthrough's real
data: the real `indicators` block (502 attributes), the real dissolved
`geometry`, the real per-catchment breakdown replicated to N catchments with
fresh ids, plus the id list on the site and the duplicate inside `indicators`
exactly as older documents carry them.

That object is what is in memory just before a save. It was then put through
`normaliseForStorage` from `frontend/src/lib/siteStore.ts` and measured with
`JSON.stringify(...).length`, at `HEAD` and again after this change. The harness
ran under `npx vite-node` against the real module, not a reimplementation, so
the numbers are the shipped code's.

## Before and after

A **200-catchment user-created site**, built from the Kruger walkthrough's
attribute maps (54.4 KB per catchment):

| | characters | % of 5,241,856 |
|---|---:|---:|
| in memory, as the API hands it over | 11,215,026 | 214% |
| stored at `HEAD` (breakdown and duplicate ids already dropped) | 67,656 | 1.3% |
| **stored after this change** | **46,582** | **0.9%** |

Sites of that size that fit in the ceiling: **77 before, 112 after.**

The same site at other scales, and from the other two documents:

```
Kruger    (54.4 KB/catchment)  n= 10  in-memory   623,121  was 65,755  now 44,681
                               n= 50  in-memory 2,853,014  was 66,155  now 45,081
                               n=200  in-memory 11,215,026 was 67,656  now 46,582
Serengeti (26.3 KB/catchment)  n=200  in-memory 5,411,814  was 80,391  now 61,472
small     (54.0 KB/catchment)  n=200  in-memory 11,121,461 was 59,829  now 41,069
```

The first column is the point of #68: **the document could not be stored at
all.** A 200-catchment site is more than twice the entire ceiling before the
breakdown comes off, and a 50-catchment one is already 54% of it — one site,
before the user has made a second.

And #69, at the scale the issue quotes. A user-created site covering the same
147,837 catchments as the Africa walkthrough:

```
document carrying the id list twice   4,026,473 chars  (76.8% of the ceiling)
stored today                          2,078,268 chars  (39.6%)
the duplicated array on its own       1,921,882 chars
```

4,026,473 with the list twice, 1,921,882 of which is one copy — 3.84 MB of a
4.0 MB document, which is the issue's headline reproduced exactly. One site,
three quarters of everything the user is allowed to keep.

## What was already fixed, and what was not

Most of both issues was fixed before I started, on `main`: `normaliseForStorage`
already strips the three names for the per-catchment breakdown and the
`indicators.catchmentIds` duplicate, and every write path (`saveSite`,
`saveSites`, `migrateLegacyStore`) goes through it. I checked rather than
assumed, and found no live writer of either — the Go `SiteIndicators` has no
`CatchmentIDs` field, and none of the four walkthrough documents carries one, so
only legacy records do. I have pinned that with tests that count occurrences in
the stored **string** rather than inspecting an intermediate object.

Three gaps were left.

**1. The type did not forbid the duplicate (#69).** `SiteIndicators` simply
omitted `catchmentIds`. Omission is not prohibition: excess-property checking
only fires on a fresh object literal, so the realistic route back in — a value
that has been through a variable, `const ind = { ...fromTheWire }` then assigned
somewhere expecting `SiteIndicators` — compiled silently. It is now
`catchmentIds?: never`, so the only assignable value is `undefined`, which
`JSON.stringify` does not emit. The test for this is a `@ts-expect-error`
checked by `tsc --noEmit`; reverting the type change makes it fail with
"Unused '@ts-expect-error' directive", which I verified.

**2. The store handed back the breakdown for the rest of the session (#68).**
The record cache introduced on this branch stored `{ site, raw }` where `site`
was *the caller's object* and `raw` was the normalised string. Those are not the
same thing: the caller's object still carries `catchments`. So after any save,
`loadSite` returned a site with the full per-catchment breakdown still attached
until the page was reloaded — and anything that re-serialised it paid for it.
`getSiteCatchments` in `hooks/useApi.ts` does exactly that: it `POST`s
`loadLocalSite(siteId)` minus the thumbnail as a request body, which for a
200-catchment site was an 11 MB upload. The cache now holds the value that
matches `raw`, and remembers the written object separately (`written`) purely so
`saveSites` can still recognise it by identity — the "one changed site out of N
costs one `JSON.stringify`" property is unchanged, and its test still passes.

**3. `ideal` was stored twice (#68).** The remaining record is 93% `indicators`,
and `ideal` is seeded as a copy of `current` — in all four walkthrough documents
it is byte-identical for all 502 attributes. `normaliseForStorage` now stores
only the entries that differ, as `idealDelta`, and `denormaliseFromStorage`
rebuilds `ideal` as `{ ...current, ...delta }` on the way out. That is the
67,656 → 46,582.

It keeps most of its value once the user has actually edited targets, because
they edit some of the 502, not all:

```
  0/502 targets differ from current:  67,656 -> 46,582  (31% smaller)
  5/502                               67,656 -> 46,754  (31%)
 24/502                               67,713 -> 47,569  (30%)
 80/502                               67,635 -> 50,757  (25%)
124/502                               67,565 -> 53,014  (22%)
209/502                               67,459 -> 56,901  (16%)
```

## Migration, and why nothing is lost

Nothing is dropped that is not recoverable from the same record, written in the
same `setItem` call. There is no cross-record or cross-key dependency, so there
is no window in which a store is half-consistent.

- **Old records read correctly and are not rewritten on read.** A record with a
  whole `ideal` is used as it stands; only one with `idealDelta` is rebuilt. The
  two encodings are told apart by the field name, not inferred, so a store with
  some records in each state — which is the normal state, since a site the user
  has not opened since the upgrade is never rewritten — reads correctly
  indefinitely. Tested.
- **The legacy `dt-sites` blob path is untouched** and still tested: it
  normalises on the way through, keeps the blob if any record write fails, and
  leaves an unparseable blob alone.
- **The reduction refuses itself when it could not be undone exactly.** `ideal`
  is rebuilt from `current`, so it can only be reconstructed when `ideal` has an
  entry for every key `current` has. Every document this application produces
  does. One that does not is stored whole rather than silently gaining a target
  value. Tested.
- **Quota failures are still loud.** `writeRecord` still checks `safeSetItem`'s
  boolean, still deletes the cache entry when the write failed, and still
  returns false so `useApi` can tell the user. A new test writes a site, fails
  the next write, and asserts that what reads back is the version that actually
  reached storage — not the one the store might have believed it had. No write
  was made best-effort and nothing was deferred; saves are still synchronous, so
  there is still no window in which an accepted save has not reached storage.

## What I deliberately left

- **`indicators.reference` and `indicators.current`** — ~21,000 characters each,
  and now 90% of a stored record. They *are* recomputable: the server aggregates
  them from the catchments. They stay anyway, because this store is the user's
  only copy, and recomputable is not the same as recoverable — dropping them
  means a site opened without a reachable server, or against a datapack that no
  longer holds those catchments, shows a site with no numbers in it. That is a
  worse failure than being 21 KB larger.
- **Numeric precision.** The values are stored at full float64 repr —
  `48.64402480652572` is 17 characters for a quantity nobody reads past three.
  Rounding would cut the two big maps by roughly half. I did not, because it is
  lossy on the user's own target values and belongs in a decision about the
  aggregation, not in a storage change.
- **`site.catchmentIds`** — 2,001 characters at 200 catchments, 1.9 M at
  continental scale. It is the site's definition, not a derivative, and there is
  nothing to recompute it from.
- **IndexedDB** — issue #72, deliberately separate.

## What I would not vouch for

- **The measurement is synthetic in one respect.** The per-catchment breakdown
  was replicated from real catchments rather than being 200 genuinely distinct
  ones, so the *count* of catchments is synthetic even though the per-catchment
  cost is measured. That affects only the "in memory" column; the stored figures
  do not depend on it, since the breakdown is not stored.
- **The 502-attribute indicator block is what the walkthroughs carry.** Real
  extracted sites may also carry `referenceLower/Upper` and `currentLower/Upper`
  — the datapack has the CSVs for them — which would add roughly 84 KB to a
  stored record that none of my measurements include. Those maps hold genuinely
  different values, so the same-as-base reduction would not help them. If they
  turn out to be common, a stored record is nearer 130 KB than 46 KB and this
  issue is worth reopening.
- **A downgrade reads `idealDelta` as a missing `ideal`.** An older bundle —
  another tab on a cached build — would find `indicators.ideal` undefined. This
  is not new in kind: `main` already moved from `dt-sites` to `dt-site:{id}`
  records, and an older bundle reading the current store sees *no sites at all*,
  which is strictly worse. But it is a forward-only migration and worth knowing.
- **`normaliseForStorage` now walks the attribute maps** on every save — O(502),
  against a `JSON.stringify` of the same maps that was already happening. I did
  not measure it because it cannot plausibly matter, but I did not measure it.
- **I did not run the app.** The evidence here is the test suite (175 passing,
  up from 164), `tsc --noEmit`, `npm run lint -- --max-warnings 0`, and the
  measurements above.

## Verification

Run from `frontend/`:

```
npm test -- --run                  # 22 files, 175 tests
npx tsc --noEmit
npm run lint -- --max-warnings 0
```

Tests that fail without the change, checked by reverting each piece:

- `the per-catchment breakdown (#68) > is not handed back by the store either`
- `targets that are still a copy of current (#68) > are stored once, and read back whole`
- `targets that are still a copy of current (#68) > cost less than they did, and the same site comes back`
- `the duplicated id list (#69) > cannot be put back by a caller` — a compile-time
  assertion; revert `types/index.ts` and `tsc --noEmit` reports TS2578.
