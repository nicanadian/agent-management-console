import { useState, useRef, useEffect } from 'react';
import { useStore } from '../../store';
import type { Task, Message as MessageT, Attachment } from '../../types';
import { Section } from './shared';
import { filesToAttachments, formatBytes } from '../../utils/attachments';

export function Conversation({ task }: { task: Task }) {
  const sendMessage = useStore((s) => s.sendMessage);
  const [reply, setReply] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isWaiting = !!task.waitingOnUser;
  const isRunning = task.lifecycleStatus === 'running';

  useEffect(() => {
    // Scroll to bottom when messages change
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [task.messages?.length]);

  async function handleSend(mode: 'auto' | 'interrupt') {
    const text = reply.trim();
    if (!text && attachments.length === 0) return;
    const encoded =
      attachments.length > 0 ? await filesToAttachments(attachments) : undefined;
    sendMessage(task.id, text, mode, encoded);
    setReply('');
    setAttachments([]);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e.metaKey || e.ctrlKey ? 'interrupt' : 'auto');
    }
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
    // Only clear when the cursor truly leaves the composer wrapper
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

  const canSend = reply.trim().length > 0 || attachments.length > 0;

  return (
    <Section title={`Conversation (${task.messages?.length || 0})`}>
      <div ref={scrollRef} className="space-y-5 max-h-[32rem] overflow-y-auto pr-2">
        {task.messages?.map((m, i) => (
          <Message key={i} message={m} agentName={task.agentId} />
        ))}
        {task.pendingReply && (
          <div className="flex justify-end">
            <div className="max-w-[80%]">
              <div className="text-[10px] uppercase tracking-wider text-neutral-600 mb-1 text-right font-mono">
                queued · will deliver after current step
              </div>
              <div className="bg-neutral-800/40 border border-dashed border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-400 italic">
                {task.pendingReply.text}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="mt-4">
        <div
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          className={`bg-neutral-950/60 border rounded ${
            isDragOver
              ? 'border-blue-500/70 bg-blue-950/20'
              : isWaiting
                ? 'border-yellow-700/60 focus-within:border-yellow-500'
                : 'border-neutral-800 focus-within:border-neutral-600'
          }`}
        >
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-2">
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
          <div className="flex items-center gap-2 px-3 py-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              className="text-neutral-500 hover:text-neutral-100 hover:bg-neutral-800/60 rounded w-6 h-6 flex items-center justify-center text-lg leading-none shrink-0"
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
              value={reply}
              onChange={(e) => setReply(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                isDragOver
                  ? 'Drop files to attach…'
                  : isWaiting
                    ? 'Reply…'
                    : isRunning
                      ? 'Queue reply…'
                      : 'Message agent…'
              }
              className="flex-1 bg-transparent text-sm outline-none text-neutral-100 placeholder-neutral-600"
            />
            <button
              onClick={() => handleSend('auto')}
              disabled={!canSend}
              className={`text-xs font-medium px-2 py-0.5 rounded ${
                canSend
                  ? 'text-blue-400 hover:text-blue-300'
                  : 'text-neutral-700 cursor-not-allowed'
              }`}
            >
              Send
            </button>
          </div>
        </div>
        <div className="mt-1 text-[10px] text-neutral-600">
          {isRunning && !isWaiting ? (
            <>
              <kbd className="font-mono">↵</kbd> queue ·{' '}
              <kbd className="font-mono">⌘↵</kbd> interrupt now · drop files
              to attach
            </>
          ) : (
            <>
              <kbd className="font-mono">↵</kbd> send · drop files to attach
            </>
          )}
        </div>
      </div>
    </Section>
  );
}

function Message({
  message,
  agentName,
}: {
  message: MessageT;
  agentName?: string;
}) {
  const isUser = message.from === 'user';

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%]">
          <div className="text-[10px] uppercase tracking-wider mb-1 font-mono flex items-center gap-2 text-blue-500/70 justify-end">
            <span>{message.timestamp}</span>
            <span>you</span>
          </div>
          {message.text && (
            <div className="rounded-lg px-3.5 py-2.5 text-[15px] leading-[1.6] bg-blue-950/40 border border-blue-900/50 text-neutral-100">
              <MessageBody text={message.text} />
            </div>
          )}
          {message.attachments && message.attachments.length > 0 && (
            <AttachmentList
              attachments={message.attachments}
              align="right"
              spacedTop={!!message.text}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="border-l-2 border-neutral-800 pl-4">
      <div className="text-[10px] uppercase tracking-wider mb-1.5 font-mono flex items-center gap-2 text-neutral-500">
        <span>{agentName || 'agent'}</span>
        <span>{message.timestamp}</span>
      </div>
      {message.text && (
        <div className="text-[15px] leading-[1.7] text-neutral-100">
          <MessageBody text={message.text} />
        </div>
      )}
      {message.attachments && message.attachments.length > 0 && (
        <AttachmentList
          attachments={message.attachments}
          align="left"
          spacedTop={!!message.text}
        />
      )}
    </div>
  );
}

function AttachmentList({
  attachments,
  align,
  spacedTop,
}: {
  attachments: Attachment[];
  align: 'left' | 'right';
  spacedTop: boolean;
}) {
  return (
    <div
      className={`flex flex-wrap gap-2 ${spacedTop ? 'mt-2' : ''} ${
        align === 'right' ? 'justify-end' : ''
      }`}
    >
      {attachments.map((a, i) => (
        <AttachmentTile key={i} attachment={a} />
      ))}
    </div>
  );
}

function AttachmentTile({ attachment }: { attachment: Attachment }) {
  const isImage = attachment.mimeType.startsWith('image/');
  if (isImage) {
    return (
      <a
        href={attachment.dataUrl}
        target="_blank"
        rel="noreferrer"
        className="block group"
        title={`${attachment.name} · ${formatBytes(attachment.size)}`}
      >
        <img
          src={attachment.dataUrl}
          alt={attachment.name}
          className="max-h-48 max-w-xs rounded border border-neutral-700 group-hover:border-neutral-500 object-cover"
        />
        <div className="mt-1 text-[10px] text-neutral-500 font-mono truncate max-w-xs">
          {attachment.name} · {formatBytes(attachment.size)}
        </div>
      </a>
    );
  }
  return (
    <a
      href={attachment.dataUrl}
      download={attachment.name}
      className="inline-flex items-center gap-2 bg-neutral-800/70 border border-neutral-700 hover:border-neutral-500 rounded px-2.5 py-1.5 text-xs text-neutral-200 max-w-full"
      title={`${attachment.name} · ${formatBytes(attachment.size)}`}
    >
      <span className="truncate max-w-[14rem]">{attachment.name}</span>
      <span className="text-neutral-500 text-[10px] font-mono shrink-0">
        {formatBytes(attachment.size)}
      </span>
    </a>
  );
}

function MessageBody({ text }: { text: string }) {
  const blocks = splitCodeFences(text);
  return (
    <>
      {blocks.map((block, i) =>
        block.kind === 'code' ? (
          <pre
            key={i}
            className="my-2 overflow-x-auto rounded-md bg-neutral-950/80 border border-neutral-800 px-3 py-2 text-[13px] leading-[1.55] font-mono text-neutral-200"
          >
            {block.text}
          </pre>
        ) : (
          <ProseBlock key={i} text={block.text} />
        )
      )}
    </>
  );
}

function ProseBlock({ text }: { text: string }) {
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.length > 0);
  if (paragraphs.length === 0) return null;
  return (
    <>
      {paragraphs.map((p, i) => (
        <p key={i} className="whitespace-pre-wrap [&:not(:last-child)]:mb-3">
          {renderInline(p)}
        </p>
      ))}
    </>
  );
}

function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  const re = /`([^`\n]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <code
        key={key++}
        className="font-mono text-[0.9em] bg-neutral-800/60 border border-neutral-800 rounded px-1 py-0.5 text-neutral-100"
      >
        {m[1]}
      </code>
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function splitCodeFences(text: string): { kind: 'prose' | 'code'; text: string }[] {
  const out: { kind: 'prose' | 'code'; text: string }[] = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last)
      out.push({ kind: 'prose', text: text.slice(last, m.index) });
    out.push({ kind: 'code', text: m[1].replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: 'prose', text: text.slice(last) });
  return out.length === 0 ? [{ kind: 'prose', text }] : out;
}
