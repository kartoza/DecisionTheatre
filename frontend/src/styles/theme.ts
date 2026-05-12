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
      50:  '#FFF3E8',
      100: '#FDE3C4',
      200: '#FBC77A',
      300: '#F5A355',
      400: '#F09840',
      500: '#E88930',
      600: '#D8832A',
      700: '#B06818',
      800: '#885010',
      900: '#603808',
    },
  },
  fonts: {
    heading: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
    body: '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
  },
  components: {
    Button: {
      baseStyle: {
        borderRadius: 'full',
        fontWeight: 'semibold',
        fontSize: 'sm',
        transition: 'all 0.2s',
        _hover: {
          transform: 'translateY(-1px)',
          _disabled: { transform: 'none' },
        },
        _active: {
          transform: 'translateY(0)',
        },
      },
      defaultProps: {
        colorScheme: 'accent',
        variant: 'solid',
      },
    },
    Select: {
      defaultProps: {
        focusBorderColor: 'brand.500',
      },
    },
  },
});
