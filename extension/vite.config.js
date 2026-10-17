import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Builds the popup (index.html + React) into dist/. Everything in public/
// (manifest, background worker, content scripts, icons) is copied as-is.
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
