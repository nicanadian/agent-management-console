import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In FS mode, the API is owned by tools/console-server.mjs (port 3001).
// Vite proxies /api/* there. `npm run dev:fs` starts both via concurrently.
// In InMemory mode (`npm run dev`), the proxy is harmless — the UI never
// hits /api/*.

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: false,
      },
    },
  },
});
