import { t } from '../i18n';
import { formatDateTime } from '../i18n/format';
/** Mac DevicesPane: local-calendar today/yesterday, otherwise abbreviated month/day. */
export function deviceLastOnline(raw?: string, now = new Date()): string | null {
  if (!raw) return null;
  const date = new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw) ? `${raw.replace(' ', 'T')}Z` : raw);
  if (Number.isNaN(date.getTime())) return null;
  if (date.toDateString() === now.toDateString()) return t('devices:lastOnline.today');
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return t('devices:lastOnline.yesterday');
  return formatDateTime(date, { month: 'short', day: 'numeric' });
}
