import { diag } from '../../lib/diag';
import { SettingsAlert } from './SettingsControls';
import { resetVoice } from '../../lib/voice/voice';
import { desktop, setDesktopSignedOut } from '../../lib/desktop';
import { useState } from 'react';
import { useStore } from '../../hooks/useStore';
import { wsClient } from '../../lib/ws-client';
import { STORAGE_KEY } from '../../lib/transport';

/**
 * GitHub avatar by login from GitHub's avatar CDN. `github.com/<login>.png` is
 * only a redirect to the same image, and github.com is often unreachable from
 * mainland China while avatars.githubusercontent.com is not.
 */
function githubAvatarUrl(login: string, size = 64): string {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=${size}`;
}

function SignOutIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3-3h-9m9 0l-3-3m3 3l-3 3" />
    </svg>
  );
}

/** Sign out only this app; computers retain their session storage. */
export function signOut() {
    diag.phase('logout');
    const savedClientId = useStore.getState().githubClientId;
    localStorage.removeItem(STORAGE_KEY);
    setDesktopSignedOut(true);
    wsClient.disconnect();
    resetVoice();
    useStore.getState().reset();
    useStore.setState({ githubClientId: savedClientId, status: 'awaiting_login' });
    window.history.replaceState({}, '', '/');
    void import('../../lib/message-db').then(({ clearAllMessages }) => clearAllMessages());
}

export function ProfileBar({ compact = false, menu = false }: { compact?: boolean; menu?: boolean } = {}) {
  const user = useStore((s) => s.user);
  const [imgError, setImgError] = useState(false);
  const [confirming, setConfirming] = useState(false);

  if (!user) return null;
  if (user.provider === 'open') return null;

  const isGitHub = user.provider === 'github';
  const initial = user.login.charAt(0).toUpperCase();

  function handleSignOut() {
    signOut();
    setConfirming(false);
  }

  return (
    <>
      {menu ? <><div className="ksr-menu-divider" role="separator" /><span className="ksb-profile-name">{user.login}</span><button type="button" role="menuitem" onClick={() => setConfirming(true)}><SignOutIcon /> Sign Out…</button></> : <div className={compact ? 'flex min-w-0 shrink items-center gap-2 px-1.5 py-1' : 'flex shrink-0 items-center gap-3 border-t border-border-primary px-4 py-2.5'}>
        {isGitHub && !imgError ? (
          <img
            src={githubAvatarUrl(user.login)}
            alt={user.login}
            className={compact ? 'h-6 w-6 rounded-full' : 'h-7 w-7 rounded-full'}
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-kraki-500/20 text-xs font-bold text-kraki-600 dark:text-kraki-400">
            {initial}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className={`truncate font-medium text-text-primary ${compact ? 'text-xs' : 'text-sm'}`}>{user.login}</p>
          {user.email && !compact && (
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
      </div>}

      {confirming && <div className="fixed inset-0 z-[90]"><SettingsAlert title={`Sign out of Kraki on ${desktop ? 'this PC' : 'this browser'}?`} body={`Conversations cached ${desktop ? 'on this PC' : 'in this browser'} are removed. Your computers keep all sessions; sign in again to see them.`} confirm="Sign Out" onCancel={() => setConfirming(false)} onConfirm={handleSignOut} /></div>}
    </>
  );
}
