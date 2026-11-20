// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Below 500px, Home/My Sites/Download/Clear cache/Documentation no longer
 * fit beside the site title and the grid controls, so they move into a
 * single overflow menu rather than disappearing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react';
import { ChakraProvider } from '@chakra-ui/react';
import { theme } from '../styles/theme';
import Header from '../components/Header';

function setWindowWidth(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => { window.dispatchEvent(new Event('resize')); });
}

afterEach(() => {
  cleanup();
  setWindowWidth(1024);
});

describe('Header overflow menu at 500px and below', () => {
  it('hides Home, My Sites, Download, Clear cache and Documentation and moves them into "More options" at 500px', async () => {
    setWindowWidth(500);
    render(
      <ChakraProvider theme={theme}>
        <Header onToggleDocs={() => {}} isDocsOpen={false} onNavigate={() => {}} currentPage="map" />
      </ChakraProvider>,
    );
    expect(screen.queryByLabelText('Go to home')).toBeNull();
    expect(screen.queryByLabelText('Go to sites')).toBeNull();
    expect(screen.queryByLabelText('Download')).toBeNull();
    expect(screen.queryByLabelText('Clear cache')).toBeNull();
    expect(screen.queryByLabelText('Toggle documentation')).toBeNull();

    fireEvent.click(screen.getByLabelText('More options'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Home')).toBeInTheDocument();
    expect(within(menu).getByText('My Sites')).toBeInTheDocument();
    expect(within(menu).getByText('Download')).toBeInTheDocument();
    expect(within(menu).getByText('Clear cache')).toBeInTheDocument();
    expect(within(menu).getByText('Show documentation')).toBeInTheDocument();
  });

  it('shows the inline buttons again above 500px, with no overflow menu', () => {
    setWindowWidth(501);
    render(
      <ChakraProvider theme={theme}>
        <Header onToggleDocs={() => {}} isDocsOpen={false} onNavigate={() => {}} currentPage="map" />
      </ChakraProvider>,
    );
    expect(screen.getByLabelText('Go to home')).toBeInTheDocument();
    expect(screen.getByLabelText('Go to sites')).toBeInTheDocument();
    expect(screen.getByLabelText('Download')).toBeInTheDocument();
    expect(screen.getByLabelText('Clear cache')).toBeInTheDocument();
    expect(screen.getByLabelText('Toggle documentation')).toBeInTheDocument();
    expect(screen.queryByLabelText('More options')).toBeNull();
  });

  it('omits Home on the landing page itself, inline and in the menu', async () => {
    setWindowWidth(500);
    render(
      <ChakraProvider theme={theme}>
        <Header onToggleDocs={() => {}} isDocsOpen={false} onNavigate={() => {}} currentPage="landing" />
      </ChakraProvider>,
    );
    fireEvent.click(screen.getByLabelText('More options'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByText('Home')).toBeNull();
    expect(within(menu).getByText('My Sites')).toBeInTheDocument();
  });

  it('hides Edit site boundary and moves it into "More options" at 500px', async () => {
    setWindowWidth(500);
    render(
      <ChakraProvider theme={theme}>
        <Header
          onToggleDocs={() => {}}
          isDocsOpen={false}
          onNavigate={() => {}}
          currentPage="map"
          siteTitle="Test Site"
          onEditBoundary={() => {}}
        />
      </ChakraProvider>,
    );
    expect(screen.queryByLabelText('Edit site boundary')).toBeNull();

    fireEvent.click(screen.getByLabelText('More options'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Edit site boundary')).toBeInTheDocument();
  });

  it('shows Edit site boundary inline again above 500px', () => {
    setWindowWidth(501);
    render(
      <ChakraProvider theme={theme}>
        <Header
          onToggleDocs={() => {}}
          isDocsOpen={false}
          onNavigate={() => {}}
          currentPage="map"
          siteTitle="Test Site"
          onEditBoundary={() => {}}
        />
      </ChakraProvider>,
    );
    expect(screen.getByLabelText('Edit site boundary')).toBeInTheDocument();
  });

  it('reads "Exit edit mode" in the menu while boundary editing is active', async () => {
    setWindowWidth(500);
    render(
      <ChakraProvider theme={theme}>
        <Header
          onToggleDocs={() => {}}
          isDocsOpen={false}
          onNavigate={() => {}}
          currentPage="map"
          siteTitle="Test Site"
          onEditBoundary={() => {}}
          isBoundaryEditMode
        />
      </ChakraProvider>,
    );
    fireEvent.click(screen.getByLabelText('More options'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Exit edit mode')).toBeInTheDocument();
  });
});
