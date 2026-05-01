import { useStore } from '../store';
import { useUIStore } from '../uiStore';
import { totalCost } from '../types';

export function TopBar() {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const openCapture = useUIStore((s) => s.openCapture);
  const openShortcuts = useUIStore((s) => s.openShortcuts);

  const todayCost = tasks.reduce((sum, t) => sum + totalCost(t), 0);
  const availableAgents = agents.filter((a) => a.status === 'available').length;

  return (
    <div className="flex items-center gap-4 px-4 py-2 border-b border-neutral-800 bg-neutral-950">
      <div className="font-semibold text-neutral-200 tracking-tight">
        Agent Console
      </div>

      <input
        type="text"
        placeholder="Search tasks..."
        className="flex-1 max-w-md px-3 py-1 text-sm bg-neutral-900 border border-neutral-800 rounded outline-none focus:border-neutral-700 placeholder-neutral-600"
      />

      <button
        onClick={openCapture}
        className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-500 rounded text-white font-medium flex items-center gap-2"
      >
        + New task
        <kbd className="text-[10px] px-1 py-0.5 bg-blue-700/60 rounded font-mono">
          c
        </kbd>
      </button>

      <div className="text-xs text-neutral-400">
        <span className="text-neutral-200 font-medium">{availableAgents}</span>{' '}
        agents available
      </div>

      <div
        className="text-xs font-mono text-neutral-400"
        title="Approximate (sum across all tasks; cache effects mean per-task accounting is best-effort)"
      >
        <span className="text-neutral-200 font-medium">
          ~${todayCost.toFixed(2)}
        </span>{' '}
        today
      </div>

      <button
        onClick={openShortcuts}
        className="text-xs text-neutral-500 hover:text-neutral-300 w-6 h-6 flex items-center justify-center rounded hover:bg-neutral-800"
        title="Keyboard shortcuts"
      >
        ?
      </button>
    </div>
  );
}
