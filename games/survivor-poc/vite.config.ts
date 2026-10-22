import { defineConfig } from 'vite';

// Relative base so the build works from any sub-path (e.g. GitHub Pages).
export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        // Keep three.js in its own chunk, like the reference site does.
        manualChunks: (id) => (id.includes('node_modules/three') ? 'three' : undefined),
      },
    },
  },
});
