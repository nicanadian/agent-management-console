import type { Task, Agent, Priority, Attachment, ProjectInfo } from '../types';
import { FileSystemRepository } from './fileSystemRepository';

// The repository is the persistence boundary. The FileSystemRepository is
// the only runtime path: it talks to tools/console-server.mjs, which owns
// `.agent-console/` and spawns per-task shim daemons.
//
// `InMemoryRepository` (under `__fixtures__/`) exists for tests and for
// future Storybook-style UI iteration; it is not loaded at runtime.

export type SendMessageMode = 'auto' | 'queue' | 'interrupt';

// Phase 8.3 — progressive capture lets the user attach @agent / #project /
// !priority chips inline. The palette parses the string client-side and
// passes the structured result through the repository.
export interface CaptureInput {
  title: string;
  agentId?: string;
  project?: string;
  priority?: Priority;
  attachments?: Attachment[];
  // Phase 12.1 — provenance tag (e.g. 'ui', 'hermes', 'cli'). Server
  // defaults to 'ui' when omitted.
  createdBy?: string;
}

export interface RepositorySnapshot {
  tasks: Task[];
  agents: Agent[];
}

export type RepositoryListener = (snapshot: RepositorySnapshot) => void;

// Phase 13 — registering a project validates the repo server-side, so the
// register call can fail with a human-readable reason (not a git repo, etc).
export interface RegisterProjectInput {
  name: string;
  repoPath: string;
  defaultBranch?: string;
  setupCommand?: string;
  mergeMode?: 'local' | 'github-pr';
}

export interface Repository {
  listTasks(): Promise<Task[]>;
  listAgents(): Promise<Agent[]>;
  getTask(id: string): Promise<Task | undefined>;
  // Phase 13 — project registry for worktree-isolated tasks.
  listProjects(): Promise<ProjectInfo[]>;
  registerProject(input: RegisterProjectInput): Promise<ProjectInfo>;
  captureTask(input: CaptureInput): Promise<Task>;
  assignTask(id: string, agentId: string): Promise<Task | undefined>;
  acceptTask(id: string): Promise<Task | undefined>;
  rejectTask(id: string): Promise<Task | undefined>;
  sendMessage(
    id: string,
    text: string,
    mode: SendMessageMode,
    attachments?: Attachment[]
  ): Promise<Task | undefined>;
  // Phase 6.6: signal the per-task shim daemon.
  // stopRun:    SIGINT  → claude finishes in-flight tool, daemon stays alive.
  // cancelRun:  SIGTERM → claude killed, daemon exits, artifacts preserved.
  stopRun(id: string): Promise<void>;
  cancelRun(id: string): Promise<void>;
  // Move a task to the Archived rail. Sending a new message un-archives.
  archiveTask(id: string): Promise<Task | undefined>;
  subscribe(listener: RepositoryListener): () => void;
}

export { FileSystemRepository } from './fileSystemRepository';

export const repository: Repository = new FileSystemRepository();
