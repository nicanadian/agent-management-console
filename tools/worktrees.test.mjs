// Tests for tools/worktrees.mjs against real scratch git repos.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerProject,
  resolveProject,
  ensureWorktree,
  commitWorkInProgress,
  mergeTaskBranch,
  removeWorktree,
  taskDiff,
  taskBranchName,
  needsSetup,
  startSetup,
  setupMarkerPath,
  openPullRequest,
  checkPullRequest,
} from './worktrees.mjs';

// Write an executable stub `gh` that prints `json` (or exits 1 if null).
function stubGh(json) {
  const path = join(root, 'gh');
  const body =
    json === null
      ? '#!/bin/sh\nexit 1\n'
      : `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(json)}\nJSON\n`;
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

// Run a setup command to completion (tests want a promise, not a callback).
function runSetup(opts) {
  return new Promise((resolve) => {
    startSetup({ ...opts, onExit: (code) => resolve(code) });
  });
}

let root; // scratch dir holding the fake repo + console dir
let repo;
let consoleDir;

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'worktrees-test-'));
  repo = join(root, 'repo');
  consoleDir = join(root, '.agent-console');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  git(repo, 'config', 'user.name', 'test');
  git(repo, 'config', 'user.email', 'test@local');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', 'init');
  registerProject(consoleDir, { name: 'demo', repoPath: repo });
});

afterEach(() => {
  delete process.env.GH_BIN;
  rmSync(root, { recursive: true, force: true });
});

function makeWorktree(taskId) {
  return ensureWorktree({ consoleDir, taskId, project: 'demo' });
}

function taskFor(taskId, wt) {
  return {
    id: taskId,
    title: 'demo task',
    project: 'demo',
    worktree: {
      path: wt.worktreePath,
      branch: wt.branch,
      repoPath: wt.repoPath,
      defaultBranch: wt.defaultBranch,
    },
  };
}

describe('registry', () => {
  it('detects the default branch and rejects non-repos', () => {
    expect(resolveProject(consoleDir, 'demo')).toEqual({
      repoPath: repo,
      defaultBranch: 'main',
    });
    expect(() =>
      registerProject(consoleDir, { name: 'bad', repoPath: root })
    ).toThrow(/not a git work tree/);
    expect(resolveProject(consoleDir, 'missing')).toBeNull();
  });

  it('stores setupCommand and github-pr mergeMode when given', () => {
    registerProject(consoleDir, {
      name: 'rich',
      repoPath: repo,
      setupCommand: '  npm install  ',
      mergeMode: 'github-pr',
    });
    expect(resolveProject(consoleDir, 'rich')).toEqual({
      repoPath: repo,
      defaultBranch: 'main',
      setupCommand: 'npm install', // trimmed
      mergeMode: 'github-pr',
    });
  });

  it('omits setupCommand/mergeMode when blank or default', () => {
    registerProject(consoleDir, {
      name: 'plain',
      repoPath: repo,
      setupCommand: '   ',
      mergeMode: 'local',
    });
    expect(resolveProject(consoleDir, 'plain')).toEqual({
      repoPath: repo,
      defaultBranch: 'main',
    });
  });
});

describe('setup hook', () => {
  it('runs the command in the worktree and writes a success marker', async () => {
    registerProject(consoleDir, {
      name: 'demo',
      repoPath: repo,
      setupCommand: 'echo hi > SETUP_RAN',
    });
    const wt = ensureWorktree({ consoleDir, taskId: 's1', project: 'demo' });
    expect(needsSetup(wt.worktreePath, wt.setupCommand)).toBe(true);

    const code = await runSetup({
      worktreePath: wt.worktreePath,
      setupCommand: wt.setupCommand,
    });
    expect(code).toBe(0);
    expect(existsSync(join(wt.worktreePath, 'SETUP_RAN'))).toBe(true);
    expect(existsSync(setupMarkerPath(wt.worktreePath))).toBe(true);
    expect(needsSetup(wt.worktreePath, wt.setupCommand)).toBe(false);
  });

  it('does not write a marker when setup fails', async () => {
    const wt = ensureWorktree({ consoleDir, taskId: 's2', project: 'demo' });
    const code = await runSetup({
      worktreePath: wt.worktreePath,
      setupCommand: 'exit 3',
    });
    expect(code).toBe(3);
    expect(existsSync(setupMarkerPath(wt.worktreePath))).toBe(false);
    expect(needsSetup(wt.worktreePath, 'exit 3')).toBe(true);
  });

  it('needsSetup is false when no setup command is configured', () => {
    const wt = ensureWorktree({ consoleDir, taskId: 's3', project: 'demo' });
    expect(needsSetup(wt.worktreePath, undefined)).toBe(false);
  });

  it('clears the marker on worktree removal so setup re-runs', async () => {
    registerProject(consoleDir, {
      name: 'demo',
      repoPath: repo,
      setupCommand: 'echo hi > SETUP_RAN',
    });
    const wt = ensureWorktree({ consoleDir, taskId: 's4', project: 'demo' });
    await runSetup({
      worktreePath: wt.worktreePath,
      setupCommand: wt.setupCommand,
    });
    expect(existsSync(setupMarkerPath(wt.worktreePath))).toBe(true);

    removeWorktree({
      task: {
        id: 's4',
        worktree: { path: wt.worktreePath, branch: wt.branch, repoPath: repo },
      },
    });
    expect(existsSync(setupMarkerPath(wt.worktreePath))).toBe(false);
  });
});

