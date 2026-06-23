import { useEffect } from 'react';
import { useStore } from '../store';
import { useUIStore } from '../uiStore';
import { taskBucket } from '../types';

export function useKeyboard() {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

      const ui = useUIStore.getState();
      const data = useStore.getState();

      if (e.key === 'Escape') {
        ui.closeAll();
        if (isInput) (target as HTMLInputElement).blur();
        return;
      }

      if (isInput) return;
      if (ui.capturePaletteOpen || ui.shortcutsOverlayOpen || ui.projectsPanelOpen)
        return;

      if (e.key === 'c') {
        e.preventDefault();
        ui.openCapture();
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        ui.openShortcuts();
        return;
      }
      if (e.key === 'v') {
        e.preventDefault();
        ui.toggleViewMode();
        return;
      }
      if (e.key === 'p') {
        e.preventDefault();
        ui.openProjects();
        return;
      }

      if (ui.selectedTaskId) {
        const task = data.tasks.find((t) => t.id === ui.selectedTaskId);
        if (task && taskBucket(task) === 'review') {
          if (e.key === 'a') {
            data.acceptTask(task.id);
            return;
          }
          if (e.key === 'r') {
            data.rejectTask(task.id);
            return;
          }
        }
      }
    }

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
}
