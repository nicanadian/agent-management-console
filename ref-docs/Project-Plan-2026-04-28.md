# Agent Management Console — Project Plan

**Founded:** 2026-04-28
**Last updated:** 2026-04-30 (Phase 9 + 10 landed end-to-end; Tauri-only Phase 11 remains)
**Author:** Nic Zinner + Claude
**Companion doc:** `Generic-Agent-Management-Console-PRD.md`

---

## Context

The PRD was drafted 2026-04-27. That same evening, five exploratory views were built in a Vite/React/Zustand frontend prototype with mock data: Cards, Agents, Graph, Board, Digest. After sleeping on it (2026-04-28), we cut to **Cards** (primary) and **Digest** (workday summary).

To decide what to build next, three independent reviews were commissioned from systems-engineering, software-engineering, and agentic-engineering lenses. Their full text is in Appendices A–C. Steps 1–5 below were the synthesis. After steps 1–5 landed (single session, 2026-04-28→29), a second panel was convened — same three reviewers plus a product designer — to plan Phase 6 onward. Their full text is in Appendices D–G.

---

## Convergent findings (panel #1, 2026-04-28)

1. **Fix the data model before adding any more UI.** Split `Task` / `Run` / `Activity` / `Message`. Add `parent_task_id` and `runs[]`. Three explicit status axes — `claimedStatus` / `validationStatus` / `reviewStatus`.
2. **Introduce a persistence boundary now**, while data is still mock. Async API; in-memory backed today; SQLite swap is one file later.
3. **Don't move to Tauri yet.** Pure-frontend work first.
4. **Cards + Digest is right; cutting Graph was correct.**

## Push-back on the PRD (still open)

- **`Activity` enum is too coarse.** Real Claude Code emits tool calls, thinking, permission prompts, partial deltas, subagent spawns. Need richer types and a `parent_event_id` so a 40-tool-call run collapses to "Read 14 files (expand)". → Phase 7.2.
- **`auto`/`queue`/`interrupt` is too clean.** Be honest: `interrupt_after_current_tool` is what you actually get. Add `cancel` and `pause`. → Phase 6.6.
- **"Done today" framing is a trap.** Make digest a *time window*, not a *day*. → Phase 8.5.
- **Deterministic-only validation won't survive research/docs.** Compromise: deterministic gates `verified`; LLM-as-judge gates `judged_ok` / `judged_concerns`; never alone clears unverified. → Phase 9.3.
- **Per-task token attribution is a comforting lie.** Show *run* cost precisely; *task* cost as `~$X` sum-of-runs. → Phase 9.5.

---

## Plan progress

### Phase 1–5 — done (2026-04-28 → 2026-04-29)

- ✓ **Step 1** — Types realigned: 4 explicit status axes (lifecycle/claim/validation/review), `Run` separated, `parentTaskId` added, helpers `taskBucket()`/`latestRun()`/`totalCost()`. Mock data migrated.
- ✓ **Step 2** — Repository boundary (`src/data/repository.ts`) + UI/data store split (`useUIStore`).
- ✓ **Step 3** — `CardsView` 499→112 lines, `DetailPanel` 468→87. Subdirs `cards/` and `detail/`. Every component <250 lines.
- ✓ **Step 4** — Vitest + 37 tests covering helpers and `InMemoryRepository`.
- ✓ **Step 5** — Claude Code adapter, end-to-end real. `tools/claude-shim.mjs` runs `claude --print --output-format stream-json --verbose`, writes `.agent-console/` per `tools/protocol.md`. Vite plugin exposes `/api/state` and `/api/messages`. `FileSystemRepository` polls. Smoke-tested live: real Claude run, queued message drained on next invocation.

### Phase 6 — close the dogfood loop

The single-shot shim is a demo, not a tool. Phase 6 makes the FS-mode UI usable as a daily Claude Code launcher. *Strong panel-#2 convergence on these items.*

- **6.1** Atomic writes (`.tmp` + rename) for shim writes to `tasks/`, `runs/`, `agents/` JSON files. *Systems eng's "no longer theoretical" bug — partial-read window is already open at 1Hz polling.*
- **6.2** Fix `messages/<id>.jsonl` drain race via rename-on-drain. Shim renames to `<file>.draining-<pid>`, reads, deletes; Vite middleware always appends to live name.
- **6.3** Stream `agentSummary` + `currentTool` updates per `tool_use` event so running cards aren't blank during the run. *The single change that makes the 1-second poll feel alive (agentic eng + product designer).*
- **6.4** Long-lived per-task shim daemon with `claude --resume <session_id>`. Replace one-invocation-per-turn with a child process per active task that loops drain-queue → claude-with-resume → write events. Persist `currentSessionId` on the run. *The actual product unlock — without resume, every "next turn" is amnesia.*
- **6.5** Wire `captureTask` in `FileSystemRepository` so the UI can launch tasks (POST `/api/capture` → write task JSON → spawn the daemon from 6.4). *Skip assign/accept/reject for now per agentic eng — single-user dogfood doesn't need them.*
- **6.6** Kill/Pause button on running cards: "Stop after current tool" (SIGINT) + "Cancel" (SIGTERM, keep artifacts). Honest labels — no mid-tool-call interrupt fiction.
- **6.7** Extract API to `tools/console-server.mjs` standalone process; Vite proxies `/api/*` to it. *Lets the API outlive `vite dev` restarts and forces the handlers to factor cleanly.*

### Phase 7 — pay down structural debt while dogfooding

