import { useStore } from '../../hooks/useStore';

export function SyncOverlay() {
  const syncing = useStore((s) => s.syncing);

  if (!syncing) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="flex items-center gap-3 rounded-2xl bg-surface-primary px-6 py-4 shadow-xl">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-kraki-500 border-t-transparent" />
        <span className="text-sm font-medium text-text-primary">Syncing sessions…</span>
      </div>
    </div>
  );
}
