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
import { ingestEvent, lastSeq, readAllEvents } from './event-store.mjs';
import { reconcile } from './reconciler.mjs';
import { subscribe as subscribeToEventTail } from './event-tailer.mjs';
import {
  loadProjects,
  registerProject,
  ensureWorktree,
  needsSetup,
  startSetup,
  mergeTaskBranch,
  openPullRequest,
  checkPullRequest,
  removeWorktree,
  taskDiff,
} from './worktrees.mjs';

const CONSOLE_DIR = resolve(process.env.CONSOLE_DIR || '.agent-console');
const PORT = parseInt(process.env.CONSOLE_API_PORT || '3001', 10);
const HOST = '127.0.0.1';

// Phase 7.1 — stale-run sweep
const STALE_RUN_THRESHOLD_MS = 2 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;

// Phase 13.2 — poll open PRs (github-pr mode) so a merge/close on GitHub
// flips the task to a terminal state. Overridable for tests.
const PR_POLL_INTERVAL_MS = parseInt(
  process.env.PR_POLL_INTERVAL_MS || '60000',
  10
);

// Phase 12.3 — SSE
const SSE_HEARTBEAT_MS = 15 * 1000;
const SSE_CONNECTION_WARN_THRESHOLD = 32;
let activeSseClients = 0;

const server = createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');

  try {
    const url = req.url || '';
    const method = req.method || 'GET';
    // Path + query split; the second arg is a throwaway base — req.url is
    // always path+query, never absolute.
    const parsedUrl = new URL(url, 'http://x');
    const pathname = parsedUrl.pathname;
    const query = parsedUrl.searchParams;

    if (method === 'GET' && pathname === '/api/state') {
      // Phase 12.1 — `?createdBy=<value>` filters tasks by provenance tag.
      // Agents are always returned in full (they're a global registry).
      const createdBy = query.get('createdBy');
      const snapshot = readSnapshot();
      if (createdBy) {
        snapshot.tasks = snapshot.tasks.filter(
          (t) => (t.createdBy ?? 'ui') === createdBy
        );
      }
      res.end(JSON.stringify(snapshot));
      return;
    }

    // Phase 12.3 — Server-Sent Events stream. One open connection per
    // client; resume via `?since=<seq>` or `Last-Event-ID` header.
    // Optional `?taskId=<id>` narrows to one task's events.
    if (method === 'GET' && pathname === '/api/events') {
      await handleSseEvents(req, res, query);
      return;
    }

    if (method === 'POST' && url === '/api/messages') {
      const body = await readBody(req);
      const { taskId, text, mode, attachments } = JSON.parse(body);
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
          ...(Array.isArray(attachments) && attachments.length > 0
            ? { attachments }
            : {}),
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
      const { title, prompt, agentId, project, priority, attachments, createdBy } =
        JSON.parse(body);
      if (!title) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'title required' }));
        return;
      }
      ensureDirs();
      const taskId = `t${Date.now()}`;
      const now = new Date().toISOString();
      const hasAttachments =
        Array.isArray(attachments) && attachments.length > 0;
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
        // Phase 12.1 — provenance. Default 'ui' so existing UI captures are
        // tagged consistently and Hermes-originated tasks are filterable.
        createdBy: typeof createdBy === 'string' && createdBy ? createdBy : 'ui',
        runs: [],
        messages: [],
      };
      writeJsonAtomic(join(CONSOLE_DIR, 'tasks', `${taskId}.json`), task);
      if (prompt) {
        appendFileSync(
          join(CONSOLE_DIR, 'messages', `${taskId}.jsonl`),
          JSON.stringify({
            text: prompt,
            mode: 'auto',
            timestamp: now,
            ...(hasAttachments ? { attachments } : {}),
          }) + '\n'
        );
        ensureDaemon(taskId);
      }
      res.end(JSON.stringify(task));
      return;
    }

    // Phase 13 — project registry. Maps task.project → a git repo so the
    // daemon can run in a per-task worktree instead of the server's cwd.
    if (pathname === '/api/projects') {
      if (method === 'GET') {
        res.end(JSON.stringify(loadProjects(CONSOLE_DIR)));
        return;
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const { name, repoPath, defaultBranch, setupCommand, mergeMode } =
          JSON.parse(body || '{}');
        try {
          const entry = registerProject(CONSOLE_DIR, {
            name,
            repoPath,
            defaultBranch,
            setupCommand,
            mergeMode,
          });
          res.end(JSON.stringify({ name, ...entry }));
        } catch (err) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
        return;
      }
    }

    // Phase 13 — what did this task change on its branch?
    if (method === 'GET') {
      const diffMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/diff$/);
      if (diffMatch) {
        const task = readTask(diffMatch[1]);
        if (!task) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'task not found' }));
          return;
        }
        try {
          res.end(JSON.stringify(taskDiff({ task })));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
        return;
      }
    }

    // Phase 12.2 — per-entity reads. Lets Hermes (or any client) fetch
    // a single task/run without pulling the full snapshot.
    if (method === 'GET') {
      const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
      if (taskMatch) {
        const [, taskId] = taskMatch;
        const file = join(CONSOLE_DIR, 'tasks', `${taskId}.json`);
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'task not found' }));
          return;
        }
        res.end(readFileSync(file, 'utf8'));
        return;
      }

      const messagesMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/messages$/);
      if (messagesMatch) {
        const [, taskId] = messagesMatch;
        const file = join(CONSOLE_DIR, 'messages', `${taskId}.jsonl`);
        if (!existsSync(file)) {
          // Empty queue is a valid state (e.g. no messages yet, or just
          // drained by the shim) — return [] rather than 404. The task's
          // own existence is the 404-worthy fact, checked separately.
          res.end(JSON.stringify([]));
          return;
        }
        const lines = readFileSync(file, 'utf8').split('\n');
        const out = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            out.push(JSON.parse(line));
          } catch {
            /* skip malformed */
          }
        }
        res.end(JSON.stringify(out));
        return;
      }

      const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
      if (runMatch) {
        const [, runId] = runMatch;
        const file = join(CONSOLE_DIR, 'runs', `${runId}.json`);
        if (!existsSync(file)) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: 'run not found' }));
          return;
        }
        res.end(readFileSync(file, 'utf8'));
        return;
      }
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

      // Phase 14 — generic field revision, so an external manager (e.g. the
      // PM cron agent) can edit a ticket's content/status without a daemon.
      // Only the whitelisted fields are mergeable; enum fields are validated.
      const updateMatch = url.match(/^\/api\/tasks\/([^/]+)\/update$/);
      if (updateMatch) {
        const [, taskId] = updateMatch;
        const body = await readBody(req);
        let payload;
        try {
          payload = body ? JSON.parse(body) : {};
        } catch {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: 'invalid JSON body' }));
          return;
        }
        try {
          const updated = updateTaskFields(taskId, payload);
          if (!updated) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: 'task not found' }));
            return;
          }
          res.end(JSON.stringify(updated));
        } catch (err) {
          res.statusCode = 400;
          res.end(JSON.stringify({ error: String(err.message || err) }));
        }
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
  // Phase 13.2: poll open PRs so a GitHub merge/close ties off the task.
  sweepPullRequests();
  setInterval(sweepPullRequests, PR_POLL_INTERVAL_MS);
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

