/**
 * The target editor as a docked panel.
 *
 * It used to be a modal: an overlay, centred, with every slider disabled and a
 * full-bleed spinner over the form for the duration of each recalculation. Two
 * things were wrong with that. The overlay hid the dials the editor exists to
 * drive, and the disable/re-enable cycle moved focus and scroll on every
 * change, so the user had to find their place again after each edit.
 *
 * These tests pin the replacement: a region docked in the right-hand slot, and
 * sliders that stay usable while a recalculation is in flight. They also pin
 * the live-update checkbox picking its default from the site's catchment count
 * while still yielding to an explicit choice.
 */
import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import ContentArea from '../components/ContentArea';
import {
  LIVE_UPDATE_CATCHMENT_THRESHOLD,
  loadLiveUpdatePreference,
  saveLiveUpdatePreference,
} from '../lib/liveTargetUpdate';
import { DEFAULT_PANE_STATES } from '../types';
import type { SiteIndicators } from '../types';

// The panes are irrelevant here and drag in MapView, deck.gl and maplibre.
vi.mock('../components/ViewPane', () => ({ default: () => <div data-testid="view-pane" /> }));

// An indicator column from metadata.csv, not a credential. Named for what it
// actually is: when this was called KEY, the opaque-looking string next to that
// name was enough for gitleaks' generic-api-key rule to report it as a secret.
const COLUMN = 'prop_X40_50Mgha';

vi.mock('../hooks/useApi', () => ({
  useAttributeDetails: () => ({ details: { [COLUMN]: 'Tree biomass 40-50Mgha' } }),
  useAttributeTargetInputs: () => ({ targetInputs: { [COLUMN]: true } }),
  useAttributeUnits: () => ({ units: { [COLUMN]: 'proportion' } }),
  useAttributeTargetRanges: () => ({ targetRanges: { [COLUMN]: { min: 0, max: 1 } } }),
  useAttributeVariableTypes: () => ({ variableTypes: { [COLUMN]: 'Trees' } }),
  useAttributeOrder: () => ({ order: { [COLUMN]: 1 } }),
}));

type Props = ComponentProps<typeof ContentArea>;

/**
 * The catchment count comes off the indicators themselves — it is the number
 * the backend rescores on every edit, so it is what the live-update default is
 * sized by.
 */
function indicators(
  catchmentCount: number,
  values: Record<string, number> = { [COLUMN]: 0.08 },
  ideal?: Record<string, number>,
): SiteIndicators {
  return {
    reference: Object.fromEntries(Object.keys(values).map((k) => [k, 0.5])),
    current: { ...values },
    ideal: { ...(ideal ?? values) },
    extractedAt: '2026-08-29T00:00:00Z',
    catchmentCount,
    totalAreaKm2: 120,
  };
}

function renderPanel(overrides: Partial<Props> = {}) {
  const onSiteIndicatorsChange = vi.fn(async (_indicators: SiteIndicators) => {});
  const props: Props = {
    mode: 'single',
    paneStates: DEFAULT_PANE_STATES,
    viewModes: DEFAULT_PANE_STATES.map(() => 'dial' as const),
    onViewModeChange: vi.fn(),
    focusedPane: 0,
    onFocusPane: vi.fn(),
    onGoQuad: vi.fn(),
    onRemovePane: vi.fn(),
    colorScaleMode: 'metadata',
    colorScaleType: 'linear',
    isTargetModalOpen: true,
    onCloseTargetModal: vi.fn(),
    onSiteIndicatorsChange,
    siteIndicators: indicators(5),
    ...overrides,
  };
  render(
    <ChakraProvider theme={theme}>
      <ContentArea {...props} />
    </ChakraProvider>,
  );
  return { onSiteIndicatorsChange, props };
}

/**
 * Expand a target group and hand back its slider.
 *
 * `hidden: true` is needed because Chakra collapses an AccordionPanel with
 * framer-motion, whose animation never runs under jsdom — the panel is left at
 * `display: none` however many times it is clicked, so the default
 * accessibility filter excludes everything inside it. The expansion itself is
 * Chakra's behaviour, not this component's; what these tests are after is the
 * slider's own wiring.
 */
function expandGroupSlider(name: string) {
  fireEvent.click(screen.getByRole('button', { name: new RegExp(name) }));
  return screen.getByRole('slider', { hidden: true });
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the docked panel', () => {
  it('is a region rather than a modal dialog', () => {
    renderPanel();
    // A dialog would trap focus and darken the dials behind it. The editor is
    // meant to be worked alongside them, not on top of them.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('region', { name: 'Edit Target Values' })).toBeInTheDocument();
  });

  it('renders a slider for each editable target', () => {
    renderPanel();
    expect(screen.getByText('Tree biomass 40-50Mgha')).toBeInTheDocument();
    expect(expandGroupSlider('Trees')).toBeInTheDocument();
  });

  it('leaves the sliders enabled while a recalculation runs', async () => {
    // Never resolves, so the component stays in its "recalculating" state for
    // the whole assertion.
    const onSiteIndicatorsChange = vi.fn(() => new Promise<void>(() => {}));
    renderPanel({ onSiteIndicatorsChange });

    const slider = expandGroupSlider('Trees');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onSiteIndicatorsChange).toHaveBeenCalled();

    // The disabling was the "redraw": it moved focus off the thumb and took
    // the scroll position with it.
    expect(screen.getByRole('slider', { hidden: true })).not.toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Recalculating…')).toBeInTheDocument();
  });

  it('does not let a slider grab focus when its value changes', () => {
    // Chakra focuses a thumb on every value change, with a bare .focus() that
    // scrolls it into view. A recalculation cascades into the other sliders'
    // values, so releasing one drag used to throw focus onto an unrelated
    // slider and scroll the panel away from where the user was working.
    renderPanel();
    const slider = expandGroupSlider('Trees');
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(document.activeElement).not.toBe(slider);
  });

  it('submits only the target the user actually moved', () => {
    const { onSiteIndicatorsChange } = renderPanel({
      siteIndicators: indicators(5, { [COLUMN]: 0.08, other: 3 }),
    });
    fireEvent.keyDown(expandGroupSlider('Trees'), { key: 'ArrowRight' });

    const submitted = onSiteIndicatorsChange.mock.calls[0][0];
    // `other` keeps its existing value rather than being resubmitted as an
    // edit — telling the backend every indicator changed at once derails the
    // cascade for the one being edited.
    expect(submitted.ideal.other).toBe(3);
    expect(submitted.ideal[COLUMN]).toBeGreaterThan(0.08);
  });
});

