/**
 * Settings › Account › Delete Account… — Mac/iOS DeleteAccountSection: an
 * explanation first, then a final "can't be undone" confirmation.
 */
import { useEffect, useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { wsClient } from '../../lib/ws-client';
import { DELETE_EXPLANATION, useAccountDeletion } from '../../lib/account-deletion';

function Dialog({ title, body, confirm, onConfirm, onCancel, testId }: {
  title: string; body: string; confirm: string; onConfirm: () => void; onCancel: () => void; testId: string;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/30 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div role="alertdialog" aria-modal="true" aria-label={title} data-testid={testId} className="w-full max-w-sm rounded-2xl border border-border-primary bg-surface-primary p-5 shadow-2xl">
        <h3 className="text-[15px] font-semibold text-text-primary">{title}</h3>
        <p className="mt-2 whitespace-pre-line text-[13px] leading-relaxed text-text-secondary">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg px-3 py-1.5 text-sm text-text-primary hover:bg-surface-secondary">Cancel</button>
          <button type="button" onClick={onConfirm} className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700">{confirm}</button>
        </div>
      </div>
    </div>
  );
}

export function DeleteAccountSection() {
  const state = useAccountDeletion((s) => s.state);
  const [step, setStep] = useState<'none' | 'explain' | 'final'>('none');
  const deleting = state.kind === 'deleting';
  return (
    <section data-testid="settings-delete-account">
      <h3 className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-text-muted">Account</h3>
      <button
        type="button"
        disabled={deleting}
        onClick={() => setStep('explain')}
        className="inline-flex items-center gap-2 rounded-lg border border-red-500/40 px-3 py-1.5 text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-60 dark:text-red-400"
      >
        {deleting && <span className="h-3 w-3 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />}
        {deleting ? 'Deleting…' : 'Delete Account…'}
      </button>
      {state.kind === 'failed' && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{state.message}</p>}
      <p className="mt-2 text-[11px] text-text-muted">Deletes your account and its data from Kraki's servers and signs out every device.</p>
      {step === 'explain' && (
        <Dialog testId="delete-explain" title="Delete your Kraki account?" body={DELETE_EXPLANATION} confirm="Continue"
          onCancel={() => setStep('none')} onConfirm={() => setStep('final')} />
      )}
      {step === 'final' && (
        <Dialog testId="delete-final" title="Delete account permanently?" body="This can't be undone." confirm="Delete Account"
          onCancel={() => setStep('none')} onConfirm={() => { setStep('none'); wsClient.requestAccountDeletion(); }} />
      )}
    </section>
  );
}

/** On the sign-in screen after the account was deleted. */
export function AccountDeletedNotice() {
  const show = useAccountDeletion((s) => s.deletedNotice);
  if (!show) return null;
  return (
    <div className="mx-auto mb-4 flex max-w-sm items-start gap-2 rounded-xl bg-surface-secondary px-4 py-3 text-left" data-testid="account-deleted-notice">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
      <div>
        <p className="text-sm font-medium text-text-primary">Your Kraki account was deleted.</p>
        <p className="text-xs text-text-muted">This device has been signed out.</p>
      </div>
    </div>
  );
}
