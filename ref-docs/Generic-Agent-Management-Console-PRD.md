# Generic Agent Management Console — Product Spec v1

**Date:** April 27, 2026  
**Author:** Nic Zinner + ChatGPT  
**Status:** Draft — ready for engineering handoff  

---

## What This Is

A desktop management console for coordinating, observing, and auditing AI agent work during a normal workday. It is not tied to an AI news pipeline, cron-heavy editorial system, or a single automation stack. It is a general-purpose command center for assigning tasks to agents, seeing what is currently happening, reviewing outputs, catching failures, and keeping a reliable record of work performed.

**One sentence:** Assign work to agents, track what they are doing, review what they produced, and know when something needs human attention.

---

## Target User

A technical operator, engineer, product lead, founder, or power user who works with multiple AI agents throughout the day. They may use agents for software development, research, documentation, testing, deployment support, analysis, ticket grooming, meeting follow-ups, or operational chores.

The user does not want to manage every agent through isolated chat windows, scattered terminal sessions, local logs, and ad hoc notes. They need one place to understand the current state of delegated work.

### Primary Pain Points

- Too many agent tasks are spread across chat sessions, terminals, IDEs, issue trackers, and local files.
- It is hard to know which tasks are running, blocked, completed, failed, or waiting for review.
- Agent outputs are easy to lose, especially when work spans multiple sessions or tools.
- The user cannot easily verify whether agents actually did what they claimed.
- Workday context gets fragmented: priorities shift, tasks get interrupted, and follow-ups fall through the cracks.
- Agent cost, runtime, tool usage, and error rates are hard to track across the day.
- There is no reliable audit trail connecting task assignment → agent actions → files changed → tests run → final result.

---

## Product Positioning

This is a **management console for delegated AI work**, not a replacement for chat, IDEs, source control, or project management tools.

It sits above individual agent sessions and provides:

- A live status board for all active and recent tasks
- A task queue for work assigned throughout the day
- A review inbox for completed outputs needing human judgment
- Deterministic validation checks for claims and deliverables
- A timeline/audit trail of agent activity
- Cost, runtime, and reliability telemetry
- Optional graph view for relationships among tasks, agents, tools, repos, files, and services

---

## Core Concepts

### Task

A unit of work assigned by the user or created by another task. Examples:

- “Investigate failing CI test in repo X.”
- “Summarize this design document and identify open questions.”
- “Draft implementation plan for feature Y.”
- “Refactor this module and run tests.”
- “Search for recent papers on constellation scheduling.”
- “Update the project README based on the latest CLI behavior.”

### Agent

An AI worker or session capable of performing a task. Agents may differ by model, tool access, role, runtime environment, or specialization.

Examples:

- Coding agent
- Research agent
- Documentation agent
- Test agent
- Review agent
- Ops agent
- General assistant

### Run

A single execution attempt of a task by an agent. A task may have multiple runs if retried, resumed, reassigned, or split.

### Artifact

Any output produced by an agent:

- Markdown file
- Code diff
- Test report
- Research notes
- Issue comment
- Pull request
- Log file
- Structured JSON result
- Screenshot
- Deployment note

### Review

A human checkpoint where the user accepts, rejects, edits, reroutes, or requests follow-up work.

### Contract

A deterministic validation rule used to verify whether an agent’s claim or deliverable satisfies expected conditions.

Examples:

- “Tests passed.”
- “A file was created.”
- “PR exists.”
- “No files outside allowed paths were modified.”
- “Output includes required sections.”
- “Build command exited with code 0.”

---

## V1 Scope

### 1. Workday Task Board

The primary view is a grouped board showing all agent-managed work.

#### Sections

- **Inbox / Unassigned** — tasks captured but not yet assigned to an agent
- **Queued** — assigned but not yet started
- **Running** — active agent work
- **Blocked** — waiting on user input, missing credentials, failed dependency, or external condition
- **Review Needed** — completed work requiring human approval
- **Done Today** — accepted or closed tasks from the current day
- **Failed / Attention** — failed runs, validation failures, timeouts, or suspicious results

#### Each Task Card Shows

- Task title
- Task type: coding, research, docs, review, ops, analysis, other
- Assigned agent
- Status
- Priority
- Start time / last update time
- Runtime duration
- Cost estimate
- Artifact count
- Validation status: verified, partially verified, unverifiable, failed
- Linked repo/project, if applicable
- Human review state, if applicable

