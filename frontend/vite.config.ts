import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/tiles': 'http://localhost:8080',
      '/data': 'http://localhost:8080',
      '/docs': 'http://localhost:8080',
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          chakra: ['@chakra-ui/react', '@emotion/react', '@emotion/styled', 'framer-motion'],
          map: ['maplibre-gl'],
          // plotly is deliberately NOT named here. It is imported lazily by
          // ChartView, which already gives it its own chunk — and naming it as a
          // manual chunk puts it back in the static graph, so Vite emits a
          // <link rel="modulepreload"> for it and the browser fetches all 4.6 MB
          // before first paint anyway. Measured: with the entry, index.html
          // preloads plotly; without it, plotly is fetched only when a chart is
          // first rendered.
        },
      },
    },
  },
});
