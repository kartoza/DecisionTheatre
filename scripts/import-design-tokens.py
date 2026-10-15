#!/usr/bin/env python3
# SPDX-FileCopyrightText: 2026 Kartoza
# SPDX-License-Identifier: AGPL-3.0-only

"""
Import design tokens from Figma (JSON format) and generate Chakra UI theme.

This script reads design tokens exported from Figma (via Tokens Studio or similar)
and generates the corresponding TypeScript theme file for Chakra UI.

Usage:
    python3 scripts/import-design-tokens.py [--input design-tokens.json] [--output frontend/src/styles/theme.ts]

The designer exports tokens from Figma using Tokens Studio plugin in JSON format.
This script transforms them into the Chakra UI theme format.
"""

import json
import argparse
import sys
from pathlib import Path
from typing import Any


def extract_color_value(token: Any) -> str:
    """Extract color value from token (handles both simple and complex formats)."""
    if isinstance(token, dict):
        return token.get('value', token.get('$value', ''))
    return str(token)


def parse_color_palette(colors: dict, palette_name: str) -> dict:
    """Parse a color palette from tokens format to Chakra format."""
    palette = colors.get(palette_name, {})
    result = {}

    for key, value in palette.items():
        if key.startswith('$') or key == 'description':
            continue
        color_value = extract_color_value(value)
        if color_value:
            result[key] = color_value

    return result


def generate_theme_ts(tokens: dict) -> str:
    """Generate Chakra UI theme TypeScript from design tokens."""

    colors = tokens.get('colors', {})
    typography = tokens.get('typography', {})

    # Extract color palettes
    brand = parse_color_palette(colors, 'brand')
    accent = parse_color_palette(colors, 'accent')

    # Build the theme file
    theme_content = '''import { extendTheme, type ThemeConfig } from '@chakra-ui/react';

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
'''

    # Add brand colors
    for shade in ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900']:
        if shade in brand:
            theme_content += f"      {shade}: '{brand[shade]}',\n"

    theme_content += '''    },
    accent: {
'''

    # Add accent colors
    for shade in ['50', '100', '200', '300', '400', '500', '600', '700', '800', '900']:
        if shade in accent:
            theme_content += f"      {shade}: '{accent[shade]}',\n"

    theme_content += '''    },
  },
  fonts: {
'''

    # Add typography
    font_family = typography.get('fontFamily', {})
    heading_font = extract_color_value(font_family.get('heading', {})) or '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif'
    body_font = extract_color_value(font_family.get('body', {})) or '"Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif'

    theme_content += f'''    heading: '{heading_font}',
    body: '{body_font}',
  }},
  components: {{
    Button: {{
      defaultProps: {{
        colorScheme: 'brand',
      }},
    }},
    Select: {{
      defaultProps: {{
        focusBorderColor: 'brand.500',
      }},
    }},
  }},
}});
'''

    return theme_content


def generate_css_variables(tokens: dict) -> str:
    """Generate CSS custom properties from design tokens for non-Chakra components."""

    colors = tokens.get('colors', {})

    css = ''':root {
  /* Brand Colors */
'''

    brand = parse_color_palette(colors, 'brand')
    for shade, value in brand.items():
        css += f'  --color-brand-{shade}: {value};\n'

    css += '\n  /* Accent Colors */\n'
    accent = parse_color_palette(colors, 'accent')
    for shade, value in accent.items():
        css += f'  --color-accent-{shade}: {value};\n'

    # Scenario colors
    scenarios = colors.get('scenarios', {})
    if scenarios:
        css += '\n  /* Scenario Colors */\n'
        for name in ['reference', 'current', 'future']:
            if name in scenarios:
                css += f'  --color-scenario-{name}: {extract_color_value(scenarios[name])};\n'

    # Site creation colors
    site_creation = colors.get('siteCreation', {})
    if site_creation:
        css += '\n  /* Site Creation Colors */\n'
        for name in ['primary', 'secondary', 'accent', 'glow']:
            if name in site_creation:
                css += f'  --color-site-{name}: {extract_color_value(site_creation[name])};\n'

    # PRISM color scale
    prism = colors.get('prismColorScale', {})
    if prism:
        css += '\n  /* PRISM Color Scale (Choropleth) */\n'
        for i in range(8):
            if str(i) in prism:
                css += f'  --color-prism-{i}: {extract_color_value(prism[str(i)])};\n'

    css += '}\n'

    return css


def main():
    parser = argparse.ArgumentParser(
        description='Import Figma design tokens and generate Chakra UI theme'
    )
    parser.add_argument(
        '--input', '-i',
        default='design-tokens.json',
        help='Input design tokens JSON file (default: design-tokens.json)'
    )
    parser.add_argument(
        '--output', '-o',
        default='frontend/src/styles/theme.ts',
        help='Output Chakra theme file (default: frontend/src/styles/theme.ts)'
    )
    parser.add_argument(
        '--css-output',
        default='frontend/src/styles/design-tokens.css',
        help='Output CSS variables file (default: frontend/src/styles/design-tokens.css)'
    )
    parser.add_argument(
        '--dry-run', '-n',
        action='store_true',
        help='Show what would be generated without writing files'
    )

    args = parser.parse_args()

    # Read input tokens
    input_path = Path(args.input)
    if not input_path.exists():
        print(f"Error: Input file '{args.input}' not found", file=sys.stderr)
        print(f"\nTo get started:", file=sys.stderr)
        print(f"  1. Export tokens from Figma using Tokens Studio plugin", file=sys.stderr)
        print(f"  2. Save as '{args.input}'", file=sys.stderr)
        print(f"  3. Run this script again", file=sys.stderr)
        sys.exit(1)

    with open(input_path) as f:
        tokens = json.load(f)

    print(f"Read design tokens from: {input_path}")

    # Generate theme
    theme_content = generate_theme_ts(tokens)
    css_content = generate_css_variables(tokens)

    if args.dry_run:
        print("\n--- Generated theme.ts ---")
        print(theme_content)
        print("\n--- Generated design-tokens.css ---")
        print(css_content)
        print("\n(Dry run - no files written)")
    else:
        # Write theme file
        output_path = Path(args.output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(output_path, 'w') as f:
            f.write(theme_content)
        print(f"Written Chakra theme to: {output_path}")

        # Write CSS variables
        css_output_path = Path(args.css_output)
        css_output_path.parent.mkdir(parents=True, exist_ok=True)
        with open(css_output_path, 'w') as f:
            f.write(css_content)
        print(f"Written CSS variables to: {css_output_path}")

        print("\nDone! Run 'make build-frontend' to apply changes.")


if __name__ == '__main__':
    main()
