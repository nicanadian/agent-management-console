import { describe, it, expect, beforeEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcile } from './reconciler.mjs';
import { ingestEvent, _resetForTests } from './event-store.mjs';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'reconciler-test-'));
  mkdirSync(join(dir, 'tasks'));
  mkdirSync(join(dir, 'runs'));
  _resetForTests();
});

function writeTask(t) {
  writeFileSync(join(dir, 'tasks', `${t.id}.json`), JSON.stringify(t));
}
function writeRun(r) {
  writeFileSync(join(dir, 'runs', `${r.id}.json`), JSON.stringify(r));
}
function readEvents() {
  const p = join(dir, 'events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe('reconcile', () => {
  it('emits a reconciled event for a task with no prior events', async () => {
    writeTask({
      id: 't1',
      title: 'demo',
      lifecycleStatus: 'done',
      claimedStatus: 'succeeded',
      validationStatus: 'pending',
      reviewStatus: 'pending',
      updatedAt: '2026-04-30T12:00:00Z',
    });
    const summary = await reconcile({ consoleDir: dir });
    expect(summary.reconciledCount).toBe(1);

    const events = readEvents();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('reconciled');
    expect(events[0].entity).toBe('task');
    expect(events[0].source).toBe('reconciler');
    expect(events[0].snapshot.id).toBe('t1');
    expect(events[0].seq).toBe(1);
  });

  it('skips tasks whose updatedAt is older than the last referencing event', async () => {
    const eventsFile = join(dir, 'events.jsonl');
    ingestEvent(
      {
        taskId: 't1',
        type: 'tool_call_started',
        source: 'shim',
        sourceEventId: 'past-1',
        timestamp: '2026-04-30T13:00:00Z',
      },
      { eventsFile }
    );
    writeTask({
      id: 't1',
      title: 'demo',
      lifecycleStatus: 'running',
      claimedStatus: 'none',
      validationStatus: 'pending',
      reviewStatus: 'pending',
      // updatedAt PRECEDES the existing event
      updatedAt: '2026-04-30T12:00:00Z',
    });
    _resetForTests();
    const summary = await reconcile({ consoleDir: dir });
    expect(summary.reconciledCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
  });

  it('emits a reconciled event when task updatedAt is newer than last event', async () => {
    const eventsFile = join(dir, 'events.jsonl');
    ingestEvent(
      {
        taskId: 't1',
        type: 'tool_call_started',
        source: 'shim',
        sourceEventId: 'past-1',
        timestamp: '2026-04-30T12:00:00Z',
      },
      { eventsFile }
    );
    writeTask({
      id: 't1',
      title: 'demo',
      lifecycleStatus: 'done',
      claimedStatus: 'succeeded',
      validationStatus: 'pending',
      reviewStatus: 'pending',
      // updatedAt POSTDATES the event
      updatedAt: '2026-04-30T13:00:00Z',
    });
    _resetForTests();
    const summary = await reconcile({ consoleDir: dir });
    expect(summary.reconciledCount).toBe(1);
  });

  it('is idempotent on (source, sourceEventId)', async () => {
    writeTask({
      id: 't1',
      title: 'demo',
      lifecycleStatus: 'done',
      claimedStatus: 'succeeded',
      validationStatus: 'pending',
      reviewStatus: 'pending',
      updatedAt: '2026-04-30T12:00:00Z',
    });
    const first = await reconcile({ consoleDir: dir });
    expect(first.reconciledCount).toBe(1);

    _resetForTests();
    const second = await reconcile({ consoleDir: dir });
    // The events file still has only one reconciled event; the second call
    // either no-ops via dedup or via timestamp comparison.
    expect(second.reconciledCount).toBe(0);
    expect(readEvents().filter((e) => e.type === 'reconciled')).toHaveLength(1);
  });

  it('reconciles runs as well as tasks', async () => {
    writeRun({
      id: 'r1',
      taskId: 't1',
      status: 'succeeded',
      startedAt: '2026-04-30T12:00:00Z',
      updatedAt: '2026-04-30T12:01:00Z',
    });
    const summary = await reconcile({ consoleDir: dir });
    expect(summary.reconciledCount).toBe(1);
    const events = readEvents();
    expect(events[0].entity).toBe('run');
    expect(events[0].runId).toBe('r1');
  });

  it('skips malformed JSON without throwing', async () => {
    writeFileSync(join(dir, 'tasks', 'bad.json'), '{ not json');
    writeTask({
      id: 't1',
      title: 'good',
      lifecycleStatus: 'done',
      claimedStatus: 'succeeded',
      validationStatus: 'pending',
      reviewStatus: 'pending',
      updatedAt: '2026-04-30T12:00:00Z',
    });
    const summary = await reconcile({ consoleDir: dir });
    expect(summary.reconciledCount).toBe(1); // good one reconciles, bad is skipped
  });
});
