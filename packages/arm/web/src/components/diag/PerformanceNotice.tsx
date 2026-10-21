import { useTranslation } from 'react-i18next';
import { t } from '../../i18n';
import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { useStore } from '../../hooks/useStore';
import { diag } from '../../lib/diag';
import './performance-notice.css';

/** Same copy as Mac/iPhone PerformanceNoticeCopy. */
export function performanceNoticeCopy() {
  return {
    title: t('settings:performanceNotice.title'),
    explanation: t('settings:performanceNotice.explanation'),
    settingsHint: t('settings:performanceNotice.settingsHint'),
  };
}
export const NOTICE_SEEN_KEY = 'kraki.diag.noticeSeen';

/** One-time, non-modal card after sign-in (Mac PerformanceNotice): shown once
 *  per install where performance data runs (Windows), bottom-right. "Don't
 *  Share" turns it off; either button marks it seen. Afterwards it lives in
 *  Settings › Privacy only. */
export function PerformanceNoticeHost({ settleMs = 1500 }: { settleMs?: number }) {
  const { t } = useTranslation('settings');
  const copy = performanceNoticeCopy();
  const connected = useStore((s) => s.status === 'connected');
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!connected || !diag.active || localStorage.getItem(NOTICE_SEEN_KEY) === 'true') return;
    const timer = setTimeout(() => { if (localStorage.getItem(NOTICE_SEEN_KEY) !== 'true') setVisible(true); }, settleMs);
    return () => clearTimeout(timer);
  }, [connected, settleMs]);
  if (!visible) return null;
  const choose = (share: boolean) => {
    localStorage.setItem(NOTICE_SEEN_KEY, 'true');
    if (!share) void diag.setEnabled(false);
    setVisible(false);
  };
  return (
    <section className="kperf-notice" role="dialog" aria-modal="false" aria-labelledby="kperf-title" data-testid="performance-notice">
      <h2 id="kperf-title"><Sparkles aria-hidden />{copy.title}</h2>
      <p>{copy.explanation}</p>
      <p className="kperf-hint">{copy.settingsHint}</p>
      <div className="kperf-actions">
        <button type="button" className="kperf-secondary" onClick={() => choose(false)}>{t('performanceNotice.decline')}</button>
        <button type="button" className="kperf-primary" autoFocus onClick={() => choose(true)}>{t('performanceNotice.ok')}</button>
      </div>
    </section>
  );
}
