#!/usr/bin/env node
// console-server.mjs — standalone HTTP API server for the agent console.
//
// Listens on 127.0.0.1:CONSOLE_API_PORT (default 3001) and serves the same
// endpoints the Vite plugin used to host. Vite's dev server (port 3000)
// proxies /api/* here. Splitting the API out of Vite means the API can
// outlive UI restarts (and eventually move into a Tauri sidecar without
// changing endpoint shapes).
//
//   GET  /api/state                       snapshot of tasks/runs/agents
//   POST /api/messages                    queue a message for the daemon
//   POST /api/capture                     create a task and spawn its daemon
//   POST /api/tasks/<taskId>/stop         SIGINT → finish in-flight tool
//   POST /api/tasks/<taskId>/cancel       SIGTERM → kill claude + daemon

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import {
  readFileSync,
  readdirSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  openSync,
  statSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { runValidation } from './validator.mjs';
import { ingestEvent, lastSeq } from './event-store.mjs';
import { reconcile } from './reconciler.mjs';

const CONSOLE_DIR = resolve(process.env.CONSOLE_DIR || '.agent-console');
const PORT = parseInt(process.env.CONSOLE_API_PORT || '3001', 10);
const HOST = '127.0.0.1';

// Phase 7.1 — stale-run sweep
const STALE_RUN_THRESHOLD_MS = 2 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  try {
    const url = req.url || '';
    const method = req.method || 'GET';

    if (method === 'GET' && url === '/api/state') {
      res.end(JSON.stringify(readSnapshot()));
      return;
    }

    if (method === 'POST' && url === '/api/messages') {
      const body = await readBody(req);
      const { taskId, text, mode } = JSON.parse(body);
      if (!taskId || typeof text !== 'string') {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'taskId and text required' }));
        return;
      }
      ensureDirs();
      const file = join(CONSOLE_DIR, 'messages', `${taskId}.jsonl`);
      appendFileSync(
        file,
        JSON.stringify({
          text,
          mode: mode ?? 'auto',
          timestamp: new Date().toISOString(),
        }) + '\n'
      );
      // Re-engaging un-archives: if the user sends a message, the task
      // belongs back in the active tray.
      const taskFile = join(CONSOLE_DIR, 'tasks', `${taskId}.json`);
      if (existsSync(taskFile)) {
        try {
          const t = JSON.parse(readFileSync(taskFile, 'utf8'));
          if (t.archivedAt) {
            delete t.archivedAt;
            t.updatedAt = new Date().toISOString();
            writeJsonAtomic(taskFile, t);
          }
        } catch {
          /* ignore — shim will rewrite on next event */
        }
      }
      ensureDaemon(taskId);
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // Phase 9.2 — run a list of contracts against a (task, run) pair and
    // write `validation_result` events. Idempotent on
    // (runId, contractId, contentHash).
    if (method === 'POST' && url === '/api/validate') {
      const body = await readBody(req);
      const { taskId, runId, contracts, cwd } = JSON.parse(body || '{}');
      if (!taskId || !runId || !Array.isArray(contracts)) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({ error: 'taskId, runId, contracts[] required' })
        );
        return;
      }
      try {
        const summary = await runValidation({
          taskId,
          runId,
          contracts,
          cwd,
          consoleDir: CONSOLE_DIR,
        });
        res.end(JSON.stringify(summary));
      } catch (err) {
        res.statusCode = err.message?.includes('not found') ? 404 : 500;
        res.end(JSON.stringify({ error: String(err.message || err) }));
      }
      return;
    }

    if (method === 'POST' && url === '/api/capture') {
      const body = await readBody(req);
      const { title, prompt, agentId, project, priority } = JSON.parse(body);
      if (!title) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'title required' }));
        return;
      }
      ensureDirs();
      const taskId = `t${Date.now()}`;
      const now = new Date().toISOString();
      const task = {
        id: taskId,
        title,
        type: 'coding',
        priority: priority || 'normal',
        project: project || undefined,
        agentId: agentId || 'claude-code',
        lifecycleStatus: prompt ? 'running' : 'inbox',
        claimedStatus: 'none',
        validationStatus: 'not_applicable',
        // Every captured task needs explicit acceptance — Accept moves it
        // to Archived; sending more messages keeps the conversation open.
        reviewStatus: 'pending',
        createdAt: now,
        updatedAt: now,
        runs: [],
        messages: [],
      };
      writeJsonAtomic(join(CONSOLE_DIR, 'tasks', `${taskId}.json`), task);
      if (prompt) {
        appendFileSync(
          join(CONSOLE_DIR, 'messages', `${taskId}.jsonl`),
          JSON.stringify({ text: prompt, mode: 'auto', timestamp: now }) + '\n'
        );
        ensureDaemon(taskId);
      }
      res.end(JSON.stringify(task));
      return;
    }

    // POST /api/tasks/<taskId>/{stop,cancel}
    if (method === 'POST') {
      const sigMatch = url.match(/^\/api\/tasks\/([^/]+)\/(stop|cancel)$/);
      if (sigMatch) {
        const [, taskId, action] = sigMatch;
        const pidFile = join(CONSOLE_DIR, 'daemons', `${taskId}.pid`);
        if (!existsSync(pidFile)) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'no daemon running for this task' }));
          return;
        }
        const pid = parseInt(readFileSync(pidFile, 'utf8'), 10);
        const signal = action === 'stop' ? 'SIGINT' : 'SIGTERM';
        process.kill(pid, signal);
        res.end(JSON.stringify({ ok: true, action, pid, signal }));
        return;
      }

      // POST /api/tasks/<taskId>/{assign,accept,reject,archive}
      const stateMatch = url.match(
        /^\/api\/tasks\/([^/]+)\/(assign|accept|reject|archive)$/
      );
      if (stateMatch) {
        const [, taskId, action] = stateMatch;
        const body = await readBody(req);
        const payload = body ? JSON.parse(body) : {};
        const updated = mutateTaskState(taskId, action, payload);
        if (!updated) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'task not found' }));
          return;
        }
        res.end(JSON.stringify(updated));
        return;
      }
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(err.message || err) }));
  }
});

