import { t } from '../i18n';
import type { WebSessionSummary, SessionPreview } from '../types/store';

/** Mac MenuBarNeedsYou: display title, reason, newest timestamp/id first. */
export function desktopNeedsYou(sessions: Map<string, WebSessionSummary>, previews: Map<string, SessionPreview>) {
  return [...sessions.values()].flatMap((s) => {
    const preview = previews.get(s.id);
    const reason = preview?.type === 'permission' ? t('desktop:needsYou.approval')
      : preview?.type === 'question' ? t('desktop:needsYou.question') : null;
    return reason ? [{ id: s.id, title: s.title ?? s.autoTitle ?? t('desktop:needsYou.newSession'), reason, timestamp: preview!.timestamp }] : [];
  }).sort((a, b) => a.timestamp === b.timestamp
    ? (a.id > b.id ? -1 : a.id < b.id ? 1 : 0)
    : (a.timestamp > b.timestamp ? -1 : 1))
    .map(({ id, title, reason }) => ({ id, title, reason }));
}
