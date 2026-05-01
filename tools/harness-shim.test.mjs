// Tests for harness-shim — also doubles as a protocol-conformance smoke
// test. The harness writes into .agent-console/ exactly like claude-shim
// does; if anything in the FS protocol drifted into a claude-only
// assumption, this is where it'll fail.

import { describe, it, expect, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let workDir;

const HARNESS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'harness-shim.mjs'
);

function runHarness(args) {
  const result = spawnSync(
    'node',
    [HARNESS_PATH, ...args],
    {
      cwd: workDir,
      encoding: 'utf8',
      timeout: 10_000,
    }
  );
  if (result.status !== 0) {
    // Surface stderr so failures are easy to debug.
    // eslint-disable-next-line no-console
    console.error('harness stderr:', result.stderr);
    console.error('harness stdout:', result.stdout);
  }
  return result;
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'harness-shim-test-'));
});

describe('harness-shim --mode echo', () => {
  it('writes task, run, and events for a one-shot turn', () => {
    const result = runHarness([
      '--task', 't1',
      '--mode', 'echo',
      '--prompt', 'hello',
    ]);
    expect(result.status).toBe(0);

    const taskFile = join(workDir, '.agent-console', 'tasks', 't1.json');
    expect(existsSync(taskFile)).toBe(true);
    const task = JSON.parse(readFileSync(taskFile, 'utf8'));
    expect(task.id).toBe('t1');
    expect(task.lifecycleStatus).toBe('done');
    expect(task.claimedStatus).toBe('succeeded');
    expect(task.runs).toHaveLength(1);
    expect(task.messages).toHaveLength(2);
    expect(task.messages[0].from).toBe('user');
    expect(task.messages[0].text).toBe('hello');
    expect(task.messages[1].from).toBe('agent');
    expect(task.messages[1].text).toBe('echo: hello');

    const runsDir = join(workDir, '.agent-console', 'runs');
    const runFiles = readdirSync(runsDir);
    expect(runFiles).toHaveLength(1);
    const run = JSON.parse(readFileSync(join(runsDir, runFiles[0]), 'utf8'));
    expect(run.status).toBe('succeeded');
    expect(run.taskId).toBe('t1');
    expect(run.costUsd).toBe(0);
    expect(run.costSource).toBe('estimated');
    expect(run.tokens).toBeDefined();

    const eventsFile = join(workDir, '.agent-console', 'events.jsonl');
    expect(existsSync(eventsFile)).toBe(true);
    const events = readFileSync(eventsFile, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(events.length).toBeGreaterThanOrEqual(2);
    // Phase 10.2 — every event has a monotonic seq.
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
    // Both system init and result events present.
    expect(events.some((e) => e.type === 'system')).toBe(true);
    expect(events.some((e) => e.type === 'result')).toBe(true);
    // Source is the harness — our protocol generality forcing function.
    expect(events.every((e) => e.source === 'harness-shim')).toBe(true);
  });
});

describe('harness-shim --mode tools', () => {
  it('emits tool_call_started + tool_call_result activity rows', () => {
    const result = runHarness([
      '--task', 't2',
      '--mode', 'tools',
      '--prompt', 'do a thing',
    ]);
    expect(result.status).toBe(0);

    const runsDir = join(workDir, '.agent-console', 'runs');
    const runFile = join(runsDir, readdirSync(runsDir)[0]);
    const run = JSON.parse(readFileSync(runFile, 'utf8'));
    const types = run.activity.map((a) => a.type);
    expect(types).toContain('tool_call_started');
    expect(types).toContain('tool_call_result');

    // Both activity rows must share toolCallId so the UI can collapse them
    // — same contract claude-shim has.
    const start = run.activity.find((a) => a.type === 'tool_call_started');
    const end = run.activity.find((a) => a.type === 'tool_call_result');
    expect(start.toolCallId).toBe(end.toolCallId);
  });
});

describe('harness-shim --mode fail', () => {
  it('marks the task failed and exits non-zero', () => {
    const result = runHarness([
      '--task', 't3',
      '--mode', 'fail',
      '--prompt', 'this should fail',
    ]);
    expect(result.status).toBe(1);

    const task = JSON.parse(
      readFileSync(join(workDir, '.agent-console', 'tasks', 't3.json'), 'utf8')
    );
    expect(task.lifecycleStatus).toBe('done');
    expect(task.claimedStatus).toBe('failed');
  });
});

describe('harness-shim multi-turn (idempotent re-run)', () => {
  it('two consecutive turns append cleanly to events with monotonic seq', () => {
    runHarness(['--task', 't4', '--mode', 'echo', '--prompt', 'first']);
    runHarness(['--task', 't4', '--mode', 'echo', '--prompt', 'second']);

    const events = readFileSync(
      join(workDir, '.agent-console', 'events.jsonl'),
      'utf8'
    )
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));

    expect(events.length).toBeGreaterThanOrEqual(4);
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    const task = JSON.parse(
      readFileSync(
        join(workDir, '.agent-console', 'tasks', 't4.json'),
        'utf8'
      )
    );
    expect(task.runs).toHaveLength(2);
    expect(task.messages).toHaveLength(4);
  });
});
