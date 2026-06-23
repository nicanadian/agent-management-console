import type { Task, Agent, Attachment, ProjectInfo } from '../types';
import type {
  CaptureInput,
  RegisterProjectInput,
  Repository,
  RepositoryListener,
  RepositorySnapshot,
  SendMessageMode,
} from './repository';

// Reads task/run/event state from `.agent-console/` (written by
// tools/claude-shim.mjs) via tools/console-server.mjs. Polls /api/state
// every 1s; future: SSE or fs.watch.
//
// All write paths POST to console-server endpoints:
//   captureTask  → /api/capture                creates task + spawns daemon
//   sendMessage  → /api/messages               queues + ensures daemon alive
//   assignTask   → /api/tasks/<id>/assign      sets agentId, queued
//   acceptTask   → /api/tasks/<id>/accept      reviewStatus=accepted
//   rejectTask   → /api/tasks/<id>/reject      back to queued, needs_changes
//   stopRun      → /api/tasks/<id>/stop        SIGINT to daemon
//   cancelRun    → /api/tasks/<id>/cancel      SIGTERM to daemon

const POLL_INTERVAL_MS = 1000;

export class FileSystemRepository implements Repository {
  private listeners: Set<RepositoryListener> = new Set();
  private cache: RepositorySnapshot = { tasks: [], agents: [] };
  private cacheKey = '';
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor() {
    this.refresh();
    this.pollTimer = setInterval(() => this.refresh(), POLL_INTERVAL_MS);
  }

  subscribe(listener: RepositoryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async listTasks(): Promise<Task[]> {
    return [...this.cache.tasks];
  }

  async listAgents(): Promise<Agent[]> {
    return [...this.cache.agents];
  }

  async getTask(id: string): Promise<Task | undefined> {
    return this.cache.tasks.find((t) => t.id === id);
  }

  async captureTask(input: CaptureInput): Promise<Task> {
    const res = await fetch('/api/capture', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: input.title,
        prompt: input.title,
        agentId: input.agentId,
        project: input.project,
        priority: input.priority,
        attachments: input.attachments,
        createdBy: input.createdBy,
      }),
    });
    if (!res.ok) {
      throw new Error(`captureTask failed: ${res.status} ${res.statusText}`);
    }
    const task = (await res.json()) as Task;
    this.refresh();
    return task;
  }

  // Phase 13 — the server stores projects as a { name: {repoPath, …} }
  // map; the UI works in arrays, so normalize on the way out.
  async listProjects(): Promise<ProjectInfo[]> {
    const res = await fetch('/api/projects');
    if (!res.ok) return [];
    const map = (await res.json()) as Record<
      string,
      { repoPath: string; defaultBranch?: string }
    >;
    return Object.entries(map).map(([name, v]) => ({ name, ...v }));
  }

  async registerProject(input: RegisterProjectInput): Promise<ProjectInfo> {
    const res = await fetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Surface the server's reason (e.g. "<path> is not a git work tree")
      // so the panel can show it inline.
      throw new Error(body.error || `register failed: ${res.status}`);
    }
    return body as ProjectInfo;
  }

  async assignTask(id: string, agentId: string): Promise<Task | undefined> {
    return this.postState(id, 'assign', { agentId });
  }

  async acceptTask(id: string): Promise<Task | undefined> {
    return this.postState(id, 'accept');
  }

  async rejectTask(id: string): Promise<Task | undefined> {
    return this.postState(id, 'reject');
  }

  async sendMessage(
    id: string,
    text: string,
    mode: SendMessageMode,
    attachments?: Attachment[]
  ): Promise<Task | undefined> {
    await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: id, text, mode, attachments }),
    });
    return undefined;
  }

  private async postState(
    id: string,
    action: 'assign' | 'accept' | 'reject' | 'archive',
    body: Record<string, unknown> = {}
  ): Promise<Task | undefined> {
    const res = await fetch(
      `/api/tasks/${encodeURIComponent(id)}/${action}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    if (!res.ok) {
      throw new Error(`${action} failed: ${res.status} ${res.statusText}`);
    }
    const task = (await res.json()) as Task;
    this.refresh();
    return task;
  }

  async stopRun(id: string): Promise<void> {
    await fetch(`/api/tasks/${encodeURIComponent(id)}/stop`, { method: 'POST' });
    this.refresh();
  }

  async cancelRun(id: string): Promise<void> {
    await fetch(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    });
    this.refresh();
  }

  async archiveTask(id: string): Promise<Task | undefined> {
    return this.postState(id, 'archive');
  }

  // --- internals ---

  private async refresh(): Promise<void> {
    try {
      const res = await fetch('/api/state');
      if (!res.ok) return;
      const next = (await res.json()) as RepositorySnapshot;
      const key = JSON.stringify(next);
      if (key === this.cacheKey) return;
      this.cache = next;
      this.cacheKey = key;
      for (const l of this.listeners) l(next);
    } catch {
      // Network blip — keep last-known cache, try again next tick.
    }
  }
}
