// SPDX-FileCopyrightText: 2026 Kartoza
// SPDX-License-Identifier: AGPL-3.0-only

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
});