- **7.1** Heartbeat + startup sweep: any `runs/<id>.json` with `status='running'` and stale `updatedAt` (>2min) → `status='unknown'`, `terminationReason: 'no_heartbeat'`. The shim's per-event `writeFileSync` *is* the heartbeat — just label it.
- **7.2** Richer activity parser in shim: emit `tool_call_started`, `tool_call_result`, `tool_call_error`, `permission_requested`, `thinking`, `subagent_spawned`. Each event carries `parentEventId` so the detail panel can collapse "14 reads" instead of rendering 14 rows. *Land before more detail-panel UI is built on the current sparse shape (systems eng).*
- **7.3** Component tests with Vitest + jsdom + Testing Library. Cover bucket → view-component routing in `DetailPanel` and the `ReplyComposer` mode-switching state machine. *Software dev: 10 component tests buy more than 10 E2E tests at this scale.*
- **7.4** Delete `InMemoryRepository` from the production bundle; move under `src/data/__fixtures__/`. Add a `--seed mock-tasks` flag to `tools/claude-shim.mjs` for the "I want pretty data to look at" case. Tests still depend on it as a fixture. *Two parallel runtime backends is unforced maintenance burden.*
- **7.5** Wire FS write paths `assignTask` / `acceptTask` / `rejectTask` via the same `/api/messages`-shaped queue pattern, with a `kind` discriminator on each entry. *Gated on 6.1 (atomic writes) and 6.7 (extracted daemon) per systems eng — two writers without a coordinator will corrupt.*

### Phase 8 — UX for daily use