server.listen(PORT, HOST, async () => {
  console.log(`console-server listening on http://${HOST}:${PORT}`);
  console.log(`  CONSOLE_DIR = ${CONSOLE_DIR}`);
  // Phase 10.4 — reconciliation pass. Catches tasks/runs whose JSON was
  // updated while the server (and thus events.jsonl) was offline. Idempotent
  // on (source='reconciler', sourceEventId), so safe on every boot.
  try {
    const summary = await reconcile({ consoleDir: CONSOLE_DIR });
    console.log(
      `reconcile: ${summary.reconciledCount} new events, ${summary.skippedCount} up-to-date · seq=${lastSeq()}`
    );
  } catch (err) {
    console.error('reconcile failed:', err.message || err);
  }
  // Phase 7.1: sweep stale runs on boot, then every 30s. Catches runs
  // whose daemon Ctrl-C'd or crashed mid-stream and never wrote a
  // terminal status.
  sweepStaleRuns();
  setInterval(sweepStaleRuns, SWEEP_INTERVAL_MS);
});

// --- helpers ---

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolveBody(body));
    req.on('error', reject);
  });
}

function readSnapshot() {
  const tasks = readJsonDir(join(CONSOLE_DIR, 'tasks'));
  const agents = readJsonDir(join(CONSOLE_DIR, 'agents'));
  return {
    tasks,
    agents:
      agents.length > 0
        ? agents
        : [
            {
              id: 'claude-code',
              name: 'claude-code',
              model: 'Opus 4.7',
              role: 'Coding agent',
              status: 'available',
              activeTasks: 0,
            },
          ],
  };
}