#### Interactions

- Create new task
- Assign task to agent
- Reassign task
- Pause/cancel task
- Mark blocked
- Add note/context
- Attach files or links
- Open detail panel
- Filter by agent, project, status, priority, task type, or validation status
- Search task titles, notes, artifacts, and logs
- Sort by last update, priority, runtime, cost, status, or agent

---

### 2. Task Detail Panel

Clicking any task opens a detail panel.

#### Detail Panel Sections

**Summary**

- Task title
- Current status
- Assigned agent
- Objective
- Priority
- Created time
- Last updated time
- Parent/child task relationships

**Prompt / Assignment**

- Original task instructions
- Additional context added later
- Files, links, tickets, issues, or repo paths attached to the task

**Activity Timeline**

- Task created
- Agent assigned
- Agent started
- Tool calls or major milestones
- Files read/written
- Tests run
- Validation checks executed
- Agent completion message
- Human review actions

**Artifacts**

- Files created or modified
- Summaries
- Diffs
- Logs
- Reports
- Links to PRs, issues, documents, or generated files

**Validation**

- Contract checks
- Pass/fail/unverified status
- Evidence for each check
- Timestamp of validation

**Cost & Runtime**

- Tokens used, if available
- Cost estimate
- Wall-clock runtime
- Model/provider used
- Tool usage summary

**Review Actions**

- Accept
- Reject
- Request changes
- Spawn follow-up task
- Reassign to another agent
- Archive

---

### 3. Task Creation and Assignment

V1 should support quick creation of tasks throughout the workday.

#### Task Creation Inputs

- Title
- Description / instructions
- Priority: low, normal, high, urgent
- Task type: coding, research, docs, testing, review, ops, analysis, other
- Project/repo
- Desired agent or auto-select
- Attachments or links
- Acceptance criteria
- Due time or soft target time
- Review required: yes/no

#### Fast Capture

The console should support a fast “capture now, refine later” mode:

- User enters a rough task in one line
- Task lands in Inbox / Unassigned
- User can later add context, attach files, or assign an agent

#### Agent Assignment Modes

- **Manual assignment** — user selects an agent
- **Default assignment** — task type maps to default agent
- **Suggested assignment** — console recommends an agent based on task type, repo, or prior reliability
- **Split assignment** — user creates subtasks for different agents

V1 can implement manual and default assignment first. Suggested assignment can be a later enhancement.

---

### 4. Review Inbox

A dedicated view for completed work that needs human attention.

#### Shows

- Completed tasks awaiting review
- Agent summary
- Deliverables/artifacts
- Validation status
- Claimed completion criteria
- Detected risks or missing evidence
- Cost/runtime

#### Review Actions

- Accept and close
- Accept with notes
- Request changes
- Send to reviewer agent
- Reopen task
- Create follow-up task
- Escalate to manual work

#### Review Design Principle

The console should not make “completed” feel the same as “accepted.”

Agent status and human decision status are separate:

- Agent says done
- Validation says pass/fail/unverified
- Human says accepted/rejected/needs changes

---

### 5. Contract Validation

The console validates agent claims using deterministic checks. It should avoid LLM-as-judge for V1 core correctness.

#### V1 Contract Types

**Command exit check**

- Verify command exited with expected code
- Example: `pnpm test` exited 0

**File existence check**

- Verify expected artifact exists
- Example: `docs/implementation-plan.md` was created

**File modification check**

- Verify expected files changed
- Verify forbidden paths were not changed

**Content structure check**

- Required headings present
- Required fields present in JSON/YAML
- Minimum/maximum length
- Required links included

**Test result check**

- Parse test output
- Count passed/failed/skipped tests
- Verify no failing tests

**Git diff check**

- Show modified files
- Detect large or unexpected diff
- Detect changes outside allowed paths

**Timestamp recency check**

- Verify artifact, commit, report, or output was produced after task start

**HTTP/API check**

- Verify endpoint returned expected status or response field

#### Example Contract YAML

```yaml
contracts:
  implementation-task:
    applies_to: task_type:coding
    assertions:
      - type: command_exit
        command: pnpm test
        expect_exit_code: 0
      - type: file_modified
        allowed_paths:
          - src/**
          - tests/**
        forbidden_paths:
          - .env
          - package-lock.json
      - type: content_structure
        file: task-summary.md
        required_headings:
          - Summary
          - Files Changed
          - Tests Run
          - Risks
    on_failure: require_review

  research-task:
    applies_to: task_type:research
    assertions:
      - type: file_exists
        path: research-notes.md
      - type: content_structure
        file: research-notes.md
        required_headings:
          - Key Findings
          - Sources
          - Open Questions
      - type: min_links
        file: research-notes.md
        expect_at_least: 3
    on_failure: mark_unverified
```

