import js from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * ESLint configuration.
 *
 * The repository has shipped an eslint dependency, a `lint` script and a CI job
 * called `lint-frontend` for its whole life, and none of them ever linted
 * anything: there was no configuration file, so eslint exited with an error
 * rather than a result, and the CI job runs `tsc --noEmit` only. No TypeScript in
 * this project has ever been linted.
 *
 * That is not academic. The stale-closure bug where switching sites coloured the
 * map from the previous site — `applyColors` memoised without `siteId` — is
 * precisely what `react-hooks/exhaustive-deps` reports, and it survived because
 * nothing was looking.
 *
 * Built from `@typescript-eslint/parser` and the plugin directly rather than the
 * `typescript-eslint` meta-package, because those two are already dependencies
 * and the meta-package is not. Adding an npm dependency to lint the code we
 * already have would be a poor trade.
 *
 * The rule set is deliberately narrow. Enabling every recommended rule at once on
 * a codebase this size produces hundreds of findings, which get silenced rather
 * than fixed. These catch faults rather than style, and they pass at zero
 * warnings today — so a new violation fails CI immediately instead of joining a
 * backlog nobody reads.
 */
export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'eslint.config.js',
      'vite.config.ts',
      'vitest.config.ts',
    ],
  },

  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser, ...globals.es2021 },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'react-hooks': reactHooks,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tsPlugin.configs.recommended.rules,

      // The reason this configuration exists. A hook that reads a value without
      // declaring it captures that value from the render it was created in,
      // which is how a site switch kept colouring the previous site.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',

      // Faults rather than taste.
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',

      // An unused variable is usually a leftover from an edit that did not
      // finish. Underscore-prefixed names are the established way of saying
      // "required by the signature, deliberately unused".
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // Off, with reasons, rather than silently absent:
      //
      // no-explicit-any — the map and GeoJSON code carries a great deal of `any`
      // from maplibre's own types. Enabling it today reports well over a hundred
      // findings, none of them a bug. Worth a pass of its own.
      '@typescript-eslint/no-explicit-any': 'off',
      // TypeScript already rejects an undefined identifier, and no-undef does not
      // understand type-only names, so it reports false positives on types.
      'no-undef': 'off',
    },
  },

  {
    // Tests reach into internals and stub globals; the production rules above
    // would only get in the way.
    files: ['src/test/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': 'off',
    },
  },
];
