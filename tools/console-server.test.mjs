// Integration tests for tools/console-server.mjs.
//
// Spawns the real server against a temp CONSOLE_DIR on an ephemeral port,
// then drives it over HTTP. Coarse but honest — exercises the actual
// request handlers, query parsing, and on-disk layout. Covers Phase 12
// additions: createdBy provenance, per-entity reads, SSE event stream.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  'console-server.mjs'
);

let consoleDir;
let server;
let port;
let baseUrl;

// Pick a fresh high port per test so concurrent vitest workers don't clash.
function pickPort() {
  return 13900 + Math.floor(Math.random() * 1000);
}

async function startServer(extraEnv = {}) {
  port = pickPort();
  baseUrl = `http://127.0.0.1:${port}`;
  server = spawn(
    'node',
    [SERVER_PATH],
    {
      env: {
        ...process.env,
        CONSOLE_DIR: consoleDir,
        CONSOLE_API_PORT: String(port),
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  // Wait for the "listening" log line. If it never comes, surface stderr.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('console-server did not start within 5s'));
    }, 5000);
    server.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('listening on')) {
        clearTimeout(timer);
        resolve();
      }
    });
    server.stderr.on('data', (chunk) => {
      // Capture for debugging if startup fails.
      // eslint-disable-next-line no-console
      console.error('server stderr:', chunk.toString());
    });
    server.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`console-server exited early with code ${code}`));
    });
  });
}

async function stopServer() {
  // Capture the handle: `server` is rebound by the next beforeEach, so a
  // stale force-kill timer reading the module variable would SIGKILL the
  // NEXT test's server ~2s in (seen as "exited early with code null").
  const s = server;
  if (!s || s.exitCode !== null) return;
  await new Promise((resolve) => {
    // Force-kill if it doesn't shut down in 2s; cleared on normal exit.
    const forceKill = setTimeout(() => {
      if (s.exitCode === null) s.kill('SIGKILL');
    }, 2000);
    s.once('exit', () => {
      clearTimeout(forceKill);
      resolve();
    });
    s.kill('SIGTERM');
  });
}

beforeEach(async () => {
  consoleDir = mkdtempSync(join(tmpdir(), 'console-server-test-'));
  await startServer();
});

afterEach(async () => {
  await stopServer();
  rmSync(consoleDir, { recursive: true, force: true });
});

async function capture(body) {
  const res = await fetch(`${baseUrl}/api/capture`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res;
}

async function getJson(path) {
  const res = await fetch(`${baseUrl}${path}`);
  return { status: res.status, body: res.ok ? await res.json() : null };
}

// --- SSE helpers ---

function parseSseChunk(chunk) {
  const out = {};
  for (const line of chunk.split('\n')) {
    if (!line || line.startsWith(':')) continue; // comment / heartbeat
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx);
    const value = line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') out.event = value;
    else if (field === 'id') out.id = value;
    else if (field === 'data') out.data = value;
  }
  if (out.data === undefined) return null;
  try {
    out.parsed = JSON.parse(out.data);
  } catch {
    return null;
  }
  return out;
}

