// worktrees.mjs — per-task git worktree isolation (Phase 13).
//
// Multiple agents can work the same repo simultaneously because each task
// gets its own worktree + branch:
//
//   registry   .agent-console/projects.json maps task.project → repo
//   spawn      ensureWorktree() creates <CONSOLE_DIR>/worktrees/<taskId>
//              on branch task/<taskId>; the daemon gets it as --cwd
//   accept     mergeTaskBranch() merges task/<taskId> into the default
//              branch; a conflict blocks the accept instead of half-applying
//   archive    removeWorktree() deletes the worktree, keeps the branch as
//              the audit record
//
// All git calls are execFileSync — the server is single-threaded, so
// synchronous merges are inherently serialized (no merge lock needed).
// The merge itself uses `git merge-tree --write-tree` + `commit-tree` +
// `update-ref` plumbing (git ≥ 2.38): it never touches any working tree,
// so a human checkout of the repo is never clobbered mid-merge. The only
// follow-up is a fast-forward sync of the main checkout when it has the
// default branch checked out *and* is clean.

import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  openSync,
  closeSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

const PROJECTS_FILE = 'projects.json';

function git(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  }).trim();
}

// Like git(), but returns { status, stdout, stderr } instead of throwing —
// merge-tree uses exit code 1 to mean "conflict" (info on stdout), and
// push/network failures report on stderr.
function gitRaw(repo, args) {
  try {
    const stdout = execFileSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    if (typeof err.status === 'number' && err.stdout !== undefined) {
      return {
        status: err.status,
        stdout: String(err.stdout),
        stderr: String(err.stderr ?? ''),
      };
    }
    throw err;
  }
}

function firstLine(s) {
  return (s || '').split('\n').map((l) => l.trim()).filter(Boolean)[0] || '';
}

// The gh binary — overridable so tests can point at a stub.
function ghBin() {
  return process.env.GH_BIN || 'gh';
}

// --- Project registry ---

export function loadProjects(consoleDir) {
  const file = join(consoleDir, PROJECTS_FILE);
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

export function saveProjects(consoleDir, projects) {
  mkdirSync(consoleDir, { recursive: true });
  const file = join(consoleDir, PROJECTS_FILE);
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(projects, null, 2));
  renameSync(tmp, file);
}