function readJsonDir(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function ensureDirs() {
  for (const sub of ['tasks', 'runs', 'messages', 'agents', 'daemons', 'logs']) {
    mkdirSync(join(CONSOLE_DIR, sub), { recursive: true });
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

// Phase 7.5 — UI-driven state transitions on the task. The daemon doesn't
// write to task.json between turns (it's idle on the queue), and these
// actions only apply to non-running tasks (assign: inbox; accept/reject:
// review/done bucket), so the rare "user clicks while daemon is
// mid-turn" race is closed by UI gating, not by the server.
function mutateTaskState(taskId, action, payload) {
  const taskFile = join(CONSOLE_DIR, 'tasks', `${taskId}.json`);
  if (!existsSync(taskFile)) return null;
  const task = JSON.parse(readFileSync(taskFile, 'utf8'));
  const now = new Date().toISOString();

  switch (action) {
    case 'assign': {
      if (!payload.agentId) {
        throw new Error('assign requires agentId');
      }
      task.agentId = payload.agentId;
      task.lifecycleStatus = 'queued';
      task.reviewStatus = 'pending';
      break;
    }
    case 'accept': {
      // Accept = "this is good, get it out of my way." One click, both
      // signals: review verdict + dismissed from the live tray.
      task.reviewStatus = 'accepted';
      task.waitingOnUser = false;
      task.archivedAt = now;
      break;
    }
    case 'reject': {
      task.lifecycleStatus = 'queued';
      task.claimedStatus = 'none';
      task.validationStatus = 'not_applicable';
      task.reviewStatus = 'needs_changes';
      task.waitingOnUser = false;
      break;
    }
    case 'archive': {
      task.archivedAt = now;
      break;
    }
  }

  task.updatedAt = now;
  writeJsonAtomic(taskFile, task);
  return task;
}

function sweepStaleRuns() {
  const runsDir = join(CONSOLE_DIR, 'runs');
  if (!existsSync(runsDir)) return;
  const now = Date.now();

  for (const file of readdirSync(runsDir)) {
    if (!file.endsWith('.json')) continue;
    const path = join(runsDir, file);
    let run;
    try {
      run = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      continue;
    }

    if (run.status !== 'running') continue;

    const lastUpdate = new Date(run.updatedAt || run.startedAt).getTime();
    if (now - lastUpdate < STALE_RUN_THRESHOLD_MS) continue;

    // Skip if the task's daemon is still alive — it just hasn't written
    // an event in 2 minutes (claude can sit thinking that long).
    if (isDaemonAlive(run.taskId)) continue;

    run.status = 'unknown';
    run.endedAt = new Date(now).toISOString();
    run.terminationReason = 'no_heartbeat';
    writeJsonAtomic(path, run);

    const taskFile = join(CONSOLE_DIR, 'tasks', `${run.taskId}.json`);
    if (existsSync(taskFile)) {
      try {
        const task = JSON.parse(readFileSync(taskFile, 'utf8'));
        task.lifecycleStatus = 'done';
        task.claimedStatus = 'failed';
        task.updatedAt = new Date(now).toISOString();
        if (Array.isArray(task.runs)) {
          task.runs = task.runs.map((r) => (r.id === run.id ? run : r));
        }
        writeJsonAtomic(taskFile, task);
      } catch {
        /* ignore */
      }
    }

    console.log(
      `sweep: ${run.id} → unknown (last update ${Math.round((now - lastUpdate) / 1000)}s ago)`
    );
  }
}

function isDaemonAlive(taskId) {
  const pidFile = join(CONSOLE_DIR, 'daemons', `${taskId}.pid`);
  if (!existsSync(pidFile)) return false;
  try {
    const pid = parseInt(readFileSync(pidFile, 'utf8'), 10);
    if (pid > 0) {
      process.kill(pid, 0); // throws if dead
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

function ensureDaemon(taskId) {
  const pidFile = join(CONSOLE_DIR, 'daemons', `${taskId}.pid`);
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf8'), 10);
      if (pid > 0) {
        process.kill(pid, 0); // throws if dead
        return;
      }
    } catch {
      // stale — fall through
    }
  }

  // Phase 10.1 — pick the adapter based on the task's agentId. Default
  // (claude-code or unset) → claude-shim. Any agentId starting with
  // `harness-<mode>` spawns the test harness in that mode.
  const adapter = adapterFor(taskId);
  const logFile = join(CONSOLE_DIR, 'logs', `daemon-${taskId}.log`);
  const out = openSync(logFile, 'a');
  const child = spawn('node', adapter.argv(taskId), {
    detached: true,
    stdio: ['ignore', out, out],
    // Pass CONSOLE_DIR through so the daemon writes to the same data
    // directory the server is reading from. Without this, custom
    // CONSOLE_DIR values (smoke tests) silently split state across two
    // directories.
    env: { ...process.env, CONSOLE_DIR },
  });
  child.unref();
}

function adapterFor(taskId) {
  const taskFile = join(CONSOLE_DIR, 'tasks', `${taskId}.json`);
  let agentId = 'claude-code';
  if (existsSync(taskFile)) {
    try {
      const t = JSON.parse(readFileSync(taskFile, 'utf8'));
      if (t.agentId) agentId = t.agentId;
    } catch {
      /* fall back to default */
    }
  }
  if (agentId.startsWith('harness-')) {
    const mode = agentId.slice('harness-'.length) || 'echo';
    return {
      kind: 'harness',
      argv: (id) => [
        'tools/harness-shim.mjs',
        '--task', id,
        '--mode', mode,
        '--daemon',
      ],
    };
  }
  return {
    kind: 'claude-code',
    argv: (id) => ['tools/claude-shim.mjs', '--task', id, '--daemon'],
  };
}
