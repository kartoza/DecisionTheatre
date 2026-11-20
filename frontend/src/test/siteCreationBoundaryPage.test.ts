// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Both SiteCreationMap (a maplibre instance) and SiteCreationPage (framer-
// motion-heavy, step-driven) are too entangled with WebGL/animation to
// instantiate meaningfully in a test. Same source-level-guard approach as
// choroplethRenderPath.test.ts.

const src = join(dirname(fileURLToPath(import.meta.url)), '..');
const mapTsx = readFileSync(join(src, 'components', 'SiteCreationMap.tsx'), 'utf8');
const pageTsx = readFileSync(join(src, 'components', 'SiteCreationPage.tsx'), 'utf8');

describe('SiteCreationMap catchment layers', () => {
  it('uses the resolved tileset band\'s own minzoom, not a hardcoded guess', () => {
    // Reported: catchments weren't showing. The three catchment layers
    // (Fill, Outlines, the transparent selectable-fill used for click
    // detection) were hardcoded to minzoom: 8, independent of where the
    // resolved tileset's own detail band's source actually starts serving
    // tiles from (11 on a default datapack's catchments_lev12, 9 under
    // --legacy). A layer minzoom below the source's own minzoom isn't an
    // error, it's just silently blank between the two - exactly the dead
    // zone the report described. layerMinzoom now reads detailBand.minzoom
    // directly, so the two can never drift apart again. The three layers
    // are added via addCatchmentLayerTriple (see
    // catchmentWideZoomBand.test.ts for that helper's own coverage), which
    // takes minzoom as a parameter rather than repeating it as a literal.
    expect(mapTsx).toContain('const layerMinzoom = detailBand?.minzoom ?? 8;');
    expect(mapTsx).not.toMatch(/minzoom: 8,/);
  });

  it('outlines catchments the same way the debug overlay does - white, not a second dimmer style', () => {
    // Reported: catchments should render like the debug boundaries do.
    // CHOROPLETH_DEBUG_OUTLINE_COLOR/_WIDTH in MapView.tsx are
    // 'rgba(255, 255, 255, 0.9)' / 1 - this page used to invent its own,
    // dimmer blue instead of reusing that visual language.
    expect(mapTsx).toContain("'line-color': 'rgba(255, 255, 255, 0.9)'");
    expect(mapTsx).not.toContain("'line-color': 'rgba(60, 140, 180, 0.6)'");
  });

  it('selects by HYBAS_ID off the resolved detail band, which sorting guarantees is real lev12, never a hex stand-in', () => {
    // GOLDEN RULE: site boundary catchment selection always reads lev12.
    // tileset.bands is sorted ascending by minzoom (see bandForZoom in
    // choroplethTiles.ts), so the last band is always the finest - real
    // lev12 detail in every tileset shape this app serves, default or
    // --legacy, never one of --legacy's own hex tiers (which only ever
    // sort earlier, being coarser).
    expect(mapTsx).toContain('tileset?.bands[tileset.bands.length - 1] ?? null');
    expect(mapTsx).toContain('catchmentId = String(feature.properties?.HYBAS_ID || feature.id)');
  });

  it('falls back to a server-side point lookup when nothing is rendered at the click point', () => {
    // Reported: "it should add a catchment (l12) no matter what zoom level
    // the map is - at the moment the l12 catchments need to be visible
    // before you can add one to the map." queryRenderedFeatures only finds
    // something if catchments-selectable-fill is actually rendering, which
    // it isn't below the resolved band's own minzoom. The fallback below
    // resolves the lev12 catchment under the clicked point server-side
    // (same endpoint identify-by-click already uses), independent of
    // what's rendered, so a click works at any zoom.
    expect(mapTsx).toContain('if (features.length === 0) {');
    expect(mapTsx).toContain('/api/catchments/at-point?lng=');
    expect(mapTsx).toContain('/api/catchments/geometry/${catchmentId}');
  });
});

