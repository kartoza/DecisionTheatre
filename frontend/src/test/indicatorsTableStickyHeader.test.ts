// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Reported, with a screenshot: scrolling the indicators table under its
// sticky header showed the scrolled row's text bleeding through the header
// text. 'gray.850' isn't a real Chakra token (the gray scale stops at 900),
// so tableBg resolved to an undefined CSS var -- no background at all.
//
// Fixing that wasn't the end of it: reported again, with a recording,
// still happening -- scrolled rows reappeared ON TOP of the header rather
// than hiding behind it. Ruled out one at a time, each confirmed live down
// to the DOM, none of it changed the outcome: the row's y-offset entrance
// animation (Framer Motion implements that via a transform, which
// establishes its own stacking context even once settled at y: 0); sticky
// on the Thead vs the Tr vs (the usually-reliable pattern) each Th cell;
// forcing a compositing layer via will-change. The header cells' own CSS
// (opaque background, correct z-index, correct computed "stuck" position)
// was never actually wrong in any of these attempts -- position: sticky on
// a header row inside a scrolling <table> is just an unreliable pattern
// across this app's rendering engines (both this dev server's Chromium and
// the desktop app's own WebKit reproduced it).
//
// The fix that actually works, because it sidesteps the bug rather than
// fighting it: two ordinary (non-sticky) tables sharing one column layout
// via a <colgroup> repeated on each. A small, genuinely non-scrolling
// header table sits above the scroll area -- it needs no sticky
// positioning at all, since it was never going to scroll in the first
// place -- and a second table below holds only the body. The one thing
// that actually has to be kept in sync between them is column widths
// (TABLE_COLUMN_WIDTHS) and the body table's own vertical scrollbar width,
// which the header table doesn't have and so is given as compensating
// right padding (measured live via scrollbarWidth, not assumed, since it
// varies by platform/theme).
const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(src, 'components', 'IndicatorEditorPage.tsx'), 'utf8');

describe('IndicatorEditorPage table header', () => {
  it('does not use the invalid gray.850 token as an actual color value', () => {
    expect(page).not.toMatch(/'gray\.850'/);
  });

  it('gives the header table a real, defined background token', () => {
    const tableBgDecl = page.match(/const tableBg = useColorModeValue\(([^)]+)\);/);
    expect(tableBgDecl).not.toBeNull();
    expect(tableBgDecl?.[1]).toContain("'gray.900'");
  });

  it('renders the header as its own table, separate from the scrolling body table', () => {
    // Two <Table> elements, not one -- the whole point of the fix. The
    // header's own Table has no id="demo-indicators-container" ancestor;
    // the body's does.
    const tableCount = (page.match(/<Table variant="simple" size="sm"/g) ?? []).length;
    expect(tableCount).toBe(2);
    expect(page).toContain('id="demo-indicators-container"');
  });

  it('does not rely on position: sticky anywhere in the table header', () => {
    // Confirmed live, repeatedly: sticky on a header row inside a
    // scrolling table doesn't reliably paint over scrolled content in
    // this app's rendering engines, regardless of which element in the
    // Thead/Tr/Th hierarchy carries it. Scoped to the header table block
    // specifically -- the page has an unrelated sticky toolbar elsewhere
    // that this fix doesn't touch.
    const headerTableMatch = page.match(/<Table variant="simple" size="sm"[\s\S]*?<\/Thead>\s*<\/Table>/);
    expect(headerTableMatch).not.toBeNull();
    expect(headerTableMatch![0]).not.toMatch(/position="sticky"/);
  });

  it('shares one column layout between the two tables via a repeated colgroup', () => {
    const colgroupUses = (page.match(/<IndicatorTableColgroup \/>/g) ?? []).length;
    expect(colgroupUses).toBe(2);
    expect(page).toContain('const TABLE_COLUMN_WIDTHS');
  });

  it('compensates the header table for the body table\'s own scrollbar width', () => {
    // The header table never grows a scrollbar (it doesn't scroll), so
    // without this its columns drift left of the body table's columns by
    // however wide the platform's native scrollbar is. Measured live
    // (scrollbarWidth) rather than assumed, since that width varies by
    // platform and theme -- not a constant worth hardcoding and risking
    // going stale on whichever platform wasn't tested.
    expect(page).toContain('setScrollbarWidth(el.offsetWidth - el.clientWidth)');
    expect(page).toMatch(/pr=\{`calc\(1\.5rem \+ \$\{scrollbarWidth\}px\)`\}/);
  });

  it('does not give table rows a y-offset entrance animation that would paint over the header', () => {
    // A contributing cause before the structural fix above, still worth
    // keeping disabled: Framer Motion implements an animated `y` offset
    // via a CSS transform, which establishes its own stacking context
    // even once settled at y: 0, not just mid-animation.
    expect(page).toContain('initial={{ opacity: 0 }}');
    expect(page).toContain('animate={{ opacity: 1 }}');
    expect(page).not.toMatch(/initial=\{\{ opacity: 0, y:/);
    expect(page).not.toMatch(/animate=\{\{ opacity: 1, y:/);
  });
});
