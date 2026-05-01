// Validator runner (Phase 9.2).
//
// Takes a list of contract specs, a task/run context, runs the deterministic
// checkers from contracts.mjs, and:
//
//   1. Writes one `validation_result` event per result to events.jsonl,
//      idempotent on (runId, contractId, contentHash) — re-running the same
//      contract on the same artifact does NOT duplicate events.
//
//   2. Patches the run JSON's `validation[]` array and `validationStatus`.
//
//   3. Patches the parent task's `validationStatus` (rollup of run results).
//
// Designed to be called both:
//   - from console-server's /api/validate endpoint (Phase 9 wiring)
//   - directly from a CLI for ad-hoc validation:
//       node tools/validator.mjs --task t1 --run r1 --contracts contracts.json

import {
  readFileSync,
  writeFileSync,
  existsSync,
  appendFileSync,
  renameSync,
  createReadStream,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { evaluateContracts, rollupValidationStatus } from './contracts.mjs';
import { ingestEvent } from './event-store.mjs';

const CONSOLE_DIR = resolve(process.env.CONSOLE_DIR || '.agent-console');

export async function runValidation({
  taskId,
  runId,
  contracts,
  cwd,
  consoleDir,
}) {
  const dir = consoleDir ? resolve(consoleDir) : CONSOLE_DIR;
  const eventsFile = join(dir, 'events.jsonl');
  const taskFile = join(dir, 'tasks', `${taskId}.json`);
  const runFile = join(dir, 'runs', `${runId}.json`);

  if (!existsSync(taskFile)) {
    throw new Error(`task not found: ${taskId}`);
  }
  if (!existsSync(runFile)) {
    throw new Error(`run not found: ${runId}`);
  }

  const run = JSON.parse(readFileSync(runFile, 'utf8'));
  const task = JSON.parse(readFileSync(taskFile, 'utf8'));

  const ctx = {
    taskId,
    runId,
    cwd: cwd || dir,
    runStartedAt: run.startedAt,
    allowedBasePaths: [resolve(cwd || dir), resolve(process.cwd())],
  };

  const results = await evaluateContracts(contracts, ctx);

  // Idempotency: scan existing events.jsonl for (runId, contractId, contentHash)
  // tuples; skip results already recorded.
  const seen = await loadValidationKeys(eventsFile);

  const validationChecks = [];
  const writtenEvents = [];

  for (const result of results) {
    const key = validationKey(runId, result.id, result.contentHash);
    const alreadyRecorded = seen.has(key);

    validationChecks.push({
      label: result.id,
      status: result.passed ? 'pass' : result.error ? 'fail' : 'fail',
      evidence: result.evidence,
      contractId: result.id,
      contractType: result.type,
    });

    if (!alreadyRecorded) {
      const event = {
        timestamp: new Date().toISOString(),
        taskId,
        runId,
        type: 'validation_result',
        source: 'validator',
        sourceEventId: `validation:${runId}:${result.id}:${result.contentHash || 'no-hash'}`,
        contractId: result.id,
        contractType: result.type,
        passed: result.passed,
        evidence: result.evidence,
        contentHash: result.contentHash,
        ...(result.error ? { error: result.error } : {}),
      };

      // Route through the event store so seq + idempotency on
      // (source, sourceEventId) are applied — Phase 10.2/10.3.
      const ingested = ingestEvent(event, { eventsFile });
      writtenEvents.push(ingested);
      seen.add(key);
    }
  }

  // Patch the run with validation results.
  run.validation = validationChecks;
  run.validationStatus = rollupValidationStatus(results);
  run.updatedAt = new Date().toISOString();
  writeJsonAtomic(runFile, run);

  // Patch the task's validationStatus to mirror the latest run.
  task.validationStatus = run.validationStatus;
  task.updatedAt = new Date().toISOString();
  // If the run was already flushed into task.runs[], replace it.
  if (Array.isArray(task.runs)) {
    task.runs = task.runs.map((r) => (r.id === run.id ? run : r));
  }
  writeJsonAtomic(taskFile, task);

  return {
    results,
    validationStatus: run.validationStatus,
    eventsWritten: writtenEvents.length,
    eventsSkipped: results.length - writtenEvents.length,
  };
}

// --- helpers -----------------------------------------------------------

function validationKey(runId, contractId, contentHash) {
  return `${runId}|${contractId}|${contentHash || ''}`;
}

async function loadValidationKeys(eventsFile) {
  const set = new Set();
  if (!existsSync(eventsFile)) return set;
  const rl = createInterface({
    input: createReadStream(eventsFile, 'utf8'),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === 'validation_result' && ev.runId && ev.contractId) {
        set.add(validationKey(ev.runId, ev.contractId, ev.contentHash));
      }
    } catch {
      /* ignore malformed lines */
    }
  }
  return set;
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, file);
}

// --- CLI ---------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task || !args.run || !args.contracts) {
    process.stderr.write(
      'Usage: node tools/validator.mjs --task <id> --run <id> --contracts <file.json> [--cwd <dir>]\n'
    );
    process.exit(1);
  }
  const contracts = JSON.parse(readFileSync(args.contracts, 'utf8'));
  runValidation({
    taskId: args.task,
    runId: args.run,
    contracts,
    cwd: args.cwd,
  })
    .then((summary) => {
      process.stdout.write(
        `validation: ${summary.validationStatus} · ${summary.eventsWritten} events written, ${summary.eventsSkipped} idempotent skip\n`
      );
      for (const r of summary.results) {
        process.stdout.write(
          `  [${r.passed ? '✓' : '✗'}] ${r.id} (${r.type}) — ${r.evidence}\n`
        );
      }
    })
    .catch((err) => {
      process.stderr.write(`validator error: ${err.stack || err.message}\n`);
      process.exit(2);
    });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') out.task = argv[++i];
    else if (a === '--run') out.run = argv[++i];
    else if (a === '--contracts') out.contracts = argv[++i];
    else if (a === '--cwd') out.cwd = argv[++i];
  }
  return out;
}
