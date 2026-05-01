import { useUIStore } from '../../uiStore';
import type { Task } from '../../types';
import { taskBucket, taskCost } from '../../types';
import { STATUS_DOT } from './statusDot';

export function BackgroundedRow({ task }: { task: Task }) {
  const selectTask = useUIStore((s) => s.selectTask);
  const lastAgentMessage = task.messages
    ?.slice()
    .reverse()
    .find((m) => m.from === 'agent');
  const preview = lastAgentMessage?.text || task.description || '';
  const bucket = taskBucket(task);
  const cost = taskCost(task);

  return (
    <button
      onClick={() => selectTask(task.id)}
      className="w-full text-left flex items-center gap-3 px-3 py-2 bg-neutral-900/30 hover:bg-neutral-900 border border-neutral-900 hover:border-neutral-800 rounded text-xs transition-colors"
    >
      <div className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[bucket]} shrink-0`} />
      <span className="text-neutral-300 font-medium shrink-0 max-w-[40%] truncate">
        {task.title}
      </span>
      <span className="text-neutral-600 truncate flex-1">{preview}</span>
      {task.waitingOnUser && <span className="text-yellow-400 shrink-0">⚠</span>}
      {cost.totalUsd > 0 && (
        <span
          className="text-neutral-600 font-mono shrink-0"
          title={cost.isApproximate ? 'Approximate (sum of runs)' : undefined}
        >
          {cost.isApproximate ? '~' : ''}${cost.totalUsd.toFixed(2)}
        </span>
      )}
    </button>
  );
}
