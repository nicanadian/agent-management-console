import { describe, it, expect } from 'vitest';
import type { Task, Run } from './types';
import {
  taskBucket,
  latestRun,
  totalCost,
  taskCost,
  billingModeForRun,
  spendSplit,
} from './types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't',
    title: 'Test',
    type: 'coding',
    priority: 'normal',
    lifecycleStatus: 'inbox',
    claimedStatus: 'none',
    validationStatus: 'not_applicable',
    reviewStatus: 'not_required',
    createdAt: '2026-04-28T00:00:00Z',
    updatedAt: '2026-04-28T00:00:00Z',
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: 'r',
    taskId: 't',
    agentId: 'agent',
    status: 'succeeded',
    startedAt: '2026-04-28T00:00:00Z',
    ...overrides,
  };
}

describe('taskBucket', () => {
  it('inbox lifecycle → inbox bucket', () => {
    expect(taskBucket(makeTask({ lifecycleStatus: 'inbox' }))).toBe('inbox');
  });

  it('queued → queued', () => {
    expect(taskBucket(makeTask({ lifecycleStatus: 'queued' }))).toBe('queued');
  });

  it('running → running', () => {
    expect(taskBucket(makeTask({ lifecycleStatus: 'running' }))).toBe('running');
  });

  it('blocked → blocked', () => {
    expect(taskBucket(makeTask({ lifecycleStatus: 'blocked' }))).toBe('blocked');
  });

  it('done + claim succeeded + review pending → review bucket', () => {
    expect(
      taskBucket(
        makeTask({
          lifecycleStatus: 'done',
          claimedStatus: 'succeeded',
          reviewStatus: 'pending',
        })
      )
    ).toBe('review');
  });

  it('done + claim succeeded + review accepted → done bucket', () => {
    expect(
      taskBucket(
        makeTask({
          lifecycleStatus: 'done',
          claimedStatus: 'succeeded',
          reviewStatus: 'accepted',
        })
      )
    ).toBe('done');
  });

  it('done + claim succeeded + validation failed → failed bucket (validator overrules claim)', () => {
    // The agentic-engineer reviewer's three-axis case: agent says done, validator says no
    expect(
      taskBucket(
        makeTask({
          lifecycleStatus: 'done',
          claimedStatus: 'succeeded',
          validationStatus: 'failed',
          reviewStatus: 'pending',
        })
      )
    ).toBe('failed');
  });

  it('done + claim failed → failed bucket', () => {
    expect(
      taskBucket(
        makeTask({
          lifecycleStatus: 'done',
          claimedStatus: 'failed',
        })
      )
    ).toBe('failed');
  });

  it('done + claim succeeded + validation partially_verified + review pending → review', () => {
    // Partial validation should not jump to "failed" — operator decides
    expect(
      taskBucket(
        makeTask({
          lifecycleStatus: 'done',
          claimedStatus: 'succeeded',
          validationStatus: 'partially_verified',
          reviewStatus: 'pending',
        })
      )
    ).toBe('review');
  });

  it('cancelled lifecycle with no claim → done bucket (default)', () => {
    expect(
      taskBucket(
        makeTask({ lifecycleStatus: 'cancelled', reviewStatus: 'not_required' })
      )
    ).toBe('done');
  });
});

describe('latestRun', () => {
  it('returns undefined when no runs', () => {
    expect(latestRun(makeTask())).toBeUndefined();
  });

  it('returns undefined when runs is empty array', () => {
    expect(latestRun(makeTask({ runs: [] }))).toBeUndefined();
  });

  it('returns the only run when one run', () => {
    const run = makeRun({ id: 'r1' });
    expect(latestRun(makeTask({ runs: [run] }))?.id).toBe('r1');
  });

  it('returns the last run by array position when multiple', () => {
    const runs = [
      makeRun({ id: 'r1' }),
      makeRun({ id: 'r2' }),
      makeRun({ id: 'r3' }),
    ];
    expect(latestRun(makeTask({ runs }))?.id).toBe('r3');
  });
});

describe('totalCost', () => {
  it('returns 0 for no runs', () => {
    expect(totalCost(makeTask())).toBe(0);
  });

  it('returns 0 for empty runs', () => {
    expect(totalCost(makeTask({ runs: [] }))).toBe(0);
  });

  it('sums costs across runs', () => {
    const runs = [
      makeRun({ id: 'r1', cost: 1.5 }),
      makeRun({ id: 'r2', cost: 2.25 }),
      makeRun({ id: 'r3', cost: 0.1 }),
    ];
    expect(totalCost(makeTask({ runs }))).toBeCloseTo(3.85);
  });

  it('treats missing cost as 0', () => {
    const runs = [
      makeRun({ id: 'r1', cost: 1.5 }),
      makeRun({ id: 'r2' }), // no cost
      makeRun({ id: 'r3', cost: 0.5 }),
    ];
    expect(totalCost(makeTask({ runs }))).toBeCloseTo(2.0);
  });

  it('prefers costUsd when present (Phase 9.4)', () => {
    const runs = [
      makeRun({ id: 'r1', cost: 0.5, costUsd: 1.5 }),
      makeRun({ id: 'r2', costUsd: 2.0 }),
    ];
    expect(totalCost(makeTask({ runs }))).toBeCloseTo(3.5);
  });
});

