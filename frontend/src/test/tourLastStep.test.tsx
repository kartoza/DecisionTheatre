/**
 * Every guided tour's last step now offers an explicit next action (#219).
 *
 * Reported: tours ended by just dismissing, leaving the user to work out on
 * their own how to leave the tour or start creating a site. Both tour
 * components (DemoTour, used by the four site-specific demos, and the
 * separate onboarding TourGuide) navigate by dispatching a `dt:navigate`
 * CustomEvent, caught by App.tsx's handleNavigate -- these tests assert on
 * that event rather than on page content, since neither component owns the
 * navigation itself.
 *
 * Every step change is asserted with `findBy*` (not `getBy*`): both
 * components key their step card by step index under an AnimatePresence
 * `mode="wait"`, whose exit/enter swap does not resolve synchronously under
 * jsdom -- asserting immediately after a click reliably still finds the
 * *previous* step's content.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { FiMap, FiCheckCircle } from 'react-icons/fi';
import { theme } from '../styles/theme';
import DemoTour, { type DemoStep } from '../components/DemoTour';
import TourGuide from '../components/TourGuide';

const DEMO_STEPS: DemoStep[] = [
  { icon: <FiMap />, title: 'Step one', description: 'first' },
  { icon: <FiCheckCircle />, title: 'Your Turn to Explore', description: 'last' },
];

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('[]', { headers: { 'content-type': 'application/json' } })),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function navigateSpy() {
  const handler = vi.fn();
  window.addEventListener('dt:navigate', handler);
  return { handler, cleanup: () => window.removeEventListener('dt:navigate', handler) };
}

describe('DemoTour last step', () => {
  it('only offers Back to main page / Create a site on the last step', async () => {
    render(
      <ChakraProvider theme={theme}>
        <DemoTour siteId="test-site" startEvent="dt:test-demo-start" steps={DEMO_STEPS} loadSiteStep={99} />
      </ChakraProvider>,
    );
    fireEvent(window, new Event('dt:test-demo-start'));

    expect(screen.queryByText('Back to main page')).toBeNull();
    expect(screen.queryByText('Create a site')).toBeNull();
    expect(await screen.findByText('Next')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Next'));

    expect(await screen.findByText('Back to main page')).toBeInTheDocument();
    expect(screen.getByText('Create a site')).toBeInTheDocument();
    expect(screen.queryByText('Next')).toBeNull();
  });

  it('"Back to main page" navigates to landing and dismisses the tour', async () => {
    render(
      <ChakraProvider theme={theme}>
        <DemoTour siteId="test-site" startEvent="dt:test-demo-start" steps={DEMO_STEPS} loadSiteStep={99} />
      </ChakraProvider>,
    );
    fireEvent(window, new Event('dt:test-demo-start'));
    fireEvent.click(await screen.findByText('Next'));

    const spy = navigateSpy();
    fireEvent.click(await screen.findByText('Back to main page'));
    spy.cleanup();

    expect(spy.handler).toHaveBeenCalledTimes(1);
    expect((spy.handler.mock.calls[0][0] as CustomEvent).detail).toBe('landing');
    await waitFor(() => expect(screen.queryByText('Your Turn to Explore')).toBeNull());
  });

  it('"Create a site" navigates to create-site and dismisses the tour', async () => {
    render(
      <ChakraProvider theme={theme}>
        <DemoTour siteId="test-site" startEvent="dt:test-demo-start" steps={DEMO_STEPS} loadSiteStep={99} />
      </ChakraProvider>,
    );
    fireEvent(window, new Event('dt:test-demo-start'));
    fireEvent.click(await screen.findByText('Next'));

    const spy = navigateSpy();
    fireEvent.click(await screen.findByText('Create a site'));
    spy.cleanup();

    expect(spy.handler).toHaveBeenCalledTimes(1);
    expect((spy.handler.mock.calls[0][0] as CustomEvent).detail).toBe('create-site');
    await waitFor(() => expect(screen.queryByText('Your Turn to Explore')).toBeNull());
  });

  it('"Close" still just dismisses without navigating, for anyone who wants to keep exploring', async () => {
    render(
      <ChakraProvider theme={theme}>
        <DemoTour siteId="test-site" startEvent="dt:test-demo-start" steps={DEMO_STEPS} loadSiteStep={99} />
      </ChakraProvider>,
    );
    fireEvent(window, new Event('dt:test-demo-start'));
    fireEvent.click(await screen.findByText('Next'));
    await screen.findByText('Back to main page');

    const spy = navigateSpy();
    fireEvent.click(screen.getByText('Close'));
    spy.cleanup();

    expect(spy.handler).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Your Turn to Explore')).toBeNull());
  });

  it('progress dots are keyboard/screen-reader reachable, and jump straight to a step', async () => {
    render(
      <ChakraProvider theme={theme}>
        <DemoTour siteId="test-site" startEvent="dt:test-demo-start" steps={DEMO_STEPS} loadSiteStep={99} />
      </ChakraProvider>,
    );
    fireEvent(window, new Event('dt:test-demo-start'));
    await screen.findByText('Step one');

    fireEvent.click(screen.getByRole('button', { name: 'Go to step 2 of 2: Your Turn to Explore' }));

    expect(await screen.findByText('Create a site')).toBeInTheDocument();
  });
});

describe('TourGuide last step', () => {
  it('offers Back to main page / Create a site once it reaches its last step', async () => {
    render(
      <ChakraProvider theme={theme}>
        <TourGuide />
      </ChakraProvider>,
    );
    // Auto-visible for a first-time visitor (empty localStorage, see beforeEach).
    // Jump straight to the last step via its progress dot -- clicking through
    // with Next would pass through the "Define Your Boundary" step, which
    // kicks off real site-creation API calls this test isn't exercising.
    fireEvent.click(await screen.findByRole('button', { name: /Go to step 8 of 8/ }));

    expect(await screen.findByText('Back to main page')).toBeInTheDocument();
    expect(screen.getByText('Create a site')).toBeInTheDocument();
  });

  it('"Create a site" navigates to create-site and dismisses the tour', async () => {
    render(
      <ChakraProvider theme={theme}>
        <TourGuide />
      </ChakraProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Go to step 8 of 8/ }));
    await screen.findByText('Back to main page');

    const spy = navigateSpy();
    fireEvent.click(screen.getByText('Create a site'));
    spy.cleanup();

    expect(spy.handler).toHaveBeenCalledTimes(1);
    expect((spy.handler.mock.calls[0][0] as CustomEvent).detail).toBe('create-site');
    await waitFor(() => expect(screen.queryByText('Documentation')).toBeNull());
  });
});
