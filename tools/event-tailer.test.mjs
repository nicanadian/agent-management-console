// Tests for tools/event-tailer.mjs (Phase 12.3.1).
//
// The interesting behavior is partial-line buffering: a single fs.watch
// fire can land mid-line if the writer is slow or the OS coalesces.
// Every test exercises that path (writes split across multiple chunks).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  subscribe,
  activeSubscriberCount,
  _resetForTests,
} from './event-tailer.mjs';

let dir;
let eventsFile;

// Wait for a predicate to become true, polling at short intervals.
// fs.watch fires via the OS, so tests must yield to the event loop
// rather than asserting synchronously. Budget covers a few of the
// tailer's safety-net poll cycles (SAFETY_POLL_MS = 1s): when the full
// suite runs concurrently, macOS can drop the watch event entirely, and
// recovery then waits on that poll rather than the (instant) watcher.
async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'event-tailer-test-'));
  eventsFile = join(dir, 'events.jsonl');
  _resetForTests();
});

afterEach(() => {
  _resetForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe('subscribe', () => {
  it('emits each appended event to subscribers', async () => {
    // File needs to exist before fs.watch is attached on macOS — the
    // tailer handles non-existence by watching the parent dir.
    writeFileSync(eventsFile, '');
    const seen = [];
    const unsub = subscribe(eventsFile, (ev) => seen.push(ev));

    appendFileSync(eventsFile, JSON.stringify({ seq: 1, type: 'a' }) + '\n');
    appendFileSync(eventsFile, JSON.stringify({ seq: 2, type: 'b' }) + '\n');

    await waitFor(() => seen.length === 2);
    expect(seen[0]).toEqual({ seq: 1, type: 'a' });
    expect(seen[1]).toEqual({ seq: 2, type: 'b' });

    unsub();
  });

  it('buffers partial trailing line across multiple writes', async () => {
    writeFileSync(eventsFile, '');
    const seen = [];
    const unsub = subscribe(eventsFile, (ev) => seen.push(ev));

    // Simulate a writer flushing mid-line. The tailer must NOT emit
    // until it sees the trailing newline.
    const fullLine = JSON.stringify({ seq: 1, type: 'partial' });
    appendFileSync(eventsFile, fullLine.slice(0, 10));
    // Give the watcher a chance to fire on the partial write.
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(0);

    appendFileSync(eventsFile, fullLine.slice(10) + '\n');
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toEqual({ seq: 1, type: 'partial' });

    unsub();
  });

  it('starts at end-of-file — does not back-emit historical events', async () => {
    writeFileSync(
      eventsFile,
      JSON.stringify({ seq: 1, type: 'old' }) + '\n'
    );
    const seen = [];
    const unsub = subscribe(eventsFile, (ev) => seen.push(ev));

    // Give the watcher a chance to do anything (it shouldn't).
    await new Promise((r) => setTimeout(r, 80));
    expect(seen).toHaveLength(0);

    appendFileSync(eventsFile, JSON.stringify({ seq: 2, type: 'new' }) + '\n');
    await waitFor(() => seen.length === 1);
    expect(seen[0].seq).toBe(2);

    unsub();
  });

  it('skips malformed lines silently', async () => {
    writeFileSync(eventsFile, '');
    const seen = [];
    const unsub = subscribe(eventsFile, (ev) => seen.push(ev));

    appendFileSync(eventsFile, 'not json\n');
    appendFileSync(eventsFile, JSON.stringify({ seq: 7, type: 'good' }) + '\n');

    await waitFor(() => seen.length === 1);
    expect(seen[0].seq).toBe(7);

    unsub();
  });

  it('fans out to multiple subscribers', async () => {
    writeFileSync(eventsFile, '');
    const a = [];
    const b = [];
    const unsubA = subscribe(eventsFile, (ev) => a.push(ev));
    const unsubB = subscribe(eventsFile, (ev) => b.push(ev));

    appendFileSync(eventsFile, JSON.stringify({ seq: 1 }) + '\n');
    await waitFor(() => a.length === 1 && b.length === 1);

    expect(a[0].seq).toBe(1);
    expect(b[0].seq).toBe(1);

    unsubA();
    unsubB();
  });

  it('unsubscribe stops events for that listener only', async () => {
    writeFileSync(eventsFile, '');
    const a = [];
    const b = [];
    const unsubA = subscribe(eventsFile, (ev) => a.push(ev));
    const unsubB = subscribe(eventsFile, (ev) => b.push(ev));

    unsubA();
    appendFileSync(eventsFile, JSON.stringify({ seq: 1 }) + '\n');
    await waitFor(() => b.length === 1);

    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);

    unsubB();
  });
});

describe('activeSubscriberCount', () => {
  it('reflects current subscribers across files', () => {
    writeFileSync(eventsFile, '');
    expect(activeSubscriberCount()).toBe(0);
    const u1 = subscribe(eventsFile, () => {});
    const u2 = subscribe(eventsFile, () => {});
    expect(activeSubscriberCount()).toBe(2);
    u1();
    expect(activeSubscriberCount()).toBe(1);
    u2();
    expect(activeSubscriberCount()).toBe(0);
  });
});
