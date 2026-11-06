import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, open: false },
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: true,
    rollupOptions: {
      input: {
        main: 'index.html',
        viewer: 'tools/asset-viewer.html',
        tjviewer: 'tools/tj-viewer.html',
      },
    },
  },
});
