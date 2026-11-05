import { formatClockTime, formatRelativeDays, formatRelativeTime } from '../i18n/format';

/** Format an ISO timestamp to a human-readable relative time ("5m ago" / "5分钟前"). */
export function timeAgo(iso: string): string {
  return formatRelativeTime(iso);
}

/** Format for session list: time if today, "yesterday" / "Xd ago" otherwise */
export function sessionTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) return formatTime(iso);
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((todayStart - dateStart) / (1000 * 60 * 60 * 24));
  return formatRelativeDays(days);
}

/** Format an ISO timestamp to hours:minutes in the user's 12/24-hour cycle. */
export function formatTime(iso: string): string {
  return formatClockTime(iso);
}

/** Capitalize first letter */
export function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Get agent display info */
export function agentInfo(agent: string): { label: string; emoji: string; color: string } {
  switch (agent.toLowerCase()) {
    case 'copilot':
      return { label: 'Copilot', emoji: '🤖', color: 'text-blue-500' };
    case 'claude':
      return { label: 'Claude', emoji: '🧠', color: 'text-orange-500' };
    case 'codex':
      return { label: 'Codex', emoji: '⚡', color: 'text-green-500' };
    default:
      return { label: capitalize(agent), emoji: '🔮', color: 'text-purple-500' };
  }
}

/** Truncate text with ellipsis */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '…';
}

const graphemes = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/** The longest prefix of at most `maxLen` UTF-16 units that ends on a
 *  grapheme boundary: never a lone surrogate or half a ZWJ/flag emoji. */
export function sliceGraphemes(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  let end = 0;
  for (const { segment } of graphemes ? graphemes.segment(text) : Array.from(text, (segment) => ({ segment }))) {
    if (end + segment.length > maxLen) break;
    end += segment.length;
  }
  return text.slice(0, end);
}
