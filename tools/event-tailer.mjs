// Live tail of events.jsonl (Phase 12.3.1).
//
// One shared watcher per events file fans out to N subscribers. Tracks a
// sticky byte offset and buffers partial trailing lines across change
// events — `appendFileSync` is line-atomic at the OS level, but a single
// fs.watch fire can land mid-line if the writer is slow or the OS
// coalesces. Every emit is a complete `\n`-terminated JSON line.
//
// Subscribers receive parsed events. The watcher is stopped automatically
// when the last subscriber unsubscribes, so the tailer adds no idle cost
// when no SSE clients are connected.
//
// This module is intentionally self-contained — Phase 11.2 (SQLite event
// store) replaces it with a SQL-driven feed, and the goal is a clean
// one-file deletion.

import {
  watch,
  existsSync,
  statSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { dirname, basename } from 'node:path';

// eventsFile → { offset, partial, subscribers, watcher?, poller? }
const TAILERS = new Map();

// Subscribe to new events appended to `eventsFile`. Returns an
// unsubscribe function. The watcher starts on the first subscribe and
// stops on the last unsubscribe.
//
// New subscribers begin at the current end-of-file — historical events
// must be loaded separately (e.g. via `readAllEvents` in event-store).
// The SSE handler in console-server combines the two.
export function subscribe(eventsFile, listener) {
  let entry = TAILERS.get(eventsFile);
  if (!entry) {
    entry = {
      offset: existsSync(eventsFile) ? statSync(eventsFile).size : 0,
      partial: '',
      subscribers: new Set(),
      watcher: null,
      poller: null,
    };
    TAILERS.set(eventsFile, entry);
    startWatcher(eventsFile, entry);
  }
  entry.subscribers.add(listener);
  return () => {
    entry.subscribers.delete(listener);
    if (entry.subscribers.size === 0) {
      stopWatcher(entry);
      TAILERS.delete(eventsFile);
    }
  };
}

// Number of active subscribers across all watched files. Used by
// console-server for connection-count logging.
export function activeSubscriberCount() {
  let count = 0;
  for (const entry of TAILERS.values()) {
    count += entry.subscribers.size;
  }
  return count;
}

function startWatcher(eventsFile, entry) {
  // Watch the parent directory — `fs.watch` on a not-yet-existing file
  // throws ENOENT on macOS. Filter to the target filename in the
  // callback. Directory writes from sibling files (tasks/, runs/) live
  // in *different* directories, so this watch is narrowly scoped.
  const dir = dirname(eventsFile);
  const name = basename(eventsFile);
  try {
    entry.watcher = watch(dir, (_eventType, filename) => {
      // macOS sometimes reports null filename — be permissive.
      if (filename && filename !== name) return;
      handleChange(eventsFile, entry);
    });
  } catch {
    // Fallback: 250ms poll if fs.watch is unavailable (rare — usually
    // means the parent dir doesn't exist yet).
    entry.poller = setInterval(() => handleChange(eventsFile, entry), 250);
  }
}

function stopWatcher(entry) {
  if (entry.watcher) {
    entry.watcher.close();
    entry.watcher = null;
  }
  if (entry.poller) {
    clearInterval(entry.poller);
    entry.poller = null;
  }
}

function handleChange(eventsFile, entry) {
  if (!existsSync(eventsFile)) return;
  const size = statSync(eventsFile).size;
  if (size === entry.offset) return;
  if (size < entry.offset) {
    // File was truncated or replaced. Reset and re-read from 0.
    entry.offset = 0;
    entry.partial = '';
  }
  const fd = openSync(eventsFile, 'r');
  try {
    const length = size - entry.offset;
    const buf = Buffer.alloc(length);
    const read = readSync(fd, buf, 0, length, entry.offset);
    entry.offset += read;
    const text = entry.partial + buf.subarray(0, read).toString('utf8');
    const lines = text.split('\n');
    // Last element is whatever follows the final '\n' (may be ''). Hold
    // it as the partial buffer until the next read completes the line.
    entry.partial = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue; // malformed line — skip silently, the writer will fix
      }
      // Snapshot subscribers — listeners may unsubscribe during emit.
      for (const l of [...entry.subscribers]) {
        try {
          l(ev);
        } catch {
          /* ignore listener errors so one bad subscriber can't break others */
        }
      }
    }
  } finally {
    closeSync(fd);
  }
}

// For tests only — discard all watcher state.
export function _resetForTests() {
  for (const entry of TAILERS.values()) stopWatcher(entry);
  TAILERS.clear();
}
