import type { Priority, Task, TaskBucket } from '../../types';
import { taskBucket } from '../../types';

// Pure kanban model — column definitions, grouping, and drop rules live
// here so BoardView stays a thin DnD/render layer and the rules are unit
// testable without a DOM.

export const BOARD_COLUMNS: { bucket: TaskBucket; label: string }[] = [
  { bucket: 'inbox', label: 'Inbox' },
  { bucket: 'queued', label: 'Queued' },
  { bucket: 'running', label: 'Running' },
  { bucket: 'blocked', label: 'Blocked' },
  { bucket: 'review', label: 'Review' },
  { bucket: 'failed', label: 'Failed' },
  { bucket: 'done', label: 'Done' },
];

const PRIORITY_RANK: Record<Priority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

// Column order: needs-you first, then priority, then most recently
// updated. Archived tasks stay off the board (they live in the Cards
// view's Archived rail).
export function groupByBucket(tasks: Task[]): Record<TaskBucket, Task[]> {
  const groups: Record<TaskBucket, Task[]> = {
    inbox: [],
    queued: [],
    running: [],
    blocked: [],
    review: [],
    failed: [],
    done: [],
  };
  for (const t of tasks) {
    if (t.archivedAt) continue;
    groups[taskBucket(t)].push(t);
  }
  for (const bucket of Object.keys(groups) as TaskBucket[]) {
    groups[bucket].sort((a, b) => {
      if (!!a.waitingOnUser !== !!b.waitingOnUser)
        return a.waitingOnUser ? -1 : 1;
      const p = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      if (p !== 0) return p;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
  }
  return groups;
}

// Most column membership is agent-driven (running, blocked, failed…), so
// dragging a card there would be a lie — the only legal drags are the
// transitions a human actually owns:
//   review → done       accept the work
//   review → queued     request changes (reject — sends it back to the agent)
//   done | failed → archive zone   dismiss from the board
//
// Reject maps to Queued, not Failed, because rejectTask() puts the task
// back in the queue for another agent turn — that's where the card
// actually lands, so the gesture matches the outcome.
export type DropAction = 'accept' | 'reject' | 'archive';

export function dropAction(
  task: Task,
  target: TaskBucket | 'archive'
): DropAction | null {
  const from = taskBucket(task);
  if (target === 'archive') {
    return from === 'done' || from === 'failed' || from === 'review'
      ? 'archive'
      : null;
  }
  if (from === 'review' && target === 'done') return 'accept';
  if (from === 'review' && target === 'queued') return 'reject';
  return null;
}

// A card is draggable iff at least one drop target would accept it.
export function isDraggable(task: Task): boolean {
  const from = taskBucket(task);
  return from === 'review' || from === 'done' || from === 'failed';
}