// Phase 12.3 — SSE handler. Catchup-then-tail with single-source
// dedup via `highestEmittedSeq`.
async function handleSseEvents(req, res, query) {
  const eventsFile = join(CONSOLE_DIR, 'events.jsonl');
  const taskFilter = query.get('taskId');

  // Resume point: Last-Event-ID header wins (browser EventSource sets
  // it automatically on reconnect), falls back to ?since=, defaults 0.
  const lastEventIdHeader = req.headers['last-event-id'];
  const sinceQuery = query.get('since');
  const resume = parseSeq(lastEventIdHeader) ?? parseSeq(sinceQuery) ?? 0;

  // SSE headers — overrides the JSON Content-Type set at the top of the
  // request handler. `X-Accel-Buffering: no` asks any intermediary not
  // to buffer (Vite's dev proxy is already pass-through, but harmless).
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  activeSseClients += 1;
  if (activeSseClients > SSE_CONNECTION_WARN_THRESHOLD) {
    console.warn(
      `sse: ${activeSseClients} concurrent clients (>${SSE_CONNECTION_WARN_THRESHOLD}) — investigate for leaks`
    );
  }

  let highestEmitted = resume;
  let catchupDone = false;
  const tailBuffer = [];

  function matchesFilter(ev) {
    if (taskFilter && ev.taskId !== taskFilter) return false;
    return true;
  }

  function emit(ev) {
    if (!matchesFilter(ev)) return;
    if (typeof ev.seq !== 'number' || ev.seq <= highestEmitted) return;
    highestEmitted = ev.seq;
    const type = typeof ev.type === 'string' ? ev.type : 'event';
    res.write(`event: ${type}\n`);
    res.write(`id: ${ev.seq}\n`);
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  }

  // Subscribe to live tail BEFORE catchup so events arriving during the
  // async catchup read are captured. Apply the same emit() filter so
  // dedup via `highestEmitted` covers any overlap with catchup.
  const unsubscribe = subscribeToEventTail(eventsFile, (ev) => {
    if (catchupDone) emit(ev);
    else tailBuffer.push(ev);
  });

  // Heartbeat keeps the connection alive through idle proxies/load
  // balancers. SSE comments (`:`-prefixed lines) are ignored by clients.
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(':keepalive\n\n');
  }, SSE_HEARTBEAT_MS);

  function cleanup() {
    unsubscribe();
    clearInterval(heartbeat);
    activeSseClients = Math.max(0, activeSseClients - 1);
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  }
  req.on('close', cleanup);
  req.on('error', cleanup);

  // Catchup pass.
  try {
    const all = await readAllEvents(eventsFile);
    for (const ev of all) emit(ev);
  } catch (err) {
    console.error('sse catchup failed:', err.message || err);
  }
  catchupDone = true;

  // Drain any tail events that arrived during catchup. After this point
  // the live subscriber emits directly.
  while (tailBuffer.length > 0) {
    const ev = tailBuffer.shift();
    emit(ev);
  }
}

