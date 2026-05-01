import type { Task } from '../../types';
import { latestRun, taskCost } from '../../types';
import type { BillingMode } from '../../types';

const APPROX_TOOLTIP =
  'Approximate. Sum of per-run costs; cache effects mean exact attribution is per-run only.';

const BILLING_TOOLTIPS: Record<BillingMode, string | undefined> = {
  subscription:
    'Notional — paid by your Claude Code subscription quota, not billed in USD.',
  api: 'Billed to API key.',
  mixed: 'Mixed — some runs on subscription, some on API key.',
  unknown: undefined,
};

const BILLING_LABELS: Record<BillingMode, string | null> = {
  subscription: 'subscription',
  api: 'api',
  mixed: 'mixed',
  unknown: null,
};

export function Stats({ task, live }: { task: Task; live?: boolean }) {
  const run = latestRun(task);
  const cost = taskCost(task);
  const isSubscription = cost.billingMode === 'subscription';
  const usdLabel = `${isSubscription || cost.isApproximate ? '~' : ''}$${cost.totalUsd.toFixed(2)}`;
  const billingLabel = BILLING_LABELS[cost.billingMode];
  const tooltip =
    BILLING_TOOLTIPS[cost.billingMode] ||
    (cost.isApproximate ? APPROX_TOOLTIP : undefined);
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
            className={`font-mono ${isSubscription ? 'text-neutral-500' : 'text-neutral-200'}`}
            title={tooltip}
          >
            {usdLabel}
            {billingLabel && (
              <span className="text-neutral-600 text-[10px] ml-1">
                · {billingLabel}
              </span>
            )}
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