describe('ensureWorktree', () => {
  it('creates a worktree on a task branch, idempotently', () => {
    const wt = makeWorktree('t1');
    expect(wt.branch).toBe(taskBranchName('t1'));
    expect(existsSync(join(wt.worktreePath, 'README.md'))).toBe(true);
    expect(git(wt.worktreePath, 'symbolic-ref', '--short', 'HEAD')).toBe(
      'task/t1'
    );
    // second call returns the same worktree without erroring
    expect(makeWorktree('t1')).toEqual(wt);
  });

  it('returns null for unregistered projects', () => {
    expect(
      ensureWorktree({ consoleDir, taskId: 't1', project: 'nope' })
    ).toBeNull();
    expect(ensureWorktree({ consoleDir, taskId: 't1' })).toBeNull();
  });

  it('gives two tasks isolated working directories', () => {
    const a = makeWorktree('ta');
    const b = makeWorktree('tb');
    writeFileSync(join(a.worktreePath, 'a.txt'), 'from a\n');
    writeFileSync(join(b.worktreePath, 'b.txt'), 'from b\n');
    expect(existsSync(join(a.worktreePath, 'b.txt'))).toBe(false);
    expect(existsSync(join(b.worktreePath, 'a.txt'))).toBe(false);
  });
});

describe('mergeTaskBranch', () => {
  it('merges committed work into main', () => {
    const wt = makeWorktree('t1');
    writeFileSync(join(wt.worktreePath, 'feature.txt'), 'new feature\n');
    const result = mergeTaskBranch({ consoleDir, task: taskFor('t1', wt) });
    expect(result.ok).toBe(true);
    expect(result.mergeCommit).toBeTruthy();
    // main now contains the file (worktree auto-committed the WIP)
    expect(git(repo, 'show', 'main:feature.txt')).toBe('new feature');
  });

  it('reports no changes for an untouched worktree', () => {
    const wt = makeWorktree('t1');
    const result = mergeTaskBranch({ consoleDir, task: taskFor('t1', wt) });
    expect(result).toEqual({ ok: true, noChanges: true });
  });

  it('merges two parallel tasks touching different files', () => {
    const a = makeWorktree('ta');
    const b = makeWorktree('tb');
    writeFileSync(join(a.worktreePath, 'a.txt'), 'A\n');
    writeFileSync(join(b.worktreePath, 'b.txt'), 'B\n');
    expect(mergeTaskBranch({ consoleDir, task: taskFor('ta', a) }).ok).toBe(true);
    expect(mergeTaskBranch({ consoleDir, task: taskFor('tb', b) }).ok).toBe(true);
    expect(git(repo, 'show', 'main:a.txt')).toBe('A');
    expect(git(repo, 'show', 'main:b.txt')).toBe('B');
  });

  it('blocks on conflict and names the files', () => {
    const a = makeWorktree('ta');
    const b = makeWorktree('tb');
    writeFileSync(join(a.worktreePath, 'README.md'), 'version A\n');
    writeFileSync(join(b.worktreePath, 'README.md'), 'version B\n');
    expect(mergeTaskBranch({ consoleDir, task: taskFor('ta', a) }).ok).toBe(true);
    const result = mergeTaskBranch({ consoleDir, task: taskFor('tb', b) });
    expect(result.ok).toBe(false);
    expect(result.conflicts).toEqual(['README.md']);
    // main is untouched by the failed merge
    expect(git(repo, 'show', 'main:README.md')).toBe('version A');
  });

  it('fast-forwards a clean main checkout after merging', () => {
    const wt = makeWorktree('t1');
    writeFileSync(join(wt.worktreePath, 'feature.txt'), 'X\n');
    mergeTaskBranch({ consoleDir, task: taskFor('t1', wt) });
    // the human's checkout (repo itself, on main, clean) sees the file
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe('X\n');
  });

  it('leaves a dirty main checkout alone', () => {
    writeFileSync(join(repo, 'wip.txt'), 'human wip\n');
    const wt = makeWorktree('t1');
    writeFileSync(join(wt.worktreePath, 'feature.txt'), 'X\n');
    const result = mergeTaskBranch({ consoleDir, task: taskFor('t1', wt) });
    expect(result.ok).toBe(true);
    // ref moved…
    expect(git(repo, 'show', 'main:feature.txt')).toBe('X');
    // …but the dirty working tree was not reset
    expect(existsSync(join(repo, 'feature.txt'))).toBe(false);
    expect(readFileSync(join(repo, 'wip.txt'), 'utf8')).toBe('human wip\n');
  });
});

