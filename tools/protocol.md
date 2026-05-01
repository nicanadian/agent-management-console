# File-based protocol — `.agent-console/`

The console (frontend) reads task and run state from a directory tree on
disk. Any agent runtime can become an integration by writing files in
this layout. Reference writers:

- `tools/claude-shim.mjs` — Claude Code (production adapter)
- `tools/harness-shim.mjs` — deterministic test harness (Phase 10.1)

Both shims write into the same directory tree via the same chokepoints,
so adding a third runtime is a matter of mirroring their shape.

## Layout

```
.agent-console/
├── tasks/                  # one JSON per task
│   └── <task-id>.json
├── runs/                   # one JSON per run
│   └── <run-id>.json
├── agents/                 # one JSON per agent (optional)
│   └── <agent-id>.json
├── messages/               # user→agent message queues, drained between turns
│   └── <task-id>.jsonl
├── daemons/                # PID files for live per-task daemons
│   └── <task-id>.pid
├── logs/                   # daemon stdout/stderr capture
│   └── daemon-<task-id>.log
└── events.jsonl            # append-only normalized event stream
```

`.agent-console/` is gitignored. The path is configurable via the
`CONSOLE_DIR` env var; `console-server.mjs` passes that through to every
spawned daemon, so a single env var swaps data directories cleanly.

## Task JSON

Mirrors the `Task` interface in `src/types.ts`. Fields the writer must
produce:

```json
{
  "id": "task-001",
  "title": "Investigate failing CI test",
  "type": "coding",
  "priority": "high",
  "agentId": "claude-code",
  "lifecycleStatus": "running",
  "claimedStatus": "none",
  "validationStatus": "pending",
  "reviewStatus": "pending",
  "createdAt": "2026-04-28T19:00:00Z",
  "updatedAt": "2026-04-28T19:05:12Z",
  "runs": [],
  "messages": []
}
```

The four explicit status axes match the PRD's separation of agent claim
/ validator verdict / human decision. `validationStatus` includes the
LLM-as-judge band (`judged_ok` / `judged_concerns`, Phase 9.3) — those
are distinct from the deterministic verdicts (`verified` / `failed` /
…) so a judge result alone cannot dress up unverified output.

## Run JSON

```json
{
  "id": "run-task-001-1745870000",
  "taskId": "task-001",
  "agentId": "claude-code",
  "status": "running",
  "startedAt": "2026-04-28T19:05:00Z",
  "activity": []
}
```

On completion (Phase 9.4 cost schema):

```json
{
  "id": "run-…",
  "status": "succeeded",
  "endedAt": "...",
  "runtime": "12m 04s",
  "cost": 0.43,
  "costUsd": 0.43,
  "costSource": "billed",
  "tokens": {
    "input": 1240,
    "output": 380,
    "cacheCreate": 0,
    "cacheRead": 8400
  },
  "agentSummary": "...",
  "validationStatus": "verified",
  "validation": [{ "label": "...", "status": "pass", "contractId": "..." }],
  "artifacts": []
}
```

`cost` is retained as a back-compat alias of `costUsd`. `costSource` is
`'billed'` when the runtime returned its own `total_cost_usd`,
`'estimated'` when we computed it ourselves.

## Messages queue (`messages/<task-id>.jsonl`)

The console appends one JSONL entry per user message:

```jsonl
{"text":"could it be threading?","mode":"queue","timestamp":"2026-04-28T19:09:40Z"}
```

The shim drains this file between turns using the **rename-on-drain**
pattern (Phase 6.2): rename to `<file>.draining-<pid>`, read, delete.
The console-server middleware always appends to the live name, so no
message is ever in two places.

`mode` values: `auto` | `queue` | `interrupt` (informational; the shim
treats all as "deliver next turn" for now).

## Events JSONL (`events.jsonl`)

Append-only, one normalized event per line. **All writes go through
`tools/event-store.mjs`** — the chokepoint that applies (Phase 10.2)
monotonic `seq` and (Phase 10.3) idempotency on `(source,
sourceEventId)`.

```jsonl
{"seq":42,"timestamp":"2026-04-28T19:05:12.345Z","taskId":"task-001","runId":"run-…","type":"assistant","source":"claude-shim","sourceEventId":"run-…:msg_abc","raw":{...}}
```

