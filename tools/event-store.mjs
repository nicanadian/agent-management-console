// Event store — single chokepoint for all writes to events.jsonl
// (Phase 10.2 + 10.3).
//
//   - Phase 10.2: every event gets a server-assigned monotonic `seq`. The
//     counter persists across restarts by reading the highest seq present
//     in events.jsonl on first call.
//
//   - Phase 10.3: idempotency on (source, sourceEventId). Replaying
//     events.jsonl after a crash, or two adapters racing on the same
//     stream-json `uuid`, produces no duplicate state.
//
// Adapters MUST go through `ingestEvent` rather than appending to
// events.jsonl directly. The shim's atomic-append guarantee on a single
// `appendFileSync` line still holds, but seq + dedup do not, hence the
// chokepoint.
//
// Usage:
//   import { ingestEvent } from './event-store.mjs';
//   const stored = ingestEvent({ taskId, runId, type, source, sourceEventId, ...payload });
//   // returns the event with seq + ts; or { duplicate: true, seq } if dedup'd.

import {
  appendFileSync,
  existsSync,
  readFileSync,
  createReadStream,
  mkdirSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const DEFAULT_EVENTS_FILE = join(
  resolve(process.env.CONSOLE_DIR || '.agent-console'),
  'events.jsonl'
);

class EventStoreState {
  constructor() {
    this.byFile = new Map(); // eventsFile → { seq, dedupSet }
  }

  forFile(eventsFile) {
    let entry = this.byFile.get(eventsFile);
    if (!entry) {
      entry = { seq: 0, dedupSet: new Set(), loaded: false };
      this.byFile.set(eventsFile, entry);
    }
    if (!entry.loaded) {
      this.loadFromDisk(eventsFile, entry);
      entry.loaded = true;
    }
    return entry;
  }

  loadFromDisk(eventsFile, entry) {
    if (!existsSync(eventsFile)) return;
    // Synchronous load on first access — events.jsonl is small enough at
    // this scale (we'll re-evaluate at SQLite cutover).
    const lines = readFileSync(eventsFile, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const ev = JSON.parse(line);
        if (typeof ev.seq === 'number' && ev.seq > entry.seq) {
          entry.seq = ev.seq;
        }
        if (ev.source && ev.sourceEventId) {
          entry.dedupSet.add(`${ev.source}|${ev.sourceEventId}`);
        }
      } catch {
        /* skip malformed */
      }
    }
  }
}

const STATE = new EventStoreState();

// ingestEvent(event, { eventsFile? })
//   event is { type, taskId?, runId?, source?, sourceEventId?, ...payload }
//   - source + sourceEventId together form the idempotency key. If absent,
//     no dedup is applied (event is appended unconditionally).
//   - timestamp is set to now if missing.
//   - seq is server-assigned (monotonic per eventsFile).
// Returns the stored event (with seq, ts), or { duplicate: true, seq } if
// the (source, sourceEventId) was already seen.
export function ingestEvent(event, options = {}) {
  const eventsFile = options.eventsFile || DEFAULT_EVENTS_FILE;
  ensureDirFor(eventsFile);
  const entry = STATE.forFile(eventsFile);

  const dedupKey =
    event.source && event.sourceEventId
      ? `${event.source}|${event.sourceEventId}`
      : null;
  if (dedupKey && entry.dedupSet.has(dedupKey)) {
    return { duplicate: true, source: event.source, sourceEventId: event.sourceEventId };
  }

  const seq = ++entry.seq;
  const stored = {
    seq,
    timestamp: event.timestamp || new Date().toISOString(),
    ...event,
  };
  appendFileSync(eventsFile, JSON.stringify(stored) + '\n');

  if (dedupKey) entry.dedupSet.add(dedupKey);
  return stored;
}

// Return the highest seq currently known for an eventsFile. Useful for
// the FSEvents reconciliation pass (Phase 10.4).
export function lastSeq(eventsFile = DEFAULT_EVENTS_FILE) {
  const entry = STATE.forFile(eventsFile);
  return entry.seq;
}

// Stream events lazily from disk (newer ingestion-time API). Used by the
// reconciler and by tests. Resolves with array of parsed events.
export async function readAllEvents(eventsFile = DEFAULT_EVENTS_FILE) {
  if (!existsSync(eventsFile)) return [];
  const out = [];
  const rl = createInterface({
    input: createReadStream(eventsFile, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// For tests only: discard the in-memory dedup/seq state (forces reload
// from disk on next call). Production code should never need this.
export function _resetForTests() {
  STATE.byFile.clear();
}

function ensureDirFor(file) {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