describe('taskCost', () => {
  it('returns 0 / not approximate for empty runs', () => {
    const c = taskCost(makeTask());
    expect(c.totalUsd).toBe(0);
    expect(c.isApproximate).toBe(false);
    expect(c.runCount).toBe(0);
  });

  it('single run with no cache → not approximate', () => {
    const runs = [makeRun({ id: 'r1', costUsd: 0.42 })];
    const c = taskCost(makeTask({ runs }));
    expect(c.totalUsd).toBeCloseTo(0.42);
    expect(c.isApproximate).toBe(false);
  });

  it('multiple runs → approximate', () => {
    const runs = [
      makeRun({ id: 'r1', costUsd: 0.5 }),
      makeRun({ id: 'r2', costUsd: 0.5 }),
    ];
    const c = taskCost(makeTask({ runs }));
    expect(c.isApproximate).toBe(true);
    expect(c.runCount).toBe(2);
  });

  it('cached tokens → approximate even with single run', () => {
    const runs = [
      makeRun({
        id: 'r1',
        costUsd: 0.5,
        tokens: { input: 100, output: 200, cacheRead: 5000 },
      }),
    ];
    const c = taskCost(makeTask({ runs }));
    expect(c.isApproximate).toBe(true);
    expect(c.hasCachedTokens).toBe(true);
  });

  it('billingMode is subscription when all runs apiKeySource=none', () => {
    const runs = [
      makeRun({ id: 'r1', costUsd: 0.5, apiKeySource: 'none' }),
      makeRun({ id: 'r2', costUsd: 0.5, apiKeySource: 'none' }),
    ];
    expect(taskCost(makeTask({ runs })).billingMode).toBe('subscription');
  });

  it('billingMode is api when run uses an API key', () => {
    const runs = [makeRun({ id: 'r1', costUsd: 0.5, apiKeySource: 'user' })];
    expect(taskCost(makeTask({ runs })).billingMode).toBe('api');
  });

  it('billingMode is mixed when both', () => {
    const runs = [
      makeRun({ id: 'r1', costUsd: 0.5, apiKeySource: 'none' }),
      makeRun({ id: 'r2', costUsd: 0.5, apiKeySource: 'user' }),
    ];
    expect(taskCost(makeTask({ runs })).billingMode).toBe('mixed');
  });

  it('billingMode is unknown when no apiKeySource recorded', () => {
    const runs = [makeRun({ id: 'r1', costUsd: 0.5 })];
    expect(taskCost(makeTask({ runs })).billingMode).toBe('unknown');
  });
});

describe('billingModeForRun', () => {
  it('none → subscription', () => {
    expect(billingModeForRun(makeRun({ apiKeySource: 'none' }))).toBe(
      'subscription'
    );
  });
  it('user → api', () => {
    expect(billingModeForRun(makeRun({ apiKeySource: 'user' }))).toBe('api');
  });
  it('project / org → api', () => {
    expect(billingModeForRun(makeRun({ apiKeySource: 'project' }))).toBe('api');
    expect(billingModeForRun(makeRun({ apiKeySource: 'org' }))).toBe('api');
  });
  it('unset → unknown', () => {
    expect(billingModeForRun(makeRun())).toBe('unknown');
  });
});

describe('createdBy provenance (Phase 12.1)', () => {
  it('round-trips on Task records', () => {
    const t = makeTask({ createdBy: 'hermes' });
    expect(t.createdBy).toBe('hermes');
  });

  it('is optional — absence leaves the field undefined', () => {
    const t = makeTask();
    expect(t.createdBy).toBeUndefined();
  });
});

describe('spendSplit', () => {
  it('splits across subscription/api/unknown buckets', () => {
    const tasks = [
      makeTask({
        id: 't1',
        runs: [
          makeRun({ id: 'r1', costUsd: 1.5, apiKeySource: 'none' }),
          makeRun({ id: 'r2', costUsd: 0.5, apiKeySource: 'user' }),
        ],
      }),
      makeTask({
        id: 't2',
        runs: [makeRun({ id: 'r3', costUsd: 0.25 })], // no apiKeySource
      }),
    ];
    const split = spendSplit(tasks);
    expect(split.subscriptionUsd).toBeCloseTo(1.5);
    expect(split.apiUsd).toBeCloseTo(0.5);
    expect(split.unknownUsd).toBeCloseTo(0.25);
  });

  it('returns zeros for empty input', () => {
    expect(spendSplit([])).toEqual({
      subscriptionUsd: 0,
      apiUsd: 0,
      unknownUsd: 0,
    });
  });
});
