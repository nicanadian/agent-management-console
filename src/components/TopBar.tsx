import { useStore } from '../store';
import { useUIStore } from '../uiStore';
import { spendSplit } from '../types';

export function TopBar() {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const openCapture = useUIStore((s) => s.openCapture);
  const openShortcuts = useUIStore((s) => s.openShortcuts);
  const openProjects = useUIStore((s) => s.openProjects);
  const projects = useStore((s) => s.projects);
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);

  const split = spendSplit(tasks);
  const apiUsd = split.apiUsd + split.unknownUsd;
  const subUsd = split.subscriptionUsd;
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

      {/* Cards ↔ Board toggle (also keyboard `v`) */}
      <div className="flex items-center rounded border border-neutral-800 overflow-hidden text-xs">
        {(['cards', 'board'] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            className={`px-2.5 py-1 capitalize ${
              viewMode === mode
                ? 'bg-neutral-800 text-neutral-100'
                : 'text-neutral-500 hover:text-neutral-300'
            }`}
            title={`${mode === 'cards' ? 'Cards' : 'Kanban board'} view (v toggles)`}
          >
            {mode}
          </button>
        ))}
      </div>

      <button
        onClick={openCapture}
        className="px-3 py-1 text-sm bg-blue-600 hover:bg-blue-500 rounded text-white font-medium flex items-center gap-2"
      >
        + New task
        <kbd className="text-[10px] px-1 py-0.5 bg-blue-700/60 rounded font-mono">
          c
        </kbd>
      </button>

      <button
        onClick={openProjects}
        className="text-xs text-neutral-400 hover:text-neutral-200 px-2 py-1 rounded hover:bg-neutral-800"
        title="Manage projects (p) — register repos for worktree-isolated tasks"
      >
        <span className="text-neutral-200 font-medium">{projects.length}</span>{' '}
        {projects.length === 1 ? 'project' : 'projects'}
      </button>

      <div className="text-xs text-neutral-400">
        <span className="text-neutral-200 font-medium">{availableAgents}</span>{' '}
        agents available
      </div>

      <div className="text-xs font-mono text-neutral-400 flex items-center gap-2">
        {apiUsd > 0 && (
          <span title="API key (real billed dollars)">
            <span className="text-neutral-200 font-medium">
              ${apiUsd.toFixed(2)}
            </span>{' '}
            api
          </span>
        )}
        {subUsd > 0 && (
          <span
            className="text-neutral-500"
            title="Notional — covered by Claude Code subscription quota"
          >
            <span className="text-neutral-300 font-medium">
              ~${subUsd.toFixed(2)}
            </span>{' '}
            sub
          </span>
        )}
        {apiUsd === 0 && subUsd === 0 && (
          <span className="text-neutral-600">$0.00 today</span>
        )}
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
