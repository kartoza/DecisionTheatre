/**
 * Reported: "When you edit the targets, the walkthrough text disappears,
 * and I don't know how to get it back." The tour used to hide itself
 * entirely while the targets panel was open (and a separate bug in the
 * pairing that brought it back could leave it hidden for good after
 * navigating away mid-edit -- see App.tsx's isTargetModalOpen effect for
 * that half). Corrected direction, from a screen recording: the dialog
 * should just stay visible the whole time a target is being edited --
 * editing a target and reading the tour are not mutually exclusive, and
 * the docked panel (right side) never overlaps the tour box (bottom left)
 * anyway. Opening the panel still advances a step that was waiting for
 * exactly that action.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, act, waitFor } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import DemoTour from '../components/DemoTour';

afterEach(() => {
  cleanup();
});

const steps = [
  { icon: <span />, title: 'Step one', description: 'The first thing to look at.' },
  { icon: <span />, title: 'Step two', description: 'Now open the targets panel.' },
];

function renderTour() {
  return render(
    <ChakraProvider theme={theme}>
      <DemoTour
        siteId="test-site"
        startEvent="dt:test-tour-start"
        steps={steps}
        // Off the end of `steps`, so advancing never coincides with it and
        // tries to fetch a real walkthrough site -- not what's under test.
        loadSiteStep={99}
        // Step 0 ("Step one") is the one that instructs opening the
        // targets panel; opening it should advance to step 1 ("Step two"),
        // without ever hiding the dialog in between.
        targetsModalAdvanceSteps={[0]}
      />
    </ChakraProvider>,
  );
}

describe('the guided tour and the targets panel', () => {
  it('stays visible while the targets panel is open', async () => {
    renderTour();
    act(() => { window.dispatchEvent(new Event('dt:test-tour-start')); });
    expect(screen.getByText('Step one')).toBeInTheDocument();

    act(() => { window.dispatchEvent(new Event('dt:targets-modal-opened')); });
    // Synchronously, before framer-motion's exit transition resolves: the
    // dialog is still on screen (the old failure mode was disappearing
    // entirely, i.e. the component returning null here).
    expect(screen.getByText(/Step (one|two)/)).toBeInTheDocument();
    // The step-advance itself completes once the exit transition does.
    await waitFor(() => expect(screen.getByText('Step two')).toBeInTheDocument());
  });

  it('remains visible even with no matching "closed" event ever arriving', async () => {
    // The exact scenario that used to leave the tour stuck hidden: the
    // panel is opened and never explicitly closed (e.g. the user navigates
    // away). There is nothing to get stuck now, since nothing hides it.
    renderTour();
    act(() => { window.dispatchEvent(new Event('dt:test-tour-start')); });
    act(() => { window.dispatchEvent(new Event('dt:targets-modal-opened')); });
    await waitFor(() => expect(screen.getByText('Step two')).toBeInTheDocument());
  });

  it('does not advance the step when no step is waiting for the panel to open', () => {
    render(
      <ChakraProvider theme={theme}>
        <DemoTour
          siteId="test-site"
          startEvent="dt:test-tour-start-2"
          steps={steps}
          targetsModalAdvanceSteps={[]}
        />
      </ChakraProvider>,
    );
    act(() => { window.dispatchEvent(new Event('dt:test-tour-start-2')); });
    expect(screen.getByText('Step one')).toBeInTheDocument();

    act(() => { window.dispatchEvent(new Event('dt:targets-modal-opened')); });
    expect(screen.getByText('Step one')).toBeInTheDocument();
  });
});
