import '@testing-library/jest-dom';

// maplibre-gl calls window.URL.createObjectURL at module load time
if (typeof window !== 'undefined' && !window.URL.createObjectURL) {
  window.URL.createObjectURL = () => '';
  window.URL.revokeObjectURL = () => {};
}

// jsdom implements neither observer. framer-motion's `whileInView` reaches for
// IntersectionObserver as soon as a motion component mounts, and Chakra reaches
// for ResizeObserver, so rendering anything at all throws without these stubs.
// They record nothing: tests assert on rendered output, not on visibility.
class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}

if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver =
    NoopObserver as unknown as typeof IntersectionObserver;
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = NoopObserver as unknown as typeof ResizeObserver;
}
