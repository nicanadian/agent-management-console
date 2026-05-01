import { useUIStore } from './uiStore';
import { TopBar } from './components/TopBar';
import { CardsView } from './components/CardsView';
import { DetailPanel } from './components/DetailPanel';
import { CapturePalette } from './components/CapturePalette';
import { ShortcutsOverlay } from './components/ShortcutsOverlay';
import { useKeyboard } from './hooks/useKeyboard';

export default function App() {
  const selectedTaskId = useUIStore((s) => s.selectedTaskId);
  const capturePaletteOpen = useUIStore((s) => s.capturePaletteOpen);
  const shortcutsOverlayOpen = useUIStore((s) => s.shortcutsOverlayOpen);

  useKeyboard();

  return (
    <div className="h-screen flex flex-col bg-neutral-950 text-neutral-100">
      <TopBar />
      <div className="flex-1 relative overflow-hidden min-h-0">
        <CardsView />
      </div>
      {selectedTaskId && <DetailPanel />}
      {capturePaletteOpen && <CapturePalette />}
      {shortcutsOverlayOpen && <ShortcutsOverlay />}
    </div>
  );
}
