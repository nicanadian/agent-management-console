import type { Task } from '../../types';
import { latestRun } from '../../types';
import { Stats, Section, ValidationIcon } from './shared';

export function ReviewView({
  task,
  onAccept,
  onReject,
}: {
  task: Task;
  onAccept: () => void;
  onReject: () => void;
}) {
  const run = latestRun(task);
  const isPrMode = task.worktree?.mergeMode === 'github-pr';
  return (
    <>
      <Stats task={task} />

      {run?.agentSummary && (
        <Section title="Agent says">
          <div className="text-sm text-neutral-300 leading-relaxed bg-neutral-900/60 rounded p-3 border-l-2 border-neutral-700">
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

      {run?.artifacts && run.artifacts.length > 0 && (
        <Section title="Artifacts">
          <div className="space-y-3">
            {run.artifacts.map((a, i) => (
              <div
                key={i}
                className="border border-neutral-800 rounded overflow-hidden"
              >
                <div className="px-3 py-1.5 bg-neutral-900 border-b border-neutral-800 text-xs flex justify-between">
                  <span className="font-mono text-neutral-300">{a.name}</span>
                  <span className="text-neutral-500 uppercase tracking-wider">
                    {a.type}
                  </span>
                </div>
                {a.preview && (
                  <pre className="p-3 text-xs font-mono text-neutral-400 whitespace-pre-wrap max-h-56 overflow-y-auto">
                    {a.preview}
                  </pre>
                )}
              </div>
            ))}
          </div>
        </Section>
      )}

      <div className="sticky bottom-0 bg-neutral-950 border-t border-neutral-800 -mx-5 px-5 py-3 mt-6 flex gap-2">
        <button
          onClick={onAccept}
          className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-500 text-white text-sm rounded font-medium flex items-center justify-center gap-2"
          title={
            isPrMode
              ? 'Push the branch and open a GitHub PR'
              : 'Merge the branch into the default branch'
          }
        >
          {isPrMode ? 'Accept & open PR' : 'Accept'}
          <kbd className="text-[10px] px-1 py-0.5 bg-green-700/60 rounded font-mono">
            a
          </kbd>
        </button>
        <button
          onClick={onReject}
          className="flex-1 px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm rounded font-medium flex items-center justify-center gap-2"
        >
          Request changes
          <kbd className="text-[10px] px-1 py-0.5 bg-neutral-700 rounded font-mono">
            r
          </kbd>
        </button>
        <button className="px-4 py-2 bg-neutral-800 hover:bg-neutral-700 text-neutral-200 text-sm rounded">
          Reject
        </button>
      </div>
    </>
  );
}
