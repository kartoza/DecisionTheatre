#!/usr/bin/env node
/**
 * Build data/walkthroughs/manifest.json.
 *
 * The sites list shows a title, description, thumbnail and date. It used to get
 * those by downloading and parsing all four walkthrough documents — 5,025,346
 * bytes, of which one file is 4 MB — on the path to first render, for demos the
 * user may never open.
 *
 * This emits only the fields the list renders. The full document is still fetched
 * when a site is actually opened, by getSite.
 *
 * Run with `node scripts/build-walkthrough-manifest.mjs`, or via `make
 * walkthrough-manifest`. A test asserts the committed manifest matches the source
 * files, so it cannot drift silently.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'data', 'walkthroughs');

/** The fields the sites list reads. Keep in step with SitesPage.tsx. */
export const MANIFEST_FIELDS = ['id', 'title', 'description', 'thumbnail', 'createdAt', 'updatedAt'];

export function buildManifest(directory = dir) {
  const files = readdirSync(directory)
    .filter((name) => name.endsWith('.json') && name !== 'manifest.json')
    .sort();

  return files.map((name) => {
    const site = JSON.parse(readFileSync(join(directory, name), 'utf8'));
    const entry = { source: 'walkthrough' };
    for (const field of MANIFEST_FIELDS) {
      if (site[field] !== undefined) entry[field] = site[field];
    }
    return entry;
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const manifest = buildManifest();
  const out = join(dir, 'manifest.json');
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  const bytes = readFileSync(out).length;
  const sources = readdirSync(dir)
    .filter((n) => n.endsWith('.json') && n !== 'manifest.json')
    .reduce((total, n) => total + readFileSync(join(dir, n)).length, 0);
  console.log(`manifest.json: ${manifest.length} entries, ${bytes} bytes (sources: ${sources} bytes)`);
}