#### Validation Status

- **Verified** — all required checks passed
- **Partially verified** — some checks passed, some could not be evaluated
- **Unverified** — insufficient evidence
- **Failed** — one or more required checks failed

#### Important Boundary

Validation is observability and review support. V1 does not need to block agent execution in real time. It should surface evidence and make blind spots obvious.

---

### 6. Agent Registry

The console maintains a registry of available agents.

#### Agent Fields

- Agent name
- Agent type/role
- Model/provider
- Tool access
- Working directory or project scope
- Default task types
- Current status: available, busy, offline, degraded
- Active task count
- Recent success/failure rate
- Average runtime
- Average cost
- Last heartbeat

#### Agent Detail View

- Active task
- Recent tasks
- Failure history
- Cost history
- Tool usage
- Known limitations
- Configuration notes

#### V1 Agent States

- Available
- Busy
- Waiting for input
- Offline
- Error
- Unknown

---

### 7. Activity Timeline

A chronological timeline of work across all agents.

#### Timeline Events

- Task created
- Task assigned
- Agent started
- Agent emitted progress update
- Tool call or command execution recorded
- Artifact created
- File modified
- Test run completed
- Contract evaluated
- Agent completed
- Review requested
- User accepted/rejected/requested changes
- Task closed

#### Timeline Filters

- Agent
- Task
- Project
- Event type
- Status
- Date/time range
- Errors only

---

### 8. Graph View

An alternate visualization showing relationships between agents, tasks, artifacts, repositories, and external services.

#### Nodes

- TaskNode
- AgentNode
- ArtifactNode
- RepoNode
- ServiceNode
- HumanReviewNode

#### Edges

- assigned_to
- spawned
- produced
- modified
- depends_on
- reviewed_by
- validated_by
- failed_at

#### Graph Behaviors

- Layout using dagre or equivalent directed graph layout
- Group by project or task lineage
- Collapse completed tasks by default
- Highlight failed or blocked paths
- Click node to open detail panel
- Edge color reflects validation or status

#### Not in V1

- Manual node positioning
- Full freeform canvas editor
- Force-directed graph
- Workflow builder

---

### 9. Workday Digest

A view designed for mid-day and end-of-day review.

#### Default Time Windows

- Since start of day
- Last 4 hours
- Yesterday
- Custom range

#### Shows

- Tasks created
- Tasks completed
- Tasks accepted by user
- Tasks waiting for review
- Failed/blocked tasks
- Most expensive tasks
- Longest-running tasks
- Agents with errors or degraded reliability
- Artifacts produced
- Open follow-ups

#### Example Summary

- 18 tasks created today
- 9 completed by agents
- 5 accepted
- 3 waiting for review
- 2 failed validation
- 1 blocked on missing repo credentials
- Total estimated spend: $14.82

---

### 10. Cost and Resource Tracking

A sidebar or dedicated dashboard tracks cost and runtime.

#### Metrics

- Total spend today
- Spend by agent
- Spend by model/provider
- Spend by project
- Cost per completed task
- Cost per accepted task
- Top expensive tasks
- Token usage, if available
- Runtime by agent
- Error rate by agent

#### Design Principle

Cost should be tied to useful outcomes where possible. “Agent spent $3.20” is less useful than “Agent spent $3.20 on a task that failed validation and still needs review.”

---

### 11. Notifications

Desktop notifications and tray status should surface only important state changes.

#### Notifications

- Task completed and needs review
- Task failed
- Contract validation failed
- Agent blocked and needs input
- Agent went offline
- Long-running task exceeded threshold
- Daily digest ready

#### Tray Status

- Green: no urgent issues
- Yellow: review needed or blocked task
- Red: failed task, validation failure, or agent error
- Gray: disconnected from agent runtime

Right-click tray actions:

- Open console
- Create task
- Show review inbox
- Show workday digest
- Pause notifications
- Quit

---

## What It Does Not Do

