// FSEvents reconciliation pass (Phase 10.4).
//
// On startup, console-server walks the tasks/ and runs/ directories and
// compares each file's `updatedAt` to the latest event timestamp that
// referenced it in events.jsonl. If a task or run was modified after its
// last event, emit a `reconciled` event so the audit log is complete
// even when a writer (or fs.watch on macOS) dropped events.
//
// Idempotency on (source='reconciler', sourceEventId='reconciled:<id>:<updatedAt>')
// ensures repeated startups don't duplicate state.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ingestEvent, readAllEvents } from './event-store.mjs';

export async function reconcile({ consoleDir } = {}) {
  const dir = consoleDir ? resolve(consoleDir) : resolve('.agent-console');
  const eventsFile = join(dir, 'events.jsonl');
  const tasksDir = join(dir, 'tasks');
  const runsDir = join(dir, 'runs');

  // Build lookup: taskId → latest event ts referencing it.
  const latestEventByTask = new Map();
  const latestEventByRun = new Map();

  const events = await readAllEvents(eventsFile);
  for (const ev of events) {
    if (ev.taskId) {
      const ts = parseTs(ev.timestamp);
      if (ts > (latestEventByTask.get(ev.taskId) || 0)) {
        latestEventByTask.set(ev.taskId, ts);
      }
    }
    if (ev.runId) {
      const ts = parseTs(ev.timestamp);
      if (ts > (latestEventByRun.get(ev.runId) || 0)) {
        latestEventByRun.set(ev.runId, ts);
      }
    }
  }

  let reconciledCount = 0;
  let skippedCount = 0;

  if (existsSync(tasksDir)) {
    for (const file of readdirSync(tasksDir)) {
      if (!file.endsWith('.json')) continue;
      const path = join(tasksDir, file);
      let task;
      try {
        task = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        continue;
      }
      const updatedAt = parseTs(task.updatedAt);
      if (!updatedAt) continue;
      const lastEvent = latestEventByTask.get(task.id) || 0;
      if (updatedAt <= lastEvent) {
        skippedCount++;
        continue;
      }
      const stored = ingestEvent(
        {
          taskId: task.id,
          type: 'reconciled',
          source: 'reconciler',
          sourceEventId: `task:${task.id}:${task.updatedAt}`,
          entity: 'task',
          snapshot: pickTaskSnapshot(task),
        },
        { eventsFile }
      );
      if (!stored.duplicate) reconciledCount++;
    }
  }

  if (existsSync(runsDir)) {
    for (const file of readdirSync(runsDir)) {
      if (!file.endsWith('.json')) continue;
      const path = join(runsDir, file);
      let run;
      try {
        run = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        continue;
      }
      const updatedAt = parseTs(run.updatedAt || run.endedAt || run.startedAt);
      if (!updatedAt) continue;
      const lastEvent = latestEventByRun.get(run.id) || 0;
      if (updatedAt <= lastEvent) {
        skippedCount++;
        continue;
      }
      const stored = ingestEvent(
        {
          taskId: run.taskId,
          runId: run.id,
          type: 'reconciled',
          source: 'reconciler',
          sourceEventId: `run:${run.id}:${run.updatedAt || run.endedAt || run.startedAt}`,
          entity: 'run',
          snapshot: pickRunSnapshot(run),
        },
        { eventsFile }
      );
      if (!stored.duplicate) reconciledCount++;
    }
  }

  return { reconciledCount, skippedCount };
}

function parseTs(s) {
  if (!s) return 0;
  const t = new Date(s).getTime();
  return Number.isNaN(t) ? 0 : t;
}

// Snapshots are kept small — the full task/run JSONs already live on disk;
// the event just needs enough to reconstruct the state at audit time.
function pickTaskSnapshot(t) {
  return {
    id: t.id,
    title: t.title,
    lifecycleStatus: t.lifecycleStatus,
    claimedStatus: t.claimedStatus,
    validationStatus: t.validationStatus,
    reviewStatus: t.reviewStatus,
    updatedAt: t.updatedAt,
  };
}

function pickRunSnapshot(r) {
  return {
    id: r.id,
    taskId: r.taskId,
    status: r.status,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
    updatedAt: r.updatedAt,
    cost: r.cost,
    costUsd: r.costUsd,
  };
}