- **8.1** Live-activity rail in `RunningView`: current tool name, file/path being touched, last 30s of streamed text, animated as 7.2's events arrive. *Without this, the console is "a slower way to read summaries you could have gotten from `ls .agent-console/`" (product designer).*
- **8.2** Promote `waitingOnUser` so it actually screams: pinned "Needs you (N)" rail at the top of Cards, plus macOS dock badge + system tray indicator. *Today there are four competing accent colors and no dominant signal.*
- **8.3** Progressive capture: `c` palette parses `@coding-agent #orbital-sim !high investigate flaky test` inline, with chips appearing as you type. Type-ahead on agents and projects. *Raycast / Linear style — no modes, no form.*
- **8.4** Decide on the chat-card stack metaphor. Product designer recommends replacing with "latest message + count" tile and putting conversation in the detail panel; the stack-flip interaction is "a clever-trick discovered after you notice the offset shadows." *Open question; user has explicitly opted into the stack so far.*
- **8.5** Cut the Digest view, fold the useful 20% (today's spend, "still waiting" count, failed list) into a collapsible strip above the Cards tray. Reclaim the nav slot for Timeline or Agents.

### Phase 9 — validation, contracts, cost — done (2026-04-30)

- ✓ **9.1** Deterministic contract checkers in `tools/contracts.mjs`: `file_exists`, `command_exit` (sandboxed), `content_structure`, `file_modified`, `min_links`, `git_diff_in_paths`. YAML loader still deferred per plan.
- ✓ **9.2** Validation results written as `validation_result` events via `tools/validator.mjs`. Idempotent on `(runId, contractId, contentHash)`. Surface: `POST /api/validate`.
- ✓ **9.3** LLM-as-judge band added: `judged_ok` / `judged_concerns` in `ValidationStatus`. Judge contract type uses `claude --print` with stdin; never alone clears unverified (rollup tested: deterministic dominates, judge can only land on its own band or downgrade `verified` → `judged_concerns`).
- ✓ **9.4** Cost schema enriched: `costUsd`, `costSource: 'estimated' | 'billed'`, `tokens: { input, output, cacheCreate, cacheRead }`. Shim parser captures all four token classes from claude's `usage` block.
- ✓ **9.5** Per-task cost shown as `~$X` when there are multiple runs OR cached tokens (cache effects distort per-task attribution). Per-run cost remains precise. Tooltip explains. `taskCost(task): TaskCost` helper.

### Phase 10 — second runtime adapter + protocol hardening — done (2026-04-30)

The custom test harness was the second adapter. Codex CLI / OpenAI Responses deferred until a real second runtime is needed for dogfooding (the harness already forced the generality work).

- ✓ **10.1** Custom test harness adapter `tools/harness-shim.mjs` — modes `echo` / `tools` / `slow` / `fail`. Same FS protocol as claude-shim. Console-server dispatches by `task.agentId` (`harness-<mode>` → harness, else claude). Forces protocol generality — no API key needed for end-to-end tests.
- ✓ **10.2** `events.jsonl` writes go through `tools/event-store.mjs`. Server-assigned `seq INTEGER`, monotonic, persisted across restarts.
- ✓ **10.3** Idempotency on `(source, sourceEventId)` at ingest. Replaying after crash, or two adapters racing on the same id, produces no duplicate state.
- ✓ **10.4** Reconciliation pass in `tools/reconciler.mjs` runs on console-server boot. Walks `tasks/` and `runs/`, emits `reconciled` events for any whose `updatedAt` postdates the last referencing event. Idempotent.
- ✓ **10.5** Sandbox `tools/contract-sandbox.mjs`: cwd allowlist (realpath-resolved against base paths), env whitelist (no inheritance of arbitrary `process.env`), no shell, hard timeout via SIGTERM → SIGKILL grace, output capped at 256KB. Only chokepoint for spawning agent-authored commands.

### Phase 11 — Tauri shell, SQLite event store, native UX

- **11.1** Tauri v2 shell wrapping the existing React app. The repository abstraction means no UI changes; the `console-server.mjs` from 6.7 collapses into a Tauri sidecar.
- **11.2** SQLite event store per the PRD's schema. Tasks/runs/artifacts retained; events 90d, validation/cost 180d. Built only after 10.x has proved the protocol shape on a second adapter.
- **11.3** Native system tray: green / yellow / red / gray indicator per the PRD's tray-status spec. Right-click actions: Open / Capture / Inbox / Digest / Pause / Quit.
- **11.4** Native notifications for review-needed / validation-failed / agent-blocked / long-running-threshold-exceeded. Mute controls.
- **11.5** Replace 1Hz polling with `tauri-plugin-fs-watch` + push events. SSE over HTTP is also viable as an interim step inside `console-server.mjs`.

---

## Explicitly NOT yet (and why)

- **Graph view** — *product designer's trap.* Most fun to build, least useful before live activity is solid. Keep deferred per panel #1 + panel #2.
- **Workflow builder** — PRD phase 4. Doesn't pay off before tasks/runs/validation are reliable.
- **Multi-user review / shared queues** — single-operator tool today. Re-evaluate when there's a co-pilot use case.
- **Issue tracker / PR integrations** — defer until a week of dogfooding shows what actually needs to flow through.
- **LLM-providers cost-API** — defer until 9.4's per-run cost schema stabilizes.
- **Saved task templates / recurring** — PRD phase 4.
- **Agent registry UI** — PRD covers it but operator value is low for a single-user tool.
- **Suggested agent assignment** — PRD covers it; defer until enough run history exists to make suggestions non-arbitrary.

## Reviewer-flagged traps (panel #2, 2026-04-29)

- **DON'T design SQLite event store yet** *(software dev #4):* file-protocol failure modes will reshape the schema. Build SQLite *after* the second adapter (Phase 10.x), not before.
- **DON'T harden the protocol broadly before dogfooding** *(agentic eng):* none of `seq`/idempotency/full atomic+lockfile matters until you've used the loop for a week. **Phase 6.1 atomic writes is a deliberate exception** — the partial-read window is empirically open today at 1Hz polling, not theoretical.
- **DON'T port `assignTask`/`acceptTask`/`rejectTask` into `FileSystemRepository` before 6.1 atomic writes + 6.7 extracted daemon land** *(systems eng):* two writers (UI + shim) on the same task JSON without a coordinator will corrupt.
- **DON'T add Playwright until two adapters exist or Tauri ships** *(software dev #2):* E2E against a Vite dev server with a shim subprocess is a flake factory. Component tests (vitest + jsdom + Testing Library) buy more right now.
- **DON'T build the graph view** *(product designer):* see above.
- **DON'T pretend `interrupt` mid-tool-call works** *(agentic eng):* it doesn't. Be honest in the UI labels — `Stop after current tool` is what `SIGINT` actually delivers (Phase 6.6).
- **DON'T add auth/CORS/multi-user/PID-files to `console-server.mjs` yet** *(systems eng):* bind to `127.0.0.1`, single trusted user, that's the contract until Tauri.

---

## Appendices

### Appendix A — Senior systems engineer (panel #1, 2026-04-28)

#### What the design gets right

- **Three-axis status separation.** Agent claim / validator verdict / human decision are explicitly distinct (PRD §5, UX principle #2). This is the single most important architectural choice in the doc and the one most products get wrong. Keep it; never collapse `validation_status` into `status` even when "it would simplify the UI."
- **Normalized `ConsoleEvent` as the spine.** Funneling every source (runtime/fs/git/command/user/validator) through one append-only event shape is the right move. The events table is the audit trail; the `tasks`/`runs` tables become projections — derivable, replayable, debuggable.
- **Deterministic-only contracts in V1.** Refusing LLM-as-judge for core correctness is correct. File-existence, exit codes, headings, diff scope — these are cheap, reproducible, and survive a postmortem.
- **File-based adapter as the lingua franca.** `.agent-console/` with task/run JSON + `events.jsonl` lets you onboard any runtime that can write a file. Smart escape hatch from runtime-coupling.
- **Retention asymmetry.** Events 90d, cost/validation 180d, tasks/runs/artifacts forever. Right call: the row-explosion tables churn, the narrative tables stay.

#### Concerns / risks

- **The events table has no monotonic ordering guarantee.** Wall-clock `timestamp TEXT` from multiple adapters will arrive out-of-order and with skew. Add a server-assigned `seq INTEGER PRIMARY KEY AUTOINCREMENT` and an `(task_id, seq)` index. Also: `timestamp` as TEXT (ISO8601) sorts correctly only if every writer uses Z-suffix UTC with consistent sub-second precision — enforce or store as INTEGER epoch-ms.
- **No idempotency / dedup story.** Adapters retry. File watchers double-fire. `events.id` is declared but there's no `UNIQUE(source, source_event_id)` to make ingestion idempotent. Without this, replaying `events.jsonl` after a crash duplicates state. The validator must also be idempotent on `(run_id, contract_id)` — currently nothing prevents two passes producing two `validation_results` rows that disagree.
- **Run lifecycle has no crash recovery.** If the console dies mid-run, `runs.status='running'` is a lie forever. Need (a) a heartbeat-driven sweep that marks stale runs `unknown`, (b) explicit `claimed_completion_at` vs `verified_completion_at` so a silent adapter doesn't auto-promote to "done." The PRD's `agent_heartbeat` event exists but no policy binds it to run state.
- **File-based protocol failure modes are unspecified.** Partial writes (writer crashes mid-`task-001.json`), racing watchers (debounce window?), atomic rename requirement, lockfile semantics, JSONL truncation on power loss — none of this is in §"Suggested V1 File-Based Protocol." On macOS, `FSEvents` coalesces and drops events under load; the adapter needs a reconciliation pass on startup, not just streaming.
- **Cost reconciliation across providers is structurally weak.** `cost_events` has `cost_usd REAL` and `tokens INTEGER` — no input/output token split, no cached-token accounting, no FX, no source-of-truth flag (estimated vs billed). Anthropic prompt caching alone breaks the single-`tokens` field. You will not be able to reconcile to a provider invoice.
- **Frontend prototype's data model is already drifting from the PRD.** `types.ts` has `status: 'review'` (one state); PRD has `review_needed | accepted | rejected`. `Task` has no `runId`, no `runs[]`, conflates run-level (`runtime`, `cost`) onto the task. Mock data uses `'10:14:55'` strings (no date, no TZ). Migrating the React store to the PRD shape is non-trivial and worth doing before more views are built on the wrong shape.
- **No contract-evaluation sandbox model.** "Command exit check: `pnpm test`" is a remote code execution primitive triggered by an agent-authored YAML. Path/working-dir/env/timeout/allowlist all unspecified.

#### What I'd do next

1. **Align the prototype's types with the PRD before building more UI.** Split `Task` from `Run`; add explicit `claimedStatus` / `validationStatus` / `reviewStatus`; move `runtime`/`cost` to runs. Cheap now, expensive after three more views land. ~1 day.
2. **Build the SQLite event store + file-based adapter as a thin Tauri sidecar — no UI rewrite.** Wire the existing React store to read projections from SQLite via Tauri commands. This de-risks the entire backend story and forces you to confront ordering, dedup, atomic writes, and crash recovery on a small surface. Ship the mock data as a seeded `events.jsonl` so the prototype keeps working. ~1 week.
3. **Validation runner third, contracts YAML fourth.** Once events persist, write the deterministic checkers (file_exists, command_exit, content_structure, git diff) against artifacts on disk, with results written back as `validation_result` events. Idempotent on `(run_id, contract_id, content_hash)`. Defer YAML loader until you have ~3 contract types working in code.
4. **Do NOT build yet:** Graph view, agent registry UI, notifications, suggested assignment, multi-runtime adapters, cost dashboards beyond the digest, and especially the LLM-providers-cost-API integration. None of these pay off until the event store is real and at least one adapter is producing real events. The graph view in particular is a tarpit before the data model is settled.

The order matters: types → store → adapter → validator. Each step verifies the one before it. Skip the type alignment and you'll rebuild the UI twice.

---

### Appendix B — Senior software developer (panel #1, 2026-04-28)

#### What the codebase gets right

- **Stack discipline.** React 18 + Vite + TS strict + Zustand + Tailwind, no router, no UI kit, no state-machine library, no animation library. For a prototype this size that's exactly right. Three runtime deps total. The `tsconfig` has `strict: true`, and the code uses it (discriminated unions on `TaskStatus`, no `any` I could find).
- **Zustand selectors are used correctly.** Components subscribe to single fields (`useStore((s) => s.tasks)`) rather than grabbing the whole store, so re-render scope stays narrow. No selector-equality footguns yet.
- **The domain model in `types.ts` is the strongest file in the repo.** Statuses, priorities, validation, activity, and message shapes are all named unions — that's the right backbone for adapters later.
- **Keyboard layer is isolated** (`useKeyboard.ts`) and explicitly skips when an input is focused. Chord handling is a tiny, readable state machine. Easy to extend without touching components.
- **Cuts have been made.** Three views were removed without leaving dead code behind. That's a healthy signal — the team is willing to delete.

#### Concerns / what's getting brittle

- **The `Task` type is doing four jobs.** Identity (id/title/status), assignment (agent/project), execution telemetry (runtime/cost/activity), and a full conversation transcript (`messages`, `pendingReply`, `waitingOnUser`) all live on one record. Once messages and activity are real, this becomes a 50KB blob loaded for every card render and a nightmare to sync. Split now: `Task`, `TaskRun`, `Message`, `ActivityEvent` as separate entities with foreign keys. The store should hold them in normalized maps (`Record<id, T>`) rather than arrays.
- **`store.ts` mixes UI state and domain state.** `selectedTaskId`, `view`, `capturePaletteOpen`, `shortcutsOverlayOpen` sit alongside `tasks` and mutators that pretend to be commands. When persistence arrives, the diff between "this is local UI" and "this needs to round-trip to SQLite/an adapter" will be painful to disentangle. Two stores (or one store with a `ui` sub-slice) costs nothing today and saves a refactor later.
- **No persistence boundary at all.** `mockTasks` is imported directly into `store.ts` and the mutators do `setState` on the in-memory array. Every read/write in components currently assumes synchronous, infallible state. The PRD's SQLite + adapters world is async, fallible, and reactive — none of that is reflected here. This is the single biggest architectural debt.
- **`CardsView.tsx` (495) and `DetailPanel.tsx` (461) are doing too much.** `ChatCard` alone is ~310 lines and owns: stack geometry math, message navigation state, reply input, send-mode logic, status accent theming, and pending-reply chip. `DetailPanel` reaches into `tasks.find(...)` to resolve the selected task instead of receiving it. Both need extraction before the next feature touches them or two people will be merge-conflicting on every PR.
- **Mock data ships in the runtime bundle.** `data/mockTasks.ts` is imported by `store.ts` unconditionally — it'll be in production. Beyond size, it means there is no story for "empty state," "loading state," or "error state" because the data is always there, instantly, never wrong.
- **Zero tests, zero CI.** Acceptable today, but `sendMessage`'s mode logic (auto / queue / interrupt with branching on `waitingOnUser` and status) is exactly the kind of code that breaks silently and is non-obvious to read. It's the cheapest test win in the repo.

#### What I'd do next (in order)

1. **Introduce a persistence boundary now, before SQLite.** Create `src/data/repository.ts` exposing async `listTasks()`, `getTask(id)`, `sendMessage(...)`, `assignTask(...)` etc. Back it with an in-memory implementation that wraps the current mock data. Have the store call the repo, not mutate arrays. This is one afternoon. It makes the eventual SQLite swap a single-file change and forces components to confront async/loading states early. **Do this before anything else.**
2. **Normalize the domain model and split UI state from domain state.** `Task` loses `messages`/`activity`/`artifacts`; those become their own collections keyed by `taskId`. UI flags (`view`, `selectedTaskId`, palette/overlay) move to a `useUIStore`. Pairs naturally with step 1.
3. **Break up `CardsView` and `DetailPanel` before the next feature.** Extract `ChatCard`, `MessageStack`, `ReplyComposer`, `BackgroundedRow` into their own files. `DetailPanel` should receive a `Task` (and ideally a `TaskRun`) as a prop, not look it up. Keeps PR surface small once features start landing.
4. **Smallest test investment that pays off:** Vitest + a handful of unit tests for the repository layer (step 1) and `sendMessage`/`assignTask` reducers. Skip component tests for now. Maybe 20 tests total, ~half a day. That covers every state-transition bug you're realistically going to hit.

#### On the PRD: push back on Tauri timing

Don't move to Tauri yet. The architectural debt above (persistence boundary, normalized model, store split, component breakup) is all pure-frontend work and will be **harder** to do inside Tauri's slower iteration loop. Land steps 1–3 in plain Vite, then shell into Tauri once the data layer is real. Moving to Tauri before fixing the data layer means you'll port the brittle parts and then refactor them under a build that takes longer.

---

### Appendix C — Senior agentic engineer (panel #1, 2026-04-28)

#### What this gets right about real agent work

- **Claimed vs verified vs accepted is the correct mental model.** Anyone running agents at volume learns fast that "agent said done" is roughly 60% reliable, "validator said pass" is 90%, and "I looked at it" is the only signal you can ship on. The PRD makes that triple explicit and the UI keeps `done` and `accepted` distinct. Most chat UIs collapse this and it bites you.
- **`waitingOnUser` as a first-class field, surfaced in the tray and digest, is the right primitive.** A real workday across 5 agents has maybe 30 minutes of "actively talking to one" and 7 hours of "which one is currently stuck on me?" The attention-score sort in `CardsView.tsx` is doing the right thing.
- **`pendingReply` (queued message visible in the UI) is a small detail that nobody else gets right.** The Claude Code queue is invisible, Cursor's is invisible, and you constantly forget what you asked for. Showing it as a chip with "send now" is genuinely better UX than the tools being wrapped.
- **File-based protocol as the V1 adapter is the only sane choice.** Anyone who has tried to build over the Anthropic Agent SDK or OpenAI Responses streams knows you don't want a typed integration first — you want a directory you tail. The PRD's `.agent-console/` layout is correct.
- **Cost tied to outcome ("$3.20 on a task that failed validation").** Right framing.

#### Where this breaks down in practice

- **The `Activity` enum is fiction.** Real Claude Code emits `tool_use` blocks with `bash`, `str_replace`, `read_file`, plus thinking blocks, plus partial text deltas, plus permission prompts, plus subagent spawns. `'started' | 'read' | 'wrote' | 'ran' | 'thought' | 'completed'` will collapse all of that into mush. You need at minimum: `tool_call_started`, `tool_call_result`, `tool_call_error`, `permission_requested`, `text_delta`, `thinking_block`, `subagent_spawned`, `compaction`. And activity entries need a `parentId` so you can collapse a 40-tool-call run into "explored repo (40 reads)".
- **`auto`/`queue`/`interrupt` is a clean model that real runtimes don't actually support.** Claude Code: you can stop the current turn but mid-tool-call interrupts are fraught — the tool finishes, then your message lands. OpenAI Responses: streaming is effectively non-interruptible mid-turn. A custom harness: whatever you wrote. "Interrupt now" should be honest about what it does — `interrupt_after_current_tool` is what you actually get 95% of the time. Also missing: `cancel` (kill the run, keep the artifacts) and `pause` (let it finish the turn, then stop and wait).
- **Deterministic-only validation will not survive contact with research and docs tasks.** "Required headings present" passes a Q2 financial report that hallucinated 40% of the numbers — this is exactly what t13 demonstrates. For coding tasks, deterministic is fine. For research/docs/analysis, you need LLM-as-judge whether the PRD likes it or not. The compromise: deterministic checks gate to `verified`, judge checks gate to a separate `judged_ok` / `judged_concerns` band, and you never let a judge result alone clear `unverified`.
- **The "today" framing is a trap.** Real agent work: a refactor task spans Tuesday afternoon to Thursday morning, gets parked behind a meeting, branches into a subtask "first migrate the schema", spawns three parallel attempts on different branches. The data model has no `parentTaskId`, no `runs[]` (despite the PRD defining it), no notion that a task can be paused and resumed. `DigestView` filtering by "today" silently hides a task started yesterday that finished at 9am. Add `parent_task_id`, model `runs` as a real array on `Task`, and make the digest a *time window* not a *day*.
- **"Assign task to agent" hides three completely different actions.** Spawning a Claude Code subprocess (`claude -p ...` with a working directory and tool permissions), POSTing to an OpenAI agent endpoint, dropping a JSON file for a daemon to pick up. Each has different failure modes (process died vs. 429 vs. file lock) and different cost telemetry surfaces. The adapter interface in the PRD is right; the UI needs to know the agent's *invocation kind* and show different controls.
- **Per-task token attribution is a comforting lie.** Prompt caching means the second task in a session might cost 10% of the first. Streaming tokens get charged before you know which task they belong to if a turn spans tasks. Realistic compromise: show *run* cost (you know that exactly), show *task* cost as a sum-of-runs estimate, and mark it `~$X` with a tooltip explaining cache effects. Don't pretend it's precise.

#### What I'd do next

1. **Wire one real Claude Code session via the file-based protocol — that's the day-one unlock.** Write a thin shim that runs `claude --output-format stream-json` in a working directory, parses the stream, and writes `.agent-console/events.jsonl` + `runs/*.json`. The moment you can watch your *own* Claude session from the console while it's running and queue a message that lands at the next turn, this product is real. Everything else is decoration until that exists.
2. **Replace the `Activity` enum with a normalized event stream that carries the raw tool name and a `parent_event_id`.** Render it as a collapsible tree, not a flat timeline. Display: "Read 14 files (expand)" instead of fourteen rows. This is the single biggest UX gap between this prototype and something operators will actually use for 8 hours a day.
3. **Add `runs[]` and `parent_task_id` to `Task` now, before more UI is built on the flat shape.** Retrying t13 with web search enabled should be a new run, not mutation. Forking a research task into "deep dive on Chen 2025" should be a child task. Both are routine and the current types can't represent them.
4. **Trap to avoid: don't build the graph view yet.** It's seductive and useless until you have parent/child tasks and multi-run lineage actually flowing. Build the cards-view + detail-panel + one real adapter to a depth where *you personally* dogfood it for a week. Ship the graph in phase 3 like the PRD says — but only after you've felt the pain that justifies it. Skipping straight to graph viz is how prototypes die.

---

### Appendix D — Senior agentic engineer (panel #2, 2026-04-29)

#### Honest opening

On track, and faster than I expected. Steps 1–4 landed cleanly and step 5 actually crossed the "real artifacts on disk" line in one session — that's the threshold I cared about most. What surprised me: I underweighted how much the single-shot shim would hurt. Looking at `runs/run-smoke-test-1777435207839.json`, run 2 literally tells the user *"no active task to continue here"* — Claude has full amnesia between turns because there's no `--resume`. My Appendix-C said "watch your own session and queue a message" was the day-one unlock. The queue half works. The "watch your own session" half doesn't, because there *is* no session — there's a sequence of unrelated one-shots. I was wrong to call this dogfoodable as-is.

#### Next 5 steps, prioritized

1. **Wire `claude --resume <session_id>` into the shim.** The `system.init` event already carries `session_id`; persist the latest one on the `Run` (or on the `Task` as `currentSessionId`) and pass `--resume` on subsequent invocations. Without this, every queued message lands in a fresh context and the product is a demo, not a tool. **Do not** try to model multi-session lineage yet — one task → one live session is the dogfoodable shape; cross-session forking can wait for parent_task_id to actually carry weight.

2. **Make the shim a long-lived per-task daemon, kicked off from the UI.** Replace one-invocation-per-turn with a child process per active task that loops: drain `messages/<id>.jsonl` → call claude with `--resume` → write events → wait for next message. The UI's "send" button becomes the trigger; you stop dropping to a terminal. This is the difference between "Claude viewer" and "Claude launcher." **Do not** move the API to a standalone Node daemon yet — keep it in the Vite plugin and let the plugin spawn shims as children. Decoupling the API host from the dev server is a Tauri-era problem.

3. **Wire `captureTask` (and only captureTask) in `FileSystemRepository`.** It writes `tasks/<id>.json` and triggers step 2's spawn. Skip `assignTask`/`acceptTask`/`rejectTask` for now — in a single-user dogfooding loop you don't need them. Capture + send is the minimum write surface that turns the FS-mode UI from read-only into usable. **Do not** bikeshed atomic writes (`.tmp` + rename) on this pass; the smoke test proves non-atomic writes are fine at human cadence. Add atomic writes when you see your first torn read, not before.

4. **Stream `agentSummary` and a coarse "current activity" string while the run is in flight.** Right now `agentSummary` only lands on `result`, so the 1-second poll shows a blank card for the entire run duration. Have the shim update `runs/<id>.json` on every `tool_use` block with `agentSummary: "Reading src/data/repository.ts (3 tools so far)"` and a `lastToolName`. This is the single change that makes the 1-second poll feel alive. **Do not** build the collapsible activity tree yet — stringly-typed "what's happening right now" is enough to dogfood; the tree is a phase-2 reward for living with sparseness first.

5. **Add a "kill / pause" button wired to `process.kill(SIGINT)` on the shim child.** Once step 2 lands you have a long-lived child to signal. Be honest in the label: call it `Stop after current tool` (matches reality — Claude finishes the in-flight tool, then exits) and `Cancel` (SIGTERM, keep artifacts). **Do not** implement `interrupt` mid-tool-call — it doesn't exist and pretending it does is the trap I called out in Appendix C.

#### Trap to avoid

The team will be tempted to harden the protocol next — atomic writes, `seq INTEGER`, idempotency keys, the systems-engineering checklist from page 3 of the plan. **Don't.** None of that matters until you've used this thing for a week and found the *actual* failure modes. The smoke test ran twice without any of those and worked. Hardening before dogfooding is how you ship a beautifully-correct event store that nobody uses because the loop isn't closed. Close the loop (steps 1–4), live with it for 5 working days, *then* fix what actually broke.

---

### Appendix E — Senior software developer (panel #2, 2026-04-29)

#### Honest opening

On track, and more so than I expected. Steps 1–5 in one session is suspicious on paper but the artifacts hold up: 37 tests, every component under 250 lines, four-axis status carrying real weight (the validator-overrules-claim test is the one I'd have written), and a real Claude session writing real files end-to-end. My prior review undersold step 5 — I framed adapter work as a Tauri-time concern, but landing it now in 250 lines of Node + a 120-line Vite plugin was the right call and unblocks dogfooding. What I overemphasized: hand-wringing about normalized maps vs arrays. Arrays are fine at this cardinality; revisit at 1k tasks. What I undersold: the maintenance cost of having two repository implementations.

#### Next 5 steps, prioritized

1. **Wire the FS write paths — assign / accept / reject — through the same `/api/messages`-shaped queue pattern.** Stubs that throw on click are worse than nothing: the UI looks live, the user clicks, silence. Either wire them (cheap — they're all "append a JSONL command, shim drains") or render the buttons disabled with a tooltip in FS mode. *Don't* invent a separate command bus; reuse the messages queue file shape with a `kind` discriminator. Sequencing concern: doing this before Playwright means you'll catch the silent-failure class of bug by hand, which is fine at this scale.

2. **Component tests with Vitest + jsdom + Testing Library — not Playwright yet.** The bucket → component mapping (running shows Conversation, review shows ReviewView, failed shows FailedView) and the ReplyComposer mode-switching are pure render-from-props logic and break silently on refactor. Ten component tests buy more than ten E2E tests at this stage. *Don't* add Playwright until you have two real adapters or a Tauri shell — E2E against a Vite dev server with a shim subprocess is a flake factory.

3. **Atomic writes in the shim and a startup reconciliation pass.** Write-to-`.tmp`-then-rename is twenty lines and closes the partial-JSON read window the file-based protocol has open right now. Pair it with a single-pass reconciler on shim/plugin start that marks any `lifecycleStatus: 'running'` run with no live PID as `unknown`. *Don't* reach for `fs.watch` or SSE yet — 1s polling is fine until you actually feel the latency.

4. **Delete `InMemoryRepository` from the production bundle; keep it as a test fixture only.** It's pulling its weight in tests (37 of them depend on it), and it's nice for Storybook-style UI iteration, but shipping it as a runtime-selectable backend means every repo method now has two semantic implementations to keep in sync, and the FS one is the real product. Move it under `src/data/__fixtures__/` or `test/`, make `FileSystemRepository` the only runtime path, and add a `--seed mock-tasks` flag to the shim for the "I want pretty data to look at" case. *Don't* delete it from tests — that's where it earns its keep.

5. **Extract the API to a tiny standalone Node process behind `npm run console-api`.** Not a daemon yet, just `node tools/api-server.mjs` that imports the same handlers the Vite plugin uses. Vite proxies `/api/*` to it. This costs an afternoon and (a) lets the API outlive `vite dev` restarts during shim work, (b) makes Tauri-time migration a config change rather than a rewrite, (c) is a forcing function to factor the handlers out of the plugin. *Don't* call it a daemon, don't add pm2 / systemd / a PID file. It's a process you `Ctrl-C` like any other.

#### Trap to avoid

The temptation will be to start designing the SQLite event store and the `seq INTEGER` / idempotency story now that the file protocol is real. Don't. The file protocol's failure modes are the right pressure to feel for two more weeks of dogfooding before you commit to a schema — you'll learn things about partial writes, retry semantics, and what activity events actually look like that will reshape the table design. Build the SQLite store after the second adapter, not the first.

---

### Appendix F — Senior systems engineer (panel #2, 2026-04-29)

#### Honest opening

The systems story is on track. Steps 1–5 landed clean, and the artifacts in `.agent-console/` prove the file-protocol primitive works end-to-end — that was the real unlock from my prior review. Three of my Appendix-A concerns are *partially* addressed: types now match the PRD (claimed/validation/review split, runs as entities), the repo boundary exists, and there's a real adapter producing real events. Still open and now load-bearing: atomic writes, event `seq`, idempotency, crash recovery, and the cost-schema flatness. The new gap I didn't fully anticipate is the **drain race** on `messages/<id>.jsonl` and the **dev-server-as-API** coupling — both are shipping decisions that need a call this week.

#### Next 5 steps, prioritized

1. **Atomic writes via tmp+rename, NOW.** This is no longer theoretical. `FileSystemRepository` polls `/api/state` at 1Hz, which calls `readJsonDir` while the shim does `writeFileSync` on every stream-json chunk — that's tens of writes per second on `runFile`. A reader landing mid-write today returns `null` (the dir reader silently filters); tomorrow it returns a half-parsed task and corrupts the UI cache. Fix is ~10 lines: write to `<file>.tmp` then `renameSync`. Do NOT also try to land file-locking or fsync semantics — POSIX rename atomicity on the same FS is enough until SQLite.

2. **Fix the `messages/<id>.jsonl` drain race with rename-on-drain.** Read-then-truncate is a real bug, not a theoretical one — the user will eventually queue a follow-up while the shim is between reading lines and `writeFileSync(file, '')`. The smallest correct fix: shim does `renameSync(file, file + '.draining-' + pid)`, reads the renamed file, deletes it. The Vite middleware always appends to the *live* name, so no message is ever in two places. Do NOT introduce a lockfile or a queue daemon — rename is the whole fix.

3. **Extract `tools/console-server.mjs` as a standalone HTTP daemon; keep the Vite plugin as a thin proxy.** The dev-server-as-API bothers me more after seeing it — coupling backend lifetime to `npm run dev` means closing the browser tab kills the API, and there's no story for running shims when the UI is closed. Extract now, before more endpoints (assign/accept/reject) get written into the Vite plugin and you have to migrate them twice. Do NOT build auth/CORS/multi-user yet — bind to `127.0.0.1`, single trusted user, that's the contract until Tauri.

4. **Heartbeat + startup sweep for stuck `running` runs.** Once the daemon exists (step 3), give it a 30s sweep: any run with `status='running'` and `updatedAt` older than 2 minutes flips to `status='unknown'`, with `endedAt` and a `terminationReason: 'no_heartbeat'`. The shim writes an `updatedAt` on the run on each stream event already — that *is* the heartbeat, just label it. This hurts the moment you Ctrl-C a shim mid-run, which will happen on day one of dogfooding. Do NOT design a generic supervisor; one sweep loop, one rule.

5. **Richer activity parser before more detail-panel UI ships.** The current parser captures only `tool_use` blocks and concatenates text — permission prompts, thinking blocks, partial deltas, subagent spawns, and `tool_result` are all dropped. Anything you build on `activity[]` today will be rebuilt when this lands. Add `tool_call_started`, `tool_call_result`, `tool_call_error`, `permission_requested`, `thinking`, and a `parentEventId` so 14 reads collapse to one row. Do NOT also add `seq INTEGER` and idempotency yet — those belong with the SQLite cutover, not the JSONL phase.

#### Trap to avoid

Do not start porting `assignTask` / `acceptTask` / `rejectTask` into `FileSystemRepository` next — it will pull you into writing back to task JSON from two writers (UI and shim) without a coordinator, and you'll discover atomic writes and the drain race by corrupting your own data. Land steps 1–3 first; *then* mutation paths are safe to wire.

---

### Appendix G — Senior product designer (panel #2, 2026-04-29)

#### First impression, honest

The product instinct is right — operators *do* need a "shelf above the chats" — and the four-axis status model (lifecycle / claim / validation / review) is genuinely the most defensible design decision in here. The PRD line "do not make completed feel the same as accepted" is the soul of the product. What made me wince: the chat-card stack. Aesthetically it's the most distinctive thing on screen, but it's pulling huge amounts of pixel weight to do a job — "what's this task and does it need me" — that a well-designed Linear row does in one line. At 230×400 with eight messages stacked, t4 (the CI investigation) gives me a six-line preview of *one* message and asks me to flip-flip-flip to read the rest. Cursor's chat sidebar, Linear's inbox, and Granola's note list all win against this on density and scannability. The yellow border is also losing the war for my eye — the blue "running" pulse, the playful card stack, and the bright "+ New task" CTA all out-shout it.

#### Next 5 UX steps, prioritized

1. **Replace the card-stack metaphor with a "latest message + count" card, and put the conversation in the detail panel.** The stack is a clever-trick — discoverable only after you notice the offset shadows, and it inverts the operator's actual question ("what's the latest?") by making them click backwards through history. Keep the card as a tile (title, agent, latest line, status, "8 messages →"), let the side panel be the place you read history. *Linear does this exactly: row in the list, full thread on click. Granola too.* This is the single biggest unlock. If you love the stack, demote it to a hover affordance, not the primary read surface.

2. **Make `waitingOnUser` actually scream.** Today it's a yellow border + small ⚠ badge competing with five other accent colors. Promote waiting tasks into a pinned "Needs you (3)" rail at the very top, separated from everything else by whitespace, with a count in the macOS dock badge and tray. Slack red dots and Linear's "Inbox" tab work because there is exactly *one* signal that means "you, now." Right now there are four (yellow border, pulse, badge, header counter) and none of them dominate.

3. **Build the live-activity rail for running tasks.** The "Activity" list in `RunningView.tsx` is sparse rows with timestamps and a fake "working..." pulse. The whole reason you'd choose this over reading 12 terminal tabs is to *see what the agent is doing right now*: current tool call, file being touched, last 30 seconds of output streaming. Cursor's agent panel and Claude Code's own TUI already do this. Without it, the console is a slower way to read summaries you could have gotten from `ls .agent-console/`.

4. **Make capture progressive, not multi-modal.** Single-line capture is correct as the default, but `c` should accept inline syntax — `@coding-agent #orbital-sim !high investigate flaky test` — parsed as you type with chips appearing. Don't build a form. *Raycast and Linear's `c` both do this beautifully: type-ahead chips, no modes.* Keep "land in inbox" as the fallback when nothing is parsed.

5. **Cut the Digest view, fold the useful 20% into the top of Cards.** End-of-day summaries are a corporate-PM artifact for a single-operator tool — you already lived the day, you don't need a deck about it. The genuinely useful bits (today's spend, "still waiting on you" count, failed-validation list) belong as a collapsible strip above the tray in Cards. Reclaim the nav slot for something operators actually toggle to — Timeline, or Agents.

#### Trap to avoid

Adding the **Graph view** next. The PRD has it queued, and it'll be the most fun thing on the roadmap to build. It is also the thing that will most quickly turn this into a demo-ware screenshot generator and least quickly help anyone get through Tuesday. Until the live running case is good enough that an operator stays in the window for an hour without flipping back to a terminal, every other view is decoration.
