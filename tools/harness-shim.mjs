#!/usr/bin/env node
// harness-shim.mjs — deterministic "echo runtime" adapter (Phase 10.1).
//
// This is NOT a real LLM. It exists to:
//   1. Force the file-based protocol to be runtime-agnostic before SQLite
//      freezes the schema. Anywhere claude-shim baked in an assumption, the
//      harness breaks.
//   2. Provide a deterministic test fixture for the console — multi-turn
//      conversations, tool-call activity rows, failures, all without an
//      API key.
//
// Modes (selected via --mode):
//   echo    — Replies "echo: <message>" deterministically.
//   tools   — Emits a fake tool_use → tool_result pair before replying.
//   slow    — Emits 3 thinking blocks 200ms apart, then replies.
//   fail    — Exits non-zero with no reply.
//
// CLI / protocol surface mirrors claude-shim.mjs:
//   node tools/harness-shim.mjs --task <id> --mode <mode> --prompt "..."
//   node tools/harness-shim.mjs --task <id> --mode <mode> --daemon

import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { ingestEvent } from './event-store.mjs';

const CONSOLE_DIR = process.env.CONSOLE_DIR || '.agent-console';
const IDLE_TIMEOUT_MS = 30 * 1000; // shorter than claude — harness has nothing to wait on
const POLL_INTERVAL_MS = 500;

main().catch((err) => {
  stderr.write(`harness error: ${err.stack || err.message}\n`);
  exit(2);
});

async function main() {
  const args = parseArgs(argv.slice(2));
  if (!args.task || (!args.prompt && !args.daemon)) {
    stderr.write(
      'Usage: node tools/harness-shim.mjs --task <id> --mode <echo|tools|slow|fail> { --prompt "..." | --daemon }\n'
    );
    exit(1);
  }
  ensureDirs();
  const cwd = args.cwd ? resolve(args.cwd) : process.cwd();
  const mode = args.mode || 'echo';

  if (args.daemon) await runDaemon(args.task, mode, cwd);
  else {
    const result = await runOneTurn(args.task, args.prompt, mode, cwd);
    stdout.write(`harness ${result.runId} ${result.status}\n`);
    exit(result.exitCode);
  }
}

