import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'web',
  plugins: [react()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/v1': 'http://127.0.0.1:8787',
      '/healthz': 'http://127.0.0.1:8787',
      '/readyz': 'http://127.0.0.1:8787',
    },
  },
});
