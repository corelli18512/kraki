import type { RangeStatus } from '../../lib/message-provider';
import './history-load-status.css';

const ERRORS: Record<Extract<RangeStatus, { state: 'error' }>['error'], string> = {
  timeout: 'History request timed out.',
  unavailable: 'History is unavailable.',
  'no-progress': 'Some history could not be loaded.',
  'page-limit': 'Some history could not be loaded.',
  failed: 'History could not be loaded.',
};

/** Outside the transcript window so interior gaps stay actionable at the tail. */
export function HistoryLoadStatus({ status, onRetry }: { status: RangeStatus; onRetry: () => void }) {
  if (status.state !== 'loading' && status.state !== 'error' && status.state !== 'incomplete') return null;
  const loading = status.state === 'loading';
  const incomplete = status.state === 'incomplete';
  return (
    <div className="khistory-status">
      <span role="status" aria-label="Conversation history" aria-live="polite" aria-atomic="true">
        {loading ? 'Loading history…' : incomplete ? 'Some history is missing.' : status.state === 'error' ? ERRORS[status.error] : ''}
      </span>
      <button type="button" disabled={loading} onClick={onRetry}
        aria-label={loading ? 'Loading history' : incomplete ? 'Continue loading history' : 'Retry history'}>
        {loading ? 'Loading…' : incomplete ? 'Continue' : 'Retry'}
      </button>
    </div>
  );
}
