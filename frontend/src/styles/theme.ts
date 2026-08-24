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
      50: '#3dcde1',
      100: '#3dcde1',
      200: '#3dcde1',
      300: '#3dcde1',
      400: '#3dcde1',
      500: '#3dcde1',
      600: '#3dcde1',
      700: '#3dcde1',
      800: '#3dcde1',
      900: '#3dcde1',
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
        // The corner every button in the application inherits. This was 'full',
        // which made pills of the controls that sit in dense rows — the header
        // icon bar, the range switch, the aggregate table's toggle — so each of
        // those had begun overriding it separately. Setting it here means a
        // button is consistent by default rather than by remembering.
        borderRadius: 'md',
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
