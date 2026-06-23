#!/usr/bin/env node
// smoke-real-claude.mjs — OPT-IN end-to-end check with a REAL claude agent.
//
// Unlike the vitest suite, this spends tokens and is nondeterministic, so
// it is never run automatically. It proves the one thing the unit/live
// tests stand in for: a real claude daemon, spawned by the server into a
// per-task worktree, actually edits files that then merge into the repo.
//
//   node tools/smoke-real-claude.mjs
//
// Requires `claude` on PATH and authenticated. Runs entirely in a temp
// dir; cleans up on exit. Defaults the agent to `acceptEdits` — enough to
// let it write a file, without disabling the whole permission system.
// Override with CONSOLE_CLAUDE_PERMISSION_MODE=bypassPermissions for a
// broader run. Because this launches an autonomous agent, the operator
// must run it deliberately; it is intentionally not part of `npm test`.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), 'console-server.mjs');
const PORT = 13822;
const base = `http://127.0.0.1:${PORT}`;
const root = mkdtempSync(join(tmpdir(), 'smoke-claude-'));
const repo = join(root, 'repo');
const consoleDir = join(root, '.agent-console');

const git = (cwd, ...a) =>
  execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(path, body) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
async function getTask(id) {
  const r = await fetch(`${base}/api/tasks/${id}`);
  return r.ok ? r.json() : null;
}

// real git repo
execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
git(repo, 'config', 'user.name', 'human');
git(repo, 'config', 'user.email', 'human@local');
writeFileSync(join(repo, 'README.md'), '# demo repo\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-m', 'init');

const server = spawn('node', [SERVER], {
  env: {
    ...process.env,
    CONSOLE_DIR: consoleDir,
    CONSOLE_API_PORT: String(PORT),
    CONSOLE_CLAUDE_PERMISSION_MODE:
      process.env.CONSOLE_CLAUDE_PERMISSION_MODE || 'acceptEdits',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const slog = [];
server.stdout.on('data', (c) => slog.push(c.toString()));
server.stderr.on('data', (c) => slog.push('[err] ' + c.toString()));

let ok = true;
const expect = (label, cond, extra = '') => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) ok = false;
};

async function main() {
  for (let i = 0; i < 50; i++) {
    if (slog.join('').includes('listening on')) break;
    await sleep(100);
  }

  console.log('\n=== register repo + capture a real claude task ===');
  await post('/api/projects', { name: 'demo', repoPath: repo });
  const prompt =
    'Create a new file named HELLO.txt whose entire contents are the single line: hello from claude. Do not modify any other file.';
  const cap = await post('/api/capture', {
    title: 'smoke: create HELLO.txt',
    prompt,
    agentId: 'claude-code',
    project: 'demo',
  });
  const id = cap.body?.id;
  expect('task captured', !!id);
  const wt = join(consoleDir, 'worktrees', id);

  console.log('\n=== waiting for the real agent to finish (up to 4 min) ===');
  const deadline = Date.now() + 240000;
  let task = null;
  while (Date.now() < deadline) {
    task = await getTask(id);
    if (task?.lifecycleStatus === 'done') break;
    process.stdout.write('.');
    await sleep(2000);
  }
  console.log('');
  expect('run reached lifecycleStatus=done', task?.lifecycleStatus === 'done', task?.lifecycleStatus);
  expect('agent claimed success', task?.claimedStatus === 'succeeded', task?.claimedStatus);

  const helloPath = join(wt, 'HELLO.txt');
  expect('agent created HELLO.txt in its worktree', existsSync(helloPath),
    existsSync(wt) ? `worktree files: ${readdirSync(wt).join(', ')}` : 'worktree gone');
  if (existsSync(helloPath)) {
    console.log(`    HELLO.txt → ${JSON.stringify(readFileSync(helloPath, 'utf8'))}`);
  }

  console.log('\n=== accept → merge the real work into main ===');
  const accept = await post(`/api/tasks/${id}/accept`);
  expect('accepted', accept.body?.reviewStatus === 'accepted');
  expect('merge commit recorded', !!accept.body?.worktree?.mergeCommit);
  const merged = git(repo, 'ls-tree', '-r', '--name-only', 'main').split('\n');
  expect('HELLO.txt is on main after merge', merged.includes('HELLO.txt'),
    `main tree: ${merged.join(', ')}`);
  if (merged.includes('HELLO.txt')) {
    console.log(`    main:HELLO.txt → ${JSON.stringify(git(repo, 'show', 'main:HELLO.txt'))}`);
  }

  console.log(`\n=== ${ok ? 'SMOKE PASSED' : 'SMOKE FAILED'} ===`);
  if (!ok) console.log('\n--- server log tail ---\n' + slog.join('').split('\n').slice(-30).join('\n'));
}

main()
  .catch((e) => {
    console.error('driver error:', e);
    ok = false;
  })
  .finally(async () => {
    server.kill('SIGTERM');
    await sleep(400);
    if (server.exitCode === null) server.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
    process.exit(ok ? 0 : 1);
  });
