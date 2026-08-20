# Notes — issue #70, site store save cost

Branch `perf/site-store-off-main-thread`. Touches `frontend/src/lib/siteStore.ts`
and `frontend/src/test/siteStore.test.ts` only.

## What the state was

The per-record split had already landed (commit `2dfe378`): sites live at
`dt-site:{id}` with a `dt-site-index`, and the per-catchment breakdown is no
longer persisted. That fixed the *write*.

It did not fix the work around the write. The three bulk callers in
`hooks/useApi.ts` — `createSite`, `updateSite`, `deleteSite` — still do
load-everything, change one entry, hand the whole list back. Against per-site
records that meant `loadSites` parsed all N records on the way in, and
`saveSites` re-serialised all N on the way out and read all N back from storage
to work out which one differed. Same O(store) main-thread cost as the old single
blob, just spread over more keys.

## What changed

A module-level **record cache** in `siteStore.ts`: for each id, the object the
module last handed out or wrote, and the exact string that object serialises to.

- `readRecord` re-parses only when the stored string differs from the one it
  already parsed, and returns the cached object rather than a fresh copy.
- `saveSites` recognises an unchanged site by **reference identity** — it is the
  very object the cache handed out — and skips serialising it entirely. A site
  it does not recognise is serialised and compared against the string the cache
  knows is on disk, so an unfamiliar-but-identical object still does not reach
  storage.
- The index is cached too, and rewritten only when membership or order actually
  changed. It used to be rewritten on every bulk save.
- The removed-records sweep in `saveSites` used `Array.includes` inside a loop
  over the index; it is a `Set` now.
- A `storage` event listener drops cached entries another tab replaced. Without
  it a second tab would serve its own stale copy, and — worse — the identity
  shortcut would decide a record needed no write when the other tab had already
  replaced it.
- `getSiteStoreStats` / `resetSiteStoreStats` count serialisations, parses,
  record reads and writes, and index writes, so the tests can assert the *amount*
  of work rather than the outcome.
- `invalidateSiteCache(id?)` is the documented escape hatch.

## Measured

jsdom, this machine, one site edited out of a store of 200:

| store | operation | before | after |
| --- | --- | --- | --- |
| 4,091,627 chars (78% of the 5,241,856 ceiling) | bulk save | 24.94 ms | 0.28 ms |
| same | reload for the next save | 17.90 ms | 0.60 ms |
| 806,903 chars, 40 sites | bulk save | 3.95 ms | 0.21 ms |

The point is not the ratio, it is that the "after" column barely moves between
807 k chars and 4.1 M: 0.21 ms → 0.28 ms. The cost is now proportional to the
edit, not to the store. (The benchmark was a throwaway; it is not committed.)

## Durability

**No durability window was introduced.** Nothing is debounced, batched, deferred
or queued. Writes are still synchronous `setItem` calls made during the save. If
`saveSite`/`saveSites` returns true, the bytes are in localStorage; close the tab
on the next tick and the work is there. Making saves *cheaper* was the fix;
making them *later* would have traded the user's only copy for smoothness.

Quota failures still surface, and the cache is built so it cannot hide one:

- `writeRecord` sets the cache entry only when `safeSetItem` returned true, and
  **deletes** it when it returned false. A failed write can therefore never leave
  the module believing a site is stored, and the next attempt with the same
  object really writes. There is a test for exactly this.
- `writeIndex` nulls the index cache on failure.
- `saveSites` still returns false if any record or the index failed, and the
  callers in `useApi.ts` still turn that into "Browser storage is full".

## Deliberately not done

- **No IndexedDB.** That is issue #72.
- **No Web Worker.** Web Storage is not exposed to workers, so the branch name is
  aspirational: this reduces main-thread work rather than moving it off-thread.
  Genuinely off-thread requires #72.
- **No npm dependency.**
- **No change to `hooks/useApi.ts` or `components/MapView.tsx`** — another agent's
  territory this round. See "outside this issue" below for what I would do there.
