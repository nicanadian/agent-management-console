import { create } from 'zustand';
import type { Task, Agent, Attachment, ProjectInfo } from './types';
import {
  repository,
  type CaptureInput,
  type RegisterProjectInput,
  type SendMessageMode,
} from './data/repository';

// Domain store. Reads from the repository on subscribe; mutations call
// repository methods, which notify back through subscribe. UI flags live
// in `useUIStore` (see uiStore.ts).

interface DataStore {
  tasks: Task[];
  agents: Agent[];
  projects: ProjectInfo[];
  loading: boolean;

  captureTask: (input: CaptureInput) => Promise<void>;
  refreshProjects: () => Promise<void>;
  // Returns the server's reason on failure so the UI can show it inline,
  // rather than throwing into a render path.
  registerProject: (
    input: RegisterProjectInput
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  assignTask: (id: string, agentId: string) => Promise<void>;
  acceptTask: (id: string) => Promise<void>;
  rejectTask: (id: string) => Promise<void>;
  sendMessage: (
    id: string,
    text: string,
    mode: SendMessageMode,
    attachments?: Attachment[]
  ) => Promise<void>;
  stopRun: (id: string) => Promise<void>;
  cancelRun: (id: string) => Promise<void>;
  archiveTask: (id: string) => Promise<void>;
}

export const useStore = create<DataStore>((set) => {
  // Subscribe to repository changes
  repository.subscribe(({ tasks, agents }) => {
    set({ tasks, agents });
  });

  // Initial load
  Promise.all([
    repository.listTasks(),
    repository.listAgents(),
    repository.listProjects(),
  ])
    .then(([tasks, agents, projects]) =>
      set({ tasks, agents, projects, loading: false })
    )
    .catch(() => set({ loading: false }));

  return {
    tasks: [],
    agents: [],
    projects: [],
    loading: true,

    captureTask: async (input) => {
      await repository.captureTask(input);
    },
    refreshProjects: async () => {
      set({ projects: await repository.listProjects() });
    },
    registerProject: async (input) => {
      try {
        await repository.registerProject(input);
        set({ projects: await repository.listProjects() });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    assignTask: async (id, agentId) => {
      await repository.assignTask(id, agentId);
    },
    acceptTask: async (id) => {
      await repository.acceptTask(id);
    },
    rejectTask: async (id) => {
      await repository.rejectTask(id);
    },
    sendMessage: async (id, text, mode, attachments) => {
      await repository.sendMessage(id, text, mode, attachments);
    },
    stopRun: async (id) => {
      await repository.stopRun(id);
    },
    cancelRun: async (id) => {
      await repository.cancelRun(id);
    },
    archiveTask: async (id) => {
      await repository.archiveTask(id);
    },
  };
});