// Validates and normalizes a registration. Throws on a non-repo path.
//   setupCommand — optional shell command run once in each fresh worktree
//                  (e.g. `npm install`) before the agent's first turn.
//   mergeMode    — 'local' (default; merge on accept) or 'github-pr'
//                  (push branch + open a PR on accept).
export function registerProject(
  consoleDir,
  { name, repoPath, defaultBranch, setupCommand, mergeMode }
) {
  if (!name || !repoPath) throw new Error('name and repoPath required');
  const abs = resolve(repoPath);
  let inside;
  try {
    inside = git(abs, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    inside = '';
  }
  if (inside !== 'true') {
    throw new Error(`${abs} is not a git work tree`);
  }
  const branch =
    defaultBranch || git(abs, ['symbolic-ref', '--short', 'HEAD']);
  const entry = { repoPath: abs, defaultBranch: branch };
  if (setupCommand && setupCommand.trim()) entry.setupCommand = setupCommand.trim();
  if (mergeMode === 'github-pr') entry.mergeMode = 'github-pr';
  const projects = loadProjects(consoleDir);
  projects[name] = entry;
  saveProjects(consoleDir, projects);
  return projects[name];
}

export function resolveProject(consoleDir, projectName) {
  if (!projectName) return null;
  const projects = loadProjects(consoleDir);
  return projects[projectName] || null;
}

// --- Worktree lifecycle ---

export function taskBranchName(taskId) {
  return `task/${taskId}`;
}

// Idempotent: returns the existing worktree if it's already set up.
// Returns null when the task has no registered project (the daemon then
// runs in the server's cwd, exactly as before Phase 13).
export function ensureWorktree({ consoleDir, taskId, project }) {
  const proj = resolveProject(consoleDir, project);
  if (!proj) return null;
  const { repoPath, defaultBranch, setupCommand, mergeMode } = proj;
  const branch = taskBranchName(taskId);
  const worktreePath = join(resolve(consoleDir), 'worktrees', taskId);
  const info = {
    worktreePath,
    branch,
    repoPath,
    defaultBranch,
    setupCommand,
    mergeMode: mergeMode || 'local',
  };

  if (existsSync(join(worktreePath, '.git'))) {
    return info;
  }

  mkdirSync(join(resolve(consoleDir), 'worktrees'), { recursive: true });

  const branchExists =
    gitRaw(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      .status === 0;
  if (branchExists) {
    // Re-attach (e.g. worktree dir was deleted but the branch survived).
    git(repoPath, ['worktree', 'prune']);
    git(repoPath, ['worktree', 'add', worktreePath, branch]);
  } else {
    git(repoPath, ['worktree', 'add', '-b', branch, worktreePath, defaultBranch]);
  }
  return info;
}

// --- One-time worktree setup (e.g. npm install) ---

// Marker sits beside the worktree dir (never inside it, so it can't leak
// into a commit). Its presence means setup already succeeded here.
export function setupMarkerPath(worktreePath) {
  return `${worktreePath}.setup-ok`;
}

export function needsSetup(worktreePath, setupCommand) {
  return !!setupCommand && !existsSync(setupMarkerPath(worktreePath));
}

// Runs the project's setup command once in a fresh worktree. Detached +
// async so the HTTP handler that triggered it stays responsive; the
// caller gates the daemon spawn on `onExit`. Writes the success marker
// only on exit 0, so a failed/interrupted setup re-runs next time.
// Returns the ChildProcess (tests await its 'exit').
export function startSetup({ worktreePath, setupCommand, logFile, onExit }) {
  const out = logFile ? openSync(logFile, 'a') : 'ignore';
  const closeOut = () => {
    if (typeof out === 'number') {
      try {
        closeSync(out);
      } catch {
        /* already closed */
      }
    }
  };
  const child = spawn(setupCommand, {
    cwd: worktreePath,
    shell: true,
    stdio: ['ignore', out, out],
  });
  child.on('exit', (code) => {
    closeOut();
    if (code === 0) {
      try {
        writeFileSync(setupMarkerPath(worktreePath), new Date().toISOString());
      } catch {
        /* best effort — worse case setup re-runs */
      }
    }
    onExit?.(code ?? 1);
  });
  child.on('error', (err) => {
    closeOut();
    onExit?.(-1, err);
  });
  return child;
}

// Agents don't reliably commit. Sweep anything left in the worktree into
// a commit so merge/diff always see the full state of the task's work.
// Returns true if a commit was created.
export function commitWorkInProgress(worktreePath, message) {
  if (!existsSync(worktreePath)) return false;
  const dirty = git(worktreePath, ['status', '--porcelain']);
  if (!dirty) return false;
  git(worktreePath, ['add', '-A']);
  git(worktreePath, [
    '-c', 'user.name=agent-console',
    '-c', 'user.email=console@local',
    'commit', '-m', message,
  ]);
  return true;
}

// --- Merge (accept) ---

// Returns one of:
//   { ok: true, mergeCommit }            merged into defaultBranch
//   { ok: true, noChanges: true }        branch adds nothing; nothing to do
//   { ok: false, conflicts: [files...] } merge blocked; caller decides
export function mergeTaskBranch({ consoleDir, task }) {
  const wt = task.worktree;
  if (!wt || !wt.branch || !wt.repoPath) {
    return { ok: true, noChanges: true };
  }
  const { repoPath, branch } = wt;
  const defaultBranch =
    wt.defaultBranch ||
    resolveProject(consoleDir, task.project)?.defaultBranch ||
    'main';

  commitWorkInProgress(
    wt.path,
    `task ${task.id}: ${task.title || 'work in progress'}`
  );

  const target = git(repoPath, ['rev-parse', `refs/heads/${defaultBranch}`]);
  const source = git(repoPath, ['rev-parse', `refs/heads/${branch}`]);

  // Branch never diverged → nothing to merge.
  if (source === target) return { ok: true, noChanges: true };
  const base = git(repoPath, ['merge-base', target, source]);
  if (base === source) return { ok: true, noChanges: true };

  // Plumbing merge: compute the merged tree without any working tree.
  // With --name-only, conflict output is: tree oid, conflicted paths,
  // blank line, then informational messages.
  const mt = gitRaw(repoPath, [
    'merge-tree', '--write-tree', '--name-only', target, source,
  ]);
  if (mt.status !== 0) {
    const lines = mt.stdout.split('\n').slice(1);
    const blank = lines.indexOf('');
    const conflicts = [
      ...new Set(lines.slice(0, blank === -1 ? undefined : blank).filter(Boolean)),
    ];
    return { ok: false, conflicts };
  }
  const tree = mt.stdout.split('\n')[0].trim();

  const mergeCommit = git(repoPath, [
    '-c', 'user.name=agent-console',
    '-c', 'user.email=console@local',
    'commit-tree', tree,
    '-p', target,
    '-p', source,
    '-m', `Merge ${branch}: ${task.title || task.id} (accepted via agent-console)`,
  ]);

  // Decide whether the main checkout can be fast-forwarded BEFORE moving
  // the ref — once update-ref runs, the checkout's status reads dirty
  // (working tree lags the new HEAD) even when the human changed nothing.
  const canSyncCheckout = isCleanlyOnBranch(repoPath, defaultBranch);

  // Compare-and-swap so a concurrent ref move (human pushed/committed
  // between our rev-parse and now) fails loudly instead of overwriting.
  git(repoPath, [
    'update-ref',
    `refs/heads/${defaultBranch}`,
    mergeCommit,
    target,
  ]);

  // Fast-forward the human's checkout so `git status` there stays
  // truthful. Dirty or different-branch checkouts are left alone.
  if (canSyncCheckout) {
    git(repoPath, ['reset', '--hard', mergeCommit]);
  }
  return { ok: true, mergeCommit };
}

function isCleanlyOnBranch(repoPath, branch) {
  try {
    const head = git(repoPath, ['symbolic-ref', '--short', 'HEAD']);
    if (head !== branch) return false;
    return git(repoPath, ['status', '--porcelain']) === '';
  } catch {
    // detached HEAD / bare repo — nothing to sync
    return false;
  }
}

// --- Cleanup (archive) ---

// Removes the worktree directory; keeps the branch — it's the audit
// record of what the task did, merged or not.
export function removeWorktree({ task }) {
  const wt = task.worktree;
  if (!wt || !wt.path || !wt.repoPath) return false;
  if (!existsSync(wt.path)) return false;
  // Sweep uncommitted work onto the branch first so nothing is lost.
  try {
    commitWorkInProgress(wt.path, `task ${task.id}: final state before archive`);
  } catch {
    /* best effort */
  }
  git(wt.repoPath, ['worktree', 'remove', '--force', wt.path]);
  git(wt.repoPath, ['worktree', 'prune']);
  // Drop the setup marker so a re-created worktree re-runs setup against
  // its fresh (empty) tree.
  try {
    rmSync(setupMarkerPath(wt.path), { force: true });
  } catch {
    /* best effort */
  }
  return true;
}

// --- Diff (review surface) ---

// What did this task change relative to where it branched off?
// Committed work reads from refs; uncommitted files are listed separately
// so the review surface never hides in-flight edits.
export function taskDiff({ task }) {
  const wt = task.worktree;
  if (!wt || !wt.branch || !wt.repoPath) return null;
  const { repoPath, branch } = wt;
  const defaultBranch = wt.defaultBranch || 'main';

  const branchOk =
    gitRaw(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
      .status === 0;
  if (!branchOk) return null;

  const base = git(repoPath, ['merge-base', `refs/heads/${defaultBranch}`, `refs/heads/${branch}`]);
  const stat = git(repoPath, ['diff', '--stat', `${base}..refs/heads/${branch}`]);
  const numstat = git(repoPath, ['diff', '--numstat', `${base}..refs/heads/${branch}`]);
  const files = numstat
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [added, deleted, path] = line.split('\t');
      return { path, added: Number(added) || 0, deleted: Number(deleted) || 0 };
    });

  let uncommitted = [];
  if (wt.path && existsSync(wt.path)) {
    uncommitted = git(wt.path, ['status', '--porcelain'])
      .split('\n')
      .filter(Boolean)
      .map((l) => l.slice(3));
  }

  return { branch, defaultBranch, baseCommit: base, stat, files, uncommitted };
}

// --- GitHub PR adapter (accept, github-pr mode) ---

// Default PR creator — shells out to the gh CLI in the repo (so it picks
// up the repo's origin/auth). Isolated and injectable so tests can drive
// the real push without needing gh installed/authenticated.
function defaultGhCreate({ repoPath, branch, defaultBranch, task }) {
  const title = task.title || `task ${task.id}`;
  const body = `Opened via agent-console for task ${task.id}.`;
  const out = execFileSync(
    ghBin(),
    [
      'pr', 'create',
      '--base', defaultBranch,
      '--head', branch,
      '--title', title,
      '--body', body,
    ],
    { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
  // gh prints the PR URL as the last non-empty stdout line.
  const url = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  const m = url.match(/\/pull\/(\d+)/);
  return { url, number: m ? Number(m[1]) : undefined };
}

// Push the task branch to origin and open a PR. Replaces the local merge
// on accept for github-pr projects. Returns:
//   { ok: true, prUrl, prNumber }      PR opened
//   { ok: false, error }               push/gh failed — caller blocks accept
// The git push is real; `ghCreate` is injectable for tests.
export function openPullRequest({ task, ghCreate = defaultGhCreate }) {
  const wt = task.worktree;
  if (!wt || !wt.branch || !wt.repoPath) {
    return { ok: false, error: 'task has no worktree branch' };
  }
  const { repoPath, branch } = wt;
  const defaultBranch = wt.defaultBranch || 'main';

  // Sweep WIP into a commit so the PR carries the full state.
  commitWorkInProgress(
    wt.path,
    `task ${task.id}: ${task.title || 'work in progress'}`
  );

  // Nothing to PR if the branch hasn't moved past the base.
  const base = git(repoPath, [
    'merge-base', `refs/heads/${defaultBranch}`, `refs/heads/${branch}`,
  ]);
  const head = git(repoPath, ['rev-parse', `refs/heads/${branch}`]);
  if (base === head) {
    return { ok: false, error: 'branch has no commits to open a PR from' };
  }

  // Push the branch. -u sets upstream so a later `gh pr create --head` and
  // subsequent pushes resolve cleanly.
  const push = gitRaw(repoPath, ['push', '-u', 'origin', branch]);
  if (push.status !== 0) {
    return {
      ok: false,
      error: `git push failed: ${firstLine(push.stderr) || firstLine(push.stdout) || 'no origin remote?'}`,
    };
  }

  try {
    const { url, number } = ghCreate({ repoPath, branch, defaultBranch, task });
    if (!url) return { ok: false, error: 'gh pr create returned no URL' };
    return { ok: true, prUrl: url, prNumber: number };
  } catch (err) {
    const reason =
      err.code === 'ENOENT'
        ? 'gh CLI not found on PATH'
        : firstLine(String(err.stderr || '')) || err.message || String(err);
    return { ok: false, error: `gh pr create failed: ${reason}` };
  }
}

// Read a PR's current state so the console can learn when work that left
// for GitHub actually merged. Returns:
//   { state: 'OPEN'|'MERGED'|'CLOSED', mergedAt?, mergeCommit?, url? }
//   { error } when gh is missing / the PR can't be read (caller retries)
export function checkPullRequest({ repoPath, prNumber }) {
  if (!prNumber) return { error: 'no prNumber' };
  try {
    const out = execFileSync(
      ghBin(),
      ['pr', 'view', String(prNumber), '--json', 'state,mergedAt,mergeCommit,url'],
      { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const j = JSON.parse(out);
    return {
      state: j.state,
      mergedAt: j.mergedAt || undefined,
      mergeCommit: j.mergeCommit?.oid || undefined,
      url: j.url || undefined,
    };
  } catch (err) {
    const reason =
      err.code === 'ENOENT'
        ? 'gh CLI not found on PATH'
        : firstLine(String(err.stderr || '')) || err.message || String(err);
    return { error: reason };
  }
}
