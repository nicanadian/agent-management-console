import { useMemo, useEffect } from 'react';
import { useStore } from '../store';
import { useUIStore } from '../uiStore';
import type { Task } from '../types';
import { taskBucket, spendSplit } from '../types';
import { ChatCard } from './cards/ChatCard';
import { BackgroundedRow } from './cards/BackgroundedRow';

function attentionScore(t: Task): number {
  const bucket = taskBucket(t);
  if (t.waitingOnUser && bucket === 'running') return 0;
  if (t.waitingOnUser && bucket === 'blocked') return 1;
  if (t.waitingOnUser && bucket === 'failed') return 2;
  if (t.waitingOnUser && bucket === 'review') return 3;
  if (bucket === 'running') return 4;
  if (bucket === 'review') return 5;
  if (bucket === 'failed') return 6;
  if (bucket === 'blocked') return 7;
  if (bucket === 'inbox') return 8;
  if (bucket === 'queued') return 9;
  return 10;
}

export function CardsView() {
  const tasks = useStore((s) => s.tasks);
  const openCapture = useUIStore((s) => s.openCapture);

  const { needsYou, open, archived } = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => {
      const r = attentionScore(a) - attentionScore(b);
      if (r !== 0) return r;
      return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    // Archived ⇒ Recent rail. Tasks stay in the tray until the user
    // clicks Archive (or sends a message — that un-archives).
    const live = sorted.filter((t) => !t.archivedAt);
    const archived = sorted.filter((t) => t.archivedAt);
    const needsYou = live.filter((t) => t.waitingOnUser);
    const open = live.filter((t) => !t.waitingOnUser);
    return { needsYou, open, archived };
  }, [tasks]);

  const counts = useMemo(() => {
    const needsYou = tasks.filter((t) => t.waitingOnUser).length;
    const running = tasks.filter((t) => taskBucket(t) === 'running').length;
    const done = tasks.filter((t) => taskBucket(t) === 'done').length;
    const failed = tasks.filter((t) => taskBucket(t) === 'failed').length;
    const split = spendSplit(tasks);
    return { needsYou, running, done, failed, split };
  }, [tasks]);

  // Phase 8.2 — surface waiting count in the tab title (closest browser
  // equivalent of a dock badge until Tauri lands).
  useEffect(() => {
    document.title = counts.needsYou
      ? `(${counts.needsYou}) Agent Console`
      : 'Agent Console';
  }, [counts.needsYou]);

  return (
    <div className="absolute inset-0 overflow-y-auto">
      <div className="max-w-[1400px] mx-auto p-6">
        {/* Header strip — capture button + workday stats */}
        <div className="flex items-center justify-between mb-5">
          <button
            onClick={openCapture}
            className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded font-medium text-sm flex items-center gap-2"
          >
            + New task
            <kbd className="text-[10px] px-1.5 py-0.5 bg-blue-700/60 rounded font-mono">
              c
            </kbd>
          </button>
          <div className="text-xs text-neutral-500 flex items-center gap-4">
            <span>
              <span className="text-yellow-400 font-medium">
                {counts.needsYou}
              </span>{' '}
              need you
            </span>
            <span>
              <span className="text-blue-400 font-medium">{counts.running}</span>{' '}
              running
            </span>
            <span>
              <span className="text-green-500 font-medium">{counts.done}</span>{' '}
              done today
            </span>
            {counts.failed > 0 && (
              <span>
                <span className="text-red-400 font-medium">{counts.failed}</span>{' '}
                failed
              </span>
            )}
            {(counts.split.apiUsd > 0 || counts.split.unknownUsd > 0) && (
              <span
                className="font-mono text-neutral-400"
                title="API key (real billed dollars)"
              >
                ${(counts.split.apiUsd + counts.split.unknownUsd).toFixed(2)} api
              </span>
            )}
            {counts.split.subscriptionUsd > 0 && (
              <span
                className="font-mono text-neutral-500"
                title="Notional — covered by Claude Code subscription quota"
              >
                ~${counts.split.subscriptionUsd.toFixed(2)} sub
              </span>
            )}
          </div>
        </div>

        {/* Pinned "Needs you" rail. */}
        {needsYou.length > 0 && (
          <section className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" />
              <span className="text-[11px] uppercase tracking-wider font-semibold text-yellow-400">
                Needs you
              </span>
              <span className="text-[11px] font-mono text-yellow-600/70">
                {needsYou.length}
              </span>
            </div>
            <div className="flex flex-wrap gap-3 justify-start">
              {needsYou.map((t) => (
                <ChatCard key={t.id} task={t} />
              ))}
            </div>
          </section>
        )}

        {/* Open — every non-archived task that isn't waiting on you.
            Tasks stay here until you click Archive in the detail panel. */}
        {open.length > 0 && (
          <section className="mb-8">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-1.5 h-1.5 rounded-full bg-blue-500" />
              <span className="text-[11px] uppercase tracking-wider font-semibold text-neutral-400">
                Open
              </span>
              <span className="text-[11px] font-mono text-neutral-600">
                {open.length}
              </span>
            </div>
            <div className="flex flex-wrap gap-3 justify-start">
              {open.map((t) => (
                <ChatCard key={t.id} task={t} />
              ))}
            </div>
          </section>
        )}

        {/* Empty state */}
        {needsYou.length === 0 &&
          open.length === 0 &&
          archived.length === 0 && (
            <div className="text-center py-16 text-neutral-600">
              <div className="text-sm">No tasks yet.</div>
              <div className="text-xs mt-1">
                Press <kbd className="font-mono">c</kbd> to capture one.
              </div>
            </div>
          )}

        {/* Archived — explicitly dismissed by the user. Sending a message
            from here un-archives the task back into Open. */}
        {archived.length > 0 && (
          <section>
            <div className="flex items-center gap-2 mb-2 text-xs text-neutral-500">
              <span className="uppercase tracking-wider font-medium">
                Archived
              </span>
              <span className="font-mono text-neutral-600">
                {archived.length}
              </span>
            </div>
            <div className="space-y-1">
              {archived.map((t) => (
                <BackgroundedRow key={t.id} task={t} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
