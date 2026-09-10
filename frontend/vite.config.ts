import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const require = createRequire(import.meta.url);

// MapLibre's worker script (imported via `?url` in src/lib/maplibreWorker.ts,
// so Vite gives it a real, content-hashed URL instead of the broken
// self-located one — see that file) itself imports a second file,
// `maplibre-gl-shared.mjs`, by a bare relative path baked into MapLibre's own
// build output. Vite's `?url` only copies the one file that was asked for, so
// without this the worker's own import 404s — and, because this app's SPA
// fallback route serves index.html for anything unmatched, that 404 is
// invisible: the worker just silently fails to start, and every vector tile
// source (choropleth, site boundaries, the vector basemap) goes dark with no
// console error.
//
// Emitted unhashed, to the exact filename MapLibre's relative import expects,
// next to wherever Vite puts the (hashed) worker file — both live in
// `assets/`, so a plain sibling filename is enough for it to resolve.
//
// Goes through Rollup's own emitFile rather than writing to dist/ by hand: a
// manual fs write in closeBundle raced Rollup's own output directory setup
// under Nix's sandboxed build (dist/assets did not exist yet there, though it
// reliably did in an ordinary local build) — emitFile makes Rollup responsible
// for the directory existing, the same as it is for every other asset.
function mapLibreWorkerSharedChunk(): Plugin {
  return {
    name: 'maplibre-worker-shared-chunk',
    apply: 'build',
    generateBundle() {
      const maplibreDist = dirname(require.resolve('maplibre-gl/package.json')) + '/dist';
      this.emitFile({
        type: 'asset',
        fileName: 'assets/maplibre-gl-shared.mjs',
        source: readFileSync(join(maplibreDist, 'maplibre-gl-shared.mjs')),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), mapLibreWorkerSharedChunk()],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/tiles': 'http://localhost:8080',
      '/data': 'http://localhost:8080',
      '/docs': 'http://localhost:8080',
      // The satellite style's "glyphs" field is a relative path
      // (/fonts/{fontstack}/{range}.pbf), which MapLibre resolves against the
      // style's own URL — i.e. against this dev server's origin, not the
      // backend's. Without this entry Vite's SPA fallback served index.html
      // for every glyph request (200 OK, text/html), which MapLibre can't
      // parse as a glyph range, silently breaking every symbol-layer label
      // (place names, road names, city labels — 7 of the Hybrid style's 17
      // layers) while the map otherwise looked like it had loaded fine.
      '/fonts': 'http://localhost:8080',
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
