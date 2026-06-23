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
├── worktrees/              # per-task git worktrees (Phase 13)
│   └── <task-id>/
├── projects.json           # project name → { repoPath, defaultBranch }
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
  "createdBy": "ui",
  "runs": [],
  "messages": []
}
```

The four explicit status axes match the PRD's separation of agent claim
/ validator verdict / human decision. `validationStatus` includes the
LLM-as-judge band (`judged_ok` / `judged_concerns`, Phase 9.3) — those
are distinct from the deterministic verdicts (`verified` / `failed` /
…) so a judge result alone cannot dress up unverified output.

`createdBy` (Phase 12.1) is a free-form provenance tag — `'ui'`,
`'hermes'`, `'cli'`, etc. The server defaults to `'ui'` when
`/api/capture` omits it. The UI renders a small chip when
`createdBy && createdBy !== 'ui'`.

## Worktrees (Phase 13)

Tasks whose `project` matches an entry in `projects.json` run in an
isolated git worktree, so multiple agents can work the same repo
simultaneously without sharing a working tree or index.

Registry: `POST /api/projects {name, repoPath, defaultBranch?,
setupCommand?, mergeMode?}` — validates the repo, detects the default
branch when omitted. `setupCommand` is a shell command run once per fresh
worktree (e.g. `npm install`); `mergeMode` is `'local'` (default) or
`'github-pr'`. `GET /api/projects` lists entries.

The persisted `worktree` object on a task:
`{ path, branch, repoPath, defaultBranch, mergeMode, setupStatus?,
mergedAt?, mergeCommit?, mergeConflicts?, prUrl?, prNumber?, removedAt? }`.

Lifecycle (all in `tools/worktrees.mjs`):

- **spawn** — `ensureDaemon` calls `ensureWorktree()`:
  `git worktree add .agent-console/worktrees/<taskId> -b task/<taskId>`
  off the default branch, passes it to the shim as `--cwd`, and records
  the `worktree` object on the task. Idempotent; re-attaches if the
  directory vanished but the branch survived.
- **setup (Phase 13.1)** — if the project has a `setupCommand` and the
  worktree has no `<taskId>.setup-ok` marker (a sibling file, never inside
  the tree), `startSetup()` runs it detached so the HTTP handler stays
  responsive. The daemon spawn is **gated** on setup exiting 0 (marker
  written, `setupStatus: 'done'`). A failure sets `setupStatus: 'failed'`,
  `lifecycleStatus: 'blocked'`, and a message; sending another message
  retries (marker absent ⇒ `needsSetup` still true). `setupInProgress`
  guards against double-starting.
- **accept = merge (local mode)** — `mergeTaskBranch()` first sweeps
  uncommitted worktree changes into a commit (agents don't reliably
  commit), then merges `task/<taskId>` into the default branch using
  `git merge-tree --write-tree` + `commit-tree` + compare-and-swap
  `update-ref` plumbing (git ≥ 2.38) — no working tree is ever touched
  by the merge. A clean human checkout sitting on the default branch is
  fast-forwarded afterwards; a dirty one is left alone. On conflict the
  accept is **blocked**: `reviewStatus` → `needs_changes`,
  `worktree.mergeConflicts` lists the files, and an agent-style message
  explains what happened.
- **accept = PR (github-pr mode, Phase 13.2)** — `openPullRequest()`
  commits WIP, pushes `task/<taskId>` to `origin`, and runs `gh pr
  create`, recording `prUrl`/`prNumber`/`prState: 'open'` and clearing the
  task from the tray (review happens on GitHub). Any failure (no `origin`,
  `gh` missing or unauthenticated, no commits) **blocks** the accept the
  same way a conflict does — nothing is marked accepted that didn't ship.
- **PR follow-up (Phase 13.2)** — a `sweepPullRequests()` poll (every
  `PR_POLL_INTERVAL_MS`, default 60s) runs `gh pr view` for any github-pr
  task whose `prState` isn't terminal. When GitHub reports `MERGED` /
  `CLOSED` it records `prState` + `prMergedAt`/`prMergeCommit` and posts a
  message, so a fire-and-forget PR still ties off its audit record. The
  `gh` binary is overridable via `GH_BIN` (tests point it at a stub);
  `checkPullRequest()` returns `{ error }` on any gh failure so a
  transient error just retries on the next sweep.
- **archive** — removes the worktree directory (sweeping any leftover
  work onto the branch first), clears the setup marker, and sets
  `worktree.removedAt`. The `task/<taskId>` branch is kept as the audit
  record, merged or not.
- **diff** — `GET /api/tasks/<id>/diff` returns
  `{ branch, defaultBranch, baseCommit, stat, files[], uncommitted[] }`
  (committed work from refs, uncommitted paths from the worktree) —
  rendered by the detail panel's Branch section.

Tasks without a registered project behave exactly as before Phase 13:
the daemon runs in the server's cwd and no `worktree` field is written.

### Concurrency / merge serialization — watch-item

Local-mode merges are safe under parallel agents **only because the
console-server is single-threaded**: all git calls are synchronous, so
two accepts can't interleave their read-`merge-tree`-`update-ref`
sequences, and the compare-and-swap `update-ref` catches an external ref
move. This is load-bearing but implicit. If the server ever goes
multi-process or moves into a Tauri sidecar that can handle accepts
concurrently, this assumption breaks and a real cross-process lock (e.g.
an `flock` on a per-repo lockfile around the merge, or a serialized merge
queue) is required. `setupInProgress` is likewise in-process state with
the same caveat.

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

- `GET  /api/state` — `{ tasks, agents }` (reads `tasks/`, `agents/`).
  `?createdBy=<value>` filters tasks by provenance (Phase 12.1).
- `GET  /api/tasks/<id>` — single task JSON, or 404 (Phase 12.2).
- `GET  /api/tasks/<id>/messages` — parsed array from
  `messages/<id>.jsonl`; empty array if no queue exists (Phase 12.2).
- `GET  /api/runs/<id>` — single run JSON, or 404 (Phase 12.2).
- `GET  /api/events` — SSE stream of `events.jsonl` (Phase 12.3).
  Catchup-then-tail; resume via `?since=<seq>` or `Last-Event-ID`
  header. Optional `?taskId=<id>` narrows to one task.
- `POST /api/messages` — append to `messages/<task-id>.jsonl`, ensure daemon
- `POST /api/capture` — create task + spawn daemon. Body:
  `{ title, prompt?, agentId?, project?, priority?, attachments?, createdBy? }`.
  `createdBy` defaults to `'ui'` (Phase 12.1).
- `POST /api/validate` — run deterministic + judge contracts
- `POST /api/tasks/<id>/{stop,cancel}` — SIGINT/SIGTERM the daemon
- `POST /api/tasks/<id>/{assign,accept,reject,archive}` — UI state transitions

### `/api/events` SSE contract (Phase 12.3)

Response headers:

```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

Each event is framed:

```
event: <event.type>
id: <event.seq>
data: <full event JSON>

```

(blank line terminator). The `id:` field doubles as the resume token —
browser `EventSource` sends it back as `Last-Event-ID` on automatic
reconnect. Manual clients can pass `?since=<seq>` instead; the header
takes precedence when both are provided.

The handler emits `:keepalive` SSE comments every 15s so idle
connections don't get reaped by intermediaries.

The stream is **at-least-once** within a session and **deduped by seq**:
- On connect, the server reads `events.jsonl` from start and emits each
  event with `seq > resume` (the catchup phase).
- Live writes during catchup are buffered, then drained — also filtered
  by `seq > highestEmittedSeq`. After draining, live writes emit
  immediately.
- Reconnect with the last seen `id:` and you'll never see a duplicate.

The implementation is a thin wrapper over `tools/event-tailer.mjs`
(`fs.watch` on the parent directory + sticky byte offset + partial-line
buffering). It will be replaced by a SQL-driven feed in Phase 11.2 —
clients should not depend on framing details beyond the SSE contract
above.

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
