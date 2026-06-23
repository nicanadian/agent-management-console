import { describe, it, expect } from 'vitest';
import type { Task } from '../../types';
import { groupByBucket, dropAction, isDraggable } from './boardModel';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: overrides.id ?? 't1',
    title: 'test task',
    type: 'coding',
    priority: 'normal',
    lifecycleStatus: 'inbox',
    claimedStatus: 'none',
    validationStatus: 'not_applicable',
    reviewStatus: 'not_required',
    createdAt: '2026-06-12T10:00:00Z',
    updatedAt: '2026-06-12T10:00:00Z',
    ...overrides,
  };
}

const reviewTask = makeTask({
  id: 'review-1',
  lifecycleStatus: 'done',
  claimedStatus: 'succeeded',
  reviewStatus: 'pending',
});

describe('groupByBucket', () => {
  it('groups tasks into their derived bucket and excludes archived', () => {
    const groups = groupByBucket([
      makeTask({ id: 'a', lifecycleStatus: 'inbox' }),
      makeTask({ id: 'b', lifecycleStatus: 'running' }),
      reviewTask,
      makeTask({
        id: 'gone',
        lifecycleStatus: 'done',
        archivedAt: '2026-06-12T11:00:00Z',
      }),
    ]);
    expect(groups.inbox.map((t) => t.id)).toEqual(['a']);
    expect(groups.running.map((t) => t.id)).toEqual(['b']);
    expect(groups.review.map((t) => t.id)).toEqual(['review-1']);
    expect(groups.done).toEqual([]);
  });

  it('sorts columns: waiting-on-user, then priority, then recency', () => {
    const groups = groupByBucket([
      makeTask({
        id: 'old-normal',
        lifecycleStatus: 'queued',
        updatedAt: '2026-06-12T08:00:00Z',
      }),
      makeTask({
        id: 'new-normal',
        lifecycleStatus: 'queued',
        updatedAt: '2026-06-12T12:00:00Z',
      }),
      makeTask({
        id: 'urgent',
        lifecycleStatus: 'queued',
        priority: 'urgent',
        updatedAt: '2026-06-12T07:00:00Z',
      }),
      makeTask({
        id: 'waiting',
        lifecycleStatus: 'queued',
        priority: 'low',
        waitingOnUser: true,
        updatedAt: '2026-06-12T06:00:00Z',
      }),
    ]);
    expect(groups.queued.map((t) => t.id)).toEqual([
      'waiting',
      'urgent',
      'new-normal',
      'old-normal',
    ]);
  });
});

describe('dropAction', () => {
  it('allows review → done as accept', () => {
    expect(dropAction(reviewTask, 'done')).toBe('accept');
  });

  it('allows review → queued as reject (request changes)', () => {
    expect(dropAction(reviewTask, 'queued')).toBe('reject');
  });

  it('does not allow non-review tasks to be rejected via queued', () => {
    const done = makeTask({
      lifecycleStatus: 'done',
      claimedStatus: 'succeeded',
      reviewStatus: 'accepted',
    });
    expect(dropAction(done, 'queued')).toBeNull();
    expect(dropAction(makeTask({ lifecycleStatus: 'inbox' }), 'queued')).toBeNull();
  });

  it('allows done / failed / review → archive', () => {
    const done = makeTask({
      lifecycleStatus: 'done',
      claimedStatus: 'succeeded',
      reviewStatus: 'accepted',
    });
    const failed = makeTask({
      lifecycleStatus: 'done',
      claimedStatus: 'failed',
    });
    expect(dropAction(done, 'archive')).toBe('archive');
    expect(dropAction(failed, 'archive')).toBe('archive');
    expect(dropAction(reviewTask, 'archive')).toBe('archive');
  });

  it('rejects agent-owned transitions', () => {
    const inbox = makeTask({ lifecycleStatus: 'inbox' });
    const running = makeTask({ lifecycleStatus: 'running' });
    // can't drag into agent-driven columns
    expect(dropAction(inbox, 'running')).toBeNull();
    expect(dropAction(inbox, 'done')).toBeNull();
    expect(dropAction(running, 'done')).toBeNull();
    expect(dropAction(running, 'archive')).toBeNull();
    // review can only land on done, nowhere else
    expect(dropAction(reviewTask, 'failed')).toBeNull();
    expect(dropAction(reviewTask, 'inbox')).toBeNull();
  });
});

describe('isDraggable', () => {
  it('is true only for review / done / failed buckets', () => {
    expect(isDraggable(reviewTask)).toBe(true);
    expect(
      isDraggable(makeTask({ lifecycleStatus: 'done', claimedStatus: 'failed' }))
    ).toBe(true);
    expect(isDraggable(makeTask({ lifecycleStatus: 'inbox' }))).toBe(false);
    expect(isDraggable(makeTask({ lifecycleStatus: 'running' }))).toBe(false);
    expect(isDraggable(makeTask({ lifecycleStatus: 'blocked' }))).toBe(false);
  });
});
