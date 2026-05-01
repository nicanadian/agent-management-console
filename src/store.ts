import { create } from 'zustand';
import type { Task, Agent } from './types';
import {
  repository,
  type CaptureInput,
  type SendMessageMode,
} from './data/repository';

// Domain store. Reads from the repository on subscribe; mutations call
// repository methods, which notify back through subscribe. UI flags live
// in `useUIStore` (see uiStore.ts).

interface DataStore {
  tasks: Task[];
  agents: Agent[];
  loading: boolean;

  captureTask: (input: CaptureInput) => Promise<void>;
  assignTask: (id: string, agentId: string) => Promise<void>;
  acceptTask: (id: string) => Promise<void>;
  rejectTask: (id: string) => Promise<void>;
  sendMessage: (id: string, text: string, mode: SendMessageMode) => Promise<void>;
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
  Promise.all([repository.listTasks(), repository.listAgents()])
    .then(([tasks, agents]) => set({ tasks, agents, loading: false }))
    .catch(() => set({ loading: false }));

  return {
    tasks: [],
    agents: [],
    loading: true,

    captureTask: async (input) => {
      await repository.captureTask(input);
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
    sendMessage: async (id, text, mode) => {
      await repository.sendMessage(id, text, mode);
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
