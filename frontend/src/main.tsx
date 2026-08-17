import React from 'react';
import ReactDOM from 'react-dom/client';
import { ChakraProvider, ColorModeScript } from '@chakra-ui/react';
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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ColorModeScript initialColorMode={theme.config.initialColorMode} />
    <ChakraProvider theme={theme}>
      <ErrorBoundary>
        <App />
        <TourGuide />
        <MunywanaDemoTour />
        <ShaiHillsDemoTour />
        <ViphyaDemoTour />
        <AfricaDemoTour />
      </ErrorBoundary>
    </ChakraProvider>
  </React.StrictMode>,
);
