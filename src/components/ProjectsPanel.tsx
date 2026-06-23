import { useState } from 'react';
import { useStore } from '../store';
import { useUIStore } from '../uiStore';

// Phase 13 — register git repos so tasks tagged #<project> run in an
// isolated worktree. The server validates the path (must be a git work
// tree) and detects the default branch when left blank.
export function ProjectsPanel() {
  const projects = useStore((s) => s.projects);
  const registerProject = useStore((s) => s.registerProject);
  const close = useUIStore((s) => s.closeProjects);

  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('');
  const [setupCommand, setSetupCommand] = useState('');
  const [mergeMode, setMergeMode] = useState<'local' | 'github-pr'>('local');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSubmit = name.trim() && repoPath.trim() && !busy;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const result = await registerProject({
      name: name.trim(),
      repoPath: repoPath.trim(),
      defaultBranch: defaultBranch.trim() || undefined,
      setupCommand: setupCommand.trim() || undefined,
      mergeMode,
    });
    setBusy(false);
    if (result.ok) {
      setName('');
      setRepoPath('');
      setDefaultBranch('');
      setSetupCommand('');
      setMergeMode('local');
    } else {
      setError(result.error);
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-start justify-center pt-24 z-50"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-neutral-900 border border-neutral-700 rounded-lg shadow-2xl"
      >
        <div className="px-5 py-3 border-b border-neutral-800 flex items-center justify-between">
          <span className="text-sm font-medium text-neutral-200 uppercase tracking-wider">
            Projects
          </span>
          <button
            onClick={close}
            className="text-neutral-500 hover:text-neutral-300 text-xl leading-none"
          >
            ×
          </button>
        </div>

        {/* Existing registrations */}
        <div className="px-5 py-3 space-y-1.5 max-h-64 overflow-y-auto">
          {projects.length === 0 ? (
            <div className="text-xs text-neutral-600 italic py-2">
              No projects yet. Register a git repo below, then capture a task
              with <span className="font-mono text-neutral-500">#name</span> to
              run it in an isolated worktree.
            </div>
          ) : (
            projects.map((p) => (
              <div
                key={p.name}
                className="flex items-center gap-3 text-sm bg-neutral-800/40 border border-neutral-800 rounded px-3 py-2"
              >
                <span className="font-mono text-purple-300 shrink-0">
                  #{p.name}
                </span>
                <span className="text-neutral-400 truncate flex-1" title={p.repoPath}>
                  {p.repoPath}
                </span>
                {p.setupCommand && (
                  <span
                    className="text-[10px] font-mono text-neutral-500 shrink-0 hidden sm:inline"
                    title={`setup: ${p.setupCommand}`}
                  >
                    ⚙ {p.setupCommand}
                  </span>
                )}
                {p.mergeMode === 'github-pr' && (
                  <span
                    className="text-[10px] uppercase font-mono tracking-wider text-blue-300/80 bg-blue-950/40 border border-blue-900/40 px-1 rounded shrink-0"
                    title="Accept opens a GitHub PR instead of merging locally"
                  >
                    PR
                  </span>
                )}
                <span className="text-[11px] font-mono text-neutral-600 shrink-0">
                  {p.defaultBranch || 'main'}
                </span>
              </div>
            ))
          )}
        </div>

        {/* Register form */}
        <form
          onSubmit={submit}
          className="px-5 py-4 border-t border-neutral-800 space-y-3"
        >
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <Field label="Name (#tag)">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-app"
                className="w-full px-2.5 py-1.5 bg-neutral-950 border border-neutral-800 rounded text-sm outline-none focus:border-neutral-600 text-neutral-100 placeholder-neutral-600 font-mono"
              />
            </Field>
            <Field label="Repo path (absolute)">
              <input
                value={repoPath}
                onChange={(e) => setRepoPath(e.target.value)}
                placeholder="/Users/you/repos/my-app"
                className="w-full px-2.5 py-1.5 bg-neutral-950 border border-neutral-800 rounded text-sm outline-none focus:border-neutral-600 text-neutral-100 placeholder-neutral-600 font-mono"
              />
            </Field>
          </div>
          <div className="grid grid-cols-[1fr_2fr] gap-3">
            <Field label="Default branch (optional)">
              <input
                value={defaultBranch}
                onChange={(e) => setDefaultBranch(e.target.value)}
                placeholder="auto"
                className="w-full px-2.5 py-1.5 bg-neutral-950 border border-neutral-800 rounded text-sm outline-none focus:border-neutral-600 text-neutral-100 placeholder-neutral-600 font-mono"
              />
            </Field>
            <Field label="Setup command (optional — run once per worktree)">
              <input
                value={setupCommand}
                onChange={(e) => setSetupCommand(e.target.value)}
                placeholder="npm install"
                className="w-full px-2.5 py-1.5 bg-neutral-950 border border-neutral-800 rounded text-sm outline-none focus:border-neutral-600 text-neutral-100 placeholder-neutral-600 font-mono"
              />
            </Field>
          </div>

          <Field label="On accept">
            <div className="flex items-center rounded border border-neutral-800 overflow-hidden text-xs w-fit">
              {(
                [
                  ['local', 'Merge locally'],
                  ['github-pr', 'Open GitHub PR'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setMergeMode(mode)}
                  className={`px-3 py-1.5 ${
                    mergeMode === mode
                      ? 'bg-neutral-800 text-neutral-100'
                      : 'text-neutral-500 hover:text-neutral-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </Field>

          {mergeMode === 'github-pr' && (
            <div className="text-[11px] text-neutral-500">
              Requires <span className="font-mono">gh</span> authenticated and an{' '}
              <span className="font-mono">origin</span> remote on the repo.
            </div>
          )}

          {error && (
            <div className="text-xs text-red-300 bg-red-950/30 border border-red-900/40 rounded px-2.5 py-1.5">
              {error}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={!canSubmit}
              className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-800 disabled:text-neutral-600 rounded text-white font-medium"
            >
              {busy ? 'Registering…' : 'Register project'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-[11px] text-neutral-500 mb-1">{label}</div>
      {children}
    </label>
  );
}
