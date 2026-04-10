import { useState } from 'react';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import { STORAGE_KEY } from '../../lib/transport';

/** Derive a GitHub avatar URL from a login name. */
function githubAvatarUrl(login: string, size = 64): string {
  return `https://github.com/${login}.png?size=${size}`;
}

function SignOutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3-3h-9m9 0l-3-3m3 3l-3 3" />
    </svg>
  );
}

export function ProfileBar() {
  const user = useStore((s) => s.user);
  const [imgError, setImgError] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (!user) return null;
  if (user.provider === 'open') return null;

  const isGitHub = user.provider === 'github';
  const initial = user.login.charAt(0).toUpperCase();

  function handleSignOut() {
    const savedClientId = useStore.getState().githubClientId;
    localStorage.removeItem(STORAGE_KEY);
    wsClient.disconnect();
    useStore.getState().reset();
    useStore.setState({ githubClientId: savedClientId, status: 'awaiting_login' });
    window.history.replaceState({}, '', '/');
    setConfirming(false);
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-3 border-t border-border-primary px-4 py-2.5">
        {isGitHub && !imgError ? (
          <img
            src={githubAvatarUrl(user.login)}
            alt={user.login}
            className="h-7 w-7 rounded-full"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-kraki-500/20 text-xs font-bold text-kraki-600 dark:text-kraki-400">
            {initial}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary">{user.login}</p>
          {user.email && (
            <p className="truncate text-xs text-text-muted">{user.email}</p>
          )}
        </div>
        <button
          onClick={() => setConfirming(true)}
          title="Sign out"
          aria-label="Sign out"
          className="shrink-0 rounded-md p-1.5 text-text-muted transition-colors hover:bg-surface-tertiary hover:text-text-primary"
        >
          <SignOutIcon className="h-4 w-4" />
        </button>
      </div>

      {/* Sign-out confirmation dialog */}
      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setConfirming(false)} onKeyDown={(e) => e.key === 'Escape' && setConfirming(false)} role="dialog" aria-modal="true" tabIndex={-1}>
          <div className="mx-4 w-full max-w-sm rounded-xl bg-surface-primary p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-semibold text-text-primary">Sign out?</h3>
            <p className="mt-2 text-sm text-text-secondary">
              This will disconnect from the relay and clear all local data including session history and device keys. You'll need to sign in again.
            </p>
            <div className="mt-5 flex justify-end gap-3">
              <button
                onClick={() => setConfirming(false)}
                className="rounded-lg px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-secondary"
              >
                Cancel
              </button>
              <button
                onClick={handleSignOut}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
              >
                Sign out
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