function openSse(path, headers = {}) {
  const controller = new AbortController();
  const events = [];
  let buf = '';
  let error;
  const ready = (async () => {
    const res = await fetch(`${baseUrl}${path}`, {
      signal: controller.signal,
      headers,
    });
    if (!res.body) throw new Error('SSE response has no body');
    const reader = res.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += Buffer.from(value).toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const part = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = parseSseChunk(part);
          if (ev) events.push(ev);
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') error = err;
    }
  })();

  return {
    events,
    close: () => controller.abort(),
    waitFor: async (n, timeoutMs = 3000) => {
      const start = Date.now();
      while (events.length < n) {
        if (error) throw error;
        if (Date.now() - start > timeoutMs) {
          throw new Error(
            `waitFor(${n}) timed out at ${events.length} events`
          );
        }
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    settle: () => ready,
  };
}

function appendEvent(ev) {
  appendFileSync(
    join(consoleDir, 'events.jsonl'),
    JSON.stringify(ev) + '\n'
  );
}

describe('Phase 12.1 — createdBy provenance', () => {
  it('defaults createdBy to "ui" when capture omits it', async () => {
    const res = await capture({ title: 'no provenance' });
    expect(res.status).toBe(200);
    const task = await res.json();
    expect(task.createdBy).toBe('ui');
  });

  it('persists explicit createdBy', async () => {
    const res = await capture({ title: 'from hermes', createdBy: 'hermes' });
    const task = await res.json();
    expect(task.createdBy).toBe('hermes');
  });

  it('filters /api/state by createdBy', async () => {
    await capture({ title: 'a', createdBy: 'ui' });
    await capture({ title: 'b', createdBy: 'hermes' });
    await capture({ title: 'c', createdBy: 'hermes' });

    const all = await getJson('/api/state');
    expect(all.body.tasks).toHaveLength(3);

    const onlyHermes = await getJson('/api/state?createdBy=hermes');
    expect(onlyHermes.body.tasks).toHaveLength(2);
    expect(onlyHermes.body.tasks.every((t) => t.createdBy === 'hermes')).toBe(
      true
    );

    const onlyUi = await getJson('/api/state?createdBy=ui');
    expect(onlyUi.body.tasks).toHaveLength(1);
    expect(onlyUi.body.tasks[0].title).toBe('a');
  });

  it('treats missing createdBy on disk as "ui" for filter purposes', async () => {
    // Write a task JSON directly (simulating a pre-12.1 task that has no
    // createdBy field) and confirm `?createdBy=ui` includes it.
    mkdirSync(join(consoleDir, 'tasks'), { recursive: true });
    writeFileSync(
      join(consoleDir, 'tasks', 'legacy.json'),
      JSON.stringify({
        id: 'legacy',
        title: 'old task',
        type: 'coding',
        priority: 'normal',
        agentId: 'claude-code',
        lifecycleStatus: 'inbox',
        claimedStatus: 'none',
        validationStatus: 'not_applicable',
        reviewStatus: 'pending',
        createdAt: '2026-04-01T00:00:00Z',
        updatedAt: '2026-04-01T00:00:00Z',
      })
    );
    const ui = await getJson('/api/state?createdBy=ui');
    expect(ui.body.tasks.some((t) => t.id === 'legacy')).toBe(true);
  });
});

describe('Phase 12.2 — per-entity reads', () => {
  it('GET /api/tasks/:id returns the task or 404', async () => {
    const captureRes = await capture({ title: 'fetch me' });
    const created = await captureRes.json();

    const found = await getJson(`/api/tasks/${created.id}`);
    expect(found.status).toBe(200);
    expect(found.body.id).toBe(created.id);
    expect(found.body.title).toBe('fetch me');

    const missing = await getJson('/api/tasks/does-not-exist');
    expect(missing.status).toBe(404);
  });

  it('GET /api/tasks/:id/messages returns [] when no queue exists', async () => {
    const captureRes = await capture({ title: 'no messages' });
    const created = await captureRes.json();

    const messages = await getJson(`/api/tasks/${created.id}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.body).toEqual([]);
  });

  it('GET /api/tasks/:id/messages parses the JSONL queue', async () => {
    // Hand-write the queue file to avoid needing a daemon to drain it.
    const taskId = 't-msgs';
    mkdirSync(join(consoleDir, 'tasks'), { recursive: true });
    mkdirSync(join(consoleDir, 'messages'), { recursive: true });
    writeFileSync(
      join(consoleDir, 'tasks', `${taskId}.json`),
      JSON.stringify({ id: taskId, title: 'with msgs' })
    );
    writeFileSync(
      join(consoleDir, 'messages', `${taskId}.jsonl`),
      [
        JSON.stringify({ text: 'hi', mode: 'auto', timestamp: 't1' }),
        JSON.stringify({ text: 'follow-up', mode: 'queue', timestamp: 't2' }),
      ].join('\n') + '\n'
    );
    const messages = await getJson(`/api/tasks/${taskId}/messages`);
    expect(messages.status).toBe(200);
    expect(messages.body).toHaveLength(2);
    expect(messages.body[0].text).toBe('hi');
    expect(messages.body[1].mode).toBe('queue');
  });

  it('GET /api/runs/:id returns the run or 404', async () => {
    const runId = 'r-test';
    mkdirSync(join(consoleDir, 'runs'), { recursive: true });
    writeFileSync(
      join(consoleDir, 'runs', `${runId}.json`),
      JSON.stringify({
        id: runId,
        taskId: 't1',
        agentId: 'claude-code',
        status: 'succeeded',
        startedAt: '2026-05-01T00:00:00Z',
      })
    );
    const found = await getJson(`/api/runs/${runId}`);
    expect(found.status).toBe(200);
    expect(found.body.id).toBe(runId);

    const missing = await getJson('/api/runs/does-not-exist');
    expect(missing.status).toBe(404);
  });
});

describe('Phase 12.3 — SSE event stream', () => {
  it('catchup: emits all events with seq > since', async () => {
    appendEvent({ seq: 1, type: 'a', taskId: 't1' });
    appendEvent({ seq: 2, type: 'b', taskId: 't2' });
    appendEvent({ seq: 3, type: 'c', taskId: 't1' });

    const sse = openSse('/api/events?since=0');
    await sse.waitFor(3);
    expect(sse.events.map((e) => e.parsed.seq)).toEqual([1, 2, 3]);
    expect(sse.events.map((e) => e.event)).toEqual(['a', 'b', 'c']);
    expect(sse.events.map((e) => e.id)).toEqual(['1', '2', '3']);
    sse.close();
  });

  it('catchup: skips events with seq <= since', async () => {
    appendEvent({ seq: 1, type: 'a' });
    appendEvent({ seq: 2, type: 'b' });
    appendEvent({ seq: 3, type: 'c' });

    const sse = openSse('/api/events?since=1');
    await sse.waitFor(2);
    expect(sse.events.map((e) => e.parsed.seq)).toEqual([2, 3]);
    sse.close();
  });

  it('tail: emits live appends after catchup', async () => {
    appendEvent({ seq: 1, type: 'a' });
    const sse = openSse('/api/events?since=0');
    await sse.waitFor(1);

    appendEvent({ seq: 2, type: 'b' });
    appendEvent({ seq: 3, type: 'c' });
    await sse.waitFor(3);

    expect(sse.events.map((e) => e.parsed.seq)).toEqual([1, 2, 3]);
    sse.close();
  });

  it('reconnect with Last-Event-ID skips already-seen events', async () => {
    appendEvent({ seq: 1, type: 'a' });
    appendEvent({ seq: 2, type: 'b' });

    const first = openSse('/api/events?since=0');
    await first.waitFor(2);
    first.close();
    await new Promise((r) => setTimeout(r, 50));

    appendEvent({ seq: 3, type: 'c' });

    // Reconnect with Last-Event-ID = 2 — should ONLY see seq=3.
    const second = openSse('/api/events', { 'Last-Event-ID': '2' });
    await second.waitFor(1);
    expect(second.events.map((e) => e.parsed.seq)).toEqual([3]);
    second.close();
  });

  it('Last-Event-ID header takes precedence over ?since=', async () => {
    appendEvent({ seq: 1, type: 'a' });
    appendEvent({ seq: 2, type: 'b' });

    const sse = openSse('/api/events?since=0', { 'Last-Event-ID': '1' });
    await sse.waitFor(1);
    expect(sse.events.map((e) => e.parsed.seq)).toEqual([2]);
    sse.close();
  });

  it('?taskId= filters catchup and tail to one task', async () => {
    appendEvent({ seq: 1, type: 'a', taskId: 't1' });
    appendEvent({ seq: 2, type: 'b', taskId: 't2' });
    appendEvent({ seq: 3, type: 'c', taskId: 't1' });

    const sse = openSse('/api/events?since=0&taskId=t1');
    await sse.waitFor(2);

    appendEvent({ seq: 4, type: 'd', taskId: 't2' });
    appendEvent({ seq: 5, type: 'e', taskId: 't1' });
    await sse.waitFor(3);

    expect(sse.events.map((e) => e.parsed.seq)).toEqual([1, 3, 5]);
    sse.close();
  });
});

// --- Phase 13 — worktrees: projects API, accept=merge, archive=cleanup ---

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { ensureWorktree } from './worktrees.mjs';

function gitIn(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeRepo() {
  const repo = join(consoleDir, 'fake-repo');
  execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' });
  gitIn(repo, 'config', 'user.name', 'test');
  gitIn(repo, 'config', 'user.email', 'test@local');
  writeFileSync(join(repo, 'README.md'), 'hello\n');
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-m', 'init');
  return repo;
}

async function postJson(path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, body: await res.json() };
}

// Writes a task that already has a worktree, simulating what ensureDaemon
// does at spawn time (we can't spawn real claude in tests).
function seedWorktreeTask(taskId, repo, overrides = {}) {
  const wt = ensureWorktree({ consoleDir, taskId, project: 'demo' });
  const task = {
    id: taskId,
    title: `task ${taskId}`,
    type: 'coding',
    priority: 'normal',
    project: 'demo',
    agentId: 'claude-code',
    lifecycleStatus: 'done',
    claimedStatus: 'succeeded',
    validationStatus: 'not_applicable',
    reviewStatus: 'pending',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runs: [],
    messages: [],
    worktree: {
      path: wt.worktreePath,
      branch: wt.branch,
      repoPath: wt.repoPath,
      defaultBranch: wt.defaultBranch,
      mergeMode: wt.mergeMode || 'local',
    },
    ...overrides,
  };
  mkdirSync(join(consoleDir, 'tasks'), { recursive: true });
  writeFileSync(
    join(consoleDir, 'tasks', `${taskId}.json`),
    JSON.stringify(task, null, 2)
  );
  return { task, wt };
}

describe('Phase 13 — project registry', () => {
  it('registers a repo and lists it', async () => {
    const repo = makeRepo();
    const reg = await postJson('/api/projects', { name: 'demo', repoPath: repo });
    expect(reg.status).toBe(200);
    expect(reg.body.defaultBranch).toBe('main');

    const list = await getJson('/api/projects');
    expect(list.body.demo.repoPath).toBe(repo);
  });

  it('rejects a path that is not a git repo', async () => {
    const reg = await postJson('/api/projects', {
      name: 'bad',
      repoPath: consoleDir,
    });
    expect(reg.status).toBe(400);
    expect(reg.body.error).toMatch(/not a git work tree/);
  });
});

describe('Phase 13 — accept merges the task branch', () => {
  it('merges into main, archives, and removes the worktree', async () => {
    const repo = makeRepo();
    await postJson('/api/projects', { name: 'demo', repoPath: repo });
    const { wt } = seedWorktreeTask('t-merge', repo);
    writeFileSync(join(wt.worktreePath, 'feature.txt'), 'shipped\n');

    const res = await postJson('/api/tasks/t-merge/accept');
    expect(res.status).toBe(200);
    expect(res.body.reviewStatus).toBe('accepted');
    expect(res.body.archivedAt).toBeTruthy();
    expect(res.body.worktree.mergedAt).toBeTruthy();
    expect(res.body.worktree.mergeCommit).toBeTruthy();
    expect(res.body.worktree.removedAt).toBeTruthy();

    expect(gitIn(repo, 'show', 'main:feature.txt')).toBe('shipped');
    expect(existsSync(wt.worktreePath)).toBe(false);
    // branch survives as the audit record
    expect(gitIn(repo, 'show', 'task/t-merge:feature.txt')).toBe('shipped');
  });

  it('blocks accept on conflict and reports it as needs_changes', async () => {
    const repo = makeRepo();
    await postJson('/api/projects', { name: 'demo', repoPath: repo });
    const { wt } = seedWorktreeTask('t-conflict', repo);
    writeFileSync(join(wt.worktreePath, 'README.md'), 'agent version\n');
    // human moves main underneath the task
    writeFileSync(join(repo, 'README.md'), 'human version\n');
    gitIn(repo, 'commit', '-am', 'human edit');

    const res = await postJson('/api/tasks/t-conflict/accept');
    expect(res.status).toBe(200);
    expect(res.body.reviewStatus).toBe('needs_changes');
    expect(res.body.archivedAt).toBeFalsy();
    expect(res.body.worktree.mergeConflicts).toEqual(['README.md']);
    expect(res.body.messages.at(-1).text).toMatch(/conflicts in: README\.md/);

    // main untouched, worktree still there for the agent to fix
    expect(gitIn(repo, 'show', 'main:README.md')).toBe('human version');
    expect(existsSync(wt.worktreePath)).toBe(true);
  });

  it('accepts tasks without a worktree exactly as before', async () => {
    await capture({ title: 'no repo task' });
    const state = await getJson('/api/state');
    const id = state.body.tasks[0].id;
    const res = await postJson(`/api/tasks/${id}/accept`);
    expect(res.status).toBe(200);
    expect(res.body.reviewStatus).toBe('accepted');
    expect(res.body.worktree).toBeUndefined();
  });
});

describe('Phase 13 — diff endpoint', () => {
  it('returns committed files and uncommitted paths', async () => {
    const repo = makeRepo();
    await postJson('/api/projects', { name: 'demo', repoPath: repo });
    const { wt } = seedWorktreeTask('t-diff', repo);
    writeFileSync(join(wt.worktreePath, 'done.txt'), 'a\nb\n');
    gitIn(wt.worktreePath, 'add', '-A');
    gitIn(wt.worktreePath, 'commit', '-m', 'progress');
    writeFileSync(join(wt.worktreePath, 'wip.txt'), 'c\n');

    const res = await getJson('/api/tasks/t-diff/diff');
    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([{ path: 'done.txt', added: 2, deleted: 0 }]);
    expect(res.body.uncommitted).toEqual(['wip.txt']);
  });

  it('returns null for tasks without a worktree and 404 for missing tasks', async () => {
    await capture({ title: 'plain task' });
    const state = await getJson('/api/state');
    const id = state.body.tasks[0].id;
    const res = await fetch(`${baseUrl}/api/tasks/${id}/diff`);
    expect(await res.json()).toBeNull();
    const missing = await fetch(`${baseUrl}/api/tasks/nope/diff`);
    expect(missing.status).toBe(404);
  });
});

// --- Phase 13.1 — per-worktree setup hook (gates the daemon) ---

async function waitForTask(id, predicate, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await getJson(`/api/tasks/${id}`);
    if (body && predicate(body)) return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitForTask(${id}) timed out`);
}

describe('Phase 13.1 — setup hook', () => {
  it('runs setup before the daemon and marks setupStatus done', async () => {
    const repo = makeRepo();
    await postJson('/api/projects', {
      name: 'demo',
      repoPath: repo,
      setupCommand: 'echo hi > SETUP_RAN',
    });
    // harness adapter → quick daemon, no real claude needed.
    const cap = await postJson('/api/capture', {
      title: 'setup task',
      prompt: 'go',
      agentId: 'harness-echo',
      project: 'demo',
    });
    const id = cap.body.id;

    const task = await waitForTask(id, (t) => t.worktree?.setupStatus === 'done');
    const wtPath = join(consoleDir, 'worktrees', id);
    expect(existsSync(join(wtPath, 'SETUP_RAN'))).toBe(true);
    expect(existsSync(`${wtPath}.setup-ok`)).toBe(true);
    expect(task.worktree.path).toBe(wtPath);
  });

  it('blocks the task when setup fails and never starts the daemon', async () => {
    const repo = makeRepo();
    await postJson('/api/projects', {
      name: 'demo',
      repoPath: repo,
      setupCommand: 'exit 7',
    });
    const cap = await postJson('/api/capture', {
      title: 'bad setup',
      prompt: 'go',
      agentId: 'harness-echo',
      project: 'demo',
    });
    const id = cap.body.id;

    const task = await waitForTask(id, (t) => t.worktree?.setupStatus === 'failed');
    expect(task.lifecycleStatus).toBe('blocked');
    expect(task.waitingOnUser).toBe(true);
    expect(task.messages.at(-1).text).toMatch(/setup failed \(exit 7\)/i);
    // no daemon pid file was written (daemon never spawned)
    expect(existsSync(join(consoleDir, 'daemons', `${id}.pid`))).toBe(false);
  });
});

// --- Phase 13.2 — github-pr mode (accept opens a PR) ---

describe('Phase 13.2 — github-pr accept', () => {
  it('blocks the accept when the PR cannot be opened (no origin)', async () => {
    const repo = makeRepo();
    await postJson('/api/projects', {
      name: 'demo',
      repoPath: repo,
      mergeMode: 'github-pr',
    });
    const { wt } = seedWorktreeTask('t-pr', repo);
    // give the branch a commit so push (not "no commits") is what fails
    writeFileSync(join(wt.worktreePath, 'feature.txt'), 'ship\n');

    const res = await postJson('/api/tasks/t-pr/accept');
    expect(res.status).toBe(200);
    expect(res.body.reviewStatus).toBe('needs_changes');
    expect(res.body.archivedAt).toBeFalsy();
    expect(res.body.messages.at(-1).text).toMatch(/couldn't open a pull request/i);
    // worktree still present — work wasn't shipped
    expect(existsSync(wt.worktreePath)).toBe(true);
  });
});

// --- Phase 13.2 — PR loop: poll gh and flip the task to merged ---

import { chmodSync } from 'node:fs';

describe('Phase 13.2 — PR merge detection (poll sweep)', () => {
  it('flips a github-pr task to merged when gh reports MERGED', async () => {
    const repo = makeRepo();

    // Stub gh that reports the PR merged.
    const gh = join(consoleDir, 'gh');
    writeFileSync(
      gh,
      "#!/bin/sh\ncat <<'JSON'\n" +
        JSON.stringify({
          state: 'MERGED',
          mergedAt: '2026-06-12T00:00:00Z',
          mergeCommit: { oid: 'abc123' },
          url: 'https://github.com/x/y/pull/7',
        }) +
        '\nJSON\n'
    );
    chmodSync(gh, 0o755);

    // Restart the server with the stub gh + a fast poll interval.
    await stopServer();
    await startServer({ GH_BIN: gh, PR_POLL_INTERVAL_MS: '200' });

    // Seed an archived github-pr task with an open PR (post-accept shape).
    mkdirSync(join(consoleDir, 'tasks'), { recursive: true });
    const id = 't-prpoll';
    writeFileSync(
      join(consoleDir, 'tasks', `${id}.json`),
      JSON.stringify({
        id,
        title: 'pr task',
        type: 'coding',
        priority: 'normal',
        project: 'demo',
        lifecycleStatus: 'done',
        claimedStatus: 'succeeded',
        validationStatus: 'not_applicable',
        reviewStatus: 'accepted',
        archivedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
        worktree: {
          path: join(consoleDir, 'worktrees', id),
          branch: `task/${id}`,
          repoPath: repo,
          defaultBranch: 'main',
          mergeMode: 'github-pr',
          prUrl: 'https://github.com/x/y/pull/7',
          prNumber: 7,
          prState: 'open',
        },
      })
    );

    const task = await waitForTask(id, (t) => t.worktree?.prState === 'merged');
    expect(task.worktree.prMergeCommit).toBe('abc123');
    expect(task.worktree.prMergedAt).toBe('2026-06-12T00:00:00Z');
    expect(task.messages.at(-1).text).toMatch(/#7 merged/i);
  });
});

// --- Phase 14 — ticket revision endpoint (PM agent) ---

describe('Phase 14 — POST /api/tasks/:id/update', () => {
  it('merges whitelisted fields and validates enums', async () => {
    await capture({ title: 'orig', createdBy: 'pm-cron' });
    const { body: state } = await getJson('/api/state');
    const id = state.tasks[0].id;

    const ok = await postJson(`/api/tasks/${id}/update`, {
      title: 'revised title',
      description: '## Acceptance criteria\n- [ ] a\n- [x] b',
      priority: 'high',
      lifecycleStatus: 'queued',
      reviewStatus: 'pending',
    });
    expect(ok.status).toBe(200);
    expect(ok.body.title).toBe('revised title');
    expect(ok.body.description).toMatch(/Acceptance criteria/);
    expect(ok.body.priority).toBe('high');
    expect(ok.body.lifecycleStatus).toBe('queued');
  });

  it('rejects an invalid enum value', async () => {
    await capture({ title: 'x' });
    const { body: state } = await getJson('/api/state');
    const id = state.tasks[0].id;
    const bad = await postJson(`/api/tasks/${id}/update`, {
      lifecycleStatus: 'flying',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/invalid lifecycleStatus/);
  });

  it('ignores non-whitelisted fields and 404s unknown tasks', async () => {
    await capture({ title: 'y' });
    const { body: state } = await getJson('/api/state');
    const id = state.tasks[0].id;
    const r = await postJson(`/api/tasks/${id}/update`, {
      id: 'hacked',
      runs: [{ id: 'nope' }],
      title: 'kept',
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBe(id); // id not overwritten
    expect(r.body.title).toBe('kept');

    const missing = await postJson('/api/tasks/nope/update', { title: 'z' });
    expect(missing.status).toBe(404);
  });
});