function parseSeq(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
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
      // Phase 13.2 — github-pr projects: accept pushes the branch and
      // opens a PR instead of merging locally. Review then happens on
      // GitHub; a push/gh failure blocks the accept like a conflict does.
      if (task.worktree?.mergeMode === 'github-pr') {
        let result;
        try {
          result = openPullRequest({ task });
        } catch (err) {
          result = { ok: false, error: String(err.message || err) };
        }
        if (!result.ok) {
          task.reviewStatus = 'needs_changes';
          task.waitingOnUser = true;
          task.messages = task.messages || [];
          task.messages.push({
            from: 'agent',
            text: `Couldn't open a pull request: ${result.error}. Fix it and accept again.`,
            timestamp: now,
          });
          break;
        }
        task.worktree.prUrl = result.prUrl;
        if (result.prNumber) task.worktree.prNumber = result.prNumber;
        task.worktree.prState = 'open';
        task.messages = task.messages || [];
        task.messages.push({
          from: 'agent',
          text: `Opened pull request${result.prNumber ? ` #${result.prNumber}` : ''}: ${result.prUrl}`,
          timestamp: now,
        });
        // Work has moved to GitHub for review — clear it from the tray.
        task.reviewStatus = 'accepted';
        task.waitingOnUser = false;
        task.archivedAt = now;
        break;
      }

      // Phase 13 — local mode: accept = merge. Fold the branch into the
      // default branch first; a conflict blocks the accept instead of
      // marking work "accepted" that never landed.
      if (task.worktree) {
        let result;
        try {
          result = mergeTaskBranch({ consoleDir: CONSOLE_DIR, task });
        } catch (err) {
          result = { ok: false, conflicts: [], error: String(err.message || err) };
        }
        if (!result.ok) {
          task.reviewStatus = 'needs_changes';
          task.waitingOnUser = true;
          task.worktree.mergeConflicts = result.conflicts;
          task.messages = task.messages || [];
          task.messages.push({
            from: 'agent',
            text: result.error
              ? `Merge into ${task.worktree.defaultBranch || 'main'} failed: ${result.error}`
              : `Merge into ${task.worktree.defaultBranch || 'main'} blocked by conflicts in: ${result.conflicts.join(', ')}. Resolve on branch ${task.worktree.branch}, then accept again.`,
            timestamp: now,
          });
          break;
        }
        delete task.worktree.mergeConflicts;
        task.worktree.mergedAt = now;
        if (result.mergeCommit) task.worktree.mergeCommit = result.mergeCommit;
      }
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

  // Archiving (directly or via accept) retires the worktree directory.
  // The branch stays — it's the audit record of what the task did.
  if (task.archivedAt && task.worktree && !task.worktree.removedAt) {
    try {
      if (removeWorktree({ task })) task.worktree.removedAt = now;
    } catch (err) {
      console.error(`worktree cleanup failed for ${taskId}:`, err.message || err);
    }
  }

  task.updatedAt = now;
  writeJsonAtomic(taskFile, task);
  return task;
}

