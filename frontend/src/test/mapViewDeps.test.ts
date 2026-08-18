import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// applyColors was memoised on [colorScaleMode, colorScaleType] while its body read
// the siteId prop in ten places. The effect that calls it does list siteId, so on
// a site switch it invoked a callback still bound to the previous site's id — used
// for the choropleth fetch and the ideal-override lookup, and stale until an
// unrelated colour-scale change happened to recreate the callback.
//
// react-hooks/exhaustive-deps is the tool for this, and this repository has no
// eslint configuration at all (see the companion issue), so nothing would catch a
// recurrence. This is a narrow stand-in: for one identifier, in one file, assert
// that a hook reading it also declares it.

interface Hook {
  kind: string;
  line: number;
  body: string;
  deps: string;
}

/**
 * Extract hook calls with their dependency arrays.
 *
 * Parenthesis matching rather than a regex: an earlier regex version matched a
 * closing brace from a *later* hook and reported a dependency array that belonged
 * to something else, which produced a false positive. String literals, template
 * literals and comments are skipped so a bracket inside one cannot unbalance the
 * count.
 */
export function extractHooks(source: string): Hook[] {
  const hooks: Hook[] = [];
  const pattern = /\b(useCallback|useMemo|useEffect)\s*\(/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    const openParen = match.index + match[0].length - 1;
    let depth = 0;
    let i = openParen;

    for (; i < source.length; i++) {
      const ch = source[i];

      // Skip over anything that can contain unbalanced brackets.
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') i++;
          i++;
        }
        continue;
      }
      if (ch === '/' && source[i + 1] === '/') {
        while (i < source.length && source[i] !== '\n') i++;
        continue;
      }
      if (ch === '/' && source[i + 1] === '*') {
        i += 2;
        while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
        i++;
        continue;
      }

      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }

    const call = source.slice(openParen, i + 1);
    // The dependency array is the last top-level [...] in the call.
    const depsMatch = call.match(/,\s*(\[[^[\]]*\])\s*,?\s*\)$/);
    const deps = depsMatch ? depsMatch[1] : '';

    hooks.push({
      kind: match[1],
      line: source.slice(0, match.index).split('\n').length,
      body: depsMatch ? call.slice(0, call.lastIndexOf(deps)) : call,
      deps,
    });
  }

  return hooks;
}

const usesIdentifier = (text: string, name: string) =>
  new RegExp(`\\b${name}\\b`).test(text);

// The analyser is checked against known input first. A source-level test that is
// silently broken is worse than no test: it reports success either way.
describe('the dependency analyser itself', () => {
  it('finds a hook that omits an identifier it uses', () => {
    const sample = `
      const f = useCallback(() => {
        return siteId + 1;
      }, [other]);
    `;
    const [hook] = extractHooks(sample);
    expect(hook.deps).toBe('[other]');
    expect(usesIdentifier(hook.body, 'siteId')).toBe(true);
    expect(usesIdentifier(hook.deps, 'siteId')).toBe(false);
  });

  it('accepts a hook that declares what it uses', () => {
    const sample = `
      const f = useCallback(() => {
        return siteId + 1;
      }, [siteId, other]);
    `;
    const [hook] = extractHooks(sample);
    expect(usesIdentifier(hook.deps, 'siteId')).toBe(true);
  });

  // The bug in the first version of this analyser: it ran past the hook's own
  // closing and picked up a later hook's dependency array.
  it('does not read the next hook’s dependencies', () => {
    const sample = `
      const a = useCallback(() => { return 1; }, [alpha]);
      const b = useCallback(() => { return siteId; }, [siteId]);
    `;
    const hooks = extractHooks(sample);
    expect(hooks).toHaveLength(2);
    expect(hooks[0].deps).toBe('[alpha]');
    expect(hooks[1].deps).toBe('[siteId]');
  });

  it('is not confused by brackets inside strings or comments', () => {
    const sample = `
      const f = useCallback(() => {
        const s = "a ) bracket";
        // another ) here
        return siteId;
      }, [siteId]);
    `;
    const [hook] = extractHooks(sample);
    expect(hook.deps).toBe('[siteId]');
  });
});

describe('MapView hook dependencies', () => {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'components', 'MapView.tsx');
  const source = readFileSync(file, 'utf8');

  it('declares siteId wherever it is read', () => {
    const offenders = extractHooks(source)
      .filter((h) => h.deps !== '') // a hook with no dependency array runs every render
      .filter((h) => usesIdentifier(h.body, 'siteId') && !usesIdentifier(h.deps, 'siteId'))
      .map((h) => `${h.kind} at MapView.tsx:${h.line} deps ${h.deps}`);

    expect(offenders).toEqual([]);
  });

  it('finds the hooks it is supposed to be checking', () => {
    // A guard against the analyser quietly matching nothing and passing forever.
    const hooks = extractHooks(source);
    expect(hooks.length).toBeGreaterThan(20);
    expect(hooks.filter((h) => usesIdentifier(h.body, 'siteId')).length).toBeGreaterThan(0);
  });
});
