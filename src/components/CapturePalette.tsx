import { useState, useRef, useEffect, useMemo } from 'react';
import { useStore } from '../store';
import { useUIStore } from '../uiStore';
import { parseCapture } from './parseCapture';
import { filesToAttachments, formatBytes } from '../utils/attachments';

export function CapturePalette() {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const captureTask = useStore((s) => s.captureTask);
  const closeCapture = useUIStore((s) => s.closeCapture);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const parsed = useMemo(() => parseCapture(value), [value]);
  const hasChips = !!(parsed.agentId || parsed.project || parsed.priority);
  const canSubmit = parsed.title.trim().length > 0;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    const encoded =
      attachments.length > 0 ? await filesToAttachments(attachments) : undefined;
    captureTask({ ...parsed, attachments: encoded });
    setValue('');
    setAttachments([]);
    closeCapture();
  }

  function addFiles(files: FileList | File[]) {
    const next = Array.from(files);
    if (next.length === 0) return;
    setAttachments((prev) => [...prev, ...next]);
  }

  function removeAttachment(idx: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== idx));
  }

  function handleDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    setIsDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    if (
      e.relatedTarget &&
      e.currentTarget.contains(e.relatedTarget as Node)
    )
      return;
    setIsDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center pt-32 z-50"
      onClick={closeCapture}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-2xl bg-neutral-900 border rounded-lg shadow-2xl ${
          isDragOver
            ? 'border-blue-500/70 bg-blue-950/10'
            : 'border-neutral-700'
        }`}
      >
        <div className="px-4 pt-3 text-xs text-neutral-500 uppercase tracking-wider flex items-center justify-between">
          <span>Capture task</span>
          <span className="text-[10px] text-neutral-600 normal-case tracking-normal">
            <span className="font-mono">@agent</span>{' '}
            <span className="font-mono">#project</span>{' '}
            <span className="font-mono">!priority</span>
          </span>
        </div>

        <div className="flex items-center pl-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="text-neutral-500 hover:text-neutral-100 hover:bg-neutral-800/60 rounded w-7 h-7 flex items-center justify-center text-lg leading-none shrink-0"
            title="Attach files"
          >
            +
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            ref={inputRef}
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              isDragOver ? 'Drop files to attach…' : 'What needs doing?'
            }
            className="flex-1 px-3 py-3 bg-transparent text-base outline-none text-neutral-100 placeholder-neutral-600"
          />
        </div>

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

        {attachments.length > 0 && (
          <div className="px-4 pb-3 flex flex-wrap gap-1.5">
            {attachments.map((f, i) => (
              <span
                key={i}
                className="inline-flex items-center gap-1.5 bg-neutral-800/70 border border-neutral-700 rounded px-2 py-0.5 text-xs text-neutral-200 max-w-full"
                title={`${f.name} · ${formatBytes(f.size)}`}
              >
                <span className="truncate max-w-[14rem]">{f.name}</span>
                <span className="text-neutral-500 text-[10px] font-mono shrink-0">
                  {formatBytes(f.size)}
                </span>
                <button
                  type="button"
                  onClick={() => removeAttachment(i)}
                  className="text-neutral-500 hover:text-neutral-200 leading-none shrink-0"
                  title="Remove"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="px-4 py-2 border-t border-neutral-800 text-xs text-neutral-500 flex justify-between">
          <div>↵ to capture · esc to close · drop files to attach</div>
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
