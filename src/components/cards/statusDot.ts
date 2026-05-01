import type { TaskBucket } from '../../types';

export const STATUS_DOT: Record<TaskBucket, string> = {
  inbox: 'bg-neutral-500',
  queued: 'bg-neutral-400',
  running: 'bg-blue-500',
  blocked: 'bg-amber-500',
  review: 'bg-yellow-500',
  done: 'bg-green-500',
  failed: 'bg-red-500',
};
