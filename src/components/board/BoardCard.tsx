import { useUIStore } from '../../uiStore';
import type { Task } from '../../types';
import { taskBucket, latestRun, taskCost } from '../../types';
import { InboxAssignPortrait } from '../cards/InboxAssignPortrait';
import { isDraggable } from './boardModel';

// Compact kanban card — the ChatCard's 230×400 message stack is too heavy
// for a column, so this renders just identity + status accents and defers
// everything else to the detail panel.
export function BoardCard({
  task,
  onDragStart,
  onDragEnd,
}: {
  task: Task;
  // dataTransfer is unreadable until drop (browser protected mode), so the
  // board tracks the in-flight task through these callbacks instead.
  onDragStart?: (task: Task) => void;
  onDragEnd?: () => void;
}) {
  const selectTask = useUIStore((s) => s.selectTask);

  const bucket = taskBucket(task);
  const isWaiting = !!task.waitingOnUser;
  const run = latestRun(task);
  const cost = taskCost(task);
  const draggable = isDraggable(task);

  const accentBorder = isWaiting
    ? 'border-yellow-700/50'
    : bucket === 'running'
      ? 'border-blue-900/40'
      : bucket === 'failed'
        ? 'border-red-900/40'
        : bucket === 'blocked'
          ? 'border-amber-900/50'
          : 'border-neutral-800';

  return (
    <div
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/task-id', task.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart?.(task);
      }}
      onDragEnd={() => onDragEnd?.()}
      onClick={() => selectTask(task.id)}
      className={`bg-neutral-900/95 border ${accentBorder} ${
        isWaiting ? 'bg-yellow-950/10' : ''
      } rounded-lg px-3 py-2.5 cursor-pointer hover:border-neutral-600 transition-colors ${
        draggable ? 'active:cursor-grabbing' : ''
      }`}
      title={draggable ? 'Drag to accept or archive' : undefined}
    >
      <div className="text-[13px] font-medium text-neutral-100 leading-snug line-clamp-2">
        {task.title}
      </div>

      {isWaiting && (
        <div className="mt-1 text-[10px] uppercase tracking-wider text-yellow-400 font-medium">
          ⚠ waiting on you
        </div>
      )}

      {task.worktree?.mergeConflicts && task.worktree.mergeConflicts.length > 0 && (
        <div className="mt-1 text-[10px] uppercase tracking-wider text-red-400 font-medium">
          merge conflict
        </div>
      )}

      {(task.agentId || task.project) && (
        <div className="mt-1 text-[11px] text-neutral-500 truncate">
          {task.agentId}
          {task.agentId && task.project && ' · '}
          {task.project}
        </div>
      )}

      {bucket === 'inbox' && (
        <div className="mt-2">
          <InboxAssignPortrait taskId={task.id} />
        </div>
      )}

      {(run?.runtime || cost.totalUsd > 0 || task.priority !== 'normal') && (
        <div className="mt-1.5 flex items-center gap-2 text-[10px] font-mono text-neutral-500">
          {task.priority !== 'normal' && (
            <span
              className={
                task.priority === 'urgent'
                  ? 'text-red-400'
                  : task.priority === 'high'
                    ? 'text-amber-400'
                    : 'text-neutral-600'
              }
            >
              {task.priority}
            </span>
          )}
          {run?.runtime && <span>{run.runtime}</span>}
          {cost.totalUsd > 0 && (
            <span
              className={
                cost.billingMode === 'subscription'
                  ? 'text-neutral-600'
                  : undefined
              }
            >
              {cost.billingMode === 'subscription' || cost.isApproximate
                ? '~'
                : ''}
              ${cost.totalUsd.toFixed(2)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