// Phase 14 — whitelist + allowed enum values for /update. Lifecycle and
// the three verdict axes are settable so a PM agent can place a ticket in
// any board column; free-text/priority fields merge as-is.
const UPDATE_ENUMS = {
  lifecycleStatus: ['inbox', 'queued', 'running', 'blocked', 'done', 'cancelled', 'archived'],
  claimedStatus: ['none', 'succeeded', 'failed'],
  validationStatus: ['not_applicable', 'pending', 'verified', 'partially_verified', 'unverified', 'failed', 'judged_ok', 'judged_concerns'],
  reviewStatus: ['not_required', 'pending', 'accepted', 'rejected', 'needs_changes'],
  priority: ['low', 'normal', 'high', 'urgent'],
  type: ['coding', 'research', 'docs', 'testing', 'review', 'ops', 'analysis'],
};
const UPDATE_FREEFORM = ['title', 'description'];

function updateTaskFields(taskId, payload) {
  const taskFile = join(CONSOLE_DIR, 'tasks', `${taskId}.json`);
  if (!existsSync(taskFile)) return null;
  const task = JSON.parse(readFileSync(taskFile, 'utf8'));

  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (UPDATE_ENUMS[key]) {
      if (!UPDATE_ENUMS[key].includes(value)) {
        throw new Error(
          `invalid ${key}: ${value} (allowed: ${UPDATE_ENUMS[key].join(', ')})`
        );
      }
      task[key] = value;
    } else if (UPDATE_FREEFORM.includes(key)) {
      if (typeof value !== 'string') throw new Error(`${key} must be a string`);
      task[key] = value;
    }
    // silently ignore unknown / non-whitelisted keys (id, runs, worktree…)
  }

  task.updatedAt = new Date().toISOString();
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

// Phase 13.2 — poll open PRs for github-pr tasks. When GitHub reports the
// PR merged (or closed without merging), record it and post a message so
// the audit record reflects the real outcome. Terminal states are skipped,
// so this never re-posts or re-checks a settled PR.
function sweepPullRequests() {
  const tasksDir = join(CONSOLE_DIR, 'tasks');
  if (!existsSync(tasksDir)) return;

  for (const file of readdirSync(tasksDir)) {
    if (!file.endsWith('.json')) continue;
    const taskFile = join(tasksDir, file);
    let task;
    try {
      task = JSON.parse(readFileSync(taskFile, 'utf8'));
    } catch {
      continue;
    }
    const wt = task.worktree;
    if (!wt || wt.mergeMode !== 'github-pr' || !wt.prNumber) continue;
    if (wt.prState === 'merged' || wt.prState === 'closed') continue; // terminal

    const status = checkPullRequest({ repoPath: wt.repoPath, prNumber: wt.prNumber });
    if (status.error) continue; // gh unavailable / transient — retry next sweep

    const now = new Date().toISOString();
    if (status.state === 'MERGED') {
      wt.prState = 'merged';
      if (status.mergedAt) wt.prMergedAt = status.mergedAt;
      if (status.mergeCommit) wt.prMergeCommit = status.mergeCommit;
      pushAgentMessage(task, `Pull request #${wt.prNumber} merged.`, now);
      task.updatedAt = now;
      writeJsonAtomic(taskFile, task);
      console.log(`pr-sweep: ${task.id} PR #${wt.prNumber} → merged`);
    } else if (status.state === 'CLOSED') {
      wt.prState = 'closed';
      pushAgentMessage(
        task,
        `Pull request #${wt.prNumber} was closed without merging.`,
        now
      );
      task.updatedAt = now;
      writeJsonAtomic(taskFile, task);
      console.log(`pr-sweep: ${task.id} PR #${wt.prNumber} → closed`);
    } else if (status.state === 'OPEN' && wt.prState !== 'open') {
      // First confirmation the PR is live (or recovered from a stale value).
      wt.prState = 'open';
      task.updatedAt = now;
      writeJsonAtomic(taskFile, task);
    }
  }
}

function pushAgentMessage(task, text, timestamp) {
  task.messages = task.messages || [];
  task.messages.push({ from: 'agent', text, timestamp });
}

