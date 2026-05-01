import { useUIStore } from '../uiStore';

const shortcuts = [
  { key: 'c', desc: 'Capture new task' },
  { key: 'a', desc: 'Accept (in review)' },
  { key: 'r', desc: 'Request changes (in review)' },
  { key: '?', desc: 'Show this help' },
  { key: 'esc', desc: 'Close panel or modal' },
];

export function ShortcutsOverlay() {
  const close = useUIStore((s) => s.closeShortcuts);

  return (
    <div
      className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-neutral-900 border border-neutral-700 rounded-lg p-6 min-w-96 shadow-2xl"
      >
        <div className="text-sm font-medium text-neutral-200 mb-4 uppercase tracking-wider">
          Keyboard shortcuts
        </div>
        <div className="space-y-2">
          {shortcuts.map((s) => (
            <div
              key={s.key}
              className="flex justify-between items-center text-sm gap-8"
            >
              <span className="text-neutral-300">{s.desc}</span>
              <kbd className="px-2 py-0.5 bg-neutral-800 border border-neutral-700 rounded text-xs font-mono text-neutral-300">
                {s.key}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
