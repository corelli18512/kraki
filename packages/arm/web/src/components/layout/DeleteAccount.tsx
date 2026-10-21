/**
 * Settings › Account › Delete Account… — Mac/iOS DeleteAccountSection: an
 * explanation first, then a final "can't be undone" confirmation.
 */
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { SettingsAlert as Dialog } from './SettingsControls';
import { wsClient } from '../../lib/ws-client';
import { deleteExplanation, useAccountDeletion } from '../../lib/account-deletion';

export function DeleteAccountSection() {
  const { t } = useTranslation('settings');
  const state = useAccountDeletion((s) => s.state);
  const [step, setStep] = useState<'none' | 'explain' | 'final'>('none');
  const deleting = state.kind === 'deleting';
  return (
    <section data-testid="settings-delete-account">
      
      <div className="kp-group"><div className="kp-row"><button
        type="button"
        disabled={deleting}
        onClick={() => setStep('explain')}
        className="kp-button inline-flex items-center gap-2 disabled:opacity-60"
      >
        {deleting && <span className="h-3 w-3 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />}
        {deleting ? t('deletion.deleting') : t('deletion.action')}
      </button></div></div>
      {state.kind === 'failed' && <p className="mt-2 text-xs text-red-600 dark:text-red-400">{state.message}</p>}
      <p className="kp-section-footer">{t('deletion.footer')}</p>
      {step === 'explain' && (
        <Dialog testId="delete-explain" title={t('deletion.explainTitle')} body={deleteExplanation()} confirm={t('actions.continue')}
          onCancel={() => setStep('none')} onConfirm={() => setStep('final')} />
      )}
      {step === 'final' && (
        <Dialog stacked testId="delete-final" title={t('deletion.finalTitle')} body={t('deletion.finalBody')} confirm={t('deletion.confirm')}
          onCancel={() => setStep('none')} onConfirm={() => { setStep('none'); wsClient.requestAccountDeletion(); }} />
      )}
    </section>
  );
}

/** On the sign-in screen after the account was deleted. */
export function AccountDeletedNotice() {
  const { t } = useTranslation('settings');
  const show = useAccountDeletion((s) => s.deletedNotice);
  if (!show) return null;
  return (
    <div className="mx-auto mb-4 flex max-w-sm items-start gap-2 rounded-xl bg-surface-secondary px-4 py-3 text-left" data-testid="account-deleted-notice">
      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-500" />
      <div>
        <p className="text-sm font-medium text-text-primary">{t('deletion.deleted')}</p>
        <p className="text-xs text-text-muted">{t('deletion.signedOut')}</p>
      </div>
    </div>
  );
}
