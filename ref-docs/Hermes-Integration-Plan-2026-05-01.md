# Hermes Integration Plan — Phase 12

**Founded:** 2026-05-01
**Author:** Nic Zinner + Claude
**Companion docs:** `Project-Plan-2026-04-28.md`, `Generic-Agent-Management-Console-PRD.md`

---

## Context

Hermes is an external orchestrator that wants to drive the console as a programmatic client — spinning up tasks, sending follow-up turns, and observing state. The existing API (Phases 6–10) already covers most of what Hermes needs:

| Hermes need                          | Endpoint                                   |
| ------------------------------------ | ------------------------------------------ |
| Create a task & pick the agent       | `POST /api/capture`                        |
| Send follow-up turns                 | `POST /api/messages`                       |
| Drive task state                     | `POST /api/tasks/:id/{stop,cancel,accept,reject,archive}` |
| Observe state                        | `GET /api/state`                           |

So the web UI and Hermes are peers — both clients of the same console-server. Phase 12 closes the three gaps that make Hermes second-class today.

---

## The three gaps

1. **Polling is wasteful at scale.** `GET /api/state` returns the full snapshot. Hermes polling at 1Hz across N tasks is a CPU heater. We have a monotonic `seq` (Phase 10.2); expose it as a stream.
2. **No per-entity reads.** Hermes that only cares about one task still has to pull the world. Adds latency and parsing cost.
3. **No attribution.** Tasks created by Hermes are indistinguishable from UI captures. The UI can't show provenance, and Hermes can't filter to "its own" tasks.

## Resolved design decisions

These are the open questions from the scoping pass, decided so implementation isn't blocked:

