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

    expect(screen.getByText('Decision Theatre')).toBeInTheDocument();
  });
});
