import { useStore } from '../../hooks/useStore';
import { X } from 'lucide-react';

/**
 * Global error banner — shows server errors, decrypt failures, etc.
 * Rendered at the app shell level, visible regardless of current route.
 */
export function ErrorBanner() {
  const lastError = useStore((s) => s.lastError);
  const clearError = useStore((s) => s.setLastError);

  if (!lastError) return null;

  return (
    <div
      role="alert"
      className="absolute left-1/2 top-4 z-50 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 shadow-lg backdrop-blur-sm"
    >
      <p className="text-sm text-red-500 dark:text-red-400">{lastError}</p>
      <button
        onClick={() => clearError(null)}
        className="shrink-0 rounded p-0.5 text-red-400 hover:bg-red-500/20 hover:text-red-300"
        aria-label="Dismiss error"
      >
        <X size={14} />
      </button>
    </div>
  );
}
