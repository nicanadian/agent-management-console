import { useStore } from '../store';
import { useUIStore } from '../uiStore';
import type { Task } from '../types';
import { taskBucket } from '../types';
import { Stats } from './detail/shared';
import { Conversation } from './detail/Conversation';
import { RunningView } from './detail/RunningView';
import { ReviewView } from './detail/ReviewView';
import { FailedView } from './detail/FailedView';
import { InboxView } from './detail/InboxView';

export function DetailPanel() {
  const tasks = useStore((s) => s.tasks);
  const selectedTaskId = useUIStore((s) => s.selectedTaskId);
  const selectTask = useUIStore((s) => s.selectTask);
  const acceptTask = useStore((s) => s.acceptTask);
  const rejectTask = useStore((s) => s.rejectTask);
  const assignTask = useStore((s) => s.assignTask);
  const archiveTask = useStore((s) => s.archiveTask);
  const agents = useStore((s) => s.agents);

  const task = tasks.find((t) => t.id === selectedTaskId);
  if (!task) return null;

  const bucket = taskBucket(task);

  return (
    <>
      <div
        className="fixed inset-0 bg-black/30 z-40"
        onClick={() => selectTask(null)}
      />
      <div className="fixed top-0 right-0 bottom-0 w-[880px] max-w-[92vw] bg-neutral-950 border-l border-neutral-800 z-40 overflow-y-auto flex flex-col">
        <Header
          task={task}
          onClose={() => selectTask(null)}
          onArchive={() => {
            archiveTask(task.id);
            selectTask(null);
          }}
        />
        <div className="p-5 space-y-6 flex-1">
          {task.description && (
            <div className="text-[15px] text-neutral-200 leading-[1.7]">
              {task.description}
            </div>
          )}
          {task.messages && task.messages.length > 0 && (
            <Conversation task={task} />
          )}
          {bucket === 'running' && <RunningView task={task} />}
          {bucket === 'review' && (
            <ReviewView
              task={task}
              onAccept={() => acceptTask(task.id)}
              onReject={() => rejectTask(task.id)}
            />
          )}
          {bucket === 'failed' && <FailedView task={task} />}
          {bucket === 'inbox' && (
            <InboxView
              agentIds={agents.map((a) => a.id)}
              onAssign={(agentId) => assignTask(task.id, agentId)}
            />
          )}
          {(bucket === 'done' || bucket === 'queued' || bucket === 'blocked') && (
            <Stats task={task} />
          )}
        </div>
      </div>
    </>
  );
}

function Header({
  task,
  onClose,
  onArchive,
}: {
  task: Task;
  onClose: () => void;
  onArchive: () => void;
}) {
  const bucket = taskBucket(task);
  // Don't offer Archive while the task is mid-turn — use Stop/Cancel instead.
  const showArchive = bucket !== 'running' && !task.archivedAt;
  return (
    <div className="sticky top-0 bg-neutral-950 border-b border-neutral-800 px-5 py-3 flex items-start justify-between z-10">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] font-mono uppercase text-neutral-500 mb-1 tracking-wider">
          {task.type} · {bucket}
          {task.project && ` · ${task.project}`}
          {task.archivedAt && ' · archived'}
        </div>
        <div className="text-base font-medium text-neutral-100 leading-snug">
          {task.title}
        </div>
      </div>
      <div className="flex items-start gap-2 ml-3 -mt-1 shrink-0">
        {showArchive && (
          <button
            onClick={onArchive}
            className="text-[11px] text-neutral-500 hover:text-neutral-200 px-2 py-1 border border-neutral-800 hover:border-neutral-700 rounded"
            title="Move to Archived. Sending a new message brings it back."
          >
            Archive
          </button>
        )}
        <button
          onClick={onClose}
          className="text-neutral-500 hover:text-neutral-300 text-2xl leading-none"
        >
          ×
        </button>
      </div>
    </div>
  );
}
