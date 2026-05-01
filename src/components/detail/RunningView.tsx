import { useStore } from '../../store';
import type { Task, Activity, ActivityType } from '../../types';
import { latestRun } from '../../types';
import { Stats, Section } from './shared';

const STANDALONE_LABEL: Partial<Record<ActivityType, string>> = {
  thinking: 'thinking',
  subagent_spawned: 'subagent',
  permission_requested: 'permission',
  started: 'started',
  completed: 'done',
};

export function RunningView({ task }: { task: Task }) {
  const run = latestRun(task);
  const stopRun = useStore((s) => s.stopRun);
  const cancelRun = useStore((s) => s.cancelRun);

  const rows = run ? buildRows(run.activity ?? []) : [];

  return (
    <>
      <Stats task={task} live />

      {/* Phase 8.1 — prominent Now panel showing what claude is doing
          right now. The string is updated by the shim per tool_use event. */}
      {run?.currentActivity && (
        <div className="bg-blue-950/30 border border-blue-900/40 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <span className="text-[10px] uppercase tracking-wider font-medium text-blue-400">
              Now
            </span>
          </div>
          <div className="text-sm text-neutral-100 font-mono leading-snug">
            {run.currentActivity}
          </div>
        </div>
      )}

      <Section title="Activity">
        <div className="space-y-1">
          {rows.map((row) =>
            row.kind === 'pair' ? (
              <ToolCallRow key={row.key} events={row.events} />
            ) : (
              <StandaloneRow key={row.key} activity={row.event} />
            )
          )}
          {rows.length === 0 && (
            <div className="text-xs text-neutral-600 italic">
              waiting for first event…
            </div>
          )}
        </div>
      </Section>

      <div className="flex gap-2 pt-2">
        <button
          onClick={() => stopRun(task.id)}
          className="px-3 py-1.5 text-xs bg-neutral-800 hover:bg-neutral-700 border border-neutral-700 rounded text-neutral-200"
          title="SIGINT — claude finishes the in-flight tool, daemon stays alive for the next message"
        >
          Stop after current tool
        </button>
        <button
          onClick={() => cancelRun(task.id)}
          className="px-3 py-1.5 text-xs bg-red-950/40 hover:bg-red-900/40 border border-red-900/60 rounded text-red-200"
          title="SIGTERM — kill claude and the daemon, keep artifacts"
        >
          Cancel
        </button>
      </div>
    </>
  );
}

// --- activity row helpers ---

type Row =
  | { kind: 'pair'; key: string; events: Activity[] }
  | { kind: 'single'; key: string | number; event: Activity };

function buildRows(activity: Activity[]): Row[] {
  // Group events by toolCallId so a started+result pair renders as one row.
  const byCallId = new Map<string, Activity[]>();
  for (const a of activity) {
    if (!a.toolCallId) continue;
    const existing = byCallId.get(a.toolCallId) ?? [];
    existing.push(a);
    byCallId.set(a.toolCallId, existing);
  }

  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const a of activity) {
    if (a.toolCallId) {
      if (seen.has(a.toolCallId)) continue;
      seen.add(a.toolCallId);
      rows.push({
        kind: 'pair',
        key: a.toolCallId,
        events: byCallId.get(a.toolCallId)!,
      });
    } else {
      rows.push({
        kind: 'single',
        key: a.id ?? `row-${rows.length}`,
        event: a,
      });
    }
  }
  return rows;
}

function ToolCallRow({ events }: { events: Activity[] }) {
  const started = events.find((e) => e.type === 'tool_call_started');
  const result = events.find(
    (e) => e.type === 'tool_call_result' || e.type === 'tool_call_error'
  );
  const isError = result?.type === 'tool_call_error';
  const isPending = !result;

  const head = started ?? events[0];

  const statusIcon = isError ? (
    <span className="text-red-500 font-bold">✗</span>
  ) : isPending ? (
    <span className="text-blue-400 animate-pulse">●</span>
  ) : (
    <span className="text-green-500 font-bold">✓</span>
  );

  return (
    <div
      className={`flex items-start gap-3 text-xs ${
        isError ? 'text-red-300' : ''
      }`}
    >
      <div className="font-mono text-neutral-600 w-16 shrink-0">
        {head.timestamp}
      </div>
      <div className="w-4 shrink-0 mt-0.5 flex justify-center">
        {statusIcon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-neutral-200 font-mono break-all">
          {head.detail}
        </div>
        {result && (
          <div className="text-neutral-500 font-mono break-all mt-0.5 line-clamp-2">
            {result.detail}
          </div>
        )}
      </div>
    </div>
  );
}

function StandaloneRow({ activity }: { activity: Activity }) {
  const label = STANDALONE_LABEL[activity.type] ?? activity.type;
  return (
    <div className="flex items-start gap-3 text-xs">
      <div className="font-mono text-neutral-600 w-16 shrink-0">
        {activity.timestamp}
      </div>
      <div className="text-neutral-500 w-14 shrink-0 uppercase tracking-wider text-[10px] mt-0.5">
        {label}
      </div>
      <div className="text-neutral-300 font-mono break-all">
        {activity.detail}
      </div>
    </div>
  );
}
