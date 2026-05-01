import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ingestEvent,
  lastSeq,
  readAllEvents,
  _resetForTests,
} from './event-store.mjs';

let dir;
let eventsFile;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'event-store-test-'));
  eventsFile = join(dir, 'events.jsonl');
  _resetForTests();
});

describe('ingestEvent', () => {
  it('assigns monotonic seq starting at 1', () => {
    const a = ingestEvent({ type: 'a', source: 's', sourceEventId: '1' }, { eventsFile });
    const b = ingestEvent({ type: 'b', source: 's', sourceEventId: '2' }, { eventsFile });
    const c = ingestEvent({ type: 'c', source: 's', sourceEventId: '3' }, { eventsFile });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(c.seq).toBe(3);
  });

  it('persists seq across module reloads (reads max from disk)', async () => {
    ingestEvent({ type: 'a', source: 's', sourceEventId: '1' }, { eventsFile });
    ingestEvent({ type: 'b', source: 's', sourceEventId: '2' }, { eventsFile });
    _resetForTests(); // simulate a console-server restart
    const c = ingestEvent({ type: 'c', source: 's', sourceEventId: '3' }, { eventsFile });
    expect(c.seq).toBe(3);
  });

  it('dedups on (source, sourceEventId)', () => {
    const first = ingestEvent(
      { type: 'a', source: 'shim', sourceEventId: 'uuid-1' },
      { eventsFile }
    );
    const second = ingestEvent(
      { type: 'a', source: 'shim', sourceEventId: 'uuid-1' },
      { eventsFile }
    );
    expect(first.seq).toBe(1);
    expect(second).toEqual({
      duplicate: true,
      source: 'shim',
      sourceEventId: 'uuid-1',
    });
    // Disk only has one line.
    expect(readFileSync(eventsFile, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('dedup survives module reload', () => {
    ingestEvent(
      { type: 'a', source: 'shim', sourceEventId: 'uuid-1' },
      { eventsFile }
    );
    _resetForTests();
    const result = ingestEvent(
      { type: 'a', source: 'shim', sourceEventId: 'uuid-1' },
      { eventsFile }
    );
    expect(result.duplicate).toBe(true);
  });

  it('does not dedup when sourceEventId is missing', () => {
    const a = ingestEvent({ type: 'a', source: 'shim' }, { eventsFile });
    const b = ingestEvent({ type: 'a', source: 'shim' }, { eventsFile });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  it('preserves payload fields', () => {
    const ev = ingestEvent(
      {
        type: 'tool_call_started',
        taskId: 't1',
        runId: 'r1',
        source: 'shim',
        sourceEventId: 'tool-1',
        toolName: 'Read',
      },
      { eventsFile }
    );
    expect(ev.taskId).toBe('t1');
    expect(ev.runId).toBe('r1');
    expect(ev.toolName).toBe('Read');
    expect(ev.timestamp).toBeDefined();
  });
});

describe('lastSeq', () => {
  it('returns 0 for empty file', () => {
    expect(lastSeq(eventsFile)).toBe(0);
  });

  it('returns highest seq', () => {
    ingestEvent({ type: 'a', source: 's', sourceEventId: '1' }, { eventsFile });
    ingestEvent({ type: 'b', source: 's', sourceEventId: '2' }, { eventsFile });
    expect(lastSeq(eventsFile)).toBe(2);
  });
});

describe('readAllEvents', () => {
  it('returns empty for missing file', async () => {
    expect(await readAllEvents(eventsFile)).toEqual([]);
  });

  it('returns events in stored order', async () => {
    ingestEvent({ type: 'a', source: 's', sourceEventId: '1' }, { eventsFile });
    ingestEvent({ type: 'b', source: 's', sourceEventId: '2' }, { eventsFile });
    const events = await readAllEvents(eventsFile);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('a');
    expect(events[1].type).toBe('b');
    expect(events[0].seq).toBe(1);
    expect(events[1].seq).toBe(2);
  });
});
