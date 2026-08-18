import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const chartView = readFileSync(join(src, 'components', 'ChartView.tsx'), 'utf8');
const viteConfig = readFileSync(join(src, '..', 'vite.config.ts'), 'utf8');

// The assets directory held 18 MB of PNGs and plotly sat in the entry chunk, so
// the browser fetched 6.85 MB of JavaScript before first paint for a chart the
// user may never open. Both sides measured by building this branch and current
// main from the same base: 6.85 MB -> 1.96 MB on the critical path.

describe('plotly is off the critical path', () => {
  it('is imported lazily', () => {
    expect(chartView).toMatch(/lazy\(\(\) => import\('react-plotly\.js'\)\)/);
    // A bare static import would put it straight back in the entry chunk.
    expect(chartView).not.toMatch(/^import Plot from 'react-plotly\.js'/m);
  });

  it('is not named as a manual chunk', () => {
    // Naming it puts it back in the static graph, and Vite then emits a
    // modulepreload link — so the browser fetches all 4.6 MB before first paint
    // even though the import is lazy. Measured, not assumed.
    // The comment explaining why plotly is absent lives inside this block, so
    // strip comments before looking — otherwise the explanation trips the check.
    // Matching the bare name rather than `plotly:` also catches `'plotly': [...]`.
    const manualChunks = viteConfig
      .slice(viteConfig.indexOf('manualChunks'))
      .replace(/\/\/.*$/gm, '');
    expect(manualChunks).not.toMatch(/plotly/i);
  });

  it('renders behind a Suspense boundary', () => {
    expect(chartView).toMatch(/<Suspense/);
  });
});

describe('image weight', () => {
  const assets = join(src, 'assets');

  it('has no multi-megabyte image that the application actually loads', () => {
    // Referenced only. Unreferenced assets are a separate question — two of them
    // are the photographs whose licence is being confirmed with the client, so
    // they are deliberately still here.
    const sources: string[] = [];
    const collect = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) collect(p);
        else if (/\.(tsx?|css)$/.test(entry.name)) sources.push(readFileSync(p, 'utf8'));
      }
    };
    collect(src);
    const blob = sources.join('\n');

    const heavy: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (/\.(png|jpe?g)$/i.test(entry.name) && statSync(p).size > 1_000_000) {
          if (blob.includes(entry.name)) {
            heavy.push(`${entry.name} (${(statSync(p).size / 1048576).toFixed(2)} MB)`);
          }
        }
      }
    };
    walk(assets);

    // Anything over a megabyte and actually loaded should be webp.
    expect(heavy).toEqual([]);
  });

  it('no longer carries the duplicate of Map_screenshot', () => {
    // frontend/src/image.png was byte-identical to assets/Map_screenshot.png and
    // imported by nothing: 1.6 MB of pure duplication in git.
    expect(existsSync(join(src, 'image.png'))).toBe(false);
  });
});
