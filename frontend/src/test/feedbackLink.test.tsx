/**
 * The footer feedback/contact-us prompt (#216).
 *
 * Reported three times over: the landing page had lost its "contact us"
 * section (it was actually already pinned under every page via App.tsx,
 * just easy to miss); once noticed, it read as a low-effort single gray
 * line, not a call to action; and "click here" did nothing at all, because
 * the URL came from a build-time env var that this project's build
 * pipeline does not treat as a rebuild trigger, so an edited .env kept
 * silently shipping the old, unconfigured build. The URL is hardcoded now
 * -- there is only one form and no deployment that needs a different one.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import FeedbackLink from '../components/FeedbackLink';

afterEach(() => {
  cleanup();
});

describe('FeedbackLink', () => {
  it('is a live link to the feedback form, with the client-requested call to action', () => {
    const { container } = render(
      <ChakraProvider theme={theme}>
        <FeedbackLink />
      </ChakraProvider>,
    );
    expect(container.textContent).toContain(
      'We would love to know more about you and what you think of our tool',
    );
    expect(container.textContent).toContain('- click here...');
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute(
      'href',
      'https://docs.google.com/forms/d/e/1FAIpQLSeuKAoitOcZ4bfjEH906qiXKjhcrVUB-cE-QXR39QEfP3XHCA/viewform?usp=header',
    );
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });
});
