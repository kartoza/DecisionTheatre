/**
 * The collapse/close affordance shared by every docked right-hand panel.
 * Reported: it should be "more than just a simple > character" -- a circle
 * in the site's own orange, with the chevron pointing the opposite way a
 * plain ">" would.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import { colors } from '../styles/colors';
import PanelCollapseButton from '../components/PanelCollapseButton';

const SOURCE = readFileSync('src/components/PanelCollapseButton.tsx', 'utf8');

afterEach(() => {
  cleanup();
});

describe('PanelCollapseButton', () => {
  it('is filled with the site orange, not a plain ghost button', () => {
    render(
      <ChakraProvider theme={theme}>
        <PanelCollapseButton onClick={() => {}} />
      </ChakraProvider>,
    );
    const button = screen.getByRole('button', { name: 'Collapse panel' });
    expect(button).toHaveStyle({ backgroundColor: colors.orange });
  });

  it('renders a real icon, not a plain ">" text character', () => {
    const { container } = render(
      <ChakraProvider theme={theme}>
        <PanelCollapseButton onClick={() => {}} />
      </ChakraProvider>,
    );
    expect(container.querySelector('svg')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Collapse panel' }).textContent).not.toContain('>');
  });

  it('still points right, like the plain ">" it replaces -- only the colours are inverted', () => {
    expect(SOURCE).toContain('FiChevronRight');
    expect(SOURCE).not.toContain('FiChevronLeft');
  });

  it('is a filled circle (borderRadius="full"), not the plain ghost variant', () => {
    expect(SOURCE).toContain('borderRadius="full"');
    expect(SOURCE).not.toContain('variant="ghost"');
  });

  it('calls onClick when pressed', () => {
    const onClick = vi.fn();
    render(
      <ChakraProvider theme={theme}>
        <PanelCollapseButton onClick={onClick} />
      </ChakraProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Collapse panel' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('accepts a custom label, for panels that call this something other than "collapse"', () => {
    render(
      <ChakraProvider theme={theme}>
        <PanelCollapseButton onClick={() => {}} label="Close target editor" />
      </ChakraProvider>,
    );
    expect(screen.getByRole('button', { name: 'Close target editor' })).toBeInTheDocument();
  });
});
