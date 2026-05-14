import React from 'react';
import ReactDOM from 'react-dom/client';
import { ChakraProvider, ColorModeScript } from '@chakra-ui/react';
import App from './App';
import TourGuide from './components/TourGuide';
import ErrorBoundary from './components/ErrorBoundary';
import { theme } from './styles/theme';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ColorModeScript initialColorMode={theme.config.initialColorMode} />
    <ChakraProvider theme={theme}>
      <ErrorBoundary>
        <App />
        <TourGuide />
      </ErrorBoundary>
    </ChakraProvider>
  </React.StrictMode>,
);
