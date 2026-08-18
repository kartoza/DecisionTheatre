import React from 'react';
import ReactDOM from 'react-dom/client';
import { ChakraProvider, ColorModeScript } from '@chakra-ui/react';
import { MotionConfig } from 'framer-motion';
import App from './App';
import TourGuide from './components/TourGuide';
import MunywanaDemoTour from './components/MunywanaDemoTour';
import ShaiHillsDemoTour from './components/ShaiHillsDemoTour';
import ViphyaDemoTour from './components/ViphyaDemoTour';
import AfricaDemoTour from './components/AfricaDemoTour';
import ErrorBoundary from './components/ErrorBoundary';
import { theme } from './styles/theme';

// Self-hosted typefaces. Imported here rather than linked from index.html so
// Vite fingerprints and bundles them, and so no build or launch reaches out to
// a font CDN — the desktop application is offline by design.
import './assets/fonts/fonts.css';

// Global error reporting, development only.
//
// index.html used to install these handlers and inject a fixed red block holding
// the full stack trace into the live page — internal file paths and frame details
// shown to whoever happened to be using the application. In production the React
// error boundary is the recovery path, and anything outside React reaches the
// console, where a developer can find it.
//
// `import.meta.env.DEV` is a compile-time constant, so this whole block is removed
// from a production bundle rather than merely skipped at runtime.
if (import.meta.env.DEV) {
  const banner = (title: string, detail: string, background: string) => {
    const pre = document.createElement('pre');
    pre.dataset.devErrorBanner = 'true';
    pre.style.cssText =
      `position:fixed;top:0;left:0;right:0;background:${background};color:white;` +
      'padding:1em;z-index:99999;font-size:14px;white-space:pre-wrap;';
    pre.textContent = `${title}\n${detail}`;
    document.body.appendChild(pre);
  };

  window.addEventListener('error', (event) => {
    banner(
      `JS Error: ${event.message}`,
      `${event.filename}:${event.lineno}:${event.colno}\n${event.error?.stack ?? ''}`,
      'red',
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    banner('Unhandled promise rejection', String(event.reason?.stack ?? event.reason), 'darkred');
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ColorModeScript initialColorMode={theme.config.initialColorMode} />
    <ChakraProvider theme={theme}>
      {/*
        Honour prefers-reduced-motion across every animation at once.

        There are 157 framer-motion call sites across 14 files and none consulted
        the setting. reducedMotion="user" makes framer-motion read the media query
        and skip transform and layout animations for anyone who has asked for
        that — an accessibility obligation under the project's WCAG 2.2 AA target,
        independent of the performance argument.

        One provider rather than 157 edits: it also means a new animation added
        later is covered without anyone remembering to do anything.
      */}
      <MotionConfig reducedMotion="user">
        <ErrorBoundary>
          <App />
          <TourGuide />
          <MunywanaDemoTour />
          <ShaiHillsDemoTour />
          <ViphyaDemoTour />
          <AfricaDemoTour />
        </ErrorBoundary>
      </MotionConfig>
    </ChakraProvider>
  </React.StrictMode>,
);