describe('removeWorktree', () => {
  it('removes the directory but keeps the branch', () => {
    const wt = makeWorktree('t1');
    writeFileSync(join(wt.worktreePath, 'feature.txt'), 'X\n');
    const task = taskFor('t1', wt);
    expect(removeWorktree({ task })).toBe(true);
    expect(existsSync(wt.worktreePath)).toBe(false);
    // branch survives as the audit record, including the swept WIP commit
    expect(git(repo, 'show', 'task/t1:feature.txt')).toBe('X');
    // idempotent
    expect(removeWorktree({ task })).toBe(false);
  });
});

describe('openPullRequest', () => {
  // Add a local bare repo as `origin` so push is real (no network).
  function addOrigin() {
    const bare = join(root, 'origin.git');
    execFileSync('git', ['init', '--bare', '-b', 'main', bare], {
      stdio: 'ignore',
    });
    git(repo, 'remote', 'add', 'origin', bare);
    git(repo, 'push', 'origin', 'main');
    return bare;
  }

  it('pushes the branch to origin and returns the PR url/number', () => {
    const bare = addOrigin();
    const wt = makeWorktree('tpr');
    writeFileSync(join(wt.worktreePath, 'feature.txt'), 'pr please\n');

    const calls = [];
    const ghCreate = (args) => {
      calls.push(args);
      return { url: 'https://github.com/acme/app/pull/42', number: 42 };
    };
    const result = openPullRequest({ task: taskFor('tpr', wt), ghCreate });

    expect(result).toEqual({
      ok: true,
      prUrl: 'https://github.com/acme/app/pull/42',
      prNumber: 42,
    });
    // gh got the right base/head
    expect(calls[0]).toMatchObject({ branch: 'task/tpr', defaultBranch: 'main' });
    // the branch really landed on the (bare) origin
    expect(git(bare, 'rev-parse', 'refs/heads/task/tpr')).toBe(
      git(repo, 'rev-parse', 'refs/heads/task/tpr')
    );
  });

  it('blocks when there is no origin remote (push fails)', () => {
    const wt = makeWorktree('tpr2');
    writeFileSync(join(wt.worktreePath, 'feature.txt'), 'x\n');
    const ghCreate = () => {
      throw new Error('should not be called when push fails');
    };
    const result = openPullRequest({ task: taskFor('tpr2', wt), ghCreate });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/push failed/i);
  });

  it('blocks when the branch has no commits to PR', () => {
    addOrigin();
    const wt = makeWorktree('tpr3'); // never touched
    const result = openPullRequest({
      task: taskFor('tpr3', wt),
      ghCreate: () => ({ url: 'x', number: 1 }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/no commits/i);
  });

  it('surfaces a gh failure as a blocked accept', () => {
    addOrigin();
    const wt = makeWorktree('tpr4');
    writeFileSync(join(wt.worktreePath, 'feature.txt'), 'x\n');
    const result = openPullRequest({
      task: taskFor('tpr4', wt),
      ghCreate: () => {
        const err = new Error('gh boom');
        err.stderr = 'gh: not authenticated';
        throw err;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/gh pr create failed/i);
  });
});

describe('checkPullRequest', () => {
  it('parses a merged PR from gh', () => {
    process.env.GH_BIN = stubGh({
      state: 'MERGED',
      mergedAt: '2026-06-12T00:00:00Z',
      mergeCommit: { oid: 'deadbeef' },
      url: 'https://github.com/acme/app/pull/9',
    });
    expect(checkPullRequest({ repoPath: repo, prNumber: 9 })).toEqual({
      state: 'MERGED',
      mergedAt: '2026-06-12T00:00:00Z',
      mergeCommit: 'deadbeef',
      url: 'https://github.com/acme/app/pull/9',
    });
  });

  it('parses an open PR (no merge fields)', () => {
    process.env.GH_BIN = stubGh({ state: 'OPEN', url: 'u' });
    const r = checkPullRequest({ repoPath: repo, prNumber: 1 });
    expect(r.state).toBe('OPEN');
    expect(r.mergedAt).toBeUndefined();
    expect(r.mergeCommit).toBeUndefined();
  });

  it('returns an error when gh fails', () => {
    process.env.GH_BIN = stubGh(null); // exits 1
    expect(checkPullRequest({ repoPath: repo, prNumber: 1 }).error).toBeTruthy();
  });
});

describe('taskDiff', () => {
  it('reports committed file changes and uncommitted paths', () => {
    const wt = makeWorktree('t1');
    writeFileSync(join(wt.worktreePath, 'done.txt'), 'committed\n');
    commitWorkInProgress(wt.worktreePath, 'progress');
    writeFileSync(join(wt.worktreePath, 'wip.txt'), 'not yet\n');

    const diff = taskDiff({ task: taskFor('t1', wt) });
    expect(diff.branch).toBe('task/t1');
    expect(diff.files).toEqual([{ path: 'done.txt', added: 1, deleted: 0 }]);
    expect(diff.uncommitted).toEqual(['wip.txt']);
  });

  it('returns null when the task has no worktree', () => {
    expect(taskDiff({ task: { id: 'x' } })).toBeNull();
  });
});
