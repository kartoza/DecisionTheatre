import { extendTheme, type ThemeConfig } from '@chakra-ui/react';

const config: ThemeConfig = {
  initialColorMode: 'dark',
  useSystemColorMode: false,
};

export const theme = extendTheme({
  config,
  styles: {
    global: {
      'html, body': {
        margin: 0,
        padding: 0,
        height: '100%',
        overflow: 'hidden',
        bg: 'gray.900',
        color: 'white',
      },
      '#root': {
        height: '100%',
      },
    },
  },
  colors: {
    brand: {
      50: '#e3f8ff',
      100: '#b3ecff',
      200: '#81defd',
      300: '#5ed0fa',
      400: '#40c3f7',
      500: '#2bb0ed',
      600: '#1992d4',
      700: '#127fbf',
      800: '#0b69a3',
      900: '#035388',
    },
    accent: {
      50: '#fff3e0',
      100: '#ffe0b2',
      200: '#ffcc80',
      300: '#ffb74d',
      400: '#ffa726',
      500: '#ff9800',
      600: '#fb8c00',
      700: '#f57c00',
      800: '#ef6c00',
      900: '#e65100',
    },
  },
  fonts: {
    heading: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
    body: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
  },
  components: {
    Button: {
      defaultProps: {
        colorScheme: 'brand',
      },
    },
    Select: {
      defaultProps: {
        focusBorderColor: 'brand.500',
      },
    },
  },
});
