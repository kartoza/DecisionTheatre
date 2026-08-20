/**
 * Pane chrome that appears on mouse over.
 *
 * The controls that act on the whole grid have moved to the header. What is
 * left on a pane is what genuinely belongs to that pane — focus it, configure
 * its factor, remove it, drag its compare swiper — and those get out of the way
 * until the pointer is over the pane they act on.
 *
 * jsdom applies no stylesheets, so opacity cannot be asserted here. What these
 * tests pin is the contract the one stylesheet is written against: the hover
 * scope and the hidden elements carry the classes it selects on, and a running
 * tour lifts the hiding. Those are the parts that break silently when someone
 * edits the markup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, cleanup } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import { usePaneChromeForced } from '../hooks/usePaneChromeForced';
import type { ComparisonState } from '../types';

vi.mock('../components/MapView', () => ({ default: () => <div data-testid="map-view" /> }));
vi.mock('../components/ChartView', () => ({ default: () => <div /> }));
vi.mock('../components/DialChart', () => ({ default: () => <div /> }));
vi.mock('../components/AggregateTable', () => ({ default: () => <div /> }));

const CSS = readFileSync('src/styles/paneChrome.css', 'utf8');
const MAPVIEW = readFileSync('src/components/MapView.tsx', 'utf8');

const comparison: ComparisonState = {
  leftScenario: 'current',
  rightScenario: 'future',
  attribute: '',
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.classList.remove('dt-tour-active');
});

async function renderPane() {
  const ViewPane = (await import('../components/ViewPane')).default;
  return render(
    <ChakraProvider theme={theme}>
      <ViewPane
        comparison={comparison}
        paneIndex={0}
        layoutMode="quad"
        viewMode="map"
        onViewModeChange={() => {}}
        onFocusPane={() => {}}
        onGoQuad={() => {}}
        onOpenControlPanel={() => {}}
        colorScaleMode="rainbow"
        colorScaleType="linear"
      />
    </ChakraProvider>,
  );
}

describe('ViewPane chrome', () => {
  it('makes the pane the hover scope', async () => {
    const { container } = await renderPane();
    expect(container.querySelectorAll('.dt-pane')).toHaveLength(1);
  });

  it('puts the per-pane toolbar inside that scope, marked to hide', async () => {
    const { container } = await renderPane();
    const pane = container.querySelector('.dt-pane');
    const toolbar = container.querySelector('.dt-pane-chrome');
    expect(toolbar).not.toBeNull();
    // The selector is `.dt-pane:hover .dt-pane-chrome` — a descendant
    // combinator, so a toolbar outside the pane would never be revealed.
    expect(pane?.contains(toolbar!)).toBe(true);
  });

  it('keeps the pane\'s own controls in the pane', async () => {
    // The point of the hover reveal is that these could not move to the header
    // the way the global toggles did: they act on one pane, so six panes
    // legitimately need six of them.
    const { getByLabelText } = await renderPane();
    expect(getByLabelText('Focus pane')).toBeInTheDocument();
    expect(getByLabelText('Configure factor')).toBeInTheDocument();
  });
});

describe('pane chrome stylesheet', () => {
  it('hides the chrome only where a pointer can hover', () => {
    // Without this guard a touch user loses the controls outright: there is no
    // hover to bring them back with.
    const guard = CSS.indexOf('@media (hover: hover) and (pointer: fine)');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(CSS.indexOf('opacity: 0')).toBeGreaterThan(guard);
  });

  it('reveals on focus as well as hover', () => {
    // A keyboard user tabbing into a control must be able to see where they are.
    expect(CSS).toContain('.dt-pane:hover .dt-pane-chrome');
    expect(CSS).toContain('.dt-pane:focus-within .dt-pane-chrome');
  });

  it('does not leave an invisible element swallowing map clicks', () => {
    expect(CSS).toContain('pointer-events: none');
    expect(CSS).toContain('pointer-events: auto');
  });

  it('selects the class the tour override sets', () => {
    expect(CSS).toContain('body.dt-tour-active .dt-pane-chrome');
  });
});

describe('the compare swiper divider', () => {
  it('rests thin and thickens with the rest of the chrome', () => {
    const hover = CSS.indexOf('@media (hover: hover) and (pointer: fine)');
    const thin = CSS.indexOf('width: 3px');
    expect(thin).toBeGreaterThan(hover);
    expect(CSS).toContain('.dt-pane:hover .dt-swiper-line');
    expect(CSS).toContain('.dt-pane:focus-within .dt-swiper-line');
  });

  it('stays visible rather than hiding like the handle', () => {
    // The line says which side of the map is which scenario. Losing it is
    // losing information, not losing a control.
    expect(CSS).not.toContain('.dt-swiper-line {\n  opacity: 0');
    const base = CSS.slice(CSS.indexOf('.dt-swiper-line {'));
    expect(base.slice(0, base.indexOf('}'))).toContain('background: white');
  });

  it('is driven by an attribute MapView sets, not by inline styles', () => {
    // Six sets of inline width/background/box-shadow across two duplicated
    // blocks used to do this. Inline styles would out-specify the rule above,
    // so a stray one silently disables the whole behaviour.
    expect(MAPVIEW).not.toMatch(/slider\.style\.(width|background|boxShadow)/);
    // Both docking paths — the drag handler and the synced-position effect.
    expect(MAPVIEW.match(/slider\.dataset\.docked/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps a docked divider docked whether hovered or not', () => {
    // Docked, the line is gone and the handle is a half-circle tab against the
    // frame — the only way back. Widening it on hover would draw a white bar
    // over a map that is clipped to zero width on that side.
    expect(CSS).toContain("body.dt-tour-active .dt-swiper-line[data-docked='right']");
    expect(CSS).toContain(".dt-pane:hover .dt-swiper-line[data-docked='left']");
  });
});

describe('the zoom cluster', () => {
  it('hides MapLibre\'s own control on every pane but one', () => {
    // MapLibre's positioning class, part of the stylesheet the library ships.
    expect(CSS).toContain('.dt-no-nav .maplibregl-ctrl-bottom-left');
    expect(CSS).toContain('display: none');
  });

  it('is not skipped at construction, so it can follow the layout', () => {
    // Which pane is bottom-left changes while the application runs — a pane is
    // removed, the columns toggle, a pane switches to chart view — and the maps
    // are built once. Gating addControl would freeze the cluster on whichever
    // pane happened to be bottom-left when its map was created.
    expect(MAPVIEW).toContain("addControl(new maplibregl.NavigationControl(), 'bottom-left')");
    expect(MAPVIEW).not.toMatch(/if \(showNavigation[^)]*\)\s*\w*[Mm]ap\.addControl/);
  });
});

describe('usePaneChromeForced', () => {
  it('lifts the hiding while a tour is on screen, and puts it back after', () => {
    const { rerender, unmount } = renderHook(
      ({ active }) => usePaneChromeForced(active),
      { initialProps: { active: true } },
    );
    expect(document.body.classList.contains('dt-tour-active')).toBe(true);

    rerender({ active: false });
    expect(document.body.classList.contains('dt-tour-active')).toBe(false);

    rerender({ active: true });
    unmount();
    expect(document.body.classList.contains('dt-tour-active')).toBe(false);
  });
});
