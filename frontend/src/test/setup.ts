import '@testing-library/jest-dom';

// maplibre-gl calls window.URL.createObjectURL at module load time
if (typeof window !== 'undefined' && !window.URL.createObjectURL) {
  window.URL.createObjectURL = () => '';
  window.URL.revokeObjectURL = () => {};
}