async function runDaemon(taskId, mode, cwd) {
  const messagesQueueFile = join(CONSOLE_DIR, 'messages', `${taskId}.jsonl`);
  const pidFile = join(CONSOLE_DIR, 'daemons', `${taskId}.pid`);

  writeFileSync(pidFile, String(process.pid));
  stdout.write(`harness daemon ${process.pid} (mode=${mode}) for task ${taskId}\n`);

  let stopRequested = false;
  process.on('SIGINT', () => {
    stdout.write('SIGINT — finishing turn (daemon stays alive)\n');
  });
  process.on('SIGTERM', () => {
    stdout.write('SIGTERM — exiting harness daemon\n');
    stopRequested = true;
    cleanupPidFile(pidFile);
    exit(0);
  });

  let idleSince = Date.now();
  while (!stopRequested) {
    const queued = drainQueue(messagesQueueFile);
    if (queued.length === 0) {
      if (Date.now() - idleSince > IDLE_TIMEOUT_MS) {
        stdout.write('idle timeout — exiting\n');
        break;
      }
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    const prompt = queued.map((m) => m.text).join('\n\n---\n\n');
    await runOneTurn(taskId, prompt, mode, cwd);
    idleSince = Date.now();
  }
  cleanupPidFile(pidFile);
  exit(0);
}

async function runOneTurn(taskId, prompt, mode, _cwd) {
  const taskFile = join(CONSOLE_DIR, 'tasks', `${taskId}.json`);
  const eventsFile = join(CONSOLE_DIR, 'events.jsonl');
  const runId = `run-${taskId}-${Date.now()}`;
  const runFile = join(CONSOLE_DIR, 'runs', `${runId}.json`);

  const task = existsSync(taskFile)
    ? JSON.parse(readFileSync(taskFile, 'utf8'))
    : newTask(taskId, prompt, mode);

  task.messages = task.messages || [];
  task.messages.push({ from: 'user', text: prompt, timestamp: timeString() });
  task.lifecycleStatus = 'running';
  task.claimedStatus = 'none';
  task.validationStatus = 'pending';
  task.updatedAt = new Date().toISOString();
  writeJsonAtomic(taskFile, task);

  const run = {
    id: runId,
    taskId,
    agentId: `harness-${mode}`,
    status: 'running',
    startedAt: new Date().toISOString(),
    activity: [],
  };
  writeJsonAtomic(runFile, run);

  // Emit a started event so the protocol's events.jsonl is non-empty even
  // for the harness — useful for tests that assert event flow.
  ingestEvent(
    {
      taskId,
      runId,
      type: 'system',
      source: 'harness-shim',
      sourceEventId: `${runId}:init`,
      raw: { type: 'system', subtype: 'init', mode },
    },
    { eventsFile }
  );

  let activityCounter = 0;
  const nextActivityId = () => `a${activityCounter++}`;

  let outcome;
  try {
    outcome = await executeMode(mode, prompt, {
      taskId,
      runId,
      eventsFile,
      run,
      runFile,
      nextActivityId,
    });
  } catch (err) {
    outcome = {
      status: 'failed',
      reply: `harness error: ${err.message}`,
      exitCode: 2,
    };
  }

  run.endedAt = new Date().toISOString();
  run.status = outcome.status;
  run.cost = 0;
  run.costUsd = 0;
  run.costSource = 'estimated';
  run.tokens = { input: 0, output: 0 };
  run.agentSummary = outcome.reply;
  run.runtime = humanDuration(run.startedAt, run.endedAt);
  run.updatedAt = new Date().toISOString();
  writeJsonAtomic(runFile, run);

  ingestEvent(
    {
      taskId,
      runId,
      type: 'result',
      source: 'harness-shim',
      sourceEventId: `${runId}:result`,
      raw: { type: 'result', status: outcome.status, total_cost_usd: 0 },
    },
    { eventsFile }
  );

  const freshTask = existsSync(taskFile)
    ? JSON.parse(readFileSync(taskFile, 'utf8'))
    : task;
  freshTask.lifecycleStatus = 'done';
  freshTask.claimedStatus = outcome.status === 'succeeded' ? 'succeeded' : 'failed';
  if (outcome.reply) {
    freshTask.messages = freshTask.messages || [];
    freshTask.messages.push({
      from: 'agent',
      text: outcome.reply,
      timestamp: timeString(),
    });
  }
  freshTask.runs = freshTask.runs || [];
  freshTask.runs.push(run);
  freshTask.updatedAt = new Date().toISOString();
  writeJsonAtomic(taskFile, freshTask);

  return { runId, status: run.status, exitCode: outcome.exitCode };
}

async function executeMode(mode, prompt, ctx) {
  switch (mode) {
    case 'echo':
      return { status: 'succeeded', reply: `echo: ${prompt}`, exitCode: 0 };

    case 'tools': {
      const callId = `tool-${Date.now()}`;
      ctx.run.activity.push({
        id: ctx.nextActivityId(),
        timestamp: timeString(),
        type: 'tool_call_started',
        detail: 'Read: example.md',
        toolCallId: callId,
        toolName: 'Read',
      });
      ingestEvent(
        {
          taskId: ctx.taskId,
          runId: ctx.runId,
          type: 'assistant',
          source: 'harness-shim',
          sourceEventId: `${ctx.runId}:tool_use:${callId}`,
          raw: { tool_use: { id: callId, name: 'Read', input: { file_path: 'example.md' } } },
        },
        { eventsFile: ctx.eventsFile }
      );
      writeJsonAtomic(ctx.runFile, ctx.run);

      ctx.run.activity.push({
        id: ctx.nextActivityId(),
        timestamp: timeString(),
        type: 'tool_call_result',
        detail: 'ok (12 lines)',
        toolCallId: callId,
      });
      ingestEvent(
        {
          taskId: ctx.taskId,
          runId: ctx.runId,
          type: 'user',
          source: 'harness-shim',
          sourceEventId: `${ctx.runId}:tool_result:${callId}`,
          raw: { tool_result: { tool_use_id: callId, content: 'ok' } },
        },
        { eventsFile: ctx.eventsFile }
      );
      writeJsonAtomic(ctx.runFile, ctx.run);

      return {
        status: 'succeeded',
        reply: `read example.md, then echo: ${prompt}`,
        exitCode: 0,
      };
    }

    case 'slow': {
      for (let i = 0; i < 3; i++) {
        ctx.run.activity.push({
          id: ctx.nextActivityId(),
          timestamp: timeString(),
          type: 'thinking',
          detail: `step ${i + 1} of 3...`,
        });
        ctx.run.currentActivity = `thinking step ${i + 1} of 3`;
        writeJsonAtomic(ctx.runFile, ctx.run);
        await sleep(200);
      }
      return { status: 'succeeded', reply: `slow echo: ${prompt}`, exitCode: 0 };
    }

    case 'fail':
      return { status: 'failed', reply: '', exitCode: 1 };

    default:
      return {
        status: 'failed',
        reply: `unknown harness mode: ${mode}`,
        exitCode: 2,
      };
  }
}

// --- helpers (mirror claude-shim) -------------------------------------

function ensureDirs() {
  for (const sub of ['tasks', 'runs', 'messages', 'agents', 'daemons', 'logs']) {
    mkdirSync(join(CONSOLE_DIR, sub), { recursive: true });
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') out.task = argv[++i];
    else if (a === '--prompt') out.prompt = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
    else if (a === '--mode') out.mode = argv[++i];
    else if (a === '--daemon') out.daemon = true;
  }
  return out;
}

function newTask(id, prompt, mode) {
  const now = new Date().toISOString();
  const title = (prompt || '').split('\n')[0].slice(0, 80) || `harness ${id}`;
  return {
    id,
    title,
    type: 'analysis',
    priority: 'normal',
    agentId: `harness-${mode}`,
    lifecycleStatus: 'running',
    claimedStatus: 'none',
    validationStatus: 'pending',
    reviewStatus: 'pending',
    createdAt: now,
    updatedAt: now,
    runs: [],
    messages: [],
  };
}

function drainQueue(file) {
  const drainingFile = `${file}.draining-${process.pid}`;
  try {
    renameSync(file, drainingFile);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const raw = readFileSync(drainingFile, 'utf8');
  unlinkSync(drainingFile);
  return raw
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

function cleanupPidFile(pidFile) {
  try {
    unlinkSync(pidFile);
  } catch {
    /* fine */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function timeString() {
  return new Date().toTimeString().slice(0, 8);
}

function humanDuration(startIso, endIso) {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs.toString().padStart(2, '0')}s`;
}
