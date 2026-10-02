/**
 * Reported: "Add pane" used to copy the focused pane's state verbatim,
 * including its indicator -- so a new map/chart/dial/belt pane always
 * started showing the exact same attribute as whatever pane you were
 * looking at, rather than surfacing something new. A full render test of
 * App.tsx for this would need to mock the whole app shell (/api/columns,
 * every other metadata endpoint, the map) just to reach one state
 * transition; this pins the logic at the source level instead, the same
 * way chevronOverlap.test.ts does for another App.tsx-only change.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

const APP = readFileSync('src/App.tsx', 'utf8');

describe('handleAddPane indicator assignment', () => {
  it('claims the first indicator not already used by any pane in the grid', () => {
    expect(APP).toContain('const used = new Set(prev.map((p) => p.attribute).filter(Boolean));');
    expect(APP).toContain('const nextUnused = columns.find((c) => !used.has(c));');
  });

  it('falls back to the focused pane\'s own indicator once every one is in use', () => {
    expect(APP).toContain('const attribute = nextUnused ?? source.attribute;');
    expect(APP).toContain('return [...prev, { ...source, attribute }];');
  });
});
