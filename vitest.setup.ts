import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});

// jsdom doesn't ship a fetch — silently stub so the FileSystemRepository's
// polling doesn't error during component tests.
if (typeof globalThis.fetch === 'undefined') {
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({
      ok: false,
      status: 503,
      json: async () => ({ tasks: [], agents: [] }),
    } as Response)
  );
}
