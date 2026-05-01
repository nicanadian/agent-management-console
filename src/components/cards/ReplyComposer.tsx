import { useState, useRef } from 'react';
import { useStore } from '../../store';
import { useUIStore } from '../../uiStore';
import type { Task } from '../../types';

export function ReplyComposer({
  task,
  messageCount,
}: {
  task: Task;
  messageCount: number;
}) {
  const sendMessage = useStore((s) => s.sendMessage);
  const selectTask = useUIStore((s) => s.selectTask);
  const [reply, setReply] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const isWaiting = !!task.waitingOnUser;
  const isRunning = task.lifecycleStatus === 'running';

  function handleSend(mode: 'auto' | 'interrupt') {
    const text = reply.trim();
    if (!text) return;
    sendMessage(task.id, text, mode);
    setReply('');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e.metaKey || e.ctrlKey ? 'interrupt' : 'auto');
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    }
  }

  // What will Enter do?
  const enterAction =
    isRunning && !isWaiting
      ? task.pendingReply
        ? 'replace queued'
        : 'queue'
      : 'send';

  return (
    <div className="px-2 pb-2 mt-auto shrink-0">
      <div
        className={`flex items-center gap-1 bg-neutral-950/60 border rounded px-2 py-1 ${
          isWaiting
            ? 'border-yellow-700/60 focus-within:border-yellow-500'
            : 'border-neutral-800 focus-within:border-neutral-600'
        }`}
      >
        <input
          ref={inputRef}
          type="text"
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            isWaiting ? 'Reply…' : isRunning ? 'Queue reply…' : 'Message…'
          }
          className="flex-1 min-w-0 bg-transparent text-[12px] outline-none text-neutral-100 placeholder-neutral-600"
        />
        <button
          onClick={() => handleSend('auto')}
          disabled={!reply.trim()}
          className={`text-[11px] font-medium px-1.5 rounded shrink-0 ${
            reply.trim()
              ? 'text-blue-400 hover:text-blue-300'
              : 'text-neutral-700 cursor-not-allowed'
          }`}
        >
          {enterAction === 'send'
            ? 'Send'
            : enterAction === 'queue'
              ? 'Queue'
              : 'Replace'}
        </button>
      </div>
      <div className="mt-1 px-0.5 flex items-center justify-between text-[9px] text-neutral-600">
        <div>
          {isRunning && !isWaiting ? (
            <>
              <kbd className="font-mono">↵</kbd> queue ·{' '}
              <kbd className="font-mono">⌘↵</kbd> int.
            </>
          ) : (
            <>
              <kbd className="font-mono">↵</kbd> send
            </>
          )}
        </div>
        <button
          onClick={() => selectTask(task.id)}
          className="hover:text-neutral-400"
        >
          {messageCount > 0
            ? `${messageCount} msg${messageCount === 1 ? '' : 's'} →`
            : 'open →'}
        </button>
      </div>
    </div>
  );
}
