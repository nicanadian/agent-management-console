import { useEffect, useState } from 'react';
import type { Task, TaskDiff } from '../../types';
import { Section } from './shared';

// Phase 13 — what the task changed on its branch. Reads the live diff
// from the server (committed work + uncommitted worktree paths) so the
// review surface shows the actual change, not the agent's claim of it.
export function WorktreeSection({ task }: { task: Task }) {
  const wt = task.worktree;
  const [diff, setDiff] = useState<TaskDiff | null>(null);

  useEffect(() => {
    if (!wt) return;
    let cancelled = false;
    fetch(`/api/tasks/${task.id}/diff`)
      .then((res) => (res.ok ? res.json() : null))
      .then((d) => {
        if (!cancelled) setDiff(d);
      })
      .catch(() => {
        /* server down / repo gone — section just stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [task.id, task.updatedAt, wt]);

  if (!wt) return null;

  return (
    <Section title="Branch">
      <div className="space-y-2 text-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[11px] px-1.5 py-0.5 bg-neutral-800 border border-neutral-700 rounded text-neutral-300">
            {wt.branch}
          </span>
          <span className="text-neutral-600 text-xs">
            → {wt.defaultBranch || 'main'}
          </span>
          {wt.setupStatus === 'running' && (
            <span className="text-[10px] uppercase font-mono tracking-wider text-neutral-400 bg-neutral-800 border border-neutral-700 px-1.5 py-0.5 rounded animate-pulse">
              setting up…
            </span>
          )}
          {wt.setupStatus === 'failed' && (
            <span className="text-[10px] uppercase font-mono tracking-wider text-red-400 bg-red-950/40 border border-red-900/40 px-1.5 py-0.5 rounded">
              setup failed
            </span>
          )}
          {wt.mergedAt && (
            <span
              className="text-[10px] uppercase font-mono tracking-wider text-green-400 bg-green-950/40 border border-green-900/40 px-1.5 py-0.5 rounded"
              title={wt.mergeCommit ? `merge commit ${wt.mergeCommit}` : undefined}
            >
              merged
            </span>
          )}
          {wt.mergeConflicts && wt.mergeConflicts.length > 0 && (
            <span className="text-[10px] uppercase font-mono tracking-wider text-red-400 bg-red-950/40 border border-red-900/40 px-1.5 py-0.5 rounded">
              merge conflict
            </span>
          )}
          {wt.mergeMode === 'github-pr' && !wt.prUrl && (
            <span
              className="text-[10px] uppercase font-mono tracking-wider text-blue-300/80 bg-blue-950/40 border border-blue-900/40 px-1.5 py-0.5 rounded"
              title="Accept opens a GitHub PR instead of merging locally"
            >
              PR on accept
            </span>
          )}
        </div>

        {wt.prUrl && (
          <div className="flex items-center gap-2">
            <a
              href={wt.prUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-blue-400 hover:text-blue-300 underline decoration-dotted"
            >
              {wt.prNumber ? `Pull request #${wt.prNumber}` : 'View pull request'} ↗
            </a>
            {wt.prState === 'merged' && (
              <span
                className="text-[10px] uppercase font-mono tracking-wider text-purple-300 bg-purple-950/40 border border-purple-900/40 px-1.5 py-0.5 rounded"
                title={wt.prMergeCommit ? `merge commit ${wt.prMergeCommit}` : undefined}
              >
                merged
              </span>
            )}
            {wt.prState === 'closed' && (
              <span className="text-[10px] uppercase font-mono tracking-wider text-neutral-400 bg-neutral-800 border border-neutral-700 px-1.5 py-0.5 rounded">
                closed
              </span>
            )}
            {(!wt.prState || wt.prState === 'open') && (
              <span className="text-[10px] uppercase font-mono tracking-wider text-green-400/80 bg-green-950/30 border border-green-900/40 px-1.5 py-0.5 rounded">
                open
              </span>
            )}
          </div>
        )}

        {wt.mergeConflicts && wt.mergeConflicts.length > 0 && (
          <div className="text-xs text-red-300/90 bg-red-950/20 border border-red-900/40 rounded p-2">
            Accept blocked — conflicts in:{' '}
            <span className="font-mono">{wt.mergeConflicts.join(', ')}</span>
          </div>
        )}

        {diff && diff.files.length > 0 && (
          <div className="space-y-0.5">
            {diff.files.map((f) => (
              <div
                key={f.path}
                className="flex items-center gap-2 text-xs font-mono"
              >
                <span className="text-neutral-300 truncate">{f.path}</span>
                <span className="text-green-500 shrink-0">+{f.added}</span>
                <span className="text-red-400 shrink-0">−{f.deleted}</span>
              </div>
            ))}
          </div>
        )}
        {diff && diff.files.length === 0 && diff.uncommitted.length === 0 && (
          <div className="text-xs text-neutral-600 italic">
            no changes on this branch yet
          </div>
        )}

        {diff && diff.uncommitted.length > 0 && (
          <div className="text-xs text-neutral-500">
            uncommitted:{' '}
            <span className="font-mono text-neutral-400">
              {diff.uncommitted.join(', ')}
            </span>
          </div>
        )}
      </div>
    </Section>
  );
}
