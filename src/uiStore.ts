import { create } from 'zustand';

interface UIStore {
  selectedTaskId: string | null;
  capturePaletteOpen: boolean;
  shortcutsOverlayOpen: boolean;

  selectTask: (id: string | null) => void;
  openCapture: () => void;
  closeCapture: () => void;
  openShortcuts: () => void;
  closeShortcuts: () => void;
  closeAll: () => void;
}

export const useUIStore = create<UIStore>((set) => ({
  selectedTaskId: null,
  capturePaletteOpen: false,
  shortcutsOverlayOpen: false,

  selectTask: (id) => set({ selectedTaskId: id }),
  openCapture: () => set({ capturePaletteOpen: true }),
  closeCapture: () => set({ capturePaletteOpen: false }),
  openShortcuts: () => set({ shortcutsOverlayOpen: true }),
  closeShortcuts: () => set({ shortcutsOverlayOpen: false }),
  closeAll: () =>
    set({
      capturePaletteOpen: false,
      shortcutsOverlayOpen: false,
      selectedTaskId: null,
    }),
}));
