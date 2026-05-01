#!/usr/bin/env node
// claude-shim.mjs — runs Claude Code with stream-json output and writes
// the resulting events into `.agent-console/` per the file-based protocol
// documented in tools/protocol.md.
//
// Modes:
//
//   One-shot (CLI / scripted use):
//     node tools/claude-shim.mjs --task <id> --prompt "..." [--cwd <dir>]
//
//   Daemon (UI-spawned, long-lived per task):
//     node tools/claude-shim.mjs --task <id> --daemon [--cwd <dir>]
//
// Daemon mode loops: drain messages/<id>.jsonl → call claude with
// --resume <session_id> → write events → wait for the next message. Idle
// timeout (5 min) → exit. SIGINT → finish current turn, exit.
// SIGTERM → exit immediately.

import { spawn } from 'node:child_process';
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

// CONSOLE_DIR honors the env var so console-server can run with a
// custom data directory (smoke tests, multi-instance dev) and have
// daemons it spawns inherit the same path.
const CONSOLE_DIR = process.env.CONSOLE_DIR || '.agent-console';
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;

// Set by runOneTurn so the daemon's signal handlers can forward.
let currentClaude = null;

main().catch((err) => {
  stderr.write(`shim error: ${err.stack || err.message}\n`);
  exit(2);
});

async function main() {
  const args = parseArgs(argv.slice(2));
  if (!args.task || (!args.prompt && !args.daemon)) {
    stderr.write(
      'Usage:\n' +
        '  Once:   node tools/claude-shim.mjs --task <id> --prompt "..." [--cwd <dir>]\n' +
        '  Daemon: node tools/claude-shim.mjs --task <id> --daemon         [--cwd <dir>]\n'
    );
    exit(1);
  }

  ensureDirs();

  const cwd = args.cwd ? resolve(args.cwd) : process.cwd();

  if (args.daemon) {
    await runDaemon(args.task, cwd);
  } else {
    await runOneShot(args.task, args.prompt, cwd);
  }
}

// One-shot: run a single turn with the given prompt (plus any queued
// messages), then exit.
async function runOneShot(taskId, prompt, cwd) {
  const result = await runOneTurn(taskId, prompt, cwd);
  stdout.write(
    `run ${result.runId} ${result.status} · cost $${result.cost.toFixed(4)} · runtime ${result.runtime}\n`
  );
  exit(result.exitCode);
}