function readTask(taskId) {
  const taskFile = join(CONSOLE_DIR, 'tasks', `${taskId}.json`);
  if (!existsSync(taskFile)) return null;
  try {
    return JSON.parse(readFileSync(taskFile, 'utf8'));
  } catch {
    return null;
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

// Phase 13.1 — taskIds whose one-time worktree setup (e.g. npm install) is
// currently running. The daemon spawn is deferred until setup exits 0; a
// message arriving meanwhile must not kick off a second setup or a daemon.
const setupInProgress = new Set();

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

  // Setup already running → it will spawn the daemon when it finishes.
  if (setupInProgress.has(taskId)) return;

  // Phase 13 — tasks with a registered project run in their own git
  // worktree so parallel agents on the same repo can't clobber each
  // other. Unregistered projects keep the old behavior (server cwd).
  const task = readTask(taskId);
  let wt = null;
  if (task?.project) {
    try {
      wt = ensureWorktree({ consoleDir: CONSOLE_DIR, taskId, project: task.project });
      if (wt) recordWorktreeOnTask(taskId, wt);
    } catch (err) {
      // A broken registry entry shouldn't strand the task — run in the
      // server cwd (pre-Phase-13 behavior) and leave a trace in the log.
      console.error(
        `worktree setup failed for ${taskId} (project=${task.project}):`,
        err.message || err
      );
      wt = null;
    }
  }

  // Phase 13.1 — gate on one-time setup (npm install, etc). The HTTP
  // handler returns immediately; the daemon starts once setup succeeds.
  if (wt && needsSetup(wt.worktreePath, wt.setupCommand)) {
    startSetupForTask(taskId, wt);
    return;
  }

  spawnDaemon(taskId, wt);
}

// Persist the worktree handle on the task (idempotent — only writes when
// the path actually changed or the worktree was previously removed).
function recordWorktreeOnTask(taskId, wt) {
  const task = readTask(taskId);
  if (!task) return;
  if (task.worktree?.path === wt.worktreePath && !task.worktree?.removedAt) {
    return;
  }
  task.worktree = {
    path: wt.worktreePath,
    branch: wt.branch,
    repoPath: wt.repoPath,
    defaultBranch: wt.defaultBranch,
    mergeMode: wt.mergeMode || 'local',
  };
  task.updatedAt = new Date().toISOString();
  writeJsonAtomic(join(CONSOLE_DIR, 'tasks', `${taskId}.json`), task);
}

function startSetupForTask(taskId, wt) {
  setupInProgress.add(taskId);
  patchTask(taskId, (t) => {
    if (t.worktree) t.worktree.setupStatus = 'running';
  });
  const logFile = join(CONSOLE_DIR, 'logs', `setup-${taskId}.log`);
  console.log(`setup: ${taskId} running \`${wt.setupCommand}\``);
  startSetup({
    worktreePath: wt.worktreePath,
    setupCommand: wt.setupCommand,
    logFile,
    onExit: (code) => {
      setupInProgress.delete(taskId);
      if (code === 0) {
        patchTask(taskId, (t) => {
          if (t.worktree) t.worktree.setupStatus = 'done';
        });
        console.log(`setup: ${taskId} ok`);
        spawnDaemon(taskId, wt);
      } else {
        // Block on a failed environment rather than launch an agent into a
        // half-built worktree. Sending another message retries (the marker
        // wasn't written, so needsSetup is still true).
        patchTask(taskId, (t) => {
          t.lifecycleStatus = 'blocked';
          t.waitingOnUser = true;
          if (t.worktree) t.worktree.setupStatus = 'failed';
          t.messages = t.messages || [];
          t.messages.push({
            from: 'agent',
            text: `Worktree setup failed (exit ${code}) running \`${wt.setupCommand}\`. See logs/setup-${taskId}.log. Send a message to retry.`,
            timestamp: new Date().toISOString(),
          });
        });
        console.error(`setup: ${taskId} failed (exit ${code})`);
      }
    },
  });
}

function spawnDaemon(taskId, wt) {
  // Phase 10.1 — pick the adapter based on the task's agentId. Default
  // (claude-code or unset) → claude-shim. Any agentId starting with
  // `harness-<mode>` spawns the test harness in that mode.
  const adapter = adapterFor(taskId);
  const argv = adapter.argv(taskId);
  if (wt) argv.push('--cwd', wt.worktreePath);

  const logFile = join(CONSOLE_DIR, 'logs', `daemon-${taskId}.log`);
  const out = openSync(logFile, 'a');
  const child = spawn('node', argv, {
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

// Read-modify-write a task.json under a mutator. Centralizes the
// existsSync/parse/write dance the setup callbacks need.
function patchTask(taskId, mutate) {
  const taskFile = join(CONSOLE_DIR, 'tasks', `${taskId}.json`);
  if (!existsSync(taskFile)) return;
  try {
    const task = JSON.parse(readFileSync(taskFile, 'utf8'));
    mutate(task);
    task.updatedAt = new Date().toISOString();
    writeJsonAtomic(taskFile, task);
  } catch {
    /* ignore — next write reconciles */
  }
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
