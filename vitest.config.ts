import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.{ts,tsx}', 'tools/**/*.test.mjs'],
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    // Tools tests run real subprocesses (sandbox, contracts) — give them headroom.
    testTimeout: 15000,
  },
});