- Replace the chat interface
- Replace the IDE
- Replace GitHub/Jira/Linear/Notion
- Automatically trust agent claims
- Act as a full workflow builder in V1
- Guarantee that agents are correct
- Require every task to be fully automated
- Require all work to come from scheduled jobs
- Record activity while the console is closed, unless the underlying agent runtime persists events elsewhere

---

## Architecture

### Proposed Stack

```text
Tauri v2 desktop shell
├── React + TypeScript frontend
│   ├── Task board
│   ├── Review inbox
│   ├── Task detail panels
│   ├── Agent registry
│   ├── Timeline view
│   ├── Graph view
│   └── Cost/resource dashboard
├── State management
│   ├── Zustand or equivalent frontend store
│   └── Query/cache layer for persisted data
├── Visualization
│   ├── React Flow / xyflow for graph view
│   ├── dagre for auto-layout
│   └── Recharts for cost/runtime charts
├── Tauri backend
│   ├── SQLite event store
│   ├── Native notifications
│   ├── System tray
│   ├── File watching
│   ├── Local command execution wrappers, where safe
│   └── Optional local agent runtime adapters
└── Integrations
    ├── Agent runtime event streams
    ├── Local filesystem watchers
    ├── Git repositories
    ├── Test/build command outputs
    ├── Issue tracker APIs, optional
    └── Model/provider usage APIs, optional
```

### Architecture Principle

Normalize every source into a small set of internal event types. The console should not care whether work came from a CLI agent, chat agent, IDE plugin, cron job, local script, or remote API.

---

## Data Model

### Normalized Event Type

```typescript
type ConsoleEvent = {
  id: string;
  timestamp: number;
  source: 'agent_runtime' | 'filesystem' | 'git' | 'command' | 'api' | 'user' | 'validator';
  type:
    | 'task_created'
    | 'task_updated'
    | 'task_assigned'
    | 'task_started'
    | 'task_blocked'
    | 'task_completed'
    | 'task_failed'
    | 'artifact_created'
    | 'artifact_modified'
    | 'validation_result'
    | 'review_action'
    | 'cost_event'
    | 'agent_heartbeat'
    | 'alert';
  taskId?: string;
  agentId?: string;
  projectId?: string;
  payload: Record<string, unknown>;
};
```

### Task Status

```typescript
type TaskStatus =
  | 'inbox'
  | 'queued'
  | 'running'
  | 'blocked'
  | 'review_needed'
  | 'accepted'
  | 'rejected'
  | 'failed'
  | 'cancelled'
  | 'archived';
```

### Validation Status

```typescript
type ValidationStatus =
  | 'not_applicable'
  | 'pending'
  | 'verified'
  | 'partially_verified'
  | 'unverified'
  | 'failed';
```

---

## SQLite Schema

```sql
PRAGMA journal_mode = WAL;
PRAGMA auto_vacuum = INCREMENTAL;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT,
  priority TEXT DEFAULT 'normal',
  status TEXT NOT NULL,
  project_id TEXT,
  assigned_agent_id TEXT,
  parent_task_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  review_required INTEGER DEFAULT 1,
  review_status TEXT DEFAULT 'not_ready',
  validation_status TEXT DEFAULT 'pending',
  metadata TEXT
);

CREATE INDEX idx_tasks_status ON tasks(status, updated_at DESC);
CREATE INDEX idx_tasks_agent ON tasks(assigned_agent_id, updated_at DESC);
CREATE INDEX idx_tasks_project ON tasks(project_id, updated_at DESC);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,
  model TEXT,
  provider TEXT,
  status TEXT NOT NULL,
  tool_access TEXT,
  default_task_types TEXT,
  last_heartbeat_at TEXT,
  metadata TEXT
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  model TEXT,
  provider TEXT,
  total_tokens INTEGER DEFAULT 0,
  total_cost_usd REAL DEFAULT 0,
  summary TEXT,
  error TEXT,
  metadata TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE INDEX idx_runs_task ON runs(task_id, started_at DESC);
CREATE INDEX idx_runs_agent ON runs(agent_id, started_at DESC);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,
  artifact_type TEXT NOT NULL,
  title TEXT,
  path TEXT,
  uri TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  metadata TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id),
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE INDEX idx_artifacts_task ON artifacts(task_id, created_at DESC);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  source TEXT NOT NULL,
  event_type TEXT NOT NULL,
  task_id TEXT,
  agent_id TEXT,
  run_id TEXT,
  project_id TEXT,
  payload TEXT NOT NULL
);

CREATE INDEX idx_events_time ON events(timestamp DESC);
CREATE INDEX idx_events_task ON events(task_id, timestamp DESC);
CREATE INDEX idx_events_agent ON events(agent_id, timestamp DESC);

CREATE TABLE validation_results (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  run_id TEXT,
  contract_id TEXT,
  timestamp TEXT NOT NULL,
  status TEXT NOT NULL,
  assertions_total INTEGER,
  assertions_passed INTEGER,
  assertions_failed INTEGER,
  assertions_unverified INTEGER,
  details TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id),
  FOREIGN KEY(run_id) REFERENCES runs(id)
);

CREATE INDEX idx_validation_task ON validation_results(task_id, timestamp DESC);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  reviewer TEXT,
  action TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);

CREATE INDEX idx_reviews_task ON reviews(task_id, created_at DESC);

CREATE TABLE cost_events (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  agent_id TEXT,
  model TEXT,
  provider TEXT,
  tokens INTEGER,
  cost_usd REAL,
  metadata TEXT
);

CREATE INDEX idx_cost_time ON cost_events(timestamp DESC);
CREATE INDEX idx_cost_task ON cost_events(task_id, timestamp DESC);
CREATE INDEX idx_cost_agent ON cost_events(agent_id, timestamp DESC);
```

