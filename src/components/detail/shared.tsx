import type { Task } from '../../types';
import { latestRun, taskCost } from '../../types';

const APPROX_TOOLTIP =
  'Approximate. Sum of per-run costs; cache effects mean exact attribution is per-run only.';

export function Stats({ task, live }: { task: Task; live?: boolean }) {
  const run = latestRun(task);
  const cost = taskCost(task);
  return (
    <div className="grid grid-cols-3 gap-3 text-xs">
      {task.agentId && (
        <div>
          <div className="text-neutral-500 mb-0.5">Agent</div>
          <div className="text-neutral-200 font-medium">{task.agentId}</div>
        </div>
      )}
      {run?.runtime && (
        <div>
          <div className="text-neutral-500 mb-0.5 flex items-center gap-1.5">
            Runtime{' '}
            {live && <span className="text-blue-400 animate-pulse">●</span>}
          </div>
          <div className="text-neutral-200 font-mono">{run.runtime}</div>
        </div>
      )}
      {cost.totalUsd > 0 && (
        <div>
          <div className="text-neutral-500 mb-0.5">Cost</div>
          <div
            className="text-neutral-200 font-mono"
            title={cost.isApproximate ? APPROX_TOOLTIP : undefined}
          >
            {cost.isApproximate ? '~' : ''}${cost.totalUsd.toFixed(2)}
          </div>
        </div>
      )}
    </div>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-neutral-500 mb-2">
        {title}
      </div>
      {children}
    </div>
  );
}

export function ValidationIcon({ status }: { status: 'pass' | 'fail' | 'warn' }) {
  if (status === 'pass')
    return <span className="text-green-500 mt-0.5 font-bold">✓</span>;
  if (status === 'fail')
    return <span className="text-red-500 mt-0.5 font-bold">✗</span>;
  return <span className="text-amber-500 mt-0.5 font-bold">!</span>;
}
