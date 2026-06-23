import { useMemo, useState } from 'react';
import { useStore } from '../../store';
import type { Task, TaskBucket } from '../../types';
import { STATUS_DOT } from '../cards/statusDot';
import { BOARD_COLUMNS, dropAction, groupByBucket } from './boardModel';
import { BoardCard } from './BoardCard';

// Kanban board over the same task list as CardsView. Columns are the
// derived taskBucket() values; membership is mostly agent-driven, so drag
// is restricted to the human-owned transitions in boardModel.dropAction.
export function BoardView() {
  const tasks = useStore((s) => s.tasks);
  const acceptTask = useStore((s) => s.acceptTask);
  const rejectTask = useStore((s) => s.rejectTask);
  const archiveTask = useStore((s) => s.archiveTask);

  // Task currently being dragged — drives drop-target highlighting and
  // the archive zone's visibility.
  const [dragging, setDragging] = useState<Task | null>(null);

  const groups = useMemo(() => groupByBucket(tasks), [tasks]);

  function findTask(e: React.DragEvent): Task | undefined {
    const id = e.dataTransfer.getData('text/task-id');
    return tasks.find((t) => t.id === id);
  }

  async function handleDrop(e: React.DragEvent, target: TaskBucket | 'archive') {
    e.preventDefault();
    setDragging(null);
    const task = findTask(e);
    if (!task) return;
    const action = dropAction(task, target);
    if (action === 'accept') await acceptTask(task.id);
    else if (action === 'reject') await rejectTask(task.id);
    else if (action === 'archive') await archiveTask(task.id);
  }

  function allowDrop(e: React.DragEvent, target: TaskBucket | 'archive') {
    if (dragging && dropAction(dragging, target)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  }

  return (
    <div className="absolute inset-0 flex flex-col">
      <div className="flex-1 min-h-0 overflow-x-auto">
        <div className="h-full flex gap-3 p-4 min-w-max">
          {BOARD_COLUMNS.map(({ bucket, label }) => {
            const items = groups[bucket];
            const action = dragging ? dropAction(dragging, bucket) : null;
            const isReject = action === 'reject';
            return (
              <div
                key={bucket}
                onDragOver={(e) => allowDrop(e, bucket)}
                onDrop={(e) => handleDrop(e, bucket)}
                className={`w-[260px] shrink-0 flex flex-col rounded-lg border ${
                  action
                    ? isReject
                      ? 'border-amber-700/70 bg-amber-950/10'
                      : 'border-green-700/70 bg-green-950/10'
                    : 'border-neutral-800/70 bg-neutral-900/30'
                }`}
              >
                <div className="flex items-center gap-2 px-3 py-2.5 shrink-0">
                  <div className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[bucket]}`} />
                  <span className="text-[11px] uppercase tracking-wider font-semibold text-neutral-400">
                    {label}
                  </span>
                  <span className="text-[11px] font-mono text-neutral-600">
                    {items.length}
                  </span>
                  {action && (
                    <span
                      className={`ml-auto text-[10px] ${
                        isReject ? 'text-amber-400' : 'text-green-500'
                      }`}
                    >
                      {isReject ? 'request changes' : 'accept'}
                    </span>
                  )}
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-2">
                  {items.map((t) => (
                    <BoardCard
                      key={t.id}
                      task={t}
                      onDragStart={setDragging}
                      onDragEnd={() => setDragging(null)}
                    />
                  ))}
                  {items.length === 0 && (
                    <div className="text-[11px] text-neutral-700 italic px-1 py-2">
                      empty
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Archive drop zone — only visible mid-drag for archivable tasks. */}
      {dragging && dropAction(dragging, 'archive') && (
        <div
          onDragOver={(e) => allowDrop(e, 'archive')}
          onDrop={(e) => handleDrop(e, 'archive')}
          className="shrink-0 m-4 mt-0 py-3 rounded-lg border border-dashed border-neutral-600 bg-neutral-900/60 text-center text-xs text-neutral-400"
        >
          Drop here to archive
        </div>
      )}
    </div>
  );
}
