import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import LandingPage from '../components/LandingPage';
import { theme } from '../styles/theme';

/**
 * Returns the CSS declarations Chakra emitted for an element, by looking its
 * emotion class names up in the injected stylesheets. jsdom performs no layout,
 * so the declarations themselves are what we can assert on — and they are what
 * went wrong.
 */
function emittedCss(el: Element): string {
  const classes = el.className.toString().split(/\s+/).filter(Boolean);
  const sheets = Array.from(document.querySelectorAll('style'))
    .map((s) => s.textContent || '')
    .join('\n');

  return classes
    .flatMap((c) => sheets.match(new RegExp(`\\.${c}\\{[^}]*\\}`, 'g')) || [])
    .join(' ');
}

function findByText(container: HTMLElement, startsWith: string): HTMLElement {
  const el = Array.from(container.querySelectorAll('*')).find(
    (n) => n.children.length === 0 && n.textContent?.trim().startsWith(startsWith)
  );
  if (!el) throw new Error(`no leaf element starting with ${JSON.stringify(startsWith)}`);
  return el as HTMLElement;
}

describe('LandingPage', () => {
  it('renders the hero', () => {
    const { container } = render(
      <ChakraProvider theme={theme}>
        <LandingPage onNavigate={() => {}} />
      </ChakraProvider>
    );
    expect(container.textContent).toContain('Welcome to the African Landscape Futures Dashboard');
    expect(container.textContent).toContain("Science-based decision support for Africa's changing landscapes");
    expect(container.textContent).toContain('Use the Landscape Futures Dashboard to:');
  });

  it('has the client-requested hover text on every Explore card (#216)', () => {
    // The tooltip text only mounts in the DOM on hover (a Chakra Tooltip,
    // like several elsewhere in the app that don't reliably open on a
    // synthetic hover under jsdom) -- pinned at the source level instead.
    const source = readFileSync('src/components/LandingPage.tsx', 'utf8');
    expect(source).toContain(
      'Click here to visualise the opportunities and challenges of conserving biodiversity while taking advantage of carbon financing.',
    );
    expect(source).toContain(
      'Click here enable discussion about desired ecosystem states and the priorities and tensions that may exist within communities.',
    );
    expect(source).toContain(
      'Click here to examine the implications of different national policies for landscapes and people.',
    );
    expect(source).toContain(
      'Click here to reimagine African landscapes guided by what we value and futures we want to create.',
    );
  });

  /**
   * The hero paragraph sits in a column flex with align-items:center, where a
   * child with only a max-width is sized shrink-to-fit — the more fragile of
   * the two spellings. This pins the explicit width so it is not tidied away as
   * redundant.
   *
   * Note this is not what broke the desktop window: that was WebKitGTK honouring
   * the viewport meta tag, which desktop browsers ignore. See main.go.
   */
  it('gives every max-width-constrained hero paragraph a definite width', () => {
    const { container } = render(
      <ChakraProvider theme={theme}>
        <LandingPage onNavigate={() => {}} />
      </ChakraProvider>
    );

    const paragraph = findByText(container, 'This interactive tool brings together');
    const css = emittedCss(paragraph);

    expect(css, 'the paragraph should still be constrained').toContain('max-width:560px');
    expect(
      css,
      'a max-width without a width is shrink-to-fit, which WebKitGTK collapses — ' +
        'see the comment in LandingPage.tsx'
    ).toMatch(/(^|[;{ ])width:\s*100%/);
  });
});