### Retention Policy

```sql
DELETE FROM events WHERE timestamp < datetime('now', '-90 days');
DELETE FROM cost_events WHERE timestamp < datetime('now', '-180 days');
DELETE FROM validation_results WHERE timestamp < datetime('now', '-180 days');
```

Tasks, runs, artifacts, and reviews should be retained unless explicitly archived or deleted by the user.

---

## Integration Adapters

The console should use adapters so it can work with different agent systems over time.

### Agent Runtime Adapter Interface

```typescript
type AgentRuntimeAdapter = {
  id: string;
  name: string;
  listAgents(): Promise<Agent[]>;
  startTask(task: Task): Promise<Run>;
  cancelRun(runId: string): Promise<void>;
  streamEvents(callback: (event: ConsoleEvent) => void): Promise<void>;
  getRunLogs(runId: string): Promise<string>;
  getArtifacts(taskId: string): Promise<Artifact[]>;
};
```

### V1 Adapter Options

The first implementation can support one local adapter and one file-based adapter:

- **Local CLI adapter** — starts or tracks agent jobs launched from local commands
- **Filesystem adapter** — watches a task/results directory for status files, logs, artifacts, and completion reports

Later adapters can support specific tools or runtimes.

---

## Suggested V1 File-Based Protocol

To make the console easy to integrate with any agent runtime, define a simple local directory protocol.

```text
.agent-console/
├── tasks/
│   ├── task-001.json
│   └── task-002.json
├── runs/
│   ├── run-001.json
│   └── run-002.json
├── artifacts/
│   └── task-001/
│       ├── summary.md
│       ├── diff.patch
│       └── test-results.json
├── logs/
│   └── run-001.log
└── events.jsonl
```

### Task JSON

```json
{
  "id": "task-001",
  "title": "Investigate failing CI test",
  "description": "Find root cause and propose fix.",
  "task_type": "coding",
  "priority": "high",
  "status": "queued",
  "assigned_agent_id": "coding-agent",
  "project_id": "mission-sim",
  "created_at": "2026-04-27T09:12:00Z",
  "review_required": true,
  "acceptance_criteria": [
    "Root cause identified",
    "Fix proposed or implemented",
    "Relevant tests run",
    "Risks documented"
  ]
}
```

### Run JSON

```json
{
  "id": "run-001",
  "task_id": "task-001",
  "agent_id": "coding-agent",
  "status": "running",
  "started_at": "2026-04-27T09:15:00Z",
  "model": "example-model",
  "provider": "example-provider",
  "total_tokens": 12000,
  "total_cost_usd": 0.82
}
```

### Event JSONL

```jsonl
{"timestamp":"2026-04-27T09:15:00Z","type":"task_started","task_id":"task-001","agent_id":"coding-agent"}
{"timestamp":"2026-04-27T09:22:00Z","type":"artifact_created","task_id":"task-001","path":"artifacts/task-001/summary.md"}
{"timestamp":"2026-04-27T09:27:00Z","type":"validation_result","task_id":"task-001","status":"partially_verified"}
```

This protocol lets the console become useful before deeper runtime integration exists.

---

