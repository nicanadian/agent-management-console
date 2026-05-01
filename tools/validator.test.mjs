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
import { runValidation } from './validator.mjs';
import { _resetForTests } from './event-store.mjs';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'validator-test-'));
  mkdirSync(join(dir, 'tasks'));
  mkdirSync(join(dir, 'runs'));
  _resetForTests();
});

function seed({ taskId = 't1', runId = 'r1', startedAt } = {}) {
  const task = {
    id: taskId,
    title: 'demo',
    type: 'docs',
    priority: 'normal',
    agentId: 'claude-code',
    lifecycleStatus: 'done',
    claimedStatus: 'succeeded',
    validationStatus: 'pending',
    reviewStatus: 'pending',
    createdAt: '2026-04-30T12:00:00Z',
    updatedAt: '2026-04-30T12:00:00Z',
    runs: [{ id: runId }],
  };
  const run = {
    id: runId,
    taskId,
    agentId: 'claude-code',
    status: 'succeeded',
    startedAt: startedAt || '2026-04-30T12:00:00Z',
    activity: [],
  };
  writeFileSync(join(dir, 'tasks', `${taskId}.json`), JSON.stringify(task));
  writeFileSync(join(dir, 'runs', `${runId}.json`), JSON.stringify(run));
}

describe('runValidation', () => {
  it('writes validation_result events and rolls up to verified', async () => {
    seed();
    writeFileSync(join(dir, 'a.md'), 'A');
    writeFileSync(join(dir, 'b.md'), 'B');

    const summary = await runValidation({
      taskId: 't1',
      runId: 'r1',
      contracts: [
        { id: 'has-a', type: 'file_exists', paths: ['a.md'] },
        { id: 'has-b', type: 'file_exists', paths: ['b.md'] },
      ],
      cwd: dir,
      consoleDir: dir,
    });

    expect(summary.validationStatus).toBe('verified');
    expect(summary.eventsWritten).toBe(2);
    expect(summary.eventsSkipped).toBe(0);

    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === 'validation_result')).toBe(true);
    expect(events.every((e) => typeof e.seq === 'number')).toBe(true);
    expect(events[0].contractId).toBe('has-a');
    expect(events[1].contractId).toBe('has-b');

    const run = JSON.parse(readFileSync(join(dir, 'runs', 'r1.json'), 'utf8'));
    expect(run.validationStatus).toBe('verified');
    expect(run.validation).toHaveLength(2);

    const task = JSON.parse(readFileSync(join(dir, 'tasks', 't1.json'), 'utf8'));
    expect(task.validationStatus).toBe('verified');
  });

  it('rolls up to partially_verified on mixed', async () => {
    seed();
    writeFileSync(join(dir, 'a.md'), 'A');
    const summary = await runValidation({
      taskId: 't1',
      runId: 'r1',
      contracts: [
        { id: 'has-a', type: 'file_exists', paths: ['a.md'] },
        { id: 'has-b', type: 'file_exists', paths: ['b.md'] },
      ],
      cwd: dir,
      consoleDir: dir,
    });
    expect(summary.validationStatus).toBe('partially_verified');
  });

  it('rolls up to failed when all fail', async () => {
    seed();
    const summary = await runValidation({
      taskId: 't1',
      runId: 'r1',
      contracts: [{ id: 'has-a', type: 'file_exists', paths: ['missing.md'] }],
      cwd: dir,
      consoleDir: dir,
    });
    expect(summary.validationStatus).toBe('failed');
  });

  it('is idempotent: second run on same contract+content writes no new events', async () => {
    seed();
    writeFileSync(join(dir, 'a.md'), 'A');
    const contracts = [{ id: 'has-a', type: 'file_exists', paths: ['a.md'] }];

    const first = await runValidation({
      taskId: 't1',
      runId: 'r1',
      contracts,
      cwd: dir,
      consoleDir: dir,
    });
    expect(first.eventsWritten).toBe(1);
    expect(first.eventsSkipped).toBe(0);

    _resetForTests(); // simulate process restart
    const second = await runValidation({
      taskId: 't1',
      runId: 'r1',
      contracts,
      cwd: dir,
      consoleDir: dir,
    });
    expect(second.eventsWritten).toBe(0);
    expect(second.eventsSkipped).toBe(1);

    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(events).toHaveLength(1);
  });

  it('non-idempotent when contract id stays but content changes', async () => {
    seed();
    writeFileSync(join(dir, 'doc.md'), '# A\n');
    const contracts = [
      {
        id: 'has-heading',
        type: 'content_structure',
        path: 'doc.md',
        requireHeadings: ['A'],
      },
    ];
    const first = await runValidation({
      taskId: 't1',
      runId: 'r1',
      contracts,
      cwd: dir,
      consoleDir: dir,
    });
    expect(first.eventsWritten).toBe(1);

    writeFileSync(join(dir, 'doc.md'), '# A\n## B\n');
    _resetForTests();
    const second = await runValidation({
      taskId: 't1',
      runId: 'r1',
      contracts,
      cwd: dir,
      consoleDir: dir,
    });
    // Different content hash → not deduped
    expect(second.eventsWritten).toBe(1);

    const events = readFileSync(join(dir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean);
    expect(events).toHaveLength(2);
  });

  it('throws when task is missing', async () => {
    await expect(
      runValidation({
        taskId: 'nonexistent',
        runId: 'r1',
        contracts: [],
        consoleDir: dir,
      })
    ).rejects.toThrow(/task not found/);
  });

  it('throws when run is missing', async () => {
    seed({ runId: 'r1' });
    await expect(
      runValidation({
        taskId: 't1',
        runId: 'nonexistent',
        contracts: [],
        consoleDir: dir,
      })
    ).rejects.toThrow(/run not found/);
  });
});
