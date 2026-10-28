import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The server injects the real base path (BASE_PATH) into index.html at serve time,
// so assets and API calls stay relative and the same build works behind a path prefix.
export default defineConfig({
  root: 'src/web',
  base: './',
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3460',
    },
  },
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
  },
});