## Build Phases

### Phase 1: Core Task Console

- Tauri desktop shell
- SQLite database
- Task board
- Task creation form
- Manual agent registry
- Task detail panel
- Basic file-based adapter
- Activity timeline
- Review inbox
- System tray and notifications

**Definition of done:** User can create tasks during the day, assign them to agents, track status, see artifacts, and review completed work.

### Phase 2: Validation and Cost Tracking

- Contract YAML support
- Validation runner
- Validation status indicators
- Cost event ingestion
- Cost sidebar/dashboard
- Workday digest
- Git diff awareness
- Test result parsing

**Definition of done:** User can distinguish claimed completion from verified completion, and can see spend/runtime by task and agent.

### Phase 3: Graph View and Better Agent Runtime Integration

- Graph view
- Parent/child task lineage
- Runtime adapter interface
- CLI adapter
- Agent heartbeat tracking
- Better cancellation/pause/resume semantics
- Per-agent reliability stats

**Definition of done:** User can understand how tasks, agents, artifacts, and projects relate across a workday.

### Phase 4: Workflow and Team Features

- Saved task templates
- Recurring task templates
- Suggested agent assignment
- Multi-user review support
- Issue tracker integration
- Pull request integration
- Calendar/day-plan integration
- Historical analytics

---

## Testing Strategy

### Tier 1 — Ship-Blocking Unit Tests

**Task state machine**

- Valid status transitions
- Invalid transition rejection
- Review status separate from task status
- Retry and rerun behavior

**Validation logic**

- Each contract type in isolation
- Missing evidence handling
- Partial verification behavior
- Failed assertions

**Cost aggregation**

- Per-task cost
- Per-agent cost
- Daily cost
- Cost per accepted task

### Tier 2 — Integration Tests

- SQLite read/write roundtrips
- File-based protocol parsing
- Event ingestion from JSONL
- Artifact indexing
- Validation result persistence

### Tier 3 — Manual / Prototype QA

- System tray
- Notifications
- Graph layout
- Native file watching edge cases
- Long-running task UX

---

## UX Principles

1. **Make state obvious.** The user should instantly know what is running, blocked, done, failed, or waiting for them.
2. **Separate agent claims from verified evidence.** “Done” is not the same as “verified” or “accepted.”
3. **Optimize for interruption.** The console should survive a chaotic workday where priorities change constantly.
4. **Keep review lightweight.** The user should be able to accept, reject, or request changes quickly.
5. **Surface blind spots.** Missing logs, missing artifacts, disconnected agents, and unverifiable claims should be explicit.
6. **Avoid workflow-builder bloat in V1.** Start with task tracking, status, review, validation, and audit trail.

---

## Known Risks & Mitigations

| Risk | Likelihood | Mitigation |
|---|---:|---|
| Scope expands into a full project management app | High | Keep V1 centered on agent-executed tasks, not general human task management |
| Different agent runtimes expose inconsistent data | High | Normalize through adapter interface and file-based protocol |
| Agent claims are misleading | High | Separate claimed completion, validation, and human acceptance |
| Too many notifications | Medium | Notify only on review, failure, blocking, or long-running thresholds |
| Graph view becomes cluttered | Medium | Keep task board primary; graph is alternate view |
| Validation checks create false confidence | Medium | Label unverifiable states clearly; show evidence for every check |
| Cost data is incomplete | Medium | Treat cost as estimated unless sourced directly from provider/runtime |

---

## Open Questions

1. Which agent runtime should be supported first?
2. Should the console launch agent tasks itself, or only observe tasks launched elsewhere in V1?
3. What is the minimum useful task file protocol for interoperability?
4. Should coding tasks integrate with Git directly in V1, or should Git awareness wait until Phase 2?
5. What projects/repos should be selectable in the first version?
6. Should review decisions write back to a task file, issue tracker, or only local SQLite?
7. Should the app support remote agents, or only local agents initially?
8. What level of command execution is acceptable from the console for safety?

---

## MVP Definition

The MVP is successful if the user can:

1. Capture tasks throughout a workday.
2. Assign tasks to one or more agents.
3. See all active, blocked, failed, and review-needed work in one place.
4. Open a task and inspect its prompt, activity, logs, artifacts, cost, and validation status.
5. Accept, reject, or request changes on completed work.
6. Review an end-of-day digest of what agents did.
7. Trust that unverifiable or failed work is clearly marked, not hidden.

