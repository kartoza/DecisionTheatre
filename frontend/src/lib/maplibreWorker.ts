import * as maplibregl from 'maplibre-gl';
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';

// MapLibre locates its own worker script from import.meta.url of the module
// it ships as. Vite inlines that module into a single bundled chunk, so the
// self-located URL points at a file Vite never emits, and the app's SPA
// fallback route quietly serves index.html in its place - the worker then
// fails to parse as a module and every vector tile source (choropleth, site
// boundaries, the vector basemap) goes dark with no console error, because
// the failure happens inside the worker before it can report anything.
//
// Importing the real worker file through Vite's `?url` gives it a proper,
// content-hashed URL in the build output; handing that to MapLibre here -
// before any Map is constructed - is what makes it resolvable.
maplibregl.setWorkerUrl(workerUrl);
