import { useStore } from '../../store';
import { useUIStore } from '../../uiStore';
import type { Task } from '../../types';
import { taskBucket, latestRun, taskCost } from '../../types';
import { STATUS_DOT } from './statusDot';
import { useMessageStack } from './useMessageStack';
import { ReplyComposer } from './ReplyComposer';
import { InboxAssignPortrait } from './InboxAssignPortrait';

export function ChatCard({ task }: { task: Task }) {
  const selectTask = useUIStore((s) => s.selectTask);
  const sendMessage = useStore((s) => s.sendMessage);

  const messages = task.messages || [];
  const stack = useMessageStack(messages);

  const bucket = taskBucket(task);
  const isWaiting = !!task.waitingOnUser;
  const isRunning = bucket === 'running';
  const isInbox = bucket === 'inbox';
  const run = latestRun(task);
  const cost = taskCost(task);

  const accentBorder = isWaiting
    ? 'border-yellow-700/50'
    : isRunning
      ? 'border-blue-900/40'
      : bucket === 'failed'
        ? 'border-red-900/40'
        : bucket === 'blocked'
          ? 'border-amber-900/50'
          : 'border-neutral-800';

  const accentBg = isWaiting ? 'bg-yellow-950/10' : '';

  return (
    <div
      className="relative isolate"
      style={{ width: 230 + stack.totalShift, height: 400 + stack.totalShift }}
    >
      {/* Background layers — one per non-selected message */}
      {messages.map((msg, i) => {
        if (i === stack.selectedIdx) return null;
        const pos = stack.positionFor(i);
        const isAgent = msg.from === 'agent';
        return (
          <button
            key={i}
            onClick={(e) => {
              e.stopPropagation();
              stack.setSelectedIdx(i);
            }}
            className={`absolute w-[230px] h-[400px] rounded-lg border bg-neutral-900/80 hover:bg-neutral-900 cursor-pointer transition-colors ${
              isAgent
                ? 'border-neutral-800 hover:border-neutral-600'
                : 'border-blue-950/60 hover:border-blue-800'
            }`}
            style={{ top: pos, left: pos, zIndex: i + 1 }}
            title={`${msg.from} · ${msg.timestamp}`}
          />
        );
      })}

      {/* Front overlay — header, body, composer */}
      <div
        className={`absolute w-[230px] h-[400px] flex flex-col bg-neutral-900/95 border ${accentBorder} ${accentBg} rounded-lg overflow-hidden shadow-lg transition-all duration-150`}
        style={{ top: stack.overlayPos, left: stack.overlayPos, zIndex: 100 }}
      >
        {/* Header */}
        <div
          className="px-3 pt-2.5 pb-1.5 cursor-pointer hover:bg-neutral-900/40 shrink-0"
          onClick={() => selectTask(task.id)}
        >
          <div className="flex items-center gap-1.5 mb-1">
            <div
              className={`w-1.5 h-1.5 rounded-full ${STATUS_DOT[bucket]} ${
                isWaiting || isRunning ? 'animate-pulse' : ''
              }`}
            />
            <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-500">
              {bucket}
            </span>
            <div className="ml-auto text-[10px] text-neutral-500 font-mono">
              {run?.runtime && <span>{run.runtime}</span>}
              {run?.runtime && cost.totalUsd > 0 && <span> · </span>}
              {cost.totalUsd > 0 && (
                <span
                  className={
                    cost.billingMode === 'subscription'
                      ? 'text-neutral-600'
                      : undefined
                  }
                  title={
                    cost.billingMode === 'subscription'
                      ? 'Notional — covered by Claude Code subscription quota.'
                      : cost.isApproximate
                        ? 'Approximate (sum of runs; cache effects mean per-task accounting is best-effort)'
                        : undefined
                  }
                >
                  {cost.billingMode === 'subscription' || cost.isApproximate
                    ? '~'
                    : ''}
                  ${cost.totalUsd.toFixed(2)}
                </span>
              )}
            </div>
          </div>
          {(task.agentId || task.project) && (
            <div className="text-[11px] text-neutral-500 truncate">
              {task.agentId}
              {task.agentId && task.project && ' · '}
              {task.project}
            </div>
          )}
          {task.createdBy && task.createdBy !== 'ui' && (
            <div className="mt-1">
              <span
                className="text-[9px] uppercase font-mono tracking-wider text-blue-300/70 bg-blue-950/40 border border-blue-900/40 px-1 rounded"
                title={`Captured by ${task.createdBy}`}
              >
                from {task.createdBy}
              </span>
            </div>
          )}
        </div>

        {/* Title */}
        <div
          className="px-3 text-[13px] font-medium text-neutral-100 leading-snug line-clamp-2 cursor-pointer shrink-0"
          onClick={() => selectTask(task.id)}
        >
          {task.title}
        </div>

        {/* Waiting badge */}
        {isWaiting && (
          <div className="px-3 mt-1.5 text-[10px] uppercase tracking-wider text-yellow-400 font-medium shrink-0">
            ⚠ waiting on you
          </div>
        )}

        {/* Body — message preview / inbox assign / status */}
        <div
          className="px-3 mt-2 mb-2 flex-1 min-h-0 overflow-hidden cursor-pointer"
          onClick={() => selectTask(task.id)}
        >
          {stack.selectedMessage ? (
            <div className="h-full flex flex-col">
              <div className="flex items-center gap-1.5 mb-1 text-[10px] font-mono uppercase tracking-wider">
                <span
                  className={
                    stack.selectedMessage.from === 'user'
                      ? 'text-blue-400'
                      : 'text-neutral-500'
                  }
                >
                  {stack.selectedMessage.from === 'user'
                    ? 'you'
                    : task.agentId || 'agent'}
                </span>
                <span className="text-neutral-600">·</span>
                <span className="text-neutral-600">
                  {stack.selectedMessage.timestamp}
                </span>
                {!stack.isLatestSelected && (
                  <span className="ml-auto text-neutral-600 text-[9px]">
                    ← older
                  </span>
                )}
              </div>
              <div
                className={`text-[12px] leading-snug line-clamp-6 ${
                  stack.selectedMessage.from === 'user'
                    ? 'text-blue-200/90 italic'
                    : 'text-neutral-300'
                }`}
              >
                {stack.selectedMessage.text}
              </div>
            </div>
          ) : isInbox ? (
            <InboxAssignPortrait taskId={task.id} />
          ) : bucket === 'queued' ? (
            <div className="text-[11px] text-neutral-500 italic">
              waiting to start…
            </div>
          ) : (
            <div className="text-[11px] text-neutral-600 italic">
              no messages yet
            </div>
          )}
        </div>

        {/* Stack navigation — only when there are multiple messages */}
        {stack.messageCount > 1 && (
          <div
            className="px-3 pb-1.5 flex items-center justify-between text-[10px] text-neutral-500 shrink-0"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              onClick={() => stack.cycle(-1)}
              disabled={stack.selectedIdx === 0}
              className="hover:text-neutral-200 disabled:opacity-30 disabled:cursor-not-allowed px-1"
              title="Previous message"
            >
              ◄
            </button>
            <span className="font-mono">
              {stack.selectedIdx + 1} / {stack.messageCount}
            </span>
            <button
              onClick={() => stack.cycle(1)}
              disabled={stack.selectedIdx === stack.messageCount - 1}
              className="hover:text-neutral-200 disabled:opacity-30 disabled:cursor-not-allowed px-1"
              title="Next message"
            >
              ►
            </button>
          </div>
        )}

        {/* Pending reply chip */}
        {task.pendingReply && (
          <div className="mx-3 mb-1.5 px-2 py-1 bg-neutral-800/60 border border-neutral-700 rounded text-[11px] text-neutral-400 shrink-0">
            <div className="flex items-center gap-1">
              <span className="text-neutral-600 font-mono text-[9px] uppercase">
                queued
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  sendMessage(
                    task.id,
                    task.pendingReply!.text,
                    'interrupt',
                    task.pendingReply!.attachments
                  );
                }}
                className="ml-auto text-blue-400 hover:text-blue-300 text-[10px]"
              >
                send now
              </button>
            </div>
            <div className="truncate text-neutral-400">
              {task.pendingReply.text}
            </div>
          </div>
        )}

        {/* Reply input — hide for inbox/done */}
        {bucket !== 'inbox' && bucket !== 'done' && (
          <ReplyComposer task={task} messageCount={stack.messageCount} />
        )}
      </div>
    </div>
  );
}
