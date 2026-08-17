import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import App from '../App';
import { theme } from '../styles/theme';

describe('App', () => {
  it('renders without crashing', () => {
    render(
      <ChakraProvider theme={theme}>
        <App />
      </ChakraProvider>
    );

    // Assert on the header landmark rather than a brand string: the title text
    // has since been replaced by partner logos, and this test only claims that
    // the app mounts. A landmark survives rebranding; a text node does not.
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });
});
