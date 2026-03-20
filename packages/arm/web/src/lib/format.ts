/** Format an ISO timestamp to a human-readable relative time */
export function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Format for session list: time if today, "Xd ago" otherwise */
export function sessionTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (isToday) {
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dateStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const days = Math.round((todayStart - dateStart) / (1000 * 60 * 60 * 24));
  if (days === 1) return 'yesterday';
  return `${days}d ago`;
}

/** Format an ISO timestamp to HH:MM */
export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
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