// Daemon: loop draining the queue, running one turn per drain, until idle
// timeout or signal.
async function runDaemon(taskId, cwd) {
  const taskFile = join(CONSOLE_DIR, 'tasks', `${taskId}.json`);
  const messagesQueueFile = join(CONSOLE_DIR, 'messages', `${taskId}.jsonl`);
  const pidFile = join(CONSOLE_DIR, 'daemons', `${taskId}.pid`);

  // Self-register so the API can find this daemon
  writeFileSync(pidFile, String(process.pid));
  stdout.write(`daemon ${process.pid} started for task ${taskId}\n`);

  let stopRequested = false;
  // SIGINT = "stop after current tool" — kill the in-flight claude
  // subprocess; daemon stays alive to wait for the next user message.
  process.on('SIGINT', () => {
    stdout.write('SIGINT — interrupting current turn (daemon stays alive)\n');
    if (currentClaude) currentClaude.kill('SIGINT');
  });
  // SIGTERM = "cancel" — kill claude AND exit the daemon. Artifacts
  // (events.jsonl, runs/, tasks/) are preserved.
  process.on('SIGTERM', () => {
    stdout.write('SIGTERM — killing current turn and exiting daemon\n');
    stopRequested = true;
    if (currentClaude) currentClaude.kill('SIGTERM');
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
    const queuedAttachments = queued.flatMap((m) => m.attachments || []);
    const result = await runOneTurn(taskId, prompt, cwd, queuedAttachments);
    stdout.write(
      `turn ${result.runId} ${result.status} · cost $${result.cost.toFixed(4)} · ${result.runtime}\n`
    );
    idleSince = Date.now();

    // Reload task (its sessionId may have just been captured for next turn)
    if (!existsSync(taskFile)) break;
  }

  cleanupPidFile(pidFile);
  exit(0);
}

// Run a single Claude turn for a task. Reads the task to find the last
// session_id (for --resume), spawns claude, parses stream-json events,
// writes updates atomically, returns when claude exits.
async function runOneTurn(taskId, initialPrompt, cwd, initialAttachments = []) {
  const taskFile = join(CONSOLE_DIR, 'tasks', `${taskId}.json`);
  const messagesQueueFile = join(CONSOLE_DIR, 'messages', `${taskId}.jsonl`);
  const eventsFile = join(CONSOLE_DIR, 'events.jsonl');
  const runId = `run-${taskId}-${Date.now()}`;
  const runFile = join(CONSOLE_DIR, 'runs', `${runId}.json`);

  // Read or create the task
  const task = existsSync(taskFile)
    ? JSON.parse(readFileSync(taskFile, 'utf8'))
    : newTask(taskId, initialPrompt);

  // In one-shot mode, also drain any queued messages and prepend with prompt
  // (for daemon mode the prompt is already the drained queue text)
  const additionalQueued = drainQueue(messagesQueueFile);
  const fullPrompt =
    additionalQueued.length === 0
      ? initialPrompt
      : [initialPrompt, ...additionalQueued.map((m) => m.text)].join('\n\n---\n\n');
  const attachments = [
    ...initialAttachments,
    ...additionalQueued.flatMap((m) => m.attachments || []),
  ];

  // Find a previous sessionId to resume from
  const lastRun =
    task.runs && task.runs.length > 0 ? task.runs[task.runs.length - 1] : null;
  const resumeSessionId = lastRun?.sessionId || null;

  // Append user turn to transcript. Attachments ride along on the message
  // record so the UI can render them; the prototype does NOT pass them to
  // claude (no agent wiring yet — see PRD).
  task.messages = task.messages || [];
  task.messages.push({
    from: 'user',
    text: fullPrompt,
    timestamp: timeString(),
    ...(attachments.length > 0 ? { attachments } : {}),
  });
  task.lifecycleStatus = 'running';
  task.claimedStatus = 'none';
  task.validationStatus = 'pending';
  task.updatedAt = new Date().toISOString();
  writeJsonAtomic(taskFile, task);

  const run = {
    id: runId,
    taskId,
    agentId: 'claude-code',
    status: 'running',
    startedAt: new Date().toISOString(),
    activity: [],
    ...(resumeSessionId ? { resumedFromSessionId: resumeSessionId } : {}),
  };
  writeJsonAtomic(runFile, run);

  const claudeArgs = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    ...(resumeSessionId ? ['--resume', resumeSessionId] : []),
    fullPrompt,
  ];

  return new Promise((resolveTurn) => {
    const claude = spawn('claude', claudeArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    currentClaude = claude;

    let agentText = '';
    let totalCostUsd = 0;
    let toolCount = 0;
    let activityCounter = 0;
    let eventCounter = 0;
    let buffer = '';
    // Phase 9.4 — token + cost telemetry, captured on stream-json `result`
    // events. Anthropic's prompt caching breaks single-`tokens` accounting,
    // so we keep the input/output/cached split separate.
    let tokenUsage = null;
    const nextActivityId = () => `a${activityCounter++}`;

    claude.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          stderr.write(`shim: skipping non-JSON line: ${line.slice(0, 80)}\n`);
          continue;
        }

        // Route through the event store so seq + (source, sourceEventId)
        // idempotency apply (Phase 10.2 / 10.3). Claude's stream-json gives
        // us a stable `message.id` on most events; fall back to a per-run
        // counter for the rest.
        ingestEvent(
          {
            taskId,
            runId,
            type: event.type ?? 'unknown',
            source: 'claude-shim',
            sourceEventId: `${runId}:${event.message?.id || `evt-${eventCounter}`}`,
            raw: event,
          },
          { eventsFile }
        );
        eventCounter++;

        if (event.type === 'system' && event.subtype === 'init') {
          if (event.session_id) run.sessionId = event.session_id;
          // `apiKeySource: 'none'` means a Pro/Max subscription is paying;
          // 'user' / 'project' / 'org' mean a real API key. The UI uses
          // this to mark cost as notional vs actually billed.
          if (event.apiKeySource) run.apiKeySource = event.apiKeySource;
        }

        if (event.type === 'assistant' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'text' && typeof block.text === 'string') {
              agentText += block.text;
            } else if (block.type === 'thinking') {
              run.activity.push({
                id: nextActivityId(),
                timestamp: timeString(),
                type: 'thinking',
                detail: (block.thinking || block.text || '').slice(0, 80),
              });
            } else if (block.type === 'tool_use') {
              toolCount++;
              const verb = toolVerb(block.name);
              const target = toolTarget(block);
              run.lastToolName = block.name;
              run.toolCount = toolCount;
              run.currentActivity = `${verb}${target ? ' ' + target : ''} (${toolCount} ${toolCount === 1 ? 'tool' : 'tools'})`;
              run.agentSummary = run.currentActivity;
              const isSubagent = block.name === 'Task' || block.name === 'Agent';
              run.activity.push({
                id: nextActivityId(),
                timestamp: timeString(),
                type: isSubagent ? 'subagent_spawned' : 'tool_call_started',
                detail: `${block.name}${target ? ': ' + target : ''}`,
                toolCallId: block.id,
                toolName: block.name,
              });
            }
          }
        }

        // tool_result blocks come back inside subsequent user messages
        if (event.type === 'user' && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === 'tool_result') {
              const isError = !!block.is_error;
              let preview = '';
              if (typeof block.content === 'string') {
                preview = block.content.slice(0, 80);
              } else if (Array.isArray(block.content)) {
                preview = block.content
                  .map((c) => (typeof c === 'string' ? c : c?.text || ''))
                  .join(' ')
                  .slice(0, 80);
              }
              run.activity.push({
                id: nextActivityId(),
                timestamp: timeString(),
                type: isError ? 'tool_call_error' : 'tool_call_result',
                detail: preview || (isError ? 'error' : 'ok'),
                toolCallId: block.tool_use_id,
              });
            }
          }
        }

        if (event.type === 'result') {
          if (typeof event.total_cost_usd === 'number') {
            totalCostUsd = event.total_cost_usd;
          }
          // Phase 9.4: claude's stream-json result has a `usage` block with
          // input_tokens / output_tokens / cache_creation_input_tokens /
          // cache_read_input_tokens. Capture all of them so the UI can
          // mark cost as approximate when caching distorts the picture.
          if (event.usage) {
            tokenUsage = {
              input: event.usage.input_tokens ?? null,
              output: event.usage.output_tokens ?? null,
              cacheCreate: event.usage.cache_creation_input_tokens ?? null,
              cacheRead: event.usage.cache_read_input_tokens ?? null,
            };
          }
        }

        run.updatedAt = new Date().toISOString();
        writeJsonAtomic(runFile, run);
      }
    });

    claude.stderr.on('data', (chunk) => {
      stderr.write(`claude stderr: ${chunk.toString()}`);
    });

    claude.on('close', (code) => {
      currentClaude = null;
      run.endedAt = new Date().toISOString();
      run.status = code === 0 ? 'succeeded' : 'failed';
      run.cost = totalCostUsd;
      run.costUsd = totalCostUsd;
      run.costSource = 'billed';
      if (tokenUsage) run.tokens = tokenUsage;
      run.agentSummary = agentText || run.currentActivity || '';
      run.runtime = humanDuration(run.startedAt, run.endedAt);
      run.updatedAt = new Date().toISOString();
      writeJsonAtomic(runFile, run);

      // Reload task (in case the API or another process touched it),
      // then persist this turn's outcome.
      const freshTask = existsSync(taskFile)
        ? JSON.parse(readFileSync(taskFile, 'utf8'))
        : task;
      freshTask.lifecycleStatus = 'done';
      freshTask.claimedStatus = code === 0 ? 'succeeded' : 'failed';
      if (agentText) {
        freshTask.messages = freshTask.messages || [];
        freshTask.messages.push({
          from: 'agent',
          text: agentText,
          timestamp: timeString(),
        });
      }
      freshTask.runs = freshTask.runs || [];
      freshTask.runs.push(run);
      freshTask.updatedAt = new Date().toISOString();
      writeJsonAtomic(taskFile, freshTask);

      resolveTurn({
        runId,
        status: run.status,
        cost: totalCostUsd,
        runtime: run.runtime,
        exitCode: code ?? 0,
      });
    });
  });
}

// --- helpers ---

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
    else if (a === '--daemon') out.daemon = true;
  }
  return out;
}

function newTask(id, prompt) {
  const now = new Date().toISOString();
  const title = (prompt || '').split('\n')[0].slice(0, 80) || `task ${id}`;
  return {
    id,
    title,
    type: 'coding',
    priority: 'normal',
    agentId: 'claude-code',
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
    /* fine if already gone */
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toolVerb(name) {
  if (['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch'].includes(name))
    return 'Reading';
  if (['Edit', 'Write', 'NotebookEdit'].includes(name)) return 'Writing';
  if (name === 'Bash') return 'Running';
  if (name === 'Task' || name === 'Agent') return 'Spawning subagent';
  return name;
}

function toolTarget(block) {
  const input = block.input || {};
  if (input.file_path) return input.file_path.replace(/^.*\//, '');
  if (input.path) return input.path.replace(/^.*\//, '');
  if (input.pattern) return input.pattern;
  if (input.command) return input.command.slice(0, 60);
  return '';
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
  if (m < 60) return `${m}m ${rs.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return `${h}h ${rm.toString().padStart(2, '0')}m`;
}
