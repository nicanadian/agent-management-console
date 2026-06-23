import { create } from 'zustand';

export type ViewMode = 'cards' | 'board';

const VIEW_MODE_KEY = 'agent-console:viewMode';

function loadViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === 'board' ? 'board' : 'cards';
  } catch {
    return 'cards';
  }
}

interface UIStore {
  selectedTaskId: string | null;
  capturePaletteOpen: boolean;
  shortcutsOverlayOpen: boolean;
  projectsPanelOpen: boolean;
  viewMode: ViewMode;

  selectTask: (id: string | null) => void;
  openCapture: () => void;
  closeCapture: () => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  openProjects: () => void;
  closeProjects: () => void;
  closeAll: () => void;
  setViewMode: (mode: ViewMode) => void;
  toggleViewMode: () => void;
}

export const useUIStore = create<UIStore>((set) => ({
  selectedTaskId: null,
  capturePaletteOpen: false,
  shortcutsOverlayOpen: false,
  projectsPanelOpen: false,
  viewMode: loadViewMode(),

  selectTask: (id) => set({ selectedTaskId: id }),
  openCapture: () => set({ capturePaletteOpen: true }),
  closeCapture: () => set({ capturePaletteOpen: false }),
  openShortcuts: () => set({ shortcutsOverlayOpen: true }),
  closeShortcuts: () => set({ shortcutsOverlayOpen: false }),
  openProjects: () => set({ projectsPanelOpen: true }),
  closeProjects: () => set({ projectsPanelOpen: false }),
  closeAll: () =>
    set({
      capturePaletteOpen: false,
      shortcutsOverlayOpen: false,
      projectsPanelOpen: false,
      selectedTaskId: null,
    }),
  setViewMode: (mode) => {
    try {
      localStorage.setItem(VIEW_MODE_KEY, mode);
    } catch {
      // private mode / disabled storage — view just won't persist
    }
    set({ viewMode: mode });
  },
  toggleViewMode: () =>
    set((s) => {
      const mode: ViewMode = s.viewMode === 'cards' ? 'board' : 'cards';
      try {
        localStorage.setItem(VIEW_MODE_KEY, mode);
      } catch {
        // ignore
      }
      return { viewMode: mode };
    }),
}));
