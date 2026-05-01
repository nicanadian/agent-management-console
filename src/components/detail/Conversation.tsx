import { useState, useRef, useEffect } from 'react';
import { useStore } from '../../store';
import type { Task, Message as MessageT } from '../../types';
import { Section } from './shared';

export function Conversation({ task }: { task: Task }) {
  const sendMessage = useStore((s) => s.sendMessage);
  const [reply, setReply] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const isWaiting = !!task.waitingOnUser;
  const isRunning = task.lifecycleStatus === 'running';

  useEffect(() => {
    // Scroll to bottom when messages change
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [task.messages?.length]);

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
  }

  return (
    <Section title={`Conversation (${task.messages?.length || 0})`}>
      <div ref={scrollRef} className="space-y-3 max-h-96 overflow-y-auto pr-1">
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
          className={`flex items-center gap-2 bg-neutral-950/60 border rounded px-3 py-2 ${
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
              isWaiting ? 'Reply…' : isRunning ? 'Queue reply…' : 'Message agent…'
            }
            className="flex-1 bg-transparent text-sm outline-none text-neutral-100 placeholder-neutral-600"
          />
          <button
            onClick={() => handleSend('auto')}
            disabled={!reply.trim()}
            className={`text-xs font-medium px-2 py-0.5 rounded ${
              reply.trim()
                ? 'text-blue-400 hover:text-blue-300'
                : 'text-neutral-700 cursor-not-allowed'
            }`}
          >
            Send
          </button>
        </div>
        <div className="mt-1 text-[10px] text-neutral-600">
          {isRunning && !isWaiting ? (
            <>
              <kbd className="font-mono">↵</kbd> queue ·{' '}
              <kbd className="font-mono">⌘↵</kbd> interrupt now
            </>
          ) : (
            <>
              <kbd className="font-mono">↵</kbd> send
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
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div className="max-w-[85%]">
        <div
          className={`text-[10px] uppercase tracking-wider mb-1 font-mono flex items-center gap-2 ${
            isUser ? 'text-blue-500/70 justify-end' : 'text-neutral-500'
          }`}
        >
          {isUser ? (
            <>
              <span>{message.timestamp}</span>
              <span>you</span>
            </>
          ) : (
            <>
              <span>{agentName || 'agent'}</span>
              <span>{message.timestamp}</span>
            </>
          )}
        </div>
        <div
          className={`rounded-lg px-3 py-2 text-sm leading-relaxed ${
            isUser
              ? 'bg-blue-950/40 border border-blue-900/50 text-neutral-100'
              : 'bg-neutral-900/60 border border-neutral-800 text-neutral-200'
          }`}
        >
          {message.text}
        </div>
      </div>
    </div>
  );
}
