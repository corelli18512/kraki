import { useTranslation } from 'react-i18next';
import type { RangeStatus } from '../../lib/message-provider';
import './history-load-status.css';

const ERRORS = {
  timeout: 'history.errors.timeout',
  unavailable: 'history.errors.unavailable',
  'no-progress': 'history.errors.partial',
  'page-limit': 'history.errors.partial',
  failed: 'history.errors.failed',
} as const;

/** Outside the transcript window so interior gaps stay actionable at the tail. */
export function HistoryLoadStatus({ status, onRetry }: { status: RangeStatus; onRetry: () => void }) {
  const { t } = useTranslation('chat');
  if (status.state !== 'loading' && status.state !== 'error' && status.state !== 'incomplete') return null;
  const loading = status.state === 'loading';
  const incomplete = status.state === 'incomplete';
  return (
    <div className="khistory-status">
      <span role="status" aria-label={t('history.conversation')} aria-live="polite" aria-atomic="true">
        {loading ? t('history.loadingHistory') : incomplete ? t('history.missing') : status.state === 'error' ? t(ERRORS[status.error]) : ''}
      </span>
      <button type="button" disabled={loading} onClick={onRetry}
        aria-label={loading ? t('history.loadingLabel') : incomplete ? t('history.continueLabel') : t('history.retryLabel')}>
        {loading ? t('history.loading') : incomplete ? t('history.continue') : t('history.retry')}
      </button>
    </div>
  );
}
