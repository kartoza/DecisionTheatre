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
    expect(container.textContent).toContain('Welcome to the Landscape Decision Dashboard');
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