- **SSE wire format** — use native SSE framing: `event: <type>`, `id: <seq>`, `data: <event JSON>`. No bespoke wrapping. `id:` doubles as the resume token via `Last-Event-ID` on reconnect.
- **Resume semantics** — accept both `?since=<seq>` query param and the `Last-Event-ID` header. Header takes precedence (browser EventSource sets it automatically).
- **Live tail mechanism** — `fs.watch('events.jsonl')` + sticky byte offset; on change, read tail, split on `\n`, buffer partial lines, parse complete lines. Fall back to a 250ms `fs.stat` mtime/size poll if `fs.watch` proves flaky on macOS at runtime. One watcher fans out to N subscribers.
- **Per-task/per-run fetch** — orthogonal endpoints, no `?include=` switches. Three reads: `GET /api/tasks/:id`, `GET /api/tasks/:id/messages`, `GET /api/runs/:id`. Each 404s cleanly.
- **`createdBy` shape** — free-form `string`. Default `'ui'` on capture if absent. Common values today: `'ui'`, `'hermes'`, `'cli'`. Structured `{ kind, sessionId }` deferred until a real correlation-ID need exists.
- **State filter** — `GET /api/state?createdBy=hermes` filters tasks; agents always returned in full. No filter on events (Hermes can join client-side from `task.createdBy`).
- **Event-stream filters** — support `?taskId=<id>` (cheap, narrow streams are an obvious need); skip `?createdBy=` for now.
- **Auth boundary** — unchanged. `127.0.0.1` only, single trusted user. Hermes runs in the same trust domain. *(Reaffirms panel #2 trap: no auth/CORS/multi-user yet.)*
- **Connection cap** — none initially. Log a warning at >32 concurrent SSE clients so we notice if Hermes leaks subscriptions.
- **Heartbeat** — SSE comment `:keepalive\n\n` every 15s. Keeps proxies and lazy file-watchers from killing idle streams.

---

## Plan

### Phase 12.1 — Attribution (`createdBy`)

Smallest, unblocks the others. Pure additive change — no behavior shifts.

- **12.1.1** Add `createdBy?: string` to `Task` in `src/types.ts`. Default in `captureTask` mutator: `'ui'`.
- **12.1.2** `POST /api/capture` accepts `createdBy` in body; persist to `tasks/<id>.json`. The capture palette continues to omit it (defaults to `'ui'` server-side).
- **12.1.3** `GET /api/state?createdBy=<value>` filters the `tasks[]` array; `agents[]` unchanged.
- **12.1.4** UI: render a small chip on cards when `createdBy && createdBy !== 'ui'`. One-line addition in `BackgroundedRow` / `ChatCard` near the title.
- **12.1.5** Update `tools/protocol.md` — document the field on the task record and the `?createdBy=` query.
- **12.1.6** Tests: extend `types.test.ts` to round-trip `createdBy`; add a `console-server` smoke test that capture → state-filter works.

### Phase 12.2 — Per-entity reads

Pure read endpoints. No concurrency story, no new state.

- **12.2.1** `GET /api/tasks/:id` → `tasks/<id>.json` content or `404`.
- **12.2.2** `GET /api/tasks/:id/messages` → parsed array from `messages/<id>.jsonl` (one JSON object per line). Empty array if file missing.
- **12.2.3** `GET /api/runs/:id` → `runs/<id>.json` content or `404`.
- **12.2.4** Update `tools/protocol.md`.
- **12.2.5** Tests: 404 on missing IDs; happy-path round-trip for each.

### Phase 12.3 — Event stream (SSE)

The largest piece. Build deliberately — every implementation choice here is throwaway after Phase 11.2 (SQLite) but a partial-line tail bug now will eat hours.

- **12.3.1** Add `tools/event-tailer.mjs`: a single shared file watcher that owns `events.jsonl`, maintains a sticky byte offset, buffers partial lines, parses complete events, and emits to subscribers. Test in isolation against a fixture file with chunked appends.
- **12.3.2** `GET /api/events` handler in `console-server.mjs`:
  - Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`.
  - Resolve resume point: `Last-Event-ID` header > `?since=` query > `0`.
  - Catchup: stream events from `readAllEvents()` with `seq > resumePoint`, emit each.
  - Tail: subscribe to the shared tailer, emit each new event.
  - Optional `?taskId=<id>` filters both phases by `event.taskId === id`.
  - Heartbeat: `:keepalive\n\n` every 15s.
  - On `req.close`, unsubscribe from the tailer.
- **12.3.3** Connection logging: track active subscriber count; warn-log at >32.
- **12.3.4** Update `tools/protocol.md` with full SSE contract (headers, framing, resume, filters).
- **12.3.5** Tests:
  - Unit: tailer correctly handles partial lines split across writes.
  - Integration: capture → subscribe with `since=0` → assert the captured events appear; reconnect with last seq → assert no duplicates.

---

## Order and rationale

**12.1 → 12.2 → 12.3.**

12.1 is two-day-fingertip work and unblocks the chip in the UI plus the `?createdBy=` filter that makes the snapshot endpoint useful for Hermes today (it can keep polling cheap-ish until 12.3 lands). 12.2 is independent and trivial. 12.3 is the structural piece and benefits from `?createdBy=` already existing if we ever decide to add it to the event filter.

---

## Out of scope (defer)

- **`POST /api/events` / write side** — Hermes is a client, not an event author. Adapters are the only writers.
- **`createdBy` filter on events** — wait for evidence Hermes actually wants it. Client-side join works fine for the projected scale.
- **Structured `createdBy: { kind, sessionId, ... }`** — free-form string until correlation IDs become real.
- **Multi-tenant / auth on the API** — still single-user, localhost-only. Tauri shell (Phase 11) is the next time auth is on the table.
- **WebSocket / bidirectional protocol** — SSE is one-way and that's all Hermes needs. WebSockets buy nothing here and add framing complexity.
- **Push to external systems (Slack, Linear, etc.)** — Hermes can do that on top of the SSE feed.

## Reviewer-flagged traps to respect

- **Don't pre-engineer for SQLite.** The SSE-from-tail mechanism is interim by design. Phase 11.2 will replace the tailer with a SQL `seq > ?` query + LISTEN/NOTIFY (or just 1Hz polling on a primary key, which is fine when there's an index). Keep `event-tailer.mjs` small and self-contained so deletion is one PR.
- **Don't fall into partial-line bugs.** `appendFileSync` is line-atomic at the OS level, but `fs.watch` can fire mid-write to a slow disk. The tailer must only emit on `\n`. Test this explicitly.
- **Don't add per-client rate limiting yet.** localhost, trusted client. If Hermes leaks subscriptions, the warn-log at >32 is the canary.
- **Don't migrate existing `tasks/*.json` to backfill `createdBy`.** Absent field reads as `'ui'` everywhere; backfill is unnecessary churn.

---

## Definition of done

- Hermes can capture a task tagged `createdBy: 'hermes'`, drive it through state transitions, observe state via `/api/state?createdBy=hermes`, fetch individual tasks/runs/messages by ID, and subscribe to a live event stream with resume semantics.
- UI shows a chip on Hermes-originated tasks.
- `tools/protocol.md` documents every new endpoint, field, and the SSE contract.
- Vitest suite still green; new tests cover tailer partial-line handling and SSE catchup-then-tail.