describe('SiteCreationPage geometry step layout', () => {
  it('moves the step title into the header row instead of a second heading below it', () => {
    // Reported: "Define Boundary" must move up into the header bar.
    const headingInHeader = pageTsx.indexOf("{isEditMode ? 'Edit ' : 'Define '}Boundary");
    const bigTitleBlock = pageTsx.indexOf("{step !== 'geometry' && (");
    expect(headingInHeader).toBeGreaterThan(-1);
    expect(bigTitleBlock).toBeGreaterThan(-1);
    // The geometry-only heading is reached before the component ever gets
    // to the big centred title block that now explicitly skips it.
    expect(headingInHeader).toBeLessThan(bigTitleBlock);
  });

  it('keeps the moved title big enough to read as the page title, not a small label', () => {
    // Reported again: moving it into the header shrunk it too far (xl/2xl).
    // 2xl/4xl is the largest size that still fits one header row next to
    // the Back button and the Method/Boundary/Details step indicator.
    const headingMatch = pageTsx.match(
      /\{step === 'geometry' && \(\s*<Heading[\s\S]*?fontSize=\{\{ base: '(\w+)', md: '(\w+)' \}\}/
    );
    expect(headingMatch).not.toBeNull();
    expect(headingMatch?.[1]).not.toBe('xl');
    expect(headingMatch?.[2]).not.toBe('2xl');
  });

  it('does not repeat the same instruction as a static banner above the map', () => {
    // Reported: duplicate instructions on how to define the boundary.
    expect(pageTsx).not.toContain('Zoom in on the map until catchment boundaries appear');
    expect(pageTsx).not.toContain('Zoom in until catchments appear, then click to select them');
  });

  it('renders the live instructions as plain text in the title\'s old spot, not a floating pill on the map', () => {
    // Reported again: the instructions should read as clean text where the
    // big title used to sit, not a dark pill overlaid on the map.
    // SiteCreationMap no longer renders that overlay at all -- it reports
    // the current text up via onInstructionsChange, since it's the only
    // place that knows mode/selection/drawing state, and the page renders
    // it as plain Text.
    expect(mapTsx).not.toContain('{/* Instructions overlay */}');
    expect(mapTsx).toContain('onInstructionsChange?.(instructions);');
    expect(pageTsx).toContain('onInstructionsChange={setMapInstructions}');
    expect(pageTsx).toMatch(/\{step === 'geometry' && \(\s*<Box flex="0 0 auto" textAlign="center" mb=\{4\}>\s*<Text[^>]*>\s*\{mapInstructions\}/);
  });

  it('has no floating-particle decoration left to remove', () => {
    // Reported: get rid of the ugly sparkles.
    expect(pageTsx).not.toContain('Floating particles');
    expect(pageTsx).not.toContain('floatAnimation');
  });

  it('lets the geometry step go full-width instead of staying inside the fixed-width container', () => {
    // Reported: the map should be the full content area.
    expect(pageTsx).toMatch(/maxW=\{step === 'geometry' \? 'full' : 'container\.xl'\}/);
  });

  it('sizes the map with flex, not a viewport-height guess that can push the confirm button off-screen', () => {
    // First attempt at "full content area" used h="calc(100vh - 160px)" on
    // the geometry step's box. 100vh is the whole browser viewport, not
    // this component's own allotted slot below the app's real header/footer
    // chrome, so the guess overshot: the box ran taller than the visible
    // area, and the map's floating "Create Boundary" button (position:
    // absolute, bottom anchored) landed below the fold, reachable only by
    // scrolling. flex: 1 off the component's own 100%-height ancestor has
    // no chrome to guess at, so it can't make that mistake again.
    expect(pageTsx).not.toMatch(/[hH]="calc\(100vh/);
    expect(pageTsx).toContain("flex=\"1\"\n                minH=\"300px\"");
  });
});
