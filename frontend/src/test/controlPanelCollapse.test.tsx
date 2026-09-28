/**
 * Reported: the indicator panel should have a collapse chevron too.
 * It used to be hidden specifically in single-pane layout ("no per-pane
 * 'Configure factor' button to reopen it the way grid view has one") --
 * that reopen path exists for every layout now (ViewPane.tsx), so the
 * collapse button shows unconditionally by default.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import ControlPanel from '../components/ControlPanel';
import type { ComparisonState } from '../types';

const comparison: ComparisonState = {
  leftScenario: 'reference',
  rightScenario: 'current',
  attribute: '',
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      // useColumns() expects an array; every other metadata hook this panel
      // uses expects an object map -- {} would break `.map()` calls on the
      // columns list.
      const body = url.includes('/columns') ? '[]' : '{}';
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPanel(props: Partial<React.ComponentProps<typeof ControlPanel>> = {}) {
  return render(
    <ChakraProvider theme={theme}>
      <ControlPanel
        isOpen
        onClose={() => {}}
        comparison={comparison}
        onLeftChange={() => {}}
        onRightChange={() => {}}
        onAttributeChange={() => {}}
        paneIndex={0}
        colorScaleMode="rainbow"
        colorScaleType="linear"
        onColorScaleTypeChange={() => {}}
        {...props}
      />
    </ChakraProvider>,
  );
}

describe('ControlPanel collapse button', () => {
  it('shows by default (canCollapse defaults to true)', async () => {
    renderPanel();
    expect(await screen.findByRole('button', { name: 'Collapse panel' })).toBeInTheDocument();
  });

  it('can still be explicitly hidden if a future caller passes canCollapse={false}', () => {
    renderPanel({ canCollapse: false });
    expect(screen.queryByRole('button', { name: 'Collapse panel' })).not.toBeInTheDocument();
  });
});