Required fields when ingesting:

- `type` — event family (`system` / `assistant` / `user` / `result` /
  `tool_call_started` / `tool_call_result` / `validation_result` /
  `reconciled` / …)
- `source` — adapter or component name (e.g. `claude-shim`,
  `harness-shim`, `validator`, `reconciler`)
- `sourceEventId` — stable per-source identifier; (source, sourceEventId)
  forms the dedup key

Server-assigned on ingest:

- `seq` — monotonic per `events.jsonl`, persisted across restarts
- `timestamp` — ISO 8601 (set if missing)

## Validation contracts (`tools/contracts.mjs`)

The deterministic checkers (Phase 9.1):

| type                | spec keys                                                    |
| ------------------- | ------------------------------------------------------------ |
| `file_exists`       | `paths: string[]`                                            |
| `command_exit`      | `command, args?, timeoutMs?, expectedExitCode?, env?`        |
| `content_structure` | `path, requireHeadings?, minLines?, requireRegex?`           |
| `file_modified`     | `path, sinceIso?` (defaults to run startedAt)                |
| `min_links`         | `path, count?`                                               |
| `git_diff_in_paths` | `allowedPaths, baseRef?`                                     |
| `judge`             | `criterion, path? \| text?, maxArtifactBytes?` (Phase 9.3)   |

`command_exit` runs through `tools/contract-sandbox.mjs` (Phase 10.5):
explicit cwd allowlist, env whitelist, hard timeout, no shell. The
sandbox is the only chokepoint for spawning agent-authored commands.

Validation is invoked via `POST /api/validate`:

```json
{
  "taskId": "t1",
  "runId": "r1",
  "cwd": "/path/to/work",
  "contracts": [{ "id": "tests-pass", "type": "command_exit", "command": "npm", "args": ["test"] }]
}
```

Results are written back to the run's `validation[]` array, the run's
`validationStatus` is rolled up, and one `validation_result` event is
appended per contract — idempotent on (runId, contractId, contentHash).

## Adapter dispatch (`console-server.mjs`)

When a task needs a daemon (capture or new message), the server reads
`task.agentId` and picks the adapter:

- `claude-code` (or unset) → `tools/claude-shim.mjs --task <id> --daemon`
- `harness-<mode>`         → `tools/harness-shim.mjs --task <id> --mode <mode> --daemon`

Add a new adapter by mirroring this dispatch and writing JSON in this
layout. The harness modes (`echo`, `tools`, `slow`, `fail`) double as
deterministic fixtures for tests.

## How the console reaches it

`tools/console-server.mjs` listens on `127.0.0.1:3001` and serves:

- `GET  /api/state` — `{ tasks, agents }` (reads `tasks/`, `agents/`)
- `POST /api/messages` — append to `messages/<task-id>.jsonl`, ensure daemon
- `POST /api/capture` — create task + spawn daemon
- `POST /api/validate` — run deterministic + judge contracts
- `POST /api/tasks/<id>/{stop,cancel}` — SIGINT/SIGTERM the daemon
- `POST /api/tasks/<id>/{assign,accept,reject,archive}` — UI state transitions

In dev, `vite.config.ts` proxies `/api/*` from port 3000 → 3001 so
either process can restart without taking the other down.

On boot, console-server runs:

1. **Reconciliation** (Phase 10.4) — scans `tasks/` and `runs/`,
   compares each `updatedAt` to the latest event referencing it in
   `events.jsonl`, and emits a `reconciled` event for any drift.
   Idempotent on (source='reconciler', sourceEventId='task:...:<updatedAt>').

2. **Stale-run sweep** (Phase 7.1) — every 30s, any run with
   `status='running'` and stale `updatedAt` plus a dead/missing daemon
   PID flips to `status='unknown', terminationReason: 'no_heartbeat'`.

## Run with the FS adapter

```bash
npm run dev   # console-server on :3001 + vite on :3000 + concurrent
```

Test the harness without claude:

```bash
curl -sX POST -H 'Content-Type: application/json' \
  -d '{"title":"test","prompt":"hi","agentId":"harness-echo"}' \
  http://127.0.0.1:3001/api/capture
```
