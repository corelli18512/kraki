import { useStore } from '../hooks/useStore';
import { wsClient } from '../lib/ws-client';
import { startOAuthFlow } from '../lib/transport';

/** GitHub mark SVG for the sign-in button */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/**
 * Dashboard page — shown on mobile (full screen session list)
 * and as fallback on desktop when no session is selected.
 */
export function DashboardPage() {
  const status = useStore((s) => s.status);
  const githubClientId = useStore((s) => s.githubClientId);
  const envClientId = import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined;
  const clientId = githubClientId || envClientId;

  if (status === 'awaiting_login') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <img src="/logo.png" alt="Kraki" className="mx-auto mb-4 h-40 w-40 object-contain animate-logo-reveal" />
        <h2 className="text-lg font-semibold text-text-primary animate-fade-up">Welcome to Kraki</h2>
        <p className="mt-2 max-w-sm text-sm text-text-secondary animate-fade-up">
          Sign in to connect to your coding agent sessions.
        </p>

        {clientId && (
          <button
            onClick={() => startOAuthFlow(clientId)}
            className="mt-6 inline-flex cursor-pointer items-center gap-2 rounded-lg bg-[#24292f] px-5 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-[#32383f] dark:bg-[#f0f0f0] dark:text-[#24292f] dark:hover:bg-[#d0d0d0] animate-fade-up"
          >
            <GitHubMark className="h-5 w-5" />
            Sign in with GitHub
          </button>
        )}

        <div className="mt-6 flex items-center gap-3 text-text-muted animate-fade-up-d2">
          <div className="h-px w-12 bg-border-primary" />
          <span className="text-xs">or</span>
          <div className="h-px w-12 bg-border-primary" />
        </div>

        <p className="mt-4 max-w-sm text-xs text-text-muted animate-fade-up-d3">
          Scan a pairing QR code from your terminal to connect.
        </p>
        <p className="mt-2 max-w-sm text-xs text-text-muted animate-fade-up-d3">
          Run <code className="rounded bg-surface-secondary px-1 py-0.5">kraki connect</code> to generate a new one.
        </p>

        <p className="mt-6 rounded-lg bg-surface-secondary px-4 py-2 font-mono text-xs text-text-muted animate-fade-up-d3">
          {wsClient.url}
        </p>
      </div>
    );
  }

  if (status === 'disconnected' || status === 'error') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <img src="/logo.png" alt="Kraki" className="h-16 w-16 object-contain" />
        <h2 className="mt-4 text-lg font-semibold text-text-primary">
          {status === 'error' ? 'Connection Error' : 'Disconnected'}
        </h2>
        <p className="mt-2 max-w-sm text-sm text-text-secondary">
          {status === 'error'
            ? 'Could not connect to the relay server. Make sure the head is running.'
            : 'Not connected to a relay server. Reconnecting…'}
        </p>
        <p className="mt-4 rounded-lg bg-surface-secondary px-4 py-2 font-mono text-xs text-text-muted">
          {wsClient.url}
        </p>
      </div>
    );
  }

  if (status === 'connecting') {
    return (
      <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-kraki-500 border-t-transparent" />
        <p className="mt-4 text-sm text-text-secondary">Connecting to relay…</p>
      </div>
    );
  }

  // Connected — desktop shows empty state (sidebar has sessions), mobile shows sidebar directly
  return (
    <div className="flex flex-1 flex-col">
      <div className="hidden flex-1 items-center justify-center md:flex">
        <div className="text-center">
          <img src="/logo.png" alt="Kraki" className="mx-auto mb-4 h-40 w-40 object-contain animate-logo-reveal" />
          <p className="text-sm font-medium text-text-primary animate-fade-up">
            Welcome to Kraki
          </p>
          <p className="mt-1 text-xs text-text-muted animate-fade-up">
            Select a session from the sidebar to get started
          </p>
        </div>
      </div>
    </div>
  );
}
