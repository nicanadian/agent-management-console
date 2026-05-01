import { useStore } from '../../store';
import { useUIStore } from '../../uiStore';

export function InboxAssignPortrait({ taskId }: { taskId: string }) {
  const agents = useStore((s) => s.agents);
  const assignTask = useStore((s) => s.assignTask);
  const selectTask = useUIStore((s) => s.selectTask);

  const agentIds = agents.map((a) => a.id);

  return (
    <div onClick={(e) => e.stopPropagation()}>
      <div className="text-[10px] uppercase tracking-wider text-neutral-600 mb-1.5">
        Assign to
      </div>
      <div className="flex flex-wrap gap-1">
        {agentIds.slice(0, 4).map((id) => (
          <button
            key={id}
            onClick={() => assignTask(taskId, id)}
            className="px-1.5 py-0.5 text-[10px] bg-neutral-800 hover:bg-neutral-700 rounded border border-neutral-700"
          >
            {id.replace('-agent', '')}
          </button>
        ))}
        {agentIds.length > 4 && (
          <button
            onClick={() => selectTask(taskId)}
            className="px-1.5 py-0.5 text-[10px] text-neutral-500 hover:text-neutral-300"
          >
            +{agentIds.length - 4}
          </button>
        )}
      </div>
    </div>
  );
}
