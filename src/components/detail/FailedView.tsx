import type { Task } from '../../types';
import { latestRun } from '../../types';
import { Stats, Section, ValidationIcon } from './shared';

export function FailedView({ task }: { task: Task }) {
  const run = latestRun(task);
  return (
    <>
      <Stats task={task} />
      {run?.agentSummary && (
        <Section title="Agent says">
          <div className="text-sm text-neutral-300 leading-relaxed bg-neutral-900/60 rounded p-3 border-l-2 border-red-900">
            {run.agentSummary}
          </div>
        </Section>
      )}
      {run?.validation && (
        <Section title="Validation">
          <div className="space-y-1.5">
            {run.validation.map((v, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <ValidationIcon status={v.status} />
                <div>
                  <div className="text-neutral-200">{v.label}</div>
                  {v.evidence && (
                    <div className="text-xs text-neutral-500 mt-0.5">
                      {v.evidence}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