describe('the live update checkbox', () => {
  const box = () => screen.getByRole('checkbox', { name: /live update/i });

  it('is ticked by default on a site at or under the threshold', () => {
    renderPanel({ siteIndicators: indicators(LIVE_UPDATE_CATCHMENT_THRESHOLD) });
    expect(box()).toBeChecked();
  });

  it('is unticked by default on a larger site', () => {
    renderPanel({ siteIndicators: indicators(LIVE_UPDATE_CATCHMENT_THRESHOLD + 1) });
    expect(box()).not.toBeChecked();
  });

  it('honours a stored choice over the catchment count, in both directions', () => {
    saveLiveUpdatePreference(true);
    renderPanel({ siteIndicators: indicators(400) });
    expect(box()).toBeChecked();
    cleanup();

    saveLiveUpdatePreference(false);
    renderPanel({ siteIndicators: indicators(2) });
    expect(box()).not.toBeChecked();
  });

  it('remembers the choice', () => {
    renderPanel({ siteIndicators: indicators(2) });
    expect(box()).toBeChecked();

    fireEvent.click(box());
    expect(box()).not.toBeChecked();
    // Stateful across sessions: the point of the control is overruling a guess
    // that does not match the machine or the network, and being asked to
    // overrule it again on every reload would defeat that.
    expect(loadLiveUpdatePreference()).toBe(false);
  });
});

describe('resetting the target set', () => {
  const resetButton = (name: RegExp) => screen.getByRole('button', { name });

  it('offers a reset to each observed scenario', () => {
    renderPanel();
    expect(resetButton(/reset to reference/i)).toBeInTheDocument();
    expect(resetButton(/reset to current/i)).toBeInTheDocument();
  });

  it('asks before discarding target work, in the panel rather than a dialog', () => {
    const { onSiteIndicatorsChange } = renderPanel();
    fireEvent.click(resetButton(/reset to reference/i));

    // Nothing has happened yet — the first click only poses the question.
    expect(onSiteIndicatorsChange).not.toHaveBeenCalled();
    expect(screen.getByText(/Set every target to the reference\?/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does nothing when the confirmation is declined', () => {
    const { onSiteIndicatorsChange } = renderPanel();
    fireEvent.click(resetButton(/reset to reference/i));
    fireEvent.click(resetButton(/cancel/i));

    expect(onSiteIndicatorsChange).not.toHaveBeenCalled();
    expect(resetButton(/reset to reference/i)).toBeInTheDocument();
  });

  it('sets every editable target to the reference once confirmed', () => {
    const { onSiteIndicatorsChange } = renderPanel({
      siteIndicators: indicators(5, { [COLUMN]: 0.08 }),
    });
    fireEvent.click(resetButton(/reset to reference/i));
    fireEvent.click(resetButton(/^reset$/i));

    const submitted = onSiteIndicatorsChange.mock.calls[0][0];
    // indicators() puts every reference at 0.5.
    expect(submitted.ideal[COLUMN]).toBe(0.5);
  });

  it('clears a target by resetting it to current', () => {
    // A site with a target already set: ideal has diverged from current.
    const { onSiteIndicatorsChange } = renderPanel({
      siteIndicators: indicators(5, { [COLUMN]: 0.08 }, { [COLUMN]: 0.42 }),
    });
    fireEvent.click(resetButton(/reset to current/i));
    fireEvent.click(resetButton(/^reset$/i));

    const submitted = onSiteIndicatorsChange.mock.calls[0][0];
    // Ideal back on current means no divergence, which is what makes the dials
    // stop showing a target at all.
    expect(submitted.ideal[COLUMN]).toBe(0.08);
  });

  it('submits nothing when the targets already sit on the scenario asked for', () => {
    // Resetting to current when nothing has diverged is a no-op, and must not
    // cost a recalculation that rescores every catchment for no change.
    const { onSiteIndicatorsChange } = renderPanel({
      siteIndicators: indicators(5, { [COLUMN]: 0.08 }),
    });
    fireEvent.click(resetButton(/reset to current/i));
    fireEvent.click(resetButton(/^reset$/i));
    expect(onSiteIndicatorsChange).not.toHaveBeenCalled();
  });
});
