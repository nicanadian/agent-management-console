import type { Task, Agent, Message, Attachment } from '../../types';
import { taskBucket } from '../../types';
import type {
  CaptureInput,
  Repository,
  RepositoryListener,
  RepositorySnapshot,
  SendMessageMode,
} from '../repository';

// In-memory backing for the prototype. The eventual SQLite-backed and
// file-system-backed repositories implement the same `Repository` interface
// so this class can be swapped without UI changes.
export class InMemoryRepository implements Repository {
  private tasks: Task[];
  private agents: Agent[];
  private listeners: Set<RepositoryListener> = new Set();

  constructor(seed?: { tasks?: Task[]; agents?: Agent[] }) {
    this.tasks = seed?.tasks ? [...seed.tasks] : [];
    this.agents = seed?.agents ? [...seed.agents] : [];
  }

  subscribe(listener: RepositoryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const snapshot: RepositorySnapshot = {
      tasks: [...this.tasks],
      agents: [...this.agents],
    };
    for (const l of this.listeners) l(snapshot);
  }

  async listTasks(): Promise<Task[]> {
    return [...this.tasks];
  }

  async listAgents(): Promise<Agent[]> {
    return [...this.agents];
  }

  async getTask(id: string): Promise<Task | undefined> {
    return this.tasks.find((t) => t.id === id);
  }

  async captureTask(input: CaptureInput): Promise<Task> {
    const now = new Date().toISOString();
    const ts = new Date().toTimeString().slice(0, 8);
    const messages: Message[] | undefined = input.attachments?.length
      ? [
          {
            from: 'user',
            text: '',
            timestamp: ts,
            attachments: input.attachments,
          },
        ]
      : undefined;
    const task: Task = {
      id: `t${Date.now()}`,
      title: input.title,
      type: 'analysis',
      priority: input.priority ?? 'normal',
      project: input.project,
      agentId: input.agentId,
      lifecycleStatus: input.agentId ? 'queued' : 'inbox',
      claimedStatus: 'none',
      validationStatus: 'not_applicable',
      reviewStatus: input.agentId ? 'pending' : 'not_required',
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy ?? 'ui',
      messages,
    };
    this.tasks = [task, ...this.tasks];
    this.notify();
    return task;
  }

  async assignTask(id: string, agentId: string): Promise<Task | undefined> {
    return this.update(id, (t) => ({
      ...t,
      agentId,
      lifecycleStatus: 'queued',
      reviewStatus: 'pending',
    }));
  }

  async acceptTask(id: string): Promise<Task | undefined> {
    return this.update(id, (t) => ({
      ...t,
      reviewStatus: 'accepted',
      waitingOnUser: false,
      archivedAt: new Date().toISOString(),
    }));
  }

  async rejectTask(id: string): Promise<Task | undefined> {
    return this.update(id, (t) => ({
      ...t,
      lifecycleStatus: 'queued',
      claimedStatus: 'none',
      validationStatus: 'not_applicable',
      reviewStatus: 'needs_changes',
      waitingOnUser: false,
    }));
  }

  async sendMessage(
    id: string,
    text: string,
    mode: SendMessageMode,
    attachments?: Attachment[]
  ): Promise<Task | undefined> {
    const now = new Date();
    const ts = now.toTimeString().slice(0, 8);

    return this.update(id, (t) => {
      const isRunning = t.lifecycleStatus === 'running';
      const shouldQueue =
        mode === 'queue' || (mode === 'auto' && isRunning && !t.waitingOnUser);

      if (shouldQueue) {
        return {
          ...t,
          pendingReply: {
            text,
            queuedAt: now.toISOString(),
            ...(attachments?.length ? { attachments } : {}),
          },
        };
      }

      const bucket = taskBucket(t);
      const restarting =
        bucket === 'review' || bucket === 'failed' || bucket === 'blocked';

      const newMessage: Message = {
        from: 'user',
        text,
        timestamp: ts,
        ...(attachments?.length ? { attachments } : {}),
      };
      return {
        ...t,
        messages: [...(t.messages || []), newMessage],
        waitingOnUser: false,
        pendingReply: undefined,
        // Re-engaging un-archives — if the user is talking to it, it's
        // not "recent" anymore.
        archivedAt: undefined,
        ...(restarting
          ? {
              lifecycleStatus: 'running' as const,
              claimedStatus: 'none' as const,
              validationStatus: 'pending' as const,
            }
          : {}),
      };
    });
  }

  async stopRun(_id: string): Promise<void> {
    // No daemon to signal in mock mode — no-op.
  }

  async cancelRun(_id: string): Promise<void> {
    // No daemon to signal in mock mode — no-op.
  }

  async archiveTask(id: string): Promise<Task | undefined> {
    return this.update(id, (t) => ({
      ...t,
      archivedAt: new Date().toISOString(),
    }));
  }

  // --- internals ---

  private update(id: string, mutator: (t: Task) => Task): Task | undefined {
    let updated: Task | undefined;
    const now = new Date().toISOString();
    this.tasks = this.tasks.map((t) => {
      if (t.id !== id) return t;
      updated = { ...mutator(t), updatedAt: now };
      return updated;
    });
    if (updated) this.notify();
    return updated;
  }
}
