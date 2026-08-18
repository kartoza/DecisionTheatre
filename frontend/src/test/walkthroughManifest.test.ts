import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// The expected manifest is derived here rather than imported from
// scripts/build-walkthrough-manifest.mjs. Importing it made `tsc --noEmit` fail
// with TS7016 — a JavaScript module with no declarations — which would break CI.
//
// Deriving it independently is also the better test: if the generator and this
// disagree about which fields belong in the manifest, that disagreement surfaces
// here instead of both sides being wrong together.
const MANIFEST_FIELDS = ['id', 'title', 'description', 'thumbnail', 'createdAt', 'updatedAt'];

function buildManifest(directory: string) {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .sort()
    .map((name) => {
      const site = JSON.parse(readFileSync(join(directory, name), 'utf8'));
      const entry: Record<string, unknown> = { source: 'walkthrough' };
      for (const field of MANIFEST_FIELDS) {
        if (site[field] !== undefined) entry[field] = site[field];
      }
      return entry;
    });
}

// listSites downloaded and parsed all four walkthrough documents — 5,025,346
// bytes, one of them 4 MB — to render a list of titles, thumbnails and dates.

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const dir = join(repo, 'data', 'walkthroughs');
const manifestPath = join(dir, 'manifest.json');

const sources = () =>
  readdirSync(dir).filter((n) => n.endsWith('.json') && n !== 'manifest.json');

describe('the walkthrough manifest', () => {
  it('is in step with the documents it summarises', () => {
    // Regenerating and comparing is the whole guard: the manifest is committed,
    // so without this it silently goes stale the moment a walkthrough changes.
    const committed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(committed).toEqual(buildManifest(dir));
  });

  it('covers every walkthrough document', () => {
    const committed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(committed).toHaveLength(sources().length);

    const ids = committed.map((e: { id: string }) => e.id).sort();
    const fileIds = sources().map((n) => n.replace('.json', '')).sort();
    expect(ids).toEqual(fileIds);
  });

  it('carries every field the sites list renders', () => {
    const committed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    for (const entry of committed) {
      // SitesPage reads id, title, description, thumbnail, createdAt and source.
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('title');
      expect(entry).toHaveProperty('source', 'walkthrough');
      for (const field of MANIFEST_FIELDS) {
        expect(Object.keys(entry)).toContain(field);
      }
    }
  });

  it('is a fraction of the size of the documents', () => {
    const manifestBytes = statSync(manifestPath).size;
    const sourceBytes = sources().reduce((t, n) => t + statSync(join(dir, n)).size, 0);

    // The point of the change. If a future edit starts embedding catchments here
    // this fails rather than quietly restoring the 5 MB first render.
    expect(sourceBytes).toBeGreaterThan(1_000_000);
    expect(manifestBytes).toBeLessThan(sourceBytes / 100);
  });

  it('carries no per-catchment payload', () => {
    const raw = readFileSync(manifestPath, 'utf8');
    for (const heavy of ['catchments', 'catchmentIndicators', 'catchmentData', 'indicators', 'geometry']) {
      expect(raw).not.toContain(`"${heavy}"`);
    }
  });
});