- **`storage.ts` unchanged.** `estimateStorageChars` is O(everything stored), but
  it runs once at startup from `App.tsx` and measuring everything is the point of
  it.
- **Legacy migration retry semantics left alone.** I tried a once-per-session
  flag and backed it out: `sessionSites.test.ts` writes `dt-sites` part-way
  through a file and expects it picked up, and more generally an import or
  restore path could legitimately write that key later. So every read and write
  still probes `dt-sites`. After a successful migration that is a null lookup and
  costs nothing.

## Things I found that are outside this issue

- **The bulk API is the real problem and it is in `useApi.ts`.** `createSite`,
  `updateSite` and `deleteSite` all round-trip the entire list to change one
  site, and `saveLocalSite`/`loadLocalSite` already exist. `updateSite` in
  particular could be `loadSite(id)` → spread → `saveSite`, which needs no cache
  at all to be O(1). The cache exists to make the *existing* shape cheap; the
  shape itself is still wrong. Worth a follow-up issue.
- `sortSitesByCreatedAtDesc(sites)` is called on every bulk save and sorts the
  whole list. Cheap next to what it used to sit beside, less cheap now that
  everything else is 0.3 ms.
- A failed migration (quota exhausted with a legacy blob present) re-reads and
  re-parses the whole blob on every single save until it succeeds. Documented in
  the module. It only happens in a state where the user is already being told
  storage is full, and each retry is a chance to rescue the blob, so I left it.

## What I would not vouch for

- **The immutability contract.** The identity shortcut in `saveSites` assumes no
  caller mutates a site returned by the store in place. I grepped for in-place
  property assignment on sites across `frontend/src` and found none — every
  update is a spread, which is what React state requires anyway — and the
  contract is documented at the top of the module. But it is a convention, not
  something the type system enforces, and a future caller that mutates in place
  and then calls `saveSites` would have its change silently dropped.
  Two things limit the blast radius: `saveSite` (the single-site path every
  interactive editor uses — `App.tsx`, `IndicatorEditorPage.tsx`, `MapView.tsx`)
  **never** takes the shortcut and always writes; and `invalidateSiteCache` is
  exported. If someone wants belt and braces, the next step would be a dev-mode
  assertion that re-serialises and compares on the skip path — I left it out
  because it would restore exactly the O(store) cost in development and make dev
  unrepresentative of production.
- **Same-tab external mutation of localStorage.** `storage` events only fire in
  *other* tabs. If something in this tab writes `dt-site:*` or clears
  localStorage without going through this module, the cache goes stale.
  `clearSiteStore()` handles the test path; nothing else in the app does this
  today.
- **Serialisation stability.** The "unfamiliar but identical" comparison assumes
  `JSON.stringify(normaliseForStorage(JSON.parse(raw))) === raw`. That holds
  because `JSON.parse` and object spread both preserve source key order for
  string keys, and site objects have string keys. It would not hold for
  integer-like top-level keys. Not a case that occurs, but it is an assumption.
- The benchmark numbers are jsdom, not a browser. The ratio and the flatness are
  what matter; the absolute milliseconds will differ.

## Tests

`npx vitest run` in `frontend/`:

- before: 19 files, 127 tests, all passing
- after: 19 files, 143 tests, all passing

`npx tsc --noEmit` and `npx eslint` clean.

16 new tests in `src/test/siteStore.test.ts`, under `what a save actually costs`,
`what a save touches, observed from outside`, and `the cache never outlives what
it describes`. I checked they fail against the previous implementation: stubbing
the new exports onto `HEAD`'s `siteStore.ts` and running the file gives 8
failures, including the spy-based one that observes reads and writes from outside
the module and so does not depend on the new counters.

Note `frontend/node_modules` in this worktree is a symlink to the one in the main
checkout, so the suite could be run without an install. Remove it before doing
anything that writes to `node_modules`.
