import { useState, useRef, useEffect, useMemo } from 'react';
import { useStore } from '../store';
import { useUIStore } from '../uiStore';
import { parseCapture } from './parseCapture';

export function CapturePalette() {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const captureTask = useStore((s) => s.captureTask);
  const closeCapture = useUIStore((s) => s.closeCapture);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const parsed = useMemo(() => parseCapture(value), [value]);
  const hasChips = !!(parsed.agentId || parsed.project || parsed.priority);
  const canSubmit = parsed.title.trim().length > 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    captureTask(parsed);
    setValue('');
    closeCapture();
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center pt-32 z-50"
      onClick={closeCapture}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl"
      >
        <div className="px-4 pt-3 text-xs text-neutral-500 uppercase tracking-wider flex items-center justify-between">
          <span>Capture task</span>
          <span className="text-[10px] text-neutral-600 normal-case tracking-normal">
            <span className="font-mono">@agent</span>{' '}
            <span className="font-mono">#project</span>{' '}
            <span className="font-mono">!priority</span>
          </span>
        </div>

        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="What needs doing?"
          className="w-full px-4 py-3 bg-transparent text-base outline-none text-neutral-100 placeholder-neutral-600"
        />

        {/* Chip preview row — appears once the user types a token */}
        {hasChips && (
          <div className="px-4 pb-3 flex flex-wrap items-center gap-1.5 text-xs">
            {parsed.agentId && (
              <Chip
                label={parsed.agentId}
                prefix="@"
                color="blue"
                title="Agent"
              />
            )}
            {parsed.project && (
              <Chip
                label={parsed.project}
                prefix="#"
                color="purple"
                title="Project"
              />
            )}
            {parsed.priority && (
              <Chip
                label={parsed.priority}
                prefix="!"
                color={
                  parsed.priority === 'urgent' || parsed.priority === 'high'
                    ? 'amber'
                    : 'neutral'
                }
                title="Priority"
              />
            )}
            {parsed.title && (
              <span className="ml-1 text-neutral-500 italic truncate">
                → "{parsed.title}"
              </span>
            )}
          </div>
        )}

        <div className="px-4 py-2 border-t border-neutral-800 text-xs text-neutral-500 flex justify-between">
          <div>↵ to capture · esc to close</div>
          <div>
            {canSubmit ? (
              <span className="text-blue-400">submit</span>
            ) : (
              <span className="text-neutral-700">type to capture</span>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

function Chip({
  prefix,
  label,
  color,
  title,
}: {
  prefix: string;
  label: string;
  color: 'blue' | 'purple' | 'amber' | 'neutral';
  title: string;
}) {
  const styles = {
    blue: 'bg-blue-950/40 border-blue-900/60 text-blue-200',
    purple: 'bg-purple-950/40 border-purple-900/60 text-purple-200',
    amber: 'bg-amber-950/40 border-amber-900/60 text-amber-200',
    neutral: 'bg-neutral-800 border-neutral-700 text-neutral-300',
  }[color];
  return (
    <span
      className={`inline-flex items-center gap-0.5 px-2 py-0.5 border rounded font-mono text-[11px] ${styles}`}
      title={title}
    >
      <span className="opacity-70">{prefix}</span>
      <span>{label}</span>
    </span>
  );
}
