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

async function startServer() {
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
  if (!server || server.exitCode !== null) return;
  await new Promise((resolve) => {
    server.once('exit', resolve);
    server.kill('SIGTERM');
    // Force-kill if it doesn't shut down in 2s.
    setTimeout(() => {
      if (server.exitCode === null) server.kill('SIGKILL');
    }, 2000);
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
